#!/usr/bin/env node
// One-off helper for the restart that deploys "restarts keep what the
// terminals showed": the server being stopped runs older code that does not
// save full-screen programs' screens, so this does it from outside.
//
//   capture <baseUrl> <login> <password> <out.json>   while the old server runs
//   apply <out.json> <DATA_DIR>                        after it stopped, before the new one starts
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const WebSocket = require(`${REPO}/node_modules/ws`);
const { Terminal } = require(`${REPO}/node_modules/@xterm/headless`);
const { Tab, HISTORY_LINES, HISTORY_BYTES } = require(`${REPO}/lib/terminals`);
const { History } = require(`${REPO}/lib/history`);

const INTERP = /^(node|nodejs|deno|bun|python[0-9.]*|ruby|perl|php|bash|sh|zsh|dash)$/;
function programName(cmd) {
  const words = String(cmd || '').split(/\s+/).filter(Boolean).filter((w) => !/^[A-Z_]+=/.test(w));
  const base = (w) => w.replace(/^'|'$/g, '').split('/').pop();
  if (!words.length) return 'The program';
  return INTERP.test(base(words[0])) && words[1] ? base(words[1]) : base(words[0]);
}

// The alternate screen of a terminal, as history records (same format and
// trimming as Tab.archiveProgramScreen).
function altRecords(term) {
  if (term.buffer.active.type !== 'alternate') return [];
  const alt = term._core.buffers.alt;
  const rows = [];
  for (let y = 0; y < term.rows; y++) rows.push(alt.lines.get(alt.ybase + y));
  const blank = (l) => !l || l.translateToString(true).trim() === '';
  let first = 0;
  let last = rows.length - 1;
  while (first <= last && blank(rows[first])) first++;
  while (last >= first && blank(rows[last])) last--;
  const self = { mirror: term, historyCell: null, lineText: Tab.prototype.lineText };
  const out = [];
  for (let y = first; y <= last; y++) out.push(Tab.prototype.lineRecord.call(self, rows[y], rows[y + 1]));
  return out;
}

async function capture(base, login, password, outFile) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: login, password }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Origin: base, Cookie: cookie } });
  const tabs = new Map();
  const pending = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'list') {
      for (const t of m.tabs) if (!tabs.has(t.id)) { tabs.set(t.id, { name: t.name }); ws.send(JSON.stringify({ t: 'attach', id: t.id })); }
    }
    if (m.t === 'snap' && tabs.has(m.id)) {
      const term = new Terminal({ cols: m.cols, rows: m.rows, scrollback: 100, allowProposedApi: true, logLevel: 'off' });
      pending.push(new Promise((res) => term.write(m.d, () => { tabs.get(m.id).records = altRecords(term); term.dispose(); res(); })));
    }
  });
  await new Promise((res) => ws.on('open', res));
  await new Promise((res) => setTimeout(res, 4000));
  await Promise.all(pending);
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { Origin: base, Cookie: cookie } });
  ws.close();
  const out = {};
  for (const [id, t] of tabs) if (t.records && t.records.length) out[id] = { name: t.name, records: t.records };
  fs.writeFileSync(outFile, JSON.stringify(out), { mode: 0o600 });
  console.log(`captured ${Object.keys(out).length} full-screen program screen(s) of ${tabs.size} tabs`);
}

function apply(inFile, dataDir) {
  const saved = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  let running = {};
  try { for (const t of JSON.parse(fs.readFileSync(path.join(dataDir, 'tabs.json'), 'utf8'))) running[t.id] = t.running; } catch { running = {}; }
  let n = 0;
  for (const [id, { records }] of Object.entries(saved)) {
    if (!/^[0-9a-f]{1,32}$/.test(id) || !fs.existsSync(path.join(dataDir, 'history', id))) continue;
    const h = new History(path.join(dataDir, 'history', id), { maxLines: HISTORY_LINES, maxBytes: HISTORY_BYTES });
    h.append(` \x1b[2m── ${programName(running[id])} was showing this when the server stopped ──\x1b[0m`);
    for (const rec of records) h.append(rec);
    h.flush();
    n++;
  }
  console.log(`added ${n} saved screen(s) to the history`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'capture') capture(...args).catch((e) => { console.error(e.message); process.exit(1); });
else if (cmd === 'apply') apply(...args);
else { console.error('usage: capture <url> <login> <password> <out.json> | apply <out.json> <DATA_DIR>'); process.exit(2); }
