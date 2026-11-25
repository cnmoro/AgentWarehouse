'use strict';
// Usage panel: the plan limits of Claude Code, Codex and OpenCode on this machine (lib/usage.js polls them and pushes
// every minute), in a small see-through panel that floats over the terminals. Drag it by its title; "–" shrinks it
// to a pill with the highest use of each tool, and a click on the pill opens it again. Where it is and whether it is
// shrunk are remembered per browser.
(() => {
  const KEY_POS = 'wt.usage.pos';
  const KEY_MODE = 'wt.usage.mode';
  const SHORT = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

  let el = null;
  let data = null;
  let mode = null; // 'open' | 'min'
  let tick = 0;

  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* private mode */ } return null; };

  const level = (m) => {
    if (m.severity === 'critical' || m.percent >= 90) return 'err';
    if (m.severity === 'warning' || m.percent >= 70) return 'warn';
    return 'ok';
  };

  function until(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'now';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    return `${Math.round(s / 60)} min ago`;
  }

  const text = (tag, cls, s) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (s !== undefined) e.textContent = s;
    return e;
  };

  function renderOpen(body) {
    for (const p of data.providers) {
      const sec = text('div', `usage-prov${p.stale ? ' stale' : ''}`);
      const head = text('div', 'usage-prov-head');
      head.append(text('span', 'usage-prov-name', p.name));
      if (p.plan) head.append(text('span', 'usage-plan', p.plan));
      sec.append(head);
      for (const m of p.meters) {
        const row = text('div', `usage-row ${level(m)}`);
        row.title = `${p.name} · ${m.label}: ${m.percent ?? '?'}% used${m.resetsAt ? `\nResets ${new Date(m.resetsAt).toLocaleString()}` : ''}`;
        const bar = text('span', 'usage-bar');
        const fill = text('span', 'usage-fill');
        fill.style.width = `${m.percent ?? 0}%`;
        bar.append(fill);
        row.append(text('span', 'usage-label', m.label), bar, text('span', 'usage-pct', m.percent == null ? '—' : `${Math.round(m.percent)}%`),
          text('span', 'usage-reset', m.resetsAt ? until(m.resetsAt) : ''));
        sec.append(row);
      }
      if (p.note) sec.append(text('div', 'usage-note', p.note));
      body.append(sec);
    }
    body.append(text('div', 'usage-foot', `Updated ${ago(data.at)} · every minute`));
  }

  // Shrunk: each tool's highest use, coloured.
  function renderPill(body) {
    for (const p of data.providers) {
      const top = p.meters.reduce((a, m) => (a && a.percent >= (m.percent ?? -1) ? a : m), null);
      const item = text('span', `usage-pill-item ${top ? level(top) : 'none'}`);
      item.append(text('span', 'usage-pill-name', SHORT[p.id] || p.name), text('span', 'usage-pill-pct', top && top.percent != null ? `${Math.round(top.percent)}%` : '—'));
      item.title = top ? `${p.name}: ${top.label} ${Math.round(top.percent)}% used` : `${p.name}: ${p.note || 'no data'}`;
      body.append(item);
    }
  }

  function render() {
    if (!el || !data) return;
    el.classList.toggle('min', mode === 'min');
    const body = el.querySelector('.usage-body');
    body.textContent = '';
    if (mode === 'min') renderPill(body); else renderOpen(body);
    el.querySelector('.usage-min').title = mode === 'min' ? 'Open' : 'Shrink';
    el.querySelector('.usage-min').textContent = mode === 'min' ? '+' : '–';
    el.hidden = !data.providers.length;
    keepOnScreen();
  }

  function setMode(m) {
    mode = m;
    store(KEY_MODE, m);
    render();
  }

  // Kept inside the window (it may have been placed on a bigger screen).
  function keepOnScreen() {
    if (el.hidden) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, r.left));
    const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, r.top));
    if (x !== r.left || y !== r.top) place(x, y);
  }
  function place(x, y) {
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.right = 'auto';
  }

  function drag(e) {
    if (e.button > 0 || e.target.closest('.usage-min')) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      el.classList.add('dragging');
      place(Math.max(4, Math.min(window.innerWidth - r.width - 4, ev.clientX - dx)), Math.max(4, Math.min(window.innerHeight - r.height - 4, ev.clientY - dy)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      if (moved) {
        const b = el.getBoundingClientRect();
        store(KEY_POS, JSON.stringify({ x: b.left, y: b.top }));
      } else if (mode === 'min') {
        setMode('open'); // a click (not a drag) on the pill opens it
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function build() {
    el = document.createElement('section');
    el.id = 'usage';
    el.className = 'usage';
    el.setAttribute('aria-label', 'Plan usage');
    el.innerHTML = '<div class="usage-head"><span class="usage-title">Usage</span><button type="button" class="usage-min" aria-label="Shrink">–</button></div><div class="usage-body"></div>';
    el.querySelector('.usage-head').addEventListener('pointerdown', drag);
    el.querySelector('.usage-body').addEventListener('pointerdown', (e) => { if (mode === 'min') drag(e); });
    el.querySelector('.usage-min').addEventListener('click', (e) => { e.stopPropagation(); setMode(mode === 'min' ? 'open' : 'min'); });
    document.body.append(el);
    let pos = null;
    try { pos = JSON.parse(store(KEY_POS) || 'null'); } catch { /* none */ }
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) place(pos.x, pos.y);
    const saved = store(KEY_MODE);
    mode = saved === 'open' || saved === 'min' ? saved : (window.matchMedia('(max-width: 720px)').matches ? 'min' : 'open');
    window.addEventListener('resize', () => keepOnScreen());
    // The countdowns and "updated" move on between pushes.
    tick = setInterval(render, 30 * 1000);
  }

  window.UsagePanel = {
    setAvailable(on) {
      if (!on && el) { el.remove(); el = null; clearInterval(tick); }
    },
    update(msg) {
      data = { at: msg.at, providers: Array.isArray(msg.providers) ? msg.providers : [] };
      if (!el) build();
      render();
    },
  };
})();
