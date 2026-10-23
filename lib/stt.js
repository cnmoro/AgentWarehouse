'use strict';
// Dictation: the page records the microphone while a button is held, posts the
// recording here, and types the answer into the terminal. Recognition is done
// by soda-stt (Chrome's offline speech engine) in a Python helper
// (scripts/stt-worker.py) that is started on first use, keeps the model in
// memory while it is being used, and exits after IDLE_MS without work.
//
// The Python environment is .venv-stt in this folder (see README), or the
// interpreter in STT_PYTHON. Nothing leaves the machine.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const WORKER = path.join(ROOT, 'scripts', 'stt-worker.py');
const PYTHON = process.env.STT_PYTHON || path.join(ROOT, '.venv-stt', 'bin', 'python');
const LOCALE = /^[a-z]{2,3}-[A-Z]{2}$/.test(process.env.STT_LOCALE || '') ? process.env.STT_LOCALE : 'pt-BR';
const MAX_BYTES = 8 * 1024 * 1024; // about 10 minutes of opus; the page stops long before
const IDLE_MS = 5 * 60 * 1000;
const START_MS = 60 * 1000;
const JOB_MS = 90 * 1000;

class Worker {
  constructor() { this.proc = null; this.ready = null; this.jobs = new Map(); this.seq = 0; this.idle = null; this.tail = Promise.resolve(); }

  available() { return fs.existsSync(PYTHON) && fs.existsSync(WORKER); }

  start() {
    if (this.ready) return this.ready;
    const proc = spawn(PYTHON, ['-I', WORKER, LOCALE], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    let errTail = '';
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('The speech engine took too long to start.')); proc.kill(); }, START_MS);
      const fail = (msg) => { clearTimeout(timer); reject(new Error(msg)); };
      proc.on('error', (e) => fail(`Cannot start ${PYTHON}: ${e.code || e.message}`));
      proc.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.ready) { clearTimeout(timer); resolve(); } else if (m.fatal) fail(m.fatal);
          else if (m.id && this.jobs.has(m.id)) {
            const j = this.jobs.get(m.id); this.jobs.delete(m.id); clearTimeout(j.timer);
            if (m.error) j.reject(new Error(m.error)); else j.resolve(m.text || '');
          }
        }
      });
      proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
      proc.on('exit', (code) => {
        fail(`The speech engine exited (${code}). ${errTail.split('\n').filter(Boolean).pop() || ''}`.trim());
        for (const j of this.jobs.values()) { clearTimeout(j.timer); j.reject(new Error('The speech engine stopped.')); }
        this.jobs.clear();
        if (this.proc === proc) { this.proc = null; this.ready = null; }
      });
    });
    this.ready.catch(() => { if (this.proc === proc) { this.proc = null; this.ready = null; } });
    return this.ready;
  }

  stop() { clearTimeout(this.idle); if (this.proc) this.proc.kill(); }
  touch() { clearTimeout(this.idle); this.idle = setTimeout(() => this.stop(), IDLE_MS); this.idle.unref(); }

  // One recording at a time: the engine is single-session and the page is for one person.
  transcribe(file) {
    const run = async () => {
      await this.start();
      this.touch();
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.jobs.delete(id); reject(new Error('Transcription took too long.')); this.stop(); }, JOB_MS);
        this.jobs.set(id, { resolve, reject, timer });
        this.proc.stdin.write(JSON.stringify({ id, path: file }) + '\n');
      }).finally(() => this.touch());
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => {});
    return p;
  }
}

function router({ sessionFrom, sameOrigin }) {
  const r = express.Router();
  const worker = new Worker();
  process.on('exit', () => worker.stop());

  r.use((req, res, next) => {
    req.session = sessionFrom(req);
    if (!req.session) return res.status(401).json({ error: 'Signed out. Reload the page.' });
    if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
    next();
  });

  r.get('/status', (req, res) => res.json({ available: worker.available(), locale: LOCALE }));

  r.post('/transcribe', express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
    if (!worker.available()) return res.status(501).json({ error: 'Dictation is not installed on this server (see the README).' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 200) return res.status(400).json({ error: 'No audio received.' });
    let dir;
    try {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-stt-'));
      const file = path.join(dir, 'in.audio');
      await fsp.writeFile(file, req.body, { mode: 0o600 });
      const text = await worker.transcribe(file);
      res.json({ text });
    } catch (e) {
      console.error('stt:', e.message);
      res.status(500).json({ error: String(e.message || e).slice(0, 300) });
    } finally {
      if (dir) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  return r;
}

module.exports = { router };
