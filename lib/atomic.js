'use strict';
// Replace a data file so that a crash or power cut leaves either the old
// content or the new one, never an empty file: write a temporary file, flush
// it to disk, rename it over the old one, then flush the folder so the rename
// itself is on disk. (Without the flushes, ext4 can lose the new content after
// a power cut and leave a zero-length file behind.)
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch { /* some file systems cannot flush a folder; the file itself is flushed */ }
}

module.exports = { writeFileAtomic };
