'use strict';
// Saved layouts: a name and an arrangement of panes (terminals, the file
// explorer, the desktop), kept on the server (DATA_DIR/layouts.json) so every
// browser signed in here sees the same list. The page sends the arrangement as
// a tree, checked here before it is kept:
//   leaf: { k: 'tab', t: <tab id>, g: <session id> } | { k: 'files', p: <folder> } | { k: 'vnc' }
//   node: { d: 'h' | 'v', f: <0..1, where the split is>, a: <tree>, b: <tree> }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LAYOUTS = 100;
const MAX_LEAVES = 4;
const MAX_NAME = 80;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

const shortStr = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

// A copy of the tree with only the fields above, or null if it is not one.
function cleanTree(n, depth = 0) {
  if (!n || typeof n !== 'object' || depth > MAX_LEAVES) return null;
  if (n.k === 'tab') {
    const t = shortStr(n.t, 64), g = shortStr(n.g, 64);
    return t || g ? { k: 'tab', t, g } : null;
  }
  if (n.k === 'files') return { k: 'files', p: shortStr(n.p, 4096) };
  if (n.k === 'vnc') return { k: 'vnc' };
  if (n.d !== 'h' && n.d !== 'v') return null;
  const a = cleanTree(n.a, depth + 1), b = cleanTree(n.b, depth + 1);
  if (!a || !b) return null;
  const f = typeof n.f === 'number' && Number.isFinite(n.f) ? Math.min(0.9, Math.max(0.1, n.f)) : 0.5;
  return { d: n.d, f: Math.round(f * 1000) / 1000, a, b };
}
const leafCount = (n) => (n.k ? 1 : leafCount(n.a) + leafCount(n.b));

class Layouts {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'layouts.json');
    this.items = [];
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const x of Array.isArray(data) ? data : []) {
        const tree = cleanTree(x && x.tree);
        const name = shortStr(x && x.name, MAX_NAME).trim();
        if (tree && name && ID.test(String(x.id)) && leafCount(tree) <= MAX_LEAVES) this.items.push({ id: x.id, name, tree });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Ignoring unreadable ${this.file} (${err.message})`);
    }
  }

  list() { return this.items; }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.items, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  // A new layout, or a new arrangement or name for an existing one. Returns whether the list changed.
  save({ id, name, tree }) {
    const t = cleanTree(tree);
    const n = shortStr(name, 1000).trim().slice(0, MAX_NAME);
    if (!t || leafCount(t) > MAX_LEAVES) return false;
    const old = ID.test(String(id)) && this.items.find((x) => x.id === id);
    if (old) {
      old.tree = t;
      if (n) old.name = n;
    } else {
      if (!n || this.items.length >= MAX_LAYOUTS) return false;
      this.items.push({ id: ID.test(String(id)) ? id : crypto.randomBytes(8).toString('hex'), name: n, tree: t });
    }
    this.write();
    return true;
  }

  rename(id, name) {
    const x = this.items.find((l) => l.id === id);
    const n = shortStr(name, 1000).trim().slice(0, MAX_NAME);
    if (!x || !n || n === x.name) return false;
    x.name = n;
    this.write();
    return true;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((l) => l.id !== id);
    if (this.items.length === before) return false;
    this.write();
    return true;
  }
}

module.exports = { Layouts, MAX_LAYOUTS };
