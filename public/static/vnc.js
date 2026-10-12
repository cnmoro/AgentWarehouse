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

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  const v = {
    available: false, built: false, open: false, RFB: null, rfb: null, loading: false,
    // Off by default: resizing changes the real desktop for everyone looking at it.
    auto: storage('wt.vncAuto') === '1',
    fit: storage('wt.vncFit') !== '0',
    preset: storage('wt.vncPreset') || '',
    poll: 0, tries: 0, local: true, remoteClip: '',
    // Which VNC server: empty = the one on this machine.
    host: '', port: '',
    // "Fluid": the screen as video (ffmpeg on the server, played here); input still goes through VNC.
    fluidOk: false, codecs: [], gpu: false, stream: null,
    mode: storage('wt.vncMode') || 'fluid',
    codec: storage('wt.vncCodec') || 'h264',
    fps: Number(storage('wt.vncFps')) || 60,
    mbps: Number(storage('wt.vncMbps')) || 12,
    quality: storage('wt.vncQuality') || 'balanced',
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
        <span class="vnc-modes" hidden>
          <select class="vnc-mode" aria-label="Streaming mode" title="Fluid: the screen is streamed as video (up to 60 fps). VNC: classic region updates, works with any VNC server.">
            <option value="fluid">Fluid (video)</option><option value="vnc">VNC</option>
          </select>
          <span class="vnc-fluidopts">
            <select class="vnc-codec" aria-label="Video codec" title="Video codec. H.264 has the lowest delay. VP9 and AV1 look better at low bit rates but browsers decode them with more delay and the server needs more CPU."></select>
            <select class="vnc-fps" aria-label="Frames per second" title="Frames per second"><option value="30">30 fps</option><option value="45">45 fps</option><option value="60">60 fps</option></select>
            <select class="vnc-mbps" aria-label="Bit rate" title="Video bit rate: higher is sharper and uses more network"><option value="4">4 Mbps</option><option value="8">8 Mbps</option><option value="12">12 Mbps</option><option value="20">20 Mbps</option><option value="35">35 Mbps</option></select>
          </span>
        </span>
        <select class="vnc-quality" aria-label="VNC image quality" title="VNC image quality: lower is faster on a slow link, higher is sharper">
          <option value="fast">Quality: fast</option><option value="balanced">Quality: balanced</option><option value="high">Quality: high</option><option value="best">Quality: best</option>
        </select>
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
        <button class="tool-btn vnc-getclip" data-v="getclip" title="The desktop copied some text: put it on your clipboard" hidden>Copy from desktop</button>
        <button class="tool-btn" data-v="paste" title="Send the text on your clipboard to the desktop's clipboard (Ctrl+V on the desktop does this by itself)">Paste</button>
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
      host: q('.vnc-host'), port: q('.vnc-port'), target: q('.vnc-target'), body: q('.vnc-body'),
      modes: q('.vnc-modes'), mode: q('.vnc-mode'), fluidOpts: q('.vnc-fluidopts'), codec: q('.vnc-codec'), fps: q('.vnc-fps'), mbps: q('.vnc-mbps'), quality: q('.vnc-quality'),
    });
    el.mode.value = v.mode; el.fps.value = String(v.fps); el.mbps.value = String(v.mbps); el.quality.value = v.quality;
    fillCodecs();
    syncModeUI();
    el.mode.addEventListener('change', () => { v.mode = el.mode.value; storage('wt.vncMode', v.mode); reconnect(); });
    el.codec.addEventListener('change', () => { v.codec = el.codec.value; storage('wt.vncCodec', v.codec); restartStream(); });
    el.fps.addEventListener('change', () => { v.fps = Number(el.fps.value); storage('wt.vncFps', String(v.fps)); restartStream(); });
    el.mbps.addEventListener('change', () => { v.mbps = Number(el.mbps.value); storage('wt.vncMbps', String(v.mbps)); restartStream(); });
    el.quality.addEventListener('change', () => { v.quality = el.quality.value; storage('wt.vncQuality', v.quality); applyQuality(); });
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('visibilitychange', onVisibility);
    el.host.value = v.host;
    el.port.value = v.port;
    el.target.hidden = !v.targetOk;
    el.target.addEventListener('submit', (e) => { e.preventDefault(); disconnect(); connect(); });
    // Capture phase on the desktop's container: before noVNC's own handlers on its canvas.
    el.screen.addEventListener('keydown', onKeyDown, true);
    el.screen.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('paste', onPaste, true);
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
      else if (act === 'getclip') takeRemoteClipboard();
      else if (act === 'full') { if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen?.(); }
    });
  }

  function syncControls() {
    el.auto.checked = v.auto;
    el.fit.checked = v.fit;
    const noFit = v.auto || v.fluidNow;
    el.fit.disabled = noFit; // the desktop already is the size of the panel (or is video, which always fits)
    el.fitLabel.classList.toggle('off', noFit);
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
    v.host = v.targetOk ? el.host.value.trim() : '';
    v.port = v.targetOk ? el.port.value.trim() : '';
    if (v.targetOk) storage('wt.vncTarget', JSON.stringify({ host: v.host, port: v.port }));
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
    const fluid = fluidActive();
    v.fluidNow = fluid;
    el.screen.classList.toggle('vnc-fluid', fluid);
    syncModeUI();
    if (fluid) { patchTiny(); rfb._sock._wtTiny = true; }
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
      if (fluid) startStream(); else applyQuality();
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
      // The desktop copied something. A page may only write the clipboard while
      // the user is doing something, so when that is refused, a button keeps the text.
      const text = e.detail.text;
      if (!text) return;
      v.remoteClip = text;
      copyText(text).then((ok) => {
        if (ok) { toast(`Desktop clipboard copied (${text.length} characters)`, 1800); showRemoteClip(false); }
        else showRemoteClip(true);
      });
    });
  }

  function disconnect() {
    stopPoll();
    stopStream();
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
    rfb.scaleViewport = !v.auto && (v.fit || v.fluidNow); // the video is always scaled to fit
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
      const st = v.stream;
      if (st && s && st.size && (st.size.w !== s.w || st.size.h !== s.h)) { st.size = s; restartStream(250); } // the desktop changed size: capture again
      const live = st && st.fps ? ` · ${st.fps} fps ${CODEC_NAME[v.codec]}` : '';
      if (s && v.rfb) setStatus(`${v.shown ? `${v.shown} · ` : ''}${s.w} × ${s.h}${v.auto ? ' · follows the window' : ''}${v.fluidNow ? (live || ' · video…') : ''}`, 'ok');
    }, 500);
  }
  function stopPoll() { clearInterval(v.poll); v.poll = 0; }

  // ---------------------------------------------------------------- modes and quality

  const CODEC_NAME = { h264: 'H.264', vp9: 'VP9', av1: 'AV1' };
  // Whether the screen can be shown as video: the server can encode it, this browser can play it,
  // and the desktop is this machine's own (the video is taken from its display).
  const mediaOk = !!(window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f"'));
  const fluidAvailable = () => v.fluidOk && mediaOk && v.local && !v.host && !v.port;
  const fluidActive = () => v.mode === 'fluid' && fluidAvailable();

  function fillCodecs() {
    if (!el.codec) return;
    const list = v.codecs.length ? v.codecs : ['h264'];
    if (!list.includes(v.codec)) v.codec = list[0];
    el.codec.innerHTML = list.map((c) => `<option value="${c}">${CODEC_NAME[c]}${c === 'h264' ? (v.gpu ? ' (GPU)' : ' (low delay)') : ' (more delay)'}</option>`).join('');
    el.codec.value = v.codec;
  }
  function syncModeUI() {
    if (!el.modes) return;
    const avail = fluidAvailable();
    el.modes.hidden = !avail;
    el.fluidOpts.hidden = v.mode !== 'fluid';
    el.quality.hidden = fluidActive();
  }
  function reconnect() { disconnect(); connect(); }

  // JPEG quality and compression level of VNC's image updates. A higher compression level costs
  // the server CPU time, which is what limits the frame rate at full speed, so the levels stay low.
  const QUALITY = { fast: [4, 1], balanced: [6, 1], high: [8, 1], best: [9, 0] };
  function applyQuality() {
    const r = v.rfb;
    if (!r || v.fluidNow) return;
    const [q, c] = QUALITY[v.quality] || QUALITY.balanced;
    r.qualityLevel = q;
    r.compressionLevel = c;
  }

  // In Fluid mode the VNC connection only carries input (keys, mouse, clipboard) and the
  // desktop's size; the image is the video. So noVNC is made to ask for a single pixel instead
  // of the whole screen, and the server has next to nothing to send.
  function patchTiny() {
    const M = v.RFB.messages;
    if (M._wtTiny) return;
    M._wtTiny = true;
    const request = M.fbUpdateRequest;
    const cont = M.enableContinuousUpdates;
    M.fbUpdateRequest = function (sock, incremental, x, y, w, h) {
      return sock._wtTiny ? request.call(this, sock, incremental, 0, 0, 1, 1) : request.call(this, sock, incremental, x, y, w, h);
    };
    M.enableContinuousUpdates = function (sock, enable, x, y, w, h) {
      return sock._wtTiny ? cont.call(this, sock, enable, 0, 0, 1, 1) : cont.call(this, sock, enable, x, y, w, h);
    };
  }

  // ---------------------------------------------------------------- the video

  const ascii = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const find = (b, tag) => { for (let i = 0; i + 4 <= b.length; i++) if (ascii(b, i) === tag) return i; return -1; };
  // The codec string for MediaSource, read from the stream's init segment.
  function codecString(init) {
    const hex = (n, d = 2) => n.toString(16).padStart(d, '0');
    let i;
    if ((i = find(init, 'avcC')) >= 0) return `avc1.${hex(init[i + 5])}${hex(init[i + 6])}${hex(init[i + 7])}`;
    if ((i = find(init, 'vpcC')) >= 0) return `vp09.${String(init[i + 8]).padStart(2, '0')}.${String(init[i + 9]).padStart(2, '0')}.${String(init[i + 10] >> 4).padStart(2, '0')}`;
    if ((i = find(init, 'av1C')) >= 0) return `av01.${init[i + 5] >> 5}.${String(init[i + 5] & 31).padStart(2, '0')}${init[i + 6] & 0x80 ? 'H' : 'M'}.${String(init[i + 6] & 0x40 ? (init[i + 6] & 0x20 ? 12 : 10) : 8).padStart(2, '0')}`;
    return '';
  }
  const concat = (parts) => {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  function startStream() {
    stopStream();
    if (!v.open || !v.rfb || !fluidActive()) return;
    showMsg('');
    const wc = canWebCodecs();
    const video = document.createElement(wc ? 'canvas' : 'video');
    video.className = 'vnc-video';
    if (!wc) {
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
    }
    el.body.append(video);
    const st = { wc, dec: null, ctx: null, pre: [], n: 0, video, ws: null, ms: null, sb: null, url: '', buf: new Uint8Array(0), init: [], moof: null, queue: [], fps: 0, frames: 0, closed: false, size: currentSize(), timers: [], mime: '' };
    v.stream = st;
    const q = new URLSearchParams({ codec: v.codec, fps: String(v.fps), mbps: String(v.mbps) });
    if (wc) q.set('fmt', 'raw');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/vstream?${q}`);
    ws.binaryType = 'arraybuffer';
    st.ws = ws;
    ws.onmessage = (e) => {
      if (st.closed) return;
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data);
          if (m.t === 'error') streamFailed(m.message);
          else if (m.t === 'ended' && v.stream === st) captureEnded();
        } catch { /* not ours */ }
        return;
      }
      if (wc) feedRaw(st, new Uint8Array(e.data)); else feed(st, new Uint8Array(e.data));
    };
    ws.onclose = () => { if (!st.closed && v.stream === st) setTimeout(() => { if (!st.closed && v.stream === st) streamFailed('The video connection closed.'); }, 200); };
    ws.onerror = () => {};
    // Keep the video over the canvas that noVNC resizes, and count frames.
    const sync = () => syncVideo(st);
    st.timers.push(setInterval(sync, 250));
    if (!wc) st.timers.push(setInterval(() => liveEdge(st), 100));
    const ro = new ResizeObserver(sync);
    ro.observe(el.body);
    st.ro = ro;
    let last = performance.now();
    const tick = (now) => {
      if (st.closed) return;
      st.frames++;
      if (now - last >= 1000) { st.fps = Math.round((st.frames * 1000) / (now - last)); st.frames = 0; last = now; }
      video.requestVideoFrameCallback(tick);
    };
    if (wc) st.timers.push(setInterval(() => { const now = performance.now(); st.fps = Math.round((st.frames * 1000) / (now - last)); st.frames = 0; last = now; }, 1000));
    else if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    sync();
  }

  function syncVideo(st) {
    const c = el.screen.querySelector('canvas');
    if (!c || st.closed) return;
    const b = el.body.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    Object.assign(st.video.style, { left: `${r.left - b.left}px`, top: `${r.top - b.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  // ---- WebCodecs: the frames are decoded and drawn as soon as they arrive, with none of the buffering a media
  // element adds. It needs a secure context (HTTPS or localhost) and a browser with VideoDecoder.
  const canWebCodecs = () => !v.noWC && window.isSecureContext && typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';

  // Falls back to the media element (MSE) for this and the following streams.
  function wcFallback(why) {
    if (!v.stream) return;
    console.warn('[vnc] WebCodecs not used:', why);
    v.noWC = true;
    stopStream();
    startStream();
  }

  // Raw stream in: H.264 is split into frames at each access unit delimiter, VP9 and AV1 come in IVF frames.
  function feedRaw(st, bytes) {
    st.buf = st.buf.length ? concat([st.buf, bytes]) : bytes;
    if (v.codec === 'h264') {
      for (;;) {
        const b = st.buf;
        const next = nextAud(b, 4);
        if (next < 0) break;
        const au = b.slice(0, next);
        st.buf = b.subarray(next);
        wcFrame(st, au);
      }
    } else {
      if (!st.ivf) { if (st.buf.length < 32) return; st.buf = st.buf.subarray(32); st.ivf = true; }
      for (;;) {
        const b = st.buf;
        if (b.length < 12) break;
        const size = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
        if (b.length < 12 + size) break;
        const fr = b.slice(12, 12 + size);
        st.buf = b.subarray(12 + size);
        wcFrame(st, fr);
      }
    }
  }
  // Where the next access unit delimiter (NAL type 9) starts, counting its zero byte, or -1.
  function nextAud(b, from) {
    for (let i = from; i + 4 <= b.length; i++) {
      if (b[i + 2] === 1 && b[i + 1] === 0 && b[i] === 0 && (b[i + 3] & 31) === 9) return i > 0 && b[i - 1] === 0 ? i - 1 : i;
    }
    return -1;
  }
  const hasNal = (b, type) => {
    for (let i = 0; i + 4 <= b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 31) === type) return i + 3;
    return -1;
  };

  function wcFrame(st, data) {
    if (st.closed) return;
    let key = st.n === 0;
    let codec = '';
    if (v.codec === 'h264') {
      key = hasNal(data, 5) >= 0;
      const sps = hasNal(data, 7);
      if (!st.dec && sps >= 0) codec = `avc1.${[1, 2, 3].map((k) => data[sps + k].toString(16).padStart(2, '0')).join('')}`;
    } else if (v.codec === 'vp9') {
      key = !(data[0] & 0x0c);
      codec = 'vp09.00.51.08';
    } else {
      codec = 'av01.0.13M.08';
    }
    if (!st.dec) {
      st.pre.push({ data, key });
      if (codec && !st.starting) wcStart(st, codec);
      return;
    }
    wcDecode(st, data, key);
  }

  function wcStart(st, codec) {
    st.starting = true;
    const config = { codec, optimizeForLatency: true };
    VideoDecoder.isConfigSupported(config).then((r) => {
      if (st.closed) return;
      if (!r.supported) return wcFallback(`${codec} is not supported`);
      const ctx = st.video.getContext('2d', { alpha: false, desynchronized: true });
      st.ctx = ctx;
      const dec = new VideoDecoder({
        output: (frame) => {
          st.frames++;
          if (st.closed) { frame.close(); return; }
          const c = st.video;
          if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) { c.width = frame.displayWidth; c.height = frame.displayHeight; }
          ctx.drawImage(frame, 0, 0);
          frame.close();
        },
        error: (e) => { if (!st.closed) wcFallback(e.message); },
      });
      dec.configure(r.config);
      st.dec = dec;
      for (const f of st.pre.splice(0)) wcDecode(st, f.data, f.key);
    }).catch((e) => wcFallback(e.message));
  }

  function wcDecode(st, data, key) {
    // A first frame that is not a key frame cannot be decoded: wait for one.
    if (!st.synced) { if (!key) return; st.synced = true; }
    try {
      st.dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round((st.n++ * 1e6) / v.fps), data }));
    } catch (e) { wcFallback(e.message); }
  }

  // Splits what arrives into MP4 boxes: ftyp and moov make the init segment; each moof + mdat is one frame.
  function feed(st, bytes) {
    st.buf = st.buf.length ? concat([st.buf, bytes]) : bytes;
    for (;;) {
      const b = st.buf;
      if (b.length < 8) break;
      const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      if (size < 8) { streamFailed('The video stream is damaged.'); return; }
      if (b.length < size) break;
      const type = ascii(b, 4);
      const box = b.slice(0, size);
      st.buf = b.subarray(size);
      if (type === 'ftyp' || type === 'moov') st.init.push(box);
      else if (type === 'moof') st.moof = box;
      else if (type === 'mdat' && st.moof) {
        const seg = concat([st.moof, box]);
        st.moof = null;
        if (!st.ms) openSource(st);
        st.queue.push(seg);
      }
    }
    pump(st);
  }

  function openSource(st) {
    const init = concat(st.init);
    const mime = `video/mp4; codecs="${codecString(init)}"`;
    st.mime = mime;
    if (!MediaSource.isTypeSupported(mime)) { streamFailed(`This browser cannot play ${CODEC_NAME[v.codec]} video here. Pick another codec, or use VNC mode.`); return; }
    const ms = new MediaSource();
    st.ms = ms;
    st.url = URL.createObjectURL(ms);
    st.video.src = st.url;
    ms.addEventListener('sourceopen', () => {
      if (st.closed || st.sb) return;
      try {
        const sb = ms.addSourceBuffer(mime);
        st.sb = sb;
        sb.addEventListener('updateend', () => { pump(st); });
        sb.addEventListener('error', () => streamFailed('The browser could not play the video.'));
        sb.appendBuffer(init);
      } catch (err) { streamFailed(`The browser could not play the video (${err.message}).`); }
    }, { once: true });
  }

  function pump(st) {
    const sb = st.sb;
    if (st.closed || !sb || sb.updating || !st.queue.length) return;
    try {
      sb.appendBuffer(concat(st.queue.splice(0, st.queue.length)));
    } catch (err) {
      if (err.name === 'QuotaExceededError') { trim(st, true); return; }
      streamFailed(`The browser could not play the video (${err.message}).`);
    }
  }

  function trim(st, hard) {
    const sb = st.sb, vd = st.video;
    if (!sb || sb.updating || !vd.buffered.length) return;
    const start = vd.buffered.start(0);
    if (vd.currentTime - start > (hard ? 0.5 : 3)) { try { sb.remove(start, vd.currentTime - (hard ? 0.2 : 1)); } catch { /* retried later */ } }
  }

  // Stay at the live edge: a player left alone would drift behind by whatever it buffered.
  function liveEdge(st) {
    const vd = st.video;
    if (st.closed || !st.sb || !vd.buffered.length) return;
    const end = vd.buffered.end(vd.buffered.length - 1);
    if (vd.paused) vd.play().catch(() => {});
    const lag = end - vd.currentTime;
    if (lag > 0.5 || vd.currentTime < vd.buffered.start(0)) vd.currentTime = Math.max(vd.buffered.start(0), end - 0.03);
    else vd.playbackRate = lag > 0.15 ? 1.15 : lag > 0.08 ? 1.05 : 1;
    if (!st.trimmed || performance.now() - st.trimmed > 2000) { st.trimmed = performance.now(); trim(st, false); }
    pump(st);
  }

  function stopStream() {
    const st = v.stream;
    if (!st) return;
    v.stream = null;
    st.closed = true;
    st.timers.forEach(clearInterval);
    st.ro?.disconnect();
    try { st.ws.close(); } catch { /* closed */ }
    try { st.dec?.close(); } catch { /* closed */ }
    if (!st.wc) try { st.video.removeAttribute('src'); st.video.load(); } catch { /* gone */ }
    if (st.url) URL.revokeObjectURL(st.url);
    st.video.remove();
  }

  let restartTimer = 0;
  function restartStream(delay = 0) {
    if (!v.stream && !fluidActive()) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { if (v.open && v.rfb && fluidActive()) startStream(); }, delay);
  }

  // The server's capture ended by itself (the desktop was resized): start it again, unless that keeps happening.
  const restarts = [];
  function captureEnded() {
    const now = Date.now();
    restarts.push(now);
    while (restarts.length && now - restarts[0] > 10000) restarts.shift();
    stopStream();
    if (restarts.length > 4) return streamFailed('The screen capture keeps stopping.', true);
    restartStream(300);
  }

  function streamFailed(message, again = false) {
    if (!v.stream && !again) return;
    stopStream();
    setStatus('video stopped', 'bad');
    showMsg('', (box) => {
      const p = document.createElement('p');
      p.textContent = message || 'The video stopped.';
      const again = document.createElement('button');
      again.className = 'primary';
      again.textContent = 'Try again';
      again.onclick = () => { showMsg(''); startStream(); };
      const classic = document.createElement('button');
      classic.textContent = 'Use VNC mode';
      classic.style.marginLeft = '8px';
      classic.onclick = () => { v.mode = 'vnc'; storage('wt.vncMode', 'vnc'); el.mode.value = 'vnc'; reconnect(); };
      box.append(p, again, classic);
    });
  }

  // Full screen: ask the browser to hand over keys it keeps for itself (Esc, Alt+Tab, Ctrl+W...) where it can.
  function onFullscreen() {
    if (!navigator.keyboard) return;
    if (document.fullscreenElement === el.root) navigator.keyboard.lock?.().catch(() => {});
    else navigator.keyboard.unlock?.();
  }
  // A hidden tab does not need a video stream.
  function onVisibility() {
    if (!v.open || !v.fluidNow) return;
    if (document.hidden) stopStream();
    else if (v.rfb && !v.stream) startStream();
  }

  // ---------------------------------------------------------------- clipboard

  function showRemoteClip(on) {
    const b = el.root.querySelector('.vnc-getclip');
    if (!b) return;
    b.hidden = !on;
    if (on) b.textContent = `Copy from desktop (${v.remoteClip.length})`;
  }
  async function takeRemoteClipboard() {
    if (!v.remoteClip) return;
    const ok = await copyText(v.remoteClip);
    toast(ok ? `Copied ${v.remoteClip.length} characters from the desktop` : 'The browser refused to copy. Select and copy the text on the desktop again.', 2200);
    if (ok) showRemoteClip(false);
  }

  // This page to the desktop. Without a secure connection the browser will not
  // let a page read the clipboard, but a paste the user starts delivers its
  // text in a paste event. So a Ctrl+V on the desktop is held back until that
  // event arrives; the text goes to the desktop's clipboard, then the V is let
  // through. (On a Mac, Cmd+V and the other Cmd shortcuts become the Ctrl ones the
  // desktop expects, and the Cmd key itself stays here.)
  const MAC_SHORTCUTS = new Set(['c', 'x', 'a', 'z', 'y', 'f', 's', 'v']);
  const heldUp = new Set(); // key codes whose release must not reach the desktop either
  let waitingPaste = null;
  let pasteBox = null;
  function focusPasteBox() {
    if (!pasteBox) {
      pasteBox = document.createElement('textarea');
      pasteBox.setAttribute('aria-hidden', 'true');
      pasteBox.tabIndex = -1;
      pasteBox.style.cssText = 'position:fixed;left:-100px;top:0;width:10px;height:10px;opacity:0;';
      el.root.appendChild(pasteBox);
    }
    pasteBox.value = '';
    pasteBox.focus({ preventScroll: true });
  }
  function refocusDesktop() { el.screen.querySelector('canvas')?.focus({ preventScroll: true }); }

  function tap(letter, { ctrl = false, shift = false } = {}) {
    const r = v.rfb;
    if (!r) return;
    const code = `Key${letter.toUpperCase()}`;
    const sym = (shift ? letter.toUpperCase() : letter).charCodeAt(0);
    if (ctrl) r.sendKey(0xffe3, 'ControlLeft', true);
    if (shift) r.sendKey(0xffe1, 'ShiftLeft', true);
    r.sendKey(sym, code, true);
    r.sendKey(sym, code, false);
    if (shift) r.sendKey(0xffe1, 'ShiftLeft', false);
    if (ctrl) r.sendKey(0xffe3, 'ControlLeft', false);
  }

  function onKeyDown(e) {
    if (!v.rfb || !v.open) return;
    if (isMac && e.key === 'Meta') { e.stopPropagation(); e.preventDefault(); return; }
    const letter = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
    const cmd = isMac && e.metaKey && !e.ctrlKey;
    const ctrl = e.ctrlKey && !e.metaKey;
    if (!letter || e.altKey || e.repeat) return;
    if (letter === 'v' && (cmd || ctrl)) {
      // Not preventDefault: the paste event is the point.
      e.stopPropagation();
      heldUp.add(e.code);
      if (waitingPaste) clearTimeout(waitingPaste.timer);
      const mine = { shift: e.shiftKey };
      focusPasteBox();
      mine.timer = setTimeout(() => { if (waitingPaste === mine) { waitingPaste = null; refocusDesktop(); tap('v', { ctrl: true, shift: e.shiftKey }); } }, 250);
      waitingPaste = mine;
    } else if (cmd && MAC_SHORTCUTS.has(letter)) {
      e.stopPropagation();
      e.preventDefault();
      heldUp.add(e.code);
      tap(letter, { ctrl: true, shift: e.shiftKey });
    }
  }
  function onKeyUp(e) {
    if (isMac && e.key === 'Meta') { e.stopPropagation(); e.preventDefault(); return; }
    if (heldUp.delete(e.code)) e.stopPropagation();
  }
  function onPaste(e) {
    if (!waitingPaste || !v.rfb) return;
    const w = waitingPaste;
    waitingPaste = null;
    clearTimeout(w.timer);
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (text) v.rfb.clipboardPasteFrom(text);
    // Let the desktop take the new clipboard in before the paste key arrives.
    refocusDesktop();
    setTimeout(() => tap('v', { ctrl: true, shift: w.shift }), text ? 80 : 0);
  }

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
    // One panel at a time: the explorer would be hidden behind this one.
    if (typeof Files !== 'undefined' && Files.isOpen()) Files.close({ keepFocus: true });
    build();
    v.open = true;
    el.root.hidden = false;
    $('#app').classList.add('vnc-open');
    if (mobile.matches) setSidebar(false);
    connect();
  }

  function close({ keepFocus = false } = {}) {
    if (!v.open) return;
    v.open = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    disconnect();
    el.root.hidden = true;
    $('#app').classList.remove('vnc-open');
    // The terminal on screen gets the keyboard back (unless another panel is taking it).
    if (!keepFocus && typeof focusActive === 'function') focusActive();
  }

  // Whether this machine runs a VNC server of its own (the page offers the button anyway: any server can be typed in).
  function setLocal(on) { v.local = on; }
  // Older servers ignore the host and port; their page does not offer them.
  function setTargetSupport(on) {
    v.targetOk = on;
    if (el.target) el.target.hidden = !on;
  }

  // The server's list of what it can stream, e.g. "vnc-fluid:h264+vp9+av1+gpu".
  function setFluid(feature) {
    const parts = feature ? feature.slice('vnc-fluid:'.length).split('+') : [];
    v.fluidOk = parts.length > 0;
    v.gpu = parts.includes('gpu');
    v.codecs = parts.filter((c) => CODEC_NAME[c]);
    fillCodecs();
    syncModeUI();
  }

  function setAvailable(on) {
    v.available = on;
    for (const b of document.querySelectorAll('.vnc-btn')) b.hidden = !on;
    if (!on && v.open) close();
  }

  for (const b of document.querySelectorAll('.vnc-btn')) b.addEventListener('click', () => (v.open ? close() : open()));

  return { open, close, setAvailable, setLocal, setTargetSupport, setFluid, isOpen: () => v.open };
})();
