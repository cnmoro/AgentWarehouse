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
        // T with several parameters is the old mouse-highlight command, not a scroll.
        if (typeof n !== 'number' || n <= limit() || (final === 'T' && params.length > 1)) return false;
        return ih[method]({ params: [limit()], length: 1 });
      });
    }
  }
  if (typeof module === 'object' && module.exports) module.exports = { clampRepeatCounts };
  else root.clampRepeatCounts = clampRepeatCounts;
})(typeof globalThis !== 'undefined' ? globalThis : this);
