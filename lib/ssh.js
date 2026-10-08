'use strict';
// SSH connection profiles, kept on the server (DATA_DIR/ssh.json), and the API
// the page uses to manage them. A connection opens as a new session whose
// shell runs `wt-ssh <id>` (scripts/wt-ssh.js): ssh starts from this machine,
// so the profile's host is reached from here.
//
// Secrets: passwords and key passphrases are encrypted (AES-256-GCM) with a
// random key in DATA_DIR/ssh.key, so a copy of ssh.json alone (a backup, a
// screenshot of the folder) does not show them. Anyone who can read the whole
// data folder as this user can read both, and so can the connection itself:
// the password reaches ssh through SSH_ASKPASS in the environment of that one
// process. Key files live in DATA_DIR/ssh-keys, mode 0600. None of it is ever
// sent back to the page; it only learns that a password or key is set.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');

const MAX_PROFILES = 200;
const MAX_KEY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'ssh.json');
    this.keyFile = path.join(dataDir, 'ssh.key');
    this.keysDir = path.join(dataDir, 'ssh-keys');
  }
  secretKey() {
    try {
      const k = fs.readFileSync(this.keyFile);
      if (k.length === 32) return k;
    } catch { /* made below */ }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const k = crypto.randomBytes(32);
    fs.writeFileSync(this.keyFile, k, { mode: 0o600, flag: 'wx' });
    return fs.readFileSync(this.keyFile);
  }
  seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.secretKey(), iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }
  open(sealed) {
    if (!sealed) return '';
    const [v, iv, tag, ct] = String(sealed).split(':');
    if (v !== 'v1') return '';
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.secretKey(), Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    } catch { return ''; }
  }
  all() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.profiles) ? data.profiles : [];
    } catch { return []; }
  }
  save(profiles) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  get(id, owner) {
    return this.all().find((p) => p.id === id && (owner === undefined || p.owner === owner)) || null;
  }
  update(id, fn) {
    const all = this.all();
    const i = all.findIndex((p) => p.id === id);
    if (i < 0) return null;
    all[i] = fn({ ...all[i] }) || all[i];
    this.save(all);
    return all[i];
  }
  keyPath(id) { return path.join(this.keysDir, `${id}.key`); }
}

// What the page may see.
function publicView(p) {
  return {
    id: p.id, name: p.name, host: p.host, port: p.port, username: p.username,
    hasPassword: !!p.password, keyName: p.keyName || null, keyEncrypted: !!p.keyEncrypted,
    hasPassphrase: !!p.passphrase, keyFingerprint: p.keyFingerprint || null,
    created: p.created, updated: p.updated, lastUsed: p.lastUsed || null,
  };
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._:-]*[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._@\\-]*$/;
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, max);

function fields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = clean(body.name, 80);
  if (!partial || body.host !== undefined) {
    out.host = clean(body.host, 253).replace(/^\[|\]$/g, '');
    if (!HOST_RE.test(out.host)) throw new HttpError(400, 'Enter a host name or IP address (letters, digits, dots, dashes, colons).');
  }
  if (!partial || body.port !== undefined) {
    out.port = body.port === undefined || body.port === '' || body.port === null ? 22 : Number(body.port);
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new HttpError(400, 'The port must be a number from 1 to 65535.');
  }
  if (!partial || body.username !== undefined) {
    out.username = clean(body.username, 64);
    if (!USER_RE.test(out.username)) throw new HttpError(400, 'Enter the user name to log in as.');
  }
  return out;
}

// Prepares an uploaded key: PuTTY (.ppk) keys are converted to OpenSSH's
// format, Windows line endings and a missing final newline (which make ssh
// say "invalid format") are fixed, and the result is checked with ssh-keygen.
// Returns { text, encrypted, fingerprint, kind }.
async function prepareKey(buf, passphrase) {
  if (buf.length === 0 || buf.length > MAX_KEY_BYTES) throw new HttpError(400, 'That does not look like a key file (too big or empty).');
  let text = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim() + '\n';
  if (/\0/.test(text)) throw new HttpError(400, 'That is a binary file, not a key. Choose the .pem or .ppk private key.');
  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-)\S* /.test(text) || /BEGIN (SSH2 )?PUBLIC KEY/.test(text)) {
    throw new HttpError(400, 'That is a public key. Choose the private one (the file without .pub).');
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wtkey-'));
  try {
    let kind = 'openssh';
    const keyFile = path.join(tmp, 'key');
    if (text.startsWith('PuTTY-User-Key-File-')) {
      kind = 'ppk';
      const ppkEncrypted = !/^Encryption:\s*none\s*$/m.test(text);
      if (ppkEncrypted && !passphrase) throw new HttpError(422, 'This PuTTY key is protected by a passphrase. Enter it to convert the key.', { needPassphrase: true });
      const input = path.join(tmp, 'in.ppk');
      await fsp.writeFile(input, text, { mode: 0o600 });
      const args = [input, '-O', 'private-openssh-new', '-o', keyFile];
      if (ppkEncrypted) {
        const pf = path.join(tmp, 'pass');
        await fsp.writeFile(pf, passphrase, { mode: 0o600 });
        args.push('--old-passphrase', pf, '--new-passphrase', pf);
      }
      const r = await run('puttygen', args);
      if (r.err && r.err.code === 'ENOENT') throw new HttpError(500, 'Converting .ppk files needs puttygen on the server: sudo apt install putty-tools');
      if (r.err) {
        if (/passphrase/i.test(r.stderr)) throw new HttpError(422, 'Wrong passphrase for this PuTTY key.', { needPassphrase: true });
        throw new HttpError(400, `That PuTTY key could not be read: ${r.stderr.trim().split('\n')[0] || 'invalid file'}`);
      }
      text = await fsp.readFile(keyFile, 'utf8');
      await fsp.chmod(keyFile, 0o600);
    } else {
      if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) throw new HttpError(400, 'That is not a private key file (no "BEGIN ... PRIVATE KEY" line).');
      await fsp.writeFile(keyFile, text, { mode: 0o600 });
    }
    // Is it usable, and does it need a passphrase?
    let encrypted = false;
    let r = await run('ssh-keygen', ['-y', '-P', '', '-f', keyFile]);
    let pub = r.stdout;
    if (r.err) {
      if (r.err.code === 'ENOENT') throw new HttpError(500, 'ssh-keygen is not installed on the server (openssh-client).');
      if (/passphrase/i.test(r.stderr) || /incorrect/i.test(r.stderr)) {
        encrypted = true;
        if (passphrase) {
          r = await run('ssh-keygen', ['-y', '-P', passphrase, '-f', keyFile]);
          if (r.err) throw new HttpError(422, 'Wrong passphrase for this key.', { needPassphrase: true });
          pub = r.stdout;
        }
      } else {
        throw new HttpError(400, `That key could not be read: ${r.stderr.trim().split('\n').pop() || 'unknown format'}`);
      }
    }
    let fingerprint = null;
    if (pub) {
      const pf = path.join(tmp, 'pub');
      await fsp.writeFile(pf, pub);
      const f = await run('ssh-keygen', ['-l', '-f', pf]);
      if (!f.err) fingerprint = f.stdout.trim().split(/\s+/).slice(1, 2)[0] || null;
    }
    return { text, encrypted, fingerprint, kind };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

function router({ sessionFrom, sameOrigin, dataDir, terminals }) {
  const r = express.Router();
  const store = new Store(dataDir);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const json = express.json({ limit: '512kb' });

  r.use((req, res, next) => {
    req.session = sessionFrom(req);
    if (!req.session) return res.status(401).json({ error: 'Signed out. Reload the page.' });
    if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
    next();
  });
  const mine = (req) => {
    const p = store.get(req.params.id, req.session.email);
    if (!p) throw new HttpError(404, 'That connection no longer exists.');
    return p;
  };

  r.get('/profiles', (req, res) => {
    res.json({ profiles: store.all().filter((p) => p.owner === req.session.email).map(publicView) });
  });

  r.post('/profiles', json, wrap(async (req, res) => {
    const body = req.body || {};
    const f = fields(body, false);
    if (!f.name) f.name = `${f.username}@${f.host}`;
    const all = store.all();
    if (all.filter((p) => p.owner === req.session.email).length >= MAX_PROFILES) throw new HttpError(400, 'Too many connections. Delete some first.');
    const now = Date.now();
    const p = { id: crypto.randomBytes(8).toString('hex'), owner: req.session.email, ...f, created: now, updated: now };
    if (typeof body.password === 'string' && body.password) p.password = store.seal(body.password);
    all.push(p);
    store.save(all);
    res.status(201).json({ profile: publicView(p) });
  }));

  r.put('/profiles/:id', json, wrap(async (req, res) => {
    mine(req);
    const body = req.body || {};
    const f = fields(body, true);
    const updated = store.update(req.params.id, (p) => {
      Object.assign(p, f);
      if (!p.name) p.name = `${p.username}@${p.host}`;
      // absent: keep; null or '': remove; text: replace
      if (body.password === null || body.password === '') delete p.password;
      else if (typeof body.password === 'string') p.password = store.seal(body.password);
      if (body.passphrase === null || body.passphrase === '') delete p.passphrase;
      else if (typeof body.passphrase === 'string') p.passphrase = store.seal(body.passphrase);
      p.updated = Date.now();
      return p;
    });
    res.json({ profile: publicView(updated) });
  }));

  r.delete('/profiles/:id', wrap(async (req, res) => {
    mine(req);
    store.save(store.all().filter((p) => p.id !== req.params.id));
    await fsp.rm(store.keyPath(req.params.id), { force: true });
    res.json({ ok: true });
  }));

  // The key file: { filename, data (base64), passphrase? }
  r.put('/profiles/:id/key', json, wrap(async (req, res) => {
    mine(req);
    const body = req.body || {};
    if (typeof body.data !== 'string') throw new HttpError(400, 'No file received.');
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
    const key = await prepareKey(Buffer.from(body.data, 'base64'), passphrase);
    await fsp.mkdir(store.keysDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(store.keyPath(req.params.id), key.text, { mode: 0o600 });
    const updated = store.update(req.params.id, (p) => {
      p.keyName = clean(path.basename(String(body.filename || 'key')), 120) || 'key';
      p.keyEncrypted = key.encrypted;
      p.keyFingerprint = key.fingerprint;
      if (passphrase && key.encrypted) p.passphrase = store.seal(passphrase); else if (!key.encrypted) delete p.passphrase;
      p.updated = Date.now();
      return p;
    });
    res.json({ profile: publicView(updated), converted: key.kind === 'ppk' });
  }));

  r.delete('/profiles/:id/key', wrap(async (req, res) => {
    mine(req);
    await fsp.rm(store.keyPath(req.params.id), { force: true });
    const updated = store.update(req.params.id, (p) => {
      delete p.keyName; delete p.keyEncrypted; delete p.keyFingerprint; delete p.passphrase;
      p.updated = Date.now();
      return p;
    });
    res.json({ profile: publicView(updated) });
  }));

  // Opens the connection as a new session.
  r.post('/profiles/:id/connect', wrap(async (req, res) => {
    const p = mine(req);
    const tab = terminals.create(p.name, os.homedir(), { start: `wt-ssh ${p.id}` });
    if (!tab) throw new HttpError(400, 'Limit of terminals reached. Close one first.');
    store.update(p.id, (x) => { x.lastUsed = Date.now(); return x; });
    res.json({ id: tab.id });
  }));

  r.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('ssh:', err);
    if (res.headersSent) { res.destroy(); return; }
    res.status(status).json({ error: status === 413 ? 'That file is too big for a key.' : err.message, needPassphrase: err.needPassphrase || undefined });
  });
  return r;
}

module.exports = { router, Store };
