#!/usr/bin/env node
'use strict';
// wt-ssh <profile id>: the command a connection's session runs. Reads the
// profile (and its password) from the data folder and starts ssh with the
// secrets handed over through SSH_ASKPASS (bin/wt-askpass), never on the
// command line. When ssh ends the shell is still there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../lib/ssh');

const dataDir = path.resolve(process.env.WT_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const store = new Store(dataDir);
const id = String(process.argv[2] || '');
const p = /^[0-9a-f]{16}$/.test(id) ? store.get(id) : null;
if (!p) {
  console.error('wt-ssh: that connection does not exist (it may have been deleted).');
  process.exit(2);
}

const args = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4',
  '-p', String(p.port || 22),
];
const keyFile = store.keyPath(p.id);
if (p.keyName && fs.existsSync(keyFile)) args.push('-i', keyFile, '-o', 'IdentitiesOnly=yes');
args.push('-l', p.username, '--', p.host);

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'wtssh-'));
const env = {
  ...process.env,
  SSH_ASKPASS: path.join(__dirname, '..', 'bin', 'wt-askpass'),
  SSH_ASKPASS_REQUIRE: 'force',
  WT_SSH_STATE: path.join(state, 'used'),
};
delete env.WT_SSH_PASSWORD;
delete env.WT_SSH_PASSPHRASE;
if (p.password) env.WT_SSH_PASSWORD = store.open(p.password);
if (p.passphrase) env.WT_SSH_PASSPHRASE = store.open(p.passphrase);
// DISPLAY makes some ssh builds prefer a graphical prompt; the helper uses the terminal.
console.log(`\x1b[2mConnecting to ${p.username}@${p.host}${p.port && p.port !== 22 ? `:${p.port}` : ''}…\x1b[0m`);
const child = spawn('ssh', args, { stdio: 'inherit', env });
const done = (code, msg) => {
  fs.rmSync(state, { recursive: true, force: true });
  if (msg) console.error(msg);
  console.log(`\x1b[2m[ssh to ${p.name} ended${code ? ` (exit ${code})` : ''}. Press ↑ then Enter to connect again.]\x1b[0m`);
  process.exit(code || 0);
};
child.on('error', (e) => done(127, `wt-ssh: cannot run ssh: ${e.message}`));
child.on('exit', (code, sig) => done(code ?? (sig ? 128 : 0)));
