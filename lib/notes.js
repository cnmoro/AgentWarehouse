'use strict';
// The Notes pad's text, one per user, kept on the server (DATA_DIR/notes.json)
// so every browser and device signed in as that user sees the same text.
// Each change gets a revision number; pages send the text whole (it is small),
// and the last one to write wins. Writes to disk are batched: at most one a
// second while someone types, and whatever is pending on shutdown.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

const MAX_TEXT = 1024 * 1024; // characters
const WRITE_DELAY = 1000;

class Notes {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'notes.json');
    this.byUser = new Map(); // email -> { text, rev, at }
    this.timer = null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [email, n] of Object.entries(data && typeof data === 'object' ? data : {})) {
        if (n && typeof n.text === 'string' && Number.isInteger(n.rev)) {
          this.byUser.set(email, { text: n.text.slice(0, MAX_TEXT), rev: n.rev, at: typeof n.at === 'string' ? n.at : '' });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Ignoring unreadable ${this.file} (${err.message})`);
    }
  }

  get(email) {
    return this.byUser.get(email) || { text: '', rev: 0, at: '' };
  }

  // New text for this user. Returns the stored entry, or null if the text was refused.
  set(email, text) {
    if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
    const old = this.get(email);
    if (text === old.text) return old;
    const entry = { text, rev: old.rev + 1, at: new Date().toISOString() };
    this.byUser.set(email, entry);
    this.scheduleWrite();
    return entry;
  }

  scheduleWrite() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.byUser), null, 2));
    } catch (err) {
      console.error('Could not save notes:', err.message);
    }
  }

  // Pending text written now (shutdown).
  close() {
    if (this.timer) this.flush();
  }
}

module.exports = { Notes, MAX_TEXT };
