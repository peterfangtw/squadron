import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LIMITS = { timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
const SOURCE = process.platform === 'win32' ? 'win32-filetime-ms-v1' : 'ps-lstart-v1';
const POWERSHELL = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {
  if ($_.ProcessId -ne 0) {
    $start = '?'
    if ($null -ne $_.CreationDate) { $start = [string]$_.CreationDate.ToFileTimeUtc() }
    [Console]::WriteLine(('{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,$start))
  }
}
[Console]::WriteLine('end')`;

function native(command, args) {
  return cp.execFileSync(command, args, {
    ...LIMITS,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function powershell(script) {
  return native('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

/** A failed or partial native read never establishes that a process is absent. */
export function snapshot() {
  try {
    const windows = process.platform === 'win32';
    const text = windows ? powershell(POWERSHELL) : native('ps', ['-axo', 'pid=,ppid=,lstart=']);
    const lines = text.trim().split(/\r?\n/);
    if (windows && lines.pop() !== 'end') throw new Error('incomplete process table');
    const rows = [];
    const seen = new Set();
    for (const line of lines) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new Error('malformed process row');
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      let started = match[3];
      if (windows) {
        if (!/^[1-9]\d{0,18}$/.test(started)) throw new Error('process start unavailable');
        const ticks = BigInt(started);
        if (ticks < 116444736000000000n || ticks > 2650467743999999999n)
          throw new Error('invalid process start');
        started = Number(ticks / 10000n - 11644473600000n);
        if (!Number.isSafeInteger(started) || started < 0) throw new Error('invalid process start');
      } else if (
        !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(
          started
        ) ||
        !Number.isFinite(Date.parse(started))
      )
        throw new Error('invalid process start');
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || seen.has(pid))
        throw new Error('invalid process identity');
      seen.add(pid);
      rows.push({ pid, ppid, started, source: SOURCE });
    }
    if (!rows.length) throw new Error('empty process table');
    return { version: 1, complete: true, rows };
  } catch (error) {
    return { version: 1, complete: false, rows: [], reason: error.message };
  }
}

export function identity(pid, table = snapshot()) {
  return table.complete ? table.rows.find((row) => row.pid === pid) : undefined;
}

export function sameIdentity(a, b) {
  return (
    validIdentity(a) &&
    validIdentity(b) &&
    a.pid === b.pid &&
    a.source === b.source &&
    a.started === b.started
  );
}

export function validIdentity(value) {
  return (
    !!value &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    (value.source === 'win32-filetime-ms-v1'
      ? Number.isSafeInteger(value.started) &&
        value.started >= 0 &&
        value.started <= 253402300799999
      : value.source === 'ps-lstart-v1' &&
        typeof value.started === 'string' &&
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(
          value.started
        ) &&
        Number.isFinite(Date.parse(value.started)))
  );
}

/** Only a still-exact parent can witness new children; a retained dead PID cannot. */
export function adopt(table, retained) {
  if (!table.complete || !retained.every(validIdentity)) return undefined;
  const members = [...retained];
  const exact = members.filter((member) => sameIdentity(member, identity(member.pid, table)));
  for (let at = 0; at < exact.length; at++) {
    const parent = exact[at];
    for (const row of table.rows) {
      const birth = (value) =>
        value.source === 'ps-lstart-v1' ? Date.parse(value.started) : value.started;
      if (
        row.ppid !== parent.pid ||
        row.source !== parent.source ||
        birth(row) < birth(parent) ||
        members.some((member) => sameIdentity(member, row))
      )
        continue;
      members.push(row);
      exact.push(row);
    }
  }
  return members;
}

/** This recheck cannot close the numeric PID check-to-signal race. */
export function end(member, signal = 'SIGTERM') {
  if (
    !Number.isSafeInteger(member?.pid) ||
    member.pid <= 0 ||
    !sameIdentity(member, identity(member.pid))
  )
    return false;
  try {
    process.kill(member.pid, signal);
    return true;
  } catch {
    return false;
  }
}

let account;
export function accountGateRoot() {
  if (!account) {
    const home =
      process.platform === 'win32'
        ? powershell(
            '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))'
          ).trim()
        : os.userInfo().homedir;
    if (!home || !path.isAbsolute(home)) throw new Error('actual account home unavailable');
    account = path.join(home, '.squadron', 'tooling', 'gate');
  }
  return account;
}

export function gateRoot(env = process.env) {
  const override = env.SQUADRON_GATE_DIR;
  if (override !== undefined) {
    if (!path.isAbsolute(override)) throw new Error('SQUADRON_GATE_DIR must be absolute');
    return path.normalize(override);
  }
  const root = accountGateRoot();
  fs.mkdirSync(path.dirname(root), { recursive: true });
  return path.join(fs.realpathSync(path.dirname(root)), 'gate');
}
