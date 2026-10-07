'use strict';
// Relay between a browser's noVNC (a WebSocket on /vnc) and this machine's VNC
// server (TigerVNC's Xvnc, or any RFB server), so the desktop can be shown in
// the page. Only signed-in sessions reach it (see server.js).
//
// If the user's VNC password file is readable (~/.vnc/passwd), the relay does
// the VNC password step with the VNC server itself and presents the browser
// with an open door ("no authentication"): getting here already took the web
// login, and the same user has a shell on this machine anyway. Otherwise the
// bytes are passed through untouched and noVNC asks for the VNC password.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOST = process.env.VNC_HOST || '127.0.0.1';
const PASSWORD_FILE = process.env.VNC_PASSWORD_FILE || path.join(os.homedir(), '.vnc', 'passwd');
const MAX_PER_SESSION = 3;

// The RFB port: VNC_PORT, else the Xvnc this user is running (-rfbport N, or
// display :N = 5900 + N), else 5901.
function findPort() {
  if (Number(process.env.VNC_PORT) > 0) return Number(process.env.VNC_PORT);
  try {
    const uid = process.getuid();
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (fs.statSync(`/proc/${pid}`).uid !== uid) continue;
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (!/(^|\/)(Xvnc|Xtigervnc)$/.test(args[0])) continue;
        const i = args.indexOf('-rfbport');
        if (i >= 0 && Number(args[i + 1]) > 0) return Number(args[i + 1]);
        const d = args.find((a) => /^:\d+$/.test(a));
        if (d) return 5900 + Number(d.slice(1));
      } catch { /* a process that went away */ }
    }
  } catch { /* no /proc */ }
  return 5901;
}
const PORT = findPort();

// Whether something answers on the VNC port; refreshed in the background, so
// the page only offers the desktop when there is one.
let up = false;
function probe() {
  const s = net.connect({ host: HOST, port: PORT });
  const done = (ok) => { up = ok; s.destroy(); };
  s.setTimeout(500, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
}
function watch() {
  probe();
  setInterval(probe, 15000).unref();
}

// ---- the VNC password: DES, which the OpenSSL in Node has switched off. A
// child process with the legacy provider does the two small jobs (reading the
// obfuscated password file, answering a challenge).
const DES_SCRIPT = `
const c = require('crypto');
const rev = (b) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i); return r; }; // VNC reverses the bits of each key byte
const [mode, keyHex, dataHex] = process.argv.slice(1);
const key = Buffer.from(keyHex, 'hex').map(rev);
const x = (mode === 'enc' ? c.createCipheriv : c.createDecipheriv)('des-ecb', key, null);
x.setAutoPadding(false);
process.stdout.write(Buffer.concat([x.update(Buffer.from(dataHex, 'hex')), x.final()]).toString('hex'));
`;
function des(mode, key, data) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--openssl-legacy-provider', '-e', DES_SCRIPT, mode, key.toString('hex'), data.toString('hex')],
      { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(Buffer.from(out.trim(), 'hex'))));
  });
}

let passwordCache = null; // { mtimeMs, key } (null key: no usable password file)
async function vncKey() {
  let st;
  try { st = fs.statSync(PASSWORD_FILE); } catch { return null; }
  if (passwordCache && passwordCache.mtimeMs === st.mtimeMs) return passwordCache.key;
  let key = null;
  try {
    const enc = fs.readFileSync(PASSWORD_FILE).subarray(0, 8);
    if (enc.length === 8) {
      const pw = await des('dec', Buffer.from([23, 82, 107, 6, 35, 78, 88, 7]), enc);
      key = Buffer.concat([pw, Buffer.alloc(8)]).subarray(0, 8); // the password, zero padded to 8
    }
  } catch (err) {
    console.error('vnc: cannot read the VNC password file:', err.message);
  }
  passwordCache = { mtimeMs: st.mtimeMs, key };
  return key;
}

// ---- reading an exact number of bytes from a stream of chunks
class Reader {
  constructor() { this.buf = Buffer.alloc(0); this.waiting = null; this.closed = false; }
  push(chunk) { this.buf = Buffer.concat([this.buf, chunk]); this.wake(); }
  close() { this.closed = true; this.wake(); }
  wake() {
    const w = this.waiting;
    if (!w) return;
    if (this.buf.length >= w.n) { this.waiting = null; const out = this.buf.subarray(0, w.n); this.buf = this.buf.subarray(w.n); w.resolve(out); }
    else if (this.closed) { this.waiting = null; w.reject(new Error('closed')); }
  }
  read(n) { return new Promise((resolve, reject) => { this.waiting = { n, resolve, reject }; this.wake(); }); }
  rest() { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
}

// Handshake with the VNC server as its client (RFB 3.8): version, security
// type, password challenge. Leaves it waiting for ClientInit.
async function authenticateUpstream(up, rd, key) {
  const hello = await rd.read(12);
  if (!/^RFB \d{3}\.\d{3}\n$/.test(hello.toString('latin1'))) throw new Error('not a VNC server');
  up.write('RFB 003.008\n');
  const count = (await rd.read(1))[0];
  if (count === 0) throw new Error('the VNC server refused the connection');
  const types = [...(await rd.read(count))];
  if (types.includes(1)) up.write(Buffer.from([1]));            // no authentication
  else if (types.includes(2) && key) {
    up.write(Buffer.from([2]));                                   // VNC authentication
    const challenge = await rd.read(16);
    up.write(await des('enc', key, challenge));
  } else throw new Error(`no usable VNC security type (${types.join(',')})`);
  if ((await rd.read(4)).readUInt32BE(0) !== 0) throw new Error('the VNC server rejected the password');
}

function bridge(ws, label) {
  const up = net.connect({ host: HOST, port: PORT });
  up.setNoDelay(true);
  const upRd = new Reader();
  const wsRd = new Reader();
  let live = false; // handshake done: bytes flow straight through
  let ended = false;
  const end = (why) => {
    if (ended) return;
    ended = true;
    if (why) console.log(`[vnc] ${label}: ${why}`);
    upRd.close(); wsRd.close();
    up.destroy();
    try { ws.close(); } catch { /* gone */ }
  };

  up.on('data', (d) => {
    if (!live) { upRd.push(d); return; }
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 8 * 1024 * 1024) up.pause();
    ws.send(d, { binary: true }, () => { if (!ended && ws.bufferedAmount < 1024 * 1024) up.resume(); });
  });
  up.on('error', (err) => end(`the VNC server: ${err.message}`));
  up.on('close', () => end());
  ws.on('message', (d) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(d);
    if (!live) { wsRd.push(b); return; }
    if (!up.write(b)) { ws.pause?.(); up.once('drain', () => ws.resume?.()); }
  });
  ws.on('close', () => end());
  ws.on('error', () => end());

  // Keep an idle connection alive, and notice a dead one.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const pinger = setInterval(() => { if (!alive) return end('no answer'); alive = false; try { ws.ping(); } catch { /* closing */ } }, 30000);
  pinger.unref();
  up.on('close', () => clearInterval(pinger));

  (async () => {
    const key = await vncKey();
    if (!key) {
      // No password to give: pass everything through; the browser will ask for it.
      live = true;
      const early = upRd.rest();
      if (early.length) ws.send(early, { binary: true });
      const pending = wsRd.rest();
      if (pending.length) up.write(pending);
      return;
    }
    await authenticateUpstream(up, upRd, key);
    // The browser's side: a server that wants no authentication.
    ws.send(Buffer.from('RFB 003.008\n'), { binary: true });
    await wsRd.read(12);
    ws.send(Buffer.from([1, 1]), { binary: true });
    await wsRd.read(1);
    ws.send(Buffer.from([0, 0, 0, 0]), { binary: true });
    live = true;
    const pending = wsRd.rest();
    if (pending.length) up.write(pending);
    const early = upRd.rest();
    if (early.length) ws.send(early, { binary: true });
  })().catch((err) => end(err.message));
}

module.exports = { bridge, watch, isUp: () => up, host: HOST, port: PORT, MAX_PER_SESSION };
