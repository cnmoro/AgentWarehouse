'use strict';
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { checkCredentials, loadUsers, SessionStore, LoginLimiter, DATA_DIR } = require('./lib/auth');
const { TerminalManager, SCROLLBACK } = require('./lib/terminals');
const files = require('./lib/files');
const ssh = require('./lib/ssh');
const vnc = require('./lib/vnc');
const vstream = require('./lib/stream');
const stt = require('./lib/stt');

// Configuration errors exit with 78 (EX_CONFIG); the systemd unit does not
// restart on that code, since retrying cannot help.
const EX_CONFIG = 78;

const PORT = Number(process.env.PORT || 7681);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TAILSCALE = tailscaleSelf();
const HOST = process.env.HOST || (TRUST_PROXY ? '127.0.0.1' : TAILSCALE.ipv4 || '127.0.0.1');
// More addresses to listen on besides HOST (for example this machine's address on the home network, so the page also opens
// from other devices there): LISTEN_ALSO=192.168.50.10 (comma-separated). Each one is also an accepted host name.
const LISTEN_ALSO = String(process.env.LISTEN_ALSO || '').split(',').map((a) => a.trim()).filter(Boolean);
const COOKIE = 'wt_sid';
const MAX_WS_BUFFER = 16 * 1024 * 1024;

function tailscaleSelf() {
  try {
    const st = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 }));
    const ips = st.Self?.TailscaleIPs || [];
    return {
      ipv4: ips.find((ip) => !ip.includes(':')) || null,
      names: [...ips, String(st.Self?.DNSName || '').replace(/\.$/, '')].filter(Boolean),
    };
  } catch {
    return { ipv4: null, names: [] };
  }
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

// Host names the browser may use to reach us. Anything else is refused, which
// stops DNS-rebinding pages from talking to the server under their own name.
const ALLOWED_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', HOST, ...LISTEN_ALSO, os.hostname(), ...TAILSCALE.names,
  ...String(process.env.ALLOWED_HOSTS || '').split(','),
].map((h) => h.trim().toLowerCase()).filter(Boolean));

if (!process.env.HOST && !TRUST_PROXY && !TAILSCALE.ipv4) {
  // Exiting (rather than quietly binding to localhost) lets systemd retry until Tailscale is up.
  console.error('Tailscale IP not found (is tailscaled up?). Set HOST to bind elsewhere.');
  process.exit(1);
}
if (TRUST_PROXY && !isLoopback(HOST)) {
  console.error('TRUST_PROXY=1 requires HOST to be a loopback address, or anyone could forge X-Forwarded-* headers.');
  process.exit(EX_CONFIG);
}
if (TRUST_PROXY && !TAILSCALE.names.length && !process.env.ALLOWED_HOSTS) {
  // Behind `tailscale serve` the browser uses the MagicDNS name; without it every request would get 421.
  console.error('Tailscale is not answering yet, so its host name is unknown. Exiting so systemd retries.');
  process.exit(1);
}

if (Object.keys(loadUsers()).length === 0) {
  console.error('No users configured. Create one first:  npm run set-user');
  process.exit(EX_CONFIG);
}
for (const name of ['SESSION_TTL_HOURS', 'SESSION_IDLE_HOURS', 'SCROLLBACK', 'PORT']) {
  const v = process.env[name];
  if (v !== undefined && !(Number(v) > 0 && Number.isFinite(Number(v)))) {
    console.error(`${name} must be a positive number, got "${v}".`);
    process.exit(EX_CONFIG);
  }
}
for (const name of ['HISTORY_LINES', 'HISTORY_MB']) {
  const v = process.env[name];
  if (v !== undefined && !(Number(v) >= 0 && Number.isFinite(Number(v)))) {
    console.error(`${name} must be 0 or a positive number, got "${v}".`);
    process.exit(EX_CONFIG);
  }
}
for (const a of LISTEN_ALSO) {
  if (!net.isIP(a)) {
    console.error(`LISTEN_ALSO has "${a}", which is not an IP address.`);
    process.exit(EX_CONFIG);
  }
}
if (HOST === '0.0.0.0' || HOST === '::' || LISTEN_ALSO.some((a) => a === '0.0.0.0' || a === '::')) {
  console.warn('WARNING: listening on all interfaces. Anyone who can reach this port gets a login page for a shell.');
}

const sessions = new SessionStore({
  ttlMs: Number(process.env.SESSION_TTL_HOURS || 168) * 3600_000,
  idleMs: Number(process.env.SESSION_IDLE_HOURS || 24) * 3600_000,
});
const limiter = new LoginLimiter();
const terminals = new TerminalManager();

// ---------------------------------------------------------------- helpers

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const value = part.slice(i + 1).trim();
    try { out[part.slice(0, i).trim()] = decodeURIComponent(value); } catch { out[part.slice(0, i).trim()] = value; }
  }
  return out;
}

function hostnameOf(hostHeader) {
  try { return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}

function allowedHost(req) {
  return ALLOWED_HOSTS.has(hostnameOf(req.headers.host));
}

function sessionFrom(req) {
  return sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
}

// Browsers always send Origin on WebSocket handshakes and on cross-site POSTs.
// Requiring it to match the host blocks cross-site WebSocket hijacking and CSRF.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const allowed = [req.headers.host];
  if (TRUST_PROXY && req.headers['x-forwarded-host']) {
    const fwd = String(req.headers['x-forwarded-host']);
    if (!ALLOWED_HOSTS.has(hostnameOf(fwd))) return false;
    allowed.push(fwd);
  }
  return allowed.includes(host);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    // The proxy appends the real peer address last; earlier entries are client-supplied.
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress;
}

function forLog(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 100);
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (!allowedHost(req)) {
    return res.status(421).type('text').send(`Unknown host. Add it to ALLOWED_HOSTS if this is intended.`);
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const pub = path.join(__dirname, 'public');
const nm = path.join(__dirname, 'node_modules');
const vendor = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  'addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-unicode11.js': '@xterm/addon-unicode11/lib/addon-unicode11.js',
  'marked.js': 'marked/lib/marked.umd.js',
  'purify.js': 'dompurify/dist/purify.min.js',
};
app.get('/vendor/:file', (req, res) => {
  if (!Object.hasOwn(vendor, req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(nm, vendor[req.params.file]));
});
// highlight.js for the Files panel's git diff. Its core is a CommonJS file: served as an ES module so the page can import it;
// the language files are ES modules already. Only names from the language folder are served.
let hljsCore = null;
app.get('/vendor/hljs/core.js', (req, res) => {
  try {
    hljsCore ||= `const module = { exports: {} };\n(function (module, exports) {\n${fs.readFileSync(path.join(nm, 'highlight.js/lib/core.js'), 'utf8')}\n})(module, module.exports);\nexport default module.exports;\n`;
  } catch { return res.sendStatus(404); }
  res.type('text/javascript').setHeader('Cache-Control', 'public, max-age=3600');
  res.send(hljsCore);
});
app.get('/vendor/hljs/languages/:name.js', (req, res) => {
  if (!/^[a-z0-9-]{1,30}$/.test(req.params.name)) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(nm, 'highlight.js/es/languages', `${req.params.name}.js`), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
});
app.use('/static', express.static(path.join(pub, 'static'), { index: false }));
// noVNC, the browser VNC client (ES modules: its core/ and vendor/ folders).
for (const dir of ['core', 'vendor']) {
  app.use(`/vendor/novnc/${dir}`, express.static(path.join(nm, '@novnc/novnc', dir), {
    index: false, dotfiles: 'deny', setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600'),
  }));
}

app.get('/login', (req, res) => {
  if (sessionFrom(req)) return res.redirect('/');
  res.sendFile(path.join(pub, 'login.html'));
});

app.post('/api/login', express.json({ limit: '4kb' }), async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const ip = clientIp(req);
  const slot = limiter.begin(ip);
  if (!slot.ok) {
    const wait = slot.retryAfter > 60 ? `${Math.ceil(slot.retryAfter / 60)} min` : `${slot.retryAfter} s`;
    res.setHeader('Retry-After', String(slot.retryAfter));
    return res.status(429).json({ error: `Too many attempts. Try again in ${wait}.` });
  }

  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    limiter.end(ip, false);
    return res.status(400).json({ error: 'Email or username and password are required' });
  }
  let user = null;
  try {
    user = await checkCredentials(email, password);
  } finally {
    limiter.end(ip, Boolean(user));
  }
  if (!user) {
    console.warn(`[auth] failed login for "${forLog(email)}" from ${ip}`);
    return res.status(401).json({ error: 'Invalid login or password' });
  }
  console.log(`[auth] ${user.email} logged in from ${ip}`);
  setSessionCookie(req, res, sessions.create(user), Math.floor(sessions.ttlMs / 1000));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const s = sessions.get(token);
  sessions.destroy(token);
  if (s) closeSocketsFor(s.id);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  if (!sessionFrom(req)) return res.redirect('/login');
  res.sendFile(path.join(pub, 'index.html'));
});

app.use('/api/files', files.router({ sessionFrom, sameOrigin, dataDir: DATA_DIR, terminals }));
app.use('/api/ssh', ssh.router({ sessionFrom, sameOrigin, dataDir: DATA_DIR, terminals }));
app.use('/api/stt', stt.router({ sessionFrom, sameOrigin }));

app.use((req, res) => res.sendStatus(404));

// No stack traces to the client (Express shows them unless NODE_ENV=production).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('request error:', err);
  res.status(status).json({ error: status === 500 ? 'Server error' : 'Bad request' });
});

// ---------------------------------------------------------------- websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
const clients = new Set();

// The desktop: noVNC's WebSocket, relayed to the VNC server (lib/vnc.js).
const vncWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const vncOpen = new Map(); // session id -> connections
const streamOpen = new Map(); // session id -> video streams
let streamsTotal = 0;

function onUpgrade(req, socket, head) {
  socket.on('error', () => {});
  let session = null;
  let route = null;
  try {
    const pathname = new URL(req.url, 'http://x').pathname;
    route = pathname === '/vnc' ? 'vnc' : pathname === '/vstream' ? 'vstream' : pathname === '/ws' ? 'ws' : null;
    const ok = route && allowedHost(req) && sameOrigin(req);
    session = ok ? sessionFrom(req) : null;
  } catch (err) {
    console.error('upgrade error:', err.message);
  }
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  if (route === 'vstream') {
    const opts = vstream.parseQuery(req.url);
    if (!opts || !vstream.info().ok) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if ((streamOpen.get(session.id) || 0) >= 2 || streamsTotal >= vstream.MAX_STREAMS) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    return vncWss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionId = session.id;
      streamOpen.set(session.id, (streamOpen.get(session.id) || 0) + 1);
      streamsTotal++;
      ws.on('close', () => { streamOpen.set(session.id, Math.max(0, (streamOpen.get(session.id) || 1) - 1)); streamsTotal = Math.max(0, streamsTotal - 1); });
      vstream.stream(ws, session.email, opts);
    });
  }
  if (route === 'vnc') {
    const target = vnc.parseTarget(req.url);
    if (!target) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if ((vncOpen.get(session.id) || 0) >= vnc.MAX_PER_SESSION) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    return vncWss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionId = session.id;
      vncOpen.set(session.id, (vncOpen.get(session.id) || 0) + 1);
      ws.on('close', () => vncOpen.set(session.id, Math.max(0, (vncOpen.get(session.id) || 1) - 1)));
      console.log(`[vnc] ${session.email} opened ${target.label}`);
      vnc.bridge(ws, `${session.email} -> ${target.label}`, target);
    });
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session));
}
server.on('upgrade', onUpgrade);

function closeSocketsFor(sessionId) {
  for (const c of clients) if (c.sessionId === sessionId) c.ws.close(4001, 'logged out');
  for (const ws of vncWss.clients) if (ws.sessionId === sessionId) ws.close(4001, 'logged out');
}

function send(client, msg) {
  const ws = client.ws;
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_WS_BUFFER) {
    // Client can't keep up; drop it. It reconnects and gets a fresh snapshot.
    ws.terminate();
    return;
  }
  ws.send(JSON.stringify(msg));
}

// Output is buffered per tab and sent once per event-loop turn: a pty hands
// over 20-50 byte reads, and one WebSocket message each is a lot of overhead.
function queueOutput(client, id, data) {
  client.out.set(id, (client.out.get(id) || '') + data);
  if (!client.flushScheduled) {
    client.flushScheduled = true;
    setImmediate(() => flushOutput(client));
  }
}

function flushOutput(client, onlyId) {
  if (!onlyId) client.flushScheduled = false;
  for (const [id, d] of client.out) {
    if (onlyId && id !== onlyId) continue;
    client.out.delete(id);
    send(client, { t: 'out', id, d });
  }
}

// Browsers attach to a tab when they first show it; until then they only get
// activity notices for it. That keeps reconnects cheap with many tabs.
function attach(client, tab) {
  if (client.subs.has(tab.id)) return;
  const id = tab.id;
  const handle = tab.subscribe({
    onSnapshot: (d, size, seq) => {
      flushOutput(client, id);
      send(client, { t: 'snap', id, d, seq, cols: size.cols, rows: size.rows });
    },
    onData: (d) => queueOutput(client, id, d),
    onSize: (size) => {
      flushOutput(client, id);
      send(client, { t: 'size', id, cols: size.cols, rows: size.rows });
    },
    onResync: () => {
      client.subs.delete(id);
      // Back off when a client keeps falling behind (slow link during a flood):
      // each resync costs a snapshot. Streak resets after a minute without one.
      const now = Date.now();
      const r = client.resyncs.get(id) || { n: 0, last: 0 };
      r.n = now - r.last > 60_000 ? 0 : r.n + 1;
      r.last = now;
      client.resyncs.set(id, r);
      const delay = r.n === 0 ? 0 : Math.min(30_000, 1000 * 2 ** (r.n - 1));
      setTimeout(() => {
        if (clients.has(client) && !client.subs.has(id) && terminals.get(id)) attach(client, terminals.get(id));
      }, delay);
    },
  });
  client.subs.set(id, handle);
}

function syncClient(client) {
  send(client, { t: 'list', tabs: terminals.list(), groups: terminals.listGroups() });
  for (const [id, handle] of client.subs) {
    if (!terminals.get(id)) {
      handle.close();
      client.subs.delete(id);
      client.out.delete(id);
    }
  }
}

terminals.on('changed', () => { for (const c of clients) syncClient(c); });
terminals.on('activity', (id) => {
  for (const c of clients) if (!c.subs.has(id)) send(c, { t: 'act', id });
});

function onConnection(ws, session) {
  const client = {
    ws, sessionId: session.id, email: session.email, subs: new Map(), out: new Map(), flushScheduled: false, resyncs: new Map(),
  };
  clients.add(client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(client, { t: 'hello', email: session.email, scrollback: SCROLLBACK, features: ['sessions', 'files', 'view', 'vnc', 'vnc-target', 'ssh', ...(vnc.isUp() ? ['vnc-local'] : []), ...(vstream.info().ok ? ['vnc-fluid:' + vstream.info().codecs.join('+') + (vstream.info().nvenc ? '+gpu' : '')] : [])] });
  syncClient(client);

  ws.on('message', (raw) => {
    try {
      handleMessage(client, raw);
    } catch (err) {
      console.error('message handler error:', err);
    }
  });

  // Oversized frames and protocol errors land here; without a handler they crash the process.
  ws.on('error', () => ws.terminate());

  ws.on('close', () => {
    for (const handle of client.subs.values()) handle.close();
    client.subs.clear();
    client.out.clear();
    clients.delete(client);
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const str = (v) => (typeof v === 'string' ? v : undefined);

function handleMessage(client, raw) {
  const ws = client.ws;
  if (!sessions.isValid(client.sessionId)) return ws.close(4001, 'session expired');
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const tab = typeof msg.id === 'string' ? terminals.get(msg.id) : null;

  switch (msg.t) {
    case 'in':
    case 'bin':
      if (tab && typeof msg.d === 'string') {
        sessions.touch(client.sessionId);
        tab.input(msg.d, msg.t === 'bin');
      }
      break;
    case 'attach':
      if (tab) attach(client, tab);
      break;
    case 'ack': {
      const handle = tab && client.subs.get(tab.id);
      if (handle) handle.ack(num(msg.seq), num(msg.n));
      break;
    }
    case 'resize':
      if (tab && num(msg.cols) > 0 && num(msg.rows) > 0) tab.resize(msg.cols, msg.rows);
      break;
    case 'create': {
      // With `group`: a new tab in that session. Otherwise a new session,
      // in the folder of the terminal `from`.
      // `cwd` (from the file browser's "Open in terminal") overrides both.
      const from = typeof msg.from === 'string' ? terminals.get(msg.from) : null;
      const group = typeof msg.group === 'string' ? msg.group : undefined;
      let cwd = from ? from.currentCwd() : undefined;
      let explicit = false;
      if (typeof msg.cwd === 'string') {
        try { cwd = files.resolvePath(msg.cwd); explicit = true; } catch { /* keep the default */ }
      }
      const created = terminals.create(str(msg.name), cwd, { group, explicitCwd: explicit });
      if (created) send(client, { t: 'created', id: created.id });
      else send(client, { t: 'error', msg: 'Limit of 50 terminals reached. Close one first.' });
      break;
    }
    case 'rename':
      if (tab && str(msg.name)) terminals.rename(tab.id, msg.name);
      break;
    case 'close':
      if (tab) terminals.close(tab.id);
      break;
    case 'reorder':
      if (Array.isArray(msg.ids)) terminals.reorder(msg.ids.filter((x) => typeof x === 'string'));
      break;
    case 'renameGroup':
      if (typeof msg.id === 'string' && str(msg.name)) terminals.renameGroup(msg.id, msg.name);
      break;
    case 'closeGroup':
      if (typeof msg.id === 'string') terminals.closeGroup(msg.id);
      break;
    case 'reorderGroups':
      if (Array.isArray(msg.ids)) terminals.reorderGroups(msg.ids.filter((x) => typeof x === 'string'));
      break;
    case 'ping':
      send(client, { t: 'pong' });
      break;
    case 'histInfo':
      if (tab) send(client, { t: 'histInfo', id: tab.id, info: tab.historyInfo() });
      break;
    case 'hist':
      if (tab && num(msg.from) >= 0) {
        const r = tab.historyRead(msg.from, Math.min(1000, num(msg.count) || 0), 512 * 1024);
        send(client, { t: 'histLines', id: tab.id, from: r.from, lines: r.lines, info: r.info });
      }
      break;
    case 'histSearch': {
      // One search per connection at a time; each yields between chunks.
      if (!tab || client.searching || typeof msg.q !== 'string' || !msg.q || msg.q.length > 200) break;
      if (!(num(msg.from) >= -1) || (msg.dir !== 1 && msg.dir !== -1)) break; // -1: search forward from line 0
      client.searching = true;
      const seq = num(msg.seq);
      tab.historySearch(msg.q, msg.from, msg.dir)
        .then((line) => send(client, { t: 'histFound', id: tab.id, seq, line, info: tab.historyInfo() }))
        .catch(() => send(client, { t: 'histFound', id: tab.id, seq, line: -1 }))
        .finally(() => { client.searching = false; });
      break;
    }
  }
}

// Drop sockets whose session expired, or whose user was removed or changed password.
setInterval(() => {
  try {
    for (const c of clients) {
      if (!sessions.isValid(c.sessionId, { checkUser: true })) c.ws.close(4001, 'session expired');
    }
    for (const ws of vncWss.clients) {
      if (!sessions.isValid(ws.sessionId, { checkUser: true })) ws.close(4001, 'session expired');
    }
  } catch (err) {
    console.error('session check failed:', err);
  }
}, 10_000).unref();

// ---------------------------------------------------------------- lifecycle

// Starts what runs once the first address is listening (not before: with nothing to serve, the shells would only be
// started to be stopped again).
let started = false;
function onFirstListening() {
  if (started) return;
  started = true;
  terminals.start();
  vnc.watch();
  vstream.probe();
}

server.on('error', (err) => {
  // The main address is not there (Tailscale is down) but others are listed in LISTEN_ALSO: serve on those and keep trying.
  if (LISTEN_ALSO.length && ['EADDRNOTAVAIL', 'ENETDOWN', 'ENETUNREACH'].includes(err.code)) {
    console.error(`Cannot listen on ${HOST}:${PORT} yet (${err.code}); serving on ${LISTEN_ALSO.join(', ')} meanwhile and trying again in 10 s.`);
    setTimeout(() => { if (!shuttingDown) server.listen(PORT, HOST); }, 10_000).unref();
    return;
  }
  // e.g. port already in use: exit instead of lingering with shells and no listener.
  console.error(`Cannot listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

// Protocol-level pings find connections whose network silently died.
setInterval(() => {
  for (const c of clients) {
    if (c.ws.isAlive === false) { c.ws.terminate(); continue; }
    c.ws.isAlive = false;
    c.ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  onFirstListening();
  console.log(`Web terminal listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
  console.log(`Accepted host names: ${[...ALLOWED_HOSTS].join(', ')}`);
});

// The extra addresses (LISTEN_ALSO): the same app on more servers. An address that is not there yet (a network that comes
// up after the service did) is tried again every 10 s instead of stopping the service.
const extraServers = [];
for (const addr of LISTEN_ALSO) {
  if (addr === HOST) continue;
  const srv = http.createServer(app);
  srv.on('upgrade', onUpgrade);
  extraServers.push(srv);
  const where = `http://${addr.includes(':') ? `[${addr}]` : addr}:${PORT}`;
  const start = () => srv.listen(PORT, addr);
  srv.on('listening', () => { onFirstListening(); console.log(`Also listening on ${where}`); });
  srv.on('error', (err) => {
    console.error(`Cannot listen on ${addr}:${PORT} yet (${err.code || err.message}); trying again in 10 s.`);
    setTimeout(() => { if (!shuttingDown) start(); }, 10_000).unref();
  });
  start();
}

// Last line of defence: an unexpected exception must not take every shell down
// with the process. Log it and keep serving.
process.on('uncaughtException', (err) => console.error('uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Whatever happens below, don't linger (systemd would wait, then SIGKILL).
  setTimeout(() => process.exit(0), 8000).unref();
  try {
    server.close();
    for (const x of extraServers) x.close();
    for (const c of clients) c.ws.terminate();
    await terminals.shutdown();
  } catch (err) {
    console.error('shutdown error:', err);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
