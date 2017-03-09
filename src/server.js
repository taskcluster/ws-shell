let debug       = require('debug')('ws-shell');
let msgcodes    = require('./msgcodes');
let events      = require('events');
let _           = require('lodash');
let querystring = require('querystring');
let stream      = require('readable-stream');
let through2    = require('through2');

const MAX_OUTSTANDING = 64 * 1024;
const MAX_MESSAGE_SIZE = 16 * 1024;

class ShellHandler extends events.EventEmitter {
  constructor(websocket, process) {
    super();
    this._process = process;
    this._ws = websocket;
    this._ws.on('error', err => {
      debug('websocket error: %s', err);
      this.emit('error', err);
      this._process.kill();
    });
    this._exitSent = false;
    this._process.on('error', err => {
      debug('process error: %s', err);
      this.emit('error', err);
      this._sendExit(false);
    });
    this._process.on('exit', (code) => {
      debug('process exited, code: %d', code);
      this._sendExit(code === 0);
    });
    this._ws.on('message', m => this._handleMessage(m));

    // Stream stdout
    this._stdoutOutstanding = 0;
    this._process.stdout.on('data', data => {
      this._write(msgcodes.STREAM_STDOUT, data);
      this._stdoutOutstanding += data.length;
      if (this._stdoutOutstanding >= MAX_OUTSTANDING) {
        this._process.stdout.pause();
      }
    });
    this._process.stdout.on('end', () => {
      this._write(msgcodes.STREAM_STDOUT, null);
    });
    this._process.stdout.resume();

    // Stream stderr
    this._stderrOutstanding = 0;
    this._process.stderr.on('data', data => {
      this._write(msgcodes.STREAM_STDERR, data);
      this._stderrOutstanding += data.length;
      if (this._stderrOutstanding >= MAX_OUTSTANDING) {
        this._process.stderr.pause();
      }
    });
    this._process.stderr.on('end', () => {
      this._write(msgcodes.STREAM_STDERR, null);
    });
    this._process.stderr.resume();
  }

  _sendExit(success) {
    if (this._exitSent) {
      return;
    }
    this._exitSent = true;
    this._ws.send(Buffer.from([
      msgcodes.MESSAGE_TYPE_EXIT,
      success ? 0 : 1,
    ]));
    this._ws.close();
  }

  _handleMessage(m) {
    let c = m[0];
    m = m.slice(1);
    switch (c) {
      case msgcodes.MESSAGE_TYPE_DATA:
        return this._handleData(m[0], m.slice(1));
      case msgcodes.MESSAGE_TYPE_ACK:
        return this._handleAck(m[0], m.slice(1));
      case msgcodes.MESSAGE_TYPE_SIZE:
        if (m.length === 4) {
          let cols = m.readUInt16BE(0);
          let rows = m.readUInt16BE(2);
          if (this._process.resize instanceof Function) {
            this._process.resize(cols, rows);
          } else {
            debug('process.resize(cols, rows) not defined, resize message ignored');
          }
        }
        return;
      case msgcodes.MESSAGE_TYPE_ABORT:
        return this._process.kill();
      default:
        debug('Unknown message code: %d', c);
    }
  }

  _handleData(streamId, m) {
    switch (streamId) {
      case msgcodes.STREAM_STDIN:
        if (m.length === 0) {
          this._process.stdin.end(() => {
            this._sendAck(0);
          });
          return;
        }
        this._process.stdin.write(m, () => {
          this._sendAck(m.length);
        });
        return;
      default:
        debug('Data for unhandled streamId: %d', streamId);
    }
  }

  _sendAck(count) {
    let m = Buffer.alloc(6);
    m[0] = msgcodes.MESSAGE_TYPE_ACK;
    m[1] = msgcodes.STREAM_STDIN;
    m.writeUInt32BE(count, 2);
    this._ws.send(m);
  }

  _handleAck(streamId, m) {
    if (m.length !== 4) {
      debug('Acknowledgement for streamId: %d not 4 bytes long', streamId);
      return;
    }
    let count = m.readUInt32BE(0);
    switch (streamId) {
      case msgcodes.STREAM_STDOUT:
        this._stdoutOutstanding -= count;
        if (this._stdoutOutstanding < MAX_OUTSTANDING) {
          this._process.stdout.resume();
        }
        break;
      case msgcodes.STREAM_STDERR:
        this._stderrOutstanding -= count;
        if (this._stderrOutstanding < MAX_OUTSTANDING) {
          this._process.stderr.resume();
        }
        break;
      default:
        debug('Acknowledgement for unknown streamId: %d', streamId);
    }
  }

  _write(streamId, data) {
    if (data === null) {
      // Empty payload signals end of stream
      data = Buffer.from([]);
    } else if (data.length === 0) {
      // Don't allow empty buffers as it signals end of stream
      return;
    }
    // Split into messages, if needed
    while (data.length > MAX_MESSAGE_SIZE) {
      this._writeChunk(streamId, data.slice(0, MAX_MESSAGE_SIZE));
      data = data.slice(MAX_MESSAGE_SIZE);
    }
    this._writeChunk(streamId, data);
  }

  _writeChunk(streamId, chunk) {
    let header = Buffer.from([
      msgcodes.MESSAGE_TYPE_DATA,
      streamId,
    ]);
    this._ws.send(Buffer.concat([header, chunk]));
  }
}
