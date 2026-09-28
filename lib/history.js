'use strict';
// Long-term terminal history, kept on disk.
//
// Every line that scrolls above the terminal's screen is appended here (see
// Tab in lib/terminals.js), and read back in pages when the history viewer
// asks for it. Only byte offsets are kept in memory.
//
// Layout: data/history/<tab id>/<n>.log with one record per text line, and
// <n>.idx with each record's byte offset (uint32 LE). A record is a flag
// character ('w' when the line continues the previous one, ' ' otherwise)
// followed by the line's text with SGR colour sequences. Segments roll over
// at SEGMENT_LINES records or SEGMENT_BYTES; whole segments are dropped from
// the old end to stay within the line and byte limits.
const fs = require('fs');
const path = require('path');

const SEGMENT_LINES = 20000;
const SEGMENT_BYTES_MAX = 8 * 1024 * 1024;
const FLUSH_MS = 200;
const MAX_PENDING = 5000;

class History {
  constructor(dir, { maxLines, maxBytes }) {
    this.dir = dir;
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    // Small byte limits need small segments, since whole segments are dropped.
    this.segmentBytes = Math.max(64 * 1024, Math.min(SEGMENT_BYTES_MAX, Math.floor(maxBytes / 4)));
    this.segments = []; // { no, log, idx, first (absolute index), offsets: number[], bytes }
    this.pending = [];
    this.flushTimer = null;
    this.failed = false;
    this.nextFirst = 0; // absolute index of the next record when there are no segments
    this.load();
    this.enforceLimits();
  }

  // Absolute index one past the newest record (including unflushed ones).
  get end() {
    const last = this.segments[this.segments.length - 1];
    return (last ? last.first + last.offsets.length : this.nextFirst) + this.pending.length;
  }

  // Absolute index of the oldest record still kept.
  get start() {
    return this.segments.length ? this.segments[0].first : this.end - this.pending.length;
  }

  get bytes() {
    return this.segments.reduce((n, s) => n + s.bytes, 0);
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const nos = fs.readdirSync(this.dir)
      .map((f) => /^(\d+)\.log$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    let first = 0;
    for (const no of nos) {
      const seg = this.openSegment(no, first);
      this.segments.push(seg);
      first += seg.offsets.length;
    }
    this.nextFirst = first;
  }

  // Reads a segment's offsets from its index, checked against the log; falls
  // back to scanning the log when the index is missing or doesn't match.
  openSegment(no, first) {
    const log = path.join(this.dir, `${no}.log`);
    const idx = path.join(this.dir, `${no}.idx`);
    const size = fs.statSync(log).size;
    let offsets = null;
    try {
      const buf = fs.readFileSync(idx);
      const n = Math.floor(buf.length / 4);
      offsets = [];
      for (let i = 0; i < n; i++) offsets.push(buf.readUInt32LE(i * 4));
      // Keep only entries that point inside the log, in increasing order.
      let ok = 0;
      while (ok < offsets.length && offsets[ok] < size && (ok === 0 || offsets[ok] > offsets[ok - 1])) ok++;
      offsets.length = ok;
    } catch {
      offsets = null;
    }
    let bytes;
    if (offsets && offsets.length) {
      // The last indexed record must end with a newline; anything after it
      // (a crash between the two writes) is scanned.
      const tailStart = offsets[offsets.length - 1];
      const tail = readRange(log, tailStart, size - tailStart);
      const nl = tail.indexOf(10);
      if (nl === -1) {
        offsets.pop();
        bytes = tailStart;
      } else {
        bytes = tailStart + nl + 1;
        for (let i = tail.indexOf(10, nl + 1), s = nl + 1; i !== -1; s = i + 1, i = tail.indexOf(10, i + 1)) {
          offsets.push(tailStart + s);
          bytes = tailStart + i + 1;
        }
      }
    } else {
      offsets = [];
      bytes = 0;
      const buf = fs.readFileSync(log);
      for (let i = buf.indexOf(10), s = 0; i !== -1; s = i + 1, i = buf.indexOf(10, i + 1)) {
        offsets.push(s);
        bytes = i + 1;
      }
    }
    // Drop a torn last record and make the index match exactly.
    if (bytes < size) fs.truncateSync(log, bytes);
    writeIndex(idx, offsets);
    return { no, log, idx, first, offsets, bytes };
  }

  append(record) {
    if (this.failed) return;
    this.pending.push(record);
    if (this.pending.length >= MAX_PENDING) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    let seg = null;
    try {
      while (this.pending.length && !this.failed) {
        seg = this.segments[this.segments.length - 1];
        if (!seg || seg.offsets.length >= SEGMENT_LINES || seg.bytes >= this.segmentBytes) seg = this.newSegment();
        const batch = [];
        const offsets = [];
        let bytes = seg.bytes;
        while (this.pending.length && seg.offsets.length + batch.length < SEGMENT_LINES && bytes < this.segmentBytes) {
          const r = this.pending.shift();
          offsets.push(bytes);
          bytes += Buffer.byteLength(r) + 1;
          batch.push(r);
        }
        const idxBuf = Buffer.alloc(offsets.length * 4);
        offsets.forEach((o, i) => idxBuf.writeUInt32LE(o, i * 4));
        fs.appendFileSync(seg.log, batch.join('\n') + '\n', { mode: 0o600 });
        fs.appendFileSync(seg.idx, idxBuf, { mode: 0o600 });
        seg.offsets.push(...offsets);
        seg.bytes = bytes;
        this.enforceLimits();
      }
    } catch (err) {
      // Disk full, read-only, removed: roll the segment back to its last good
      // state and stop archiving this tab (the terminal itself is unaffected).
      console.error(`history disabled for ${this.dir}: ${err.message}`);
      if (seg) {
        try { fs.truncateSync(seg.log, seg.bytes); } catch { /* best effort */ }
        try { writeIndex(seg.idx, seg.offsets); } catch { /* best effort */ }
      }
      this.failed = true;
      this.pending = [];
    }
  }

  // Take back the newest records that make up the last `count` logical lines
  // (lines that came back onto the screen when the terminal grew taller).
  dropLastLogical(count) {
    let dropped = 0;
    while (count > 0 && this.pending.length) {
      if (this.pending.pop()[0] !== 'w') count--;
      dropped++;
    }
    if (count <= 0) return dropped;
    this.flush();
    try {
      while (count > 0 && this.segments.length) {
        const seg = this.segments[this.segments.length - 1];
        if (!seg.offsets.length) { this.removeNewestSegment(); continue; }
        // Read the flag byte of each record from the end until enough starts.
        let i = seg.offsets.length;
        const flags = readRange(seg.log, seg.offsets[Math.max(0, i - 256)], seg.bytes - seg.offsets[Math.max(0, i - 256)]);
        const base = seg.offsets[Math.max(0, i - 256)];
        while (i > 0 && count > 0 && i > Math.max(0, seg.offsets.length - 256)) {
          i--;
          if (flags[seg.offsets[i] - base] !== 0x77 /* 'w' */) count--;
          dropped++;
        }
        fs.truncateSync(seg.log, i < seg.offsets.length ? seg.offsets[i] : seg.bytes);
        seg.bytes = i < seg.offsets.length ? seg.offsets[i] : seg.bytes;
        seg.offsets.length = i;
        writeIndex(seg.idx, seg.offsets);
        if (!seg.offsets.length) this.removeNewestSegment();
      }
    } catch (err) {
      console.error(`history disabled for ${this.dir}: ${err.message}`);
      this.failed = true;
      this.pending = [];
    }
    return dropped;
  }

  removeNewestSegment() {
    const seg = this.segments.pop();
    this.nextFirst = seg.first;
    for (const f of [seg.log, seg.idx]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }

  newSegment() {
    const last = this.segments[this.segments.length - 1];
    const no = last ? last.no + 1 : 0;
    const seg = {
      no,
      log: path.join(this.dir, `${no}.log`),
      idx: path.join(this.dir, `${no}.idx`),
      first: last ? last.first + last.offsets.length : this.nextFirst,
      offsets: [],
      bytes: 0,
    };
    fs.writeFileSync(seg.log, '', { mode: 0o600 });
    fs.writeFileSync(seg.idx, '', { mode: 0o600 });
    this.segments.push(seg);
    return seg;
  }

  // Drop whole segments from the old end: while the rest still holds the
  // configured number of lines, or while over the byte limit (always keeping
  // the newest segment).
  enforceLimits() {
    const lines = () => this.segments.reduce((n, s) => n + s.offsets.length, 0);
    while (this.segments.length > 1
      && (lines() - this.segments[0].offsets.length >= this.maxLines || this.bytes > this.maxBytes)) {
      const old = this.segments.shift();
      for (const f of [old.log, old.idx]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
    }
  }

  // Records for absolute indices from..from+count, clipped to what exists and
  // stopping after about maxBytes. Returns { from, records }.
  read(from, count, maxBytes = 1024 * 1024) {
    this.flush();
    from = Math.max(from, this.start);
    const to = Math.min(from + count, this.end);
    const records = [];
    let budget = maxBytes;
    for (const seg of this.segments) {
      const segEnd = seg.first + seg.offsets.length;
      const a0 = Math.max(from, seg.first) - seg.first;
      if (segEnd <= from || seg.first >= to || a0 >= seg.offsets.length) continue;
      let b = Math.min(to, segEnd) - seg.first;
      const startByte = seg.offsets[a0];
      // Shrink the range to the byte budget (at least one record).
      while (b - a0 > 1) {
        const endByte = b < seg.offsets.length ? seg.offsets[b] : seg.bytes;
        if (endByte - startByte <= budget) break;
        b = a0 + Math.max(1, Math.floor((b - a0) / 2));
      }
      const endByte = b < seg.offsets.length ? seg.offsets[b] : seg.bytes;
      const lines = readRange(seg.log, startByte, endByte - startByte).toString('utf8').split('\n');
      lines.pop();
      records.push(...lines);
      budget -= endByte - startByte;
      if (budget <= 0 || records.length >= to - from) break;
    }
    return { from, records };
  }

  clear() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const next = this.end;
    this.pending = [];
    for (const seg of this.segments) {
      for (const f of [seg.log, seg.idx]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
    }
    this.segments = [];
    this.nextFirst = next; // absolute numbering keeps moving forward
  }

  destroy() {
    this.clear();
    this.failed = true;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* nothing left */ }
  }
}

function readRange(file, start, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  if (!length) return buf;
  const fd = fs.openSync(file, 'r');
  try {
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, start + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function writeIndex(file, offsets) {
  const buf = Buffer.alloc(offsets.length * 4);
  offsets.forEach((o, i) => buf.writeUInt32LE(o, i * 4));
  fs.writeFileSync(file, buf, { mode: 0o600 });
}

module.exports = { History };
