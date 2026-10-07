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

// Whether something listens on the VNC port; refreshed in the background, so
// the page only offers the desktop when there is one. This must never open a
// connection: TigerVNC counts every connection that closes before logging in
// as a security failure and, after a few, blocks the address ("Too many
// security failures"). So the kernel's list of listening sockets is read
// instead (for a VNC server on another machine, it is assumed to be there).
let up = false;
function listening(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c[3] === '0A' && c[1] && c[1].endsWith(`:${hex}`)) return true; // 0A = LISTEN
      }
    } catch { /* not Linux, or no IPv6 */ }
  }
  return false;
}
const LOCAL = /^(127\.|localhost$|::1$)/.test(HOST);
function probe() { up = LOCAL ? listening(PORT) : true; }
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
  if (hello.toString('latin1') === 'RFB 003.003\n') {
    // How TigerVNC turns a blocked address away: version 3.3, a zero "security type", a reason.
    const type = (await rd.read(4)).readUInt32BE(0);
    if (type === 0) {
      const len = (await rd.read(4)).readUInt32BE(0);
      throw new Error(`The VNC server refused the connection: ${(await rd.read(Math.min(len, 200))).toString('utf8') || 'no reason given'}`);
    }
    throw new Error('The VNC server only speaks the old RFB 3.3');
  }
  up.write('RFB 003.008\n');
  const count = (await rd.read(1))[0];
  if (count === 0) {
    const len = (await rd.read(4)).readUInt32BE(0);
    throw new Error(`The VNC server refused the connection: ${(await rd.read(Math.min(len, 200))).toString('utf8') || 'no reason given'}`);
  }
  const types = [...(await rd.read(count))];
  if (types.includes(1)) up.write(Buffer.from([1]));            // no authentication
  else if (types.includes(2) && key) {
    up.write(Buffer.from([2]));                                   // VNC authentication
    const challenge = await rd.read(16);
    up.write(await des('enc', key, challenge));
  } else throw new Error(`no usable VNC security type (${types.join(',')})`);
  if ((await rd.read(4)).readUInt32BE(0) !== 0) {
    let why = '';
    try { why = (await rd.read(Math.min((await rd.read(4)).readUInt32BE(0), 200))).toString('utf8'); } catch { /* no reason sent */ }
    throw new Error(`The VNC server rejected the login${why ? `: ${why}` : ''}`);
  }
}

// Where a connection goes. The page may name a host and a port (a VNC server
// elsewhere on the network, or this machine by another address); with neither
// it is this machine's own VNC server. The password step is done here only
// for this machine's own server (its ~/.vnc/passwd is the one that fits);
// any other target gets the bytes as they are, and noVNC asks for its password.
// The same user can open a terminal here and connect anywhere from it, so
// this gives no more than the login already does.
function localAddresses() {
  const s = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase()]);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) s.add(a.address.toLowerCase());
  return s;
}
function parseTarget(url) {
  const q = new URL(url, 'http://x').searchParams;
  const hostIn = String(q.get('host') || '').trim().replace(/^\[|\]$/g, '');
  const portIn = String(q.get('port') || '').trim();
  if (!hostIn && !portIn) return { host: HOST, port: PORT, shim: true, label: 'this machine' };
  const host = hostIn || HOST;
  if (!/^[A-Za-z0-9._:-]{1,253}$/.test(host)) return null;
  const local = localAddresses().has(host.toLowerCase());
  let port = portIn ? Number(portIn) : (local ? PORT : 5900);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (port < 100) port += 5900; // "host:1" means display 1, as in VNC clients
  return { host, port, shim: local && port === PORT, label: `${host}:${port}` };
}

// A network error, in words.
function explain(err, target) {
  const at = `${target.host}:${target.port}`;
  const why = {
    ECONNREFUSED: `Nothing is listening at ${at} (connection refused)`,
    ENOTFOUND: `${target.host} is not a known host name`,
    EAI_AGAIN: `${target.host} could not be looked up`,
    ETIMEDOUT: `${at} did not answer (timed out)`,
    EHOSTUNREACH: `${at} cannot be reached`,
    ENETUNREACH: `${at} cannot be reached`,
    ECONNRESET: `${at} closed the connection`,
  }[err.code];
  return why || `${at}: ${err.message}`;
}

function bridge(ws, label, target = { host: HOST, port: PORT, shim: true }) {
  const up = net.connect({ host: target.host, port: target.port });
  up.setNoDelay(true);
  const upRd = new Reader();
  const wsRd = new Reader();
  let live = false; // handshake done: bytes flow straight through
  let ended = false;
  let loggedIn = false; // the VNC server has accepted us
  let abandoned = false; // the browser left before that
  const end = (why, { upstreamToo = true } = {}) => {
    if (ended) return;
    ended = true;
    if (why) console.log(`[vnc] ${label}: ${why}`);
    wsRd.close();
    // Not the upstream side when the login is still being completed for a browser that left.
    if (upstreamToo) { upRd.close(); up.destroy(); }
    try { ws.close(); } catch { /* gone */ }
  };
  // A connection hung up before the VNC login finishes counts against this
  // machine at the VNC server (see probe()), so when the browser leaves
  // early the login is still completed, and the connection closed after it.
  const browserGone = () => {
    if (loggedIn || live) return end();
    abandoned = true;
    end(undefined, { upstreamToo: false });
  };

  up.on('data', (d) => {
    if (!live) { upRd.push(d); return; }
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 8 * 1024 * 1024) up.pause();
    ws.send(d, { binary: true }, () => { if (!ended && ws.bufferedAmount < 1024 * 1024) up.resume(); });
  });
  // Before the login is done, the handshake code below decides what a hang-up
  // means (it can tell the browser why); afterwards, a hang-up ends the relay.
  let upError = null;
  up.on('error', (err) => { upError = err; if (live) end(explain(err, target)); else upRd.close(); });
  up.setTimeout(15000, () => { if (!live && !loggedIn) up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
  up.on('close', () => { if (live) end(); else upRd.close(); });
  ws.on('message', (d) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(d);
    if (!live) { wsRd.push(b); return; }
    if (!up.write(b)) { ws.pause?.(); up.once('drain', () => ws.resume?.()); }
  });
  ws.on('close', browserGone);
  ws.on('error', browserGone);

  // Keep an idle connection alive, and notice a dead one.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const pinger = setInterval(() => { if (!alive) return end('no answer'); alive = false; try { ws.ping(); } catch { /* closing */ } }, 30000);
  pinger.unref();
  up.on('close', () => clearInterval(pinger));

  (async () => {
    const key = target.shim ? await vncKey() : null;
    if (!key) {
      // No password to give: pass everything through; the browser will ask for it.
      // Not before the server has said something, though: if it cannot be
      // reached, the browser can still be told why.
      const first = await upRd.read(12);
      let head = first;
      if (first.toString('latin1') === 'RFB 003.003\n') {
        // The old greeting is also how TigerVNC turns a blocked address away: read on, to tell the two apart.
        const type = await upRd.read(4);
        if (type.readUInt32BE(0) === 0) {
          const len = (await upRd.read(4)).readUInt32BE(0);
          throw new Error(`The VNC server refused the connection: ${(await upRd.read(Math.min(len, 200))).toString('utf8') || 'no reason given'}`);
        }
        head = Buffer.concat([first, type]);
      }
      live = true;
      ws.send(Buffer.concat([head, upRd.rest()]), { binary: true });
      const pending = wsRd.rest();
      if (pending.length) up.write(pending);
      return;
    }
    await authenticateUpstream(up, upRd, key);
    loggedIn = true;
    if (abandoned) { up.destroy(); return; }
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
  })().catch(async (err0) => {
    const err = upError && err0.message === 'closed' ? new Error(explain(upError, target))
      : err0.message === 'closed' ? new Error('The VNC server closed the connection') : err0;
    // Tell noVNC why, in its own protocol, so the page can show the reason: version, then "no security types" and the reason.
    if (!live && !abandoned && ws.readyState === ws.OPEN) {
      try {
        ws.send(Buffer.from('RFB 003.008\n'), { binary: true });
        await Promise.race([wsRd.read(12), new Promise((r) => setTimeout(r, 1500))]);
        const reason = Buffer.from(err.message.slice(0, 200));
        const head = Buffer.alloc(5);
        head.writeUInt8(0, 0);
        head.writeUInt32BE(reason.length, 1);
        ws.send(Buffer.concat([head, reason]), { binary: true });
        await new Promise((r) => setTimeout(r, 300));
      } catch { /* the browser is gone */ }
    }
    end(err.message);
    if (abandoned) { upRd.close(); up.destroy(); }
  });
}

module.exports = { bridge, watch, parseTarget, isUp: () => up, host: HOST, port: PORT, MAX_PER_SESSION };
