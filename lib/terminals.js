'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const pty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TABS_FILE = path.join(DATA_DIR, 'tabs.json');
const SCROLLBACK = Number(process.env.SCROLLBACK || 10000);
const MAX_NAME = 60;

// Pause the pty when this many chunks are waiting to be parsed, resume below LOW.
const HIGH_WATER = 64;
const LOW_WATER = 8;

// Variables from the server's own environment that the shells should not inherit.
const STRIP_ENV = ['PORT', 'HOST', 'SESSION_TTL_HOURS', 'SESSION_IDLE_HOURS', 'SCROLLBACK', 'TRUST_PROXY'];

function cleanName(name, fallback) {
  const s = String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
  return s || fallback;
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
    this.cwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    this.cols = 120;
    this.rows = 32;
    this.pty = null;
    this.alive = false;
    this.pending = 0;
    this.paused = false;
    this.subscribers = new Set();

    // Server-side mirror of the screen. Every byte from the pty goes through it,
    // so a browser that (re)connects gets the exact current screen, including
    // the alternate buffer used by full-screen TUIs, plus scrollback.
    this.mirror = new HeadlessTerminal({
      cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);

    this.spawn();
  }

  spawn() {
    const shell = process.env.SHELL || '/bin/bash';
    this.pty = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: shellEnv(),
    });
    this.alive = true;
    const p = this.pty;
    p.onData((data) => this.output(data));
    p.onExit(({ exitCode }) => {
      if (this.pty !== p) return;
      this.alive = false;
      this.output(`\r\n\x1b[2m[process exited with code ${exitCode} — press Enter to start a new shell]\x1b[0m\r\n`);
      this.manager.emit('changed');
    });
  }

  // Feed data to the mirror and, once parsed, to subscribers. Broadcasting from
  // the parse callback keeps live output and snapshots in the same order.
  output(data) {
    this.pending++;
    if (this.pending > HIGH_WATER && !this.paused && this.alive) {
      this.paused = true;
      this.pty.pause();
    }
    this.mirror.write(data, () => {
      this.pending--;
      if (this.paused && this.pending < LOW_WATER) {
        this.paused = false;
        if (this.alive) this.pty.resume();
      }
      for (const fn of this.subscribers) fn(data);
    });
  }

  // Calls onSnapshot(serializedScreen) and then onData(chunk) for all later output.
  subscribe(onSnapshot, onData) {
    const entry = { active: true };
    this.mirror.write('', () => {
      if (!entry.active) return;
      onSnapshot(this.serializer.serialize({ scrollback: SCROLLBACK }), { cols: this.cols, rows: this.rows });
      entry.fn = onData;
      this.subscribers.add(onData);
    });
    return () => {
      entry.active = false;
      if (entry.fn) this.subscribers.delete(entry.fn);
    };
  }

  input(data) {
    if (this.alive) {
      this.pty.write(data);
    } else if (data.includes('\r')) {
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
    this.mirror.resize(cols, rows);
    if (this.alive) {
      try { this.pty.resize(cols, rows); } catch { /* process may have just exited */ }
    }
  }

  currentCwd() {
    if (this.alive) {
      try { this.cwd = fs.readlinkSync(`/proc/${this.pty.pid}/cwd`); } catch { /* keep last known */ }
    }
    return this.cwd;
  }

  kill() {
    this.alive = false;
    try { this.pty.kill('SIGHUP'); } catch { /* already gone */ }
    this.subscribers.clear();
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
    try { saved = JSON.parse(fs.readFileSync(TABS_FILE, 'utf8')); } catch { /* first run */ }
    for (const t of saved) {
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
    if (this.tabs.size >= 50) return null;
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
