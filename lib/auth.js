'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Separate instances each need their own DATA_DIR (logins, tabs, history).
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
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

// Cached by mtime so the file can be checked often (password changes and
// removals take effect without a restart).
let usersCache = { mtimeMs: -1, users: {} };
function loadUsers() {
  let st;
  try {
    st = fs.statSync(USERS_FILE);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (st.mtimeMs !== usersCache.mtimeMs) {
    try {
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (!users || typeof users !== 'object' || Array.isArray(users)) throw new Error('not an object');
      usersCache = { mtimeMs: st.mtimeMs, users };
    } catch (err) {
      // A half-written hand edit: keep the last good copy rather than failing.
      console.error(`Cannot read ${USERS_FILE}: ${err.message}. Keeping the previous users.`);
      usersCache.mtimeMs = st.mtimeMs;
    }
  }
  return usersCache.users;
}

// Changes whenever the user's password changes; sessions carry it so that a
// password change or removal ends existing sessions.
function userFingerprint(email) {
  const users = loadUsers();
  if (!Object.hasOwn(users, email)) return null;
  return crypto.createHash('sha256').update(users[email].hash).digest('hex').slice(0, 32);
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
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  if (password.length === 0 || password.length > 1024) return null;
  const users = loadUsers();
  const key = normalizeEmail(email);
  const user = Object.hasOwn(users, key) ? users[key] : null;
  const ok = await verifyPassword(password, user ? user.hash : await getDummyHash());
  return ok && user ? { email: key, fp: userFingerprint(key) } : null;
}

// ---- Sessions (in memory; a server restart logs everyone out) ----

class SessionStore {
  constructor({ ttlMs, idleMs }) {
    this.ttlMs = ttlMs;
    this.idleMs = idleMs;
    this.sessions = new Map(); // sha256(token) -> { email, fp, created, lastSeen }
    setInterval(() => this.sweep(), 10_000).unref();
  }

  static digest(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  create({ email, fp }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(SessionStore.digest(token), { email, fp, created: now, lastSeen: now });
    return token;
  }

  get(token) {
    if (!token) return null;
    const id = SessionStore.digest(token);
    if (!this.isValid(id, { checkUser: true })) {
      this.sessions.delete(id);
      return null;
    }
    const s = this.sessions.get(id);
    s.lastSeen = Date.now();
    return { id, ...s };
  }

  destroy(token) {
    if (token) this.sessions.delete(SessionStore.digest(token));
  }

  isValid(id, { checkUser = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return false;
    const now = Date.now();
    if (now - s.created > this.ttlMs || now - s.lastSeen > this.idleMs) return false;
    return !checkUser || userFingerprint(s.email) === s.fp;
  }

  touch(id) {
    const s = this.sessions.get(id);
    if (s) s.lastSeen = Date.now();
  }

  sweep() {
    try {
      for (const id of this.sessions.keys()) {
        if (!this.isValid(id, { checkUser: true })) this.sessions.delete(id);
      }
    } catch (err) {
      console.error('session sweep failed:', err);
    }
  }
}

// ---- Login throttling ----
// Every attempt is counted before the password is checked, so parallel
// requests can't slip past the limit while hashes are in flight. There is
// deliberately no global lockout: that would let anyone lock the owner out.

class LoginLimiter {
  constructor({ maxPerIp = 5, windowMs = 15 * 60_000, maxInFlight = 4 } = {}) {
    Object.assign(this, { maxPerIp, windowMs, maxInFlight });
    this.byIp = new Map(); // ip -> [timestamps]
    this.inFlight = 0;
    setInterval(() => this.sweep(), windowMs).unref();
  }

  recent(ip, now) {
    const list = (this.byIp.get(ip) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.byIp.set(ip, list);
    else this.byIp.delete(ip);
    return list;
  }

  // Returns { ok: true } and reserves an attempt, or { ok: false, retryAfter } (seconds).
  begin(ip) {
    const now = Date.now();
    const list = this.recent(ip, now);
    if (list.length >= this.maxPerIp) {
      return { ok: false, retryAfter: Math.ceil((this.windowMs - (now - list[0])) / 1000) };
    }
    if (this.inFlight >= this.maxInFlight) return { ok: false, retryAfter: 1 };
    list.push(now);
    this.byIp.set(ip, list);
    this.inFlight++;
    return { ok: true };
  }

  end(ip, success) {
    this.inFlight--;
    if (success) this.byIp.delete(ip);
  }

  sweep() {
    const now = Date.now();
    for (const ip of [...this.byIp.keys()]) this.recent(ip, now);
  }
}

module.exports = {
  DATA_DIR,
  hashPassword, verifyPassword, normalizeEmail, loadUsers, saveUsers,
  checkCredentials, userFingerprint, SessionStore, LoginLimiter,
};
