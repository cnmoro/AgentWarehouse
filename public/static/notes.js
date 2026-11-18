'use strict';
// Notes: a plain-text pad that floats over the terminals (button at the bottom
// right, next to the microphone). Write or paste a long prompt there with the
// browser's own text editing (selection, Shift+arrows, copy and paste, undo),
// then send all of it to the terminal that has the keyboard, followed by
// Enter. The text, whether the pad is open or rolled up, and its size are kept
// in this browser (localStorage), so they survive a reload or a server restart.
//
// Sending: when the program in the terminal has asked for bracketed paste (bash,
// zsh, Claude Code, Codex and most editors do), the text goes as one paste, so
// its line breaks stay line breaks and do not submit it line by line; Enter
// follows a moment later, once the program has taken the paste in. Otherwise
// it is typed as is, and each line break acts as Enter.
/* global state, $, sendInput, toast, storage, sessionLabel, focusActive, mobile */
(() => {
  const KEY_TEXT = 'wt.notes.text';
  const KEY_MODE = 'wt.notes.mode'; // '' closed, 'open', 'rolled'
  const KEY_SIZE = 'wt.notes.size'; // {"w":460,"h":220}
  const MIN_W = 280, MIN_H = 72, DEF_W = 460, DEF_H = 220;
  const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const sendKeys = isMac ? '⌘ Enter' : 'Ctrl+Enter';

  const ICON_NOTE = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M8.5 12.5h7M8.5 16h5"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2.6 2.8a.8.8 0 0 1 1-.3l14 6.8a.8.8 0 0 1 0 1.4l-14 6.8a.8.8 0 0 1-1.1-.9L4 10.6h6.3V9.4H4L2.5 3.6a.8.8 0 0 1 .1-.8z"/></svg>';

  let mode = ['open', 'rolled'].includes(storage(KEY_MODE)) ? storage(KEY_MODE) : '';
  let size = readSize();
  let saveTimer = 0;
  let onScreen = false;
  const el = {};

  function readSize() {
    try {
      const s = JSON.parse(storage(KEY_SIZE) || 'null');
      if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) return { w: s.w, h: s.h };
    } catch { /* default */ }
    return { w: DEF_W, h: DEF_H };
  }

  // ---------------------------------------------------------------- build

  function build() {
    const main = $('#main');

    el.btn = document.createElement('button');
    el.btn.id = 'notes-btn';
    el.btn.type = 'button';
    el.btn.innerHTML = ICON_NOTE;
    el.btn.setAttribute('aria-controls', 'notes');
    el.btn.addEventListener('click', onButton);

    el.panel = document.createElement('section');
    el.panel.id = 'notes';
    el.panel.className = 'notes';
    el.panel.setAttribute('role', 'dialog');
    el.panel.setAttribute('aria-modal', 'false');
    el.panel.setAttribute('aria-labelledby', 'notes-title');
    el.panel.innerHTML = `
      <div class="notes-grip" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
      <div class="notes-head">
        <span class="notes-title" id="notes-title">Notes</span>
        <span class="notes-target"></span>
        <button type="button" class="notes-icon notes-close" title="Close (the text is kept)" aria-label="Close notes">✕</button>
      </div>
      <textarea class="notes-text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Notes text"></textarea>
      <div class="notes-foot">
        <span class="notes-count" aria-live="polite"></span>
        <button type="button" class="notes-roll"></button>
        <button type="button" class="notes-send">${ICON_SEND}<span>Send</span></button>
      </div>`;
    el.grip = el.panel.querySelector('.notes-grip');
    el.target = el.panel.querySelector('.notes-target');
    el.text = el.panel.querySelector('.notes-text');
    el.count = el.panel.querySelector('.notes-count');
    el.roll = el.panel.querySelector('.notes-roll');
    el.send = el.panel.querySelector('.notes-send');
    el.panel.querySelector('.notes-close').addEventListener('click', () => setMode('', { focusTerminal: true }));
    el.roll.addEventListener('click', () => setMode(mode === 'rolled' ? 'open' : 'rolled', { focusText: mode === 'rolled' }));
    el.send.addEventListener('click', submit);
    el.text.placeholder = `Write or paste here. ${sendKeys} sends it to the terminal and presses Enter.`;
    el.text.value = storage(KEY_TEXT) || '';

    el.text.addEventListener('input', () => { scheduleSave(); updateFoot(); });
    el.text.addEventListener('blur', flushSave);
    el.text.addEventListener('keydown', onKey);
    el.panel.addEventListener('pointerenter', updateTarget);
    el.panel.addEventListener('focusin', updateTarget);
    setupResize();

    main.append(el.panel, el.btn);
    applySize();
    render();
  }

  // ---------------------------------------------------------------- state

  function setMode(m, { focusText = false, focusTerminal = false } = {}) {
    mode = m;
    storage(KEY_MODE, m);
    render();
    if (m === 'open' && focusText) requestAnimationFrame(() => el.text.focus());
    else if (focusTerminal && !mobile.matches) focusActive();
  }

  function onButton() {
    if (mode === 'open') setMode('', { focusTerminal: true });
    else setMode('open', { focusText: true });
  }

  // Shown while terminals are on screen; Files, the Desktop or SSH taking the
  // whole page (not as a pane) hides the button and the pad, and they come back
  // as they were.
  function terminalsOnScreen() {
    if (!state.active || !state.tabs.some((t) => t.id === state.active)) return false;
    const empty = $('#empty');
    if (empty && !empty.hidden) return false;
    return !['#files', '#vnc', '#ssh'].some((sel) => {
      const p = $(sel);
      return p && !p.hidden && !p.classList.contains('docked');
    });
  }

  function render() {
    onScreen = terminalsOnScreen();
    el.btn.hidden = !onScreen;
    el.panel.hidden = !onScreen || !mode;
    el.panel.classList.toggle('rolled', mode === 'rolled');
    el.btn.classList.toggle('on', !!mode);
    el.btn.setAttribute('aria-expanded', String(mode === 'open'));
    el.btn.title = mode === 'open' ? 'Close notes' : 'Notes: write a prompt and send it to the terminal';
    el.btn.setAttribute('aria-label', el.btn.title);
    el.roll.textContent = mode === 'rolled' ? 'Expand' : 'Roll up';
    el.roll.title = mode === 'rolled' ? 'Show the text' : 'Fold the pad down to this bar (the text is kept)';
    el.roll.setAttribute('aria-expanded', String(mode !== 'rolled'));
    updateTarget();
    updateFoot();
  }

  function updateTarget() {
    if (!el.target) return;
    const name = state.active ? sessionLabel(state.active) : '';
    el.target.textContent = name ? `→ ${name}` : '';
    el.target.title = name ? `Sends to: ${name} (the terminal that has the keyboard)` : '';
    updateFoot();
  }

  function updateFoot() {
    const v = el.text.value;
    const lines = v ? v.split('\n').length : 0;
    el.count.textContent = v ? `${lines} ${lines === 1 ? 'line' : 'lines'} · ${v.length.toLocaleString()} ${v.length === 1 ? 'char' : 'chars'}` : 'Empty';
    el.btn.classList.toggle('has-text', !!v.trim());
    const target = state.active && state.tabs.find((t) => t.id === state.active);
    const ready = !!v.trim() && !!target && state.connected;
    el.send.disabled = !ready;
    el.send.title = !v.trim() ? 'Nothing to send'
      : !target ? 'No terminal on screen'
        : !state.connected ? 'Not connected'
          : `Send all of it to ${sessionLabel(target.id)} and press Enter (${sendKeys})`;
  }

  // ---------------------------------------------------------------- saving

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    storage(KEY_TEXT, el.text.value);
  }
  window.addEventListener('pagehide', flushSave);
  // Another tab of this browser changed the notes: take its text unless this one is being typed in.
  window.addEventListener('storage', (e) => {
    if (!el.text) return;
    if (e.key === KEY_TEXT && document.activeElement !== el.text) { el.text.value = e.newValue || ''; updateFoot(); }
  });

  // ---------------------------------------------------------------- keys

  function onKey(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      setMode('rolled', { focusTerminal: true });
    }
    // Everything else is the browser's own editing; keep it away from the page's shortcuts.
    e.stopPropagation();
  }

  // ---------------------------------------------------------------- sending

  // Control characters other than line breaks and tabs could act as keys in the
  // terminal (an Escape could end the paste early), so they are dropped.
  function clean(text) {
    return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\s+$/, '');
  }

  function submit() {
    const id = state.active;
    const tab = id && state.tabs.find((t) => t.id === id);
    if (!tab) { toast('Open a terminal first.'); return; }
    if (!state.connected) { toast('Not connected. Send again once the connection is back.'); return; }
    if (tab.alive === false) { toast('That terminal has ended.'); return; }
    let text = clean(el.text.value);
    if (!text) { toast('Nothing to send.', 2500); el.text.focus(); return; }

    const v = state.views.get(id);
    const bracketed = !!(v && v.term && v.term.modes && v.term.modes.bracketedPasteMode);
    if (!bracketed) text = text.replace(/\t/g, '    '); // a Tab would ask the shell to complete
    const body = text.replace(/\n/g, '\r');
    sendInput(id, bracketed ? PASTE_START + body + PASTE_END : body);
    // Enter on its own, a moment later: programs that take a paste in (Claude
    // Code, Codex) would treat an Enter arriving with it as part of the text.
    const wait = bracketed ? Math.min(900, 120 + Math.round(text.length / 40)) : 30;
    setTimeout(() => { if (state.connected) sendInput(id, '\r'); }, wait);

    // Cleared the way typing would clear it, so Ctrl+Z in the pad brings it back.
    clearUndoably();
    toast(`Sent to ${sessionLabel(id)}.`, 1800);
    if (mobile.matches) el.text.blur();
    else focusActive();
  }

  function clearUndoably() {
    el.text.focus();
    el.text.select();
    let done = false;
    try { done = document.execCommand('delete'); } catch { /* not supported */ }
    if (!done || el.text.value) el.text.value = '';
    flushSave();
    updateFoot();
  }

  // ---------------------------------------------------------------- size

  function maxSize() {
    const main = $('#main');
    const r = main.getBoundingClientRect();
    const chrome = el.panel ? el.panel.offsetHeight - el.text.offsetHeight : 90;
    return { w: Math.max(MIN_W, r.width - 44), h: Math.max(MIN_H, r.height - 82 - 20 - chrome) };
  }

  function applySize() {
    if (!el.panel) return;
    el.panel.style.setProperty('--notes-w', `${Math.round(size.w)}px`);
    el.panel.style.setProperty('--notes-h', `${Math.round(size.h)}px`);
  }

  // The pad grows up and to the left from its corner by the buttons, so the grip is at its top left.
  function setupResize() {
    el.grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.grip.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: el.panel.offsetWidth, h: el.text.offsetHeight };
      const lim = maxSize();
      document.body.classList.add('resizing');
      const move = (ev) => {
        size = {
          w: Math.min(lim.w, Math.max(MIN_W, start.w - (ev.clientX - start.x))),
          h: Math.min(lim.h, Math.max(MIN_H, start.h - (ev.clientY - start.y))),
        };
        applySize();
      };
      const end = () => {
        el.grip.removeEventListener('pointermove', move);
        el.grip.removeEventListener('pointerup', end);
        el.grip.removeEventListener('pointercancel', end);
        document.body.classList.remove('resizing');
        storage(KEY_SIZE, JSON.stringify({ w: Math.round(size.w), h: Math.round(size.h) }));
      };
      el.grip.addEventListener('pointermove', move);
      el.grip.addEventListener('pointerup', end);
      el.grip.addEventListener('pointercancel', end);
    });
    el.grip.addEventListener('dblclick', () => {
      size = { w: DEF_W, h: DEF_H };
      applySize();
      storage(KEY_SIZE, '');
    });
  }

  // ---------------------------------------------------------------- wiring

  // Text from elsewhere (dictation, stt.js) typed into the pad at its cursor,
  // the way typing would put it there, so Ctrl+Z takes it out again.
  function insert(text) {
    const t = el.text;
    const start = t.selectionStart, end = t.selectionEnd;
    const before = t.value.slice(0, start);
    const after = t.value.slice(end);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    t.focus();
    t.setSelectionRange(start, end);
    let done = false;
    try { done = document.execCommand('insertText', false, lead + text + trail); } catch { /* not supported */ }
    if (!done) {
      t.setRangeText(lead + text + trail, start, end, 'end');
      scheduleSave();
    }
    flushSave();
    updateFoot();
  }

  // For stt.js: dictation goes into the pad while it is open (not rolled up) and on screen.
  window.Notes = { isOpen: () => mode === 'open' && onScreen && !el.panel.hidden, insert };

  build();
  // What is on screen changed (app.js), or one of the full-page views opened or closed.
  document.addEventListener('wt:view', render);
  const watch = new MutationObserver(render);
  for (const sel of ['#empty', '#files', '#vnc', '#ssh']) {
    const n = $(sel);
    if (n) watch.observe(n, { attributes: true, attributeFilter: ['hidden', 'class'] });
  }
})();
