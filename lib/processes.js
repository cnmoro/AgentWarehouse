'use strict';
// Linux /proc helpers for the processes running in a terminal: which command
// is in the foreground (to offer it again after a server restart), and every
// process of a terminal's session (to stop them all on shutdown).
const fs = require('fs');
const path = require('path');

// Fields of /proc/<pid>/stat after the command name, which may contain spaces.
function stat(pid) {
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
  try {
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  } catch {
    return null;
  }
}

function envPath(pid) {
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

module.exports = { stat, startTime, commandLine, foregroundCommand, sessionMembers, processesInSessions, serviceCgroupPids, signalAll };
