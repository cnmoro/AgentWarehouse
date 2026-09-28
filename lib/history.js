'use strict';
// Long-term terminal history, kept on disk.
//
// The terminal (server mirror and browsers) keeps only a "hot" window of
// scrollback. Lines that fall off its top are appended here, one record per
// line, and read back in pages when the history viewer asks for them. Nothing
// is loaded into memory except byte offsets.
//
// Layout: data/history/<tab id>/<segment number>.log, each segment holding up
// to SEGMENT_LINES records. A record is one text line: a flag character ('w'
// when the line continues the previous one, ' ' otherwise), then the line's
// text with SGR colour sequences. When the total exceeds the configured limit,
// whole segments are dropped from the old end.
const fs = require('fs');
const path = require('path');

const SEGMENT_LINES = 20000;
const FLUSH_MS = 200;

class History {
  constructor(dir, maxLines) {
    this.dir = dir;
    this.maxSegments = Math.max(2, Math.ceil(maxLines / SEGMENT_LINES) + 1);
    this.segments = []; // { no, file, first (absolute index), offsets: number[], bytes }
    this.pending = [];
    this.flushTimer = null;
    this.first = 0; // absolute index of the oldest record still kept
    this.load();
  }

  // Absolute index one past the newest record.
  get end() {
    const last = this.segments[this.segments.length - 1];
    return (last ? last.first + last.offsets.length : this.first) + this.pending.length;
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
      const file = path.join(this.dir, `${no}.log`);
      const buf = fs.readFileSync(file);
      const offsets = [];
      let start = 0;
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) {
        offsets.push(start);
        start = i + 1;
      }
      if (start < buf.length) fs.truncateSync(file, start); // drop a torn last record
      this.segments.push({ no, file, first, offsets, bytes: start });
      first += offsets.length;
    }
    this.first = 0;
  }

  // Records never contain line breaks: they come from terminal cells.
  append(record) {
    this.pending.push(record);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    if (this.pending.length >= 5000) this.flush();
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    while (this.pending.length) {
      let seg = this.segments[this.segments.length - 1];
      if (!seg || seg.offsets.length >= SEGMENT_LINES) seg = this.newSegment();
      const room = SEGMENT_LINES - seg.offsets.length;
      const batch = this.pending.splice(0, room);
      let bytes = seg.bytes;
      for (const r of batch) {
        seg.offsets.push(bytes);
        bytes += Buffer.byteLength(r) + 1;
      }
      try {
        fs.appendFileSync(seg.file, batch.join('\n') + '\n', { mode: 0o600 });
      } catch (err) {
        console.error(`history write failed (${seg.file}): ${err.message}`);
        seg.offsets.length -= batch.length; // keep the index consistent with the file
        return;
      }
      seg.bytes = bytes;
    }
  }

  newSegment() {
    const last = this.segments[this.segments.length - 1];
    const no = last ? last.no + 1 : 0;
    const seg = { no, file: path.join(this.dir, `${no}.log`), first: last ? last.first + last.offsets.length : this.first, offsets: [], bytes: 0 };
    this.segments.push(seg);
    while (this.segments.length > this.maxSegments) {
      const old = this.segments.shift();
      try { fs.unlinkSync(old.file); } catch { /* already gone */ }
    }
    return seg;
  }

  // Oldest absolute index still available.
  get start() {
    return this.segments.length ? this.segments[0].first : this.end - this.pending.length;
  }

  // Records for absolute indices [from, from + count), clipped to what exists.
  read(from, count) {
    this.flush();
    const out = [];
    from = Math.max(from, this.start);
    const to = Math.min(from + count, this.end);
    for (const seg of this.segments) {
      const segEnd = seg.first + seg.offsets.length;
      if (segEnd <= from || seg.first >= to) continue;
      const a = Math.max(from, seg.first) - seg.first;
      const b = Math.min(to, segEnd) - seg.first;
      const startByte = seg.offsets[a];
      const endByte = b < seg.offsets.length ? seg.offsets[b] : seg.bytes;
      const buf = Buffer.alloc(endByte - startByte);
      const fd = fs.openSync(seg.file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, startByte); } finally { fs.closeSync(fd); }
      const lines = buf.toString('utf8').split('\n');
      lines.pop(); // trailing newline
      out.push(...lines);
    }
    return { from, records: out };
  }

  clear() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const next = this.end;
    this.pending = [];
    for (const seg of this.segments) {
      try { fs.unlinkSync(seg.file); } catch { /* already gone */ }
    }
    this.segments = [];
    this.first = next; // keep absolute numbering moving forward
  }

  destroy() {
    this.clear();
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* nothing left */ }
  }
}

module.exports = { History, SEGMENT_LINES };
