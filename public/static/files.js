'use strict';
// File browser: a panel over the terminal area, opened from the folder button
// in the sidebar (or Ctrl+Shift+F, Cmd+Shift+F on a Mac). Talks to
// /api/files (lib/files.js). Uses app.js's globals: $, state, send, toast,
// copyText, focusActive, isMac, storage, mobile, setSidebar, hasSessions, sessionOf.

const Files = (() => {
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
  const enc = encodeURIComponent;

  const fb = {
    available: false, built: false, open: false,
    path: null, listing: null, shown: [], sel: new Set(), anchor: null, cursor: null,
    history: [], hpos: -1, filter: '',
    sort: JSON.parse(storage('wt.fbSort') || '{"key":"name","dir":1}'),
    showHidden: storage('wt.fbHidden') === '1',
    pins: [], pinsLoaded: false, info: null,
    previewToken: 0, previewPath: null, wrap: storage('wt.fbWrap') === '1',
    upload: null, typeahead: '', typeaheadAt: 0, loading: 0,
    clip: null,  // { op: 'copy' | 'cut', paths } the files copied or cut inside the browser
    drag: null,  // { dir, names } while rows are being dragged
  };
  const el = {};

  // ---------------------------------------------------------------- helpers

  async function api(method, url, body) {
    const res = await fetch('/api/files' + url, {
      method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      if (res.status === 401) location.replace('/login');
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
  const baseName = (p) => (p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1));
  const parentOf = (p) => (p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/');
  const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
  const isHidden = (name) => name.startsWith('.');
  const tilde = (p) => {
    const home = fb.info && fb.info.home;
    if (!home) return p;
    return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
  };

  function fmtSize(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const s = (Date.now() - ms) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ms >= today.getTime()) return `today ${time}`;
    if (ms >= today.getTime() - 86400000) return `yesterday ${time}`;
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // What the browser can play (the server serves these inline, see lib/files.js).
  const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba']);
  const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']);
  function mediaKind(e) {
    const x = extOf(e.name);
    return AUDIO_EXT.has(x) ? 'audio' : VIDEO_EXT.has(x) ? 'video' : null;
  }

  function kindOf(e) {
    if (e.type === 'dir') return 'dir';
    if (e.type === 'broken') return 'broken';
    const x = extOf(e.name);
    if (IMAGE_EXT.has(x)) return 'image';
    if (['zip', 'gz', 'tgz', 'tar', 'xz', 'bz2', '7z', 'rar', 'zst', 'deb', 'rpm', 'whl', 'jar'].includes(x)) return 'archive';
    if (x === 'pdf') return 'pdf';
    if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php',
      'sh', 'bash', 'zsh', 'fish', 'lua', 'swift', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'json', 'jsonl', 'yaml',
      'yml', 'toml', 'ini', 'xml', 'proto', 'tf', 'dockerfile', 'makefile', 'r', 'ipynb'].includes(x)) return 'code';
    if (['md', 'txt', 'log', 'csv', 'tsv', 'rst', 'env', 'conf', 'cfg', 'lock'].includes(x) || !x) return 'text';
    if (mediaKind(e)) return 'media';
    if (['avi', 'wma', 'wmv', 'flv', 'mpg', 'mpeg'].includes(x)) return 'media';
    return 'file';
  }

  // Small inline icons (no icon font): a folder, or a page tinted by kind.
  function icon(e) {
    const k = kindOf(e);
    const span = document.createElement('span');
    span.className = `ficon k-${k}${e.link ? ' link' : ''}`;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = k === 'dir'
      ? '<svg viewBox="0 0 20 20"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4l1.6 1.8h7.4A1.5 1.5 0 0 1 18 7.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5z"/></svg>'
      : '<svg viewBox="0 0 20 20"><path d="M5 2.5h6.6L16 6.9v10.6H5z"/><path class="fold" d="M11.5 2.5v4.5H16"/></svg>';
    return span;
  }

  function setLoading(on) {
    fb.loading += on ? 1 : -1;
    if (el.root) el.root.classList.toggle('loading', fb.loading > 0);
  }

  // ---------------------------------------------------------------- dialogs

  // A small modal: a message, maybe a text field, and buttons. Resolves to
  // { button, value } (button null when dismissed).
  function dialog({ title, message, list, input, select, buttons }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      const box = document.createElement('div');
      box.className = 'modal';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const h = document.createElement('h3');
      h.textContent = title;
      box.append(h);
      if (message) {
        const p = document.createElement('p');
        p.textContent = message;
        box.append(p);
      }
      if (list && list.length) {
        const ul = document.createElement('ul');
        ul.className = 'modal-list';
        for (const item of list.slice(0, 8)) {
          const li = document.createElement('li');
          li.textContent = item;
          ul.append(li);
        }
        if (list.length > 8) {
          const li = document.createElement('li');
          li.className = 'more';
          li.textContent = `and ${list.length - 8} more`;
          ul.append(li);
        }
        box.append(ul);
      }
      let field = null;
      if (input !== undefined) {
        field = document.createElement('input');
        field.type = 'text';
        field.value = input;
        field.spellcheck = false;
        field.autocomplete = 'off';
        box.append(field);
      }
      const row = document.createElement('div');
      row.className = 'modal-buttons';
      const done = (button) => {
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve({ button, value: field ? field.value.trim() : null });
      };
      let primary = null;
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        btn.className = b.primary ? 'primary' : b.danger ? 'danger' : 'plain';
        btn.onclick = () => done(b.value);
        if (b.primary) primary = b.value;
        row.append(btn);
      }
      box.append(row);
      back.append(box);
      back.onmousedown = (e) => { if (e.target === back) done(null); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && primary !== null && field && document.activeElement === field) {
          e.preventDefault(); e.stopPropagation(); done(primary);
        }
      };
      document.addEventListener('keydown', onKey, true);
      document.body.append(back);
      if (field) {
        field.focus();
        if (select) field.setSelectionRange(select[0], select[1]); else field.select();
      } else {
        (row.querySelector('.primary') || row.querySelector('button')).focus();
      }
    });
  }

  // ---------------------------------------------------------------- building

  function build() {
    if (fb.built) return;
    fb.built = true;
    const root = $('#files');
    root.innerHTML = `
      <header class="files-head">
        <div class="files-nav">
          <button class="icon-btn" data-act="back" title="Back (Alt+←)" aria-label="Back">←</button>
          <button class="icon-btn" data-act="forward" title="Forward (Alt+→)" aria-label="Forward">→</button>
          <button class="icon-btn" data-act="up" title="Parent folder (Backspace)" aria-label="Parent folder">↑</button>
        </div>
        <div class="files-path" title="Click to type a path (Ctrl+L)"></div>
        <div class="files-head-actions">
          <button class="icon-btn" data-act="pin" title="Pin this folder" aria-label="Pin this folder">☆</button>
          <button class="icon-btn" data-act="refresh" title="Refresh (F5)" aria-label="Refresh">⟳</button>
          <button class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close files">✕</button>
        </div>
        <div class="files-busy" aria-hidden="true"></div>
      </header>
      <div class="files-body">
        <nav class="files-places" aria-label="Places"></nav>
        <div class="files-resizer files-pl-resizer" role="separator" aria-orientation="vertical" aria-label="Resize places"
             tabindex="0" title="Drag to resize · double-click to reset"></div>
        <div class="files-main">
          <div class="files-toolbar">
            <input class="files-filter" type="search" placeholder="Filter this folder" aria-label="Filter this folder" spellcheck="false" autocomplete="off">
            <button class="tool-btn" data-act="mkdir" title="New folder">＋ Folder</button>
            <button class="tool-btn" data-act="upload-files" title="Upload files into this folder">⇪ Files</button>
            <button class="tool-btn" data-act="upload-dir" title="Upload a folder into this folder">⇪ Folder</button>
            <label class="tool-check" title="Show hidden files (names starting with a dot)"><input type="checkbox" class="files-hidden"> Hidden</label>
          </div>
          <div class="files-cols">
            <button data-sort="name">Name</button><button data-sort="size">Size</button><button data-sort="mtime">Modified</button>
          </div>
          <div class="files-list" role="listbox" tabindex="0" aria-multiselectable="true" aria-label="Folder contents"></div>
          <div class="files-empty" hidden></div>
          <div class="files-drop" hidden><div class="files-drop-box">Drop to upload into <b></b></div></div>
        </div>
        <div class="files-resizer files-pv-resizer" role="separator" aria-orientation="vertical" aria-label="Resize preview"
             tabindex="0" title="Drag to resize · double-click to reset"></div>
        <aside class="files-preview" hidden aria-label="Preview"></aside>
      </div>
      <footer class="files-status">
        <span class="files-count"></span>
        <div class="files-progress" hidden>
          <div class="files-progress-bar"><div></div></div>
          <span class="files-progress-text"></span>
          <button class="link-btn" data-act="cancel-upload">Cancel</button>
        </div>
      </footer>
      <input type="file" class="files-input-files" multiple hidden>
      <input type="file" class="files-input-dir" webkitdirectory multiple hidden>`;
    const q = (s) => root.querySelector(s);
    Object.assign(el, {
      root, path: q('.files-path'), places: q('.files-places'), list: q('.files-list'), empty: q('.files-empty'),
      filter: q('.files-filter'), hidden: q('.files-hidden'), cols: q('.files-cols'), preview: q('.files-preview'),
      count: q('.files-count'), drop: q('.files-drop'), dropName: q('.files-drop b'), main: q('.files-main'),
      progress: q('.files-progress'), progressBar: q('.files-progress-bar div'), progressText: q('.files-progress-text'),
      inputFiles: q('.files-input-files'), inputDir: q('.files-input-dir'), pinBtn: q('[data-act="pin"]'),
    });
    el.hidden.checked = fb.showHidden;
    setupResizers();

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && root.contains(b)) runAction(b.dataset.act);
    });
    el.cols.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      fb.sort = fb.sort.key === b.dataset.sort ? { key: b.dataset.sort, dir: -fb.sort.dir } : { key: b.dataset.sort, dir: b.dataset.sort === 'name' ? 1 : -1 };
      storage('wt.fbSort', JSON.stringify(fb.sort));
      renderList();
    });
    el.filter.addEventListener('input', () => { fb.filter = el.filter.value; renderList(); });
    el.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.filter.value = ''; fb.filter = ''; renderList(); el.list.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); el.list.focus(); if (!fb.sel.size && fb.shown[0]) selectOnly(fb.shown[0].name); }
    });
    el.hidden.addEventListener('change', () => {
      fb.showHidden = el.hidden.checked;
      storage('wt.fbHidden', fb.showHidden ? '1' : '');
      renderList();
    });
    el.path.addEventListener('click', (e) => { if (e.target === el.path || e.target.classList.contains('crumb-rest')) editPath(); });
    el.list.addEventListener('keydown', onListKey);
    el.list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = e.target.closest('.frow');
      if (row && !fb.sel.has(row.dataset.name)) selectOnly(row.dataset.name, { preview: false });
      if (!row) clearSelection();
      showMenu(e.clientX, e.clientY, row ? selectionMenu() : backgroundMenu());
    });
    el.list.addEventListener('mousedown', (e) => { if (e.target === el.list && e.button === 0) clearSelection(); });
    el.list.addEventListener('pointerdown', onListPointerDown);
    el.inputFiles.addEventListener('change', () => { uploadFromInput(el.inputFiles); });
    el.inputDir.addEventListener('change', () => { uploadFromInput(el.inputDir); });
    root.addEventListener('keydown', onPanelKey);
    setupDrop();
  }

  // ---------------------------------------------------------------- navigation

  async function go(target, { push = true, select = null, preview = false } = {}) {
    setLoading(true);
    try {
      const data = await api('GET', `/list?path=${enc(target)}`);
      const changed = data.path !== fb.path;
      fb.listing = data;
      fb.path = data.path;
      if (push && changed) {
        fb.history = fb.history.slice(0, fb.hpos + 1);
        fb.history.push(data.path);
        fb.hpos = fb.history.length - 1;
      }
      if (changed) {
        fb.sel.clear();
        fb.anchor = fb.cursor = null;
        fb.filter = '';
        el.filter.value = '';
        closePreview();
      } else {
        // Refresh: keep what is still there selected.
        const names = new Set(data.entries.map((x) => x.name));
        for (const n of [...fb.sel]) if (!names.has(n)) fb.sel.delete(n);
      }
      if (select) {
        const e = data.entries.find((x) => x.name === select);
        if (e) {
          if (isHidden(select) && !fb.showHidden) { fb.showHidden = true; el.hidden.checked = true; }
          fb.sel = new Set([select]);
          fb.anchor = fb.cursor = select;
        }
      }
      render();
      if (select) {
        scrollToName(select);
        const e = data.entries.find((x) => x.name === select);
        if (e && preview && e.type !== 'dir') showPreview(e);
      }
      return true;
    } catch (err) {
      toast(err.message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  const refresh = () => (fb.path ? go(fb.path, { push: false }) : go('~'));

  function back() {
    if (fb.hpos > 0) { fb.hpos--; go(fb.history[fb.hpos], { push: false }); }
  }
  function forward() {
    if (fb.hpos < fb.history.length - 1) { fb.hpos++; go(fb.history[fb.hpos], { push: false }); }
  }
  function up() {
    const p = parentOf(fb.path);
    if (p) go(p, { select: baseName(fb.path) });
  }

  // Open a path that may be a file: its folder, with the file selected.
  async function reveal(p) {
    const ok = await go(p).catch(() => false);
    if (ok && fb.path === p) return;
    const parent = parentOf(p);
    if (parent) go(parent, { select: baseName(p), preview: true });
  }

  function editPath() {
    if (el.path.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = tilde(fb.path || '~');
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Path');
    el.path.textContent = '';
    el.path.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (goThere) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      renderPath();
      if (goThere && v) reveal(v);
      else el.list.focus();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(false);
  }

  // ---------------------------------------------------------------- rendering

  function render() {
    renderPath();
    renderPlaces();
    renderList();
    const pinned = fb.pins.some((p) => p.path === fb.path);
    el.pinBtn.textContent = pinned ? '★' : '☆';
    el.pinBtn.classList.toggle('on', pinned);
    el.pinBtn.title = pinned ? 'Unpin this folder' : 'Pin this folder';
    el.root.querySelector('[data-act="back"]').disabled = fb.hpos <= 0;
    el.root.querySelector('[data-act="forward"]').disabled = fb.hpos >= fb.history.length - 1;
    el.root.querySelector('[data-act="up"]').disabled = !parentOf(fb.path || '/');
    const ro = fb.listing && !fb.listing.writable;
    for (const a of ['mkdir', 'upload-files', 'upload-dir']) el.root.querySelector(`[data-act="${a}"]`).disabled = ro;
  }

  function renderPath() {
    el.path.textContent = '';
    if (!fb.path) return;
    const home = fb.info && fb.info.home;
    const crumbs = [];
    let rest = fb.path;
    if (home && (fb.path === home || fb.path.startsWith(home + '/'))) {
      crumbs.push({ label: '⌂ Home', path: home });
      rest = fb.path.slice(home.length);
    } else {
      crumbs.push({ label: '/', path: '/' });
    }
    let acc = crumbs[0].path === '/' ? '' : home;
    for (const part of rest.split('/').filter(Boolean)) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        el.path.append(sep);
      }
      const b = document.createElement('button');
      b.className = 'crumb';
      b.textContent = c.label;
      b.title = c.path;
      if (i === crumbs.length - 1) b.classList.add('current');
      b.onclick = (e) => { e.stopPropagation(); if (c.path !== fb.path) go(c.path); };
      b.addEventListener('dragover', (e) => dirDragOver(e, c.path, b));
      b.addEventListener('drop', (e) => dirDrop(e, c.path));
      el.path.append(b);
    });
    const restEl = document.createElement('span');
    restEl.className = 'crumb-rest';
    el.path.append(restEl);
    el.path.scrollLeft = el.path.scrollWidth;
  }

  function placeItem(label, p, { pin = null, icon: ico = '', title } = {}) {
    const b = document.createElement('button');
    b.className = 'place';
    if (p === fb.path) b.classList.add('current');
    const i = document.createElement('span');
    i.className = 'place-icon';
    i.textContent = ico;
    const name = document.createElement('span');
    name.className = 'place-name';
    name.textContent = label;
    b.append(i, name);
    b.title = title || tilde(p);
    b.onclick = () => (pin && pin.type === 'file' ? reveal(p) : go(p));
    if (p && !(pin && pin.type === 'file')) {
      b.addEventListener('dragover', (e) => dirDragOver(e, p, b));
      b.addEventListener('drop', (e) => dirDrop(e, p));
    }
    if (pin) {
      const x = document.createElement('span');
      x.className = 'place-unpin';
      x.textContent = '✕';
      x.title = 'Unpin';
      x.onclick = (e) => { e.stopPropagation(); setPins(fb.pins.filter((q) => q.path !== pin.path)); };
      b.append(x);
      b.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Open', action: () => b.onclick() },
          { label: 'Rename pin…', action: () => renamePin(pin) },
          { label: 'Copy path', action: () => copyPaths([pin.path]) },
          { sep: true },
          { label: 'Unpin', action: () => setPins(fb.pins.filter((q) => q.path !== pin.path)) },
        ]);
      };
    }
    return b;
  }

  function renderPlaces() {
    el.places.textContent = '';
    const h1 = document.createElement('div');
    h1.className = 'places-title';
    h1.textContent = 'Places';
    el.places.append(h1);
    const home = fb.info ? fb.info.home : '~';
    el.places.append(placeItem('Home', home, { icon: '⌂' }));
    if (state.active) {
      const t = placeItem('Terminal folder', '', { icon: '›_', title: 'The folder the terminal on screen is in' });
      t.onclick = async () => {
        try { const { path } = await api('GET', `/cwd?tab=${enc(state.active)}`); go(path); } catch (err) { toast(err.message); }
      };
      el.places.append(t);
    }
    el.places.append(placeItem('Computer', '/', { icon: '⌸' }));
    const h2 = document.createElement('div');
    h2.className = 'places-title';
    h2.textContent = 'Pinned';
    el.places.append(h2);
    if (!fb.pins.length) {
      const hint = document.createElement('div');
      hint.className = 'places-hint';
      hint.textContent = 'Pin folders or files with ☆ or the right-click menu.';
      el.places.append(hint);
    }
    for (const p of fb.pins) el.places.append(placeItem(p.name, p.path, { pin: p, icon: p.type === 'file' ? '◇' : '★' }));
  }

  function sortedEntries() {
    let list = fb.listing ? fb.listing.entries : [];
    if (!fb.showHidden) list = list.filter((e) => !isHidden(e.name));
    if (fb.filter) {
      const q = fb.filter.toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }
    const { key, dir } = fb.sort;
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...list].sort((a, b) => {
      const da = a.type === 'dir' ? 0 : 1;
      const db = b.type === 'dir' ? 0 : 1;
      if (da !== db) return da - db; // folders first, whatever the order
      let c = 0;
      if (key === 'size') c = a.size - b.size;
      else if (key === 'mtime') c = a.mtime - b.mtime;
      if (!c) c = coll.compare(a.name, b.name);
      return c * dir;
    });
  }

  function renderList() {
    if (!fb.listing) return;
    fb.shown = sortedEntries();
    for (const b of el.cols.querySelectorAll('[data-sort]')) {
      const on = b.dataset.sort === fb.sort.key;
      b.classList.toggle('on', on);
      b.dataset.dir = on ? (fb.sort.dir > 0 ? '▲' : '▼') : '';
    }
    const frag = document.createDocumentFragment();
    for (const e of fb.shown) {
      const row = document.createElement('div');
      row.className = 'frow';
      row.setAttribute('role', 'option');
      row.dataset.name = e.name;
      row.draggable = false; // made draggable while the pointer is on the icon or name (see onListPointerDown)
      row.addEventListener('dragstart', (ev) => onRowDragStart(ev, e));
      row.addEventListener('dragend', onRowDragEnd);
      if (fb.clip && fb.clip.op === 'cut' && fb.clip.paths.includes(join(fb.path, e.name))) row.classList.add('cut');
      if (fb.sel.has(e.name)) { row.classList.add('sel'); row.setAttribute('aria-selected', 'true'); }
      if (e.name === fb.cursor) row.classList.add('cursor');
      if (isHidden(e.name)) row.classList.add('hidden-file');
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = e.name;
      if (e.link) name.title = `${e.name} (link)`;
      const size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = e.type === 'dir' ? '' : fmtSize(e.size);
      const time = document.createElement('span');
      time.className = 'ftime';
      time.textContent = fmtTime(e.mtime);
      if (e.mtime) time.title = new Date(e.mtime).toLocaleString();
      row.append(icon(e), name, size, time);
      row.onclick = (ev) => onRowClick(ev, e);
      row.ondblclick = () => openEntry(e);
      if (e.type === 'dir') {
        const target = join(fb.path, e.name);
        row.addEventListener('dragover', (ev) => dirDragOver(ev, target, row));
        row.addEventListener('drop', (ev) => dirDrop(ev, target));
      }
      frag.append(row);
    }
    el.list.textContent = '';
    el.list.append(frag);
    const hiddenCount = fb.listing.entries.filter((e) => isHidden(e.name)).length;
    el.empty.hidden = fb.shown.length > 0;
    el.empty.textContent = fb.filter ? `Nothing here matches "${fb.filter}".`
      : hiddenCount && !fb.showHidden ? `Only hidden files here (${hiddenCount}). Tick "Hidden" to see them.`
        : 'This folder is empty. Drop files here to upload them.';
    renderCount();
  }

  function renderCount() {
    if (!fb.listing) return;
    const dirs = fb.shown.filter((e) => e.type === 'dir').length;
    const filesN = fb.shown.length - dirs;
    const parts = [`${dirs} folder${dirs === 1 ? '' : 's'}`, `${filesN} file${filesN === 1 ? '' : 's'}`];
    const hiddenCount = fb.listing.entries.filter((e) => isHidden(e.name)).length;
    if (!fb.showHidden && hiddenCount) parts.push(`${hiddenCount} hidden`);
    if (fb.listing.truncated) parts.push('showing the first 5,000');
    if (!fb.listing.writable) parts.push('read-only');
    if (fb.sel.size) {
      const sel = selectedEntries();
      const bytes = sel.filter((e) => e.type !== 'dir').reduce((a, e) => a + e.size, 0);
      parts.push(`${sel.length} selected${bytes ? ` (${fmtSize(bytes)})` : ''}`);
    }
    el.count.textContent = parts.join(' · ');
  }

  function scrollToName(name) {
    const row = el.list.querySelector(`.frow[data-name="${CSS.escape(name)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- selection

  const selectedEntries = () => fb.shown.filter((e) => fb.sel.has(e.name));

  function paintSelection() {
    for (const row of el.list.children) {
      const on = fb.sel.has(row.dataset.name);
      row.classList.toggle('sel', on);
      row.classList.toggle('cursor', row.dataset.name === fb.cursor);
      if (on) row.setAttribute('aria-selected', 'true'); else row.removeAttribute('aria-selected');
    }
    renderCount();
  }

  function clearSelection() {
    fb.sel.clear();
    paintSelection();
  }

  function selectOnly(name, { preview = true } = {}) {
    fb.sel = new Set([name]);
    fb.anchor = fb.cursor = name;
    paintSelection();
    scrollToName(name);
    const e = fb.shown.find((x) => x.name === name);
    if (preview && e && e.type !== 'dir' && !el.preview.hidden) showPreview(e, { play: false });
  }

  function onRowClick(ev, e) {
    el.list.focus({ preventScroll: true });
    const multi = isMac ? ev.metaKey : ev.ctrlKey;
    if (ev.shiftKey && fb.anchor) {
      const names = fb.shown.map((x) => x.name);
      const a = names.indexOf(fb.anchor);
      const b = names.indexOf(e.name);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!multi) fb.sel.clear();
      for (let i = lo; i <= hi; i++) fb.sel.add(names[i]);
      fb.cursor = e.name;
      paintSelection();
      return;
    }
    if (multi) {
      if (fb.sel.has(e.name)) fb.sel.delete(e.name); else fb.sel.add(e.name);
      fb.anchor = fb.cursor = e.name;
      paintSelection();
      return;
    }
    fb.sel = new Set([e.name]);
    fb.anchor = fb.cursor = e.name;
    paintSelection();
    if (e.type !== 'dir') showPreview(e);
  }

  function openEntry(e) {
    if (e.type === 'dir') go(join(fb.path, e.name));
    else showPreview(e);
  }

  function moveCursor(delta, extend) {
    if (!fb.shown.length) return;
    const names = fb.shown.map((x) => x.name);
    let i = names.indexOf(fb.cursor);
    i = i < 0 ? (delta > 0 ? 0 : names.length - 1) : Math.max(0, Math.min(names.length - 1, i + delta));
    const name = names[i];
    if (extend && fb.anchor) {
      const a = names.indexOf(fb.anchor);
      const [lo, hi] = a < i ? [a, i] : [i, a];
      fb.sel = new Set(names.slice(lo, hi + 1));
      fb.cursor = name;
      paintSelection();
      scrollToName(name);
    } else {
      selectOnly(name);
    }
  }

  // ---------------------------------------------------------------- rectangle selection

  // Press on empty space (or on a row's size/date cells) and drag to select
  // everything the rectangle touches; Ctrl or Shift adds to the selection.
  // Pressing on an icon or a name instead starts dragging those files.
  function onListPointerDown(e) {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const row = e.target.closest('.frow');
    if (row && e.target.closest('.fname, .ficon')) {
      row.draggable = true; // drag the file(s)
      const off = () => { row.draggable = false; };
      document.addEventListener('pointerup', off, { once: true, capture: true });
      document.addEventListener('dragend', off, { once: true, capture: true });
      return;
    }
    if (row && fb.sel.has(row.dataset.name)) return; // a plain click on a selected row
    const list = el.list;
    const toContent = (ev) => {
      const r = list.getBoundingClientRect();
      return { x: ev.clientX - r.left + list.scrollLeft, y: ev.clientY - r.top + list.scrollTop };
    };
    const start = toContent(e);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = additive ? new Set(fb.sel) : new Set();
    let band = null;
    let last = { clientX: e.clientX, clientY: e.clientY };
    let timer = 0;

    const update = () => {
      const now = toContent(last);
      const x0 = Math.min(start.x, now.x);
      const x1 = Math.max(start.x, now.x);
      const y0 = Math.min(start.y, now.y);
      const y1 = Math.max(start.y, now.y);
      band.style.cssText = `left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px`;
      const sel = new Set(base);
      let lastHit = null;
      for (const r of list.children) {
        if (!r.classList.contains('frow')) continue;
        if (r.offsetTop + r.offsetHeight > y0 && r.offsetTop < y1 && r.offsetLeft + r.offsetWidth > x0 && r.offsetLeft < x1) {
          sel.add(r.dataset.name);
          lastHit = r.dataset.name;
        }
      }
      fb.sel = sel;
      if (lastHit) fb.anchor = fb.cursor = lastHit;
      paintSelection();
    };
    // Near the top or bottom edge the list scrolls under the rectangle.
    const tick = () => {
      const r = list.getBoundingClientRect();
      const dy = last.clientY < r.top + 24 ? -(r.top + 24 - last.clientY) : last.clientY > r.bottom - 24 ? last.clientY - (r.bottom - 24) : 0;
      if (dy) { list.scrollTop += Math.max(-24, Math.min(24, dy)); update(); }
    };
    const move = (ev) => {
      last = ev;
      if (!band) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        band = document.createElement('div');
        band.className = 'files-band';
        list.append(band);
        list.setPointerCapture(e.pointerId);
        list.focus({ preventScroll: true });
        timer = setInterval(tick, 40);
        ev.preventDefault();
      }
      update();
    };
    const end = () => {
      list.removeEventListener('pointermove', move);
      list.removeEventListener('pointerup', end);
      list.removeEventListener('pointercancel', end);
      clearInterval(timer);
      if (band) {
        band.remove();
        // The click that follows a drag must not clear what was just selected.
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        list.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => list.removeEventListener('click', swallow, true), 0);
      }
    };
    list.addEventListener('pointermove', move);
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- copy, cut, paste, move

  const pathsOfSelection = () => selectedEntries().map((x) => join(fb.path, x.name));

  function copyFiles(op) {
    const paths = pathsOfSelection();
    if (!paths.length) return;
    fb.clip = { op: op === 'cut' ? 'cut' : 'copy', paths };
    renderList();
    toast(`${op === 'cut' ? 'Cut' : 'Copied'} ${paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`}. Paste with ${isMac ? '⌘V' : 'Ctrl+V'}.`, 2200);
  }

  async function paste(into = fb.path) {
    if (!fb.clip || !fb.clip.paths.length) { toast('Nothing to paste. Copy or cut some files first.', 2000); return; }
    const { op, paths } = fb.clip;
    const done = await transfer(op === 'cut' ? 'move' : 'copy', paths, into);
    if (done && op === 'cut') fb.clip = null;
    if (done) renderList();
  }

  // Copy or move paths into `to`. Asks once about names that already exist.
  async function transfer(op, paths, to) {
    const verb = op === 'move' ? 'Moved' : 'Copied';
    try {
      setLoading(true);
      let res = await api('POST', '/transfer', { op, paths, to, mode: 'fail' });
      let doneList = res.done;
      let failed = res.failed;
      if (res.conflicts.length) {
        const { button } = await dialog({
          title: `${res.conflicts.length === 1 ? 'An item already exists' : `${res.conflicts.length} items already exist`} in ${baseName(to) || '/'}`,
          list: res.conflicts,
          buttons: [
            { label: 'Cancel', value: 'cancel' },
            { label: 'Skip them', value: 'skip' },
            { label: 'Keep both', value: 'rename' },
            { label: 'Replace', value: 'replace', danger: true },
          ],
        });
        if (button === 'rename' || button === 'replace') {
          const again = paths.filter((p) => res.conflicts.includes(baseName(p)));
          const r2 = await api('POST', '/transfer', { op, paths: again, to, mode: button });
          doneList = doneList.concat(r2.done);
          failed = failed.concat(r2.failed);
        } else if (button !== 'skip') {
          if (!doneList.length && !failed.length) return false;
        }
      }
      if (failed.length) {
        await dialog({ title: 'Some items could not be ' + (op === 'move' ? 'moved' : 'copied'), list: failed.map((f) => `${baseName(f.path)}: ${f.error}`), buttons: [{ label: 'OK', value: 'ok', primary: true }] });
      } else if (doneList.length) {
        toast(`${verb} ${doneList.length === 1 ? baseName(doneList[0]) : `${doneList.length} items`} to ${tilde(to)}`, 2200);
      }
      const mine = doneList.filter((p) => parentOf(p) === fb.path).map(baseName);
      await go(fb.path, { push: false, select: mine[0] || null });
      if (mine.length > 1) { fb.sel = new Set(mine); paintSelection(); }
      return doneList.length > 0;
    } catch (err) {
      toast(err.message);
      return false;
    } finally {
      setLoading(false);
      if (fb.open) el.list.focus({ preventScroll: true });
    }
  }

  // Dragging rows onto a folder (in the list, the path bar or Places) moves
  // them; Ctrl (Option on a Mac) copies.
  function onRowDragStart(ev, e) {
    if (!fb.sel.has(e.name)) selectOnly(e.name, { preview: false });
    const names = [...fb.sel];
    fb.drag = { dir: fb.path, names, paths: names.map((n) => join(fb.path, n)) };
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData('application/x-wt-files', JSON.stringify(fb.drag.paths));
    ev.dataTransfer.setData('text/plain', fb.drag.paths.join('\n'));
    if (names.length > 1) {
      const g = document.createElement('div');
      g.className = 'drag-ghost';
      g.textContent = `${names.length} items`;
      document.body.append(g);
      ev.dataTransfer.setDragImage(g, 12, 12);
      setTimeout(() => g.remove(), 0);
    }
  }
  function onRowDragEnd() {
    fb.drag = null;
    el.root.querySelectorAll('.drop-into').forEach((x) => x.classList.remove('drop-into'));
  }
  // Whether the dragged rows may go into folder `p`.
  function canDropHere(p) {
    const d = fb.drag;
    if (!d) return false;
    if (fb.listing && p === fb.path && !fb.listing.writable) return false;
    // A folder into itself or one of its own subfolders.
    return !d.paths.some((x) => p === x || p.startsWith(x + '/'));
  }

  async function newFile() {
    const { button, value } = await dialog({
      title: 'New file', message: `In ${tilde(fb.path)}`, input: 'New file.txt', select: [0, 8],
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', value: 'ok', primary: true }],
    });
    if (button !== 'ok' || !value) { el.list.focus(); return; }
    try {
      await api('POST', '/mkfile', { dir: fb.path, name: value });
      await go(fb.path, { push: false, select: value, preview: true });
    } catch (err) { toast(err.message); }
    el.list.focus();
  }

  function invertSelection() {
    fb.sel = new Set(fb.shown.filter((x) => !fb.sel.has(x.name)).map((x) => x.name));
    paintSelection();
  }

  function selectAll() {
    fb.sel = new Set(fb.shown.map((x) => x.name));
    paintSelection();
  }

  async function showProperties() {
    const sel = selectedEntries();
    let lines;
    if (sel.length <= 1) {
      const x = sel[0] || { name: baseName(fb.path), type: 'dir', size: 0, mtime: 0, link: false };
      const p = sel[0] ? join(fb.path, x.name) : fb.path;
      lines = [
        `Name:      ${x.name}`,
        `Type:      ${x.type === 'dir' ? 'Folder' : x.type === 'file' ? (extOf(x.name) ? `${extOf(x.name).toUpperCase()} file` : 'File') : x.type}${x.link ? ' (link)' : ''}`,
        `Location:  ${tilde(parentOf(p) || '/')}`,
        ...(x.type === 'file' ? [`Size:      ${fmtSize(x.size)} (${x.size.toLocaleString()} bytes)`] : []),
        ...(x.mtime ? [`Modified:  ${new Date(x.mtime).toLocaleString()}`] : []),
        ...(!sel[0] ? [`Contains:  ${fb.listing.entries.length} items`] : []),
      ];
    } else {
      const bytes = sel.filter((x) => x.type === 'file').reduce((a, x) => a + x.size, 0);
      lines = [`Items:     ${sel.length}`, `Folders:   ${sel.filter((x) => x.type === 'dir').length}`, `Files:     ${sel.filter((x) => x.type !== 'dir').length}`, `Size:      ${fmtSize(bytes)} (files only)`, `Location:  ${tilde(fb.path)}`];
    }
    await dialog({ title: 'Properties', list: lines, buttons: [{ label: 'Close', value: 'ok', primary: true }] });
    el.list.focus();
  }

  // ---------------------------------------------------------------- keyboard

  function onListKey(e) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const cur = fb.shown.find((x) => x.name === fb.cursor);
    const page = Math.max(1, Math.floor(el.list.clientHeight / 30) - 1);
    if (e.key === 'ArrowDown') moveCursor(1, e.shiftKey);
    else if (e.key === 'ArrowUp' && e.altKey) up();
    else if (e.key === 'ArrowUp') moveCursor(-1, e.shiftKey);
    else if (e.key === 'PageDown') moveCursor(page, e.shiftKey);
    else if (e.key === 'PageUp') moveCursor(-page, e.shiftKey);
    else if (e.key === 'Home') moveCursor(-1e9, e.shiftKey);
    else if (e.key === 'End') moveCursor(1e9, e.shiftKey);
    else if (e.key === 'Enter' && !e.altKey && cur) openEntry(cur);
    else if (e.key === ' ' && cur && cur.type !== 'dir') {
      // Space on the file already playing in the preview pauses or resumes it.
      const m = el.preview.querySelector('audio, video');
      if (m && fb.previewPath === join(fb.path, cur.name)) { if (m.paused) m.play().catch(() => {}); else m.pause(); } else showPreview(cur);
    }
    else if (e.key === 'Backspace') up();
    else if (e.key === 'Delete' || (isMac && mod && e.key === 'Backspace')) deleteSelected();
    else if (e.key === 'F2') renameSelected();
    else if (mod && e.code === 'KeyA') selectAll();
    else if (mod && e.shiftKey && e.code === 'KeyC' && fb.sel.size) copyPaths(pathsOfSelection());
    else if (mod && e.code === 'KeyC' && fb.sel.size) copyFiles('copy');
    else if (mod && e.code === 'KeyX' && fb.sel.size) copyFiles('cut');
    else if (mod && e.code === 'KeyV') paste();
    else if (e.altKey && e.key === 'Enter') showProperties();
    else if (e.key.length === 1 && !mod && !e.altKey && e.key !== ' ') {
      // Type to jump to a name.
      const now = Date.now();
      fb.typeahead = now - fb.typeaheadAt < 800 ? fb.typeahead + e.key.toLowerCase() : e.key.toLowerCase();
      fb.typeaheadAt = now;
      const hit = fb.shown.find((x) => x.name.toLowerCase().startsWith(fb.typeahead));
      if (hit) selectOnly(hit.name);
    } else return;
    e.preventDefault();
  }

  function onPanelKey(e) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.target.tagName === 'INPUT' && e.target !== el.filter) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hideMenu()) return;
      if (!el.preview.hidden) { closePreview(); el.list.focus(); return; }
      close();
    } else if (mod && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); close(); }
    else if (mod && !e.shiftKey && e.code === 'KeyF') { e.preventDefault(); el.filter.focus(); el.filter.select(); }
    else if (mod && e.code === 'KeyL') { e.preventDefault(); editPath(); }
    else if (e.key === 'F5' || (mod && e.code === 'KeyR')) { e.preventDefault(); refresh(); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); forward(); }
  }

  // ---------------------------------------------------------------- preview

  // Two draggable bars: between Places and the list, and between the list and
  // the preview. Each remembers its width in this browser; double-click resets,
  // arrow keys on a focused bar adjust it. The list always keeps LIST_MIN px.
  const LIST_MIN = 300;
  const bodyEl = () => el.root.querySelector('.files-body');
  const widthOf = (node) => (node && !node.hidden && node.offsetParent ? node.getBoundingClientRect().width : 0);
  const panes = {};

  function makeResizer(bar, { cssVar, key, min, hardMax, grows, target, other, deflt }) {
    const max = () => Math.max(min, Math.min(hardMax, bodyEl().clientWidth - widthOf(other()) - LIST_MIN));
    const set = (px, save = false) => {
      const w = Math.round(Math.max(min, Math.min(max(), px)));
      el.root.style.setProperty(cssVar, `${w}px`);
      if (save) storage(key, String(w));
      return w;
    };
    const current = () => widthOf(target()) || deflt();
    const reset = () => { el.root.style.removeProperty(cssVar); storage(key, ''); };
    // The saved width, once the panel has a size (not while it is hidden).
    const applySaved = () => { const w = Number(storage(key)); if (w > 0) set(w); else el.root.style.removeProperty(cssVar); };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = current();
      el.root.classList.add('resizing');
      const move = (ev) => set(startW + grows * (ev.clientX - startX));
      const end = (ev) => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', end);
        bar.removeEventListener('pointercancel', end);
        el.root.classList.remove('resizing');
        set(startW + grows * (ev.clientX - startX), true);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);
    });
    bar.addEventListener('dblclick', reset);
    bar.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      if (e.key === 'ArrowRight') set(current() + grows * step, true);
      else if (e.key === 'ArrowLeft') set(current() - grows * step, true);
      else if (e.key === 'Home') reset();
      else return;
      e.preventDefault();
    });
    return { applySaved };
  }

  function setupResizers() {
    panes.places = makeResizer(el.root.querySelector('.files-pl-resizer'), {
      cssVar: '--pl-w', key: 'wt.fbPlacesW', min: 120, hardMax: 420, grows: 1,
      target: () => el.places, other: () => el.preview, deflt: () => 190,
    });
    panes.preview = makeResizer(el.root.querySelector('.files-pv-resizer'), {
      cssVar: '--pv-w', key: 'wt.fbPreviewW', min: 240, hardMax: 1600, grows: -1,
      target: () => el.preview, other: () => el.places, deflt: () => Math.min(720, Math.round(bodyEl().clientWidth * 0.46)),
    });
    // A narrower window may no longer fit a saved width: clamp, keeping the saved value.
    window.addEventListener('resize', () => { if (fb.open) { panes.places.applySaved(); if (!el.preview.hidden) panes.preview.applySaved(); } });
  }

  // A removed <audio>/<video> can keep playing until it is collected: stop it.
  function stopMedia() {
    if (!el.preview) return;
    for (const m of el.preview.querySelectorAll('audio, video')) {
      try { m.pause(); m.removeAttribute('src'); m.load(); } catch { /* already gone */ }
    }
  }

  function closePreview() {
    stopMedia();
    fb.previewToken++;
    fb.previewPath = null;
    if (!el.preview) return;
    el.preview.hidden = true;
    el.preview.textContent = '';
    el.root.classList.remove('previewing');
  }

  // play: start audio/video right away (a click or Enter); false when arrowing past files.
  async function showPreview(e, { play = true } = {}) {
    stopMedia();
    const token = ++fb.previewToken;
    const p = join(fb.path, e.name);
    fb.previewPath = p;
    el.preview.hidden = false;
    el.root.classList.add('previewing');
    panes.preview.applySaved();
    el.preview.textContent = '';

    const head = document.createElement('div');
    head.className = 'pv-head';
    const title = document.createElement('div');
    title.className = 'pv-title';
    title.append(icon(e));
    const nm = document.createElement('span');
    nm.textContent = e.name;
    nm.title = p;
    title.append(nm);
    const x = document.createElement('button');
    x.className = 'icon-btn pv-close';
    x.textContent = '✕';
    x.title = 'Close preview (Esc)';
    x.onclick = () => { closePreview(); el.list.focus(); };
    title.append(x);
    const meta = document.createElement('div');
    meta.className = 'pv-meta';
    meta.textContent = `${fmtSize(e.size)} · modified ${e.mtime ? new Date(e.mtime).toLocaleString() : '?'}`;
    const actions = document.createElement('div');
    actions.className = 'pv-actions';
    const act = (label, fn, cls = 'tool-btn') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = fn;
      actions.append(b);
      return b;
    };
    act('⇩ Download', () => download([{ path: p, dir: false }]));
    act('Copy path', () => copyPaths([p]));
    act('Open in terminal', () => openInTerminal(fb.path));
    head.append(title, meta, actions);
    const body = document.createElement('div');
    body.className = 'pv-body';
    el.preview.append(head, body);

    const kind = kindOf(e);
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'pv-image';
      img.alt = e.name;
      img.src = `/api/files/raw?inline=1&path=${enc(p)}`;
      img.onerror = () => { body.textContent = 'This image could not be shown.'; };
      body.append(img);
      return;
    }
    const media = mediaKind(e);
    if (media) {
      const m = document.createElement(media);
      m.className = `pv-${media}`;
      m.controls = true;
      m.preload = 'metadata';
      m.playsInline = true;
      m.autoplay = play;
      m.src = `/api/files/raw?inline=1&path=${enc(p)}`;
      const note = document.createElement('div');
      note.className = 'pv-note';
      note.hidden = true;
      m.onerror = () => {
        note.hidden = false;
        note.textContent = `This browser can't play ${extOf(e.name).toUpperCase()} files like this one. Download it to open it.`;
        m.hidden = true;
      };
      if (media === 'audio') {
        const stage = document.createElement('div');
        stage.className = 'pv-stage';
        stage.innerHTML = '<div class="pv-art" aria-hidden="true">♪</div>';
        stage.append(m, note);
        body.append(stage);
      } else {
        body.append(m, note);
      }
      return;
    }
    if (e.size === 0) { body.innerHTML = '<div class="pv-note">Empty file.</div>'; return; }
    const loading = document.createElement('div');
    loading.className = 'pv-note';
    loading.textContent = 'Loading…';
    body.append(loading);
    let data;
    try {
      data = await api('GET', `/read?path=${enc(p)}`);
    } catch (err) {
      if (token === fb.previewToken) loading.textContent = err.message;
      return;
    }
    if (token !== fb.previewToken) return;
    body.textContent = '';
    if (data.binary) {
      const n = document.createElement('div');
      n.className = 'pv-note';
      n.textContent = `Binary file (${fmtSize(data.size)}). Download it to open it.`;
      body.append(n);
      return;
    }
    const wrapBtn = act(fb.wrap ? 'No wrap' : 'Wrap', () => {
      fb.wrap = !fb.wrap;
      storage('wt.fbWrap', fb.wrap ? '1' : '');
      wrapBtn.textContent = fb.wrap ? 'No wrap' : 'Wrap';
      code.classList.toggle('wrap', fb.wrap);
    }, 'tool-btn');
    const lines = data.text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const code = document.createElement('div');
    code.className = `pv-code${fb.wrap ? ' wrap' : ''}`;
    const gutter = document.createElement('pre');
    gutter.className = 'pv-gutter';
    gutter.textContent = lines.map((_, i) => i + 1).join('\n');
    const text = document.createElement('pre');
    text.className = 'pv-text';
    text.textContent = lines.join('\n');
    text.tabIndex = 0;
    code.append(gutter, text);
    body.append(code);
    if (data.truncated) {
      const n = document.createElement('div');
      n.className = 'pv-note pv-trunc';
      n.textContent = `Showing the first ${fmtSize(data.text.length)} of ${fmtSize(data.size)}. Download the file to see all of it.`;
      body.append(n);
    }
  }

  // ---------------------------------------------------------------- actions

  function download(items) {
    items.forEach((it, i) => {
      // Spaced out: browsers drop rapid repeated downloads.
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = `/api/files/${it.dir ? 'archive' : 'raw'}?path=${enc(it.path)}`;
        a.download = '';
        document.body.append(a);
        a.click();
        a.remove();
      }, i * 400);
    });
    if (items.some((it) => it.dir)) toast(`Preparing ${items.length > 1 ? 'downloads' : `${baseName(items[0].path)}.zip`}…`, 2500);
  }

  async function copyPaths(paths) {
    const ok = await copyText(paths.join('\n'));
    toast(ok ? (paths.length > 1 ? `Copied ${paths.length} paths` : `Copied ${tilde(paths[0])}`) : 'The browser blocked the copy.', 1800);
  }

  // A new tab in the current session (or a new session), in that folder.
  function openInTerminal(dir) {
    const msg = { t: 'create', cwd: dir, name: baseName(dir) || '/' };
    const gid = hasSessions() && state.active ? sessionOf(state.active) : null;
    if (gid) msg.group = gid;
    if (send(msg)) close({ keepFocus: true });
    else toast('Not connected.');
  }

  async function newFolder() {
    const { button, value } = await dialog({
      title: 'New folder', message: `In ${tilde(fb.path)}`, input: 'New folder',
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', value: 'ok', primary: true }],
    });
    if (button !== 'ok' || !value) { el.list.focus(); return; }
    try {
      await api('POST', '/mkdir', { dir: fb.path, name: value });
      await go(fb.path, { push: false, select: value });
    } catch (err) { toast(err.message); }
    el.list.focus();
  }

  async function renameSelected() {
    const [e] = selectedEntries();
    if (!e) return;
    const dot = e.type === 'dir' ? -1 : e.name.lastIndexOf('.');
    const { button, value } = await dialog({
      title: `Rename ${e.type === 'dir' ? 'folder' : 'file'}`, input: e.name, select: [0, dot > 0 ? dot : e.name.length],
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Rename', value: 'ok', primary: true }],
    });
    if (button !== 'ok' || !value || value === e.name) { el.list.focus(); return; }
    try {
      const p = join(fb.path, e.name);
      const res = await api('POST', '/rename', { path: p, name: value });
      // Keep pins pointing at the right place.
      if (fb.pins.some((q) => q.path === p)) setPins(fb.pins.map((q) => (q.path === p ? { ...q, path: res.path } : q)));
      await go(fb.path, { push: false, select: value });
    } catch (err) { toast(err.message); }
    el.list.focus();
  }

  async function deleteSelected() {
    const sel = selectedEntries();
    if (!sel.length) return;
    const trash = !fb.info || fb.info.trash;
    const what = sel.length === 1 ? `"${sel[0].name}"` : `${sel.length} items`;
    const { button } = await dialog({
      title: trash ? `Move ${what} to the Trash?` : `Delete ${what} permanently?`,
      message: trash ? 'You can restore them from the Trash on this machine.' : 'This cannot be undone.',
      list: sel.length > 1 ? sel.map((x) => x.name + (x.type === 'dir' ? '/' : '')) : null,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: trash ? 'Move to Trash' : 'Delete', value: 'ok', danger: true }],
    });
    if (button !== 'ok') { el.list.focus(); return; }
    const paths = sel.map((x) => join(fb.path, x.name));
    try {
      let res = await api('POST', '/delete', { paths, permanent: !trash });
      // Some places have no Trash (system folders such as /tmp): ask before
      // deleting those for good.
      const noTrash = res.failed.filter((f) => /not supported|trash/i.test(f.error));
      if (res.trash && noTrash.length) {
        const again = await dialog({
          title: 'No Trash for these',
          message: 'This location has no Trash, so they can only be deleted permanently. Delete them for good?',
          list: noTrash.map((f) => baseName(f.path)),
          buttons: [{ label: 'Keep them', value: 'cancel' }, { label: 'Delete permanently', value: 'ok', danger: true }],
        });
        if (again.button === 'ok') {
          const res2 = await api('POST', '/delete', { paths: noTrash.map((f) => f.path), permanent: true });
          res = { ...res, failed: res.failed.filter((f) => !noTrash.includes(f)).concat(res2.failed) };
        } else {
          res = { ...res, failed: res.failed.filter((f) => !noTrash.includes(f)) };
        }
      }
      if (res.failed.length) {
        await dialog({
          title: 'Some items could not be deleted', list: res.failed.map((f) => `${baseName(f.path)}: ${f.error}`),
          buttons: [{ label: 'OK', value: 'ok', primary: true }],
        });
      } else {
        toast(trash ? `Moved ${what} to the Trash` : `Deleted ${what}`, 2000);
      }
      if (paths.includes(fb.previewPath)) closePreview();
      await refresh();
    } catch (err) { toast(err.message); }
    el.list.focus();
  }

  // ---------------------------------------------------------------- pins

  async function loadPins() {
    try {
      const { pins } = await api('GET', '/pins');
      fb.pins = pins;
      fb.pinsLoaded = true;
      if (fb.open) render();
    } catch { /* keep what we have */ }
  }

  async function setPins(list) {
    const old = fb.pins;
    fb.pins = list;
    render();
    try {
      fb.pins = (await api('PUT', '/pins', { pins: list })).pins;
      render();
    } catch (err) {
      fb.pins = old;
      render();
      toast(err.message);
    }
  }

  function togglePin(p, type = 'dir') {
    if (fb.pins.some((q) => q.path === p)) setPins(fb.pins.filter((q) => q.path !== p));
    else setPins([...fb.pins, { path: p, name: baseName(p) || '/', type }]);
  }

  async function renamePin(pin) {
    const { button, value } = await dialog({
      title: 'Rename pin', message: tilde(pin.path), input: pin.name,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Rename', value: 'ok', primary: true }],
    });
    if (button === 'ok' && value) setPins(fb.pins.map((q) => (q.path === pin.path ? { ...q, name: value } : q)));
  }

  // ---------------------------------------------------------------- context menu

  let menuEl = null;
  function hideMenu() {
    if (!menuEl) return false;
    menuEl.remove();
    menuEl = null;
    return true;
  }

  function showMenu(x, y, items) {
    hideMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    menuEl.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        menuEl.append(s);
        continue;
      }
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.className = it.danger ? 'danger' : '';
      b.disabled = !!it.disabled;
      const l = document.createElement('span');
      l.textContent = it.label;
      b.append(l);
      if (it.hint) {
        const h = document.createElement('span');
        h.className = 'ctx-hint';
        h.textContent = it.hint;
        b.append(h);
      }
      b.onclick = () => { hideMenu(); it.action(); };
      menuEl.append(b);
    }
    document.body.append(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    menuEl.querySelector('button:not(:disabled)')?.focus();
    menuEl.addEventListener('keydown', (e) => {
      const btns = [...menuEl.querySelectorAll('button:not(:disabled)')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideMenu(); el.list.focus(); }
    });
  }

  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) hideMenu(); }, true);
  window.addEventListener('blur', hideMenu);
  window.addEventListener('resize', hideMenu);

  const mk = isMac ? '⌘' : 'Ctrl+';

  function selectionMenu() {
    const sel = selectedEntries();
    const paths = pathsOfSelection();
    const ro = fb.listing && !fb.listing.writable;
    const cutCopy = [
      { label: 'Cut', hint: `${mk}X`, disabled: ro, action: () => copyFiles('cut') },
      { label: 'Copy', hint: `${mk}C`, action: () => copyFiles('copy') },
    ];
    if (sel.length > 1) {
      return [
        ...cutCopy,
        { label: 'Copy paths', hint: `${mk}⇧C`, action: () => copyPaths(paths) },
        { label: `Download ${sel.length} items`, action: () => download(sel.map((x, i) => ({ path: paths[i], dir: x.type === 'dir' }))) },
        { sep: true },
        { label: `Move ${sel.length} items to the Trash…`, hint: 'Del', danger: true, disabled: ro, action: deleteSelected },
        { sep: true },
        { label: 'Properties', hint: 'Alt+Enter', action: showProperties },
      ];
    }
    const e = sel[0];
    const p = paths[0];
    const pinned = fb.pins.some((q) => q.path === p);
    const common = [
      { sep: true },
      { label: 'Rename…', hint: 'F2', disabled: ro, action: renameSelected },
      { label: 'Move to the Trash…', hint: 'Del', danger: true, disabled: ro, action: deleteSelected },
      { sep: true },
      { label: 'Properties', hint: 'Alt+Enter', action: showProperties },
    ];
    if (e.type === 'dir') {
      return [
        { label: 'Open', hint: 'Enter', action: () => go(p) },
        { label: 'Open in terminal', action: () => openInTerminal(p) },
        { sep: true },
        ...cutCopy,
        { label: 'Paste into folder', hint: `${mk}V`, disabled: !fb.clip, action: () => paste(p) },
        { sep: true },
        { label: 'Copy path', hint: `${mk}⇧C`, action: () => copyPaths([p]) },
        { label: 'Download as .zip', action: () => download([{ path: p, dir: true }]) },
        { label: pinned ? 'Unpin' : 'Pin', action: () => togglePin(p, 'dir') },
        ...common,
      ];
    }
    const media = mediaKind(e);
    return [
      { label: media ? (media === 'audio' ? 'Play' : 'Play video') : 'Preview', hint: media ? '' : 'Space', action: () => showPreview(e) },
      { label: 'Open folder in terminal', action: () => openInTerminal(fb.path) },
      { sep: true },
      ...cutCopy,
      { sep: true },
      { label: 'Copy path', hint: `${mk}⇧C`, action: () => copyPaths([p]) },
      { label: 'Download', action: () => download([{ path: p, dir: false }]) },
      { label: pinned ? 'Unpin' : 'Pin', action: () => togglePin(p, 'file') },
      ...common,
    ];
  }

  function backgroundMenu() {
    const ro = fb.listing && !fb.listing.writable;
    const pinned = fb.pins.some((q) => q.path === fb.path);
    return [
      { label: 'New folder…', disabled: ro, action: newFolder },
      { label: 'New file…', disabled: ro, action: newFile },
      { sep: true },
      { label: 'Paste', hint: `${mk}V`, disabled: ro || !fb.clip, action: () => paste() },
      { label: 'Select all', hint: `${mk}A`, action: selectAll },
      { label: 'Invert selection', action: invertSelection },
      { sep: true },
      { label: 'Upload files…', disabled: ro, action: () => el.inputFiles.click() },
      { label: 'Upload a folder…', disabled: ro, action: () => el.inputDir.click() },
      { sep: true },
      { label: 'Open terminal here', action: () => openInTerminal(fb.path) },
      { label: 'Download this folder as .zip', action: () => download([{ path: fb.path, dir: true }]) },
      { label: 'Copy path', action: () => copyPaths([fb.path]) },
      { label: pinned ? 'Unpin this folder' : 'Pin this folder', action: () => togglePin(fb.path, 'dir') },
      { sep: true },
      { label: fb.showHidden ? 'Hide hidden files' : 'Show hidden files', action: () => { el.hidden.click(); } },
      { label: 'Refresh', hint: 'F5', action: refresh },
      { label: 'Properties', action: showProperties },
    ];
  }

  function runAction(act) {
    if (act === 'back') back();
    else if (act === 'forward') forward();
    else if (act === 'up') up();
    else if (act === 'refresh') refresh();
    else if (act === 'close') close();
    else if (act === 'pin') togglePin(fb.path, 'dir');
    else if (act === 'mkdir') newFolder();
    else if (act === 'upload-files') el.inputFiles.click();
    else if (act === 'upload-dir') el.inputDir.click();
    else if (act === 'cancel-upload') cancelUpload();
  }

  // ---------------------------------------------------------------- uploads

  // Files dropped from the computer (folders included, walked recursively).
  // The entries must be taken from the event right away: the browser empties
  // the DataTransfer once the handler returns.
  function takeEntries(dt) {
    const entries = [];
    for (const item of dt.items || []) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
    }
    const plain = entries.length ? null : [...(dt.files || [])];
    return { entries, plain };
  }

  async function collect({ entries, plain }) {
    if (plain) return { files: plain.map((f) => ({ file: f, rel: f.name })), dirs: [] };
    const files = [];
    const dirs = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        files.push({ file, rel: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const kids = [];
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          kids.push(...batch);
        }
        if (!kids.length) dirs.push(prefix + entry.name);
        for (const k of kids) await walk(k, `${prefix}${entry.name}/`);
      }
    };
    for (const e of entries) await walk(e, '');
    return { files, dirs };
  }

  function uploadFromInput(input) {
    const files = [...input.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
    input.value = '';
    upload(files, [], fb.path);
  }

  async function upload(files, dirs, target) {
    if (!files.length && !dirs.length) return;
    if (fb.upload) { toast('An upload is still running. Wait for it or cancel it first.'); return; }
    let mode = 'fail';
    let list = files;
    try {
      const { existing } = await api('POST', '/check', { dir: target, rels: files.map((f) => f.rel) });
      if (existing.length) {
        const { button } = await dialog({
          title: `${existing.length === 1 ? 'An item already exists' : `${existing.length} items already exist`} in ${baseName(target)}`,
          list: existing,
          buttons: [
            { label: 'Cancel', value: 'cancel' },
            { label: 'Skip them', value: 'skip' },
            { label: 'Keep both', value: 'rename' },
            { label: 'Replace', value: 'replace', danger: true },
          ],
        });
        if (!button || button === 'cancel') return;
        if (button === 'skip') { const ex = new Set(existing); list = files.filter((f) => !ex.has(f.rel)); }
        else mode = button;
      }
      for (const d of dirs) await api('POST', '/mkdir', { dir: target, rel: d });
    } catch (err) {
      toast(err.message);
      return;
    }
    const job = {
      target, total: list.reduce((a, f) => a + f.file.size, 0), sent: 0, count: list.length, done: 0,
      failed: [], xhrs: new Set(), cancelled: false, started: Date.now(), current: '',
    };
    fb.upload = job;
    renderProgress();
    const queue = list.slice();
    const worker = async () => {
      while (!job.cancelled && queue.length) {
        const it = queue.shift();
        job.current = it.rel;
        try {
          await uploadOne(it, target, mode, job);
        } catch (err) {
          if (!job.cancelled) job.failed.push(`${it.rel}: ${err.message}`);
        }
        job.done++;
        renderProgress();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    fb.upload = null;
    renderProgress();
    const ok = job.done - job.failed.length;
    if (job.cancelled) toast(`Upload cancelled after ${ok} of ${job.count} files.`);
    else if (job.failed.length) {
      dialog({ title: `${job.failed.length} of ${job.count} files failed`, list: job.failed, buttons: [{ label: 'OK', value: 'ok', primary: true }] });
    } else if (list.length || dirs.length) {
      toast(`Uploaded ${list.length} file${list.length === 1 ? '' : 's'} (${fmtSize(job.total)}) to ${tilde(target)}`, 3000);
    }
    if (fb.open && fb.path && (target === fb.path || parentOf(target) === fb.path)) {
      const top = (list[0] || {}).rel || dirs[0] || '';
      go(fb.path, { push: false, select: target === fb.path ? top.split('/')[0] : baseName(target) });
    }
  }

  function uploadOne(it, dir, mode, job) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/files/upload?dir=${enc(dir)}&rel=${enc(it.rel)}&mode=${mode}`);
      let sent = 0;
      xhr.upload.onprogress = (e) => { job.sent += e.loaded - sent; sent = e.loaded; renderProgress(); };
      xhr.onload = () => {
        job.sent += it.file.size - sent;
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let msg = `failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
        if (xhr.status === 401) location.replace('/login');
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.onabort = () => reject(new Error('cancelled'));
      xhr.onloadend = () => job.xhrs.delete(xhr);
      job.xhrs.add(xhr);
      xhr.send(it.file);
    });
  }

  function cancelUpload() {
    const job = fb.upload;
    if (!job) return;
    job.cancelled = true;
    for (const x of job.xhrs) x.abort();
  }

  let progressFrame = 0;
  function renderProgress() {
    if (progressFrame) return;
    progressFrame = requestAnimationFrame(() => {
      progressFrame = 0;
      if (!el.progress) return;
      const job = fb.upload;
      el.progress.hidden = !job;
      if (!job) return;
      const frac = job.total ? Math.min(1, job.sent / job.total) : job.done / Math.max(1, job.count);
      el.progressBar.style.width = `${(frac * 100).toFixed(1)}%`;
      const secs = (Date.now() - job.started) / 1000;
      const rate = secs > 1 ? job.sent / secs : 0;
      el.progressText.textContent = `Uploading ${Math.min(job.done + 1, job.count)} of ${job.count} · ${fmtSize(job.sent)} of ${fmtSize(job.total)}`
        + (rate ? ` · ${fmtSize(rate)}/s` : '');
      el.progressText.title = job.current;
    });
  }

  // ---------------------------------------------------------------- drag & drop

  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dropTarget = null;

  function showDrop(p, rowEl) {
    if (dropTarget && dropTarget.el && dropTarget.el !== rowEl) dropTarget.el.classList.remove('drop-into');
    dropTarget = { path: p, el: rowEl };
    if (rowEl) rowEl.classList.add('drop-into');
    el.drop.hidden = false;
    el.dropName.textContent = tilde(p);
  }

  function hideDrop() {
    if (dropTarget && dropTarget.el) dropTarget.el.classList.remove('drop-into');
    dropTarget = null;
    if (el.drop) el.drop.hidden = true;
  }

  function dirDragOver(e, p, rowEl) {
    if (fb.drag) {
      // Files being moved inside the browser (not uploaded from the computer).
      if (!canDropHere(p)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = (isMac ? e.altKey : e.ctrlKey) ? 'copy' : 'move';
      if (dropTarget && dropTarget.el && dropTarget.el !== rowEl) dropTarget.el.classList.remove('drop-into');
      dropTarget = { path: p, el: rowEl };
      if (rowEl) rowEl.classList.add('drop-into');
      return;
    }
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    showDrop(p, rowEl);
  }

  function dirDrop(e, p) {
    if (fb.drag) {
      if (!canDropHere(p)) return;
      e.preventDefault();
      e.stopPropagation();
      const paths = fb.drag.paths;
      const op = (isMac ? e.altKey : e.ctrlKey) ? 'copy' : 'move';
      hideDrop();
      fb.drag = null;
      transfer(op, paths, p);
      return;
    }
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const taken = takeEntries(e.dataTransfer);
    hideDrop();
    collect(taken).then(({ files, dirs }) => upload(files, dirs, p), (err) => toast(err.message));
  }

  function setupDrop() {
    el.main.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || !fb.path) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = fb.listing && fb.listing.writable ? 'copy' : 'none';
      if (!e.target.closest('.frow') || !dropTarget || !dropTarget.el) showDrop(fb.path, null);
    });
    el.main.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !el.main.contains(e.relatedTarget)) hideDrop();
    });
    el.main.addEventListener('drop', (e) => dirDrop(e, (dropTarget && dropTarget.path) || fb.path));
  }

  // Files dropped anywhere else would make the browser open them in place of
  // this page: open the panel instead.
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || (el.root && el.root.contains(e.target))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e) || (el.root && el.root.contains(e.target))) return;
    e.preventDefault();
    if (fb.available) {
      toast('Open the file browser (folder button) and drop the files on a folder to upload them.');
      open();
    }
  });

  // ---------------------------------------------------------------- open / close

  async function open(where) {
    if (!fb.available) return;
    build();
    fb.open = true;
    el.root.hidden = false;
    $('#app').classList.add('files-open');
    if (mobile.matches) setSidebar(false);
    // Take the keyboard now, not after loading: an Esc typed meanwhile must
    // not reach the program in the terminal.
    el.list.focus({ preventScroll: true });
    if (!fb.info) {
      try { fb.info = await api('GET', '/info'); } catch { /* defaults */ }
    }
    if (!fb.pinsLoaded) loadPins();
    panes.places.applySaved();
    if (where) await reveal(where);
    else if (!fb.path) await go(fb.info ? fb.info.home : '~');
    else await refresh();
    el.list.focus({ preventScroll: true });
  }

  function close({ keepFocus = false } = {}) {
    if (!fb.open) return;
    stopMedia();
    fb.open = false;
    hideMenu();
    hideDrop();
    el.root.hidden = true;
    $('#app').classList.remove('files-open');
    if (!keepFocus) focusActive();
  }

  function toggle() {
    if (fb.open) close(); else open();
  }

  function setAvailable(on) {
    fb.available = on;
    for (const b of document.querySelectorAll('.files-btn')) b.hidden = !on;
    if (!on && fb.open) close();
  }

  for (const b of document.querySelectorAll('.files-btn')) b.addEventListener('click', toggle);

  return { open, close, toggle, setAvailable, isOpen: () => fb.open };
})();
