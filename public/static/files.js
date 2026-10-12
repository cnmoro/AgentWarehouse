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
    view: ['details', 'list', 'small', 'large'].includes(storage('wt.fbView')) ? storage('wt.fbView') : 'details',
    cols: (() => { try { const c = JSON.parse(storage('wt.fbCols') || '{}'); return { vis: Array.isArray(c.vis) ? c.vis : null, w: c.w && typeof c.w === 'object' ? c.w : {} }; } catch { return { vis: null, w: {} }; } })(),
    colSig: '',
    render: storage('wt.fbMd') !== '0', // Markdown files: draw them instead of showing the text
    source: false, // HTML and SVG files: show the text instead of the page
    clip: null,  // { op: 'copy' | 'cut', paths } the files copied or cut inside the browser
    drag: null,  // { dir, names } while rows are being dragged
    edit: null, // { path, data, ed } while the preview shows the editor
    git: { data: null, json: '', message: '', running: null, again: false, busy: false, timer: null, collapsed: new Set(), diff: null, token: 0 }, // the repository of the folder on screen, and the file whose diff is shown
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

  // ---------------------------------------------------------------- saving text

  const hasUnsaved = () => !!((fb.edit && fb.edit.ed && fb.edit.ed.isDirty()) || (fb.gd && fb.gd.isDirty()));

  // Saves text into an existing file. Resolves to { ok, mtime, size }, or { ok: false } when the user chose not to
  // overwrite a file that changed on disk meanwhile (or the save failed, which is shown).
  async function saveText({ path: file, content, bom, eol, expect, force = false }) {
    try {
      const r = await api('PUT', '/write', { path: file, content, bom, eol, expect, force });
      toast('Saved');
      refreshListSoon();
      return { ok: true, mtime: r.mtime, size: r.size };
    } catch (err) {
      if (err.status === 409 && !force) {
        const { button } = await dialog({
          title: 'The file changed on disk',
          message: `${baseName(file)} was changed by something else since you opened it. Saving now would replace those changes with yours.`,
          buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Overwrite', value: 'overwrite', danger: true }],
        });
        if (button === 'overwrite') return saveText({ path: file, content, bom, eol, expect, force: true });
        return { ok: false };
      }
      toast(err.message);
      return { ok: false };
    }
  }

  let listTimer = 0;
  function refreshListSoon() { clearTimeout(listTimer); listTimer = setTimeout(() => { if (fb.open && fb.path) go(fb.path, { push: false }); }, 300); }

  // Before leaving an editor with unsaved changes: save, discard or stay. Resolves to true when it is fine to go on.
  async function confirmLeave() {
    const target = fb.edit && fb.edit.ed && fb.edit.ed.isDirty() ? 'preview' : fb.gd && fb.gd.isDirty() ? 'diff' : null;
    if (!target) return true;
    const { button } = await dialog({
      title: 'Unsaved changes',
      message: 'You changed this file and have not saved it.',
      buttons: [{ label: 'Keep editing', value: 'stay' }, { label: 'Discard', value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }],
    });
    if (button === 'discard') return true;
    if (button === 'save') {
      if (target === 'preview') return (await saveEdit()) === true;
      await fb.gd.save();
      return !fb.gd.isDirty();
    }
    return false;
  }

  // ---------------------------------------------------------------- building

  // ---------------------------------------------------------------- views and columns

  const svgIcon = (d) => `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
  const VIEWS = [
    { id: 'details', label: 'Details', d: 'M2 4h2v2H2zm4 0h12v2H6zM2 9h2v2H2zm4 0h12v2H6zM2 14h2v2H2zm4 0h12v2H6z' },
    { id: 'list', label: 'List', d: 'M2 4h5v2H2zm0 5h5v2H2zm0 5h5v2H2zM9 4h5v2H9zm0 5h5v2H9zm0 5h5v2H9zM16 4h2v2h-2z' },
    { id: 'small', label: 'Small icons', d: 'M2 3h4v4H2zm6 0h4v4H8zm6 0h4v4h-4zM2 9h4v4H2zm6 0h4v4H8zm6 0h4v4h-4zM2 15h4v3H2zm6 0h4v3H8zm6 0h4v3h-4z' },
    { id: 'large', label: 'Large icons', d: 'M2 2h7v7H2zm9 0h7v7h-7zM2 11h7v7H2zm9 0h7v7h-7z' },
  ];
  const VIEW_BUTTONS = VIEWS.map((v, i) => `<button data-view="${v.id}" title="${v.label} (${isMac ? '⌘' : 'Ctrl'}+Shift+${i + 1})" aria-label="${v.label}" aria-pressed="false">${svgIcon(v.d)}</button>`).join('');

  // Details columns. Name is always there; the others can be switched on and
  // off (right-click the header), resized (drag a divider; double-click fits
  // the widest entry) and sorted (click). A tile or list view shows names only.
  const COLUMNS = [
    { key: 'name', label: 'Name' },
    { key: 'size', label: 'Size', w: 90, right: true },
    { key: 'mtime', label: 'Modified', w: 150 },
    { key: 'btime', label: 'Created', w: 150 },
    { key: 'type', label: 'Type', w: 140 },
    { key: 'ext', label: 'Extension', w: 90 },
    { key: 'mode', label: 'Permissions', w: 110 },
    { key: 'owner', label: 'Owner', w: 100 },
  ];
  const DEFAULT_VIS = ['size', 'mtime', 'type'];
  const colDef = (key) => COLUMNS.find((c) => c.key === key);
  const colWidth = (c) => Math.max(c.key === 'name' ? 100 : 50, Math.min(900, fb.cols.w[c.key] || c.w || 0));
  const GAP = 6;
  const NAME_MIN = 160;

  function typeLabel(e) {
    if (e.type === 'dir') return 'Folder';
    if (e.type === 'broken') return 'Broken link';
    if (e.type === 'other') return 'Special file';
    const ext = extOf(e.name).toUpperCase();
    const m = mediaKind(e);
    const k = kindOf(e);
    const noun = m || (k === 'image' ? 'image' : k === 'archive' ? 'archive' : k === 'code' ? 'source file' : k === 'pdf' ? 'document' : k === 'text' ? 'text file' : 'file');
    return ext ? `${ext} ${noun}` : 'File';
  }

  function modeString(mode, type) {
    if (!mode && type !== 'dir') return '';
    const t = 'rwxrwxrwx';
    let out = '';
    for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? t[i] : '-';
    return (type === 'dir' ? 'd' : '-') + out;
  }

  // What each details column shows for an entry, and what it sorts by.
  function cellText(key, e) {
    switch (key) {
      case 'size': return e.type === 'dir' ? '' : fmtSize(e.size);
      case 'mtime': return fmtTime(e.mtime);
      case 'btime': return e.btime ? fmtTime(e.btime) : '—';
      case 'type': return typeLabel(e);
      case 'ext': return e.type === 'dir' ? '' : extOf(e.name);
      case 'mode': return modeString(e.mode, e.type);
      case 'owner': return e.owner || '';
      default: return e.name;
    }
  }
  const cellTitle = (key, e) => (key === 'mtime' && e.mtime ? new Date(e.mtime).toLocaleString()
    : key === 'btime' && e.btime ? new Date(e.btime).toLocaleString()
      : key === 'size' && e.type === 'file' ? `${e.size.toLocaleString()} bytes` : '');

  const visibleKeys = () => (fb.cols.vis || DEFAULT_VIS).filter((k) => k !== 'name' && colDef(k));

  // The columns shown. When the list is narrow (a wide preview beside it, a
  // phone) only the ones that fit: those furthest right drop out.
  function effectiveCols() {
    const name = colDef('name');
    if (fb.view !== 'details') return [name];
    const avail = (el.main && el.main.clientWidth) || 900;
    // Room enough: every column that was chosen shows (sideways scrolling if they are wider than the list).
    if (avail >= 700) return [name, ...visibleKeys().map(colDef)];
    let used = 14 + 24 + GAP + (fb.cols.w.name || NAME_MIN) + 18;
    const out = [name];
    for (const k of visibleKeys()) {
      const c = colDef(k);
      if (used + colWidth(c) + GAP > avail) break;
      used += colWidth(c) + GAP;
      out.push(c);
    }
    return out;
  }

  function applyColumns(cols = effectiveCols()) {
    const nameW = fb.cols.w.name;
    const tracks = ['24px', nameW ? `minmax(100px, ${colWidth(colDef('name'))}px)` : `minmax(${NAME_MIN}px, 1fr)`,
      ...cols.slice(1).map((c) => `${colWidth(c)}px`)];
    let total = 14 + 24 + GAP + (nameW ? colWidth(colDef('name')) : NAME_MIN) + 18;
    for (const c of cols.slice(1)) total += colWidth(c) + GAP;
    el.main.style.setProperty('--cols', tracks.join(' '));
    el.main.style.setProperty('--table-w', `${total}px`);
  }

  const saveCols = () => storage('wt.fbCols', JSON.stringify(fb.cols));

  function renderHeader(cols = effectiveCols()) {
    el.cols.textContent = '';
    el.cols.append(document.createElement('span')); // above the icons
    for (const c of cols) {
      const cell = document.createElement('div');
      cell.className = `colh${c.right ? ' right' : ''}`;
      const b = document.createElement('button');
      b.dataset.sort = c.key;
      b.textContent = c.label;
      const on = fb.sort.key === c.key;
      b.classList.toggle('on', on);
      b.dataset.dir = on ? (fb.sort.dir > 0 ? '▲' : '▼') : '';
      const grip = document.createElement('span');
      grip.className = 'col-grip';
      grip.dataset.key = c.key;
      grip.title = 'Drag to resize · double-click to fit';
      cell.append(b, grip);
      el.cols.append(cell);
    }
    applyColumns(cols);
  }

  function setColWidth(key, px, save = false) {
    fb.cols.w[key] = Math.round(Math.max(key === 'name' ? 100 : 50, Math.min(900, px)));
    applyColumns();
    if (save) saveCols();
  }

  // The width that shows the widest entry (and the heading) of a column.
  function fitColumn(key) {
    const ctx = document.createElement('canvas').getContext('2d');
    const base = key === 'name' ? '13px' : '12px';
    ctx.font = `${base} ${getComputedStyle(document.body).fontFamily}`;
    let w = ctx.measureText(colDef(key).label).width + 24;
    for (const e of fb.shown) w = Math.max(w, ctx.measureText(cellText(key, e)).width + (key === 'size' ? 22 : 12));
    setColWidth(key, Math.ceil(w) + 4, true);
  }

  function setupColumnHeader() {
    el.cols.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('.col-grip');
      if (!g || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      const key = g.dataset.key;
      const startX = e.clientX;
      const startW = g.parentElement.getBoundingClientRect().width;
      el.root.classList.add('resizing');
      const move = (ev) => setColWidth(key, startW + ev.clientX - startX);
      const end = (ev) => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', end);
        g.removeEventListener('pointercancel', end);
        el.root.classList.remove('resizing');
        setColWidth(key, startW + ev.clientX - startX, true);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', end);
      g.addEventListener('pointercancel', end);
    });
    el.cols.addEventListener('dblclick', (e) => {
      const g = e.target.closest('.col-grip');
      if (g) fitColumn(g.dataset.key);
    });
    // Clicking a divider must not sort.
    el.cols.addEventListener('click', (e) => { if (e.target.closest('.col-grip')) e.stopImmediatePropagation(); }, true);
    el.cols.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const vis = new Set(visibleKeys());
      showMenu(e.clientX, e.clientY, [
        ...COLUMNS.filter((c) => c.key !== 'name').map((c) => ({
          label: `${vis.has(c.key) ? '✓' : ' '}  ${c.label}`,
          action: () => toggleColumn(c.key),
        })),
        { sep: true },
        { label: 'Fit all columns', action: () => { for (const c of effectiveCols()) fitColumn(c.key); } },
        { label: 'Reset columns', action: () => { fb.cols = { vis: null, w: {} }; saveCols(); renderList(); } },
      ]);
    });
  }

  function toggleColumn(key) {
    const vis = new Set(visibleKeys());
    if (vis.has(key)) vis.delete(key); else vis.add(key);
    fb.cols.vis = COLUMNS.filter((c) => vis.has(c.key)).map((c) => c.key); // always in the table's order
    saveCols();
    renderList();
  }

  function setView(v) {
    if (!VIEWS.some((x) => x.id === v) || v === fb.view) return;
    fb.view = v;
    storage('wt.fbView', v);
    renderList();
    el.list.focus({ preventScroll: true });
    const row = fb.cursor && el.list.querySelector(`.frow[data-name="${CSS.escape(fb.cursor)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

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
            <div class="view-switch" role="group" aria-label="View">${VIEW_BUTTONS}</div>
          </div>
          <div class="files-table">
            <div class="files-cols" title="Right-click to choose the columns"></div>
            <div class="files-list" role="listbox" tabindex="0" aria-multiselectable="true" aria-label="Folder contents"></div>
          </div>
          <div class="files-empty" hidden></div>
          <div class="files-drop" hidden><div class="files-drop-box">Drop to upload into <b></b></div></div>
        </div>
        <div class="files-resizer files-pv-resizer" role="separator" aria-orientation="vertical" aria-label="Resize preview"
             tabindex="0" title="Drag to resize · double-click to reset"></div>
        <aside class="files-preview" hidden aria-label="Preview"></aside>
        <section class="files-diff" hidden aria-label="Changes of a file"></section>
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
      filter: q('.files-filter'), hidden: q('.files-hidden'), cols: q('.files-cols'), table: q('.files-table'), preview: q('.files-preview'),
      count: q('.files-count'), drop: q('.files-drop'), dropName: q('.files-drop b'), main: q('.files-main'),
      progress: q('.files-progress'), progressBar: q('.files-progress-bar div'), progressText: q('.files-progress-text'),
      inputFiles: q('.files-input-files'), inputDir: q('.files-input-dir'), pinBtn: q('[data-act="pin"]'), diff: q('.files-diff'),
    });
    el.hidden.checked = fb.showHidden;
    setupResizers();
    fb.gd = GitDiff.create(el.diff, { onClose: closeDiff, onFile: stepDiff, storage, save: saveText, confirmLeave, reload: () => (fb.git.diff ? openDiff(fb.git.diff, { keepScroll: true }) : undefined) });
    window.addEventListener('beforeunload', (ev) => { if (hasUnsaved()) { ev.preventDefault(); ev.returnValue = ''; } });
    new ResizeObserver(placeDiff).observe(el.places);

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && root.contains(b)) runAction(b.dataset.act);
    });
    el.cols.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      const text = !['size', 'mtime', 'btime', 'mode'].includes(b.dataset.sort);
      fb.sort = fb.sort.key === b.dataset.sort ? { key: b.dataset.sort, dir: -fb.sort.dir } : { key: b.dataset.sort, dir: text ? 1 : -1 };
      storage('wt.fbSort', JSON.stringify(fb.sort));
      renderList();
    });
    el.filter.addEventListener('input', () => { fb.filter = el.filter.value; renderList(); });
    el.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.filter.value = ''; fb.filter = ''; renderList(); el.list.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); el.list.focus(); if (!fb.sel.size && fb.shown[0]) selectOnly(fb.shown[0].name); }
    });
    el.root.querySelector('.view-switch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) setView(b.dataset.view);
    });
    setupColumnHeader();
    // The columns that fit, and the list view's rows, follow the size of the list.
    let rzTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        if (!fb.open || !fb.listing) return;
        if (effectiveCols().map((c) => c.key).join() !== fb.colSig) renderList(); else fitListRows();
      }, 60);
    }).observe(el.main);
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
    if ((push || target !== fb.path) && hasUnsaved() && !(await confirmLeave())) return false;
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
    refreshGit();
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
    el.changes = document.createElement('div');
    el.changes.className = 'files-changes';
    el.places.append(el.changes);
    renderChanges();
  }

  // ---------------------------------------------------------------- git changes

  const KIND = {
    M: { letter: 'M', cls: 'm', label: 'Modified' }, A: { letter: 'A', cls: 'a', label: 'Added' }, D: { letter: 'D', cls: 'd', label: 'Deleted' },
    R: { letter: 'R', cls: 'r', label: 'Renamed' }, C: { letter: 'C', cls: 'r', label: 'Copied' }, T: { letter: 'T', cls: 'm', label: 'Type changed' },
    U: { letter: '!', cls: 'x', label: 'Merge conflict' }, '?': { letter: 'U', cls: 'u', label: 'Untracked' },
  };

  // The changes as the groups the list shows: conflicts, staged, then the rest (a file can be in two of them).
  function changeGroups(data) {
    const groups = [
      { id: 'conflict', title: 'Conflicts', side: 'conflict', items: [] },
      { id: 'staged', title: 'Staged', side: 'staged', items: [] },
      { id: 'changes', title: 'Changes', side: 'worktree', items: [] },
    ];
    for (const c of data.changes) {
      if (c.conflict) { groups[0].items.push({ ...c, k: KIND.U, side: 'conflict' }); continue; }
      if (c.x !== '.') groups[1].items.push({ ...c, k: KIND[c.x] || KIND.M, side: 'staged' });
      if (c.y !== '.') groups[2].items.push({ ...c, k: KIND[c.y] || KIND.M, side: 'worktree', orig: undefined });
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    for (const g of groups) g.items.sort((a, b) => coll.compare(a.path, b.path));
    return groups.filter((g) => g.items.length);
  }
  const sameChange = (a, b) => a && b && a.path === b.path && a.side === b.side;

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // The Changes section is built in two parts: a head (branch, buttons, commit box) that is made once and then only
  // updated, so the message being typed is not lost when the list refreshes, and the list of files, drawn again.
  function renderChanges() {
    if (!el.changes) return;
    const data = fb.git.data;
    if (!data || !data.repo) { el.changes.textContent = ''; return; }
    if (!el.changes.firstChild) buildChangesHead();
    updateChangesHead(data);
    renderChangeList(data);
  }

  function gitButton(label, title, onclick, cls = 'tool-btn') {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.onclick = onclick;
    return b;
  }

  function buildChangesHead() {
    const head = document.createElement('div');
    head.className = 'places-title chg-title';
    const t = document.createElement('span');
    t.textContent = 'Changes';
    const br = gitButton('', '', (ev) => branchMenu(ev), 'chg-branch');
    head.append(t, br);
    const bar = document.createElement('div');
    bar.className = 'chg-bar';
    const pull = gitButton('↓', 'Pull', () => gitAct('Pull', { action: 'pull' }));
    const push = gitButton('↑', 'Push', () => gitAct('Push', { action: 'push' }));
    const sync = gitButton('⟳', 'Sync: pull, then push', () => gitAct('Sync', { action: 'sync' }));
    const more = gitButton('⋯', 'More git actions', (ev) => moreMenu(ev));
    pull.classList.add('chg-pull');
    push.classList.add('chg-push');
    bar.append(pull, push, sync, more);
    const box = document.createElement('div');
    box.className = 'chg-commit';
    const msg = document.createElement('textarea');
    msg.className = 'chg-msg';
    msg.rows = 2;
    msg.placeholder = 'Message (Ctrl+Enter to commit)';
    msg.spellcheck = true;
    msg.value = fb.git.message || '';
    msg.addEventListener('input', () => { fb.git.message = msg.value; });
    msg.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); doCommit(); } });
    const row = document.createElement('div');
    row.className = 'chg-commitrow';
    const commit = gitButton('✓ Commit', 'Commit the staged changes', () => doCommit(), 'tool-btn primary-btn chg-commitbtn');
    const variants = gitButton('▾', 'Other ways to commit', (ev) => commitMenu(ev), 'tool-btn chg-commitmore');
    row.append(commit, variants);
    box.append(msg, row);
    const status = document.createElement('div');
    status.className = 'chg-run';
    status.setAttribute('aria-live', 'polite');
    const list = document.createElement('div');
    list.className = 'chg-list';
    el.changes.append(head, bar, box, status, list);
  }

  function updateChangesHead(data) {
    const g = fb.git;
    const q = (s) => el.changes.querySelector(s);
    const where = data.detached ? `(${data.oid || 'detached'})` : data.branch || '(no commits)';
    const br = q('.chg-branch');
    br.textContent = `⎇ ${where}${data.ahead ? ` ↑${data.ahead}` : ''}${data.behind ? ` ↓${data.behind}` : ''}`;
    br.title = `${data.name}: ${data.detached ? 'detached HEAD' : `branch ${where}`}${data.upstream ? ` · tracking ${data.upstream}` : ''}${data.ahead || data.behind ? ` · ${data.ahead} ahead, ${data.behind} behind` : ''}\nClick to switch or create a branch`;
    const groups = changeGroups(data);
    const count = (id) => (groups.find((x) => x.id === id) || { items: [] }).items.length;
    const staged = count('staged');
    const pull = q('.chg-pull');
    const push = q('.chg-push');
    pull.textContent = data.behind ? `↓ ${data.behind}` : '↓';
    push.textContent = data.ahead ? `↑ ${data.ahead}` : '↑';
    pull.title = data.upstream ? `Pull from ${data.upstream}` : 'Pull (this branch has no upstream)';
    push.title = data.upstream ? `Push to ${data.upstream}` : 'Push, creating the branch on the remote';
    const commit = q('.chg-commitbtn');
    const all = !staged && (count('changes') + count('conflict') > 0);
    commit.textContent = all ? '✓ Commit All' : '✓ Commit';
    commit.title = all ? 'Nothing is staged: stage every change and commit them' : `Commit the ${plural(staged, 'staged file')}`;
    const busy = !!g.running;
    for (const b of el.changes.querySelectorAll('.chg-bar button, .chg-commitrow button')) b.disabled = busy;
    q('.chg-run').textContent = busy ? `${g.running}…` : '';
  }

  const guard = (fn) => (ev) => { ev.stopPropagation(); fn(ev); };

  function renderChangeList(data) {
    const list = el.changes.querySelector('.chg-list');
    list.textContent = '';
    const groups = changeGroups(data);
    if (!groups.length) {
      const hint = document.createElement('div');
      hint.className = 'places-hint';
      hint.textContent = `${data.name}: no changes.`;
      list.append(hint);
      return;
    }
    for (const g of groups) {
      const open = !fb.git.collapsed.has(g.id);
      const h = document.createElement('div');
      h.className = 'chg-group';
      h.setAttribute('role', 'button');
      h.tabIndex = 0;
      h.setAttribute('aria-expanded', String(open));
      const caret = document.createElement('span');
      caret.className = 'chg-caret';
      caret.textContent = open ? '▾' : '▸';
      const gname = document.createElement('span');
      gname.className = 'chg-gname';
      gname.textContent = g.title;
      const acts = document.createElement('span');
      acts.className = 'chg-acts';
      const act = (label, title, fn, cls = '') => { const b = gitButton(label, title, guard(fn), `chg-act ${cls}`); b.disabled = !!fb.git.running; acts.append(b); };
      if (g.id === 'staged') act('−', 'Unstage all', () => gitAct('Unstage', { action: 'unstage', all: true }));
      if (g.id === 'changes') {
        act('↶', 'Discard all changes', () => discardItems(g.items), 'danger');
        act('＋', 'Stage all', () => gitAct('Stage', { action: 'stage', all: true }));
      }
      if (g.id === 'conflict') act('＋', 'Mark all as resolved (stage)', () => gitAct('Stage', { action: 'stage', paths: g.items.map((c) => c.path) }));
      const cnt = document.createElement('span');
      cnt.className = 'chg-count';
      cnt.textContent = String(g.items.length);
      h.append(caret, gname, acts, cnt);
      const toggle = () => { if (fb.git.collapsed.has(g.id)) fb.git.collapsed.delete(g.id); else fb.git.collapsed.add(g.id); renderChanges(); };
      h.onclick = toggle;
      h.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
      list.append(h);
      if (!open) continue;
      for (const c of g.items) list.append(changeRow(c, g));
    }
    if (data.truncated) {
      const hint = document.createElement('div');
      hint.className = 'places-hint';
      hint.textContent = 'Only the first changes are listed.';
      list.append(hint);
    }
  }

  function changeRow(c, g) {
    const b = document.createElement('div');
    b.className = 'chg';
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    if (sameChange(c, fb.git.diff)) b.classList.add('on');
    const i = c.path.lastIndexOf('/');
    const badge = document.createElement('span');
    badge.className = `chg-badge st-${c.k.cls}`;
    badge.textContent = c.k.letter;
    const name = document.createElement('span');
    name.className = 'chg-name';
    name.textContent = c.path.slice(i + 1);
    const dir = document.createElement('span');
    dir.className = 'chg-dir';
    dir.textContent = i >= 0 ? c.path.slice(0, i) : '';
    const acts = document.createElement('span');
    acts.className = 'chg-acts';
    const busy = !!fb.git.running;
    const act = (label, title, fn, cls = '') => { const x = gitButton(label, title, guard(fn), `chg-act ${cls}`); x.disabled = busy; acts.append(x); };
    if (g.id === 'staged') act('−', 'Unstage', () => gitAct('Unstage', { action: 'unstage', paths: c.orig ? [c.path, c.orig] : [c.path] }));
    else {
      act('↶', c.k === KIND['?'] ? 'Delete this untracked file' : 'Discard the changes in this file', () => discardItems([c]), 'danger');
      act('＋', 'Stage', () => gitAct('Stage', { action: 'stage', paths: [c.path] }));
    }
    b.append(badge, name, dir, acts);
    b.title = `${c.path}${c.orig ? `\n(renamed from ${c.orig})` : ''}\n${c.k.label}`;
    b.onclick = () => openDiff(c);
    b.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDiff(c); } };
    return b;
  }

  // ---- git actions

  const firstLine = (text) => (String(text || '').split('\n').find((l) => l.trim()) || '').trim().slice(0, 140);

  // Runs one git action in the repository on screen, then refreshes the list. Resolves to the answer, or null when it failed
  // (git's own message is shown then).
  async function gitAct(label, body) {
    const g = fb.git;
    if (!g.data || g.running) return null;
    g.running = label;
    renderChanges();
    try {
      const r = await api('POST', '/git/action', { repo: g.data.repo, ...body });
      toast(`${label}: ${firstLine(r.output) || 'done'}`);
      return r;
    } catch (err) {
      await dialog({ title: `${label} failed`, message: err.message, buttons: [{ label: 'OK', value: 'ok', primary: true }] });
      return null;
    } finally {
      g.running = null;
      await refreshGit(true);
      renderChanges();
    }
  }

  async function discardItems(items) {
    const tracked = items.filter((c) => c.k !== KIND['?']).map((c) => c.path);
    const untracked = items.filter((c) => c.k === KIND['?']).map((c) => c.path);
    const what = items.length === 1 ? baseName(items[0].path) : `${items.length} files`;
    const { button } = await dialog({
      title: 'Discard changes',
      message: `${untracked.length ? 'Untracked files are deleted for good. ' : ''}The changes in ${what} are lost and cannot be recovered.`,
      list: items.map((c) => c.path),
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'go', danger: true }],
    });
    if (button !== 'go') return;
    await gitAct('Discard', { action: 'discard', paths: tracked, untracked });
  }

  async function doCommit({ amend = false, stageAll = false, then = null } = {}) {
    const g = fb.git;
    if (!g.data || g.running) return;
    const msg = (g.message || '').trim();
    const groups = changeGroups(g.data);
    const n = (id) => (groups.find((x) => x.id === id) || { items: [] }).items.length;
    if (!msg && !amend) {
      toast('Type a commit message first.');
      el.changes.querySelector('.chg-msg')?.focus();
      return;
    }
    let all = stageAll;
    if (!n('staged') && !amend && !all) {
      if (!(n('changes') + n('conflict'))) { toast('Nothing to commit.'); return; }
      const { button } = await dialog({
        title: 'No staged changes', message: 'Nothing is staged. Stage all the changes and commit them?',
        buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Stage all and commit', value: 'go', primary: true }],
      });
      if (button !== 'go') return;
      all = true;
    }
    const r = await gitAct(amend ? 'Amend' : 'Commit', { action: 'commit', message: msg, amend, stageAll: all });
    if (!r) return;
    g.message = '';
    const box = el.changes.querySelector('.chg-msg');
    if (box) box.value = '';
    if (then === 'push') await gitAct('Push', { action: 'push' });
    if (then === 'sync') await gitAct('Sync', { action: 'sync' });
  }

  function menuAt(ev, items) {
    const r = ev.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, items);
  }

  function commitMenu(ev) {
    menuAt(ev, [
      { label: 'Commit', action: () => doCommit() },
      { label: 'Commit All (stage everything)', action: () => doCommit({ stageAll: true }) },
      { label: 'Commit (Amend last commit)', action: () => doCommit({ amend: true }) },
      { sep: true },
      { label: 'Commit & Push', action: () => doCommit({ then: 'push' }) },
      { label: 'Commit & Sync', action: () => doCommit({ then: 'sync' }) },
    ]);
  }

  function moreMenu(ev) {
    const d = fb.git.data;
    menuAt(ev, [
      { label: 'Pull', action: () => gitAct('Pull', { action: 'pull' }) },
      { label: 'Pull (Rebase)', action: () => gitAct('Pull', { action: 'pull', rebase: true }) },
      { label: 'Push', action: () => gitAct('Push', { action: 'push' }) },
      { label: 'Push (Force, with lease)…', action: async () => {
        const { button } = await dialog({ title: 'Force push', message: 'This replaces the branch on the remote with yours, discarding commits there that you do not have. It is refused if someone pushed in the meantime (--force-with-lease).', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Force push', value: 'go', danger: true }] });
        if (button === 'go') gitAct('Push', { action: 'push', force: true });
      } },
      { label: 'Fetch', action: () => gitAct('Fetch', { action: 'fetch' }) },
      { label: 'Sync (pull, then push)', action: () => gitAct('Sync', { action: 'sync' }) },
      { sep: true },
      { label: 'Switch branch…', action: () => branchMenuAt(ev.currentTarget) },
      { label: 'Create branch…', action: () => createBranch() },
      { sep: true },
      { label: 'Stash', action: () => gitAct('Stash', { action: 'stash' }) },
      { label: 'Stash (include untracked)', action: () => gitAct('Stash', { action: 'stash', untracked: true }) },
      { label: d && d.stashes ? `Pop stash (${d.stashes})` : 'Pop stash', disabled: !(d && d.stashes), action: () => gitAct('Pop stash', { action: 'stashPop' }) },
      { sep: true },
      { label: 'Undo last commit (keep the changes)', action: async () => {
        const { button } = await dialog({ title: 'Undo last commit', message: 'The last commit is undone and its changes are staged again. Nothing is lost.', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Undo commit', value: 'go', primary: true }] });
        if (button === 'go') gitAct('Undo commit', { action: 'undoCommit' });
      } },
    ]);
  }

  async function branchMenu(ev) { branchMenuAt(ev.currentTarget); }

  async function branchMenuAt(anchor) {
    const g = fb.git;
    if (!g.data) return;
    let list;
    try { list = (await api('GET', `/git/branches?repo=${enc(g.data.repo)}`)).branches; } catch (err) { toast(err.message); return; }
    const r = anchor.getBoundingClientRect();
    const items = [{ label: '＋ Create new branch…', action: () => createBranch() }, { sep: true }];
    for (const b of list.slice(0, 40)) {
      items.push({
        label: `${b.current ? '✓ ' : ''}${b.name}`, hint: b.remote ? 'remote' : b.upstream ? '' : '', disabled: b.current,
        action: () => gitAct('Switch branch', { action: 'checkout', branch: b.remote ? b.name.slice(b.name.indexOf('/') + 1) : b.name }),
      });
    }
    if (list.length > 40) items.push({ label: `…and ${list.length - 40} more (use the terminal)`, disabled: true, action() {} });
    showMenu(r.left, r.bottom + 2, items);
  }

  async function createBranch() {
    const { button, value } = await dialog({ title: 'Create branch', message: 'Name of the new branch (it starts from the current one and is switched to):', input: '', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', value: 'go', primary: true }] });
    if (button === 'go' && value) gitAct('Create branch', { action: 'createBranch', name: value });
  }

  const insideRepo = (repo, p) => !!p && (p === repo || p.startsWith(repo === '/' ? '/' : `${repo}/`));

  // Ask which repository the folder on screen belongs to, and what changed in it.
  async function refreshGit(force = false) {
    const g = fb.git;
    if (!fb.info || !fb.info.git || !fb.path) return;
    if (g.busy) { if (force) g.again = true; return; }
    if (g.data && g.data.repo && !insideRepo(g.data.repo, fb.path)) { g.data = null; g.json = ''; renderChanges(); if (g.diff) closeDiff(); }
    g.busy = true;
    const asked = fb.path;
    try {
      const data = await api('GET', `/git/status?path=${enc(asked)}`);
      if (asked !== fb.path) return;
      const json = JSON.stringify(data);
      if (force || json !== g.json) {
        const sigs = new Map((g.data && g.data.changes || []).map((c) => [`${c.path}`, c.sig]));
        g.json = json;
        g.data = data.repo ? data : null;
        renderChanges();
        syncDiff(sigs);
      }
    } catch { /* not a repository, or git is busy: leave the list as it is */ } finally {
      g.busy = false;
      if (g.again) { g.again = false; refreshGit(true); }
    }
  }

  function startGitPolling() {
    stopGitPolling();
    fb.git.timer = setInterval(() => { if (fb.open && !document.hidden) refreshGit(); }, 5000);
  }
  function stopGitPolling() { clearInterval(fb.git.timer); fb.git.timer = null; }

  // ---- the diff of one file

  // The diff view covers the list and the preview, right of the Places column.
  function placeDiff() {
    if (!el.diff) return;
    const r = el.root.querySelector('.files-pl-resizer');
    el.diff.style.left = `${el.places.offsetWidth + (r ? r.offsetWidth : 0)}px`;
  }

  const metaOf = (c) => ({ abs: fb.git.data ? join(fb.git.data.repo, c.path) : c.path, path: c.path, orig: c.orig, letter: c.k.letter, cls: c.k.cls, label: c.k.label, sideLabel: c.side === 'staged' ? 'Staged' : c.side === 'conflict' ? 'Merge conflict' : c.k === KIND['?'] ? 'Untracked' : 'Working tree' });

  async function openDiff(c, { keepScroll = false } = {}) {
    const g = fb.git;
    if (!g.data) return;
    if (fb.gd.isEditing() && !keepScroll) {
      if (!(await confirmLeave())) return;
      fb.gd.abortEdit();
    }
    const mine = ++g.token;
    g.diff = { path: c.path, side: c.side, orig: c.orig, sig: c.sig, k: c.k };
    placeDiff();
    renderChanges();
    if (!keepScroll) { el.diff.hidden = false; el.diff.classList.add('loading'); }
    try {
      const q = `repo=${enc(g.data.repo)}&path=${enc(c.path)}&side=${c.side}${c.orig ? `&orig=${enc(c.orig)}` : ''}`;
      const data = await api('GET', `/git/diff?${q}`);
      if (mine !== g.token) return;
      el.diff.classList.remove('loading');
      await fb.gd.show(data, metaOf(c));
      if (!keepScroll) fb.gd.focus();
    } catch (err) {
      if (mine !== g.token) return;
      el.diff.classList.remove('loading');
      fb.gd.message(metaOf(c), err.message);
    }
  }

  function closeDiff() {
    const g = fb.git;
    if (!g.diff && el.diff.hidden) return false;
    if (fb.gd && fb.gd.isDirty()) { confirmLeave().then((ok) => { if (ok) closeDiffNow(); }); return true; }
    closeDiffNow();
    return true;
  }
  function closeDiffNow() {
    const g = fb.git;
    g.token++;
    g.diff = null;
    if (fb.gd) fb.gd.hide();
    renderChanges();
    el.list.focus({ preventScroll: true });
  }

  // Another changed file, in the order of the list.
  function stepDiff(dir) {
    const g = fb.git;
    if (!g.data || !g.diff) return;
    const all = changeGroups(g.data).flatMap((x) => x.items);
    const i = all.findIndex((c) => sameChange(c, g.diff));
    const next = all[(Math.max(i, 0) + dir + all.length) % all.length];
    if (next) openDiff(next);
  }

  // The list was refreshed: keep the diff that is open in step with it.
  function syncDiff(oldSigs) {
    const g = fb.git;
    if (!g.diff || !g.data || fb.gd.isEditing()) return;
    const c = changeGroups(g.data).flatMap((x) => x.items).find((x) => sameChange(x, g.diff));
    if (!c) {
      // Staged or unstaged meanwhile: follow the file to its other group.
      const other = changeGroups(g.data).flatMap((x) => x.items).find((x) => x.path === g.diff.path);
      if (other) { openDiff(other, { keepScroll: true }); return; }
      fb.gd.message(metaOf({ ...g.diff, k: g.diff.k }), 'This file has no changes any more.');
      g.diff.gone = true;
      return;
    }
    if (g.diff.gone || c.sig !== g.diff.sig || oldSigs.get(c.path) !== c.sig) openDiff(c, { keepScroll: !g.diff.gone });
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
    const num = { size: 'size', mtime: 'mtime', btime: 'btime', mode: 'mode' }[key];
    return [...list].sort((a, b) => {
      const da = a.type === 'dir' ? 0 : 1;
      const db = b.type === 'dir' ? 0 : 1;
      if (da !== db) return da - db; // folders first, whatever the order
      let c = 0;
      if (num) c = (a[num] || 0) - (b[num] || 0);
      else if (key !== 'name') c = coll.compare(cellText(key, a), cellText(key, b));
      if (!c) c = coll.compare(a.name, b.name);
      return c * dir;
    });
  }

  const THUMB_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|mp4|m4v|webm|ogv|mov|mkv|avi)$/i;

  // The list view flows top to bottom in columns: as many rows as fit.
  function fitListRows() {
    if (fb.view !== 'list') return;
    el.list.style.setProperty('--rows', String(Math.max(1, Math.floor(((el.list.clientHeight || 300) - 16) / 28))));
  }

  function renderList() {
    if (!fb.listing) return;
    fb.shown = sortedEntries();
    const cols = effectiveCols();
    fb.colSig = cols.map((c) => c.key).join();
    el.main.dataset.view = fb.view;
    el.list.className = `files-list v-${fb.view}`;
    for (const b of el.root.querySelectorAll('.view-switch [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === fb.view));
    if (fb.view === 'details') renderHeader(cols);
    const tiles = fb.view === 'small' || fb.view === 'large';
    const thumbs = tiles && fb.info && fb.info.thumbs;
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
      name.title = e.link ? `${e.name} (link)` : e.name;
      if (tiles) {
        const art = document.createElement('span');
        art.className = 'tile-art';
        art.append(icon(e));
        const ext = extOf(e.name);
        if (e.type === 'file' && (ext === 'svg' || (thumbs && THUMB_EXT_RE.test(e.name)))) {
          const img = document.createElement('img');
          img.className = 'thumb';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.draggable = false;
          img.alt = '';
          const p = join(fb.path, e.name);
          img.src = ext === 'svg' ? `/api/files/raw?inline=1&path=${enc(p)}` : `/api/files/thumb?w=${fb.view === 'large' ? 256 : 128}&path=${enc(p)}`;
          img.onerror = () => img.remove(); // the icon stays
          art.append(img);
        }
        row.append(art, name);
      } else if (fb.view === 'list') {
        row.append(icon(e), name);
      } else {
        row.append(icon(e), name);
        for (const c of cols.slice(1)) {
          const cell = document.createElement('span');
          cell.className = `fcell c-${c.key}`;
          cell.textContent = cellText(c.key, e);
          const t = cellTitle(c.key, e);
          if (t) cell.title = t;
          row.append(cell);
        }
      }
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
    fitListRows();
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
    if (row && e.target.closest('.fname, .ficon, .tile-art')) {
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
      const dx = fb.view === 'list' ? (last.clientX < r.left + 24 ? -(r.left + 24 - last.clientX) : last.clientX > r.right - 24 ? last.clientX - (r.right - 24) : 0) : 0;
      if (dy || dx) { list.scrollTop += Math.max(-24, Math.min(24, dy)); list.scrollLeft += Math.max(-24, Math.min(24, dx)); update(); }
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

  // "Move to…" / "Copy to…": ask for the folder (the one above is offered), as an
  // absolute path, one starting with ~, or relative to this folder (../x, sub).
  async function chooseFolderFor(op) {
    const paths = pathsOfSelection();
    if (!paths.length) return;
    const what = paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`;
    const { button, value } = await dialog({
      title: `${op === 'move' ? 'Move' : 'Copy'} ${what} to…`,
      message: 'A folder: absolute (/home/me/x), from home (~/x) or relative to this folder (../x).',
      input: tilde(parentOf(fb.path) || '/'),
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: op === 'move' ? 'Move' : 'Copy', value: 'ok', primary: true }],
    });
    el.list.focus({ preventScroll: true });
    if (button !== 'ok' || !value) return;
    let to = value;
    if (!to.startsWith('/') && !to.startsWith('~')) to = `${fb.path}/${to}`;
    // Resolve "." and ".." here, so the message and the server see the same folder.
    if (to.startsWith('/')) {
      const out = [];
      for (const seg of to.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); }
      to = `/${out.join('/')}`;
    }
    transfer(op, paths, to);
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

  // How far one arrow key moves in the current view: down a row in details,
  // along a row in the tile views (down = a whole row of tiles), along a column in the list.
  function layoutSteps() {
    const kids = el.list.querySelectorAll('.frow');
    const first = kids[0];
    const rowH = first ? first.offsetHeight : 30;
    if (!first || fb.view === 'details') return { down: 1, right: 0, rowH };
    if (fb.view === 'list') {
      let n = 0;
      for (const k of kids) { if (k.offsetLeft === first.offsetLeft) n++; else break; }
      return { down: 1, right: Math.max(1, n), rowH };
    }
    let n = 0;
    for (const k of kids) { if (k.offsetTop === first.offsetTop) n++; else break; }
    return { down: Math.max(1, n), right: 1, rowH };
  }

  function onListKey(e) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const cur = fb.shown.find((x) => x.name === fb.cursor);
    const lay = layoutSteps();
    const page = Math.max(1, Math.floor(el.list.clientHeight / Math.max(20, lay.rowH)) - 1) * Math.max(1, Math.abs(lay.down));
    if (e.key === 'ArrowDown') moveCursor(lay.down, e.shiftKey);
    else if (e.key === 'ArrowUp' && e.altKey) up();
    else if (e.key === 'ArrowUp') moveCursor(-lay.down, e.shiftKey);
    else if (e.key === 'ArrowRight' && lay.right) moveCursor(lay.right, e.shiftKey);
    else if (e.key === 'ArrowLeft' && lay.right) moveCursor(-lay.right, e.shiftKey);
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
    if (mod && !e.shiftKey && e.code === 'KeyS' && ((fb.edit && fb.edit.ed) || (fb.gd && fb.gd.isEditing()))) { e.preventDefault(); if (fb.gd && fb.gd.isEditing()) fb.gd.save(); else saveEdit(); return; }
    if (e.target.tagName === 'TEXTAREA' && e.key !== 'Escape') return; // typing in the editor
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hideMenu()) return;
      if (fb.gd && fb.gd.isEditing()) { fb.gd.leaveEditAsk(); return; }
      if (closeDiff()) return;
      if (fb.edit) { confirmLeave().then((ok) => { if (ok) stopEdit(); }); return; }
      if (!el.preview.hidden) { closePreview(); el.list.focus(); return; }
      close();
    } else if (mod && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); close(); }
    else if (mod && e.shiftKey && /^Digit[1-4]$/.test(e.code)) { e.preventDefault(); setView(VIEWS[Number(e.code.slice(5)) - 1].id); }
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

  // The preview becomes an editor for the file. Save with the button or Ctrl+S.
  function startEdit(e, p, data, body, actions) {
    for (const b of actions.querySelectorAll('button, label')) b.hidden = true;
    const bar = document.createElement('div');
    bar.className = 'pv-editbar';
    const dot = document.createElement('span');
    dot.className = 'gd-dirty';
    dot.textContent = '●';
    dot.title = 'Unsaved changes';
    dot.hidden = true;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'tool-btn primary-btn';
    saveBtn.textContent = 'Save';
    saveBtn.title = 'Save (Ctrl+S)';
    const done = document.createElement('button');
    done.className = 'tool-btn';
    done.textContent = 'Done';
    done.title = 'Stop editing (asks first when there are unsaved changes)';
    const hint = document.createElement('span');
    hint.className = 'pv-edithint';
    hint.textContent = `${data.eol === 'crlf' ? 'CRLF · ' : ''}${fmtSize(data.size)}`;
    bar.append(dot, saveBtn, done, hint);
    body.textContent = '';
    const host = document.createElement('div');
    host.className = 'pv-editor';
    body.append(bar, host);
    const lang = GitDiff.languageOf(p);
    const ed = Editor.create(host, { text: data.text, lang, onDirty: (d) => { dot.hidden = !d; }, onSave: () => saveEdit() });
    fb.edit = { path: p, data, ed, entry: e };
    saveBtn.onclick = () => saveEdit();
    done.onclick = async () => { if (await confirmLeave()) stopEdit(); };
    ed.focus();
  }

  // Resolves to true when the text was saved.
  async function saveEdit() {
    const x = fb.edit;
    if (!x || x.saving) return false;
    x.saving = true;
    try {
      const r = await saveText({ path: x.path, content: x.ed.getText(), bom: !!x.data.bom, eol: x.data.eol, expect: { mtime: x.data.mtime, size: x.data.size } });
      if (r.ok && fb.edit === x) { x.data.mtime = r.mtime; x.data.size = r.size; x.ed.markSaved(); }
      return !!r.ok;
    } finally { x.saving = false; if (fb.edit === x) x.ed.focus(); }
  }

  // Leave the editor and show the preview again (read from disk).
  function stopEdit() {
    const x = fb.edit;
    if (!x) return;
    fb.edit = null;
    x.ed.destroy();
    if (fb.previewPath === x.path && x.entry) showPreview(x.entry, { play: false });
  }

  function closePreview() {
    if (fb.edit) { fb.edit.ed.destroy(); fb.edit = null; }
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
    if (fb.edit && fb.edit.path !== join(fb.path, e.name) && !(await confirmLeave())) return;
    if (fb.edit) { fb.edit.ed.destroy(); fb.edit = null; }
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
    const ext = extOf(e.name);
    // HTML and SVG can be shown or read as source.
    const canSource = ext === 'html' || ext === 'htm' || ext === 'xhtml' || ext === 'svg';
    if (canSource) {
      const b = act(fb.source ? 'Show it' : 'View source', () => { fb.source = !fb.source; showPreview(e, { play }); });
      b.title = fb.source ? 'Show the rendered page' : 'Show the file as text';
    }
    if (kind === 'image' && !(canSource && fb.source)) {
      const img = document.createElement('img');
      img.className = 'pv-image';
      img.alt = e.name;
      img.src = `/api/files/raw?inline=1&path=${enc(p)}`;
      img.onerror = () => { body.textContent = 'This image could not be shown.'; };
      img.title = 'Click to zoom between fit and actual size';
      img.onclick = () => img.classList.toggle('actual');
      body.append(img);
      return;
    }
    const isHtml = ext === 'html' || ext === 'htm' || ext === 'xhtml';
    const viewUrl = '/api/files/view' + p.split('/').map((seg, i) => (i === 0 ? '' : enc(seg))).join('/');
    if ((isHtml && !fb.source) || ext === 'pdf') {
      if (!features.has('view')) {
        // An older server would answer the frame with a 404 that browsers show as "refused to connect".
        const n = document.createElement('div');
        n.className = 'pv-note';
        n.textContent = `Showing ${ext === 'pdf' ? 'PDF files' : 'web pages'} needs a newer version of the server: restart the web terminal to turn it on.`
          + (isHtml ? ' Meanwhile, "View source" shows the file as text.' : ' Meanwhile, Download opens it on your computer.');
        body.append(n);
        return;
      }
    }
    if (ext === 'pdf') {
      // The browser's own PDF viewer (zoom, pages, search, print). Not sandboxed: it cannot run in one.
      const frame = document.createElement('iframe');
      frame.className = 'pv-frame pdf';
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = e.name;
      frame.src = `${viewUrl}#view=FitH&navpanes=0`;
      body.append(frame);
      return;
    }
    if (isHtml && !fb.source) {
      // Static: no scripts, see /view in lib/files.js. A white page, as browsers draw one.
      meta.textContent += ' · scripts are off in this preview';
      const frame = document.createElement('iframe');
      frame.className = 'pv-frame';
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = e.name;
      frame.src = viewUrl;
      body.append(frame);
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
    // Editing: only for a file that is read whole and is plain UTF-8 text (the server says; see /read).
    const editBtn = act('✎ Edit', () => startEdit(e, p, data, body, actions), 'tool-btn');
    if (!data.editable) {
      editBtn.disabled = true;
      editBtn.title = data.why || 'This file cannot be edited here.';
    } else editBtn.title = 'Edit this file here (Ctrl+S saves)';
    const isMd = ['md', 'markdown', 'mdown', 'mkd'].includes(ext);
    const canRender = isMd && typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined';
    if (canRender) {
      const lab = document.createElement('label');
      lab.className = 'pv-check';
      lab.title = 'Draw the Markdown (headings, lists, code, tables) instead of showing the text';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = fb.render;
      box.onchange = () => { fb.render = box.checked; storage('wt.fbMd', fb.render ? '1' : '0'); showPreview(e, { play }); };
      lab.append(box, ' Render');
      actions.append(lab);
      if (fb.render) {
        body.append(renderMarkdown(data.text, dirOf(p)));
        if (data.truncated) {
          const n = document.createElement('div');
          n.className = 'pv-note pv-trunc';
          n.textContent = `Showing the first ${fmtSize(data.text.length)} of ${fmtSize(data.size)}. Download the file to see all of it.`;
          body.append(n);
        }
        return;
      }
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

  const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

  // Markdown to safe HTML. Pictures next to the file are loaded from the server;
  // links open in a new tab, and links to anything else are left inert.
  function renderMarkdown(text, dir) {
    const root = document.createElement('div');
    root.className = 'pv-md';
    const html = marked.parse(text, { gfm: true, breaks: false, async: false });
    root.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    for (const img of root.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (/^(data:image\/|\/api\/files\/)/i.test(src)) continue;
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) { img.replaceWith(Object.assign(document.createElement('span'), { className: 'pv-md-missing', textContent: `[image: ${img.alt || src}]` })); continue; }
      const parts = (src.startsWith('/') ? src : `${dir}/${src}`).split('/').reduce((acc, seg) => {
        if (seg === '..') acc.pop(); else if (seg && seg !== '.') acc.push(seg);
        return acc;
      }, []);
      img.src = `/api/files/raw?inline=1&path=${enc('/' + parts.join('/'))}`;
      img.loading = 'lazy';
    }
    for (const a of root.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else if (!href.startsWith('#')) a.removeAttribute('href');
    }
    return root;
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
      { label: 'Move up', hint: 'one folder', disabled: ro || fb.path === '/', action: () => transfer('move', pathsOfSelection(), parentOf(fb.path)) },
      { label: 'Move to…', disabled: ro, action: () => chooseFolderFor('move') },
      { label: 'Copy to…', action: () => chooseFolderFor('copy') },
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
      ...VIEWS.map((v, i) => ({ label: `${fb.view === v.id ? '✓' : '\u2003'}  View: ${v.label}`, hint: `${mk}⇧${i + 1}`, action: () => setView(v.id) })),
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
    // One panel at a time: the desktop would cover this one.
    if (typeof Vnc !== 'undefined' && Vnc.isOpen()) Vnc.close({ keepFocus: true });
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
    startGitPolling();
  }

  function close(opts = {}) {
    if (!fb.open) return;
    if (hasUnsaved()) { confirmLeave().then((ok) => { if (ok) { if (fb.edit) { fb.edit.ed.destroy(); fb.edit = null; } if (fb.gd) fb.gd.hide(); closeNow(opts); } }); return; }
    closeNow(opts);
  }

  function closeNow({ keepFocus = false } = {}) {
    stopGitPolling();
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

  // What the server can do (older servers lack some of it: see the hello message).
  let features = new Set();
  function setFeatures(list) { features = new Set(list); }

  function setAvailable(on) {
    fb.available = on;
    for (const b of document.querySelectorAll('.files-btn')) b.hidden = !on;
    if (!on && fb.open) close();
  }

  for (const b of document.querySelectorAll('.files-btn')) b.addEventListener('click', toggle);

  return { open, close, toggle, setAvailable, setFeatures, isOpen: () => fb.open };
})();
