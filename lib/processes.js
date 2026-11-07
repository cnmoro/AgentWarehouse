'use strict';
// Helpers for the processes running in a terminal: which command is in the
// foreground (to offer it again after a server restart), its folder, and every
// process of a terminal's session (to stop them all on shutdown). Linux reads
// /proc; macOS has none, so there the same answers come from ps and lsof.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAC = process.platform === 'darwin';

// macOS: one ps listing of every process, kept for a moment (a save asks about every tab at once). macOS reports no
// session ids, so a process's session is the session leader (the tab's shell) on the same terminal.
let psCache = { at: 0, byPid: new Map() };
function macProcs() {
  if (Date.now() - psCache.at < 1000) return psCache.byPid;
  const byPid = new Map();
  try {
    const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    const leaders = new Map(); // tty -> pid of its session leader
    const rows = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const r = { pid: +m[1], ppid: +m[2], pgrp: +m[3], tpgid: +m[4], state: m[5], tty: m[6], starttime: m[7] };
      rows.push(r);
      if (r.state.includes('s') && r.tty !== '??') leaders.set(r.tty, r.pid);
    }
    for (const r of rows) {
      r.session = r.tty !== '??' && leaders.has(r.tty) ? leaders.get(r.tty) : (r.state.includes('s') ? r.pid : 0);
      byPid.set(r.pid, r);
    }
  } catch { /* ps failed: nothing known */ }
  psCache = { at: Date.now(), byPid };
  return byPid;
}
function macArgv(pid) {
  try {
    const line = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    return line ? line.split(/\s+/) : null;
  } catch {
    return null;
  }
}
// The current folder of these processes, in one lsof run.
function macCwds(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let text = '';
  try {
    text = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    text = String(err.stdout || ''); // lsof exits with 1 when one of the processes is gone, but still lists the others
  }
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

// Fields of /proc/<pid>/stat after the command name, which may contain spaces.
function stat(pid) {
  if (MAC) return macProcs().get(+pid) || null;
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0], ppid: +f[1], pgrp: +f[2], session: +f[3], tpgid: +f[5], starttime: +f[19] };
  } catch {
    return null;
  }
}

// When the process started (clock ticks since boot), or null if it is gone.
function startTime(pid) {
  const s = stat(pid);
  return s ? s.starttime : null;
}

function argv(pid) {
  if (MAC) return macArgv(pid);
  try {
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  } catch {
    return null;
  }
}

function envPath(pid) {
  if (MAC) return process.env.PATH || ''; // another process's environment cannot be read here
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const p = env.find((e) => e.startsWith('PATH='));
    return p ? p.slice(5) : process.env.PATH || '';
  } catch {
    return process.env.PATH || '';
  }
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// The name under which PATH finds this file, if any ("/home/u/.local/bin/claude" -> "claude").
function commandName(file, searchPath) {
  const name = path.basename(file);
  const target = realpath(file);
  if (!target) return null;
  for (const dir of searchPath.split(':')) {
    if (dir && realpath(path.join(dir, name)) === target) return name;
  }
  return null;
}

const INTERPRETERS = /^(node|nodejs|deno|bun|python[0-9.]*|ruby|perl|php|bash|sh|zsh|dash)$/;

function quote(arg) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// The command the user would type to start this process again. A script run
// through its #! line shows up as "node /path/to/claude --x"; turn that back
// into "claude --x" when PATH finds the same file.
function commandLine(pid) {
  let args = argv(pid);
  if (!args || !args.length) return null;
  const searchPath = envPath(pid);
  if (args.length >= 2 && INTERPRETERS.test(path.basename(args[0])) && args[1].startsWith('/')) {
    const name = commandName(args[1], searchPath);
    if (name) args = [name, ...args.slice(2)];
  } else if (args[0].startsWith('/')) {
    const name = commandName(args[0], searchPath);
    if (name) args = [name, ...args.slice(1)];
  }
  const line = args.map(quote).join(' ').replace(/[\x00-\x1f\x7f]/g, ' ');
  return line.length > 1000 ? null : line;
}

// The foreground job of a terminal whose shell has this pid, as a command
// line, or null when the shell itself is in the foreground (at its prompt).
function foregroundCommand(shellPid) {
  const s = stat(shellPid);
  if (!s || !(s.tpgid > 0) || s.tpgid === shellPid) return null;
  return commandLine(s.tpgid);
}

// All processes in the session led by this pid (a terminal's shell).
function sessionMembers(sid) {
  if (MAC) return [...macProcs().values()].filter((r) => r.session === sid).map((r) => r.pid);
  const out = [];
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const s = stat(e);
    if (s && s.session === sid) out.push(+e);
  }
  return out;
}

// All processes in any of these sessions, in one pass over /proc.
function processesInSessions(sids) {
  const want = new Set(sids);
  if (MAC) return [...macProcs().values()].filter((r) => want.has(r.session)).map((r) => r.pid);
  const out = [];
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const s = stat(e);
    if (s && want.has(s.session)) out.push(+e);
  }
  return out;
}

// When this server is the main process of its own systemd service, every
// process in that service's cgroup; null otherwise. Started by hand (npm
// start), the cgroup is whatever the user's terminal or desktop runs in, which
// holds their other programs, so it must never be touched: systemd sets
// SYSTEMD_EXEC_PID to the main process's pid, and a process started from
// inside another unit inherits that unit's value instead of its own.
function serviceCgroupPids() {
  if (MAC) return null;
  if (process.env.SYSTEMD_EXEC_PID !== String(process.pid)) return null;
  try {
    const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
    const cg = line && line.slice(3).trim();
    if (!cg || !/\.service$/.test(cg)) return null;
    return fs.readFileSync(path.join('/sys/fs/cgroup', cg, 'cgroup.procs'), 'utf8')
      .split('\n').filter(Boolean).map(Number);
  } catch {
    return null;
  }
}

function signalAll(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

// The current folder of a process (a tab's shell). On macOS the folders of all these shells are looked up together and
// kept for a moment, since a save asks about every tab.
let cwdCache = { at: 0, map: new Map() };
function cwd(pid, allPids = [pid]) {
  if (!MAC) return fs.readlinkSync(`/proc/${pid}/cwd`);
  if (Date.now() - cwdCache.at > 2000 || !cwdCache.map.has(pid)) cwdCache = { at: Date.now(), map: macCwds([...new Set([pid, ...allPids])]) };
  const d = cwdCache.map.get(pid);
  if (!d) throw new Error('unknown');
  return d;
}

module.exports = { cwd, stat, startTime, commandLine, foregroundCommand, sessionMembers, processesInSessions, serviceCgroupPids, signalAll };
