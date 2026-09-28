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
        if (typeof n !== 'number' || n <= limit()) return false;
        return ih[method]({ params: [limit()], length: 1 });
      });
    }
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
  // 400 KB takes 12 s. Real palette sequences are far below 4 KB; ignore
  // anything bigger. (Handlers registered later run first, so the server's and
  // browser's own OSC 4 handlers still see normal-sized sequences.)
  function limitPaletteSequences(term) {
    term.parser.registerOscHandler(4, (data) => data.length > 4096);
  }

  // Everything both sides apply to every terminal.
  function hardenTerminal(term) {
    clampRepeatCounts(term);
    dropHyperlinks(term);
    limitPaletteSequences(term);
    guardParser(term);
  }

  const api = { clampRepeatCounts, dropHyperlinks, limitPaletteSequences, guardParser, hardenTerminal };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
