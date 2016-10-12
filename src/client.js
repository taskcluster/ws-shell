let debug       = require('debug')('ws-shell');
let msgcodes    = require('./msgcodes');
let events      = require('events');
let _           = require('lodash');
let querystring = require('querystring');
let stream      = require('readable-stream');
let through2    = require('through2');

// Load ws, if WebSocket isn't present on global/window
let WebSocket = global.WebSocket;
if (!WebSocket) {
  WebSocket = require('ws');
}

const MAX_MESSAGE_SIZE = 16 * 1024;

/** ShellClient */
class ShellClient extends events.EventEmitter {
  constructor(options) {
    super();
    options = _.defaults({}, options, {
      tty:      false,
      command:  [],
      url:      null,
    });

    // Remember, if this is a tty
    this.isTTY = options.tty;

    // Validate URL before we do anything
    if (!/^wss?:\/\/.+/.test(options.url)) {
      throw new Error(`url must be ws:// or wss://, got: ${options.url}`);
    }

    // Wrap commad in array, if it's a string
    if (typeof options.command === 'string') {
      options.command = [options.command];
    }

    // Validate command
    if (!(options.command instanceof Array)) {
      throw new Error('options.command must be an array');
    }
    if (!_.every(options.command, e => typeof e === 'string')) {
      throw new Error('options.command must be an array of strings');
    }

    // Construct URL
    let url = options.url + '?' + querystring.stringify({
      tty:      options.tty ? 'true' : 'false',
      command:  options.command,
    });

    // Construct websocket
    this._ws = new WebSocket(url);
    this._ws.binaryType = 'arraybuffer';

    // Handle websocket events
    this._ws.addEventListener('open', () => {
      debug('websocket opened');
      this.emit('open');
    });
    this._ws.addEventListener('message', (e) => this._handleMessage(e));
    this._ws.addEventListener('error', (err) => {
      debug('websocket error: %s', err);
      this.emit('error', err);
    });

    // Ensure we only emit exit once
    this._exitEmitted = false;
    this._ws.addEventListener('close', () => {
      debug('websocket closed');
      if (!this._exitEmitted) {
        this.emit('exit', false);
        this._exitEmitted = true;
      }
    });

    // Setup stdout stream
    this.stdout = through2({objectMode: false, allowHalfOpen: false});
    this._stdoutOutstanding = 0;
    this.stdout.on('drain', () => {
      if (this._stdoutOutstanding > 0) {
        this._sendAck(msgcodes.STREAM_STDOUT, this._stdoutOutstanding);
        this._stdoutOutstanding = 0;
      }
    });

    // Setup stderr stream
    this.stderr = through2({objectMode: false, allowHalfOpen: false});
    this._stderrOutstanding = 0;
    this.stderr.on('drain', () => {
      if (this._stderrOutstanding > 0) {
        this._sendAck(msgcodes.STREAM_STDERR, this._stderrOutstanding);
        this._stderrOutstanding = 0;
      }
    });

    // Setup stdin stream
    this._pendingWrites = []; // {count, callback}
    this.stdin = new stream.Writable({
      highWaterMark:  MAX_MESSAGE_SIZE,
      decodeStrings:  true, // docs are ambiguous here
      objectMode:     false,
      write:          this._write.bind(this),
      writev: (chunks, callback) => {
        let data = Buffer.concat(chunks.map(c => c.chunk));
        this._write(data, null, callback);
      },
    });
    this.stdin.on('finish', () => {
      let header = Buffer.from([
        msgcodes.MESSAGE_TYPE_DATA,
        msgcodes.STREAM_STDIN,
      ]);
      this._ws.send(message);
      this._pendingWrites.push({count: 0, callback() {
        // TODO: Node streams doesn't support acknowleging that the stream was
        // successfully closed.
        debug('stream finished');
      }});
    });
  }

  _handleMessage(e) {
    let m = Buffer.from(new Uint8Array(e.data));
    let c = m[0];
    m = m.slice(1);

    switch (c) {
      case msgcodes.MESSAGE_TYPE_DATA:
        return this._handleData(m[0], m.slice(1));

      case msgcodes.MESSAGE_TYPE_ACK:
        return this._handleAck(m[0], m.slice(1));

      case msgcodes.MESSAGE_TYPE_EXIT:
        let success = m[0] === 0;
        // Only emit exit once
        if (!this._exitEmitted) {
          this.emit('exit', success);
          this._exitEmitted = true;
        }
        return;

      default:
        debug('Unknown message code: %d', c);
    }
  }

  _handleData(streamId, m) {
    switch (streamId) {
      case msgcodes.STREAM_STDOUT:
        // close stdout, if payload is empty
        if (m.length === 0) {
          this.stdout.end();
          return;
        }
        // output m to stdout
        if (this.stdout.write(m)) {
          // If stream isn't blocked we send drain event immediately
          this._sendAck(msgcodes.STREAM_STDOUT, m.length);
          return;
        }
        // Wait for drain event before sending ack
        this._stdoutOutstanding += m.length;
        return;
      case msgcodes.STREAM_STDERR:
        // close stderr, if payload is empty
        if (m.length === 0) {
          this.stderr.end();
          return;
        }
        // output m to stderr
        if (this.stderr.write(m)) {
          // If stream isn't blocked we send drain event immediately
          this._sendAck(msgcodes.STREAM_STDERR, m.length);
          return;
        }
        // Wait for drain event before sending ack
        this._stderrOutstanding += m.length;
        return;
      default:
        debug('Unknown stream identifier: %d', streamId);
    }
  }

  _handleAck(streamId, m) {
    if (streamId !== msgcodes.STREAM_STDIN) {
      return debug('Ack for unknown stream identifier: %d', streamId);
    }
    if (m.length !== 4) {
      return debug('Ack for stdin, but length was not 4');
    }
    let N = m.readUInt32BE(0);
    if (N === 0) {
      if (this._pendingWrites[0].count === 0) {
        this._pendingWrites.shift().callback();
      } else {
        this.emit('error', new Error('stdin closed before all writes was acknowledged'));
      }
    }
    // ack N from stdin
    while (this._pendingWrites.length > 0 && N > 0) {
      if (this._pendingWrites[0].count <= N) {
        N -= this._pendingWrites[0].count;
        this._pendingWrites.shift().callback();
      } else {
        this._pendingWrites[0].count -= N;
        N = 0;
      }
    }
    if (N > 0) {
      this.emit('error', new Error('Received acknowledgement for data not sent'));
    }
  }

  _write(data, encoding, callback) {
    while (data.length > MAX_MESSAGE_SIZE) {
      this._writeChunk(data.slice(0, MAX_MESSAGE_SIZE), null, () => {});
      data = data.slice(MAX_MESSAGE_SIZE);
    }
    this._writeChunk(data, null, callback);
  }

  _writeChunk(chunk, encoding, callback) {
    if (chunk.length === 0) {
      return callback();
    }
    let header = Buffer.from([
      msgcodes.MESSAGE_TYPE_DATA,
      msgcodes.STREAM_STDIN,
    ]);
    let message = Buffer.concat([header, chunk]);
    this._ws.send(message);
    this._pendingWrites.push({count: chunk.length, callback});
  }

  _sendAck(streamId, N) {
    let m = Buffer.alloc(6);
    m[0] = msgcodes.MESSAGE_TYPE_ACK;
    m[1] = streamId;
    m.writeUInt32BE(N, 2);
    this._ws.send(m);
  }

  resize(cols, rows) {
    let m = Buffer.alloc(5);
    m[0] = msgcodes.MESSAGE_TYPE_SIZE;
    m.writeUInt16BE(cols, 1);
    m.writeUInt16BE(rows, 3);
    this._ws.send(m);
  }

  kill() {
    if (this._abortSent) {
      return;
    }
    this._abortSent = true;
    let m = Buffer.alloc(1);
    m[0] = msgcodes.MESSAGE_TYPE_ABORT;
    this._ws.send(m);
  }

  close() {
    try {
      this.kill();
    } catch (err) {
      debug('close() failed to call kill(), error: %s', err);
    }
    this._ws.close();
  }
}

// Export ShellClient
module.exports = ShellClient;
