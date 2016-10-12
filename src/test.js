let wsshell = require('./');

(async () => {
  let shell = await wsshell.dial({
    url:      'ws://127.0.0.1:2222/',
    tty:      process.stdout.isTTY,
    command:  ["bash"],
  });

  if (process.stdout.isTTY) {
    process.stdin.setRawMode(true);
    process.stdout.on('resize', () => {
      shell.resize(process.stdout.columns, process.stdout.rows);
    });
    shell.resize(process.stdout.columns, process.stdout.rows);
  }

  shell.stdout.pipe(process.stdout);
  shell.stderr.pipe(process.stderr);
  process.stdin.pipe(shell.stdin);

  process.on('SIGINT', () => shell.kill());

  shell.on('exit', success => {
    if (process.stdout.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(success ? 0 : 1);
  });

})().catch(err => console.log(err));
