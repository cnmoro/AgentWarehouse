'use strict';
// "Fluid" desktop: instead of VNC's region updates, the screen of this
// machine's VNC display is captured by ffmpeg (x11grab), encoded as video
// (H.264, VP9 or AV1) and sent over a WebSocket as fragmented MP4, which the
// page plays with Media Source Extensions (hardware decoding, up to 60 fps).
// Keyboard and mouse still go through the VNC connection (see public/static/vnc.js).
// Only the display of this machine's own VNC server can be streamed.
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const vnc = require('./vnc');

const MAX_STREAMS = 3;
const CODECS = ['h264', 'vp9', 'av1'];

// The X display of the Xvnc that the Desktop panel shows (VNC_DISPLAY, else the ":N" of the Xvnc on the VNC port).
function findDisplay() {
  if (/^:\d+$/.test(process.env.VNC_DISPLAY || '')) return process.env.VNC_DISPLAY;
  try {
    const uid = process.getuid();
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (fs.statSync(`/proc/${pid}`).uid !== uid) continue;
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (!/(^|\/)(Xvnc|Xtigervnc)$/.test(args[0])) continue;
        const d = args.find((a) => /^:\d+$/.test(a));
        const i = args.indexOf('-rfbport');
        const port = i >= 0 ? Number(args[i + 1]) : d ? 5900 + Number(d.slice(1)) : 0;
        if (d && port === vnc.port) return d; // the Xvnc the Desktop panel connects to
      } catch { /* a process that went away */ }
    }
  } catch { /* no /proc */ }
  return null;
}

const run = (args, timeout = 15000) => new Promise((resolve) => {
  execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { timeout }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});

// What this machine can encode, found once at start: { ok, codecs: ['h264', ...], nvenc }.
const caps = { ok: false, codecs: [], nvenc: false };
let probed = null;
function probe() {
  if (probed) return probed;
  probed = (async () => {
    const list = await new Promise((resolve) => {
      execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 10000 }, (err, out) => resolve(err ? '' : out));
    });
    if (!/x11grab/.test(await new Promise((r) => execFile('ffmpeg', ['-hide_banner', '-devices'], { timeout: 10000 }, (e, o) => r(o || ''))))) return;
    const has = (n) => new RegExp(`\\s${n}\\s`).test(list);
    const tiny = ['-f', 'lavfi', '-i', 'color=size=256x256:rate=5', '-frames:v', '3'];
    // NVENC's H.264 omits the stream header field that says no frames are reordered, so a browser decoding on the GPU
    // may hold back many frames before showing them (seen as seconds of lag). libx264 writes it. NVENC stays available as STREAM_NVENC=1.
    if (process.env.STREAM_NVENC === '1' && has('h264_nvenc') && !(await run([...tiny, '-c:v', 'h264_nvenc', '-f', 'null', '-'])).err) caps.nvenc = true;
    if (has('libx264') || caps.nvenc) caps.codecs.push('h264');
    if (has('libvpx-vp9')) caps.codecs.push('vp9');
    if (has('libsvtav1')) caps.codecs.push('av1');
    caps.ok = caps.codecs.length > 0;
  })().catch(() => {});
  return probed;
}

// ffmpeg's arguments for one stream.
function encoderArgs(codec, { fps, mbps, nvenc }) {
  const rate = `${mbps}M`;
  const gop = String(fps * 2);
  if (codec === 'h264' && nvenc) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-zerolatency', '1', '-delay', '0', '-rc', 'cbr', '-b:v', rate, '-bf', '0', '-g', gop, '-profile:v', 'high'];
  }
  if (codec === 'h264') {
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', rate, '-maxrate', rate, '-bufsize', `${Math.max(100, Math.round((mbps * 1000 * 2) / fps))}k`, '-g', gop, '-pix_fmt', 'yuv420p'];
  }
  if (codec === 'vp9') {
    return ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-tile-columns', '2', '-lag-in-frames', '0', '-b:v', rate, '-g', gop, '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libsvtav1', '-preset', '12', '-b:v', rate, '-g', gop, '-pix_fmt', 'yuv420p', '-svtav1-params', 'pred-struct=1:lookahead=0'];
}

function ffmpegArgs(display, codec, opts) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-f', 'x11grab', '-framerate', String(opts.fps), '-draw_mouse', '0', '-i', display,
    // The pointer is not in the picture: the page shows the real one at once, so the mouse does not wait for the video.
    // Video encoders want even sizes.
    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
    ...encoderArgs(codec, opts),
    ...(opts.raw
      // For WebCodecs: H.264 as Annex B with an access unit delimiter before each frame, VP9 and AV1 in IVF (sized frames).
      ? [...(codec === 'h264' ? ['-bsf:v', 'h264_metadata=aud=insert', '-f', 'h264'] : ['-f', 'ivf']), '-flush_packets', '1']
      // One fragment per frame, so the page can show each frame as soon as it arrives.
      : ['-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '1000', '-flush_packets', '1']),
    'pipe:1',
  ];
}

function parseQuery(url) {
  const q = new URL(url, 'http://x').searchParams;
  const codec = String(q.get('codec') || 'h264');
  const fps = Number(q.get('fps') || 60);
  const mbps = Number(q.get('mbps') || 12);
  if (!CODECS.includes(codec) || !Number.isInteger(fps) || fps < 5 || fps > 60 || !Number.isInteger(mbps) || mbps < 1 || mbps > 80) return null;
  return { codec, fps, mbps, raw: q.get('fmt') === 'raw' };
}

// Sends the screen to `ws` until either side goes away.
function stream(ws, label, { codec, fps, mbps, raw }) {
  const display = findDisplay();
  const fail = (message) => { try { ws.send(JSON.stringify({ t: 'error', message })); } catch { /* gone */ } try { ws.close(); } catch { /* gone */ } };
  if (!display || !caps.codecs.includes(codec)) return fail(!display ? 'No VNC display was found on this machine.' : `This machine cannot encode ${codec}.`);

  let child = null;
  let closed = false;
  let useNvenc = caps.nvenc;
  let gotData = false;
  const started = () => {
    gotData = false;
    const args = ffmpegArgs(display, codec, { fps, mbps, nvenc: useNvenc, raw });
    child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    child.stdout.on('data', (d) => {
      gotData = true;
      if (ws.readyState !== ws.OPEN) return;
      // Raw streams carry one byte in front: 1 when this chunk ends a whole frame. ffmpeg writes in blocks of 32 KiB
      // and flushes the rest after each frame, so a chunk whose size is not a multiple of 32768 is the end of a frame.
      const out = raw ? Buffer.concat([Buffer.from([d.length % 32768 ? 1 : 0]), d]) : d;
      ws.send(out, { binary: true }, () => { if (!closed && ws.bufferedAmount < 64 * 1024) child.stdout.resume(); });
      // The browser cannot keep up: hold ffmpeg back rather than pile up old frames.
      if (ws.bufferedAmount > 192 * 1024) child.stdout.pause();
    });
    child.on('error', (e) => fail(`ffmpeg could not start (${e.message})`));
    child.on('close', (code) => {
      child = null;
      if (closed) return;
      if (!gotData && useNvenc && codec === 'h264') { useNvenc = false; return started(); } // GPU encoder refused: use the CPU one
      // It ran and then stopped (the desktop changed size, most likely): tell the page, which captures again.
      if (gotData) { try { ws.send(JSON.stringify({ t: 'ended' })); } catch { /* gone */ } try { ws.close(); } catch { /* gone */ } return; }
      fail(`The screen capture stopped${code ? ` (${err.trim().split('\n').pop() || `exit ${code}`})` : ''}.`);
    });
  };
  console.log(`[vstream] ${label}: ${codec} ${fps} fps ${mbps} Mbps${raw ? ' raw' : ''} on ${display}${useNvenc && codec === 'h264' ? ' (NVENC)' : ''}`);
  started();

  const stop = () => {
    if (closed) return;
    closed = true;
    if (child) {
      const c = child;
      c.kill('SIGTERM');
      setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
    }
  };
  ws.on('close', stop);
  ws.on('error', stop);
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const pinger = setInterval(() => { if (!alive) { stop(); try { ws.terminate(); } catch { /* gone */ } return; } alive = false; try { ws.ping(); } catch { /* closing */ } }, 20000);
  pinger.unref();
  ws.on('close', () => clearInterval(pinger));
}

// For the page: what can be streamed here.
function info() {
  return { ok: caps.ok && !!findDisplay(), codecs: caps.codecs, nvenc: caps.nvenc };
}

module.exports = { stream, parseQuery, probe, info, MAX_STREAMS };
