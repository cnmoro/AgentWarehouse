'use strict';
/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Unicode11Addon */

const $ = (sel) => document.querySelector(sel);
const tabsEl = $('#tabs');
const termsEl = $('#terms');
const appEl = $('#app');

const state = {
  ws: null,
  tabs: [],             // [{ id, name, alive }] in sidebar order
  views: new Map(),     // id -> { term, fit, el, webgl }
  active: localStorage.getItem('wt.active'),
  pendingActivate: null,
  renaming: null,
  retry: 0,
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
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.retry = 0;
    $('#conn').classList.add('up');
    $('#conn').title = 'Connected';
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
      case 'hello': $('#who').textContent = msg.email; $('#who').title = msg.email; break;
      case 'list': onList(msg.tabs); break;
      case 'snap': onSnapshot(msg); break;
      case 'out': onOutput(msg.id, msg.d); break;
      case 'created': activate(msg.id); break;
    }
  };

  ws.onclose = (ev) => {
    $('#conn').classList.remove('up');
    $('#conn').title = 'Disconnected — reconnecting…';
    if (ev.code === 4001) { location.replace('/login'); return; }
    // The handshake is rejected with 401 when the session is gone; check before retrying.
    fetch('/', { redirect: 'manual' }).then((r) => {
      if (r.type === 'opaqueredirect' || r.redirected) location.replace('/login');
    }).catch(() => {});
    const delay = Math.min(10000, 500 * 2 ** state.retry++);
    setTimeout(connect, delay);
  };
}

// ------------------------------------------------------------------ terminals

function createView(id) {
  const el = document.createElement('div');
  el.className = 'term';
  termsEl.appendChild(el);

  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize: Number(localStorage.getItem('wt.fontSize')) || 14,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: THEME,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(el);

  term.attachCustomKeyEventHandler((e) => handleKey(term, e));
  term.onData((d) => send({ t: 'in', id, d }));
  term.onBinary((d) => send({ t: 'in', id, d }));

  const view = { term, fit, el, webgl: null };
  state.views.set(id, view);
  return view;
}

function disposeView(id) {
  const v = state.views.get(id);
  if (!v) return;
  v.term.dispose();
  v.el.remove();
  state.views.delete(id);
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
  if (!v) return;
  try { v.fit.fit(); } catch { return; }
  send({ t: 'resize', id: state.active, cols: v.term.cols, rows: v.term.rows });
}

function onSnapshot({ id, d, cols, rows }) {
  const v = state.views.get(id) || createView(id);
  v.term.reset();
  v.term.resize(cols, rows);
  v.term.write(d, () => {
    if (id === state.active) {
      fitActive();
      v.term.scrollToBottom();
    }
  });
}

function onOutput(id, d) {
  const v = state.views.get(id);
  if (!v) return;
  v.term.write(d);
  if (id !== state.active) {
    const li = tabsEl.querySelector(`[data-id="${id}"]`);
    if (li) li.classList.add('activity');
  }
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
  localStorage.setItem('wt.active', id);
  const v = state.views.get(id) || createView(id);
  v.el.classList.add('visible');
  setWebgl(v, true);
  const tab = state.tabs.find((t) => t.id === id);
  document.title = tab ? `${tab.name} · Web Terminal` : 'Web Terminal';
  renderTabs();
  requestAnimationFrame(() => {
    fitActive();
    if (!state.renaming) v.term.focus();
  });
  if (window.matchMedia('(max-width: 700px)').matches) appEl.classList.add('collapsed');
}

function onList(tabs) {
  state.tabs = tabs;
  const ids = new Set(tabs.map((t) => t.id));
  for (const id of [...state.views.keys()]) if (!ids.has(id)) disposeView(id);
  for (const t of tabs) if (!state.views.has(t.id)) createView(t.id);

  $('#empty').hidden = tabs.length > 0;
  if (state.pendingActivate && ids.has(state.pendingActivate)) {
    const id = state.pendingActivate;
    state.pendingActivate = null;
    activate(id);
  } else if (!ids.has(state.active)) {
    if (tabs.length) activate(tabs[0].id);
    else { state.active = null; renderTabs(); }
  } else if (!state.views.get(state.active).el.classList.contains('visible')) {
    activate(state.active);
  } else {
    renderTabs();
    const tab = tabs.find((t) => t.id === state.active);
    if (tab) document.title = `${tab.name} · Web Terminal`;
  }
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

// Return false to stop xterm from handling the key.
function handleKey(term, e) {
  if (e.type !== 'keydown') return true;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  // Ctrl+C copies when text is selected; otherwise it goes to the shell as SIGINT.
  if (mod && !e.altKey && key === 'c' && (e.shiftKey || term.hasSelection())) {
    copyText(term.getSelection());
    term.clearSelection();
    e.preventDefault();
    return false;
  }
  // Ctrl+V / Ctrl+Shift+V: let the browser fire a paste event, which xterm turns
  // into input (with bracketed-paste markers when the program asks for them).
  if (mod && !e.altKey && key === 'v') return false;

  // Ctrl + / Ctrl - / Ctrl 0: font size.
  if (e.ctrlKey && (key === '=' || key === '+' || key === '-' || key === '0')) {
    const size = key === '0' ? 14 : Math.max(8, Math.min(32, term.options.fontSize + (key === '-' ? -1 : 1)));
    localStorage.setItem('wt.fontSize', size);
    for (const v of state.views.values()) v.term.options.fontSize = size;
    fitActive();
    e.preventDefault();
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ sidebar

function renderTabs() {
  if (state.renaming) return; // don't clobber an input the user is typing in
  const activity = new Set([...tabsEl.querySelectorAll('.activity')].map((li) => li.dataset.id));
  tabsEl.textContent = '';
  for (const t of state.tabs) {
    const li = document.createElement('li');
    li.className = 'tab';
    li.dataset.id = t.id;
    li.draggable = true;
    li.setAttribute('role', 'tab');
    if (t.id === state.active) li.classList.add('active');
    else if (activity.has(t.id)) li.classList.add('activity');
    if (!t.alive) li.classList.add('dead');

    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    name.title = `${t.name}\nDouble-click to rename`;

    const actions = document.createElement('span');
    actions.className = 'actions';
    const ren = document.createElement('button');
    ren.textContent = '✎';
    ren.title = 'Rename';
    ren.onclick = (e) => { e.stopPropagation(); startRename(t.id); };
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    close.title = 'Close terminal';
    close.onclick = (e) => {
      e.stopPropagation();
      if (!t.alive || confirm(`Close "${t.name}"? Its shell and any running programs will be killed.`)) {
        send({ t: 'close', id: t.id });
      }
    };
    actions.append(ren, close);

    li.append(dot, name, actions);
    li.onclick = () => activate(t.id);
    name.ondblclick = (e) => { e.stopPropagation(); startRename(t.id); };
    addDrag(li);
    tabsEl.appendChild(li);
  }
}

function startRename(id) {
  const li = tabsEl.querySelector(`[data-id="${id}"]`);
  const tab = state.tabs.find((t) => t.id === id);
  if (!li || !tab) return;
  state.renaming = id;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = tab.name;
  input.maxLength = 60;
  li.querySelector('.name').replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    state.renaming = null;
    const name = input.value.trim();
    if (save && name && name !== tab.name) {
      tab.name = name;
      send({ t: 'rename', id, name });
    }
    renderTabs();
    const v = state.views.get(state.active);
    if (v) v.term.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

let dragId = null;
function addDrag(li) {
  li.addEventListener('dragstart', (e) => {
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    li.classList.remove('dragging');
    tabsEl.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
  });
  li.addEventListener('dragover', (e) => {
    if (!dragId || dragId === li.dataset.id) return;
    e.preventDefault();
    tabsEl.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    li.classList.add('drop-before');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragId || dragId === li.dataset.id) return;
    const ids = state.tabs.map((t) => t.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(li.dataset.id), 0, dragId);
    state.tabs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    renderTabs();
    send({ t: 'reorder', ids });
  });
}

// ------------------------------------------------------------------ wiring

$('#new-tab').onclick = () => {
  const n = state.tabs.length + 1;
  send({ t: 'create', name: `Terminal ${n}`, from: state.active || undefined });
};

$('#logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
};

$('#toggle-sidebar').onclick = () => {
  appEl.classList.toggle('collapsed');
  localStorage.setItem('wt.collapsed', appEl.classList.contains('collapsed') ? '1' : '');
  requestAnimationFrame(fitActive);
};
if (localStorage.getItem('wt.collapsed') || window.matchMedia('(max-width: 700px)').matches) {
  appEl.classList.add('collapsed');
}

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitActive, 50);
}).observe(termsEl);

// When several browsers share a terminal, the one in use sets its size.
window.addEventListener('focus', fitActive);

connect();
