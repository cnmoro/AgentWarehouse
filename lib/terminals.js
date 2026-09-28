'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const pty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TABS_FILE = path.join(DATA_DIR, 'tabs.json');
const SCROLLBACK = Number(process.env.SCROLLBACK || 10000);
const MAX_NAME = 60;
const MAX_TABS = 50;

// Flow control. The pty is paused while the server mirror has too many chunks
// waiting to be parsed, or while a browser has too much output it has not yet
// acknowledged (i.e. not yet rendered). Without the second part a fast
// producer fills the browser's queue and Ctrl+C takes seconds to show up.
const HIGH_WATER = 64;             // chunks queued in the mirror
const LOW_WATER = 8;
const ACK_HIGH = 1024 * 1024;      // chars sent to a browser but not acknowledged
const ACK_LOW = 256 * 1024;
// A browser that stays over ACK_HIGH this long (sleeping laptop, background tab)
// stops holding up the shell. It gets no more output and receives a fresh
// snapshot once it catches up.
const STALL_MS = 5000;

// Snapshots are serialized one per event-loop turn so reconnecting with many
// big tabs does not block the server for seconds.
const snapshotQueue = [];
function queueSnapshot(fn) {
  snapshotQueue.push(fn);
  if (snapshotQueue.length === 1) setImmediate(runSnapshots);
}
function runSnapshots() {
  const fn = snapshotQueue.shift();
  try { fn(); } catch (err) { console.error('snapshot failed:', err); }
  if (snapshotQueue.length) setImmediate(runSnapshots);
}
// Random start so acks from a page that outlived a server restart can't match.
let nextSubId = 1 + Math.floor(Math.random() * 1e9);

// Snapshots above this size are cut down to less scrollback: a huge message
// blocks the server while it is built and can take many seconds to deliver.
const MAX_SNAPSHOT = 4 * 1024 * 1024;

// Colours the mirror reports when programs ask (OSC 4/10/11/12). Keep in sync
// with THEME in public/static/app.js.
const THEME = {
  foreground: '#d6dde6', background: '#0e1116', cursor: '#5fb3ff',
  ansi: ['#1b2029', '#f0706a', '#4fce8a', '#e0b04d', '#5fb3ff', '#c792ea', '#56c8d8', '#d6dde6',
    '#5c6676', '#ff8c85', '#6fe3a2', '#f2c66b', '#82c4ff', '#d7a9f5', '#7ad8e5', '#ffffff'],
};

function xtermRgb(hex) {
  const h = hex.replace('#', '');
  return 'rgb:' + [0, 2, 4].map((i) => h.slice(i, i + 2).repeat(2)).join('/');
}

function paletteColor(n) {
  if (n < 16) return THEME.ansi[n];
  const hex = (v) => v.toString(16).padStart(2, '0');
  if (n < 232) {
    const c = n - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return '#' + [Math.floor(c / 36), Math.floor(c / 6) % 6, c % 6].map((v) => hex(level(v))).join('');
  }
  const g = 8 + (n - 232) * 10;
  return '#' + hex(g).repeat(3);
}

// Variables from the server's own environment that the shells should not inherit.
const STRIP_ENV = ['PORT', 'HOST', 'SESSION_TTL_HOURS', 'SESSION_IDLE_HOURS', 'SCROLLBACK', 'TRUST_PROXY', 'ALLOWED_HOSTS'];

function cleanName(name, fallback) {
  const s = String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
  return s || fallback;
}

function usableDir(dir) {
  // readlink of /proc/<pid>/cwd appends " (deleted)" once the folder is gone.
  const d = String(dir || '').replace(/ \(deleted\)$/, '');
  try {
    if (d && fs.statSync(d).isDirectory()) return d;
  } catch { /* fall through */ }
  return os.homedir();
}

function shellEnv() {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

class Tab {
  constructor(manager, { id, name, cwd }) {
    this.manager = manager;
    this.id = id;
    this.name = name;
    this.cwd = usableDir(cwd);
    this.cols = 120;
    this.rows = 32;
    this.pty = null;
    this.alive = false;
    this.pending = 0;
    this.paused = false;
    this.flowTimer = null;
    this.subscribers = new Set();
    this.version = 0;          // bumps on every change to the mirror
    this.lastActivity = 0;
    this.snapshotCache = null; // { version, screen }

    // Server-side mirror of the screen. Every byte from the pty goes through it,
    // so a browser that (re)connects gets the exact current screen, including
    // the alternate buffer used by full-screen TUIs, plus scrollback.
    this.mirror = new HeadlessTerminal({
      cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);
    // Same character-width tables as the browser, or emoji shift columns.
    this.mirror.loadAddon(new Unicode11Addon());
    this.mirror.unicode.activeVersion = '11';
    // Programs query the terminal (cursor position, device attributes...). The
    // mirror is the one terminal that always exists, so it answers; browsers don't.
    this.mirror.onData((reply) => { if (this.alive) this.pty.write(reply); });
    this.answerColorQueries();

    this.spawn();
  }

  spawn() {
    const shell = process.env.SHELL || '/bin/bash';
    this.cwd = usableDir(this.cwd);
    this.pty = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: shellEnv(),
    });
    this.alive = true;
    this.paused = false;
    const p = this.pty;
    p.onData((data) => this.output(data));
    p.onExit(({ exitCode }) => {
      clearTimeout(this.killTimer);
      if (this.pty !== p) return;
      this.alive = false;
      this.paused = false;
      this.output(`\r\n\x1b[2m[process exited with code ${exitCode} — press Enter to start a new shell]\x1b[0m\r\n`);
      this.manager.emit('changed');
    });
  }

  // Feed data to the mirror and, once parsed, to subscribers. Broadcasting from
  // the parse callback keeps live output and snapshots in the same order.
  output(data) {
    if (this.disposed) return;
    this.pending++;
    this.updateFlow();
    this.mirror.write(data, () => {
      if (this.disposed) return;
      this.pending--;
      this.version++;
      this.snapshotCache = null;
      this.trackPartial(data);
      const now = Date.now();
      if (now - this.lastActivity > 1000) {
        this.lastActivity = now;
        this.manager.emit('activity', this.id);
      }
      for (const sub of this.subscribers) {
        if (sub.stalled) { sub.skipped = true; continue; }
        sub.unacked += data.length;
        sub.onData(data);
      }
      this.updateFlow();
    });
  }

  updateFlow() {
    if (this.disposed) return;
    const now = Date.now();
    // Hysteresis: once paused, stay paused until everything is below the low marks.
    let blocked = this.pending > (this.paused ? LOW_WATER : HIGH_WATER);
    let nextCheck = Infinity;
    for (const sub of this.subscribers) {
      if (sub.stalled) continue;
      if (sub.unacked > (this.paused ? ACK_LOW : ACK_HIGH)) {
        // A client still working through its snapshot can't ack live output
        // yet. Holding the program back for it would freeze everyone, so it is
        // treated as stalled straight away.
        if (sub.snapOwed > 0) {
          sub.stalled = true;
          continue;
        }
        sub.overSince ??= now;
        if (now - sub.overSince >= STALL_MS) {
          sub.stalled = true;
          continue;
        }
        blocked = true;
        nextCheck = Math.min(nextCheck, sub.overSince + STALL_MS);
      } else {
        sub.overSince = null;
      }
    }
    if (blocked !== this.paused) {
      this.paused = blocked;
      if (this.alive) {
        try { blocked ? this.pty.pause() : this.pty.resume(); } catch { /* exiting */ }
      }
    }
    clearTimeout(this.flowTimer);
    this.flowTimer = nextCheck < Infinity ? setTimeout(() => this.updateFlow(), Math.max(10, nextCheck - now)) : null;
  }

  // The headless terminal does not answer colour queries, and browsers are told
  // not to (they would answer once each), so answer them here.
  answerColorQueries() {
    const reply = (s) => { if (this.alive) this.pty.write(s); };
    const dynamic = { 10: THEME.foreground, 11: THEME.background, 12: THEME.cursor };
    for (const [code, color] of Object.entries(dynamic)) {
      this.mirror.parser.registerOscHandler(Number(code), (data) => {
        if (data !== '?') return false;
        reply(`\x1b]${code};${xtermRgb(color)}\x1b\\`);
        return true;
      });
    }
    this.mirror.parser.registerOscHandler(4, (data) => {
      const parts = data.split(';');
      if (!parts.includes('?')) return false;
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const n = Number(parts[i]);
        if (parts[i + 1] === '?' && Number.isInteger(n) && n >= 0 && n < 256) {
          reply(`\x1b]4;${n};${xtermRgb(paletteColor(n))}\x1b\\`);
        }
      }
      return true;
    });
  }

  // Terminal state the serialize addon does not restore: mouse encoding, cursor
  // visibility and style, and the scroll region.
  extraState() {
    const core = this.mirror._core;
    let out = '';
    try {
      const enc = core.coreMouseService.activeEncoding;
      if (enc === 'SGR') out += '\x1b[?1006h';
      else if (enc === 'SGR_PIXELS') out += '\x1b[?1016h';

      const buf = core.buffer;
      const origin = core.coreService.decPrivateModes.origin;
      if (buf.scrollTop !== 0 || buf.scrollBottom !== this.mirror.rows - 1) {
        out += `\x1b[${buf.scrollTop + 1};${buf.scrollBottom + 1}r`;
      }
      // Always finish with an absolute cursor position: DECSTBM homes the cursor,
      // and the addon's relative moves land one column off after a full-width
      // last line (pending wrap).
      out += `\x1b[${buf.y + 1 - (origin ? buf.scrollTop : 0)};${Math.min(buf.x, this.mirror.cols - 1) + 1}H`;

      const modes = core.coreService.decPrivateModes;
      if (modes.cursorStyle) {
        const base = { block: 1, underline: 3, bar: 5 }[modes.cursorStyle];
        if (base) out += `\x1b[${base + (modes.cursorBlink === false ? 1 : 0)} q`;
      }
      if (core.coreService.isCursorHidden) out += '\x1b[?25l';
    } catch { /* internals changed; the snapshot is still usable without these */ }
    return out;
  }

  snapshot() {
    if (this.snapshotCache?.version !== this.version) {
      // Heavily coloured history serializes to many bytes per line; keep fewer
      // lines then. Estimate from the newest 500 lines before doing the full job.
      let lines = SCROLLBACK;
      const history = this.mirror.buffer.active.baseY;
      if (history > 500) {
        const sample = this.serializer.serialize({ scrollback: 500 }).length;
        const perLine = sample / (500 + this.mirror.rows);
        lines = Math.min(SCROLLBACK, Math.floor((MAX_SNAPSHOT * 0.9) / perLine) - this.mirror.rows);
      }
      let screen = this.serializer.serialize({ scrollback: Math.max(0, lines) });
      while (screen.length > MAX_SNAPSHOT && lines > 0) {
        lines = Math.floor(lines * (MAX_SNAPSHOT / screen.length) * 0.9);
        screen = this.serializer.serialize({ scrollback: lines });
      }
      this.snapshotCache = { version: this.version, screen: screen + this.extraState() + (this.partialSeq || '') };
    }
    return this.snapshotCache.screen;
  }

  // A pty chunk can end in the middle of an escape sequence (e.g. "\x1b[3" now,
  // "1m" later). The mirror holds that half-parsed state; a serialized screen
  // can't express it. Keep the unfinished bytes and append them to snapshots so
  // a browser attaching at that moment ends up in the same parser state.
  trackPartial(data) {
    let idle = true;
    try { idle = this.mirror._core._inputHandler._parser.currentState === 0; } catch { /* assume idle */ }
    if (idle) {
      this.partialSeq = '';
      return;
    }
    const esc = data.lastIndexOf('\x1b');
    this.partialSeq = esc >= 0 ? data.slice(esc) : (this.partialSeq || '') + data;
    if (this.partialSeq.length > 64 * 1024) this.partialSeq = ''; // runaway string sequence; give up
  }

  // Calls onSnapshot(screen, size, subId), then onData(chunk) / onSize(size) for
  // everything after it. onResync() means output was skipped (the subscriber
  // stalled) and it should subscribe again for a fresh snapshot.
  // The mirror only yields between whole chunks, and every parsed chunk has
  // already been broadcast, so any macrotask is a consistent point to snapshot.
  subscribe({ onSnapshot, onData, onSize, onResync }) {
    // snapOwed: acks pay off the snapshot first. It never counts toward flow
    // control, so a big snapshot to a slow client doesn't freeze the shell.
    const sub = {
      id: nextSubId++, onData, onSize, onResync,
      active: true, unacked: 0, snapOwed: 0, overSince: null, stalled: false, skipped: false,
    };
    const job = () => {
      if (!sub.active || this.disposed) return;
      const screen = this.snapshot();
      sub.snapOwed = screen.length;
      onSnapshot(screen, { cols: this.mirror.cols, rows: this.mirror.rows }, sub.id);
      this.subscribers.add(sub);
      this.updateFlow();
    };
    queueSnapshot(job);
    return {
      ack: (subId, n) => {
        if (subId !== sub.id || !sub.active || !(n > 0)) return;
        const toSnap = Math.min(n, sub.snapOwed);
        sub.snapOwed -= toSnap;
        sub.unacked = Math.max(0, sub.unacked - (n - toSnap));
        if (sub.stalled && sub.unacked <= ACK_LOW) {
          if (sub.skipped) {
            // Output was dropped while it was stalled: start over from a snapshot.
            sub.active = false;
            this.subscribers.delete(sub);
            sub.onResync();
          } else {
            sub.stalled = false;
            sub.overSince = null;
          }
        }
        this.updateFlow();
      },
      close: () => {
        sub.active = false;
        this.subscribers.delete(sub);
        this.updateFlow();
      },
    };
  }

  input(data, binary = false) {
    if (this.alive) {
      // Binary input (legacy mouse reports) is one byte per char and must not be UTF-8 encoded.
      this.pty.write(binary ? Buffer.from(data, 'latin1') : data);
    } else if (!binary && data.includes('\r')) {
      this.output('\x1bc'); // full reset of the mirror and every client
      this.spawn();
      this.manager.emit('changed');
    }
  }

  resize(cols, rows) {
    cols = Math.max(2, Math.min(1000, cols | 0));
    rows = Math.max(1, Math.min(500, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.alive) {
      try { this.pty.resize(cols, rows); } catch { /* process may have just exited */ }
    }
    // Resize the mirror in stream order: output already queued was produced at the
    // old size, anything after this is at the new size.
    this.mirror.write('', () => {
      if (this.disposed) return;
      this.mirror.resize(cols, rows);
      this.version++;
      for (const sub of this.subscribers) if (!sub.stalled) sub.onSize({ cols, rows });
    });
  }

  currentCwd() {
    if (this.alive) {
      try { this.cwd = fs.readlinkSync(`/proc/${this.pty.pid}/cwd`); } catch { /* keep last known */ }
    }
    return usableDir(this.cwd);
  }

  kill() {
    const wasAlive = this.alive;
    this.alive = false;
    this.disposed = true;
    const p = this.pty;
    // Shells that ignore SIGHUP (trap '' HUP) get SIGKILL shortly after. A shell
    // that already exited is left alone: its pid may belong to something else now.
    if (wasAlive) {
      try { p.kill('SIGHUP'); } catch { /* already gone */ }
      this.killTimer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      this.killTimer.unref();
    }
    clearTimeout(this.flowTimer);
    this.subscribers.clear();
    this.snapshotCache = null;
    this.mirror.dispose();
  }

  info() {
    return { id: this.id, name: this.name, alive: this.alive };
  }
}

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.tabs = new Map();
    this.on('changed', () => this.save());
    this.restore();
    setInterval(() => this.save(), 30_000).unref();
  }

  restore() {
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(TABS_FILE, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('not an array');
    } catch (err) {
      saved = [];
      if (err.code !== 'ENOENT') {
        console.error(`Ignoring unreadable ${TABS_FILE} (${err.message}); kept as tabs.json.bad`);
        try { fs.renameSync(TABS_FILE, TABS_FILE + '.bad'); } catch { /* nothing to keep */ }
      }
    }
    for (const t of saved.slice(0, MAX_TABS)) {
      if (!t || typeof t.id !== 'string' || !/^[0-9a-f]{1,32}$/.test(t.id) || this.tabs.has(t.id)) continue;
      this.tabs.set(t.id, new Tab(this, { id: t.id, name: cleanName(t.name, 'Terminal'), cwd: t.cwd }));
    }
    if (this.tabs.size === 0) this.create('Terminal 1');
  }

  save() {
    const data = [...this.tabs.values()].map((t) => ({ id: t.id, name: t.name, cwd: t.currentCwd() }));
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(TABS_FILE + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(TABS_FILE + '.tmp', TABS_FILE);
    } catch (err) {
      console.error('Could not save tabs:', err.message);
    }
  }

  list() {
    return [...this.tabs.values()].map((t) => t.info());
  }

  get(id) {
    return this.tabs.get(id);
  }

  create(name, cwd) {
    if (this.tabs.size >= MAX_TABS) return null;
    const id = crypto.randomBytes(8).toString('hex');
    const tab = new Tab(this, { id, name: cleanName(name, `Terminal ${this.tabs.size + 1}`), cwd });
    this.tabs.set(id, tab);
    this.emit('changed');
    return tab;
  }

  rename(id, name) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.name = cleanName(name, tab.name);
    this.emit('changed');
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.kill();
    this.tabs.delete(id);
    this.emit('closed', id);
    this.emit('changed');
  }

  reorder(ids) {
    if (!Array.isArray(ids)) return;
    const next = new Map();
    for (const id of ids) if (this.tabs.has(id)) next.set(id, this.tabs.get(id));
    for (const [id, t] of this.tabs) if (!next.has(id)) next.set(id, t);
    this.tabs = next;
    this.emit('changed');
  }

  shutdown() {
    this.save();
    for (const t of this.tabs.values()) t.kill();
  }
}

module.exports = { TerminalManager };
