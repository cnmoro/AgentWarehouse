'use strict';
/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Unicode11Addon, hardenTerminal, throttleRestyles, safeResize */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const tabsEl = $('#tabs');
const termsEl = $('#terms');
const appEl = $('#app');
const mobile = window.matchMedia('(max-width: 700px)');
// On a Mac, Cmd does clipboard and Ctrl belongs to the terminal.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAX_TABS = 50;
const INPUT_CHUNK = 256 * 1024;  // keep each message well under the server's frame limit
const ACK_EVERY = 32 * 1024;
const SNAPSHOT_SLICE = 256 * 1024;

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private mode etc. */ }
  return null;
}

const state = {
  ws: null,
  connected: false,
  tabs: [],             // [{ id, name, alive, group }] terminals, in tab order
  groups: null,         // [{ id, name }] sessions in sidebar order; null: a server without sessions
  activity: new Set(),  // terminals whose screen changed since they were last on screen
  views: new Map(),     // id -> view (see createView)
  active: storage('wt.active'),
  pendingActivate: null,
  closedAt: null,         // position of a closed tab in its session, to open its neighbour
  closedSessionAt: null,  // position of a closed session in the sidebar
  renaming: null,
  retry: 0,
  retryTimer: null,
  connectStarted: 0,
  lastHeard: 0,
  leaving: false,
  fontSize: Number(storage('wt.fontSize')) || 14,
  scrollback: 10000,    // replaced by the server's value on connect
  ctrlSticky: false,    // phone key bar: next key is sent with Ctrl
};

const THEME = {
  background: '#0e1116', foreground: '#d6dde6', cursor: '#5fb3ff', cursorAccent: '#0e1116',
  selectionBackground: '#2f4a66', selectionInactiveBackground: '#26374a',
  black: '#1b2029', red: '#f0706a', green: '#4fce8a', yellow: '#e0b04d',
  blue: '#5fb3ff', magenta: '#c792ea', cyan: '#56c8d8', white: '#d6dde6',
  brightBlack: '#5c6676', brightRed: '#ff8c85', brightGreen: '#6fe3a2', brightYellow: '#f2c66b',
  brightBlue: '#82c4ff', brightMagenta: '#d7a9f5', brightCyan: '#7ad8e5', brightWhite: '#ffffff',
};

// ------------------------------------------------------------------ socket

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function sendInput(id, data, type = 'in') {
  for (let i = 0; i < data.length; i += INPUT_CHUNK) {
    send({ t: type, id, d: data.slice(i, i + INPUT_CHUNK) });
  }
}

function setConnected(up) {
  state.connected = up;
  if (!up && state.ctrlSticky) setCtrlSticky(false);
  for (const el of $$('.conn')) {
    el.classList.toggle('up', up);
    el.title = up ? 'Connected' : 'Disconnected, reconnecting…';
    el.setAttribute('aria-label', el.title);
  }
  $('#banner').hidden = up;
  $('#main').classList.toggle('offline', !up);
  // Refuse keystrokes while offline rather than silently dropping part of a command.
  for (const v of state.views.values()) v.term.options.disableStdin = !up;
}

function goToLogin() {
  state.leaving = true;
  location.replace('/login');
}

// Reconnecting must survive networks that drop packets silently (Wi-Fi
// changes, laptop sleep, Tailscale re-routing): there, a connection attempt
// can hang for minutes, and Chrome lets only one handshake per server be
// pending, so a stuck attempt blocks every later one. Hence: attempts time
// out, a lost connection always schedules the next attempt before anything
// else, and a watchdog restarts the cycle if it ever stops.
const CONNECT_TIMEOUT = 6000;

function connect() {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (state.leaving) return;
  const cur = state.ws;
  if (cur && cur.readyState === WebSocket.OPEN) return;
  if (cur && cur.readyState === WebSocket.CONNECTING) {
    if (Date.now() - state.connectStarted < CONNECT_TIMEOUT) return; // still in time
    abandon(cur);
  }
  let ws;
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  } catch {
    scheduleRetry();
    return;
  }
  state.ws = ws;
  state.connectStarted = Date.now();
  const timeout = setTimeout(() => {
    if (state.ws === ws && ws.readyState === WebSocket.CONNECTING) lose(ws);
  }, CONNECT_TIMEOUT);

  ws.onopen = () => {
    clearTimeout(timeout);
    if (state.ws !== ws) return;
    state.retry = 0;
    startHeartbeat(ws);
    setConnected(true);
    try {
      if (hist.open) {
        hist.requested.clear();
        send({ t: 'histInfo', id: hist.id });
      }
      // The server forgot what this page was attached to. Hidden tabs re-attach
      // when next shown; the visible one re-attaches as soon as the list arrives.
      bgAttach.clear();
      for (const [id, v] of state.views) {
        if (isShown(id)) v.attached = false;
        else disposeView(id);
      }
    } catch (err) {
      console.error('after reconnect:', err);
    }
  };

  ws.onmessage = (ev) => {
    state.lastHeard = Date.now(); // any message proves the connection is alive
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
      case 'hello':
        $('#who').textContent = msg.email;
        $('#who').title = msg.email;
        if (msg.scrollback > 0) state.scrollback = msg.scrollback;
        // Older servers have no file browser: its button stays hidden.
        if (typeof Files !== 'undefined') {
          Files.setFeatures(Array.isArray(msg.features) ? msg.features : []);
          Files.setAvailable(Array.isArray(msg.features) && msg.features.includes('files'));
        }
        if (typeof Vnc !== 'undefined') {
          Vnc.setFluid(Array.isArray(msg.features) ? msg.features.find((f) => f.startsWith('vnc-fluid:')) : '');
          Vnc.setLocal(Array.isArray(msg.features) && msg.features.includes('vnc-local'));
          if (typeof Ssh !== 'undefined') Ssh.setAvailable(Array.isArray(msg.features) && msg.features.includes('ssh'));
          Vnc.setTargetSupport(Array.isArray(msg.features) && msg.features.includes('vnc-target'));
          Vnc.setAvailable(Array.isArray(msg.features) && (msg.features.includes('vnc') || msg.features.includes('vnc-local')));
        }
        break;
      case 'list': onList(msg.tabs, msg.groups); break;
      case 'snap': onSnapshot(msg); break;
      case 'out': onOutput(msg.id, msg.d); break;
      case 'size': onSize(msg); break;
      case 'act': onAct(msg.id); break;
      case 'created': activate(msg.id); break;
      case 'error': toast(msg.msg); break;
      case 'pong': break;
      case 'histInfo': onHistInfo(msg); break;
      case 'histLines': onHistLines(msg); break;
      case 'histFound': onHistFound(msg); break;
    }
  };

  ws.onclose = (ev) => {
    clearTimeout(timeout);
    if (state.ws === ws) lose(ws, ev.code);
  };
}

// Stop listening to a socket and close it (closing a pending one also frees
// Chrome's one-handshake-per-server slot).
function abandon(ws) {
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try { ws.close(); } catch { /* already closed */ }
  if (state.ws === ws) state.ws = null;
}

// The connection is gone (or never came up): schedule the next attempt first,
// so that nothing below can leave the page without one.
function lose(ws, code) {
  abandon(ws);
  if (code === 4001) { goToLogin(); return; }
  scheduleRetry();
  try { setConnected(false); } catch (err) { console.error('setConnected:', err); }
  // A rejected handshake (session gone, e.g. after a server restart) looks like
  // a plain close; ask the server whether we are still signed in.
  fetch('/', { redirect: 'manual', cache: 'no-store' }).then((r) => {
    if (r.type === 'opaqueredirect' || r.redirected) goToLogin();
  }).catch(() => {});
}

// 0.4 s, 0.8 s, 1.6 s, 3.2 s, then every 5 s; jittered so many tabs don't
// reconnect in lockstep after a server restart.
function scheduleRetry() {
  clearTimeout(state.retryTimer);
  const base = Math.min(5000, 400 * 2 ** state.retry++);
  state.retryTimer = setTimeout(connect, base * (0.6 + Math.random() * 0.4));
}

// A network that dies silently leaves the socket "open" for minutes. Every
// 5 s: if a ping has been unanswered for 8 s (and nothing else arrived since),
// the connection is dead. Waiting is measured from the ping itself, so the
// once-a-minute timers of a background tab don't make it look dead.
function startHeartbeat(ws) {
  state.lastHeard = Date.now();
  let pingedAt = 0;
  const timer = setInterval(() => {
    if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) { clearInterval(timer); return; }
    const answered = state.lastHeard >= pingedAt;
    if (!answered && Date.now() - pingedAt > 8000) {
      clearInterval(timer);
      lose(ws, 4000);
      return;
    }
    if (answered) {
      pingedAt = Date.now();
      send({ t: 'ping' });
    }
  }, 5000);
}

// Try right away (network back, tab shown, user typing) instead of waiting
// out the backoff; an attempt that is already taking a while is replaced.
function reconnectNow() {
  if (state.connected || state.leaving) return;
  const cur = state.ws;
  if (cur && cur.readyState === WebSocket.CONNECTING) {
    if (Date.now() - state.connectStarted < 1500) return;
    abandon(cur);
  }
  state.retry = 0;
  connect();
}
window.addEventListener('online', reconnectNow);
$('#retry-now').onclick = () => {
  // The user asked: replace even a fresh attempt.
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) abandon(state.ws);
  reconnectNow();
};
window.addEventListener('focus', reconnectNow);
window.addEventListener('pageshow', reconnectNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });
document.addEventListener('keydown', () => { if (!state.connected) reconnectNow(); }, true);
document.addEventListener('pointerdown', () => { if (!state.connected) reconnectNow(); }, true);

// Watchdog: whatever happened, a disconnected page always has an attempt
// running or scheduled.
setInterval(() => {
  if (state.connected || state.leaving || state.retryTimer) return;
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING
      && Date.now() - state.connectStarted < CONNECT_TIMEOUT) return;
  connect();
}, 5000);

let toastTimer = null;
function toast(text, ms = 4000) {
  const el = $('#toast');
  el.textContent = String(text || 'Something went wrong');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------------------------------------------ terminals

// The server's mirror answers terminal queries (cursor position, device
// attributes, ...). If every open browser answered too, programs would get
// duplicate replies typed into them, so the browser swallows those queries.
function silenceQueries(term) {
  const p = term.parser;
  const swallow = () => true;
  p.registerCsiHandler({ final: 'n' }, swallow);                        // DSR
  p.registerCsiHandler({ prefix: '?', final: 'n' }, swallow);
  p.registerCsiHandler({ final: 'c' }, swallow);                        // DA1
  p.registerCsiHandler({ prefix: '>', final: 'c' }, swallow);           // DA2
  p.registerCsiHandler({ prefix: '=', final: 'c' }, swallow);           // DA3
  p.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow);    // DECRQM
  p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow);
  p.registerCsiHandler({ prefix: '>', final: 'q' }, swallow);           // XTVERSION
  p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);    // DECRQSS
  for (const osc of [4, 10, 11, 12]) {                                   // color queries
    p.registerOscHandler(osc, (data) => data.length <= 4096 && data.split(';').includes('?'));
  }
}

function createView(id) {
  const el = document.createElement('div');
  el.className = 'term';
  el.dataset.id = id;
  termsEl.appendChild(el);

  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize: state.fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: state.scrollback,
    allowProposedApi: true,
    theme: THEME,
    // Keeps text readable when a program picks colours close to our background.
    minimumContrastRatio: 4.5,
    macOptionIsMeta: true,
    // Programs that take the mouse (claude, codex, vim, tmux) get the drags;
    // Option+drag (Shift+drag elsewhere) still selects terminal text.
    macOptionClickForcesSelection: true,
    // The scrollbar's width (xterm sizes it from the overview ruler); the
    // other scrollbars in app.css match it.
    overviewRuler: { width: 8 },
    rightClickSelectsWord: false,
    disableStdin: !state.connected,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => openLink(uri)));
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  silenceQueries(term);
  hardenTerminal(term);
  throttleRestyles(term);
  term.open(el);

  term.attachCustomKeyEventHandler((e) => handleKey(term, e));
  // Selecting text copies it, as in most terminals. xterm finishes the
  // selection in its own (document-level) mouseup, hence the timeout; the
  // click still counts as a user action for the plain-http copy fallback.
  el.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    setTimeout(() => {
      const text = term.hasSelection() ? term.getSelection() : '';
      if (text.trim()) copyAndTell(text);
    }, 0);
  });
  // OSC 52: programs that do their own selection (claude, codex, tmux, vim
  // with clipboard support) copy by sending the text in this sequence. Only
  // writes are honoured, never reads, and only for the terminal on screen.
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?' || !isShown(id) || !document.hasFocus()) return true;
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (text) copyAndTell(text);
    } catch { /* not valid base64: ignore */ }
    return true;
  });
  term.onData((d) => {
    reclaimSize(id);
    if (state.ctrlSticky) {
      // One typed character becomes its control character; anything else
      // (a suggestion, a paste, an arrow sequence) just releases Ctrl.
      if (d.length === 1) d = ctrlChar(d);
      setCtrlSticky(false);
    }
    sendInput(id, d);
  });
  term.onBinary((d) => sendInput(id, d, 'bin'));
  // Scrolled to the very top: offer the older history, if there is any.
  term.onScroll(() => updateHistPill(id));

  addTouchScroll(el, term);

  const view = { id, term, fit, el, webgl: null, attached: false, seq: 0, ackPending: 0, ackTimer: null, actTimer: null, actSince: 0 };
  state.views.set(id, view);
  return view;
}

// Touch on the terminal.
//  - A swipe scrolls. On the normal screen it moves through the history; where
//    a program has taken over (the alternate screen of claude, opencode, vim,
//    less; or any program that asked for mouse reports) it becomes mouse-wheel
//    events on the terminal, which xterm reports to the program or turns into
//    arrow keys, as a wheel would. A quick flick keeps going for a moment.
//  - Pressing and holding selects the word under the finger; keep dragging to
//    extend, lift to get a small bar with Copy. (xterm has no touch selection,
//    and the browser's own long-press only offers "Paste".)
// The touch selection in cells (buffer rows): `lo` and `hi`, both included.
let touchSel = null; // { term, lo, hi }
const cellIndex = (term, c) => c.row * term.cols + c.col;
const screenOf = (term) => term.element && term.element.querySelector('.xterm-screen');

function cellAtPoint(term, x, y) {
  const r = screenOf(term).getBoundingClientRect();
  const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - r.left) / (r.width / term.cols))));
  const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - r.top) / (r.height / term.rows))));
  return { col, row: row + term.buffer.active.viewportY };
}

function selectCells(term, a, b) {
  const [lo, hi] = cellIndex(term, a) <= cellIndex(term, b) ? [a, b] : [b, a];
  term.select(lo.col, lo.row, cellIndex(term, hi) - cellIndex(term, lo) + 1);
  touchSel = { term, lo: { ...lo }, hi: { ...hi } };
}

const selBar = document.createElement('div');
selBar.id = 'selbar';
selBar.hidden = true;
selBar.innerHTML = '<button data-a="copy">Copy</button><button data-a="line">Line</button><button data-a="x" aria-label="Cancel selection">✕</button>';
document.body.appendChild(selBar);
// Handles at both ends of the selection, to pull it longer or shorter.
const handles = ['lo', 'hi'].map((end) => {
  const h = document.createElement('div');
  h.className = `selhandle ${end}`;
  h.hidden = true;
  h.innerHTML = '<span></span>';
  document.body.appendChild(h);
  return h;
});
let handleDrag = null; // 'lo' | 'hi'
selBar.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard as it is
selBar.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.a;
  const term = touchSel && touchSel.term;
  if (!act || !term) return;
  if (act === 'copy') { copyAndTell(term.getSelection()); term.clearSelection(); hideSelBar(); }
  else if (act === 'line') {
    selectCells(term, { col: 0, row: touchSel.lo.row }, { col: term.cols - 1, row: touchSel.hi.row });
    showSelBar(term);
  } else { term.clearSelection(); hideSelBar(); }
});
handles.forEach((h, i) => {
  const end = i === 0 ? 'lo' : 'hi';
  h.addEventListener('touchstart', (e) => { e.preventDefault(); handleDrag = end; selBar.hidden = true; }, { passive: false });
  h.addEventListener('touchmove', (e) => {
    if (!handleDrag || !touchSel) return;
    e.preventDefault();
    const { term } = touchSel;
    const t = e.touches[0];
    const ch = screenOf(term).getBoundingClientRect().height / term.rows;
    // The handle hangs below its cell: the cell being pointed at is the row above the finger.
    const c = cellAtPoint(term, t.clientX, t.clientY - 14 - ch / 2);
    const other = handleDrag === 'lo' ? touchSel.hi : touchSel.lo;
    selectCells(term, c, other);
    placeHandles(term);
  }, { passive: false });
  const end_ = () => { if (handleDrag && touchSel) { handleDrag = null; showSelBar(touchSel.term); } };
  h.addEventListener('touchend', end_);
  h.addEventListener('touchcancel', end_);
});

function hideSelBar() {
  selBar.hidden = true;
  handles.forEach((h) => { h.hidden = true; });
  touchSel = null;
  handleDrag = null;
}

function placeHandles(term) {
  const screen = screenOf(term);
  if (!touchSel || touchSel.term !== term || !screen) return;
  const r = screen.getBoundingClientRect();
  const cw = r.width / term.cols;
  const ch = r.height / term.rows;
  const vy = term.buffer.active.viewportY;
  const place = (h, c, right) => {
    const row = c.row - vy;
    h.hidden = row < 0 || row >= term.rows;
    if (h.hidden) return;
    h.style.left = `${r.left + (right ? (c.col + 1) * cw : c.col * cw)}px`;
    h.style.top = `${r.top + (row + 1) * ch}px`;
  };
  place(handles[0], touchSel.lo, false);
  place(handles[1], touchSel.hi, true);
}

function showSelBar(term) {
  const screen = screenOf(term);
  if (!touchSel || touchSel.term !== term || !screen) return;
  const r = screen.getBoundingClientRect();
  const ch = r.height / term.rows;
  const vy = term.buffer.active.viewportY;
  const top = r.top + (touchSel.lo.row - vy) * ch;
  const bottom = r.top + (touchSel.hi.row - vy + 1) * ch;
  selBar.hidden = false;
  const w = selBar.offsetWidth;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + touchSel.lo.col * (r.width / term.cols)));
  // Above the selection; below it (past the handles) when there is no room above.
  const y = top - selBar.offsetHeight - 10 >= 4 ? top - selBar.offsetHeight - 10 : bottom + 36;
  selBar.style.left = `${x}px`;
  selBar.style.top = `${Math.max(4, Math.min(innerHeight - selBar.offsetHeight - 4, y))}px`;
  placeHandles(term);
}

function addTouchScroll(el, term) {
  const HOLD_MS = 420;
  const SLOP = 10;
  let lastY = null;
  let lastT = 0;
  let carry = 0;
  let velocity = 0; // px per ms, positive = content moving up
  let coast = 0;
  let hold = 0;
  let startX = 0;
  let startY = 0;
  let scrolling = false;
  let selecting = null; // { from, to } cells of the word first pressed
  let touching = 0;     // until shortly after the finger lifts: swallow the browser's long-press menu
  let noMouseUntil = 0; // after a selection: ignore the mouse events the browser makes up from the touch

  const cellHeight = () => el.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height
    || term.options.fontSize * 1.2;
  const wheel = (dy, x, y) => {
    const target = el.querySelector('.xterm-screen') || el;
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  };
  const handedOver = () => term.buffer.active.type !== 'normal' || term.modes.mouseTrackingMode !== 'none';
  const scroll = (dy, x, y) => {
    if (handedOver()) { wheel(dy, x, y); return; }
    carry += dy / cellHeight();
    const lines = Math.trunc(carry);
    if (lines) { term.scrollLines(lines); carry -= lines; }
  };
  const cellAt = (x, y) => cellAtPoint(term, x, y);
  const index = (c) => cellIndex(term, c);
  const wordAt = (c) => {
    const text = term.buffer.active.getLine(c.row)?.translateToString(false) || '';
    const blank = (i) => !text[i] || /\s/.test(text[i]);
    if (blank(c.col)) return { from: c, to: c };
    let a = c.col;
    let z = c.col;
    while (a > 0 && !blank(a - 1)) a--;
    while (z < term.cols - 1 && !blank(z + 1)) z++;
    return { from: { col: a, row: c.row }, to: { col: z, row: c.row } };
  };
  const selectBetween = (a, b) => selectCells(term, a, b);
  const extendTo = (x, y) => {
    const c = cellAt(x, y);
    if (index(c) < index(selecting.from)) selectBetween(c, selecting.to);
    else if (index(c) > index(selecting.to)) selectBetween(selecting.from, c);
    else selectBetween(selecting.from, selecting.to);
  };

  el.addEventListener('touchstart', (e) => {
    cancelAnimationFrame(coast);
    clearTimeout(hold);
    touching = 1;
    if (touchSel && touchSel.term === term && !selecting) { term.clearSelection(); hideSelBar(); }
    lastY = e.touches.length === 1 ? e.touches[0].clientY : null;
    lastT = e.timeStamp;
    velocity = 0;
    carry = 0;
    scrolling = false;
    selecting = null;
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    hold = setTimeout(() => {
      if (scrolling) return;
      const word = wordAt(cellAt(startX, startY));
      selecting = word;
      selectBetween(word.from, word.to);
      if (navigator.vibrate) navigator.vibrate(12);
    }, HOLD_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) { clearTimeout(hold); return; }
    const t = e.touches[0];
    if (selecting) {
      extendTo(t.clientX, t.clientY);
      e.preventDefault();
      return;
    }
    if (lastY === null) return;
    if (!scrolling && Math.hypot(t.clientX - startX, t.clientY - startY) < SLOP) return; // still a press
    scrolling = true;
    clearTimeout(hold);
    const dy = lastY - t.clientY;
    const dt = Math.max(1, e.timeStamp - lastT);
    velocity = 0.6 * velocity + 0.4 * (dy / dt);
    lastY = t.clientY;
    lastT = e.timeStamp;
    scroll(dy, t.clientX, t.clientY);
    e.preventDefault();
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    clearTimeout(hold);
    setTimeout(() => { touching = 0; }, 700);
    if (selecting) {
      selecting = null;
      lastY = null;
      // Lifting a finger makes the browser send a mouse click next, which the
      // terminal takes as "clicked elsewhere" and clears the selection with.
      if (e.cancelable) e.preventDefault();
      noMouseUntil = Date.now() + 800;
      if (term.hasSelection()) showSelBar(term);
      return;
    }
    const x = e.changedTouches[0]?.clientX ?? 0;
    const y = e.changedTouches[0]?.clientY ?? 0;
    const flick = scrolling && lastY !== null && e.timeStamp - lastT < 80 && Math.abs(velocity) > 0.4;
    lastY = null;
    if (!flick) return;
    let v = velocity;
    let prev = performance.now();
    const step = (now) => {
      v *= 0.95 ** ((now - prev) / 16);
      if (Math.abs(v) < 0.05) return;
      scroll(v * (now - prev), x, y);
      prev = now;
      coast = requestAnimationFrame(step);
    };
    coast = requestAnimationFrame(step);
  }, { passive: false });

  term.onScroll(() => { if (touchSel && touchSel.term === term) { placeHandles(term); if (!selBar.hidden) showSelBar(term); } });
  el.addEventListener('touchcancel', () => {
    clearTimeout(hold);
    cancelAnimationFrame(coast);
    lastY = null;
    selecting = null;
    touching = 0;
  }, { passive: true });

  for (const type of ['mousedown', 'mouseup', 'click']) {
    el.addEventListener(type, (e) => {
      if (Date.now() < noMouseUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  // The long-press menu ("Paste") the browser opens on the terminal's hidden
  // input: not while a finger is down or just lifted. A mouse's right-click is
  // not affected.
  el.addEventListener('contextmenu', (e) => { if (touching || selecting) e.preventDefault(); });
}

function disposeView(id) {
  const v = state.views.get(id);
  if (!v) return;
  clearTimeout(v.ackTimer);
  clearTimeout(v.actTimer);
  // A blinking cursor's timer keeps a disposed terminal alive; stop it first.
  v.term.options.cursorBlink = false;
  if (v.webgl) { try { v.webgl.dispose(); } catch { /* already gone */ } }
  v.term.dispose();
  v.el.remove();
  state.views.delete(id);
}

function openLink(uri) {
  if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
}

// Browsers cap live WebGL contexts (~16), so only the visible terminal gets one.
// The GPU renderer caches every glyph/colour pair it draws. A program that
// animates through many shades (opencode's progress bar, a gradient) keeps
// producing pairs it has never drawn: the cache grows a page every few seconds
// and each page is a texture upload, which shows as flicker. A terminal that
// does this (SWITCH_PAGES new cache pages within SWITCH_MS) is switched to the
// plain renderer, which has no cache. Normal use adds one or two pages, early.
const SWITCH_PAGES = 6;
const SWITCH_MS = 30000;

function setWebgl(view, on) {
  if (on && !view.webgl && !view.plainRenderer) {
    try {
      const addon = new WebglAddon.WebglAddon();
      addon.onContextLoss(() => { addon.dispose(); view.webgl = null; });
      const pages = [];
      addon.onAddTextureAtlasCanvas(() => {
        const now = Date.now();
        pages.push(now);
        while (pages.length && now - pages[0] > SWITCH_MS) pages.shift();
        if (pages.length >= SWITCH_PAGES && view.webgl === addon) {
          view.plainRenderer = true;
          // Not inside the event that is still being delivered.
          setTimeout(() => { if (view.webgl === addon) { addon.dispose(); view.webgl = null; } }, 0);
        }
      });
      view.term.loadAddon(addon);
      view.webgl = addon;
    } catch { /* falls back to the DOM renderer */ }
  } else if (!on && view.webgl) {
    view.webgl.dispose();
    view.webgl = null;
  }
}

// The server keeps terminals between 20x1 and 500x200; fit within the same
// bounds so both sides always agree on the size (a narrower window clips).
function fittedSize(v) {
  let dims;
  try { dims = v.fit.proposeDimensions(); } catch { return null; }
  if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return null;
  return { cols: Math.max(20, Math.min(500, dims.cols)), rows: Math.max(1, Math.min(200, dims.rows)) };
}

function fitView(id) {
  const v = state.views.get(id);
  if (!v || !v.el.classList.contains('visible')) return;
  const size = fittedSize(v);
  if (!size) return;
  safeResize(v.term, size.cols, size.rows);
  send({ t: 'resize', id, cols: size.cols, rows: size.rows });
}
function fitActive() {
  for (const id of shownTabs()) fitView(id);
}

function drawerOpen() {
  return mobile.matches && !appEl.classList.contains('collapsed');
}

function focusActive() {
  const v = state.views.get(state.active);
  // On a phone, focusing the terminal behind an open drawer pops up the keyboard.
  if (v && !state.renaming && !drawerOpen()) v.term.focus();
}

// Another browser may have resized this terminal. Take the size back as soon as
// this one is used, not only when its window regains focus.
function reclaimSize(id) {
  if (!isShown(id)) return;
  const v = state.views.get(id);
  const size = v && fittedSize(v);
  if (size && (size.cols !== v.term.cols || size.rows !== v.term.rows)) fitActive();
}

// Tell the server how much output we have actually processed, so it can hold
// the program back instead of flooding the browser.
function ack(v, n) {
  v.ackPending += n;
  if (v.ackPending >= ACK_EVERY) {
    flushAck(v);
  } else if (!v.ackTimer) {
    v.ackTimer = setTimeout(() => flushAck(v), 100);
  }
}

function flushAck(v) {
  clearTimeout(v.ackTimer);
  v.ackTimer = null;
  if (v.ackPending > 0 && state.views.get(v.id) === v) {
    send({ t: 'ack', id: v.id, seq: v.seq, n: v.ackPending });
  }
  v.ackPending = 0;
}

function showView(v) {
  v.el.classList.add('visible');
  setWebgl(v, true);
}

function onSnapshot({ id, d, seq, cols, rows }) {
  // Keep the reader's place if they had scrolled up into the history.
  const old = state.views.get(id);
  const back = old ? old.term.buffer.active.baseY - old.term.buffer.active.viewportY : 0;
  // Build a fresh terminal: reset() would leave not-yet-parsed old output queued.
  disposeView(id);
  const v = createView(id);
  v.attached = true;
  v.seq = seq;
  v.term.resize(cols, rows);
  // Written in slices, each acknowledged as it is parsed, so the server sees
  // progress on a big snapshot instead of one ack at the very end.
  for (let i = 0; i < d.length; i += SNAPSHOT_SLICE) {
    const slice = d.slice(i, i + SNAPSHOT_SLICE);
    v.term.write(slice, () => ack(v, slice.length));
  }
  bgAttach.delete(id);
  if (!isShown(id)) noteOutput(v);
  if (isShown(id)) {
    showView(v);
    applyLayout();
    v.term.write('', () => {
      if (back > 0) v.term.scrollToLine(Math.max(0, v.term.buffer.active.baseY - back));
      else v.term.scrollToBottom();
      fitActive();
      if (appEl.contains(document.activeElement) || document.activeElement === document.body) focusActive();
    });
  }
}

function onOutput(id, d) {
  const v = state.views.get(id);
  if (!v) return;
  v.term.write(d, () => ack(v, d.length));
  if (!isShown(id)) noteOutput(v);
}

// Another browser resized the terminal. Follow it so wrapping matches what the
// program draws; this browser takes the size back when it is used again.
function onSize({ id, cols, rows }) {
  const v = state.views.get(id);
  if (v) safeResize(v.term, cols, rows);
}

function markActivity(id) {
  if (isShown(id) || state.activity.has(id)) return;
  state.activity.add(id);
  renderTabs();
}

// ---- Activity (the yellow dot) means "the text on screen changed since you
// last looked", not "some bytes arrived". Idle programs print things that
// leave the screen as it was: claude flashes "Checking for updates" every
// 30 minutes, TUIs redraw after a resize or re-send their modes on focus.
// So: remember a fingerprint of each tab's screen when you leave it; when a
// background tab prints, wait for the output to settle, then compare.
const ACT_SETTLE = 1000;    // judge once the tab has been quiet this long...
const ACT_MAX_WAIT = 5000;  // ...or after this long, if it never goes quiet
const seen = new Map(Object.entries(JSON.parse(storage('wt.seen') || '{}')));
const bgAttach = new Set(); // hidden tabs being fetched only to compare their screen

// Text of the bottom screenful, without spaces: line wrapping changes after a
// resize, the words don't. FNV-1a, so localStorage keeps a short number.
function screenHash(term) {
  const b = term.buffer.active;
  let h = 0x811c9dc5;
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 160) continue;
      h = Math.imul(h ^ c, 0x01000193) >>> 0;
    }
  }
  return h.toString(36);
}

function rememberSeen(id) {
  const v = state.views.get(id);
  if (!v || !v.attached) return;
  seen.set(id, screenHash(v.term));
  storage('wt.seen', JSON.stringify(Object.fromEntries(seen)));
}

// A background tab printed: compare once it settles.
function noteOutput(v) {
  if (isShown(v.id)) return;
  const now = Date.now();
  if (!v.actSince) v.actSince = now;
  clearTimeout(v.actTimer);
  const wait = Math.max(0, Math.min(ACT_SETTLE, v.actSince + ACT_MAX_WAIT - now));
  v.actTimer = setTimeout(() => {
    v.actSince = 0;
    if (isShown(v.id) || state.views.get(v.id) !== v) return;
    // Let xterm finish parsing what has arrived, then look.
    v.term.write('', () => {
      if (isShown(v.id) || state.views.get(v.id) !== v) return;
      const now = screenHash(v.term);
      const before = seen.get(v.id);
      if (before === undefined) {
        // Never viewed in this browser: what it shows now is the starting point.
        seen.set(v.id, now);
        storage('wt.seen', JSON.stringify(Object.fromEntries(seen)));
      } else if (before !== now) {
        markActivity(v.id);
      }
    });
  }, wait);
}

// Fetch a hidden tab quietly; its snapshot and further output are judged like
// any background tab's.
function fetchInBackground(id) {
  if (isShown(id) || bgAttach.has(id)) return;
  const v = state.views.get(id);
  if (v && v.attached) return; // its output reaches us directly
  if (send({ t: 'attach', id })) bgAttach.add(id);
}

// The server reports activity in a tab this page isn't attached to.
function onAct(id) {
  fetchInBackground(id);
}
// Leaving the page also counts as having seen the tab on screen.
document.addEventListener('visibilitychange', () => { if (document.hidden && state.active) rememberSeen(state.active); });
window.addEventListener('pagehide', () => { if (state.active) rememberSeen(state.active); });

function activate(id) {
  if (!state.tabs.some((t) => t.id === id)) {
    state.pendingActivate = id;
    return;
  }
  if (state.active && state.active !== id && state.views.has(state.active)) rememberSeen(state.active);
  placeTab(id);
  if (hist.open && hist.id !== id) histClose();
  hideHistPill();
  state.active = id;
  storage('wt.active', id);
  if (state.ctrlSticky) setCtrlSticky(false);
  state.activity.delete(id);
  rememberLastTab(id);

  let v = state.views.get(id);
  if (!v) v = createView(id);
  if (!v.attached && send({ t: 'attach', id })) v.attached = true;
  applyLayout();
  saveLayout();
  renderTabs();
  requestAnimationFrame(() => {
    fitActive();
    focusActive();
  });
  if (mobile.matches) setSidebar(false);
}

function onList(tabs, groups) {
  const oldSession = sessionOf(state.active);
  const oldSessionIndex = sessions().findIndex((g) => g.id === oldSession);
  const oldTabIndex = tabsOf(oldSession).findIndex((t) => t.id === state.active);
  state.tabs = tabs;
  state.groups = Array.isArray(groups) ? groups : null;
  const ids = new Set(tabs.map((t) => t.id));
  // What is being renamed was closed elsewhere: drop the input.
  if (state.renaming && !ids.has(state.renaming) && !sessions().some((g) => g.id === state.renaming)) state.renaming = null;
  // A pane whose terminal is gone closes (the last terminal pane waits for its neighbour).
  for (const leaf of tabLeaves()) {
    if (leaf.tabId && !ids.has(leaf.tabId) && tabLeaves().length > 1) removeLeaf(leaf);
  }
  barKey = null;
  for (const id of [...state.views.keys()]) if (!ids.has(id)) disposeView(id);
  for (const id of [...state.activity]) if (!ids.has(id)) state.activity.delete(id);
  if ([...seen.keys()].some((id) => !ids.has(id))) {
    for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
    storage('wt.seen', JSON.stringify(Object.fromEntries(seen)));
  }
  if ([...lastTab.values()].some((id) => !ids.has(id))) {
    for (const [g, id] of [...lastTab]) if (!ids.has(id)) lastTab.delete(g);
    storage('wt.lastTab', JSON.stringify(Object.fromEntries(lastTab)));
  }
  $('#empty').hidden = tabs.length > 0;
  const live = new Set(sessions().map((g) => g.id));
  if ([...hiddenIds].some((id) => !live.has(id))) {
    for (const id of [...hiddenIds]) if (!live.has(id)) hiddenIds.delete(id);
    storage('wt.hidden', JSON.stringify([...hiddenIds]));
  }

  if (state.pendingActivate && ids.has(state.pendingActivate)) {
    const id = state.pendingActivate;
    state.pendingActivate = null;
    activate(id);
  } else if (!ids.has(state.active)) {
    // The tab on screen went away: its neighbour in the same session, or, if
    // the session is gone, the neighbouring session (not back to the top).
    const siblings = oldSession ? tabsOf(oldSession) : [];
    const all = sessions();
    if (siblings.length) {
      const i = state.closedAt ?? Math.max(0, oldTabIndex);
      activate(siblings[Math.min(i, siblings.length - 1)].id);
    } else if (all.length) {
      const i = state.closedSessionAt ?? Math.max(0, oldSessionIndex);
      activateSession(all[Math.min(i, all.length - 1)].id);
    } else {
      state.active = null;
      renderTabs();
    }
    state.closedAt = state.closedSessionAt = null;
  } else {
    const v = state.views.get(state.active);
    if (!v || !v.attached) activate(state.active);
    else renderTabs();
  }
  // Tabs never viewed in this browser: take their current screen as the
  // starting point, so the yellow dot can tell a real change from a redraw.
  for (const t of tabs) if (!seen.has(t.id)) fetchInBackground(t.id);
  // Clicking a sidebar button that then disappeared leaves focus nowhere.
  if (document.activeElement === document.body) focusActive();
}

// ------------------------------------------------------------------ clipboard & keys

// Resolves to true when the text reached the clipboard.
async function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  // Plain-http fallback (e.g. http://100.x.y.z): execCommand still works inside a key event.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  const prev = document.activeElement;
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* nothing else to try */ }
  ta.remove();
  if (prev) prev.focus();
  return ok;
}

async function copyAndTell(text) {
  const ok = await copyText(text);
  if (ok) {
    const lines = text.split('\n').length;
    toast(lines > 1 ? `Copied ${lines} lines` : `Copied ${text.length} characters`, 1500);
  } else {
    toast(`The browser blocked the copy. Select the text again and press ${isMac ? '⌘C' : 'Ctrl+C'}.`);
  }
}

function setFontSize(size) {
  state.fontSize = Math.max(8, Math.min(32, size));
  storage('wt.fontSize', String(state.fontSize));
  for (const v of state.views.values()) v.term.options.fontSize = state.fontSize;
  fitActive();
}

// Return false to stop xterm from handling the key. e.code is used rather than
// e.key so the shortcuts work on any keyboard layout.
function handleKey(term, e) {
  if (e.type !== 'keydown') return true;
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

  // Ctrl+C copies when text is selected; otherwise it goes to the program (SIGINT).
  if (mod && !e.altKey && e.code === 'KeyC' && (e.shiftKey || term.hasSelection())) {
    copyAndTell(term.getSelection());
    term.clearSelection();
    e.preventDefault();
    return false;
  }
  // Ctrl+V / Ctrl+Shift+V: let the browser fire a paste event, which xterm turns
  // into input (with bracketed-paste markers when the program asks for them).
  if (mod && !e.altKey && e.code === 'KeyV') return false;

  // Ctrl+Shift+H: full history of this terminal, beyond the scrollback.
  if (mod && e.shiftKey && !e.altKey && e.code === 'KeyH') {
    histOpen();
    e.preventDefault();
    return false;
  }
  // Ctrl+Shift+F: the file browser.
  if (mod && e.shiftKey && !e.altKey && e.code === 'KeyF' && typeof Files !== 'undefined') {
    Files.toggle();
    e.preventDefault();
    return false;
  }
  // Ctrl+Shift+K: find a session by name.
  if (mod && e.shiftKey && !e.altKey && e.code === 'KeyK') {
    setSearch(true);
    e.preventDefault();
    return false;
  }
  // Ctrl+Shift+E: jump to the tab list (Tab itself belongs to the shell).
  if (mod && e.shiftKey && !e.altKey && e.code === 'KeyE') {
    if (appEl.classList.contains('collapsed')) setSidebar(true);
    requestAnimationFrame(() => tabsEl.querySelector('.tab.active')?.focus());
    e.preventDefault();
    return false;
  }
  // Ctrl + / − / 0 (Cmd on a Mac): font size instead of zooming the page. The
  // terminal sends nothing for these; Ctrl+Shift+− (Ctrl+_, undo) still passes.
  if (mod && !e.shiftKey && !e.altKey && ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract'].includes(e.code)) {
    const delta = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1 }[e.code];
    setFontSize(delta ? state.fontSize + delta : 14);
    e.preventDefault();
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ sessions and tabs

// The sidebar lists sessions; the strip above the terminal lists the tabs
// (terminals) of the session on screen. A server without sessions sends no
// groups: then each terminal is a session of its own and the strip is hidden.

const stripEl = $('#strip');
const lastTab = new Map(Object.entries(JSON.parse(storage('wt.lastTab') || '{}'))); // session -> tab last on screen

function hasSessions() {
  return Array.isArray(state.groups);
}

function sessionOf(id) {
  const t = state.tabs.find((x) => x.id === id);
  return t ? (hasSessions() ? t.group : t.id) : null;
}

function sessions() {
  return hasSessions() ? state.groups : state.tabs.map((t) => ({ id: t.id, name: t.name }));
}

function tabsOf(gid) {
  return state.tabs.filter((t) => (hasSessions() ? t.group : t.id) === gid);
}

function rememberLastTab(id) {
  const gid = sessionOf(id);
  if (!gid || lastTab.get(gid) === id) return;
  lastTab.set(gid, id);
  storage('wt.lastTab', JSON.stringify(Object.fromEntries(lastTab)));
}

// Back to the tab that was on screen when the session was left.
function activateSession(gid) {
  const members = tabsOf(gid);
  if (!members.length) return;
  const last = lastTab.get(gid);
  activate(members.some((t) => t.id === last) ? last : members[0].id);
}

// The browser tab always says the same thing, whatever session is open.
function updateTitle() {
  if (document.title !== 'Agent Warehouse') document.title = 'Agent Warehouse';
}

function renderTabs() {
  if (state.renaming) return; // don't clobber an input the user is typing in
  renderSidebar();
  renderStrip();
  updateTitle();
  const full = state.tabs.length >= MAX_TABS;
  const limit = `Limit of ${MAX_TABS} terminals reached`;
  for (const b of $$('.new-tab')) {
    b.disabled = full;
    b.title = full ? limit : hasSessions() ? 'New session (opens in the current folder)' : 'New terminal (opens in the current tab\'s folder)';
  }
  for (const b of $$('.chip-add')) {
    b.disabled = full;
    b.title = full ? limit : 'New tab (opens in the folder of this session\'s first tab)';
  }
}

function actionButton(text, title, label, onclick, className) {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.tabIndex = -1;
  b.setAttribute('aria-label', label);
  if (className) b.className = className;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

// ---- finding a session by name (fuzzy): the letters typed must appear in order;
// runs of them, and ones that start a word, rank higher.
const searchEl = $('#search');
const searchQ = $('#search-q');
let query = '';
function fuzzy(name, q) {
  const n = name.toLowerCase();
  const hits = [];
  let score = 0, from = 0, prev = -2;
  for (const ch of q.toLowerCase()) {
    if (ch === ' ') continue;
    const i = n.indexOf(ch, from);
    if (i < 0) return null;
    hits.push(i);
    score += 1 + (i === prev + 1 ? 5 : 0) + (i === 0 || /[\s\-_./]/.test(n[i - 1]) ? 4 : 0) - Math.min(i, 20) * 0.05;
    prev = i;
    from = i + 1;
  }
  // A plain substring is the best match there is.
  const sub = n.indexOf(q.toLowerCase().trim());
  if (sub >= 0) score += 20 - Math.min(sub, 15) * 0.2;
  return { score, hits };
}
function markName(el, name, hits) {
  el.textContent = '';
  const set = new Set(hits);
  let run = '', on = false;
  const flush = () => {
    if (!run) return;
    if (on) { const m = document.createElement('mark'); m.textContent = run; el.append(m); } else el.append(run);
    run = '';
  };
  [...name].forEach((c, i) => { if (set.has(i) !== on) { flush(); on = set.has(i); } run += c; });
  flush();
}
function setSearch(open) {
  searchEl.hidden = !open;
  $('#search-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    if (appEl.classList.contains('collapsed')) setSidebar(true);
    searchQ.focus();
    searchQ.select();
  } else {
    query = '';
    searchQ.value = '';
    renderSidebar();
  }
}
$('#search-btn').onclick = () => setSearch(searchEl.hidden);
searchQ.addEventListener('input', () => { query = searchQ.value.trim(); renderSidebar(); });
searchQ.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); setSearch(false); focusActive(); }
  else if (e.key === 'Enter') {
    const first = tabsEl.querySelector('.tab');
    if (first) { activateSession(first.dataset.id); setSearch(false); focusActive(); }
  } else if (e.key === 'ArrowDown') { e.preventDefault(); tabsEl.querySelector('.tab')?.focus(); }
});

function renderSidebar() {
  const hadFocus = tabsEl.contains(document.activeElement) ? document.activeElement.closest('.tab')?.dataset.id : null;
  const current = sessionOf(state.active);
  tabsEl.textContent = '';
  const addItem = (g, hidden) => {
    const members = tabsOf(g.id);
    const active = g.id === current;
    const li = document.createElement('li');
    li.className = 'tab';
    li.dataset.id = g.id;
    li.draggable = !hidden;
    if (hidden) li.classList.add('hidden-session');
    li.tabIndex = active ? 0 : -1;
    li.setAttribute('role', 'tab');
    li.setAttribute('aria-selected', String(active));
    if (active) li.classList.add('active');
    if (members.some((t) => state.activity.has(t.id))) li.classList.add('activity');
    if (members.length && members.every((t) => !t.alive)) li.classList.add('dead');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    if (query && g._hits) markName(name, g.name, g._hits); else name.textContent = g.name;
    name.title = `${g.name}${members.length > 1 ? ` · ${members.length} tabs` : ''}\nDouble-click to rename`;
    li.append(dot, name);
    if (members.length > 1) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(members.length);
      count.setAttribute('aria-label', `${members.length} tabs`);
      li.append(count);
    }

    const actions = document.createElement('span');
    actions.className = 'actions';
    actions.append(
      eyeButton(g, hidden),
      actionButton('⏱', 'Full history (Ctrl+Shift+H)', `History of ${g.name}`, () => {
        if (sessionOf(state.active) !== g.id) activateSession(g.id);
        histOpen();
      }),
      actionButton('✎', 'Rename (F2)', `Rename ${g.name}`, () => renameSession(g.id)),
      actionButton('✕', hasSessions() ? 'Close session (Delete)' : 'Close terminal (Delete)', `Close ${g.name}`,
        () => closeSession(g.id), 'close'),
    );
    li.append(actions);
    li.onclick = () => activateSession(g.id);
    name.ondblclick = (e) => { e.stopPropagation(); renameSession(g.id); };
    if (!hidden) addDrag(li);
    tabsEl.appendChild(li);
    if (hadFocus === g.id) li.focus();
  };
  const all = sessions();
  if (query) {
    // Matches, best first, hidden sessions included.
    const found = all.map((g) => ({ g, m: fuzzy(g.name, query) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score);
    for (const { g, m } of found) { g._hits = m.hits; addItem(g, hiddenIds.has(g.id)); delete g._hits; }
    if (!found.length) {
      const none = document.createElement('li');
      none.className = 'search-none';
      none.textContent = 'No session matches';
      tabsEl.appendChild(none);
    }
    return;
  }
  all.filter((g) => !hiddenIds.has(g.id)).forEach((g) => addItem(g, false));
  const hid = all.filter((g) => hiddenIds.has(g.id));
  if (hid.length) {
    // The section opens by itself while the session on screen is in it.
    const open = hiddenOpen || hid.some((g) => g.id === current);
    const head = document.createElement('li');
    head.className = 'hidden-head';
    head.setAttribute('role', 'presentation');
    const b = document.createElement('button');
    b.setAttribute('aria-expanded', String(open));
    const changed = !open && hid.some((g) => tabsOf(g.id).some((t) => state.activity.has(t.id)));
    b.innerHTML = `<span class="chev">${open ? '▾' : '▸'}</span><span>Hidden (${hid.length})</span>${changed ? '<span class="dot warn"></span>' : ''}`;
    b.onclick = () => { hiddenOpen = !hiddenOpen; storage('wt.hiddenOpen', hiddenOpen ? '1' : '0'); renderSidebar(); };
    head.append(b);
    tabsEl.appendChild(head);
    if (open) hid.forEach((g) => addItem(g, true));
  }
  tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest' });
}

// Hiding a session only takes it out of the main list (into a collapsible
// section at the end); its shells keep running. Remembered per browser.
const hiddenIds = new Set(JSON.parse(storage('wt.hidden') || '[]'));
let hiddenOpen = storage('wt.hiddenOpen') !== '0';
const EYE = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10z"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/></svg>';

function eyeButton(g, hidden) {
  const b = document.createElement('button');
  b.innerHTML = EYE;
  b.className = 'eye';
  b.title = hidden ? 'Show in the list' : 'Hide from the list';
  b.tabIndex = -1;
  b.setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} ${g.name}`);
  b.onclick = (e) => { e.stopPropagation(); setHidden(g.id, !hidden); };
  return b;
}

function setHidden(gid, hide) {
  if (hide) {
    // Leaving the session on screen: move to its neighbour in the visible list.
    if (sessionOf(state.active) === gid) {
      const vis = sessions().filter((g) => !hiddenIds.has(g.id));
      const i = vis.findIndex((g) => g.id === gid);
      const next = vis[i + 1] || vis[i - 1];
      if (next) activateSession(next.id);
    }
    hiddenIds.add(gid);
  } else {
    hiddenIds.delete(gid);
  }
  storage('wt.hidden', JSON.stringify([...hiddenIds]));
  renderTabs();
}

function renderStrip() {
  const gid = hasSessions() ? sessionOf(state.active) : null;
  stripEl.hidden = !gid;
  $('#main').classList.toggle('has-strip', !!gid);
  if (!gid) { stripEl.textContent = ''; return; }
  const hadFocus = stripEl.contains(document.activeElement) ? document.activeElement.closest('.chip')?.dataset.id : null;
  stripEl.textContent = '';
  for (const t of tabsOf(gid)) {
    const active = t.id === state.active;
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.id = t.id;
    chip.draggable = true;
    chip.tabIndex = active ? 0 : -1;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(active));
    if (active) chip.classList.add('active');
    else if (isShown(t.id)) chip.classList.add('active', 'in-split');
    else if (state.activity.has(t.id)) chip.classList.add('activity');
    if (!t.alive) chip.classList.add('dead');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    name.title = `${t.name}\nDouble-click to rename · middle-click to close`;
    const close = actionButton('✕', 'Close tab (Delete)', `Close tab ${t.name}`, () => closeTab(t.id), 'chip-close');
    chip.append(dot, name, close);
    chip.onclick = () => activate(t.id);
    // Middle-click closes, as in browsers (and must not start autoscroll).
    chip.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
    chip.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } };
    name.ondblclick = (e) => { e.stopPropagation(); renameTab(t.id); };
    addChipDrag(chip);
    stripEl.appendChild(chip);
    if (hadFocus === t.id) chip.focus();
  }
  const add = document.createElement('button');
  add.className = 'chip-add';
  add.textContent = '+';
  add.setAttribute('aria-label', 'New tab');
  add.onclick = () => send({ t: 'create', group: gid });
  stripEl.appendChild(add);
  stripEl.querySelector('.chip.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(id, returnFocus) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  const g = hasSessions() && state.groups.find((x) => x.id === t.group);
  const what = g && tabsOf(g.id).length > 1 ? `tab "${t.name}" of "${g.name}"` : `"${g ? g.name : t.name}"`;
  if (t.alive && !confirm(`Close ${what}? Its shell and any running programs will be killed.`)) {
    if (returnFocus) returnFocus.focus();
    else focusActive();
    return;
  }
  if (id === state.active) state.closedAt = tabsOf(sessionOf(id)).indexOf(t);
  send({ t: 'close', id });
  focusActive();
}

function closeSession(gid, returnFocus) {
  if (!hasSessions()) { closeTab(gid, returnFocus); return; }
  const g = state.groups.find((x) => x.id === gid);
  if (!g) return;
  const members = tabsOf(gid);
  const what = members.length > 1 ? `Its ${members.length} tabs` : 'Its shell';
  if (members.some((t) => t.alive) && !confirm(`Close "${g.name}"? ${what} and any running programs will be killed.`)) {
    if (returnFocus) returnFocus.focus();
    else focusActive();
    return;
  }
  if (gid === sessionOf(state.active)) state.closedSessionAt = state.groups.indexOf(g);
  send({ t: 'closeGroup', id: gid });
  focusActive();
}

// Keyboard use of the session list: arrows move, Enter opens, F2 renames, Delete closes.
tabsEl.addEventListener('keydown', (e) => {
  const li = e.target.closest?.('.tab');
  if (!li || e.target.tagName === 'INPUT') return;
  const items = [...tabsEl.querySelectorAll('.tab')];
  const i = items.indexOf(li);
  const target = {
    ArrowDown: items[(i + 1) % items.length],
    ArrowUp: items[(i - 1 + items.length) % items.length],
    Home: items[0],
    End: items[items.length - 1],
  }[e.key];
  if (target) {
    items.forEach((x) => { x.tabIndex = -1; });
    target.tabIndex = 0;
    target.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    activateSession(li.dataset.id);
  } else if (e.key === 'F2') {
    renameSession(li.dataset.id);
  } else if (e.key === 'Delete') {
    closeSession(li.dataset.id, li);
  } else if (e.key === 'Escape') {
    focusActive();
  } else {
    return;
  }
  e.preventDefault();
});

// The same for the tabs of the strip, along the row.
stripEl.addEventListener('keydown', (e) => {
  const chip = e.target.closest?.('.chip');
  if (!chip || e.target.tagName === 'INPUT') return;
  const items = [...stripEl.querySelectorAll('.chip')];
  const i = items.indexOf(chip);
  const target = {
    ArrowRight: items[(i + 1) % items.length],
    ArrowLeft: items[(i - 1 + items.length) % items.length],
    Home: items[0],
    End: items[items.length - 1],
  }[e.key];
  if (target) {
    items.forEach((x) => { x.tabIndex = -1; });
    target.tabIndex = 0;
    target.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    activate(chip.dataset.id);
  } else if (e.key === 'F2') {
    renameTab(chip.dataset.id);
  } else if (e.key === 'Delete') {
    closeTab(chip.dataset.id, chip);
  } else if (e.key === 'Escape') {
    focusActive();
  } else {
    return;
  }
  e.preventDefault();
});

// Edit a name in place: Enter or leaving the field saves, Escape cancels.
function inlineRename(el, current, save) {
  const nameEl = el && el.querySelector('.name');
  if (!nameEl || state.renaming) return;
  state.renaming = el.dataset.id;
  el.draggable = false; // otherwise mouse selection inside the input starts a drag
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = current;
  input.maxLength = 60;
  input.setAttribute('aria-label', 'Name');
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (keep && name && name !== current) {
      save(name);
      nameEl.textContent = name;
    }
    // Swap the input back in place. Rebuilding the list here would eat a click
    // on another tab that caused this blur.
    input.replaceWith(nameEl);
    el.draggable = true;
    state.renaming = null;
    updateTitle();
    // Catch up on list changes skipped while the input was open. Deferred so a
    // click on another tab (which caused the blur) still lands.
    setTimeout(renderTabs, 150);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    // preventDefault: otherwise the Enter keypress lands in the terminal once it has focus.
    if (e.key === 'Enter') { e.preventDefault(); finish(true); focusActive(); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); focusActive(); }
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  input.onauxclick = (e) => e.stopPropagation();
}

function renameSession(gid) {
  const li = tabsEl.querySelector(`.tab[data-id="${CSS.escape(gid)}"]`);
  if (!hasSessions()) {
    const t = state.tabs.find((x) => x.id === gid);
    if (t) inlineRename(li, t.name, (name) => { t.name = name; send({ t: 'rename', id: gid, name }); });
    return;
  }
  const g = state.groups.find((x) => x.id === gid);
  if (g) inlineRename(li, g.name, (name) => { g.name = name; send({ t: 'renameGroup', id: gid, name }); });
}

function renameTab(id) {
  const chip = stripEl.querySelector(`.chip[data-id="${CSS.escape(id)}"]`);
  const t = state.tabs.find((x) => x.id === id);
  if (t) inlineRename(chip, t.name, (name) => { t.name = name; send({ t: 'rename', id, name }); });
}

// ---- drag to reorder: sessions up and down the sidebar, tabs along the strip

let dragId = null;
function clearDropMarks(root) {
  root.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
}
function dropPosition(el, e, horizontal) {
  const r = el.getBoundingClientRect();
  return (horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) ? 'before' : 'after';
}
function moveSession(targetId, where) {
  const ids = sessions().map((g) => g.id).filter((id) => id !== dragId);
  const idx = targetId ? ids.indexOf(targetId) + (where === 'after' ? 1 : 0) : ids.length;
  ids.splice(idx, 0, dragId);
  if (hasSessions()) {
    state.groups.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    send({ t: 'reorderGroups', ids });
  } else {
    state.tabs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    send({ t: 'reorder', ids });
  }
  renderTabs();
}
function addDrag(li) {
  li.addEventListener('dragstart', (e) => {
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
    // A session can be dropped on the screen: its tab in use goes there.
    const gid = li.dataset.id;
    const tab = hasSessions() ? (tabsOf(gid).find((t) => t.id === lastTab.get(gid)) || tabsOf(gid)[0]) : state.tabs.find((t) => t.id === gid);
    if (tab) setTimeout(() => startDock({ kind: 'tab', id: tab.id }), 0);
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    li.classList.remove('dragging');
    clearDropMarks(tabsEl);
  });
  li.addEventListener('dragover', (e) => {
    if (!dragId || dragId === li.dataset.id) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks(tabsEl);
    li.classList.add(dropPosition(li, e) === 'before' ? 'drop-before' : 'drop-after');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId || dragId === li.dataset.id) return;
    moveSession(li.dataset.id, dropPosition(li, e));
  });
}
// Dropping on the empty space below the last session moves it to the end.
tabsEl.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
tabsEl.addEventListener('drop', (e) => {
  e.preventDefault();
  if (dragId) moveSession(null, 'end');
});

let chipDragId = null;
// The session's tabs take the places they held among all terminals (as the
// server does), so the order of other sessions' tabs is untouched.
function moveChip(targetId, where) {
  const ids = tabsOf(sessionOf(chipDragId)).map((t) => t.id).filter((id) => id !== chipDragId);
  const idx = targetId ? ids.indexOf(targetId) + (where === 'after' ? 1 : 0) : ids.length;
  ids.splice(idx, 0, chipDragId);
  const byId = new Map(state.tabs.map((t) => [t.id, t]));
  const places = state.tabs.map((t, i) => (ids.includes(t.id) ? i : -1)).filter((i) => i >= 0);
  ids.forEach((id, k) => { state.tabs[places[k]] = byId.get(id); });
  send({ t: 'reorder', ids });
  renderTabs();
}
function addChipDrag(chip) {
  chip.addEventListener('dragstart', (e) => {
    chipDragId = chip.dataset.id;
    chip.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', chip.dataset.id);
    setTimeout(() => startDock({ kind: 'tab', id: chipDragId }), 0);
  });
  chip.addEventListener('dragend', () => {
    chipDragId = null;
    chip.classList.remove('dragging');
    clearDropMarks(stripEl);
  });
  chip.addEventListener('dragover', (e) => {
    if (!chipDragId || chipDragId === chip.dataset.id) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks(stripEl);
    chip.classList.add(dropPosition(chip, e, true) === 'before' ? 'drop-before' : 'drop-after');
  });
  chip.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!chipDragId || chipDragId === chip.dataset.id) return;
    moveChip(chip.dataset.id, dropPosition(chip, e, true));
  });
}
stripEl.addEventListener('dragover', (e) => { if (chipDragId) e.preventDefault(); });
stripEl.addEventListener('drop', (e) => {
  e.preventDefault();
  if (chipDragId) moveChip(null, 'end');
});

// ------------------------------------------------------------------ split panes
//
// The area under the tab strip holds up to four panes (a 2x2 grid at most):
// terminal tabs (of any session), the file explorer and the desktop. Drag a
// tab, a session from the sidebar, a pane's title bar, or the Files / Desktop
// button over the area: the half of the pane under the pointer nearest to the
// edge you approach takes it; the middle of a pane swaps.
//
// The layout is a binary tree. A leaf shows one thing; a node splits its
// area in two ('h': side by side, 'v': one above the other) at `frac`.

const mainEl = $('#main');
const splittersEl = $('#splitters');
const barsEl = $('#panebars');
const dropEl = $('#dropzone');
const dzHl = dropEl.querySelector('.dz-hl');
const GAP = 5;         // the splitter's thickness
const BAR = 24;        // the title bar of a terminal when there are several panes
const MIN_FRAC = 0.12;
const MAX_PANES = 4;

let leafSeq = 0;
const newLeaf = (kind, tabId = null) => ({ type: 'leaf', kind, tabId, n: ++leafSeq });
const layout = { root: newLeaf('tab', state.active), focus: null };
layout.focus = layout.root;

const leavesOf = (n = layout.root) => (n.type === 'leaf' ? [n] : [...leavesOf(n.a), ...leavesOf(n.b)]);
const tabLeaves = () => leavesOf().filter((l) => l.kind === 'tab');
const leafOfTab = (id) => tabLeaves().find((l) => l.tabId === id) || null;
const leafOfKind = (kind) => leavesOf().find((l) => l.kind === kind) || null;
function parentOf(node, root = layout.root) {
  if (root.type === 'leaf') return null;
  if (root.a === node || root.b === node) return root;
  return parentOf(node, root.a) || parentOf(node, root.b);
}
function replaceNode(old, next) {
  const p = parentOf(old);
  if (!p) layout.root = next;
  else if (p.a === old) p.a = next;
  else p.b = next;
}
const panelEl = (kind) => (kind === 'files' ? $('#files') : kind === 'vnc' ? $('#vnc') : null);
const panelApi = (kind) => (kind === 'files' ? Files : Vnc);

// What is saved: the tabs in their places (a panel is not reopened by a reload).
function plain(n) {
  if (n.type === 'leaf') return n.kind === 'tab' && n.tabId ? { t: n.tabId } : null;
  const a = plain(n.a), b = plain(n.b);
  if (a && b) return { d: n.dir, f: Math.round(n.frac * 1000) / 1000, a, b };
  return a || b;
}
function saveLayout() {
  const p = plain(layout.root);
  storage('wt.layout', p && !p.t ? JSON.stringify({ tree: p, focus: state.active }) : '');
}
function inflate(p) {
  if (!p) return null;
  if (p.t) return newLeaf('tab', String(p.t));
  const a = inflate(p.a), b = inflate(p.b);
  if (!a || !b) return a || b;
  return { type: 'node', dir: p.d === 'v' ? 'v' : 'h', frac: Math.max(MIN_FRAC, Math.min(1 - MIN_FRAC, Number(p.f) || 0.5)), a, b };
}
try {
  const saved = JSON.parse(storage('wt.layout') || 'null');
  const root = saved && inflate(saved.tree);
  if (root && leavesOf(root).length <= MAX_PANES) {
    layout.root = root;
    layout.focus = leavesOf(root).find((l) => l.tabId === state.active) || leavesOf(root)[0];
  }
} catch { /* none saved */ }

// The terminal pane that has the keyboard (or the first one).
function focusedTabLeaf() {
  if (layout.focus && layout.focus.kind === 'tab' && leavesOf().includes(layout.focus)) return layout.focus;
  return tabLeaves()[0] || null;
}
// Tabs on screen: on a phone only the one in use.
function shownTabs() {
  if (mobile.matches) return state.active ? [state.active] : [];
  return tabLeaves().map((l) => l.tabId).filter(Boolean);
}
function isShown(id) { return !!id && shownTabs().includes(id); }

// Where the tab goes when it is chosen (strip, sidebar): into the pane that has
// the keyboard, or, if it is on screen already, that pane gets the keyboard.
function placeTab(id) {
  const there = leafOfTab(id);
  if (there) { layout.focus = there; return; }
  let leaf = focusedTabLeaf();
  if (!leaf) { // only panels are left: the focused one gives way
    leaf = layout.focus || layout.root;
    if (leaf.kind !== 'tab') closePanel(leaf.kind);
    leaf.kind = 'tab';
  }
  leaf.tabId = id;
  layout.focus = leaf;
}

function closePanel(kind) {
  const api = panelApi(kind);
  if (api.isOpen()) api.close({ keepFocus: true });
}

function sessionLabel(tabId) {
  const t = state.tabs.find((x) => x.id === tabId);
  if (!t) return '';
  const g = hasSessions() && state.groups.find((x) => x.id === t.group);
  return g && tabsOf(g.id).length > 1 ? `${g.name} › ${t.name}` : g ? g.name : t.name;
}

let barKey = null;  // null: rebuild the bars at the next layout
function applyLayout() {
  const mob = mobile.matches;
  const W = termsEl.clientWidth, H = termsEl.clientHeight;
  const top = termsEl.offsetTop;
  mainEl.style.setProperty('--top', `${top}px`);
  mainEl.style.setProperty('--bottom', `${Math.max(0, mainEl.clientHeight - top - H)}px`);

  // On a phone: just the pane that has the keyboard.
  let root = layout.root;
  if (mob) root = focusedTabLeaf() || root;
  const out = { leaves: [], nodes: [] };
  (function place(n, r) {
    n._r = r;
    if (n.type === 'leaf') { out.leaves.push(n); return; }
    out.nodes.push(n);
    const f = Math.max(MIN_FRAC, Math.min(1 - MIN_FRAC, n.frac));
    if (n.dir === 'h') {
      const w1 = Math.round((r.w - GAP) * f);
      place(n.a, { x: r.x, y: r.y, w: w1, h: r.h });
      place(n.b, { x: r.x + w1 + GAP, y: r.y, w: r.w - w1 - GAP, h: r.h });
    } else {
      const h1 = Math.round((r.h - GAP) * f);
      place(n.a, { x: r.x, y: r.y, w: r.w, h: h1 });
      place(n.b, { x: r.x, y: r.y + h1 + GAP, w: r.w, h: r.h - h1 - GAP });
    }
  })(root, { x: 0, y: 0, w: W, h: H });
  const multi = out.leaves.length > 1;
  mainEl.classList.toggle('split', multi);

  // Terminals: those on screen are visible (and sized by their pane), the rest are not.
  const wantLeaf = new Map(out.leaves.filter((l) => l.kind === 'tab' && l.tabId && state.tabs.some((t) => t.id === l.tabId)).map((l) => [l.tabId, l]));
  for (const [id, v] of state.views) {
    const leaf = wantLeaf.get(id);
    if (leaf) continue;
    if (v.el.classList.contains('visible')) {
      rememberSeen(id);
      v.el.classList.remove('visible');
      setWebgl(v, false);
    }
  }
  for (const [id, leaf] of wantLeaf) {
    let v = state.views.get(id);
    if (!v) v = createView(id);
    if (!v.attached && send({ t: 'attach', id })) v.attached = true;
    if (!v.el.classList.contains('visible')) {
      v.el.classList.add('visible');
      setWebgl(v, true);
      state.activity.delete(id);
    }
    const r = leaf._r;
    const bar = multi ? BAR : 0;
    if (multi) {
      Object.assign(v.el.style, { inset: 'auto', left: `${r.x + 10}px`, top: `${r.y + bar + 8}px`, width: `${Math.max(0, r.w - 14)}px`, height: `${Math.max(0, r.h - bar - 12)}px` });
    } else {
      v.el.style.inset = v.el.style.left = v.el.style.top = v.el.style.width = v.el.style.height = '';
    }
  }
  // Panels fill their pane; one that is not a pane covers everything, as it always did.
  for (const kind of ['files', 'vnc']) {
    const el = panelEl(kind);
    const leaf = out.leaves.find((l) => l.kind === kind);
    el.classList.toggle('docked', !!leaf && multi);
    if (leaf && multi) {
      Object.assign(el.style, { inset: 'auto', left: `${leaf._r.x}px`, top: `${top + leaf._r.y}px`, width: `${leaf._r.w}px`, height: `${leaf._r.h}px` });
    } else {
      el.style.inset = el.style.left = el.style.top = el.style.width = el.style.height = '';
    }
  }

  // A panel covering everything (not one of the panes) hides the panes' bars and splitters too.
  const covered = ['files', 'vnc'].some((k) => !panelEl(k).hidden && !panelEl(k).classList.contains('docked'));
  barsEl.hidden = splittersEl.hidden = covered;

  // Title bars of the terminals and the splitters.
  const key = multi ? out.leaves.map((l) => `${l.n}:${l.kind}:${l.tabId}:${sessionLabel(l.tabId)}:${l._r.x},${l._r.y},${l._r.w}`).join('|') + `|${tabLeaves().length}` : 'single';
  if (key !== barKey) {
    barKey = key;
    barsEl.textContent = '';
    if (multi) {
      for (const l of out.leaves.filter((x) => x.kind === 'tab' && x.tabId)) {
        const bar = document.createElement('div');
        bar.className = 'panebar' + (l === layout.focus ? ' focus' : '');
        bar.dataset.n = l.n;
        bar.draggable = true;
        bar.style.cssText = `left:${l._r.x}px;top:${top + l._r.y}px;width:${l._r.w}px;height:${BAR}px`;
        const name = document.createElement('span');
        name.className = 'panebar-name';
        name.textContent = sessionLabel(l.tabId);
        bar.append(name);
        if (tabLeaves().length > 1) bar.append(actionButton('✕', 'Close this pane (the terminal keeps running)', 'Close pane', () => closeLeaf(l), 'panebar-btn'));
        bar.addEventListener('pointerdown', () => focusLeaf(l));
        bar.addEventListener('dragstart', (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', l.tabId);
          setTimeout(() => startDock({ kind: 'tab', id: l.tabId }), 0);
        });
        barsEl.append(bar);
      }
    }
  } else if (multi) {
    // Positions only (the bars are kept so a drag in progress survives).
    for (const bar of barsEl.children) {
      const l = out.leaves.find((x) => String(x.n) === bar.dataset.n);
      if (l) bar.style.cssText = `left:${l._r.x}px;top:${top + l._r.y}px;width:${l._r.w}px;height:${BAR}px`;
    }
  }
  for (const bar of barsEl.children) bar.classList.toggle('focus', String(layout.focus && layout.focus.n) === bar.dataset.n);
  while (splittersEl.children.length > out.nodes.length) splittersEl.lastChild.remove();
  while (splittersEl.children.length < out.nodes.length) splittersEl.append(makeSplitter());
  out.nodes.forEach((n, i) => {
    const s = splittersEl.children[i];
    s._node = n;
    s.dataset.dir = n.dir;
    const r = n._r, a = n.a._r;
    s.style.cssText = n.dir === 'h'
      ? `left:${a.x + a.w}px;top:${top + r.y}px;width:${GAP}px;height:${r.h}px`
      : `left:${r.x}px;top:${top + a.y + a.h}px;width:${r.w}px;height:${GAP}px`;
  });
}

function makeSplitter() {
  const s = document.createElement('div');
  s.className = 'splitter';
  s.setAttribute('role', 'separator');
  s.title = 'Drag to resize · double-click to halve';
  s.addEventListener('pointerdown', (e) => {
    const n = s._node;
    if (!n) return;
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => {
      const t = termsEl.getBoundingClientRect();
      const r = n._r;
      const pos = n.dir === 'h' ? ev.clientX - t.left - r.x : ev.clientY - t.top - r.y;
      const total = (n.dir === 'h' ? r.w : r.h) - GAP;
      n.frac = Math.max(MIN_FRAC, Math.min(1 - MIN_FRAC, (pos - GAP / 2) / total));
      applyLayout();
    };
    const end = () => {
      s.removeEventListener('pointermove', move);
      s.removeEventListener('pointerup', end);
      s.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing');
      saveLayout();
      fitActive();
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
  });
  s.addEventListener('dblclick', () => { if (s._node) { s._node.frac = 0.5; saveLayout(); applyLayout(); fitActive(); } });
  return s;
}

function relayout({ focus = true } = {}) {
  applyLayout();
  saveLayout();
  renderTabs();
  requestAnimationFrame(() => { fitActive(); if (focus) focusActive(); });
}

// A pane goes away; its sibling takes the whole space.
function removeLeaf(leaf, { closePanelToo = true } = {}) {
  const p = parentOf(leaf);
  if (!p) return false;
  replaceNode(p, p.a === leaf ? p.b : p.a);
  if (layout.focus === leaf) layout.focus = null;
  if (closePanelToo && leaf.kind !== 'tab') closePanel(leaf.kind);
  if (!layout.focus || !leavesOf().includes(layout.focus)) layout.focus = tabLeaves()[0] || leavesOf()[0];
  const f = focusedTabLeaf();
  if (f && f.tabId && state.active !== f.tabId) { state.active = f.tabId; storage('wt.active', f.tabId); }
  return true;
}
function closeLeaf(leaf) {
  if (leaf.kind === 'tab' && tabLeaves().length < 2) return;
  if (removeLeaf(leaf)) { barKey = null; relayout(); }
}
function focusLeaf(leaf) {
  if (layout.focus === leaf) return;
  layout.focus = leaf;
  if (leaf.kind === 'tab' && leaf.tabId && leaf.tabId !== state.active) activate(leaf.tabId);
  else { barKey = null; applyLayout(); }
}

// Splits `target` so that `content` (a new leaf) sits on `side` of it.
function splitLeaf(target, content, side) {
  const horizontal = side === 'left' || side === 'right';
  const first = side === 'left' || side === 'top';
  const node = { type: 'node', dir: horizontal ? 'h' : 'v', frac: 0.5, a: first ? content : target, b: first ? target : content };
  replaceNode(target, node);
}

// Dropped on a pane: `target` the pane, `where` an edge or 'center'.
// `drag` is { kind: 'tab', id } or { kind: 'files' | 'vnc' }.
function dropOn(target, where, drag) {
  const wasFocus = layout.focus;
  void wasFocus;
  if (drag.kind === 'tab') {
    const id = drag.id;
    const there = leafOfTab(id);
    if (where === 'center') {
      if (target.kind !== 'tab') return;
      if (there && there !== target) { const mine = target.tabId; target.tabId = id; there.tabId = mine; if (target.kind !== 'tab') { /* swapped into a tab pane */ } }
      else if (target.kind === 'tab') target.tabId = id;
      else return;
      layout.focus = target;
    } else {
      if (target.tabId === id) {
        // Its own pane: the pane keeps another tab of the session.
        const gid = sessionOf(id);
        const shown = new Set(shownTabs());
        const other = tabsOf(gid).find((t) => t.id !== id && !shown.has(t.id));
        if (!other) return;
        target.tabId = other.id;
      } else if (there) {
        if (!removeLeaf(there)) return;
      }
      if (leavesOf().length >= MAX_PANES) return;
      const N = newLeaf('tab', id);
      splitLeaf(target, N, where);
      layout.focus = N;
    }
    state.active = id;
    storage('wt.active', id);
    state.activity.delete(id);
    rememberLastTab(id);
  } else {
    const kind = drag.kind;
    const there = leafOfKind(kind);
    if (there === target) return;
    if (there) removeLeaf(there, { closePanelToo: false });
    if (where === 'center' || leavesOf().length >= MAX_PANES) {
      // Only a terminal pane can give way, and one terminal must remain.
      if (target.kind !== 'tab' || tabLeaves().length < 2) return;
      target.kind = kind;
      target.tabId = null;
      layout.focus = target;
    } else {
      const N = newLeaf(kind);
      splitLeaf(target, N, where);
      layout.focus = N;
    }
    closePanel(kind === 'files' ? 'vnc' : 'files');
    const api = panelApi(kind);
    if (!api.isOpen()) api.open();
  }
  barKey = null;
  hideHistPill();
  if (hist.open) histClose();
  relayout();
}

// A panel was closed or opened by its own button: keep the panes in step.
for (const kind of ['files', 'vnc']) {
  new MutationObserver(() => {
    const el = panelEl(kind);
    const leaf = leafOfKind(kind);
    if (el.hidden && leaf) {
      if (tabLeaves().length && removeLeaf(leaf, { closePanelToo: false })) { barKey = null; relayout({ focus: false }); return; }
    }
    applyLayout();
    requestAnimationFrame(fitActive);
  }).observe(panelEl(kind), { attributes: true, attributeFilter: ['hidden'] });
  panelEl(kind).addEventListener('pointerdown', () => { const l = leafOfKind(kind); if (l && layout.focus !== l) { layout.focus = l; barKey = null; applyLayout(); } }, true);
}

// -- the drop zones, while something draggable is on its way
let drag = null; // { kind: 'tab', id } | { kind: 'files' | 'vnc' }
function startDock(d) {
  if (mobile.matches) return;
  drag = d;
  dropEl.hidden = false;
  dropEl.classList.remove('over');
  barsEl.style.pointerEvents = 'none';
}
function endDock() {
  drag = null;
  dropEl.hidden = true;
  dropEl.classList.remove('over');
  barsEl.style.pointerEvents = '';
}
// The pane under the pointer and where in it: an edge, or the middle.
function dropTarget(e) {
  const r = dropEl.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const leaves = leavesOf();
  const leaf = leaves.find((l) => x >= l._r.x && x < l._r.x + l._r.w + GAP && y >= l._r.y && y < l._r.y + l._r.h + GAP) || leaves[0];
  const b = leaf._r;
  const nx = (x - b.x) / b.w, ny = (y - b.y) / b.h;
  const d = { left: nx, right: 1 - nx, top: ny, bottom: 1 - ny };
  const side = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a));
  const center = leaves.length > 1 && d[side] > 0.28;
  let where = center ? 'center' : side;
  // Full: an edge can only swap.
  if (where !== 'center' && leaves.length >= MAX_PANES && !(drag && drag.kind === 'tab' && leaf.tabId === drag.id)) where = 'center';
  return { leaf, where };
}
function showHighlight(t) {
  const b = t.leaf._r;
  let r = { x: b.x, y: b.y, w: b.w, h: b.h };
  if (t.where === 'left') r.w = b.w / 2;
  else if (t.where === 'right') { r.x = b.x + b.w / 2; r.w = b.w / 2; }
  else if (t.where === 'top') r.h = b.h / 2;
  else if (t.where === 'bottom') { r.y = b.y + b.h / 2; r.h = b.h / 2; }
  Object.assign(dzHl.style, { left: `${r.x + 4}px`, top: `${r.y + 4}px`, width: `${r.w - 8}px`, height: `${r.h - 8}px` });
}
dropEl.addEventListener('dragover', (e) => {
  if (!drag) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropEl.classList.add('over');
  showHighlight(dropTarget(e));
});
dropEl.addEventListener('dragleave', (e) => { if (e.target === dropEl) dropEl.classList.remove('over'); });
dropEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const d = drag;
  const t = d ? dropTarget(e) : null;
  endDock();
  if (d && t) dropOn(t.leaf, t.where, d);
});
// dragend never arrives when the dragged element was rebuilt meanwhile (a session
// dropped in the sidebar re-renders the list), so every other way a drag ends
// removes the overlay too: any drop, Esc, and any pointer movement with no button down.
document.addEventListener('dragend', endDock);
document.addEventListener('drop', () => setTimeout(endDock, 0), true);
document.addEventListener('pointermove', (e) => { if (drag && e.buttons === 0) endDock(); }, true);
document.addEventListener('pointerdown', () => { if (drag) endDock(); }, true);
document.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') endDock(); }, true);
window.addEventListener('blur', () => { if (drag) endDock(); });
for (const [sel, kind] of [['.files-btn', 'files'], ['.vnc-btn', 'vnc']]) {
  for (const b of document.querySelectorAll(sel)) {
    b.draggable = true;
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', kind);
      setTimeout(() => startDock({ kind }), 0); // after the browser has taken the drag image
    });
  }
}
// Clicking or typing in a terminal pane gives it the keyboard.
termsEl.addEventListener('focusin', (e) => {
  const t = e.target.closest && e.target.closest('.term');
  const id = t && t.dataset.id;
  if (id && id !== state.active && isShown(id)) activate(id);
});
mobile.addEventListener('change', () => { barKey = null; applyLayout(); fitActive(); });

// ------------------------------------------------------------------ long-term history
//
// The terminal keeps a limited scrollback; older lines live on the server
// (lib/history.js). This viewer shows all of it, fetching pages of lines as
// they scroll into view and drawing only the visible rows.

const HIST_PAGE = 200;
const HIST_MAX_PX = 15_000_000; // stay well below browsers' element height limits
const hist = {
  open: false, id: null, info: null, pages: new Map(), requested: new Map(), queue: [], stale: new Set(),
  rowH: 18, found: -1, searchSeq: 0, stick: true, poll: null, pendingJump: null,
};
const histEls = {
  root: $('#history'), scroll: $('#hist-scroll'), spacer: $('#hist-spacer'), rows: $('#hist-rows'),
  q: $('#hist-q'), status: $('#hist-status'), pill: $('#histpill'),
};

function paletteCss(n) {
  const ansi = [THEME.black, THEME.red, THEME.green, THEME.yellow, THEME.blue, THEME.magenta, THEME.cyan, THEME.white,
    THEME.brightBlack, THEME.brightRed, THEME.brightGreen, THEME.brightYellow, THEME.brightBlue, THEME.brightMagenta,
    THEME.brightCyan, THEME.brightWhite];
  if (n < 16) return ansi[n];
  if (n < 232) {
    const c = n - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(c / 36))},${level(Math.floor(c / 6) % 6)},${level(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// Records are "<flag><text with SGR sequences>" (see lib/terminals.js).
function renderRecord(record, el) {
  el.textContent = '';
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, under: false, inverse: false, hidden: false, strike: false, over: false };
  const put = (text) => {
    if (!text) return;
    const plain = st.fg === null && st.bg === null && !st.bold && !st.dim && !st.italic && !st.under
      && !st.inverse && !st.hidden && !st.strike && !st.over;
    if (plain) { el.appendChild(document.createTextNode(text)); return; }
    const span = document.createElement('span');
    span.textContent = text;
    let fg = st.fg;
    let bg = st.bg;
    if (st.inverse) { [fg, bg] = [bg || THEME.background, fg || THEME.foreground]; }
    if (fg) span.style.color = fg;
    if (bg) span.style.backgroundColor = bg;
    if (st.bold) span.style.fontWeight = 'bold';
    if (st.dim) span.style.opacity = '0.6';
    if (st.italic) span.style.fontStyle = 'italic';
    const deco = [st.under && 'underline', st.strike && 'line-through', st.over && 'overline'].filter(Boolean);
    if (deco.length) span.style.textDecoration = deco.join(' ');
    if (st.hidden) span.style.visibility = 'hidden';
    el.appendChild(span);
  };
  const sgr = (params) => {
    const p = params === '' ? [0] : params.split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (v === 0) Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, under: false, inverse: false, hidden: false, strike: false, over: false });
      else if (v === 1) st.bold = true;
      else if (v === 2) st.dim = true;
      else if (v === 3) st.italic = true;
      else if (v === 4) st.under = true;
      else if (v === 7) st.inverse = true;
      else if (v === 8) st.hidden = true;
      else if (v === 9) st.strike = true;
      else if (v === 53) st.over = true;
      else if (v >= 30 && v <= 37) st.fg = paletteCss(v - 30);
      else if (v >= 90 && v <= 97) st.fg = paletteCss(v - 90 + 8);
      else if (v >= 40 && v <= 47) st.bg = paletteCss(v - 40);
      else if (v >= 100 && v <= 107) st.bg = paletteCss(v - 100 + 8);
      else if (v === 39) st.fg = null;
      else if (v === 49) st.bg = null;
      else if (v === 38 || v === 48) {
        let color = null;
        if (p[i + 1] === 5) { color = paletteCss(p[i + 2] & 255); i += 2; }
        else if (p[i + 1] === 2) { color = `rgb(${p[i + 2] & 255},${p[i + 3] & 255},${p[i + 4] & 255})`; i += 4; }
        if (v === 38) st.fg = color; else st.bg = color;
      }
    }
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 1;
  for (let m = re.exec(record); m; m = re.exec(record)) {
    put(record.slice(last, m.index));
    sgr(m[1]);
    last = re.lastIndex;
  }
  put(record.slice(last));
  if (!el.firstChild) el.appendChild(document.createTextNode(' ')); // keep the row's height
}

function histGeometry() {
  const info = hist.info;
  const count = info ? Math.max(0, info.total - info.start) : 0;
  const viewH = histEls.scroll.clientHeight;
  const visible = Math.max(1, Math.ceil(viewH / hist.rowH));
  const exactH = count * hist.rowH;
  const height = Math.min(exactH, HIST_MAX_PX);
  const maxScroll = Math.max(0, height - viewH);
  // Beyond HIST_MAX_PX the scrollbar is proportional instead of exact.
  const maxFirst = Math.max(0, count - visible);
  return { count, viewH, visible, height, maxScroll, maxFirst, exact: exactH <= HIST_MAX_PX };
}

function histFirstLine(g) {
  const top = histEls.scroll.scrollTop;
  const rel = g.exact ? top / hist.rowH : (g.maxScroll ? (top / g.maxScroll) * g.maxFirst : 0);
  return { line: hist.info.start + Math.floor(rel), frac: g.exact ? top % hist.rowH : 0 };
}

function histScrollToLine(line, where = 'top') {
  const g = histGeometry();
  let rel = line - hist.info.start;
  if (where === 'center') rel -= Math.floor(g.visible / 2);
  if (where === 'bottom') rel -= Math.max(1, Math.floor(g.viewH / hist.rowH)) - 1; // last fully visible row
  rel = Math.max(0, Math.min(g.maxFirst, rel));
  histEls.spacer.style.height = `${g.height}px`; // before scrolling, or the browser clamps to the old height
  histEls.scroll.scrollTop = g.exact ? rel * hist.rowH : (g.maxFirst ? (rel / g.maxFirst) * g.maxScroll : 0);
  histRender();
}

function histRender() {
  if (!hist.open || !hist.info) return;
  const g = histGeometry();
  if (histEls.spacer.style.height !== `${g.height}px`) histEls.spacer.style.height = `${g.height}px`;
  const { line: first, frac } = histFirstLine(g);
  const last = Math.min(hist.info.total, first + g.visible + 1);
  histEls.rows.style.transform = `translateY(${histEls.scroll.scrollTop - frac}px)`;
  const rows = histEls.rows;
  while (rows.children.length < last - first) {
    const div = document.createElement('div');
    div.className = 'hrow';
    rows.appendChild(div);
  }
  while (rows.children.length > Math.max(0, last - first)) rows.lastChild.remove();
  const need = new Set();
  for (let n = first; n < last; n++) {
    const div = rows.children[n - first];
    const page = Math.floor(n / HIST_PAGE);
    const lines = hist.pages.get(page);
    const record = lines && lines[n - page * HIST_PAGE];
    const key = record === undefined ? `?${n}` : `${n}\u0000${record}`;
    if (div.dataset.key !== key) {
      div.dataset.key = key;
      if (record === undefined) {
        div.className = 'hrow loading';
        div.textContent = '…';
      } else {
        div.className = 'hrow';
        renderRecord(record, div);
      }
      div.dataset.line = String(n);
      div.dataset.wrapped = record && record[0] === 'w' ? '1' : '';
    }
    if (record === undefined || hist.stale.has(page)) need.add(page);
    div.classList.toggle('found', n === hist.found);
  }
  // Only pages in view are requested; scrolling past others drops them.
  const now = Date.now();
  hist.queue = [...need].filter((p) => !(hist.requested.get(p) && now - hist.requested.get(p) < 5000));
  histPump();
  const at = Math.min(hist.info.total, first + 1);
  histEls.status.textContent = hist.statusMsg
    || `Line ${(at - hist.info.start).toLocaleString()} of ${(hist.info.total - hist.info.start).toLocaleString()}`;
  // Keep a little cache around the view, drop the rest.
  if (hist.pages.size > 60) {
    const keep = Math.floor(first / HIST_PAGE);
    for (const p of hist.pages.keys()) if (Math.abs(p - keep) > 10) hist.pages.delete(p);
  }
}

// At most two page requests in flight: coloured pages can be large, and a
// slow link must not pile them up. A request without an answer in 5 s (lost
// in a reconnect) is retried.
const HIST_IN_FLIGHT = 2;
function histPump() {
  const now = Date.now();
  for (const [p, t] of hist.requested) if (now - t >= 5000) hist.requested.delete(p);
  while (hist.requested.size < HIST_IN_FLIGHT && hist.queue.length) {
    const page = hist.queue.shift();
    const arr = hist.pages.get(page) || [];
    let first = 0;
    if (hist.stale.has(page) && hist.info) {
      first = Math.max(0, Math.min(HIST_PAGE - 1, (hist.staleFrom ?? hist.info.archived) - page * HIST_PAGE));
    } else {
      while (first < HIST_PAGE && arr[first] !== undefined) first++;
      if (first >= HIST_PAGE) continue;
    }
    const from = page * HIST_PAGE + first;
    if (!send({ t: 'hist', id: hist.id, from, count: HIST_PAGE - first })) {
      hist.queue.unshift(page);
      return; // offline: try again after reconnecting
    }
    hist.requested.set(page, now);
  }
}

function histSetInfo(info) {
  // Old lines were dropped (history at its limit): keep the reader on the
  // same line rather than letting the view slide forward.
  const keepLine = hist.info && info.epoch === hist.info.epoch && info.start !== hist.info.start && !hist.stick
    ? histFirstLine(histGeometry()).line : null;
  histApplyInfo(info);
  if (keepLine !== null) histScrollToLine(Math.max(info.start, keepLine), 'top');
}

function histApplyInfo(info) {
  if (!hist.info || info.epoch !== hist.info.epoch) {
    // Line numbers moved (clear, resize): everything cached is stale.
    hist.pages.clear();
    hist.requested.clear();
    hist.queue = [];
    for (const r of histEls.rows.children) r.dataset.key = '';
    hist.stale.clear();
    hist.staleFrom = null;
  } else {
    // Lines at or after the archive boundary are the live screen and can still
    // change (clear, progress bars), and lines fetched while live may have been
    // archived in their final form since: mark those pages stale from the
    // lower of the old and new boundary. They keep showing until fresh copies
    // arrive, so nothing flickers.
    const boundary = Math.min(info.archived, hist.info.archived);
    hist.staleFrom = Math.min(hist.staleFrom ?? boundary, boundary);
    const firstLive = Math.floor(boundary / HIST_PAGE);
    for (const p of hist.pages.keys()) if (p >= firstLive) hist.stale.add(p);
  }
  hist.info = info;
}

function onHistLines(msg) {
  if (!hist.open || msg.id !== hist.id) return;
  if (hist.info && msg.info.epoch !== hist.info.epoch) {
    histSetInfo(msg.info);
    histRender();
    return;
  }
  const atBottom = histAtBottom();
  histSetInfo(msg.info);
  // File each line under its page (the server may have clipped the start).
  for (let k = 0; k < msg.lines.length; k++) {
    const abs = msg.from + k;
    const page = Math.floor(abs / HIST_PAGE);
    let arr = hist.pages.get(page);
    if (!arr) hist.pages.set(page, (arr = []));
    arr[abs - page * HIST_PAGE] = msg.lines[k];
  }
  hist.requested.delete(Math.floor(msg.from / HIST_PAGE));
  hist.stale.delete(Math.floor(msg.from / HIST_PAGE));
  if (!hist.stale.size) hist.staleFrom = null;
  histPump();
  if (atBottom && hist.stick) histScrollToLine(hist.info.total - 1, 'bottom');
  else histRender();
}

function histAtBottom() {
  const el = histEls.scroll;
  return el.scrollHeight - el.clientHeight - el.scrollTop < hist.rowH * 2;
}

function onHistInfo(msg) {
  if (msg.id === state.active && histEls.pill.dataset.waiting === '1') {
    histEls.pill.dataset.waiting = '';
    // Lines older than the terminal's own scrollback.
    const older = msg.info.memStart - msg.info.start;
    const v = state.views.get(state.active);
    if (older > 0 && v && v.term.buffer.active.viewportY === 0 && v.term.buffer.active.type === 'normal') {
      histEls.pill.textContent = `↑ ${older.toLocaleString()} older lines · Open history (Ctrl+Shift+H)`;
      histEls.pill.dataset.line = String(msg.info.memStart - 1);
      histEls.pill.hidden = false;
    }
  }
  if (!hist.open || msg.id !== hist.id) return;
  const atBottom = histAtBottom();
  const grew = !hist.info || msg.info.total !== hist.info.total;
  histSetInfo(msg.info);
  if (hist.pendingJump !== null) {
    const { line, where } = hist.pendingJump;
    hist.pendingJump = null;
    histScrollToLine(line, where);
    return;
  }
  if (atBottom && hist.stick && grew) histScrollToLine(hist.info.total - 1, 'bottom');
  else histRender();
}

function onHistFound(msg) {
  if (!hist.open || msg.id !== hist.id || msg.seq !== hist.searchSeq) return;
  if (msg.info) histSetInfo(msg.info);
  if (msg.line >= 0) {
    hist.found = msg.line;
    hist.statusMsg = hist.wrapped ? (hist.searchDir < 0 ? 'Wrapped to the newest line' : 'Wrapped to the oldest line') : '';
    hist.stick = false;
    histScrollToLine(msg.line, 'center');
  } else if (!hist.wrapped && hist.info) {
    // Nothing further in this direction: continue from the other end once.
    hist.wrapped = true;
    hist.searchSeq++;
    const from = hist.searchDir < 0 ? hist.info.total : hist.info.start - 1;
    send({ t: 'histSearch', id: hist.id, q: hist.searchQ, from: Math.max(-1, from), dir: hist.searchDir, seq: hist.searchSeq });
  } else {
    hist.statusMsg = 'No matches';
    histRender();
  }
}

function updateHistPill(id) {
  if (id !== state.active || hist.open) return;
  const v = state.views.get(id);
  const buf = v && v.term.buffer.active;
  if (buf && buf.type === 'normal' && buf.viewportY === 0 && buf.baseY > 0) {
    if (histEls.pill.hidden && histEls.pill.dataset.waiting !== '1') {
      histEls.pill.dataset.waiting = '1';
      send({ t: 'histInfo', id });
    }
  } else {
    hideHistPill();
  }
}

function hideHistPill() {
  histEls.pill.hidden = true;
  histEls.pill.dataset.waiting = '';
}

function histOpen(line = null, where = 'bottom') {
  const v = state.views.get(state.active);
  if (!v || !state.connected) return;
  hideHistPill();
  hist.open = true;
  hist.id = state.active;
  hist.info = null;
  hist.pages.clear();
  hist.requested.clear();
  hist.queue = [];
  hist.stale.clear();
  hist.staleFrom = null;
  hist.found = -1;
  hist.statusMsg = '';
  hist.stick = line === null;
  hist.pendingJump = line === null ? { line: Number.MAX_SAFE_INTEGER, where: 'bottom' } : { line, where };
  const cell = v.term._core && v.term._core._renderService && v.term._core._renderService.dimensions.css.cell;
  hist.rowH = (cell && cell.height) || Math.round(state.fontSize * 1.3);
  histEls.rows.style.fontSize = `${state.fontSize}px`;
  histEls.rows.style.lineHeight = `${hist.rowH}px`;
  histEls.rows.textContent = '';
  histEls.root.hidden = false;
  histEls.scroll.focus();
  send({ t: 'histInfo', id: hist.id });
  clearInterval(hist.poll);
  hist.poll = setInterval(() => { if (hist.open) send({ t: 'histInfo', id: hist.id }); }, 1000);
}

function histClose() {
  if (!hist.open) return;
  hist.open = false;
  clearInterval(hist.poll);
  histEls.root.hidden = true;
  histEls.rows.textContent = '';
  hist.pages.clear();
  focusActive();
}

function histSearch(dir) {
  const q = histEls.q.value.trim();
  if (!q || !hist.info) return;
  const g = histGeometry();
  const from = hist.found >= 0 ? hist.found
    : dir < 0 ? histFirstLine(g).line + g.visible : histFirstLine(g).line - 1;
  hist.searchSeq++;
  hist.searchQ = q;
  hist.searchDir = dir;
  hist.wrapped = false;
  hist.statusMsg = 'Searching…';
  histRender();
  send({ t: 'histSearch', id: hist.id, q, from: Math.max(0, from), dir, seq: hist.searchSeq });
}

histEls.scroll.addEventListener('scroll', () => {
  hist.stick = histAtBottom();
  requestAnimationFrame(histRender);
}, { passive: true });
new ResizeObserver(() => { if (hist.open) histRender(); }).observe(histEls.scroll);

histEls.pill.onclick = () => histOpen(Number(histEls.pill.dataset.line), 'bottom');
$('#hist-close').onclick = histClose;
$('#hist-bottom').onclick = () => {
  hist.stick = true;
  hist.found = -1;
  if (hist.info) histScrollToLine(hist.info.total - 1, 'bottom');
  histEls.scroll.focus();
};
histEls.q.addEventListener('input', () => { hist.found = -1; hist.statusMsg = ''; });
histEls.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); histSearch(e.shiftKey ? 1 : -1); }
  if (e.key === 'Escape') { e.preventDefault(); if (histEls.q.value) histEls.q.value = ''; else histClose(); }
});
histEls.root.addEventListener('keydown', (e) => {
  if (e.target === histEls.q) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape' || (mod && e.shiftKey && e.code === 'KeyH')) { e.preventDefault(); histClose(); return; }
  if (mod && e.code === 'KeyF') { e.preventDefault(); histEls.q.focus(); histEls.q.select(); return; }
  if (!hist.info) return;
  const g = histGeometry();
  const first = histFirstLine(g).line;
  const jump = { Home: [hist.info.start, 'top'], End: [hist.info.total - 1, 'bottom'],
    PageUp: [first - g.visible + 1, 'top'], PageDown: [first + g.visible - 1, 'top'] }[e.key];
  if (jump) {
    e.preventDefault();
    hist.stick = e.key === 'End';
    histScrollToLine(jump[0], jump[1]);
  }
});

// Copying across a wrapped line should give one line, as in the terminal.
histEls.rows.addEventListener('copy', (e) => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const rows = [...histEls.rows.children].filter((r) => sel.containsNode(r, true));
  const parts = sel.toString().split('\n');
  if (rows.length !== parts.length) return; // unexpected shape: let the browser copy as is
  let text = parts[0];
  for (let i = 1; i < parts.length; i++) text += (rows[i].dataset.wrapped === '1' ? '' : '\n') + parts[i];
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
});

// ------------------------------------------------------------------ phone key bar

function ctrlChar(ch) {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @ A-Z [ \ ] ^ _
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  return ch;
}

let ctrlTimer = 0;
function setCtrlSticky(on) {
  state.ctrlSticky = on;
  // A forgotten Ctrl would turn the next letter into a control key much later.
  clearTimeout(ctrlTimer);
  if (on) ctrlTimer = setTimeout(() => setCtrlSticky(false), 8000);
  const b = $('#keybar [data-key="ctrl"]');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}

const KEYS = {
  esc: () => '\x1b',
  tab: () => '\t',
  up: (app) => (app ? '\x1bOA' : '\x1b[A'),
  down: (app) => (app ? '\x1bOB' : '\x1b[B'),
  right: (app) => (app ? '\x1bOC' : '\x1b[C'),
  left: (app) => (app ? '\x1bOD' : '\x1b[D'),
};

for (const btn of $$('#keybar button')) {
  // pointerdown + preventDefault keeps focus (and the phone keyboard) on the terminal.
  btn.addEventListener('pointerdown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    const v = state.views.get(state.active);
    if (!v || !state.connected) return;
    if (key === 'ctrl') {
      setCtrlSticky(!state.ctrlSticky);
    } else if (KEYS[key]) {
      sendInput(state.active, KEYS[key](v.term.modes.applicationCursorKeysMode));
      setCtrlSticky(false);
    } else {
      sendInput(state.active, state.ctrlSticky ? ctrlChar(btn.dataset.key) : btn.dataset.key);
      setCtrlSticky(false);
    }
    v.term.focus();
  });
}

// ------------------------------------------------------------------ wiring

function setSidebar(open) {
  appEl.classList.toggle('collapsed', !open);
  $('#backdrop').hidden = !(open && mobile.matches);
  // On phones the drawer is transient; only remember the choice on desktop.
  if (!mobile.matches) storage('wt.collapsed', open ? '' : '1');
  requestAnimationFrame(() => {
    fitActive();
    if (open && mobile.matches) (tabsEl.querySelector('.tab.active') || $('#sidebar .new-tab')).focus();
    else focusActive();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen()) setSidebar(false);
});

for (const btn of $$('.new-tab')) {
  btn.onclick = () => {
    const names = new Set(sessions().map((g) => g.name));
    let n = sessions().length + 1;
    while (names.has(`Terminal ${n}`)) n++;
    send({ t: 'create', name: `Terminal ${n}`, from: state.active || undefined });
  };
}
$('#expand').onclick = () => setSidebar(true);
$('#collapse').onclick = () => setSidebar(false);
$('#backdrop').onclick = () => setSidebar(false);
$('#font-down').onclick = () => { setFontSize(state.fontSize - 1); focusActive(); };
$('#font-up').onclick = () => { setFontSize(state.fontSize + 1); focusActive(); };

$('#logout').onclick = async () => {
  state.leaving = true;
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
};

// Ctrl+W (delete word in bash) closes a browser tab; ask first. The shells
// keep running on the server either way.
window.addEventListener('beforeunload', (e) => {
  if (state.leaving || !state.tabs.length) return;
  e.preventDefault();
  e.returnValue = '';
});

// Sidebar width: drag its right edge (or focus the edge and use the arrow
// keys); double-click resets it. Remembered per browser. The terminal refits
// through the ResizeObserver below.
// On a phone the sidebar is a drawer over the terminal: wider by default (a
// session name needs room beside its buttons) and allowed almost full width.
const sidebarDefault = () => (mobile.matches ? Math.min(320, Math.round(window.innerWidth * 0.85)) : 272);
const SIDEBAR_MIN = 160;
const resizerEl = $('#sidebar-resizer');

function sidebarMax() {
  return Math.max(SIDEBAR_MIN, mobile.matches ? Math.round(window.innerWidth * 0.92) : Math.min(640, Math.round(window.innerWidth * 0.6)));
}

function setSidebarWidth(px, { save = false } = {}) {
  const w = Math.round(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, px)));
  appEl.style.setProperty('--sidebar-w', `${w}px`);
  resizerEl.setAttribute('aria-valuenow', String(w));
  if (save) storage('wt.sidebarWidth', w === sidebarDefault() ? '' : String(w));
  return w;
}

function sidebarWidth() {
  return $('#sidebar').getBoundingClientRect().width || sidebarDefault();
}

resizerEl.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
setSidebarWidth(Number(storage('wt.sidebarWidth')) || sidebarDefault());

resizerEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizerEl.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = sidebarWidth();
  document.body.classList.add('resizing');
  const move = (ev) => setSidebarWidth(startW + ev.clientX - startX);
  const end = (ev) => {
    resizerEl.removeEventListener('pointermove', move);
    resizerEl.removeEventListener('pointerup', end);
    resizerEl.removeEventListener('pointercancel', end);
    document.body.classList.remove('resizing');
    setSidebarWidth(startW + ev.clientX - startX, { save: true });
    focusActive();
  };
  resizerEl.addEventListener('pointermove', move);
  resizerEl.addEventListener('pointerup', end);
  resizerEl.addEventListener('pointercancel', end);
});
resizerEl.addEventListener('dblclick', () => {
  setSidebarWidth(sidebarDefault(), { save: true });
  focusActive();
});
resizerEl.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 64 : 16;
  if (e.key === 'ArrowLeft') setSidebarWidth(sidebarWidth() - step, { save: true });
  else if (e.key === 'ArrowRight') setSidebarWidth(sidebarWidth() + step, { save: true });
  else if (e.key === 'Home') setSidebarWidth(sidebarDefault(), { save: true });
  else if (e.key === 'Escape' || e.key === 'Enter') focusActive();
  else return;
  e.preventDefault();
});
// A narrower window may no longer fit the remembered width; clamp it (without
// forgetting the saved value, which applies again once the window is wider).
mobile.addEventListener('change', () => setSidebarWidth(Number(storage('wt.sidebarWidth')) || sidebarDefault()));
window.addEventListener('resize', () => {
  setSidebarWidth(Number(storage('wt.sidebarWidth')) || sidebarDefault());
});

setSidebar(!(storage('wt.collapsed') || mobile.matches));
mobile.addEventListener('change', () => setSidebar(!mobile.matches && !storage('wt.collapsed')));

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { applyLayout(); fitActive(); }, 50);
}).observe(termsEl);

// When several browsers share a terminal, the one in use sets its size.
window.addEventListener('focus', fitActive);
termsEl.addEventListener('pointerdown', () => reclaimSize(state.active));

setConnected(false);
$('#banner').hidden = true;
connect();

document.addEventListener('visibilitychange', () => { if (document.hidden && state.ctrlSticky) setCtrlSticky(false); });
