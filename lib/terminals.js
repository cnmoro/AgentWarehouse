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
const { hardenTerminal, safeResize } = require('../public/static/clamp');
const { History } = require('./history');
const procs = require('./processes');

const { DATA_DIR } = require('./auth');
const TABS_FILE = path.join(DATA_DIR, 'tabs.json');
// Lines kept on disk per tab beyond the in-memory scrollback (0 = off).
const HISTORY_LINES = Number(process.env.HISTORY_LINES ?? 200000);
// With history on, the scrollback must hold more lines than one output slice
// can scroll (~2k), or lines would leave it before they are archived.
const SCROLLBACK = Math.max(HISTORY_LINES > 0 ? 3000 : 0, Number(process.env.SCROLLBACK || 10000));
const HISTORY_BYTES = Number(process.env.HISTORY_MB ?? 64) * 1024 * 1024; // per tab, on disk
const HISTORY_DIR = path.join(DATA_DIR, 'history');
// Per-tab shell command history (bash's HISTFILE), so Up recalls a tab's own
// commands, also after a server restart.
const SHELL_DIR = path.join(DATA_DIR, 'shells');
const MAX_NAME = 60;
const MAX_TABS = 50;

// Flow control. The pty is paused while the server mirror has too many chunks
// waiting to be parsed, or while a browser has too much output it has not yet
// acknowledged (i.e. not yet rendered). Without the second part a fast
// producer fills the browser's queue and Ctrl+C takes seconds to show up.
// Output is fed to the mirror in slices. xterm only yields between writes, and
// some sequences cost time proportional to the screen area (full resets,
// scrolls, REP), so both the slice and the queue limit shrink for big screens:
// at 120x32 a slice is 2 KB and the queue 128 KB.
const REFERENCE_AREA = 120 * 32;
const areaScale = (cols, rows) => Math.min(1, REFERENCE_AREA / (cols * rows));
const sliceFor = (cols, rows) => Math.max(256, Math.floor(2048 * areaScale(cols, rows)));
const highWaterFor = (cols, rows) => Math.max(16 * 1024, Math.floor(128 * 1024 * areaScale(cols, rows)));
const lowWaterFor = (cols, rows) => highWaterFor(cols, rows) / 8;
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
const MAX_SNAPSHOT = 2 * 1024 * 1024;

// Colours the mirror reports when programs ask (OSC 4/10/11/12). Keep in sync
// with THEME in public/static/app.js.
const THEME = {
  foreground: '#d6dde6', background: '#0e1116', cursor: '#5fb3ff',
  ansi: ['#1b2029', '#f0706a', '#4fce8a', '#e0b04d', '#5fb3ff', '#c792ea', '#56c8d8', '#d6dde6',
    '#5c6676', '#ff8c85', '#6fe3a2', '#f2c66b', '#82c4ff', '#d7a9f5', '#7ad8e5', '#ffffff'],
};

// SGR sequence for a cell's or pen's attributes (xterm's cell and attribute
// objects share these methods).
function sgrOf(a) {
  const p = ['0'];
  if (a.isBold()) p.push('1');
  if (a.isDim()) p.push('2');
  if (a.isItalic()) p.push('3');
  if (a.isUnderline()) p.push('4');
  if (a.isBlink()) p.push('5');
  if (a.isInverse()) p.push('7');
  if (a.isInvisible()) p.push('8');
  if (a.isStrikethrough()) p.push('9');
  if (a.isOverline && a.isOverline()) p.push('53');
  const color = (rgb, palette, v, base) => {
    if (rgb) return `${base + 8};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
    if (!palette) return null;
    if (v < 8) return String(base + v);
    if (v < 16) return String(base + 60 + v - 8);
    return `${base + 8};5;${v}`;
  };
  const fg = color(a.isFgRGB(), a.isFgPalette(), a.getFgColor(), 30);
  const bg = color(a.isBgRGB(), a.isBgPalette(), a.getBgColor(), 40);
  if (fg) p.push(fg);
  if (bg) p.push(bg);
  return `\x1b[${p.join(';')}m`;
}

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
// VTE_VERSION would make /etc/profile.d/vte*.sh replace PROMPT_COMMAND; the
// systemd ones would e.g. send some programs' output to the journal.
const STRIP_ENV = ['PORT', 'HOST', 'SESSION_TTL_HOURS', 'SESSION_IDLE_HOURS', 'SCROLLBACK', 'HISTORY_LINES', 'HISTORY_MB',
  'TRUST_PROXY', 'ALLOWED_HOSTS', 'VTE_VERSION', 'JOURNAL_STREAM', 'INVOCATION_ID', 'MANAGERPID', 'SYSTEMD_EXEC_PID',
  'NOTIFY_SOCKET', 'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES', 'WATCHDOG_PID', 'WATCHDOG_USEC'];

function reorderMap(map, ids) {
  const wanted = [...new Set(ids)].filter((id) => map.has(id));
  const moving = new Set(wanted);
  const keys = [...map.keys()];
  let k = 0;
  const next = new Map();
  for (const key of keys) {
    const id = moving.has(key) ? wanted[k++] : key;
    next.set(id, map.get(id));
  }
  return next;
}

function cleanName(name, fallback) {
  // Control characters and bidi overrides (which could make a name display misleadingly) are removed.
  const s = String(name ?? '').replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, MAX_NAME);
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
  constructor(manager, { id, name, cwd, resume, group }) {
    this.manager = manager;
    this.id = id;
    this.name = name;
    this.group = group; // the session (sidebar entry) this terminal is a tab of
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
      logLevel: 'off', // malformed sequences in binary output would flood the journal
    });
    hardenTerminal(this.mirror);
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);
    // Same character-width tables as the browser, or emoji shift columns.
    this.mirror.loadAddon(new Unicode11Addon());
    this.mirror.unicode.activeVersion = '11';
    // Programs query the terminal (cursor position, device attributes...). The
    // mirror is the one terminal that always exists, so it answers; browsers don't.
    this.mirror.onData((reply) => this.reply(reply));
    this.answerColorQueries();
    this.mirror.parser.registerOscHandler(6973, (data) => {
      if (this.promptToken && data === this.promptToken && !this.promptSeen) {
        this.promptSeen = true;
        if (this.onFirstPrompt) this.onFirstPrompt();
      }
      return true;
    });
    this.setupHistory();

    this.pendingResume = null;
    if (resume) {
      // The server restarted while this command ran here: offer it again. It
      // is also the newest history entry, so Up recalls it in any case.
      this.pendingResume = resume;
      this.output(`\x1b[2m↻ The server restarted. This terminal was running:\x1b[0m ${resume}\r\n`
        + '\x1b[2m  Press Enter to run it again once it appears at the prompt (or press ↑ to recall it).\x1b[0m\r\n');
      try {
        this.seedShellHistory();
        if (this.lastHistoryLine() !== resume) fs.appendFileSync(this.shellHistoryFile, `${resume}\n`, { mode: 0o600 });
      } catch { /* Up just won't have it */ }
    }
    this.spawn();
    if (resume) this.typeWhenReady(resume);
  }

  // Command text from tabs.json or a shell: no control characters (C0 or C1),
  // so it can only ever be typed text, never keys.
  static cleanCommand(text) {
    const s = String(text || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
    return s && s.length <= 1000 ? s : null;
  }

  // Types text at the shell's prompt once bash has shown its first prompt
  // (PROMPT_COMMAND sends a private marker, see spawn), never earlier: startup
  // files may read from the terminal, and typed text would answer them. Not at
  // all if the user typed first or no prompt marker arrives.
  typeWhenReady(text) {
    this.onFirstPrompt = () => {
      this.onFirstPrompt = null;
      if (!this.disposed && this.alive && !this.inputSinceSpawn) this.pty.write(text);
    };
    this.resumeTimer = setTimeout(() => { this.onFirstPrompt = null; }, 120000);
  }

  // What is running in the foreground right now (null at the shell prompt):
  // the line as typed when the shell recorded it and it matches the process
  // actually running, otherwise rebuilt from the process's arguments.
  runningCommand() {
    if (!this.alive || this.disposed) return null;
    let fg;
    try { fg = procs.foregroundCommand(this.pty.pid); } catch { return null; }
    if (!fg) return this.pendingResume;
    const program = path.basename(fg.split(' ')[0].replace(/^'|'$/g, ''));
    let recorded;
    try { recorded = fs.readFileSync(this.runningFile, 'utf8'); } catch { return Tab.cleanCommand(fg); }
    if (recorded.startsWith('#same')) {
      // The command did not enter history: either it repeats the previous line
      // (HISTCONTROL=ignoredups), or it was hidden on purpose (leading space,
      // ignorespace). Offer it only in the first case.
      // A repeat contains every argument of the running process.
      const prev = this.lastHistoryLine();
      const args = fg.split(' ').map((a) => a.replace(/^'|'$/g, '')).filter(Boolean);
      return prev && args.every((a) => prev.includes(a)) ? Tab.cleanCommand(prev) : null;
    }
    const typed = Tab.cleanCommand(recorded.replace(/^\s*\d+\*?\s+/, ''));
    return typed && typed.includes(program) ? typed : Tab.cleanCommand(fg);
  }

  lastHistoryLine() {
    try {
      const lines = fs.readFileSync(this.shellHistoryFile, 'utf8').split('\n').filter((l) => l && !/^#\d+$/.test(l));
      return lines[lines.length - 1] || null;
    } catch {
      return null;
    }
  }

  get shellHistoryFile() {
    return path.join(SHELL_DIR, `${this.id}.bash_history`);
  }

  get runningFile() {
    return path.join(SHELL_DIR, `${this.id}.running`);
  }

  // A new tab starts from the user's normal bash history.
  seedShellHistory() {
    const file = this.shellHistoryFile;
    if (fs.existsSync(file)) return;
    fs.mkdirSync(SHELL_DIR, { recursive: true, mode: 0o700 });
    let seed = '';
    try {
      const global = process.env.HISTFILE || path.join(os.homedir(), '.bash_history');
      seed = fs.readFileSync(global, 'utf8').split('\n').slice(-2001).join('\n');
    } catch { /* no global history */ }
    fs.writeFileSync(file, seed, { mode: 0o600 });
  }

  // ---- long-term history (see lib/history.js) ----
  //
  // A line is archived once it has scrolled above the screen: from then on no
  // program output can change it (only a resize reflow, `clear` or a reset,
  // all handled here). `archiveAt` is the index, in the normal buffer's line
  // list, of the first line not yet archived. xterm reports every line it
  // drops from the top through onTrim, which shifts that index.

  setupHistory() {
    // Changes whenever line numbers are reset (clear). Random start, so a page
    // open across a server restart can't mistake new numbering for the old.
    this.historyEpoch = Math.floor(Math.random() * 1e9);
    this.history = null;
    this.archiveAt = 0;
    this.watchedLines = null;
    this.historyCleared = false;
    this.lostLines = 0;
    if (!(HISTORY_LINES > 0)) return;
    try {
      this.history = new History(path.join(HISTORY_DIR, this.id), { maxLines: HISTORY_LINES, maxBytes: HISTORY_BYTES });
    } catch (err) {
      console.error(`history disabled for tab ${this.id}: ${err.message}`);
      return;
    }
    if (this.history.end > this.history.start) {
      this.history.append(` \x1b[2m── server restarted ${new Date().toISOString()} ──\x1b[0m`);
    }
    // "clear" (ED3, erase saved lines) erases the long-term history as it
    // erases the scrollback. A full reset (RIS) keeps the history: programs
    // can send it by accident (cat of a binary file).
    const erase = (params) => {
      if (params[0] === 3 && this.mirror.buffer.active.type === 'normal') this.clearHistory();
      return false;
    };
    this.mirror.parser.registerCsiHandler({ final: 'J' }, erase);
    this.mirror.parser.registerCsiHandler({ prefix: '?', final: 'J' }, erase);
    this.mirror.parser.registerEscHandler({ final: 'c' }, () => {
      try {
        // Keep everything: this is also what `cat` of a binary file sends by
        // accident. Only an explicit "erase saved lines" (clear) erases history.
        this.archiveRemaining();
        if (this.history && !this.selfReset) this.history.append(' \x1b[2m── terminal reset ──\x1b[0m');
        this.selfReset = false;
      } catch (err) {
        console.error('history error:', err);
      }
      return false; // xterm then performs the reset
    });
    this.watchLines();
  }

  clearHistory() {
    if (!this.history) return;
    this.history.clear();
    this.historyCleared = true; // the erase that follows trims lines on purpose
    this.historyEpoch++;
  }

  // (Re)attach to the normal buffer's line list; a full reset replaces it.
  watchLines() {
    const lines = this.mirror._core.buffers.normal.lines;
    if (lines === this.watchedLines) return lines;
    if (this.trimWatch) this.trimWatch.dispose();
    this.watchedLines = lines;
    this.archiveAt = 0;
    this.trimWatch = lines.onTrim((n) => { this.archiveAt -= n; });
    return lines;
  }

  // Called after every parsed chunk: archive what has scrolled above the screen.
  archiveScrolled() {
    if (!this.history || this.disposed) return;
    const buf = this.mirror._core.buffers.normal;
    const lines = this.watchLines();
    if (this.archiveAt < 0) {
      // Lines were dropped before they could be archived: only possible when
      // more than a whole scrollback scrolls by within one small slice.
      if (!this.historyCleared) {
        if (!this.lostLines) console.warn(`history: tab ${this.id} dropped lines during a very fast scroll`);
        this.lostLines += -this.archiveAt;
      }
      this.archiveAt = 0;
    }
    this.historyCleared = false;
    // Archive whole logical lines only: stop before one that continues onto the
    // screen, unless that one line has grown taller than half the scrollback
    // (a minified file, a one-line JSON reply). Then archive its rows as they
    // go, or its start would be trimmed away before the line ever ends.
    let q = buf.ybase;
    while (q > this.archiveAt && lines.get(q) && lines.get(q).isWrapped) q--;
    if (q === this.archiveAt && buf.ybase - this.archiveAt > SCROLLBACK / 2) q = buf.ybase;
    for (let i = this.archiveAt; i < q; i++) this.history.append(this.lineRecord(lines.get(i), lines.get(i + 1)));
    if (q > this.archiveAt) this.archiveAt = q;
  }

  // Everything not yet archived, up to the last non-empty line (used before
  // the shell restart's reset and at shutdown).
  archiveRemaining() {
    if (!this.history || this.disposed) return;
    this.archiveScrolled();
    const lines = this.watchLines();
    let last = lines.length - 1;
    while (last >= this.archiveAt && lines.get(last).translateToString(true) === '') last--;
    for (let i = this.archiveAt; i <= last; i++) this.history.append(this.lineRecord(lines.get(i), lines.get(i + 1)));
    this.archiveAt = Math.max(this.archiveAt, last + 1);
  }

  // A resize reflows lines, so indices change. xterm keeps the object of the
  // first physical line of every logical line through a reflow, so the
  // archive point is found again by identity. If the terminal grew taller,
  // archived lines may be back on the screen, where programs can change them
  // again: those are taken back out of the archive and archived anew when
  // they scroll off.
  beforeReflow() {
    if (!this.history) return null;
    this.archiveScrolled();
    const lines = this.watchLines();
    const at = lines.get(this.archiveAt) || null;
    if (!at || !at.isWrapped) return { line: at };
    // Part of a long line is archived already (see archiveScrolled).
    const buf = this.mirror._core.buffers.normal;
    const cursorRow = Math.min(lines.length - 1, buf.ybase + buf.y);
    let cursorStart = cursorRow;
    while (cursorStart > 0 && lines.get(cursorStart).isWrapped) cursorStart--;
    if (this.archiveAt >= cursorStart && this.archiveAt <= cursorRow) {
      // It is the line still being printed, where the cursor is. xterm does
      // not reflow that line (reflowCursorLine is off: shells redraw their
      // prompt), so its rows, and the one the archive point is on, stay.
      return { line: at, cursor: true };
    }
    // A finished line: it gets reflowed. Remember its first row and how many
    // cells of it are archived; afterwards the archive point is that many
    // cells into the line.
    let start = this.archiveAt;
    while (start > 0 && lines.get(start).isWrapped) start--;
    if (lines.get(start).isWrapped) {
      // Its first row is gone (longer than the whole buffer). It is finished:
      // archive the rest of it now and anchor on the line that follows.
      let end = this.archiveAt;
      while (lines.get(end + 1) && lines.get(end + 1).isWrapped) end++;
      for (let i = this.archiveAt; i <= end; i++) this.history.append(this.lineRecord(lines.get(i), lines.get(i + 1)));
      this.archiveAt = end + 1;
      return { line: lines.get(this.archiveAt) || null };
    }
    return { line: lines.get(start), cells: (this.archiveAt - start) * this.mirror.cols };
  }

  afterReflow(state) {
    if (!state || !this.history) return;
    const buf = this.mirror._core.buffers.normal;
    const lines = this.watchLines();
    let q = buf.ybase;
    while (q > 0 && lines.get(q) && lines.get(q).isWrapped) q--;
    let idx = -1;
    if (state.line) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines.get(i) === state.line) { idx = i; break; }
      }
    }
    if (idx === -1) {
      console.warn(`history: tab ${this.id} lost its place in a resize`);
      idx = q;
    } else if (state.cursor) {
      // Same row object, same place in the line: continue from it. The rows
      // around it belong to the line being printed, not to lines coming back
      // from the archive, so nothing is taken back.
      this.archiveAt = idx;
      this.historyCleared = true;
      this.archiveBeforeTrim();
      return;
    } else if (state.cells) {
      this.archiveAt = Math.min(lines.length, idx + Math.floor(state.cells / this.mirror.cols));
      this.historyCleared = true;
      this.archiveBeforeTrim();
      return;
    }
    // Lines that came back onto the screen (the terminal grew): at most a
    // screen's worth. Anything larger means the anchor is off; then keep the
    // archive as it is rather than delete records.
    if (idx > q && idx - q <= this.mirror.rows) {
      let starts = 0;
      for (let i = q; i < idx; i++) if (!lines.get(i).isWrapped) starts++;
      this.history.dropLastLogical(starts);
      idx = q;
    }
    this.archiveAt = idx;
    this.historyCleared = true; // trims during the reflow are accounted for
    this.archiveBeforeTrim();
  }

  // Runs while the scrollback limit is raised for a reflow: rows that
  // restoring the limit will trim must be archived now (possibly part of a
  // long line), or they are gone.
  archiveBeforeTrim() {
    const lines = this.watchLines();
    const trimmed = lines.length - (SCROLLBACK + this.mirror.rows);
    if (this.archiveAt >= trimmed) return;
    for (let i = this.archiveAt; i < trimmed; i++) this.history.append(this.lineRecord(lines.get(i), lines.get(i + 1)));
    this.archiveAt = trimmed;
  }

  // `next` is the following row: when it continues this line, this row's
  // trailing spaces are part of the text and are kept.
  lineRecord(line, next) {
    return (line.isWrapped ? 'w' : ' ') + this.lineText(line, !!(next && next.isWrapped));
  }

  // A buffer line as text with SGR colour sequences. Lines without any colour
  // (the common case) take a fast path.
  lineText(line, full = false) {
    const n = line.length;
    const data = line._data;
    let plain = !!data;
    if (data) {
      for (let i = 0; i < n; i++) {
        if (data[i * 3 + 1] !== 0 || data[i * 3 + 2] !== 0) { plain = false; break; }
      }
    }
    if (plain) return line.translateToString(!full);
    // A private cell object: the buffer's getNullCell() is a shared template
    // that xterm fills new cells from, so loading into it would corrupt them.
    const cell = this.historyCell || (this.historyCell = this.mirror.buffer.active.getNullCell());
    let end = n;
    while (!full && end > 0) {
      line.loadCell(end - 1, cell);
      if (cell.getChars() || !cell.isBgDefault() || cell.isInverse()) break;
      end--;
    }
    let out = '';
    let key = '0|0';
    for (let x = 0; x < end; x++) {
      line.loadCell(x, cell);
      if (cell.getWidth() === 0) continue; // right half of a wide character
      const k = `${cell.fg}|${cell.bg}`;
      if (k !== key) {
        out += sgrOf(cell);
        key = k;
      }
      out += cell.getChars() || ' ';
    }
    if (key !== '0|0') out += '\x1b[0m';
    return out;
  }

  // Line numbers are absolute: the archive holds [start, archived), the lines
  // still in memory (the ones not archived yet, i.e. the screen) follow.
  historyInfo() {
    if (this.history) this.history.flush();
    const archived = this.history ? this.history.end : 0;
    const tail = this.disposed || !this.history ? 0 : Math.max(0, this.watchLines().length - Math.max(0, this.archiveAt));
    // The terminal's scrollback starts at buffer line 0, which is this many
    // lines before the first unarchived one.
    const inMemory = this.disposed || !this.history ? 0 : Math.max(0, this.archiveAt);
    return {
      start: this.history ? this.history.start : 0,
      archived,
      memStart: Math.max(this.history ? this.history.start : 0, archived - inMemory),
      total: archived + tail,
      epoch: this.historyEpoch,
    };
  }

  // Records for [from, from + count), at most about maxBytes of them.
  historyRead(from, count, maxBytes = 1024 * 1024) {
    const info = this.historyInfo();
    count = Math.max(0, Math.trunc(count) || 0);
    from = Math.max(info.start, Math.min(Math.trunc(from) || 0, info.total));
    const to = Math.min(from + count, info.total);
    const out = [];
    let bytes = 0;
    if (this.history && from < info.archived) {
      const r = this.history.read(from, Math.min(to, info.archived) - from, maxBytes);
      out.push(...r.records);
      for (const rec of r.records) bytes += rec.length;
    }
    if (from + out.length >= info.archived) {
      const lines = this.watchLines();
      for (let abs = from + out.length; abs < to && bytes < maxBytes; abs++) {
        const k = this.archiveAt + (abs - info.archived);
        const line = lines.get(k);
        const rec = line ? this.lineRecord(line, lines.get(k + 1)) : ' ';
        out.push(rec);
        bytes += rec.length;
      }
    }
    return { from, lines: out, info };
  }

  // Case-insensitive search, one chunk (bounded in lines and bytes) per
  // event-loop turn. Resolves to the absolute line number of the nearest match
  // in the given direction, or -1.
  async historySearch(query, from, dir) {
    const needle = String(query).toLowerCase();
    if (!needle) return -1;
    const epoch = this.historyEpoch;
    const strip = (r) => r.slice(1).replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
    let chunk = 2000;
    let pos = from + dir;
    for (;;) {
      if (this.disposed || this.historyEpoch !== epoch) return -1;
      const info = this.historyInfo();
      if (pos < info.start) {
        if (dir < 0) return -1;
        pos = info.start;
      }
      if (pos >= info.total) return -1;
      const a = dir < 0 ? Math.max(info.start, pos - chunk + 1) : pos;
      const b = dir < 0 ? pos + 1 : Math.min(info.total, pos + chunk);
      const { from: got, lines } = this.historyRead(a, b - a, 2 * 1024 * 1024);
      if (dir < 0 && got + lines.length < b) {
        // Byte limit hit: read fewer lines per step so none are skipped.
        chunk = Math.max(1, lines.length);
        continue;
      }
      const order = dir < 0 ? [...lines.keys()].reverse() : [...lines.keys()];
      for (const i of order) {
        if (strip(lines[i]).includes(needle)) return got + i;
      }
      pos = dir < 0 ? a - 1 : got + Math.max(1, lines.length);
      await new Promise((r) => setImmediate(r));
    }
  }

  // On shutdown, move what is still in memory to the archive so it is there
  // after a restart (the shells themselves do not survive).
  archiveAll() {
    this.archiveRemaining();
    if (this.history) this.history.flush();
  }

  spawn() {
    const shell = process.env.SHELL || '/bin/bash';
    this.cwd = usableDir(this.cwd);
    const env = shellEnv();
    if (path.basename(shell) === 'bash') {
      // Each tab keeps its own history file, written after every command.
      try {
        this.seedShellHistory();
        fs.writeFileSync(this.runningFile, '', { mode: 0o600 });
      } catch (err) {
        console.error(`shell history for tab ${this.id}: ${err.message}`);
      }
      // Set even if seeding failed, so commands never fall back to ~/.bash_history.
      env.HISTFILE = this.shellHistoryFile;
      env.WT_RUNNING_FILE = this.runningFile;
      // At every prompt: append to the tab's history file, remember the newest
      // history entry, and send a private marker (OSC 6973) that tells the
      // server a prompt is up; both terminals ignore it.
      // The marker carries a random token, so text printed before the first
      // prompt (a motd, git output) cannot fake it.
      this.promptToken = crypto.randomBytes(12).toString('hex');
      const prompt = `history -a; __wt_last=$(HISTTIMEFORMAT= builtin history 1); printf '\\033]6973;${this.promptToken}\\007'`;
      env.PROMPT_COMMAND = env.PROMPT_COMMAND ? `${prompt}; ${env.PROMPT_COMMAND}` : prompt;
      // PS0 is expanded after a command line is entered, before it runs: note
      // the line exactly as typed (aliases, pipelines), or "#same" when it did
      // not enter history (a repeat, or hidden with a leading space).
      env.PS0 = '$(__wt_cur=$(HISTTIMEFORMAT= builtin history 1); '
        + 'if [ "$__wt_cur" = "$__wt_last" ]; then echo "#same"; else printf "%s\\n" "$__wt_cur"; fi >"$WT_RUNNING_FILE" 2>/dev/null)';
    }
    this.inputSinceSpawn = false;
    this.lastOutputAt = 0;
    this.promptSeen = false;
    this.pty = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });
    this.alive = true;
    this.paused = false;
    // For shutdown, even after this shell is gone. The start time tells a
    // later, unrelated process that reuses the pid apart from this shell.
    this.manager.sessions.set(this.pty.pid, procs.startTime(this.pty.pid));
    const p = this.pty;
    p.onData((data) => {
      this.lastOutputAt = Date.now();
      this.output(data);
    });
    p.onExit(({ exitCode }) => {
      clearTimeout(this.killTimer);
      if (this.pty !== p) return;
      this.alive = false;
      this.paused = false;
      this.output(`\r\n\x1b[2m[process exited with code ${exitCode} — press Enter to start a new shell]\x1b[0m\r\n`);
      this.manager.emit('changed');
    });
  }

  // Answers to terminal queries. A program that floods queries but never reads
  // them (cat of a file full of ESC[c) would otherwise queue replies in node-pty
  // without limit, and Ctrl+C would wait behind them.
  reply(s) {
    if (!this.alive) return;
    const q = this.pty._writeStream && this.pty._writeStream._writeQueue;
    // node-pty keeps every write queued until it completes, so a normal burst
    // (256 palette answers) passes through here; only a real backlog is cut.
    if (q && q.length > 1024) return;
    this.pty.write(s);
  }

  // Feed data to the mirror and, once parsed, to subscribers. Broadcasting from
  // the parse callback keeps live output and snapshots in the same order.
  output(data) {
    if (this.disposed) return;
    const slice = sliceFor(this.mirror.cols, this.mirror.rows);
    for (let i = 0; i < data.length; i += slice) this.outputSlice(data.slice(i, i + slice));
  }

  outputSlice(data) {
    this.pending += data.length;
    this.updateFlow();
    this.mirror.write(data, () => {
      if (this.disposed) return;
      this.pending -= data.length;
      this.version++;
      this.snapshotCache = null;
      this.trackPartial(data);
      try {
        this.archiveScrolled();
      } catch (err) {
        // Never let history break xterm's write loop (that would freeze the tab).
        console.error('history error:', err);
      }
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
    const { cols, rows } = this.mirror;
    let blocked = this.pending > (this.paused ? lowWaterFor(cols, rows) : highWaterFor(cols, rows));
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
    const reply = (s) => this.reply(s);
    const dynamic = { 10: THEME.foreground, 11: THEME.background, 12: THEME.cursor };
    for (const [code, color] of Object.entries(dynamic)) {
      this.mirror.parser.registerOscHandler(Number(code), (data) => {
        if (data.length !== 1 || data !== '?') return false;
        reply(`\x1b]${code};${xtermRgb(color)}\x1b\\`);
        return true;
      });
    }
    this.mirror.parser.registerOscHandler(4, (data) => {
      if (data.length > 4096) return false; // 256 queries fit easily; don't split megabytes
      const parts = data.split(';');
      if (!parts.includes('?')) return false;
      // At most one answer per palette entry, however long the query.
      for (let i = 0; i + 1 < parts.length && i < 512; i += 2) {
        const n = Number(parts[i]);
        if (parts[i + 1] === '?' && Number.isInteger(n) && n >= 0 && n < 256) {
          reply(`\x1b]4;${n};${xtermRgb(paletteColor(n))}\x1b\\`);
        }
      }
      return true;
    });
  }

  // Terminal state the serialize addon does not restore: mouse encoding, scroll
  // region, the program's saved cursor (ESC 7), line-drawing character sets,
  // a pending wrap at the end of a full line, the current pen, cursor style and
  // visibility. Appended after the addon's output (and trailingFill).
  extraState() {
    const core = this.mirror._core;
    const { cols, rows } = this.mirror;
    let out = '';
    try {
      const enc = core.coreMouseService.activeEncoding;
      if (enc === 'SGR') out += '\x1b[?1006h';
      else if (enc === 'SGR_PIXELS') out += '\x1b[?1016h';

      const buf = core.buffer;
      const modes = core.coreService.decPrivateModes;
      const top = modes.origin ? buf.scrollTop : 0;
      const cup = (y, x) => `\x1b[${y + 1 - top};${Math.min(x, cols - 1) + 1}H`;
      if (buf.scrollTop !== 0 || buf.scrollBottom !== rows - 1) {
        out += `\x1b[${buf.scrollTop + 1};${buf.scrollBottom + 1}r`;
      }

      if (buf.savedCurAttrData) {
        // savedY counts from the top of the scrollback. Origin mode is switched
        // off for the move so a save outside the scroll region lands right.
        const y = Math.max(0, Math.min(rows - 1, buf.savedY - buf.ybase));
        out += (modes.origin ? '\x1b[?6l' : '') + `\x1b[${y + 1};${Math.min(buf.savedX, cols - 1) + 1}H`;
        out += sgrOf(buf.savedCurAttrData) + '\x1b7' + (modes.origin ? '\x1b[?6h' : '');
      }

      // Cursor. After a full-width line xterm sits past the last column
      // (x === cols) and wraps on the next character. A plain CUP can't express
      // that, so print the last cell again, which leaves the cursor there.
      const line = this.mirror.buffer.active.getLine(this.mirror.buffer.active.baseY + buf.y);
      let lastX = cols - 1;
      let last = buf.x >= cols && line && line.getCell(lastX);
      if (last && last.getWidth() === 0 && cols > 1) last = line.getCell(--lastX); // right half of a wide char
      if (last && last.getWidth() >= 1 && lastX + last.getWidth() === cols) {
        out += cup(buf.y, lastX) + sgrOf(last) + (last.getChars() || ' ');
      } else {
        out += cup(buf.y, buf.x);
      }

      // Character sets: after the reprint above, which must not be translated.
      const cs = core._charsetService;
      (cs._charsets || []).forEach((set, g) => {
        if (set && set.q === '─') out += `\x1b${'()*+'[g]}0`; // DEC special graphics
      });
      out += ['', '\x0e', '\x1bn', '\x1bo'][cs.glevel] || '';

      out += sgrOf(core._inputHandler._curAttrData);
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
      // The addon ends the normal-screen part with the pen currently in use,
      // which belongs to the full-screen app; switching to the alternate screen
      // then erases all of it with that background. Reset the pen first.
      const alt = screen.lastIndexOf('\x1b[?1049h');
      if (alt >= 0) screen = screen.slice(0, alt) + '\x1b[0m' + screen.slice(alt);
      this.snapshotCache = {
        version: this.version,
        screen: screen + this.trailingFill() + this.extraState() + (this.partialSeq || ''),
      };
    }
    return this.snapshotCache.screen;
  }

  // The serialize addon stops at the last row with text when there is no
  // scrollback (always the case on the alternate screen), even if the rows
  // below are coloured, e.g. a whiptail or mc background. Repaint those rows
  // as runs of erased cells. extraState() puts the cursor and pen back afterwards.
  trailingFill() {
    const buf = this.mirror.buffer.active;
    if (buf.length > this.mirror.rows) return '';
    const cell = buf.getNullCell();
    const bgCode = (c) => {
      if (c.isBgDefault()) return null;
      const n = c.getBgColor();
      if (c.isBgRGB()) return `48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
      return n < 8 ? `${40 + n}` : n < 16 ? `${92 + n}` : `48;5;${n}`;
    };
    let out = '';
    for (let y = this.mirror.rows - 1; y >= 0; y--) {
      const line = buf.getLine(y);
      if (!line || line.translateToString(true) !== '') break;
      let x = 0;
      while (x < this.mirror.cols) {
        line.getCell(x, cell);
        const code = bgCode(cell);
        let end = x + 1;
        while (end < this.mirror.cols) {
          line.getCell(end, cell);
          if (bgCode(cell) !== code) break;
          end++;
        }
        if (code) out += `\x1b[${y + 1};${x + 1}H\x1b[0;${code}m\x1b[${end - x}X`;
        x = end;
      }
    }
    return out;
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
      this.partialFull = false;
      return;
    }
    // The unfinished sequence starts at the last ESC or 8-bit introducer (DCS, SOS, CSI, OSC, PM, APC).
    const m = /[\x1b\x90\x98\x9b\x9d\x9e\x9f][^\x1b\x90\x98\x9b\x9d\x9e\x9f]*$/.exec(data);
    if (m) {
      this.partialSeq = m[0];
      this.partialFull = false;
    } else if (!this.partialFull) {
      this.partialSeq = (this.partialSeq || '') + data;
    }
    // A long string sequence (OSC 52, sixel): keep only its start. The client
    // then treats the rest as part of a truncated string and ignores it, rather
    // than printing the payload as text.
    if (this.partialSeq.length > 64 * 1024) {
      this.partialSeq = this.partialSeq.slice(0, 64);
      this.partialFull = true;
    }
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
    this.inputSinceSpawn = true;
    if (this.pendingResume && (data.includes('\r') || data.includes('\x03'))) this.pendingResume = null;
    if (this.alive) {
      // Binary input (legacy mouse reports) is one byte per char and must not be UTF-8 encoded.
      this.pty.write(binary ? Buffer.from(data, 'latin1') : data);
    } else if (!binary && data.includes('\r')) {
      this.selfReset = true; // keep the long-term history across the restart
      this.output('\x1bc'); // full reset of the mirror and every client
      this.spawn();
      this.manager.emit('changed');
    }
  }

  resize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols | 0)); // reflowing long history into a few columns is costly
    rows = Math.max(1, Math.min(200, rows | 0));
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
      let reflow = null;
      try { reflow = this.beforeReflow(); } catch (err) { console.error('history error:', err); }
      safeResize(this.mirror, cols, rows, () => {
        try { this.afterReflow(reflow); } catch (err) { console.error('history error:', err); }
      });
      this.version++;
      for (const sub of this.subscribers) {
        // A stalled client misses the resize; mark it so it resyncs with a snapshot.
        if (sub.stalled) sub.skipped = true;
        else sub.onSize({ cols, rows });
      }
    });
  }

  currentCwd() {
    if (this.alive) {
      try { this.cwd = fs.readlinkSync(`/proc/${this.pty.pid}/cwd`); } catch { /* keep last known */ }
    }
    return usableDir(this.cwd);
  }

  // Server shutdown: hang up every process in this terminal's session.
  hangup() {
    if (!this.alive || !this.pty) return [];
    const members = procs.sessionMembers(this.pty.pid);
    procs.signalAll(members, 'SIGHUP');
    procs.signalAll(members, 'SIGCONT'); // stopped jobs must run to see the hangup
    return members;
  }

  kill() {
    clearTimeout(this.resumeTimer);
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
    if (this.history) this.history.flush();
    this.mirror.dispose();
  }

  info() {
    return { id: this.id, name: this.name, alive: this.alive, group: this.group };
  }
}

// Terminals are grouped in sessions: a session is an entry in the sidebar, its
// terminals are the tabs along the top. Sessions are kept in sidebar order;
// terminals in tab order (this.tabs), filtered by session.
const ID_RE = /^[0-9a-f]{1,32}$/;

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.tabs = new Map();
    this.groups = new Map(); // id -> { id, name }, in sidebar order
    this.started = false;
    this.sessions = new Map(); // shell pid (= its session id) -> start time, while the session has processes
  }

  // Called once the server is listening, so a second instance that fails to
  // bind never spawns shells or rewrites tabs.json.
  start() {
    this.started = true;
    this.on('changed', () => this.save());
    this.restore();
    setInterval(() => this.save(), 10_000).unref();
  }

  restore() {
    let saved = [];
    let damaged = false;
    try {
      saved = JSON.parse(fs.readFileSync(TABS_FILE, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('not an array');
    } catch (err) {
      saved = [];
      if (err.code !== 'ENOENT') {
        damaged = true;
        console.error(`Ignoring unreadable ${TABS_FILE} (${err.message}); kept as tabs.json.bad`);
        try { fs.renameSync(TABS_FILE, TABS_FILE + '.bad'); } catch { /* nothing to keep */ }
      }
    }
    for (const t of saved.slice(0, MAX_TABS)) {
      if (!t || typeof t.id !== 'string' || !ID_RE.test(t.id) || this.tabs.has(t.id)) continue;
      const resume = typeof t.running === 'string' ? Tab.cleanCommand(t.running) : null;
      // Saved before sessions existed: the terminal becomes a session of its
      // own, keeping its name, with one tab.
      const legacy = typeof t.group !== 'string' || !ID_RE.test(t.group);
      const group = legacy ? t.id : t.group;
      if (!this.groups.has(group)) {
        this.groups.set(group, { id: group, name: cleanName(legacy ? t.name : t.groupName, 'Terminal') });
      }
      const name = legacy ? 'Tab 1' : cleanName(t.name, 'Tab');
      this.tabs.set(t.id, new Tab(this, { id: t.id, name, cwd: t.cwd, resume, group }));
    }
    if (this.tabs.size === 0) this.create('Terminal 1');
    // History of tabs that no longer exist. Kept when tabs.json was damaged, so
    // it can still be recovered by hand.
    if (damaged) return;
    try {
      for (const dir of fs.readdirSync(HISTORY_DIR)) {
        if (!this.tabs.has(dir)) fs.rmSync(path.join(HISTORY_DIR, dir), { recursive: true, force: true });
      }
    } catch { /* no history yet */ }
    try {
      for (const f of fs.readdirSync(SHELL_DIR)) {
        const id = f.replace(/\.(bash_history|running)$/, '');
        if (!this.tabs.has(id)) fs.rmSync(path.join(SHELL_DIR, f), { force: true });
      }
    } catch { /* no shell history yet */ }
  }

  // Saved every few seconds and on shutdown: what each tab needs to come back
  // after a restart (name, folder, and the command running in it, if any).
  // Forget sessions with no processes left: their pid may be reused.
  pruneSessions() {
    const alive = new Set(procs.processesInSessions([...this.sessions.keys()]).map((pid) => procs.stat(pid)?.session));
    for (const sid of [...this.sessions.keys()]) if (!alive.has(sid)) this.sessions.delete(sid);
  }

  save() {
    if (this.saveFrozen) return;
    try { this.pruneSessions(); } catch { /* next time */ }
    const data = [];
    for (const g of this.groups.values()) {
      for (const t of this.tabsOf(g.id)) {
        data.push({ id: t.id, name: t.name, cwd: t.currentCwd(), running: t.runningCommand(), group: g.id, groupName: g.name });
      }
    }
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

  listGroups() {
    return [...this.groups.values()].map((g) => ({ id: g.id, name: g.name }));
  }

  get(id) {
    return this.tabs.get(id);
  }

  tabsOf(group) {
    return [...this.tabs.values()].filter((t) => t.group === group);
  }

  // A new tab in an existing session opens in the folder of the session's
  // first tab; without a session, a new session (named `name`) opens in `cwd`.
  create(name, cwd, { group } = {}) {
    if (this.tabs.size >= MAX_TABS) return null;
    const id = crypto.randomBytes(8).toString('hex');
    let tabName;
    if (group && this.groups.has(group)) {
      const siblings = this.tabsOf(group);
      if (siblings.length) cwd = siblings[0].currentCwd();
      const taken = new Set(siblings.map((t) => t.name));
      let n = siblings.length + 1;
      while (taken.has(`Tab ${n}`)) n++;
      tabName = cleanName(name, `Tab ${n}`);
    } else {
      group = crypto.randomBytes(8).toString('hex');
      this.groups.set(group, { id: group, name: cleanName(name, `Terminal ${this.groups.size + 1}`) });
      tabName = 'Tab 1';
    }
    const tab = new Tab(this, { id, name: tabName, cwd, group });
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

  renameGroup(id, name) {
    const g = this.groups.get(id);
    if (!g) return;
    g.name = cleanName(name, g.name);
    this.emit('changed');
  }

  closeGroup(id) {
    for (const t of this.tabsOf(id)) this.close(t.id);
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.kill();
    fs.rmSync(tab.shellHistoryFile, { force: true });
    fs.rmSync(tab.runningFile, { force: true });
    if (tab.history) tab.history.destroy();
    else fs.rmSync(path.join(HISTORY_DIR, tab.id), { recursive: true, force: true }); // left from when history was on
    this.tabs.delete(id);
    // A session lasts as long as it has tabs.
    if (!this.tabsOf(tab.group).length) this.groups.delete(tab.group);
    this.emit('closed', id);
    this.emit('changed');
  }

  // `ids` in their new order; they take the places they held between them, so
  // reordering one session's tabs leaves every other terminal where it was.
  reorder(ids) {
    this.tabs = reorderMap(this.tabs, ids);
    this.emit('changed');
  }

  reorderGroups(ids) {
    this.groups = reorderMap(this.groups, ids);
    this.emit('changed');
  }

  // Saves the tabs (with what runs in them), then stops every process of every
  // terminal: hang up, give them up to `graceMs` to exit, then SIGKILL what is
  // left, so nothing lingers after the server (or holds up systemd's stop).
  async shutdown(graceMs = 2000) {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    this.save();
    // Shells exiting below would trigger saves that record nothing running;
    // the state just written is the one to come back to.
    this.saveFrozen = true;
    for (const t of this.tabs.values()) {
      try { t.archiveAll(); } catch (err) { console.error('history save failed:', err.message); }
    }
    // Every session any tab ever had (a shell that exited or was restarted can
    // leave jobs behind), and, when this is a systemd service of its own, every
    // other process in its cgroup (programs that started their own session:
    // setsid, daemons, tmux servers).
    this.pruneSessions();
    // A session whose leader pid now belongs to another process (started
    // at a different time) is not ours any more.
    const sessions = [...this.sessions].filter(([sid, started]) => {
      const now = procs.startTime(sid);
      return now === null || now === started;
    }).map(([sid]) => sid);
    const others = () => {
      const pids = new Set(procs.processesInSessions(sessions));
      for (const pid of procs.serviceCgroupPids() || []) pids.add(pid);
      pids.delete(process.pid);
      return [...pids];
    };
    let left = others();
    procs.signalAll(left, 'SIGHUP');
    procs.signalAll(left, 'SIGTERM');
    procs.signalAll(left, 'SIGCONT'); // stopped jobs must run to see the signals
    const until = Date.now() + graceMs;
    while (left.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      left = others();
    }
    if (left.length) procs.signalAll(left, 'SIGKILL');
    for (const t of this.tabs.values()) t.kill();
  }
}

module.exports = { TerminalManager, SCROLLBACK };
