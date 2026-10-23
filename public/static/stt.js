'use strict';
// Dictation button (bottom right of the terminals): hold, speak, release. The
// recording goes to /api/stt/transcribe and the text is typed into the tab that
// was on screen when the button was pressed. Needs a server with soda-stt
// installed (the button does not show otherwise) and a page the browser
// treats as secure (HTTPS or localhost), because that is when it allows the
// microphone.
(() => {
  const MIN_MS = 400;
  const MAX_MS = 60 * 1000;
  const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

  let btn = null;
  let rec = null; // { recorder, stream, chunks, started, tab, timer, aborted }
  let busy = false;

  const pickType = () => (window.MediaRecorder && TYPES.find((t) => MediaRecorder.isTypeSupported(t))) || '';

  function setState(s) {
    btn.classList.toggle('rec', s === 'rec');
    btn.classList.toggle('busy', s === 'busy');
    btn.title = s === 'rec' ? 'Listening… release to type it'
      : s === 'busy' ? 'Transcribing…'
        : 'Hold to dictate, release to type it in the terminal';
    btn.setAttribute('aria-pressed', s === 'rec' ? 'true' : 'false');
  }

  function release(r) {
    clearTimeout(r.timer);
    for (const t of r.stream ? r.stream.getTracks() : []) t.stop();
  }

  async function start() {
    if (busy || rec) return;
    if (!state.active) { toast('Open a terminal first.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast(window.isSecureContext
        ? 'This browser cannot record audio.'
        : 'The browser only allows the microphone on HTTPS or localhost. Open this page through https:// (for example tailscale serve) or http://localhost.', 9000);
      return;
    }
    const r = { chunks: [], started: 0, tab: state.active, aborted: false, stream: null, recorder: null, timer: 0 };
    rec = r;
    setState('rec');
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      rec = null; setState('idle');
      toast(e && e.name === 'NotAllowedError' ? 'Microphone blocked. Allow it for this site in the browser.' : `Microphone: ${(e && e.message) || e}`, 7000);
      return;
    }
    if (r.aborted) { release(r); rec = null; setState('idle'); return; } // let go before the microphone was ready
    const type = pickType();
    r.recorder = new MediaRecorder(r.stream, type ? { mimeType: type } : undefined);
    r.recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) r.chunks.push(ev.data); };
    r.recorder.onstop = () => finish(r, r.recorder.mimeType || type || 'audio/webm');
    r.started = performance.now();
    r.recorder.start();
    r.timer = setTimeout(stop, MAX_MS);
  }

  function stop() {
    const r = rec;
    if (!r) return;
    if (!r.recorder) { r.aborted = true; return; }
    rec = null;
    release(r);
    if (r.recorder.state !== 'inactive') r.recorder.stop(); else finish(r, r.recorder.mimeType);
    r.short = performance.now() - r.started < MIN_MS;
  }

  async function finish(r, mime) {
    if (r.short || performance.now() - r.started < MIN_MS) { setState('idle'); toast('Hold the button while you speak.', 2500); return; }
    const blob = new Blob(r.chunks, { type: mime });
    busy = true;
    setState('busy');
    try {
      const res = await fetch('/api/stt/transcribe', { method: 'POST', headers: { 'Content-Type': mime }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { location.href = '/login'; return; }
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      // One line, no control characters: it is typed, never run by itself.
      const text = String(data.text || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
      if (!text) { toast('Did not catch anything.', 2500); return; }
      const id = state.tabs.some((t) => t.id === r.tab) ? r.tab : state.active;
      if (!id) return;
      sendInput(id, text);
      const v = state.views.get(id);
      if (v && v.term && id === state.active) v.term.focus();
    } catch (e) {
      toast(`Dictation: ${e.message || e}`, 7000);
    } finally {
      busy = false;
      setState('idle');
    }
  }

  function build() {
    btn = document.createElement('button');
    btn.id = 'mic';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Hold to dictate');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';
    btn.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      start();
    });
    for (const ev of ['pointerup', 'pointercancel']) btn.addEventListener(ev, stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // Same thing from the keyboard: hold Space or Enter while the button has focus.
    btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(); } });
    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stop(); });
    btn.addEventListener('blur', stop);
    $('#main').appendChild(btn);
    setState('idle');
  }

  fetch('/api/stt/status').then((r) => (r.ok ? r.json() : null)).then((s) => { if (s && s.available) build(); }).catch(() => {});
})();
