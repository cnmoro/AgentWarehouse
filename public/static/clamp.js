'use strict';
// Shared by the server (headless mirror) and the browser.
//
// xterm.js carries out some CSI commands one step at a time, as often as the
// count says: scroll up/down (S/T), insert/delete lines (L/M), tab
// forward/back (I/Z) and repeat character (b). "\e[2147483647T" in any program
// output would lock the thread for minutes. Past the screen size more repeats
// change nothing (REP: past a full screen of characters), so clamp the count
// there. Both sides clamp the same way and stay in sync.
(function (root) {
  function clampRepeatCounts(term) {
    const ih = term._core && term._core._inputHandler;
    if (!ih) return; // internals changed; nothing we can safely do
    const ops = {
      S: ['scrollUp', () => term.rows],
      T: ['scrollDown', () => term.rows],
      L: ['insertLines', () => term.rows],
      M: ['deleteLines', () => term.rows],
      I: ['cursorForwardTab', () => term.cols],
      Z: ['cursorBackwardTab', () => term.cols],
      b: ['repeatPrecedingCharacter', () => term.cols * term.rows],
    };
    for (const [final, [method, limit]] of Object.entries(ops)) {
      if (typeof ih[method] !== 'function') continue;
      term.parser.registerCsiHandler({ final }, (params) => {
        const n = params[0];
        if (typeof n !== 'number') return false;
        let max = limit();
        // REP of a combined cluster (e + marks) prints every mark into every
        // cell: bound the total code units, not just the cell count.
        if (final === 'b') {
          max = Math.max(1, Math.floor(max / clusterLength(term, ih)));
          // In insert mode every printed cell shifts the rest of the line, so
          // each repeat costs a full line: more than one line's worth changes
          // nothing visible anyway.
          try {
            if (term._core.coreService.modes.insertMode) max = Math.min(max, term.cols);
          } catch { /* internals changed; keep the area limit */ }
        }
        if (n <= max) return false;
        return ih[method]({ params: [max], length: 1 });
      });
    }
  }
  function clusterLength(term, ih) {
    try {
      const js = ih._parser.precedingJoinState;
      if (!js) return 1;
      const b = term._core.buffer;
      const x = b.x - ((js >> 1) & 3);
      const line = b.lines.get(b.ybase + b.y);
      return Math.max(1, line.getString(x).length);
    } catch { return 1; }
  }
  // OSC 8 hyperlinks cost xterm a buffer marker each (~3 KB) plus work on every
  // scrollback trim; a stream of unique links runs a process out of memory.
  // Plain URLs are still clickable through the web-links addon.
  function dropHyperlinks(term) {
    term.parser.registerOscHandler(8, () => true);
  }

  // An exception inside xterm's parser leaves its write queue stuck for good:
  // nothing is parsed again, the tab freezes and (on the server) the shell
  // blocks once flow control pauses it. Two layers of protection:
  //  - xterm 6.0.0 throws on ED/DECSED 1 ("erase to cursor") with the cursor in
  //    the bottom-right cell; that erases the whole screen, so do exactly that.
  //  - any other exception is contained: the rest of that chunk is dropped and
  //    the parser reset, instead of the terminal dying.
  function guardParser(term) {
    const ih = term._core && term._core._inputHandler;
    if (!ih || typeof ih.parse !== 'function') return;
    for (const prefix of ['', '?']) {
      term.parser.registerCsiHandler(prefix ? { prefix, final: 'J' } : { final: 'J' }, (params) => {
        const b = term._core.buffer;
        if (params[0] !== 1 || b.x + 1 < term.cols || b.y !== term.rows - 1) return false;
        return ih.eraseInDisplay({ params: [2], length: 1 }, prefix === '?');
      });
    }
    const parse = ih.parse; // the write queue looks this up on every call
    ih.parse = function (data, promiseResult) {
      try {
        return parse.call(this, data, promiseResult);
      } catch (err) {
        try { this._parser.reset(); } catch { /* nothing more to do */ }
        if (typeof console !== 'undefined') console.error('terminal parser error (chunk dropped):', err && err.message);
        return undefined;
      }
    };
  }

  // xterm's own OSC 4 (palette) handler is quadratic in the payload length:
  // 400 KB takes 12 s, 16 KB about 10 ms. A full 256-colour palette is ~5 KB;
  // ignore anything over 16 KB. (Handlers registered later run first, so the server's and
  // browser's own OSC 4 handlers still see normal-sized sequences.)
  const MAX_PALETTE = 16 * 1024;
  function limitPaletteSequences(term) {
    term.parser.registerOscHandler(4, (data) => data.length > MAX_PALETTE);
  }

  // xterm's string handlers build OSC/DCS payloads one character at a time
  // (~30 bytes of heap per byte, per handler) and keep up to 10 MB of them:
  // an unterminated 10 MB OSC 4 holds ~900 MB, five of them crash the server.
  // Stop collecting past a sane size; the sequence is then ignored.
  const MAX_STRING = 64 * 1024;
  function capStringPayloads(term) {
    const p = term._core && term._core._inputHandler && term._core._inputHandler._parser;
    for (const table of [p && p._oscParser && p._oscParser._handlers, p && p._dcsParser && p._dcsParser._handlers]) {
      for (const list of Object.values(table || {})) {
        for (const h of list) {
          const proto = Object.getPrototypeOf(h);
          if (!proto || proto.__capped || typeof proto.put !== 'function' || !('_hitLimit' in h)) continue;
          const put = proto.put;
          proto.put = function (data, start, end) {
            if (this._hitLimit) return;
            if (this._data.length + (end - start) > MAX_STRING) { this._data = ''; this._hitLimit = true; return; }
            put.call(this, data, start, end);
          };
          proto.__capped = true;
        }
      }
    }
  }

  // Each colour change (OSC 4/10-12/104/110-112) and each change of the
  // cursorBlink/convertEol options (CSI ?12 h/l, CSI 20 h/l) makes the browser
  // restyle the whole terminal; the DOM renderer used by hidden tabs needs
  // ~60-170 us per change, so 1 MB of them freezes the page for a minute.
  // Allow a burst, then a steady rate; drop the excess. Browser only: the
  // server mirror has no restyle cost, and a timing-based rule applied on both
  // sides could make them drop different sequences.
  function throttleRestyles(term, perSecond = 200) {
    const ih = term._core && term._core._inputHandler;
    let tokens = perSecond, last = Date.now();
    const take = (n) => {
      const now = Date.now();
      tokens = Math.min(perSecond, tokens + (now - last) * perSecond / 1000);
      last = now;
      // A single sequence bigger than the whole bucket (a full 256-colour
      // palette) still passes when the bucket is full.
      if (tokens < Math.min(n, perSecond)) return false;
      tokens = Math.max(0, tokens - n);
      return true;
    };
    const colorCount = {
      4: (d) => { const s = d.split(';'); let n = 0; for (let i = 1; i < s.length; i += 2) if (s[i] !== '?') n++; return n; },
      104: (d) => (d ? d.split(';').length : 1),
    };
    for (const code of [4, 10, 11, 12, 104, 110, 111, 112]) {
      term.parser.registerOscHandler(code, (d) => {
        if (d.length > MAX_PALETTE) return true;
        const n = colorCount[code] ? colorCount[code](d) : (d.split(';').filter((x) => x !== '?').length || 1);
        return n > 0 && !take(n);
      });
    }
    if (!ih) return;
    // LNM (CSI 20 h/l) changes how line feeds work, so it must never be
    // dropped. Setting the raw option directly gives the same behaviour without
    // the option-change event that makes the renderer restyle.
    const raw = term._core.optionsService && term._core.optionsService.rawOptions;
    if (raw && 'convertEol' in raw) {
      for (const [final, method, value] of [['h', 'setMode', true], ['l', 'resetMode', false]]) {
        term.parser.registerCsiHandler({ final }, (params) => {
          if (!params.includes(20)) return false;
          raw.convertEol = value;
          const rest = params.filter((v) => v !== 20);
          if (rest.length) ih[method]({ params: rest, length: rest.length });
          return true;
        });
      }
    }
    // Cursor blink (CSI ?12 h/l) is cosmetic: throttle it.
    for (const [prefix, mode, set, reset] of [['?', 12, 'setModePrivate', 'resetModePrivate']]) {
      for (const [final, method] of [['h', set], ['l', reset]]) {
        if (typeof ih[method] !== 'function') continue;
        term.parser.registerCsiHandler(prefix ? { prefix, final } : { final }, (params) => {
          if (!params.includes(mode) || take(1)) return false;
          const rest = params.filter((v) => v !== mode);
          if (rest.length) ih[method]({ params: rest, length: rest.length });
          return true;
        });
      }
    }
  }

  // Combining marks (U+0301...) pile up in one cell without limit, and REP
  // repeats the whole cluster: an 80 KB file ran the server out of memory.
  // Tall stacks of marks are also slow for the browser to draw. Limits, in
  // UTF-16 units including the base character: 16 when the cluster starts with
  // an emoji (family emoji and tag flags need 11-14), 6 for anything else (a
  // letter with up to five accents; keycaps like #️⃣ are 3). Later marks are dropped, but a width change they carry
  // (e.g. emoji presentation) still applies.
  const MAX_CLUSTER = 16;
  const MAX_TEXT_CLUSTER = 6;
  // Decided by the cluster's first character only: a ZWJ or VS16 further in
  // must not unlock the larger limit for a stack of accents.
  const EMOJI_BASE = /^(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])/u;
  const clusterLimit = (cluster) => (EMOJI_BASE.test(cluster) ? MAX_CLUSTER : MAX_TEXT_CLUSTER);
  const IS_COMBINED = 0x200000;
  const WIDTH_BITS = 0xC00000;
  const interned = new Map();
  function capCombiningMarks(term) {
    const line = term._core && term._core.buffer && term._core.buffer.lines.get(0);
    const proto = line && Object.getPrototypeOf(line);
    if (!proto || proto.__clusterCapped || typeof proto.addCodepointToCell !== 'function') return;
    const add = proto.addCodepointToCell;
    proto.addCodepointToCell = function (index, codePoint, width) {
      const content = this._data[index * 3];
      const cluster = (content & IS_COMBINED) && this._combined[index];
      if (cluster && cluster.length >= clusterLimit(cluster)) {
        if (width) this._data[index * 3] = (content & ~WIDTH_BITS) | (width << 22);
        return;
      }
      add.call(this, index, codePoint, width);
      // String += builds a rope: a long cluster costs ~1 KB per cell. Store one
      // flat, shared copy instead (join() allocates a fresh flat string).
      const s = this._combined[index];
      if (typeof s === 'string') {
        let flat = interned.get(s);
        if (flat === undefined) {
          if (interned.size >= 4096) interned.clear();
          flat = s.split('').join('');
          interned.set(flat, flat);
        }
        this._combined[index] = flat;
      }
    };
    proto.__clusterCapped = true;
  }

  // Everything both sides apply to every terminal.
  function hardenTerminal(term) {
    clampRepeatCounts(term);
    dropHyperlinks(term);
    limitPaletteSequences(term);
    capStringPayloads(term);
    capCombiningMarks(term);
    guardParser(term);
  }

  const api = {
    clampRepeatCounts, dropHyperlinks, limitPaletteSequences, capStringPayloads, capCombiningMarks,
    throttleRestyles, guardParser, hardenTerminal,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
