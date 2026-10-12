'use strict';
// What the editor needs to know about a text file before it may change it: is it valid UTF-8, does it start with
// a byte order mark, and does it use one kind of line ending throughout. A file that fails these is shown but not
// editable, because saving it back through a text box would alter bytes the user never touched.

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// buf: the whole file. Returns { ok, why, bom, eol, text } where text has the BOM removed and, for 'crlf' files,
// the line endings turned into "\n" (the editor works with "\n" and the server puts them back when saving).
function inspect(buf) {
  let start = 0;
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (bom) start = 3;
  let text;
  try {
    text = strict.decode(buf.subarray(start));
  } catch {
    return { ok: false, why: 'The file is not valid UTF-8 text.' };
  }
  if (text.includes('\0')) return { ok: false, why: 'The file contains NUL bytes.' };
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length; // includes the \n of every \r\n
  const loneCr = (text.replace(/\r\n/g, '').match(/\r/g) || []).length;
  if (loneCr) return { ok: false, why: 'The file has old-style (CR only) line endings.' };
  if (crlf && crlf !== lf) return { ok: false, why: 'The file mixes Windows (CRLF) and Unix (LF) line endings.' };
  return { ok: true, bom, eol: crlf ? 'crlf' : 'lf', text: crlf ? text.replace(/\r\n/g, '\n') : text };
}

// The bytes to write for edited text (with "\n" line endings), the way the file was read.
function encode(text, { bom, eol }) {
  const body = eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, 'utf8')]);
}

module.exports = { inspect, encode };
