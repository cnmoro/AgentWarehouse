'use strict';
// A small text editor for the Files panel: a <textarea> (so typing, selecting, undo, the clipboard, the phone keyboard
// and spell-free input all work as the browser does them) laid over a <pre> that shows the same text with syntax colors
// (highlight.js, through GitDiff) and, when it is given the original text, a mark on the lines that changed.
//
// It is meant for files up to about 1 MB: the whole text is held in the box. Above ~150 KB the colors and the change
// marks are switched off (the <pre> then only gives the text its size) so typing stays quick on big files.

const Editor = (() => {
  const LINE_H = 19;
  const HL_MAX = 150 * 1024; // above this, no syntax colors and no change marks
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // The changed ranges between two arrays of lines ({ os, oc, ns, nc }, 1-based, like `git diff -U0`): the common start
  // and end are cut off, then the middle is compared with Myers' algorithm. A middle that differs too much is
  // reported as one changed block, which keeps the work bounded.
  function diffHunks(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const A = a.slice(p, a.length - s);
    const B = b.slice(p, b.length - s);
    const n = A.length;
    const m = B.length;
    if (!n && !m) return [];
    const whole = [{ os: n ? p + 1 : p, oc: n, ns: m ? p + 1 : p, nc: m }];
    const MAX_D = 600;
    if (n * m > 4e6 && Math.min(n, m) > 2000) return whole;
    // Myers: v[k] is the furthest x on diagonal k; trace keeps v after each d, to walk back.
    const max = Math.min(n + m, MAX_D);
    const off = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]; else x = v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
    }
    if (found < 0) return whole;
    // Walk back from the end to collect the edits, as the steps that left the previous diagonal.
    const edits = []; // 'i': B[y] was inserted at (x, y); 'd': A[x] was deleted at (x, y)
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
      const vv = trace[d];
      const k = x - y;
      const down = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]);
      const px = vv[off + (down ? k + 1 : k - 1)];
      const py = px - (down ? k + 1 : k - 1);
      edits.push({ t: down ? 'i' : 'd', x: px, y: py });
      x = px;
      y = py;
    }
    edits.reverse();
    // Neighbouring edits make one hunk.
    const out = [];
    let cur = null;
    for (const e of edits) {
      const ax = e.x + p;
      const by = e.y + p;
      if (cur && ax === cur.ox + cur.oc && by === cur.ny + cur.nc) {
        if (e.t === 'd') cur.oc++; else cur.nc++;
      } else {
        if (cur) out.push(cur);
        cur = { ox: ax, oc: e.t === 'd' ? 1 : 0, ny: by, nc: e.t === 'i' ? 1 : 0 };
      }
    }
    if (cur) out.push(cur);
    return out.map((h) => ({ os: h.oc ? h.ox + 1 : h.ox, oc: h.oc, ns: h.nc ? h.ny + 1 : h.ny, nc: h.nc }));
  }

  function create(host, opts) {
    const o = { text: '', lang: null, original: null, readOnly: false, onDirty() {}, onSave() {}, onScroll() {}, ...opts };
    host.classList.add('ed');
    host.innerHTML = `
      <div class="ed-scroll">
        <div class="ed-gutter" aria-hidden="true"><div class="ed-gin"></div></div>
        <div class="ed-stack"><pre class="ed-hl" aria-hidden="true"></pre><textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="Text of the file"></textarea></div>
      </div>`;
    const el = { scroll: host.querySelector('.ed-scroll'), gutter: host.querySelector('.ed-gutter'), gin: host.querySelector('.ed-gin'), hl: host.querySelector('.ed-hl'), ta: host.querySelector('.ed-ta') };
    el.ta.readOnly = !!o.readOnly;
    let saved = o.text; // the text that is on disk (as far as this editor knows)
    let original = o.original; // lines to compare with for the change marks, or null
    let prevLines = [];
    let prevHtml = [];
    let version = 0;
    let hlTimer = 0;
    let markTimer = 0;
    let raf = 0;
    let marks = new Map(); // line number (1-based) -> 'add' | 'mod'
    let destroyed = false;
    let charW = 7.5;
    let dirty = false;
    let plain = false; // big file: the text box scrolls by itself and nothing is drawn behind it
    let lastCount = -1;

    const indentUnit = (() => {
      const lines = o.text.split('\n', 400);
      let tabs = 0;
      let spaces = 0;
      for (const l of lines) { if (l[0] === '\t') tabs++; else if (/^ {2,}\S/.test(l)) spaces++; }
      return tabs > spaces ? '\t' : '  ';
    })();

    const small = () => el.ta.value.length <= HL_MAX;

    // ---- drawing

    function measure() {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
      probe.textContent = 'M'.repeat(100);
      el.hl.append(probe);
      const w = probe.getBoundingClientRect().width / 100;
      probe.remove();
      if (w > 1) charW = w;
    }

    function drawGutter(n) {
      let html = '';
      if (!plain) {
        for (let i = 1; i <= n; i++) { const m = marks.get(i); html += m ? `<span class="ed-gm ${m}">${i}</span>` : `<span>${i}</span>`; }
        el.gin.innerHTML = html;
      } else {
        const parts = new Array(n);
        for (let i = 0; i < n; i++) parts[i] = i + 1;
        el.gin.textContent = parts.join('\n');
      }
      el.gutter.style.minWidth = `${String(n).length * charW + 18}px`;
    }

    function setMode(isPlain) {
      if (isPlain === plain) return;
      plain = isPlain;
      host.classList.toggle('plain', plain);
      lastCount = -1;
      if (plain) { el.hl.textContent = ''; prevLines = []; prevHtml = []; el.gin.style.transform = ''; } else el.gin.style.transform = '';
    }

    // Draws the text. Lines that did not change since the last drawing keep their colors; the edited ones are drawn plain
    // and get their colors a moment later (colors() below).
    function draw() {
      raf = 0;
      if (destroyed) return;
      const text = el.ta.value;
      setMode(!small());
      if (plain) {
        let n = 1;
        for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
        if (n !== lastCount) { lastCount = n; drawGutter(n); }
        return;
      }
      const lines = text.split('\n');
      let p = 0;
      while (p < lines.length && p < prevLines.length && lines[p] === prevLines[p]) p++;
      let s = 0;
      while (s < lines.length - p && s < prevLines.length - p && lines[lines.length - 1 - s] === prevLines[prevLines.length - 1 - s]) s++;
      const html = new Array(lines.length);
      for (let i = 0; i < lines.length; i++) {
        if (i < p) html[i] = prevHtml[i];
        else if (i >= lines.length - s) html[i] = prevHtml[prevHtml.length - (lines.length - i)];
        else html[i] = esc(lines[i]);
      }
      prevLines = lines;
      prevHtml = html;
      paint();
      drawGutter(lines.length);
    }

    function paint() {
      let out = '';
      for (let i = 0; i < prevHtml.length; i++) {
        const m = marks.get(i + 1);
        out += `<span class="ed-l${m ? ' ' + m : ''}">${prevHtml[i] || '&#8203;'}</span>`;
      }
      el.hl.innerHTML = out;
    }

    async function colors() {
      hlTimer = 0;
      if (destroyed || !small() || !o.lang) return;
      const my = ++version;
      const lines = el.ta.value.split('\n');
      const html = await GitDiff.htmlLines(lines, o.lang);
      if (destroyed || my !== version || lines.length !== prevLines.length) return;
      prevLines = lines;
      prevHtml = html;
      paint();
    }

    function computeMarks() {
      markTimer = 0;
      if (destroyed || !original || !small()) { if (marks.size) { marks = new Map(); schedule(); } return; }
      const next = new Map();
      const lines = el.ta.value.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      for (const h of diffHunks(original, lines)) {
        for (let i = 0; i < h.nc; i++) next.set(h.ns + i, h.oc ? 'mod' : 'add');
        if (!h.nc && h.oc) next.set(Math.max(1, h.ns + 1), next.get(h.ns + 1) || 'del');
      }
      marks = next;
      schedule();
      o.onMarks && o.onMarks(diffHunks(original, lines), lines);
    }

    function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

    function changed() {
      dirty = el.ta.value !== saved;
      o.onDirty(dirty);
      schedule();
      clearTimeout(hlTimer);
      hlTimer = setTimeout(colors, 150);
      clearTimeout(markTimer);
      markTimer = setTimeout(computeMarks, 250);
    }

    // ---- caret

    function reveal() {
      if (plain) return; // the text box scrolls to the caret by itself
      const ta = el.ta;
      const pos = ta.selectionEnd;
      const before = ta.value.slice(0, pos);
      const line = before.split('\n').length - 1;
      const lineText = before.slice(before.lastIndexOf('\n') + 1);
      let col = 0;
      for (const ch of lineText) col += ch === '\t' ? 4 - (col % 4) : 1;
      const y = 8 + line * LINE_H;
      const x = 12 + col * charW;
      const sc = el.scroll;
      const gw = el.gutter.offsetWidth;
      if (y < sc.scrollTop + 4) sc.scrollTop = Math.max(0, y - 4);
      else if (y + LINE_H > sc.scrollTop + sc.clientHeight - 4) sc.scrollTop = y + LINE_H - sc.clientHeight + 12;
      if (x < sc.scrollLeft + 4) sc.scrollLeft = Math.max(0, x - 40);
      else if (x + gw > sc.scrollLeft + sc.clientWidth - 12) sc.scrollLeft = x + gw - sc.clientWidth + 40;
    }

    // ---- editing keys

    function insert(text) {
      el.ta.focus();
      if (!document.execCommand('insertText', false, text)) {
        const { selectionStart: a, selectionEnd: b } = el.ta;
        el.ta.setRangeText(text, a, b, 'end');
        el.ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    function lineBounds(value, a, b) {
      const start = value.lastIndexOf('\n', a - 1) + 1;
      let end = value.indexOf('\n', b > a && value[b - 1] === '\n' ? b - 1 : b);
      if (end < 0) end = value.length;
      return [start, end];
    }

    function indentBlock(out) {
      const ta = el.ta;
      const [a, b] = [ta.selectionStart, ta.selectionEnd];
      const [start, end] = lineBounds(ta.value, a, b);
      const block = ta.value.slice(start, end);
      const lines = block.split('\n');
      let delta0 = 0;
      let total = 0;
      const next = lines.map((l, i) => {
        let r;
        if (!out) r = indentUnit + l;
        else if (l.startsWith('\t')) r = l.slice(1);
        else { const m = /^ {1,2}/.exec(l); r = m ? l.slice(m[0].length) : l; }
        const d = r.length - l.length;
        if (i === 0) delta0 = d;
        total += d;
        return r;
      }).join('\n');
      ta.setSelectionRange(start, end);
      insert(next);
      ta.setSelectionRange(Math.max(start, a + delta0), b + total);
    }

    el.ta.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); o.onSave(); return; }
      if (o.readOnly) return;
      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        const ta = el.ta;
        const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
        if (e.shiftKey || multi) indentBlock(e.shiftKey); else insert(indentUnit);
      } else if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
        const ta = el.ta;
        const pos = ta.selectionStart;
        const ls = ta.value.lastIndexOf('\n', pos - 1) + 1;
        const lead = /^[ \t]*/.exec(ta.value.slice(ls, pos))[0];
        const before = ta.value.slice(ls, pos).trimEnd();
        const extra = /[{[(:]$/.test(before) ? indentUnit : '';
        if (lead || extra) { e.preventDefault(); insert('\n' + lead + extra); }
      }
    });
    el.ta.addEventListener('input', () => { changed(); reveal(); });
    el.ta.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) reveal(); });
    el.ta.addEventListener('mouseup', () => reveal());
    el.scroll.addEventListener('scroll', () => o.onScroll(el.scroll));
    el.ta.addEventListener('scroll', () => { if (plain) { el.gin.style.transform = `translateY(${-el.ta.scrollTop}px)`; o.onScroll(el.ta); } });

    // ---- start

    el.ta.value = o.text;
    measure();
    draw();
    if (o.lang) colors();
    if (original) computeMarks();

    return {
      get el() { return plain ? el.ta : el.scroll; },
      getText: () => el.ta.value,
      isDirty: () => dirty,
      focus: () => el.ta.focus({ preventScroll: true }),
      // The text was saved: it is the new baseline for "unsaved".
      markSaved: () => { saved = el.ta.value; dirty = false; o.onDirty(false); },
      setOriginal: (lines) => { original = lines; computeMarks(); },
      setReadOnly: (on) => { o.readOnly = on; el.ta.readOnly = on; },
      setText: (t) => { el.ta.value = t; saved = t; dirty = false; o.onDirty(false); version++; prevLines = []; prevHtml = []; draw(); colors(); computeMarks(); },
      scrollTo: (top) => { (plain ? el.ta : el.scroll).scrollTop = top; },
      destroy: () => { destroyed = true; clearTimeout(hlTimer); clearTimeout(markTimer); cancelAnimationFrame(raf); host.classList.remove('ed'); host.textContent = ''; },
    };
  }

  return { create, diffHunks };
})();
