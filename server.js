'use strict';
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { checkCredentials, loadUsers, SessionStore, LoginLimiter } = require('./lib/auth');
const { TerminalManager } = require('./lib/terminals');

const PORT = Number(process.env.PORT || 7681);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const HOST = process.env.HOST || (TRUST_PROXY ? '127.0.0.1' : tailscaleIp() || '127.0.0.1');
const COOKIE = 'wt_sid';
const MAX_WS_BUFFER = 16 * 1024 * 1024;

function tailscaleIp() {
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

if (Object.keys(loadUsers()).length === 0) {
  console.error('No users configured. Create one first:  npm run set-user');
  process.exit(1);
}
if (HOST === '0.0.0.0' || HOST === '::') {
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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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
  if (TRUST_PROXY && req.headers['x-forwarded-host']) allowed.push(req.headers['x-forwarded-host']);
  return allowed.includes(host);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress;
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
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
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
};
app.get('/vendor/:file', (req, res) => {
  const rel = vendor[req.params.file];
  if (!rel) return res.sendStatus(404);
  res.sendFile(path.join(nm, rel));
});
app.use('/static', express.static(path.join(pub, 'static'), { index: false }));

app.get('/login', (req, res) => {
  if (sessionFrom(req)) return res.redirect('/');
  res.sendFile(path.join(pub, 'login.html'));
});

app.post('/api/login', express.json({ limit: '4kb' }), async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const ip = clientIp(req);
  const wait = limiter.blockedFor(ip);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });

  const { email, password } = req.body || {};
  const user = await checkCredentials(email, password);
  if (!user) {
    limiter.fail(ip);
    console.warn(`[auth] failed login for "${String(email).slice(0, 100)}" from ${ip}`);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  limiter.succeed(ip);
  console.log(`[auth] ${user} logged in from ${ip}`);
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

app.use((req, res) => res.sendStatus(404));

// ---------------------------------------------------------------- websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const clients = new Set();

server.on('upgrade', (req, socket, head) => {
  const session = new URL(req.url, 'http://x').pathname === '/ws' && sameOrigin(req) ? sessionFrom(req) : null;
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session));
});

function closeSocketsFor(sessionId) {
  for (const c of clients) if (c.sessionId === sessionId) c.ws.close(4001, 'logged out');
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

function attach(client, tab) {
  if (client.subs.has(tab.id)) return;
  const unsub = tab.subscribe(
    (data, size) => send(client, { t: 'snap', id: tab.id, d: data, cols: size.cols, rows: size.rows }),
    (data) => send(client, { t: 'out', id: tab.id, d: data }),
  );
  client.subs.set(tab.id, unsub);
}

function syncClient(client) {
  send(client, { t: 'list', tabs: terminals.list() });
  for (const info of terminals.list()) attach(client, terminals.get(info.id));
  for (const [id, unsub] of client.subs) {
    if (!terminals.get(id)) { unsub(); client.subs.delete(id); }
  }
}

terminals.on('changed', () => { for (const c of clients) syncClient(c); });

function onConnection(ws, session) {
  const client = { ws, sessionId: session.id, email: session.email, subs: new Map() };
  clients.add(client);
  send(client, { t: 'hello', email: session.email });
  syncClient(client);

  ws.on('message', (raw) => {
    if (!sessions.isValid(client.sessionId)) return ws.close(4001, 'session expired');
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const tab = typeof msg.id === 'string' ? terminals.get(msg.id) : null;

    switch (msg.t) {
      case 'in':
        if (tab && typeof msg.d === 'string') {
          sessions.touch(client.sessionId);
          tab.input(msg.d);
        }
        break;
      case 'resize':
        if (tab) tab.resize(Number(msg.cols), Number(msg.rows));
        break;
      case 'create': {
        const from = typeof msg.from === 'string' ? terminals.get(msg.from) : null;
        const created = terminals.create(msg.name, from ? from.currentCwd() : undefined);
        if (created) send(client, { t: 'created', id: created.id });
        break;
      }
      case 'rename':
        if (tab) terminals.rename(tab.id, msg.name);
        break;
      case 'close':
        if (tab) terminals.close(tab.id);
        break;
      case 'reorder':
        terminals.reorder(msg.ids);
        break;
      case 'ping':
        send(client, { t: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    for (const unsub of client.subs.values()) unsub();
    clients.delete(client);
  });
}

// Drop sockets whose session expired while they sat idle.
setInterval(() => {
  for (const c of clients) if (!sessions.isValid(c.sessionId)) c.ws.close(4001, 'session expired');
}, 60_000).unref();

// ---------------------------------------------------------------- lifecycle

server.listen(PORT, HOST, () => {
  console.log(`Web terminal listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
});

function shutdown() {
  terminals.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
