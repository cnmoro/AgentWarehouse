'use strict';
// File browser API: list folders, preview text and images, download files
// (folders as .zip), upload (also whole folders), make folders, rename, move
// to the Trash, and per-user pinned places. Everything runs as the server's
// user, who already has a shell here, so the only limits are the operating
// system's permissions; what matters is that requests come from a signed-in
// session on this page (see the checks in router()) and that nothing a file
// contains can run in the page (text is returned as data, downloads are
// attachments, image previews carry a sandbox CSP).
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const express = require('express');

const MAX_ENTRIES = 5000;           // per folder listing
const PREVIEW_BYTES = 1024 * 1024;  // text shown in the preview pane
const MAX_PINS = 50;

const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

const has = (cmd) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const CAN_TRASH = has('gio');
const CAN_ZIP = has('zip');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// "~", "~/x" and absolute paths; anything else is refused (there is no
// "current folder" on the server to be relative to).
function resolvePath(p) {
  let s = typeof p === 'string' ? p.trim() : '';
  if (!s || s === '~') return os.homedir();
  if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  if (!path.isAbsolute(s) || s.includes('\0')) throw new HttpError(400, 'Use an absolute path (or one starting with ~).');
  return path.resolve(s);
}

// One path segment from the browser (a file name, or part of a dropped
// folder's relative path): no separators, no "." or "..", nothing empty.
function cleanSegment(name) {
  const s = String(name ?? '');
  if (!s || s === '.' || s === '..' || /[/\0]/.test(s) || Buffer.byteLength(s) > 255) {
    throw new HttpError(400, `Not a valid name: "${s.slice(0, 80)}"`);
  }
  return s;
}

function cleanRelative(rel) {
  const parts = String(rel ?? '').split('/').filter((x) => x !== '');
  if (!parts.length || parts.length > 64) throw new HttpError(400, 'Not a valid relative path.');
  return parts.map(cleanSegment);
}

function fsError(err, what) {
  if (err instanceof HttpError) return err;
  const msg = {
    ENOENT: `${what} does not exist.`,
    EACCES: `Permission denied: ${what}.`,
    EPERM: `Not permitted: ${what}.`,
    ENOTDIR: `${what} is not a folder.`,
    EISDIR: `${what} is a folder.`,
    EEXIST: `${what} already exists.`,
    ENOTEMPTY: `${what} is not empty.`,
    ENOSPC: 'The disk is full.',
    EXDEV: 'Cannot move between disks.',
  }[err.code];
  const status = { ENOENT: 404, EACCES: 403, EPERM: 403, EEXIST: 409, ENOSPC: 507 }[err.code] || 400;
  return new HttpError(msg ? status : 500, msg || `${what}: ${err.message}`);
}

function typeOf(st) {
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

async function list(dir) {
  let st;
  try { st = await fsp.stat(dir); } catch (err) { throw fsError(err, dir); }
  if (!st.isDirectory()) throw new HttpError(400, `${dir} is not a folder.`);
  let names;
  try { names = await fsp.readdir(dir); } catch (err) { throw fsError(err, dir); }
  const truncated = names.length > MAX_ENTRIES;
  const entries = await Promise.all(names.slice(0, MAX_ENTRIES).map(async (name) => {
    const full = path.join(dir, name);
    const e = { name, type: 'other', size: 0, mtime: 0, link: false };
    try {
      const l = await fsp.lstat(full);
      e.link = l.isSymbolicLink();
      const s = e.link ? await fsp.stat(full).catch(() => null) : l;
      if (s) { e.type = typeOf(s); e.size = s.isFile() ? s.size : 0; e.mtime = s.mtimeMs; }
      else { e.type = 'broken'; e.mtime = l.mtimeMs; }
    } catch { /* vanished or unreadable: listed without details */ }
    return e;
  }));
  return { path: dir, parent: dir === '/' ? null : path.dirname(dir), home: os.homedir(), entries, truncated, writable: await writable(dir) };
}

async function writable(p) {
  try { await fsp.access(p, fs.constants.W_OK); return true; } catch { return false; }
}

// Text preview: the first PREVIEW_BYTES, unless the file looks binary (a NUL
// byte early on, or mostly invalid UTF-8).
async function read(file) {
  let st;
  try { st = await fsp.stat(file); } catch (err) { throw fsError(err, file); }
  if (!st.isFile()) throw new HttpError(400, `${file} is not a file.`);
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch (err) { throw fsError(err, file); }
  try {
    const want = Math.min(st.size, PREVIEW_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const data = buf.subarray(0, got);
    const head = data.subarray(0, 8192);
    let binary = head.includes(0);
    let text = '';
    if (!binary) {
      // A multi-byte character cut at the preview limit is not "binary".
      text = new TextDecoder('utf-8').decode(data);
      const bad = (text.slice(0, 8192).match(/\uFFFD/g) || []).length;
      if (bad > 8 && bad > head.length / 100) { binary = true; text = ''; }
    }
    return { path: file, size: st.size, mtime: st.mtimeMs, binary, text, truncated: st.size > got };
  } finally {
    await fh.close();
  }
}

function contentDisposition(kind, name) {
  // ASCII fallback plus the exact name (RFC 6266 / 5987).
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Pinned places, per user, in DATA_DIR/pins.json.
class Pins {
  constructor(dataDir) { this.file = path.join(dataDir, 'pins.json'); }
  all() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { return {}; }
  }
  get(user) {
    const list = this.all()[user];
    return Array.isArray(list) ? list : [];
  }
  set(user, list) {
    const data = this.all();
    data[user] = list;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// A name not taken in `dir`: "a.txt" -> "a (1).txt", "dir" -> "dir (1)".
async function freeName(dir, name) {
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext && ext !== name ? ext : ''}`;
    try { await fsp.lstat(path.join(dir, candidate)); } catch { return candidate; }
  }
  throw new HttpError(409, 'Too many files with that name.');
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

function router({ sessionFrom, sameOrigin, dataDir, terminals }) {
  const r = express.Router();
  const pins = new Pins(dataDir);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Signed in, always; anything that changes files must come from this page.
  // (GETs are protected by the SameSite=Strict session cookie: another site
  // can neither send it nor read the answer.)
  r.use((req, res, next) => {
    req.session = sessionFrom(req);
    if (!req.session) return res.status(401).json({ error: 'Signed out. Reload the page.' });
    if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
    next();
  });

  r.get('/list', wrap(async (req, res) => {
    res.json(await list(resolvePath(req.query.path)));
  }));

  r.get('/read', wrap(async (req, res) => {
    res.json(await read(resolvePath(req.query.path)));
  }));

  // The file itself. Images may be shown inline (in an <img>, sandboxed);
  // everything else is always an attachment, so an HTML or SVG file from
  // disk can never run as a page of this site.
  r.get('/raw', wrap(async (req, res) => {
    const file = resolvePath(req.query.path);
    let st;
    try { st = await fsp.stat(file); } catch (err) { throw fsError(err, file); }
    if (!st.isFile()) throw new HttpError(400, `${file} is not a file.`);
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    const inline = req.query.inline === '1' && type;
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', path.basename(file)));
    res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
    res.sendFile(file, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-store' } }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).json({ error: fsError(err, file).message });
    });
  }));

  // A folder, as a .zip (or .tar.gz without zip), streamed as it is made.
  r.get('/archive', wrap(async (req, res) => {
    const dir = resolvePath(req.query.path);
    let st;
    try { st = await fsp.stat(dir); } catch (err) { throw fsError(err, dir); }
    if (!st.isDirectory()) throw new HttpError(400, `${dir} is not a folder.`);
    const parent = path.dirname(dir);
    const name = dir === '/' ? '.' : path.basename(dir);
    const cwd = dir === '/' ? '/' : parent;
    const label = dir === '/' ? 'root' : name;
    // "./name": a folder called "-T" must not be read as an option.
    const arg = name === '.' ? '.' : `./${name}`;
    const [cmd, args, ext] = CAN_ZIP
      ? ['zip', ['-q', '-r', '-y', '-', arg], '.zip']
      : ['tar', ['-czf', '-', arg], '.tar.gz'];
    res.setHeader('Content-Type', CAN_ZIP ? 'application/zip' : 'application/gzip');
    res.setHeader('Content-Disposition', contentDisposition('attachment', label + ext));
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(res);
    req.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
    child.on('error', () => res.destroy());
  }));

  // Which of these (relative) paths already exist under `dir`, so the page
  // can ask once before an upload replaces anything.
  r.post('/check', express.json({ limit: '1mb' }), wrap(async (req, res) => {
    const dir = resolvePath(req.body && req.body.dir);
    const rels = Array.isArray(req.body.rels) ? req.body.rels.slice(0, 20000) : [];
    const existing = [];
    for (const rel of rels) {
      try {
        if (await exists(path.join(dir, ...cleanRelative(rel)))) existing.push(rel);
      } catch { /* invalid names are reported by the upload itself */ }
    }
    res.json({ existing });
  }));

  // One file per request, streamed to a temporary name and renamed into
  // place when complete, so a broken upload never leaves half a file under
  // the real name. `rel` may contain folders (from a dropped folder); they
  // are created. mode: fail (default) | replace | rename (keep both).
  r.post('/upload', wrap(async (req, res) => {
    const dir = resolvePath(req.query.dir);
    const parts = cleanRelative(req.query.rel);
    const mode = ['replace', 'rename'].includes(req.query.mode) ? req.query.mode : 'fail';
    const parentDir = path.join(dir, ...parts.slice(0, -1));
    let name = parts[parts.length - 1];
    try { await fsp.mkdir(parentDir, { recursive: true }); } catch (err) { throw fsError(err, parentDir); }
    if (await exists(path.join(parentDir, name))) {
      if (mode === 'fail') throw new HttpError(409, `${name} already exists.`);
      if (mode === 'rename') name = await freeName(parentDir, name);
      else {
        const st = await fsp.stat(path.join(parentDir, name)).catch(() => null);
        if (st && st.isDirectory()) throw new HttpError(409, `${name} is a folder; it cannot be replaced by a file.`);
      }
    }
    const target = path.join(parentDir, name);
    const tmp = path.join(parentDir, `.${name}.${crypto.randomBytes(4).toString('hex')}.upload`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(tmp, { force: true }, () => reject(err));
      };
      req.on('close', () => { if (!req.complete) fail(new HttpError(400, 'Upload interrupted.')); });
      req.on('error', fail);
      out.on('error', (err) => fail(fsError(err, target)));
      out.on('finish', () => { if (!failed) resolve(); });
      req.pipe(out);
    });
    try {
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw fsError(err, target);
    }
    res.json({ ok: true, path: target, name });
  }));

  // { dir, name }: a new folder (an error if it exists). { dir, rel }: a
  // relative path, created with its parents, fine if it exists (the empty
  // folders inside a dropped folder).
  r.post('/mkdir', express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const dir = resolvePath(req.body && req.body.dir);
    const parents = typeof req.body.rel === 'string';
    const target = parents ? path.join(dir, ...cleanRelative(req.body.rel)) : path.join(dir, cleanSegment(req.body.name));
    try { await fsp.mkdir(target, { recursive: parents }); } catch (err) { throw fsError(err, target); }
    res.json({ ok: true, path: target });
  }));

  r.post('/rename', express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const from = resolvePath(req.body && req.body.path);
    const to = path.join(path.dirname(from), cleanSegment(req.body.name));
    if (from === to) return res.json({ ok: true, path: to });
    if (await exists(to)) throw new HttpError(409, `${path.basename(to)} already exists.`);
    try { await fsp.rename(from, to); } catch (err) { throw fsError(err, from); }
    res.json({ ok: true, path: to });
  }));

  // To the Trash when the desktop's trash is available (recoverable);
  // otherwise only when the page says it may delete for good.
  r.post('/delete', express.json({ limit: '1mb' }), wrap(async (req, res) => {
    const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths.slice(0, 1000).map(resolvePath) : [];
    if (paths.some((p) => p === '/' || p === os.homedir())) throw new HttpError(400, 'Refusing to delete / or the home folder.');
    const permanent = req.body.permanent === true;
    if (!CAN_TRASH && !permanent) throw new HttpError(400, 'No Trash on this machine; deleting would be permanent.');
    const failed = [];
    for (const p of paths) {
      try {
        // Asynchronously: a big folder must not stall the terminals' I/O.
        if (CAN_TRASH && !permanent) await execFileAsync('gio', ['trash', '--', p], { timeout: 120000 });
        else await fsp.rm(p, { recursive: true, force: false });
      } catch (err) {
        failed.push({ path: p, error: String((err.stderr && err.stderr.toString()) || err.message).trim().slice(0, 200) });
      }
    }
    res.json({ ok: failed.length === 0, failed, trash: CAN_TRASH && !permanent });
  }));

  r.get('/pins', (req, res) => res.json({ pins: pins.get(req.session.email) }));

  r.put('/pins', express.json({ limit: '64kb' }), wrap(async (req, res) => {
    const list = Array.isArray(req.body && req.body.pins) ? req.body.pins : null;
    if (!list) throw new HttpError(400, 'pins must be a list.');
    const clean = [];
    for (const p of list.slice(0, MAX_PINS)) {
      if (!p || typeof p.path !== 'string') continue;
      const abs = resolvePath(p.path);
      if (clean.some((x) => x.path === abs)) continue;
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : (path.basename(abs) || '/');
      clean.push({ path: abs, name });
    }
    pins.set(req.session.email, clean);
    res.json({ pins: clean });
  }));

  // Where a terminal is right now (its shell's folder).
  r.get('/cwd', (req, res) => {
    const tab = typeof req.query.tab === 'string' ? terminals.get(req.query.tab) : null;
    res.json({ path: tab ? tab.currentCwd() : os.homedir() });
  });

  r.get('/info', (req, res) => res.json({ home: os.homedir(), trash: CAN_TRASH, zip: CAN_ZIP }));

  // JSON errors for this API (the app's own handler sends plain statuses).
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    const e = err instanceof HttpError ? err : fsError(err, 'request');
    if (e.status >= 500) console.error('files:', err);
    if (res.headersSent) { res.destroy(); return; }
    res.status(e.status || 500).json({ error: e.message });
  });
  return r;
}

module.exports = { router, resolvePath, cleanRelative };
