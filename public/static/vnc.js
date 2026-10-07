'use strict';
// The desktop: a panel over the terminal area that shows this machine's VNC
// desktop with noVNC (loaded on first use from /vendor/novnc). The WebSocket
// goes to /vnc, which server.js relays to the VNC server (lib/vnc.js).
// Uses app.js's globals: $, storage, toast, copyText, setSidebar, mobile.

const Vnc = (() => {
  // [label, width, height]
  const PRESETS = [
    ['1024 × 768', 1024, 768],
    ['1280 × 720  (HD)', 1280, 720],
    ['1366 × 768', 1366, 768],
    ['1440 × 900', 1440, 900],
    ['1600 × 900', 1600, 900],
    ['1920 × 1080  (Full HD)', 1920, 1080],
    ['1920 × 1200', 1920, 1200],
    ['2560 × 1440  (QHD)', 2560, 1440],
    ['3440 × 1440  (ultrawide)', 3440, 1440],
    ['3840 × 2160  (4K)', 3840, 2160],
  ];

  const v = {
    available: false, built: false, open: false, RFB: null, rfb: null, loading: false,
    // Off by default: resizing changes the real desktop for everyone looking at it.
    auto: storage('wt.vncAuto') === '1',
    fit: storage('wt.vncFit') !== '0',
    preset: storage('wt.vncPreset') || '',
    poll: 0, tries: 0, local: true,
    // Which VNC server: empty = the one on this machine.
    host: '', port: '',
  };
  try { const t = JSON.parse(storage('wt.vncTarget') || '{}'); v.host = String(t.host || ''); v.port = String(t.port || ''); } catch { /* none saved */ }
  const el = {};

  function build() {
    if (v.built) return;
    v.built = true;
    const root = $('#vnc');
    root.innerHTML = `
      <header class="vnc-head">
        <div class="vnc-title"><span class="vnc-dot" aria-hidden="true"></span><b>Desktop</b><span class="vnc-status" role="status"></span></div>
        <form class="vnc-target" title="Which VNC server to show. Leave both empty for the desktop of this machine; a port below 100 is a display number (1 means 5901).">
          <input class="vnc-host" type="text" placeholder="this machine" aria-label="VNC server address" spellcheck="false" autocomplete="off" size="16">
          <span aria-hidden="true">:</span>
          <input class="vnc-port" type="text" inputmode="numeric" placeholder="5901" aria-label="VNC server port" spellcheck="false" autocomplete="off" size="5">
          <button type="submit" class="tool-btn" title="Connect to this server">Connect</button>
        </form>
        <label class="vnc-switch" title="While on, the desktop's resolution follows the size of this panel (resize the window, drag the sidebar) as long as you stay connected.">
          <input type="checkbox" class="vnc-auto"><span class="vnc-slider" aria-hidden="true"></span><span>Resize desktop with window</span>
        </label>
        <select class="vnc-preset" aria-label="Desktop size" title="Set the desktop to a standard resolution (turns off the resizing with the window)"></select>
        <label class="tool-check vnc-fitlabel" title="Scale the desktop to fit this panel instead of showing it at its own size"><input type="checkbox" class="vnc-fit"> Scale to fit</label>
        <span class="vnc-spacer"></span>
        <button class="tool-btn" data-v="cad" title="Send Ctrl+Alt+Del to the desktop">Ctrl+Alt+Del</button>
        <button class="tool-btn" data-v="paste" title="Send the text on your clipboard to the desktop's clipboard">Paste</button>
        <button class="tool-btn" data-v="full" title="Full screen">⛶</button>
        <button class="tool-btn" data-v="reconnect" title="Connect again">Reconnect</button>
        <button class="icon-btn" data-v="close" title="Close the desktop" aria-label="Close the desktop">✕</button>
      </header>
      <div class="vnc-body">
        <div class="vnc-screen"></div>
        <div class="vnc-msg" hidden></div>
      </div>`;
    const q = (s) => root.querySelector(s);
    Object.assign(el, {
      root, status: q('.vnc-status'), dot: q('.vnc-dot'), auto: q('.vnc-auto'), preset: q('.vnc-preset'), fit: q('.vnc-fit'),
      fitLabel: q('.vnc-fitlabel'), screen: q('.vnc-screen'), msg: q('.vnc-msg'),
      host: q('.vnc-host'), port: q('.vnc-port'), target: q('.vnc-target'),
    });
    el.host.value = v.host;
    el.port.value = v.port;
    el.target.addEventListener('submit', (e) => { e.preventDefault(); disconnect(); connect(); });
    el.preset.innerHTML = '<option value="">Size…</option>'
      + PRESETS.map(([label, w, h]) => `<option value="${w}x${h}">${label}</option>`).join('')
      + '<option value="custom">Custom…</option>';
    el.auto.checked = v.auto;
    el.fit.checked = v.fit;
    syncControls();

    el.auto.addEventListener('change', () => {
      v.auto = el.auto.checked;
      storage('wt.vncAuto', v.auto ? '1' : '0');
      if (v.auto) { v.preset = ''; storage('wt.vncPreset', ''); }
      applySizing();
    });
    el.fit.addEventListener('change', () => {
      v.fit = el.fit.checked;
      storage('wt.vncFit', v.fit ? '1' : '0');
      applySizing();
    });
    el.preset.addEventListener('change', () => {
      const val = el.preset.value;
      el.preset.blur();
      if (val === 'custom') {
        const text = window.prompt('Desktop size, as width × height (for example 1600x1000):', '1600x1000');
        const m = text && /^\s*(\d{3,5})\s*[x×*,]\s*(\d{3,5})\s*$/i.exec(text);
        if (!m) { showCurrentSize(); return; }
        setSize(Number(m[1]), Number(m[2]));
      } else if (val) {
        const [w, h] = val.split('x').map(Number);
        setSize(w, h);
      }
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const act = b.dataset.v;
      if (act === 'close') close();
      else if (act === 'reconnect') { disconnect(); connect(); }
      else if (act === 'cad') { if (v.rfb) v.rfb.sendCtrlAltDel(); }
      else if (act === 'paste') sendClipboard();
      else if (act === 'full') { if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen?.(); }
    });
  }

  function syncControls() {
    el.auto.checked = v.auto;
    el.fit.checked = v.fit;
    el.fit.disabled = v.auto; // the desktop already is the size of the panel
    el.fitLabel.classList.toggle('off', v.auto);
  }

  const setStatus = (text, state) => {
    el.status.textContent = text ? ` · ${text}` : '';
    el.dot.dataset.state = state || 'idle';
  };

  function showMsg(html, build) {
    el.msg.hidden = !html && !build;
    el.msg.textContent = '';
    if (build) build(el.msg);
    else if (html) el.msg.textContent = html;
  }

  // ---------------------------------------------------------------- connection

  async function connect() {
    if (v.rfb || v.loading) return;
    v.loading = true;
    setStatus('connecting…', 'busy');
    showMsg('Connecting to the desktop…');
    try {
      if (!v.RFB) v.RFB = (await import('/vendor/novnc/core/rfb.js')).default;
    } catch (err) {
      v.loading = false;
      setStatus('could not load the viewer', 'bad');
      showMsg(`The desktop viewer could not be loaded (${err.message}).`);
      return;
    }
    v.loading = false;
    if (!v.open) return; // closed meanwhile
    v.host = el.host.value.trim();
    v.port = el.port.value.trim();
    storage('wt.vncTarget', JSON.stringify({ host: v.host, port: v.port }));
    if ((v.host && !/^[A-Za-z0-9._:-]{1,253}$/.test(v.host)) || (v.port && !/^\d{1,5}$/.test(v.port)) || (v.port && Number(v.port) > 65535)) {
      setStatus('check the address', 'bad');
      showMsg('That is not a valid server address. Use a host name or IP address, and a port number (or a display number such as 1).');
      return;
    }
    if (!v.host && !v.port && !v.local) {
      setStatus('no VNC server here', 'bad');
      showMsg('There is no VNC server on this machine. Type the address of one above (for example 192.168.1.20 and 5900) and press Connect.');
      return;
    }
    const params = new URLSearchParams();
    if (v.host) params.set('host', v.host);
    if (v.port) params.set('port', v.port);
    const query = params.toString() ? `?${params}` : '';
    v.shown = v.host || v.port ? `${v.host || 'this machine'}${v.port ? `:${v.port}` : ''}` : '';
    const rfb = new v.RFB(el.screen, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/vnc${query}`, { shared: true });
    v.rfb = rfb;
    rfb.background = '#0b0d11';
    rfb.focusOnClick = true;
    applySizing();

    rfb.addEventListener('connect', () => {
      setStatus('', 'ok');
      showMsg('');
      v.tries = 0;
      el.screen.querySelector('canvas')?.focus();
      rfb.focus();
      // A size chosen earlier: the server announces that it can resize a moment after connecting.
      if (!v.auto && v.preset) {
        const [w, h] = v.preset.split('x').map(Number);
        let n = 0;
        const t = setInterval(() => {
          if (v.rfb !== rfb || ++n > 40) return clearInterval(t);
          if (rfb._supportsSetDesktopSize) { clearInterval(t); sendSize(w, h); }
        }, 100);
      }
      startPoll();
    });
    let failure = ''; // why the server refused us, when it said
    rfb.addEventListener('disconnect', (e) => {
      if (v.rfb !== rfb) return;
      v.rfb = null;
      stopPoll();
      setStatus(failure ? 'login refused' : e.detail.clean ? 'disconnected' : 'connection lost', 'bad');
      if (v.open) {
        showMsg('', (box) => {
          const p = document.createElement('p');
          p.textContent = failure ? `${failure}.`
            : e.detail.clean ? 'The desktop connection was closed.' : 'The connection to the desktop was lost.';
          const b = document.createElement('button');
          b.className = 'primary';
          b.textContent = 'Reconnect';
          b.onclick = () => connect();
          box.append(p);
          if (/too many security failures/i.test(failure)) {
            const hint = document.createElement('p');
            hint.className = 'vnc-hint';
            hint.textContent = 'The VNC server blocks an address for a while after repeated failed logins. Wait a minute or two and reconnect.';
            box.append(hint);
          }
          box.append(b);
        });
      }
    });
    rfb.addEventListener('credentialsrequired', () => {
      // The server could not log in for us: ask for the VNC password.
      setStatus('password needed', 'busy');
      showMsg('', (box) => {
        const form = document.createElement('form');
        const p = document.createElement('p');
        p.textContent = 'This desktop is protected by a VNC password.';
        const input = document.createElement('input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.placeholder = 'VNC password';
        const b = document.createElement('button');
        b.className = 'primary';
        b.textContent = 'Connect';
        form.append(p, input, b);
        form.onsubmit = (ev) => { ev.preventDefault(); rfb.sendCredentials({ password: input.value }); showMsg('Connecting to the desktop…'); };
        box.append(form);
        input.focus();
      });
    });
    rfb.addEventListener('securityfailure', (e) => {
      // The disconnect that follows shows it, with a Reconnect button.
      failure = (e.detail && e.detail.reason ? String(e.detail.reason) : 'the login was refused').replace(/[.\s]+$/, '');
    });
    rfb.addEventListener('clipboard', (e) => {
      const text = e.detail.text;
      if (!text) return;
      copyText(text).then((ok) => { if (ok) toast(`Desktop clipboard copied (${text.length} characters)`, 1800); });
    });
  }

  function disconnect() {
    stopPoll();
    if (v.rfb) {
      const r = v.rfb;
      v.rfb = null;
      try { r.disconnect(); } catch { /* already closed */ }
    }
    el.screen.textContent = '';
  }

  // ---------------------------------------------------------------- sizing

  // Follow the panel's size (auto), or show the desktop at its own size,
  // scaled to fit or with scrollbars.
  function applySizing() {
    syncControls();
    const rfb = v.rfb;
    if (!rfb) return;
    rfb.resizeSession = v.auto;
    rfb.scaleViewport = !v.auto && v.fit;
    rfb.clipViewport = false;
    showCurrentSize();
  }

  // Ask the VNC server for a desktop of this size (RFB SetDesktopSize).
  function sendSize(w, h) {
    const rfb = v.rfb;
    if (!rfb) return false;
    if (!rfb._supportsSetDesktopSize) { toast('This VNC server cannot change the size of its desktop.'); return false; }
    try {
      v.RFB.messages.setDesktopSize(rfb._sock, w, h, rfb._screenID, rfb._screenFlags);
      return true;
    } catch (err) {
      toast(`Could not change the desktop size (${err.message}).`);
      return false;
    }
  }

  function setSize(w, h) {
    w = Math.max(320, Math.min(8192, w));
    h = Math.max(200, Math.min(8192, h));
    v.auto = false;
    v.fit = true; // a fixed size is shown scaled into the panel
    v.preset = `${w}x${h}`;
    storage('wt.vncAuto', '0');
    storage('wt.vncFit', '1');
    storage('wt.vncPreset', v.preset);
    applySizing();
    sendSize(w, h);
  }

  function currentSize() {
    const r = v.rfb;
    return r && r._fbWidth ? { w: r._fbWidth, h: r._fbHeight } : null;
  }

  // The size box shows the desktop's real size when it matches a preset.
  function showCurrentSize() {
    if (!el.preset) return;
    const s = currentSize();
    const key = s ? `${s.w}x${s.h}` : '';
    const known = [...el.preset.options].some((o) => o.value === key);
    el.preset.value = known ? key : '';
    el.preset.options[0].textContent = s && !known ? `${s.w} × ${s.h}` : 'Size…';
  }

  function startPoll() {
    stopPoll();
    v.poll = setInterval(() => {
      const s = currentSize();
      showCurrentSize();
      if (s && v.rfb) setStatus(`${v.shown ? `${v.shown} · ` : ''}${s.w} × ${s.h}${v.auto ? ' · follows the window' : ''}`, 'ok');
    }, 500);
  }
  function stopPoll() { clearInterval(v.poll); v.poll = 0; }

  async function sendClipboard() {
    if (!v.rfb) return;
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* not allowed here (plain http, or refused) */ }
    if (!text) text = window.prompt('Text to put on the desktop\'s clipboard:') || '';
    if (!text) return;
    v.rfb.clipboardPasteFrom(text);
    toast(`Sent ${text.length} characters to the desktop's clipboard. Paste there with Ctrl+V.`, 2400);
  }

  // ---------------------------------------------------------------- open / close

  function open() {
    if (!v.available) return;
    build();
    v.open = true;
    el.root.hidden = false;
    $('#app').classList.add('vnc-open');
    if (mobile.matches) setSidebar(false);
    connect();
  }

  function close() {
    if (!v.open) return;
    v.open = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    disconnect();
    el.root.hidden = true;
    $('#app').classList.remove('vnc-open');
    // The terminal on screen gets the keyboard back.
    if (typeof focusActive === 'function') focusActive();
  }

  // Whether this machine runs a VNC server of its own (the page offers the button anyway: any server can be typed in).
  function setLocal(on) { v.local = on; }

  function setAvailable(on) {
    v.available = on;
    for (const b of document.querySelectorAll('.vnc-btn')) b.hidden = !on;
    if (!on && v.open) close();
  }

  for (const b of document.querySelectorAll('.vnc-btn')) b.addEventListener('click', () => (v.open ? close() : open()));

  return { open, close, setAvailable, setLocal, isOpen: () => v.open };
})();
