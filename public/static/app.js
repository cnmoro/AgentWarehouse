'use strict';
/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Unicode11Addon, clampRepeatCounts */

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
  tabs: [],             // [{ id, name, alive }] in sidebar order
  views: new Map(),     // id -> view (see createView)
  active: storage('wt.active'),
  pendingActivate: null,
  closedIndex: null,
  renaming: null,
  retry: 0,
  retryTimer: null,
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

function connect() {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.retry = 0;
    setConnected(true);
    startHeartbeat(ws);
    // The server forgot what this page was attached to. Hidden tabs re-attach
    // when next shown; the visible one re-attaches as soon as the list arrives.
    for (const [id, v] of state.views) {
      if (id === state.active) v.attached = false;
      else disposeView(id);
    }
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
      case 'hello':
        $('#who').textContent = msg.email;
        $('#who').title = msg.email;
        if (msg.scrollback > 0) state.scrollback = msg.scrollback;
        break;
      case 'list': onList(msg.tabs); break;
      case 'snap': onSnapshot(msg); break;
      case 'out': onOutput(msg.id, msg.d); break;
      case 'size': onSize(msg); break;
      case 'act': markActivity(msg.id); break;
      case 'created': activate(msg.id); break;
      case 'error': toast(msg.msg); break;
      case 'pong': state.lastPong = Date.now(); break;
    }
  };

  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.ws = null;
    setConnected(false);
    if (ev.code === 4001) { goToLogin(); return; }
    // A rejected handshake (session gone, e.g. after a server restart) looks like
    // a plain close; ask the server whether we are still signed in.
    fetch('/', { redirect: 'manual', cache: 'no-store' }).then((r) => {
      if (r.type === 'opaqueredirect' || r.redirected) goToLogin();
    }).catch(() => {});
    const delay = Math.min(8000, 500 * 2 ** state.retry++);
    state.retryTimer = setTimeout(connect, delay);
  };
}

// A network that dies silently (phone changing networks, laptop lid) leaves
// the socket "open" for minutes. Ping every 15 s; no answer in 10 s = dead.
function startHeartbeat(ws) {
  state.lastPong = Date.now();
  const timer = setInterval(() => {
    if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) { clearInterval(timer); return; }
    if (Date.now() - state.lastPong > 25_000) {
      clearInterval(timer);
      ws.close();
      ws.onclose({ code: 4000 }); // the close handshake itself may never finish
      return;
    }
    send({ t: 'ping' });
  }, 15_000);
}

// Reconnect right away instead of waiting out the backoff.
function reconnectNow() {
  if (!state.connected && state.retryTimer) connect();
}
window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = String(text || 'Something went wrong');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
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
    p.registerOscHandler(osc, (data) => data.split(';').includes('?'));
  }
}

function createView(id) {
  const el = document.createElement('div');
  el.className = 'term';
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
    rightClickSelectsWord: false,
    // OSC 8 hyperlinks from program output: only ever open http(s).
    linkHandler: { activate: (e, uri) => openLink(uri), allowNonHttpProtocols: false },
    disableStdin: !state.connected,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => openLink(uri)));
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  silenceQueries(term);
  clampRepeatCounts(term);
  term.open(el);

  term.attachCustomKeyEventHandler((e) => handleKey(term, e));
  term.onData((d) => {
    reclaimSize(id);
    if (state.ctrlSticky && d.length === 1) {
      d = ctrlChar(d);
      setCtrlSticky(false);
    }
    sendInput(id, d);
  });
  term.onBinary((d) => sendInput(id, d, 'bin'));

  addTouchScroll(el, term);

  const view = { id, term, fit, el, webgl: null, attached: false, seq: 0, ackPending: 0, ackTimer: null };
  state.views.set(id, view);
  return view;
}

// xterm 6 has no touch scrolling of its own. On the normal screen a swipe moves
// through the history; on the alternate screen (vim, less) it is left alone.
function addTouchScroll(el, term) {
  let lastY = null;
  let carry = 0;
  el.addEventListener('touchstart', (e) => {
    lastY = e.touches.length === 1 ? e.touches[0].clientY : null;
    carry = 0;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (lastY === null || e.touches.length !== 1 || term.buffer.active.type !== 'normal') return;
    const y = e.touches[0].clientY;
    const cell = el.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height
      || term.options.fontSize * 1.2;
    carry += (lastY - y) / cell;
    lastY = y;
    const lines = Math.trunc(carry);
    if (lines) {
      term.scrollLines(lines);
      carry -= lines;
    }
    e.preventDefault();
  }, { passive: false });
  el.addEventListener('touchend', () => { lastY = null; }, { passive: true });
}

function disposeView(id) {
  const v = state.views.get(id);
  if (!v) return;
  clearTimeout(v.ackTimer);
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
function setWebgl(view, on) {
  if (on && !view.webgl) {
    try {
      const addon = new WebglAddon.WebglAddon();
      addon.onContextLoss(() => { addon.dispose(); view.webgl = null; });
      view.term.loadAddon(addon);
      view.webgl = addon;
    } catch { /* falls back to the DOM renderer */ }
  } else if (!on && view.webgl) {
    view.webgl.dispose();
    view.webgl = null;
  }
}

function fitActive() {
  const v = state.views.get(state.active);
  if (!v || !v.el.classList.contains('visible')) return;
  try { v.fit.fit(); } catch { return; }
  send({ t: 'resize', id: state.active, cols: v.term.cols, rows: v.term.rows });
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
  if (id !== state.active) return;
  const v = state.views.get(id);
  const dims = v && v.fit.proposeDimensions();
  if (dims && (dims.cols !== v.term.cols || dims.rows !== v.term.rows)) fitActive();
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
  if (id === state.active) {
    showView(v);
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
  if (id !== state.active) markActivity(id);
}

// Another browser resized the terminal. Follow it so wrapping matches what the
// program draws; this browser takes the size back when it is used again.
function onSize({ id, cols, rows }) {
  const v = state.views.get(id);
  if (v && (v.term.cols !== cols || v.term.rows !== rows)) v.term.resize(cols, rows);
}

function markActivity(id) {
  if (id === state.active) return;
  const li = tabsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (li) li.classList.add('activity');
}

function activate(id) {
  if (!state.tabs.some((t) => t.id === id)) {
    state.pendingActivate = id;
    return;
  }
  const prev = state.views.get(state.active);
  if (prev && state.active !== id) {
    prev.el.classList.remove('visible');
    setWebgl(prev, false);
  }
  state.active = id;
  storage('wt.active', id);

  let v = state.views.get(id);
  if (!v) v = createView(id);
  if (!v.attached && send({ t: 'attach', id })) v.attached = true;
  showView(v);

  const tab = state.tabs.find((t) => t.id === id);
  document.title = tab ? `${tab.name} · Web Terminal` : 'Web Terminal';
  renderTabs();
  requestAnimationFrame(() => {
    fitActive();
    focusActive();
  });
  if (mobile.matches) setSidebar(false);
}

function onList(tabs) {
  const oldIndex = state.tabs.findIndex((t) => t.id === state.active);
  state.tabs = tabs;
  const ids = new Set(tabs.map((t) => t.id));
  // The tab being renamed was closed elsewhere: drop the input.
  if (state.renaming && !ids.has(state.renaming)) state.renaming = null;
  for (const id of [...state.views.keys()]) if (!ids.has(id)) disposeView(id);
  $('#empty').hidden = tabs.length > 0;

  if (state.pendingActivate && ids.has(state.pendingActivate)) {
    const id = state.pendingActivate;
    state.pendingActivate = null;
    activate(id);
  } else if (!ids.has(state.active)) {
    // The active tab went away: move to its neighbour, not back to the top.
    const idx = state.closedIndex ?? Math.max(0, oldIndex);
    state.closedIndex = null;
    if (tabs.length) activate(tabs[Math.min(idx, tabs.length - 1)].id);
    else { state.active = null; document.title = 'Web Terminal'; renderTabs(); }
  } else {
    const v = state.views.get(state.active);
    if (!v || !v.attached) activate(state.active);
    else {
      renderTabs();
      const tab = tabs.find((t) => t.id === state.active);
      if (tab) document.title = `${tab.name} · Web Terminal`;
    }
  }
  // Clicking a sidebar button that then disappeared leaves focus nowhere.
  if (document.activeElement === document.body) focusActive();
}

// ------------------------------------------------------------------ clipboard & keys

async function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
  }
  // Plain-http fallback (e.g. http://100.x.y.z): execCommand still works inside a key event.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  const prev = document.activeElement;
  ta.select();
  try { document.execCommand('copy'); } catch { /* nothing else to try */ }
  ta.remove();
  if (prev) prev.focus();
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
    copyText(term.getSelection());
    term.clearSelection();
    e.preventDefault();
    return false;
  }
  // Ctrl+V / Ctrl+Shift+V: let the browser fire a paste event, which xterm turns
  // into input (with bracketed-paste markers when the program asks for them).
  if (mod && !e.altKey && e.code === 'KeyV') return false;

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

// ------------------------------------------------------------------ sidebar

function renderTabs() {
  if (state.renaming) return; // don't clobber an input the user is typing in
  const activity = new Set([...tabsEl.querySelectorAll('.activity')].map((li) => li.dataset.id));
  const hadFocus = tabsEl.contains(document.activeElement) ? document.activeElement.closest('.tab')?.dataset.id : null;
  tabsEl.textContent = '';
  for (const t of state.tabs) {
    const active = t.id === state.active;
    const li = document.createElement('li');
    li.className = 'tab';
    li.dataset.id = t.id;
    li.draggable = true;
    li.tabIndex = active ? 0 : -1;
    li.setAttribute('role', 'tab');
    li.setAttribute('aria-selected', String(active));
    if (active) li.classList.add('active');
    else if (activity.has(t.id)) li.classList.add('activity');
    if (!t.alive) li.classList.add('dead');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    name.title = `${t.name}\nDouble-click to rename`;

    const actions = document.createElement('span');
    actions.className = 'actions';
    const ren = document.createElement('button');
    ren.textContent = '✎';
    ren.title = 'Rename (F2)';
    ren.tabIndex = -1;
    ren.setAttribute('aria-label', `Rename ${t.name}`);
    ren.onclick = (e) => { e.stopPropagation(); startRename(t.id); };
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    close.title = 'Close terminal (Delete)';
    close.tabIndex = -1;
    close.setAttribute('aria-label', `Close ${t.name}`);
    close.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
    actions.append(ren, close);

    li.append(dot, name, actions);
    li.onclick = () => activate(t.id);
    name.ondblclick = (e) => { e.stopPropagation(); startRename(t.id); };
    addDrag(li);
    tabsEl.appendChild(li);
    if (hadFocus === t.id) li.focus();
  }
  tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest' });
  const full = state.tabs.length >= MAX_TABS;
  for (const b of $$('.new-tab')) {
    b.disabled = full;
    b.title = full ? `Limit of ${MAX_TABS} terminals reached` : 'New terminal (opens in the current tab\'s folder)';
  }
}

function closeTab(id, returnFocus) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.alive && !confirm(`Close "${t.name}"? Its shell and any running programs will be killed.`)) {
    if (returnFocus) returnFocus.focus();
    else focusActive();
    return;
  }
  if (id === state.active) state.closedIndex = state.tabs.indexOf(t);
  send({ t: 'close', id });
  focusActive();
}

// Keyboard use of the tab list: arrows move, Enter opens, F2 renames, Delete closes.
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
    activate(li.dataset.id);
  } else if (e.key === 'F2') {
    startRename(li.dataset.id);
  } else if (e.key === 'Delete') {
    closeTab(li.dataset.id, li);
  } else if (e.key === 'Escape') {
    focusActive();
  } else {
    return;
  }
  e.preventDefault();
});

function startRename(id) {
  const li = tabsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const tab = state.tabs.find((t) => t.id === id);
  if (!li || !tab || state.renaming) return;
  state.renaming = id;
  li.draggable = false; // otherwise mouse selection inside the input starts a drag
  const nameEl = li.querySelector('.name');
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = tab.name;
  input.maxLength = 60;
  input.setAttribute('aria-label', 'Terminal name');
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== tab.name) {
      tab.name = name;
      send({ t: 'rename', id, name });
    }
    // Swap the input back in place. Rebuilding the list here would eat a click
    // on another tab that caused this blur.
    nameEl.textContent = tab.name;
    nameEl.title = `${tab.name}\nDouble-click to rename`;
    input.replaceWith(nameEl);
    li.draggable = true;
    state.renaming = null;
    if (id === state.active) document.title = `${tab.name} · Web Terminal`;
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
}

let dragId = null;
function clearDropMarks() {
  tabsEl.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
}
function dropPosition(li, e) {
  const r = li.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}
function moveTab(targetId, where) {
  const ids = state.tabs.map((t) => t.id).filter((id) => id !== dragId);
  let idx = targetId ? ids.indexOf(targetId) + (where === 'after' ? 1 : 0) : ids.length;
  ids.splice(idx, 0, dragId);
  state.tabs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  renderTabs();
  send({ t: 'reorder', ids });
}
function addDrag(li) {
  li.addEventListener('dragstart', (e) => {
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    li.classList.remove('dragging');
    clearDropMarks();
  });
  li.addEventListener('dragover', (e) => {
    if (!dragId || dragId === li.dataset.id) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    li.classList.add(dropPosition(li, e) === 'before' ? 'drop-before' : 'drop-after');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId || dragId === li.dataset.id) return;
    moveTab(li.dataset.id, dropPosition(li, e));
  });
}
// Dropping on the empty space below the last tab moves it to the end.
tabsEl.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
tabsEl.addEventListener('drop', (e) => {
  e.preventDefault();
  if (dragId) moveTab(null, 'end');
});

// ------------------------------------------------------------------ phone key bar

function ctrlChar(ch) {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @ A-Z [ \ ] ^ _
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  return ch;
}

function setCtrlSticky(on) {
  state.ctrlSticky = on;
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
    const names = new Set(state.tabs.map((t) => t.name));
    let n = state.tabs.length + 1;
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

setSidebar(!(storage('wt.collapsed') || mobile.matches));
mobile.addEventListener('change', () => setSidebar(!mobile.matches && !storage('wt.collapsed')));

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitActive, 50);
}).observe(termsEl);

// When several browsers share a terminal, the one in use sets its size.
window.addEventListener('focus', fitActive);
termsEl.addEventListener('pointerdown', () => reclaimSize(state.active));

setConnected(false);
$('#banner').hidden = true;
connect();
