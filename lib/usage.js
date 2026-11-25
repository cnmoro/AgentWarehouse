'use strict';
// Plan usage of the coding agents installed for the user this server runs as: Claude Code (the 5-hour and weekly
// limits of the claude.ai plan), Codex (the ChatGPT plan's windows) and OpenCode (the OpenCode Go plan's meters). Each is read with the credentials the tool itself keeps in this user's home, the same way
// the tool's own usage screen does; nothing is refreshed or written, so a token that expired stays expired until the
// tool is used again. Polled while a page is connected and pushed to every page.
const fs = require('fs');
const os = require('os');
const path = require('path');

const POLL_MS = 60 * 1000;
const BACKOFF_MS = 5 * 60 * 1000; // after a 429 or a network failure
const TIMEOUT_MS = 10 * 1000;

const home = os.homedir();
const FILES = {
  claude: path.join(home, '.claude', '.credentials.json'),
  codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'),
  opencode: path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json'),
  opencodeDb: path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'opencode.db'),
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

class HttpError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
  }
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { 'User-Agent': 'agent-warehouse', Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = body && body.error;
    throw new HttpError(res.status, (e && (e.code || e.type || e.message)) || (typeof e === 'string' ? e : '') || `HTTP ${res.status}`);
  }
  return body;
}

// A failed request, in a few words for the panel (never the token, never a whole response).
function problem(err) {
  if (err.status === 401 || err.status === 403) return /expired/i.test(err.message) ? 'key expired' : 'not signed in (token expired or revoked)';
  if (err.status === 429) return 'rate limited, retrying later';
  if (err.status) return `error ${err.status}`;
  return 'unreachable';
}

const windowLabel = (seconds) => {
  if (seconds === 5 * 3600) return '5h';
  if (seconds === 7 * 86400) return 'Week';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  return `${Math.round(seconds / 3600)}h`;
};
const pct = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null);

async function claude() {
  const c = readJson(FILES.claude)?.claudeAiOauth;
  if (!c || !c.accessToken) return null;
  const tier = String(c.rateLimitTier || '').replace(/^default_claude_/, '').replace(/_/g, ' ');
  const out = { id: 'claude', name: 'Claude', plan: [c.subscriptionType, tier].filter(Boolean).join(' · '), meters: [] };
  if (Number.isFinite(c.expiresAt) && c.expiresAt < Date.now()) {
    out.note = 'token expired: it renews the next time Claude Code runs';
    return out;
  }
  const d = await getJson('https://api.anthropic.com/api/oauth/usage', { Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' });
  if (Array.isArray(d.limits) && d.limits.length) {
    for (const l of d.limits) {
      const model = l.scope && l.scope.model && l.scope.model.display_name;
      const label = l.kind === 'session' ? '5h' : l.group === 'weekly' ? (model ? `Week · ${model}` : 'Week') : (model || l.kind);
      out.meters.push({ label, percent: pct(l.percent), resetsAt: l.resets_at || null, severity: l.severity || null });
    }
  } else {
    for (const [key, label] of [['five_hour', '5h'], ['seven_day', 'Week'], ['seven_day_opus', 'Week · Opus'], ['seven_day_sonnet', 'Week · Sonnet']]) {
      if (d[key]) out.meters.push({ label, percent: pct(d[key].utilization), resetsAt: d[key].resets_at || null });
    }
  }
  return out;
}

async function codex() {
  const a = readJson(FILES.codex);
  const t = a && a.tokens;
  if (!t || !t.access_token) return a && a.OPENAI_API_KEY ? { id: 'codex', name: 'Codex', plan: 'API key', meters: [], note: 'pay per use: no plan limits' } : null;
  const out = { id: 'codex', name: 'Codex', plan: '', meters: [] };
  const d = await getJson('https://chatgpt.com/backend-api/wham/usage', { Authorization: `Bearer ${t.access_token}`, 'ChatGPT-Account-Id': t.account_id || '' });
  out.plan = d.plan_type || '';
  const r = d.rate_limit || {};
  for (const w of [r.primary_window, r.secondary_window]) {
    if (!w) continue;
    const resetsAt = Number.isFinite(w.reset_at) ? new Date(w.reset_at * 1000).toISOString() : null;
    out.meters.push({ label: windowLabel(w.limit_window_seconds), percent: pct(w.used_percent), resetsAt, severity: r.limit_reached ? 'critical' : null });
  }
  if (!out.meters.length) out.note = 'no limits reported';
  return out;
}

// OpenCode's sign-in (`opencode auth login`, OAuth) lives in its database; an API key for the Go plan, in auth.json.
function opencodeOauth() {
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(FILES.opencodeDb, { readOnly: true });
    const row = db.prepare("SELECT value FROM credential WHERE integration_id = 'opencode' AND active = 1 ORDER BY time_updated DESC LIMIT 1").get();
    const v = row && JSON.parse(row.value);
    return v && v.type === 'oauth' && v.access ? { token: v.access, expires: v.expires } : null;
  } catch {
    return null; // no database, or a Node without node:sqlite
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
}

async function opencode() {
  const oauth = fs.existsSync(FILES.opencodeDb) ? opencodeOauth() : null;
  const a = readJson(FILES.opencode);
  const key = a && a['opencode-go'] && a['opencode-go'].key;
  if (!oauth && !key) return null;
  const out = { id: 'opencode', name: 'OpenCode', plan: 'Go', meters: [] };
  // The sign-in first while it is current (OpenCode renews it when it runs), then the key.
  const tokens = [];
  if (oauth && !(Number.isFinite(oauth.expires) && oauth.expires < Date.now())) tokens.push(oauth.token);
  if (key) tokens.push(key);
  if (!tokens.length) {
    out.note = 'sign-in expired: it renews the next time OpenCode runs';
    return out;
  }
  let lastErr = null;
  for (const token of tokens) {
    try {
      const body = await getJson('https://opencode.ai/inference/go/v1/usage', { Authorization: `Bearer ${token}` });
      const d = (body && body.usage) || body || {};
      for (const [k, label] of [['rolling', '5h'], ['weekly', 'Week'], ['monthly', 'Month']]) {
        const m = d[k];
        if (m) out.meters.push({ label, percent: pct(m.percent), resetsAt: m.resetsAt || null, severity: m.status === 'rate-limited' ? 'critical' : null });
      }
      return out;
    } catch (err) {
      lastErr = err;
      if (err.status === 429 || !err.status) throw err;
    }
  }
  out.note = oauth && lastErr && (lastErr.status === 401 || lastErr.status === 403)
    ? 'sign-in expired: it renews the next time OpenCode runs'
    : problem(lastErr);
  return out;
}

const SOURCES = [['claude', claude], ['codex', codex], ['opencode', opencode]];

class Usage {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.last = new Map(); // id -> provider entry (kept when a later poll fails, marked stale)
    this.next = new Map(); // id -> earliest time to ask again
    this.timer = null;
    this.running = false;
    this.data = null;
  }

  // Whether any of the tools has credentials here (the page shows the panel only then).
  available() {
    return Object.values(FILES).some((f) => fs.existsSync(f));
  }

  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const providers = [];
      await Promise.all(SOURCES.map(async ([id, fn], i) => {
        let entry;
        if ((this.next.get(id) || 0) > Date.now()) {
          entry = this.last.get(id);
        } else {
          try {
            entry = await fn();
            if (entry) entry.at = Date.now();
            this.last.set(id, entry);
          } catch (err) {
            if (err.status === 429 || !err.status) this.next.set(id, Date.now() + BACKOFF_MS);
            const prev = this.last.get(id);
            entry = prev ? { ...prev, stale: true, note: problem(err) } : { id, name: id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : 'OpenCode', plan: '', meters: [], note: problem(err) };
          }
        }
        if (entry) providers[i] = entry;
      }));
      this.data = { at: Date.now(), providers: providers.filter(Boolean) };
      this.onUpdate(this.data);
    } finally {
      this.running = false;
    }
  }

  // Polls while `on` (some page is connected).
  watch(on) {
    if (on && !this.timer) {
      if (!this.data || Date.now() - this.data.at > POLL_MS) this.poll();
      this.timer = setInterval(() => this.poll(), POLL_MS);
      this.timer.unref();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { Usage };
