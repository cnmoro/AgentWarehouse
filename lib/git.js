'use strict';
// Read-only git for the Files panel: which files of a repository changed
// (like VS Code's Source Control list) and what changed in one of them.
//
// git runs without a shell, with fixed arguments, and with the settings that
// would let a repository's own configuration run programs switched off
// (core.fsmonitor, external diff tools, text conversion filters). `git status`
// can still run a repository's own clean filters, which is the same exposure as
// typing `git status` in that folder in a terminal; git also refuses repositories
// owned by another user.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const textinfo = require('./textinfo');

const MAX_FILE_BYTES = 1.5 * 1024 * 1024; // a side of a diff larger than this is not sent
const EDIT_BYTES = 1024 * 1024; // the largest file the editor opens (see lib/files.js)
const MAX_CHANGES = 3000;
const TIMEOUT_MS = 20000;

const SAFE = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.quotepath=off',
  '-c', 'core.pager=cat',
  '-c', 'color.ui=false',
];
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C', GIT_EXTERNAL_DIFF: '', GIT_ASKPASS: 'true' };

class GitError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function git(cwd, args, { maxBuffer = 16 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE, ...args], { cwd, env: ENV, timeout: TIMEOUT_MS, maxBuffer, encoding, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(stdout);
    });
  });
}

let available = null;
async function isAvailable() {
  if (available === null) available = await git(process.cwd(), ['--version']).then(() => true, () => false);
  return available;
}

// The top folder of the repository that contains `dir`, or null.
async function repoRoot(dir) {
  try {
    const out = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return out ? path.resolve(out) : null;
  } catch {
    return null; // not a repository, not a folder, or git refused (another owner's folder)
  }
}

// What an entry of `git status` means, for the page.
const KIND = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflict' };

async function status(dir) {
  const root = await repoRoot(dir);
  if (!root) return { repo: null };
  const out = await git(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  const tok = out.split('\0');
  const info = { repo: root, name: path.basename(root), branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0 };
  const changes = [];
  let truncated = false;
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [, key, ...rest] = t.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.head') { info.branch = val === '(detached)' ? null : val; info.detached = val === '(detached)'; }
      else if (key === 'branch.oid') info.oid = val === '(initial)' ? null : val.slice(0, 7);
      else if (key === 'branch.upstream') info.upstream = val;
      else if (key === 'branch.ab') { const m = /^\+(\d+) -(\d+)$/.exec(val); if (m) { info.ahead = Number(m[1]); info.behind = Number(m[2]); } }
      continue;
    }
    let entry = null;
    if (t[0] === '1') { // 1 XY sub mH mI mW hH hI path
      const p = t.split(' ');
      entry = { x: p[1][0], y: p[1][1], path: p.slice(8).join(' ') };
    } else if (t[0] === '2') { // 2 XY sub mH mI mW hH hI Xscore path, then the old path
      const p = t.split(' ');
      entry = { x: p[1][0], y: p[1][1], path: p.slice(9).join(' '), orig: tok[++i] };
    } else if (t[0] === 'u') { // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const p = t.split(' ');
      entry = { x: 'U', y: 'U', path: p.slice(10).join(' '), conflict: true };
    } else if (t[0] === '?') {
      entry = { x: '.', y: '?', path: t.slice(2) };
    } else continue; // '!' ignored files
    if (changes.length >= MAX_CHANGES) { truncated = true; break; }
    changes.push(entry);
  }
  info.stashes = await git(root, ['rev-list', '--walk-reflogs', '--count', 'refs/stash']).then((o) => Number(o.trim()) || 0, () => 0);
  // A cheap fingerprint of each working-tree file, so the page can tell that a file it shows changed again.
  await Promise.all(changes.map(async (c) => {
    try {
      const st = await fsp.lstat(path.join(root, c.path));
      c.sig = `${Math.round(st.mtimeMs)}-${st.size}`;
    } catch { c.sig = 'gone'; }
  }));
  return { ...info, changes, truncated };
}

// Keeps a path given by the page inside the repository and free of options.
function cleanRel(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) throw new GitError('Bad file path.');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new GitError('That file is outside the repository.');
  return path.relative(root, abs).split(path.sep).join('/');
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

// A file's content at a revision (":path" is the index, ":2:path" our side of a conflict, "HEAD:path"),
// as { text } | { binary } | { tooLarge } | null when it does not exist there.
async function blob(root, spec) {
  let buf;
  try {
    buf = await git(root, ['cat-file', 'blob', spec], { maxBuffer: MAX_FILE_BYTES + 1, encoding: 'buffer' });
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(err.message))) return { tooLarge: true };
    return null;
  }
  if (buf.length > MAX_FILE_BYTES) return { tooLarge: true };
  if (looksBinary(buf)) return { binary: true, size: buf.length };
  return { text: buf.toString('utf8') };
}

async function worktree(root, rel) {
  const file = path.join(root, rel);
  let st;
  try { st = await fsp.lstat(file); } catch { return null; }
  if (st.isSymbolicLink()) return { text: await fsp.readlink(file) };
  if (!st.isFile()) return null;
  if (st.size > MAX_FILE_BYTES) return { tooLarge: true };
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) return { binary: true, size: buf.length };
  // What the editor needs to open this file (the same rules as the Files preview).
  let edit;
  if (buf.length > EDIT_BYTES) edit = { editable: false, why: `The file is larger than ${EDIT_BYTES / 1024 / 1024} MB, the most the editor opens.` };
  else {
    const info = textinfo.inspect(buf);
    edit = info.ok ? { editable: true, bom: info.bom, eol: info.eol } : { editable: false, why: info.why };
  }
  return { text: buf.toString('utf8'), edit: { ...edit, mtime: st.mtimeMs, size: st.size } };
}

// The changed line ranges between the two sides, from `git diff -U0`: [{ os, oc, ns, nc }].
async function hunks(root, args) {
  let out = '';
  try {
    out = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', ...args]);
  } catch (err) {
    if (typeof err.stdout === 'string') out = err.stdout;
  }
  const list = [];
  for (const line of out.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) list.push({ os: Number(m[1]), oc: m[2] === undefined ? 1 : Number(m[2]), ns: Number(m[3]), nc: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return list;
}

// side: 'staged' (HEAD against the index), 'worktree' (the index against the file), 'conflict' (our side against the file).
async function diff(root, rawRel, side, rawOrig) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || (await repoRoot(root)) !== path.resolve(root)) throw new GitError('That is not the top folder of a repository.');
  root = path.resolve(root);
  const rel = cleanRel(root, rawRel);
  const orig = rawOrig ? cleanRel(root, rawOrig) : null;
  let before;
  let after;
  let h = [];
  if (side === 'staged') {
    before = await blob(root, `HEAD:${orig || rel}`);
    after = await blob(root, `:${rel}`);
    if (before && after && !before.binary && !after.binary && !before.tooLarge && !after.tooLarge) {
      h = await hunks(root, ['--cached', '-M', '--', ...(orig ? [orig] : []), rel]);
    }
  } else if (side === 'conflict') {
    before = await blob(root, `:2:${rel}`);
    after = await worktree(root, rel);
    if (before && after && before.text !== undefined && after.text !== undefined) h = await hunks(root, ['--ours', '--', rel]);
  } else if (side === 'worktree') {
    before = await blob(root, `:${rel}`);
    after = await worktree(root, rel);
    if (before && after && before.text !== undefined && after.text !== undefined) h = await hunks(root, ['--', rel]);
  } else throw new GitError('Unknown side.');
  const pick = (s) => (s && s.text !== undefined ? s.text : null);
  const flag = (s) => (s && s.binary ? 'binary' : s && s.tooLarge ? 'large' : null);
  return {
    path: rel, orig, side,
    old: pick(before), new: pick(after),
    oldKind: flag(before), newKind: flag(after),
    oldMissing: !before, newMissing: !after,
    hunks: h,
    // The working-tree side can be edited in place (unless it is a symlink, a deleted file, a binary or a large one).
    edit: side !== 'staged' && after && after.edit ? { ...after.edit, abs: path.join(root, rel) } : null,
  };
}


// ---------------------------------------------------------------- actions (stage, commit, push, ...)

// One action at a time per repository: two git commands changing the index at once make each other fail.
const queues = new Map();
function serial(root, fn) {
  const prev = queues.get(root) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(root, next);
  next.finally(() => { if (queues.get(root) === next) queues.delete(root); }).catch(() => {});
  return next;
}

const NET_TIMEOUT_MS = 120000;
// Network commands must never wait for a password or a question: they fail with git's own message instead.
const NET_ENV = { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };

// Runs git and returns its output (stdout and stderr together, as a terminal would show them). A failure becomes a
// GitError with that output as its message.
function run(root, args, { net = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...SAFE, ...args], {
      cwd: root, env: { ...ENV, GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', ...(net ? NET_ENV : {}) },
      timeout: net ? NET_TIMEOUT_MS : TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.trim().slice(-4000);
      if (err) {
        const why = err.killed ? 'git took too long and was stopped.' : out || err.message;
        return reject(new GitError(why, 422));
      }
      resolve(out);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const cleanList = (root, list, max = 2000) => {
  if (!Array.isArray(list) || !list.length || list.length > max) throw new GitError('Choose the files first.');
  return [...new Set(list.map((p) => cleanRel(root, p)))];
};

async function hasHead(root) {
  return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
}

async function upstreamOf(root) {
  return git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then((o) => o.trim() || null, () => null);
}

async function push(root, force) {
  const flags = force ? ['--force-with-lease'] : [];
  if (await upstreamOf(root)) return run(root, ['push', ...flags], { net: true });
  const remotes = (await git(root, ['remote']).catch(() => '')).split('\n').filter(Boolean);
  if (!remotes.length) throw new GitError('This repository has no remote to push to. Add one first: git remote add origin <url>');
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  return run(root, ['push', '-u', ...flags, remote, 'HEAD'], { net: true });
}

const BRANCH_RE = /^[^\s~^:?*\[\\]+$/;
async function checkBranchName(root, name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name.startsWith('-') || !BRANCH_RE.test(name)) throw new GitError('That is not a valid branch name.');
  await git(root, ['check-ref-format', '--branch', name]).catch(() => { throw new GitError('That is not a valid branch name.'); });
  return name;
}

async function branches(rawRoot) {
  const root = await topOf(rawRoot);
  const out = await git(root, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)', 'refs/heads', 'refs/remotes']);
  const list = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [full, short, head, upstream] = line.split('\t');
    if (full.endsWith('/HEAD')) continue;
    list.push({ name: short, remote: full.startsWith('refs/remotes/'), current: head === '*', upstream: upstream || null });
  }
  const locals = new Set(list.filter((b) => !b.remote).map((b) => b.name));
  // A remote branch that already has a local one is not offered twice.
  return { branches: list.filter((b) => !(b.remote && locals.has(b.name.slice(b.name.indexOf('/') + 1)))) };
}

async function topOf(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || (await repoRoot(root)) !== path.resolve(root)) throw new GitError('That is not the top folder of a repository.');
  return path.resolve(root);
}

// body: { action, ...arguments }. Returns { output } (what git printed).
async function action(rawRoot, body) {
  const root = await topOf(rawRoot);
  const b = body || {};
  return serial(root, async () => {
    switch (b.action) {
      case 'stage': {
        if (b.all) return { output: await run(root, ['add', '-A']) };
        return { output: await run(root, ['add', '-A', '--', ...cleanList(root, b.paths)]) };
      }
      case 'unstage': {
        const paths = b.all ? ['.'] : cleanList(root, b.paths);
        if (await hasHead(root)) return { output: await run(root, ['restore', '--staged', '--', ...paths]) };
        return { output: await run(root, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...paths]) };
      }
      case 'discard': {
        let out = '';
        if (b.paths && b.paths.length) out += await run(root, ['restore', '--worktree', '--', ...cleanList(root, b.paths)]);
        if (b.untracked && b.untracked.length) out += await run(root, ['clean', '-f', '--', ...cleanList(root, b.untracked)]);
        if (!(b.paths && b.paths.length) && !(b.untracked && b.untracked.length)) throw new GitError('Choose the files first.');
        return { output: out };
      }
      case 'commit': {
        const message = typeof b.message === 'string' ? b.message.trim() : '';
        if (!message && !b.amend) throw new GitError('Type a commit message first.');
        if (b.stageAll) await run(root, ['add', '-A']);
        const args = ['commit', ...(b.amend ? ['--amend'] : []), ...(b.noVerify ? ['--no-verify'] : []), ...(message ? ['-m', message] : ['--no-edit'])];
        return { output: await run(root, args) };
      }
      case 'push': return { output: await push(root, !!b.force) };
      case 'pull': return { output: await run(root, ['pull', '--no-edit', ...(b.rebase ? ['--rebase'] : [])], { net: true }) };
      case 'fetch': return { output: await run(root, ['fetch', '--all', '--prune'], { net: true }) };
      case 'sync': {
        const pulled = await run(root, ['pull', '--no-edit'], { net: true });
        const pushed = await push(root, false);
        return { output: `${pulled}\n${pushed}`.trim() };
      }
      case 'checkout': {
        const name = await checkBranchName(root, b.branch);
        return { output: await run(root, ['switch', name]) };
      }
      case 'createBranch': {
        const name = await checkBranchName(root, b.name);
        const start = b.start ? await checkBranchName(root, b.start) : null;
        return { output: await run(root, ['switch', '-c', name, ...(start ? [start] : [])]) };
      }
      case 'stash': {
        const msg = typeof b.message === 'string' ? b.message.trim() : '';
        return { output: await run(root, ['stash', 'push', ...(b.untracked ? ['--include-untracked'] : []), ...(msg ? ['-m', msg] : [])]) };
      }
      case 'stashPop': return { output: await run(root, ['stash', 'pop']) };
      case 'undoCommit': return { output: await run(root, ['reset', '--soft', 'HEAD~1']) };
      default: throw new GitError('Unknown git action.');
    }
  });
}

module.exports = { action, branches, isAvailable, status, diff, repoRoot, GitError, blob, cleanRel };
