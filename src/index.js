let ShellClient = require('./client');
let Promise     = require('promise');

exports.ShellClient = ShellClient;
exports.dial = (options) => {
  return new Promise((resolve, reject) => {
    let shell = new ShellClient(options);
    shell.once('error', reject);
    shell.once('open', () => {
      shell.removeListener('error', reject);
      resolve(shell);
    });
  });
};
