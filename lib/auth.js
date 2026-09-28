'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// scrypt parameters: N=2^15, r=8, p=1 (~32 MB, ~100 ms per hash).
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

function scrypt(password, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

// A fixed hash to verify against when the email is unknown, so response time
// does not reveal whether an account exists.
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

async function checkCredentials(email, password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return null;
  const users = loadUsers();
  const key = normalizeEmail(email);
  const user = Object.hasOwn(users, key) ? users[key] : null;
  const ok = await verifyPassword(password, user ? user.hash : await getDummyHash());
  return ok && user ? key : null;
}

// ---- Sessions (in memory; a server restart logs everyone out) ----

class SessionStore {
  constructor({ ttlMs, idleMs }) {
    this.ttlMs = ttlMs;
    this.idleMs = idleMs;
    this.sessions = new Map(); // sha256(token) -> { email, created, lastSeen }
    setInterval(() => this.sweep(), 60_000).unref();
  }

  static digest(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  create(email) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(SessionStore.digest(token), { email, created: now, lastSeen: now });
    return token;
  }

  get(token) {
    if (!token) return null;
    const id = SessionStore.digest(token);
    const s = this.sessions.get(id);
    if (!s) return null;
    const now = Date.now();
    if (now - s.created > this.ttlMs || now - s.lastSeen > this.idleMs) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = now;
    return { id, ...s };
  }

  destroy(token) {
    if (token) this.sessions.delete(SessionStore.digest(token));
  }

  isValid(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    const now = Date.now();
    return now - s.created <= this.ttlMs && now - s.lastSeen <= this.idleMs;
  }

  touch(id) {
    const s = this.sessions.get(id);
    if (s) s.lastSeen = Date.now();
  }

  sweep() {
    for (const id of this.sessions.keys()) {
      if (!this.isValid(id)) this.sessions.delete(id);
    }
  }
}

// ---- Login throttling ----

class LoginLimiter {
  constructor({ maxPerIp = 5, maxGlobal = 30, windowMs = 15 * 60_000 } = {}) {
    Object.assign(this, { maxPerIp, maxGlobal, windowMs });
    this.byIp = new Map(); // ip -> [timestamps]
    this.global = [];
  }

  prune(list, now) {
    while (list.length && now - list[0] > this.windowMs) list.shift();
  }

  // Returns seconds until the caller may retry, or 0 if allowed.
  blockedFor(ip) {
    const now = Date.now();
    this.prune(this.global, now);
    const list = this.byIp.get(ip) || [];
    this.prune(list, now);
    if (list.length >= this.maxPerIp) return Math.ceil((this.windowMs - (now - list[0])) / 1000);
    if (this.global.length >= this.maxGlobal) return Math.ceil((this.windowMs - (now - this.global[0])) / 1000);
    return 0;
  }

  fail(ip) {
    const now = Date.now();
    const list = this.byIp.get(ip) || [];
    list.push(now);
    this.byIp.set(ip, list);
    this.global.push(now);
  }

  succeed(ip) {
    this.byIp.delete(ip);
  }
}

module.exports = {
  hashPassword, verifyPassword, normalizeEmail, loadUsers, saveUsers,
  checkCredentials, SessionStore, LoginLimiter,
};
