'use strict';
// The diff of one file, side by side or inline, with syntax highlighting (highlight.js, loaded when the
// first diff is opened). Used by the Files panel's "Changes" list (files.js). It draws what /api/files/git/diff
// returns: the two sides of the file as text and the changed line ranges.

const GitDiff = (() => {
  const CONTEXT = 3; // unchanged lines kept around a change when the rest is folded

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---------------------------------------------------------------- languages

  const BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
    json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', map: 'json',
    html: 'xml', htm: 'xml', xml: 'xml', xsd: 'xml', xsl: 'xml', svg: 'xml', plist: 'xml', vue: 'xml', svelte: 'xml', xhtml: 'xml', csproj: 'xml',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    py: 'python', pyw: 'python', pyi: 'python',
    sh: 'bash', bash: 'bash', zsh: 'bash', env: 'bash', ksh: 'bash',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
    sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
    cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', lua: 'lua', r: 'r', pl: 'perl', pm: 'perl',
    ps1: 'powershell', psm1: 'powershell', proto: 'protobuf', gradle: 'groovy', groovy: 'groovy',
    dart: 'dart', scala: 'scala', sbt: 'scala', ex: 'elixir', exs: 'elixir', hs: 'haskell', erl: 'erlang', clj: 'clojure',
    graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff', mk: 'makefile', cmake: 'cmake', vim: 'vim', m: 'objectivec', mm: 'objectivec',
    dockerfile: 'dockerfile', tex: 'latex', nginx: 'nginx',
  };
  const BY_NAME = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', 'nginx.conf': 'nginx', '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.env': 'bash', '.gitignore': 'bash', '.editorconfig': 'ini', 'cmakelists.txt': 'cmake' };

  function languageOf(file) {
    const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
    if (BY_NAME[name]) return BY_NAME[name];
    if (name.startsWith('dockerfile')) return 'dockerfile';
    const i = name.lastIndexOf('.');
    return i >= 0 ? BY_EXT[name.slice(i + 1)] || null : null;
  }

  let hljsPromise = null;
  const loaded = new Map();
  // highlight.js with the language registered, or null when it cannot be had (then the code is shown plain).
  async function highlighter(lang) {
    if (!lang) return null;
    try {
      hljsPromise ||= import('/vendor/hljs/core.js').then((m) => m.default);
      const h = await hljsPromise;
      if (!loaded.has(lang)) {
        loaded.set(lang, import(`/vendor/hljs/languages/${lang}.js`).then((m) => { h.registerLanguage(lang, m.default); return true; }, () => false));
      }
      return (await loaded.get(lang)) ? h : null;
    } catch {
      return null;
    }
  }

  // Highlighted HTML cut into one string per line. A token that spans lines (a comment, a template string)
  // is closed at the end of each line and opened again at the start of the next, so every line stands alone.
  function splitLines(html) {
    const lines = [];
    const open = [];
    let cur = '';
    const re = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g;
    let m;
    while ((m = re.exec(html))) {
      const t = m[0];
      if (t === '\n') {
        lines.push(cur + '</span>'.repeat(open.length));
        cur = open.join('');
      } else if (t === '</span>') {
        open.pop();
        cur += t;
      } else if (t.startsWith('<span')) {
        open.push(t);
        cur += t;
      } else cur += t;
    }
    lines.push(cur + '</span>'.repeat(open.length));
    return lines;
  }

  const linesOf = (text) => {
    const l = text.replace(/\r\n?/g, '\n').split('\n');
    if (l.length && l[l.length - 1] === '') l.pop();
    return l;
  };

  async function htmlLines(lines, lang) {
    const plain = () => lines.map(esc);
    const text = lines.join('\n');
    if (!lang || text.length > 600000) return plain();
    const h = await highlighter(lang);
    if (!h) return plain();
    try {
      const out = splitLines(h.highlight(text, { language: lang, ignoreIllegals: true }).value);
      return out.length >= lines.length ? out : plain();
    } catch {
      return plain();
    }
  }

  // ---------------------------------------------------------------- rows

  // The two files lined up: [{ k: 'ctx' | 'del' | 'add' | 'mod', o, n }] with 1-based line numbers on each side.
  function buildRows(oldLines, newLines, hunks) {
    const rows = [];
    if (oldLines === null || newLines === null) {
      const lines = oldLines === null ? newLines : oldLines;
      for (let i = 1; i <= lines.length; i++) rows.push(oldLines === null ? { k: 'add', n: i } : { k: 'del', o: i });
      return rows;
    }
    let list = hunks;
    if (!list.length && oldLines.join('\n') !== newLines.join('\n')) {
      // git gave no ranges (it should): one change between the common start and end.
      let p = 0;
      while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
      let s = 0;
      while (s < oldLines.length - p && s < newLines.length - p && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
      list = [{ os: p + 1, oc: oldLines.length - p - s, ns: p + 1, nc: newLines.length - p - s }];
      if (!list[0].oc) list[0].os = p;
      if (!list[0].nc) list[0].ns = p;
    }
    let oi = 1;
    let ni = 1;
    const ctx = (count) => { for (let i = 0; i < count; i++) rows.push({ k: 'ctx', o: oi++, n: ni++ }); };
    for (const h of list) {
      ctx((h.oc === 0 ? h.os : h.os - 1) - (oi - 1));
      const m = Math.min(h.oc, h.nc);
      for (let i = 0; i < m; i++) rows.push({ k: 'mod', o: oi++, n: ni++ });
      for (let i = m; i < h.oc; i++) rows.push({ k: 'del', o: oi++ });
      for (let i = m; i < h.nc; i++) rows.push({ k: 'add', n: ni++ });
    }
    while (oi <= oldLines.length && ni <= newLines.length) rows.push({ k: 'ctx', o: oi++, n: ni++ });
    return rows;
  }

  // ---------------------------------------------------------------- the view

  function create(host, { onClose, onFile, storage }) {
    const get = (k, d) => { try { const v = storage(k); return v === null || v === undefined ? d : v; } catch { return d; } };
    const prefs = { layout: get('wt.gitLayout', 'split') === 'inline' ? 'inline' : 'split', fold: get('wt.gitFold', '1') !== '0', wrap: get('wt.gitWrap', '1') !== '0' };
    host.innerHTML = `
      <header class="gd-head">
        <div class="gd-title"><span class="gd-badge"></span><span class="gd-name"></span><span class="gd-dir"></span><span class="gd-side"></span></div>
        <div class="gd-actions">
          <button class="icon-btn" data-gd="prev-change" title="Previous change (Shift+F7)" aria-label="Previous change">↑</button>
          <button class="icon-btn" data-gd="next-change" title="Next change (F7)" aria-label="Next change">↓</button>
          <button class="icon-btn" data-gd="prev-file" title="Previous changed file (Alt+↑)" aria-label="Previous changed file">‹</button>
          <button class="icon-btn" data-gd="next-file" title="Next changed file (Alt+↓)" aria-label="Next changed file">›</button>
          <div class="gd-seg" role="group" aria-label="Layout">
            <button data-gd="split" title="Two columns, old and new">Side by side</button>
            <button data-gd="inline" title="One column, removed lines then added lines">Inline</button>
          </div>
          <label class="tool-check" title="Hide the unchanged lines far from a change"><input type="checkbox" data-gd="fold"> Fold</label>
          <label class="tool-check" title="Wrap long lines"><input type="checkbox" data-gd="wrap"> Wrap</label>
          <button class="icon-btn" data-gd="close" title="Back to the files (Esc)" aria-label="Close the diff">✕</button>
        </div>
      </header>
      <div class="gd-body" tabindex="0"></div>`;
    const q = (s) => host.querySelector(s);
    const el = { badge: q('.gd-badge'), name: q('.gd-name'), dir: q('.gd-dir'), side: q('.gd-side'), body: q('.gd-body'), fold: q('[data-gd="fold"]'), wrap: q('[data-gd="wrap"]') };
    el.fold.checked = prefs.fold;
    el.wrap.checked = prefs.wrap;
    let cur = null; // { data, meta, rows, oldHtml, newHtml, expanded, shown, changeEls, at }
    let token = 0;

    const syncButtons = () => {
      for (const b of host.querySelectorAll('[data-gd="split"],[data-gd="inline"]')) b.classList.toggle('on', b.dataset.gd === prefs.layout);
    };

    function setHeader(meta) {
      el.badge.textContent = meta.letter;
      el.badge.className = `gd-badge st-${meta.cls}`;
      el.badge.title = meta.label;
      const i = meta.path.lastIndexOf('/');
      el.name.textContent = meta.path.slice(i + 1);
      el.dir.textContent = i >= 0 ? meta.path.slice(0, i) : '';
      el.side.textContent = meta.sideLabel + (meta.orig ? ` · renamed from ${meta.orig}` : '');
    }

    function message(text) {
      el.body.textContent = '';
      const d = document.createElement('div');
      d.className = 'gd-msg';
      d.textContent = text;
      el.body.append(d);
    }

    // ---- drawing

    function visibleRows(c) {
      const rows = c.rows;
      if (!prefs.fold) return rows.map((r) => ({ r }));
      const near = new Uint8Array(rows.length);
      rows.forEach((r, i) => {
        if (r.k === 'ctx') return;
        for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) near[j] = 1;
      });
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        if (near[i]) { out.push({ r: rows[i] }); continue; }
        let j = i;
        while (j < rows.length && !near[j]) j++;
        // A fold hides at least 2 lines: one line is cheaper to show than to describe.
        if (j - i < 2 || c.expanded.has(i)) { for (let k = i; k < j; k++) out.push({ r: rows[k] }); } else out.push({ fold: { from: i, count: j - i } });
        i = j - 1;
      }
      return out;
    }

    const codeCell = (cls, html, ln, side, attr = '') => `<div class="gd-ln ${cls}${side}"${attr}>${ln === undefined ? '' : ln}</div><div class="gd-code ${cls}${side}">${html === undefined ? '' : html || '&#8203;'}</div>`;

    function rowHtml(r, c, split) {
      const oh = r.o ? c.oldHtml[r.o - 1] : undefined;
      const nh = r.n ? c.newHtml[r.n - 1] : undefined;
      const anchor = r.first ? ' data-chg="1"' : '';
      if (split) {
        if (r.k === 'ctx') return codeCell('ctx', oh, r.o, ' l', anchor) + codeCell('ctx', nh, r.n, ' r');
        const left = r.o ? codeCell('del', oh, r.o, ' l', anchor) : codeCell('blank', undefined, undefined, ' l', anchor);
        const right = r.n ? codeCell('add', nh, r.n, ' r') : codeCell('blank', undefined, undefined, ' r');
        return left + right;
      }
      if (r.k === 'ctx') return `<div class="gd-ln ctx"${anchor}>${r.o}</div><div class="gd-ln ctx">${r.n}</div><div class="gd-code ctx">${nh || '&#8203;'}</div>`;
      if (r.k === 'del') return `<div class="gd-ln del"${anchor}>${r.o}</div><div class="gd-ln del"></div><div class="gd-code del">${oh || '&#8203;'}</div>`;
      return `<div class="gd-ln add"${anchor}></div><div class="gd-ln add">${r.n}</div><div class="gd-code add">${nh || '&#8203;'}</div>`;
    }

    // A pair of lines changed in place (mod) is drawn as a deleted line and an added line in the inline layout.
    function expandForInline(rows) {
      const out = [];
      let i = 0;
      while (i < rows.length) {
        if (rows[i].k !== 'mod') { out.push(rows[i++]); continue; }
        let j = i;
        while (j < rows.length && rows[j].k === 'mod') j++;
        for (let k = i; k < j; k++) out.push({ k: 'del', o: rows[k].o });
        for (let k = i; k < j; k++) out.push({ k: 'add', n: rows[k].n });
        i = j;
      }
      return out;
    }

    const PAGE = 1500;
    function draw(keepScroll = true) {
      const c = cur;
      if (!c || !c.rows) return;
      const top = keepScroll ? el.body.scrollTop : 0;
      const split = prefs.layout === 'split';
      const rows = split ? c.rows : expandForInline(c.rows);
      const view = visibleRows({ ...c, rows });
      // The first row of each run of changed rows is a place to jump to.
      let prevChanged = false;
      for (const v of view) {
        if (v.r) { const ch = v.r.k !== 'ctx'; v.r.first = ch && !prevChanged; prevChanged = ch; } else prevChanged = false;
      }
      if (c.shown === undefined) c.shown = PAGE;
      let html = '';
      let n = 0;
      let rest = 0;
      for (const v of view) {
        if (n >= c.shown) { rest++; continue; }
        if (v.fold) {
          html += `<button class="gd-fold" data-from="${v.fold.from}" title="Show these lines">⋯ ${v.fold.count} unchanged lines</button>`;
          n++;
        } else { html += rowHtml(v.r, c, split); n++; }
      }
      if (rest) html += `<button class="gd-fold gd-more">Show ${Math.min(rest, PAGE)} more of ${rest} rows</button>`;
      el.body.textContent = '';
      const grid = document.createElement('div');
      grid.className = `gd-grid ${split ? 'split' : 'inline'}${prefs.wrap ? ' wrap' : ''}`;
      grid.innerHTML = html;
      el.body.append(grid);
      el.body.scrollTop = top;
      c.changeEls = [...grid.querySelectorAll('[data-chg]')];
    }

    async function show(data, meta) {
      const my = ++token;
      setHeader(meta);
      syncButtons();
      host.hidden = false;
      const bin = data.oldKind === 'binary' || data.newKind === 'binary';
      if (bin) { cur = null; return message('Binary file: its content is not shown.'); }
      if (data.oldKind === 'large' || data.newKind === 'large') { cur = null; return message('This file is too large to show here.'); }
      const oldLines = data.old === null ? null : linesOf(data.old);
      const newLines = data.new === null ? null : linesOf(data.new);
      if (oldLines && newLines && oldLines.join('\n') === newLines.join('\n') && data.old === data.new) {
        cur = null;
        return message(data.orig ? 'The file was renamed; its content did not change.' : 'No changes in the content (only the file mode, or line endings, changed).');
      }
      if (oldLines === null && newLines === null) { cur = null; return message('Nothing to show for this file.'); }
      const rows = buildRows(oldLines, newLines, data.hunks || []);
      const keep = cur && cur.path === data.path && cur.side === data.side ? cur : null;
      cur = { data, meta, path: data.path, side: data.side, rows, oldHtml: (oldLines || []).map(esc), newHtml: (newLines || []).map(esc), expanded: keep ? keep.expanded : new Set(), shown: keep ? keep.shown : undefined, changeEls: [], at: -1 };
      draw(!!keep);
      if (!keep) goTo(0);
      const lang = languageOf(data.path);
      if (lang) {
        const [oh, nh] = await Promise.all([oldLines ? htmlLines(oldLines, lang) : [], newLines ? htmlLines(newLines, lang) : []]);
        if (my !== token || !cur || cur.data !== data) return;
        cur.oldHtml = oh;
        cur.newHtml = nh;
        draw(true);
      }
    }

    // Scroll to the next (dir 1) or previous (dir -1) change.
    function jump(dir) {
      if (!cur || !cur.changeEls.length) return;
      const els = cur.changeEls;
      const top = el.body.getBoundingClientRect().top;
      let idx;
      if (dir > 0) idx = els.findIndex((e) => e.getBoundingClientRect().top - top > 24);
      else { idx = -1; els.forEach((e, i) => { if (e.getBoundingClientRect().top - top < -4) idx = i; }); }
      if (idx < 0) idx = dir > 0 ? (cur.at >= els.length - 1 ? 0 : els.length - 1) : (cur.at <= 0 ? els.length - 1 : 0);
      cur.at = idx;
      scrollToEl(els[idx]);
    }
    const scrollToEl = (target) => { el.body.scrollTop += target.getBoundingClientRect().top - el.body.getBoundingClientRect().top - 60; };
    function goTo(i) {
      if (!cur || !cur.changeEls.length) return;
      cur.at = i;
      scrollToEl(cur.changeEls[i]);
    }

    host.addEventListener('click', (e) => {
      const fold = e.target.closest('.gd-fold');
      if (fold && cur) {
        if (fold.classList.contains('gd-more')) cur.shown += PAGE; else cur.expanded.add(Number(fold.dataset.from));
        draw(true);
        return;
      }
      const b = e.target.closest('[data-gd]');
      if (!b) return;
      const a = b.dataset.gd;
      if (a === 'close') onClose();
      else if (a === 'prev-change') jump(-1);
      else if (a === 'next-change') jump(1);
      else if (a === 'prev-file') onFile(-1);
      else if (a === 'next-file') onFile(1);
      else if (a === 'split' || a === 'inline') { prefs.layout = a; try { storage('wt.gitLayout', a); } catch { /* private mode */ } syncButtons(); if (cur) cur.expanded.clear(); draw(true); }
    });
    host.addEventListener('change', (e) => {
      const b = e.target.closest('[data-gd]');
      if (!b) return;
      if (b.dataset.gd === 'fold') { prefs.fold = b.checked; try { storage('wt.gitFold', b.checked ? '1' : '0'); } catch { /* private mode */ } draw(true); }
      if (b.dataset.gd === 'wrap') { prefs.wrap = b.checked; try { storage('wt.gitWrap', b.checked ? '1' : '0'); } catch { /* private mode */ } draw(true); }
    });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'F7') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
      else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); onFile(1); }
      else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); onFile(-1); }
    });

    return {
      show,
      message: (meta, text) => { token++; setHeader(meta); syncButtons(); host.hidden = false; cur = null; message(text); },
      hide: () => { token++; host.hidden = true; cur = null; el.body.textContent = ''; },
      focus: () => el.body.focus({ preventScroll: true }),
    };
  }

  return { create, languageOf, splitLines, buildRows };
})();
