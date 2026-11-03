/**
 * One bounded PowerShell per table: what `win32.ts` reads with when no owner
 * holds a reusable reader. docs/tasks/TASK_verifying_windows_processes.md.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as util from 'node:util';
import type { Failed, Incomplete, Success } from '../unsupported';
import type { Children, Slot } from './win32_children';
import { FILETIME_MAX, filetimeToUnixMs } from './index';

/** Milliseconds from the Windows process start clock, not a `ps lstart`. */
export const WIN32_FILETIME_MS_V1 = 'win32-filetime-ms-v1' as const;

export const MAX_OUTPUT = 8 * 1024 * 1024;

export const MAX_ROWS = 65_536;

/** Cold one-shot bound. The in-process query was much faster; startup was not. */
export const TIMEOUT_MS = 5_000;

const OFFSET_LIMIT_MINUTES = 14 * 60;

export type NativeRow = {
  pid: number;
  ppid: number;
  startedAt: number;
  /**
   * WMI `Name`, the image file name (for example `PING.EXE`). It names the
   * file only, independently of the command line's path or quoting.
   */
  image: string | null;
  /** `null` when WMI returned no command line. That row is still a process. */
  command: string | null;
};

export type NativeTable = {
  source: typeof WIN32_FILETIME_MS_V1;
  rows: readonly NativeRow[];
  selfPid: number;
  kernelPid: number;
};

export type NativeRead =
  | Success<NativeTable>
  | Incomplete<Omit<NativeTable, 'kernelPid'> & { kernelPid?: number }>
  | Failed;

export type ReaderEffects = {
  windowsDirectory: string | undefined;
  /**
   * One process, hidden, resolved only after it has closed. Reject on spawn
   * failure, timeout, or output past `maxBuffer`.
   */
  run(
    file: string,
    args: readonly string[],
    options: {
      maxBuffer: number;
      timeoutMs: number;
      /**
       * The backend's reserved right to start this run's one child
       * (`win32_children.ts`): the run marks it started and closed.
       */
      slot?: Slot;
    }
  ): Promise<{ stdout: string; stderr: string; code: number }>;
};

/**
 * `children` is the backend's: each read is admitted there before its run,
 * once, so it starts nothing while any child of the backend holds the slot,
 * and it waits only within that admission's bound.
 */
export function reader(
  effects: ReaderEffects,
  children?: Children
): { read(): Promise<NativeRead> } {
  return {
    read: () => readOnce(effects, children)
  };
}

async function readOnce(effects: ReaderEffects, children?: Children): Promise<NativeRead> {
  const file = powershellPath(effects.windowsDirectory);
  if (!file) return failed('Windows directory must be an absolute local path');
  const slot = await children?.admit();
  if (typeof slot === 'string') return failed(slot);
  const nonce = crypto.randomBytes(16).toString('hex');
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await effects.run(file, powershellArgs(nonce), {
      maxBuffer: MAX_OUTPUT,
      timeoutMs: TIMEOUT_MS,
      ...(slot ? { slot } : {})
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    // A run that started no child frees what it reserved.
    slot?.release();
  }
  if (result.code !== 0) return failed(`powershell exited ${result.code}`);
  if (result.stderr !== '') return failed('powershell wrote to stderr');
  return parseFrame(result.stdout, nonce);
}

export function powershellPath(directory: string | undefined): string | undefined {
  if (
    !directory ||
    !/^[a-z]:[\\/]/i.test(directory) ||
    /[<>"|?*]/.test(directory) ||
    directory.slice(2).includes(':') ||
    [...directory].some((character) => character.charCodeAt(0) < 32)
  )
    return undefined;
  return path.win32.join(directory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function powershellArgs(nonce: string): readonly string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(scriptFor(nonce), 'utf16le').toString('base64')
  ];
}

/** The table's start field, as the start vocabulary decodes it. */
export { filetimeToUnixMs };

/**
 * WMI's own `CreationDate` spelling: local civil time plus a minute offset,
 * microsecond fraction floored. The reader carries FILETIME instead; this is
 * the oracle native controls compare it against. Pid 0 and pid 4 expose this
 * DMTF and a null `Get-Process.StartTime`.
 */
export function dmtfToUnixMs(text: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const micros = Number(match[7]);
  const sign = match[8] === '+' ? 1 : -1;
  const offset = Number(match[9]);
  if (offset > OFFSET_LIMIT_MINUTES || hour > 23 || minute > 59 || second > 59) return undefined;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  const unix = local + Math.floor(micros / 1000) - sign * offset * 60_000;
  return Number.isSafeInteger(unix) ? unix : undefined;
}

export function parseFrame(stdout: string, nonce: string): NativeRead {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT) return failed('output exceeds 8 MiB');
  if (!/^[0-9a-f]{32}$/.test(nonce)) return failed('malformed nonce');
  const lines = stdout.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const openings = lines.filter((line) => line.startsWith('v3 ')).length;
  const endings = lines.filter((line) => line.startsWith('end ')).length;
  if (openings === 0 || endings === 0) return failed('truncated frame');
  if (openings !== 1 || endings !== 1) return failed('duplicate frame');
  if (lines[0] !== `v3 ${nonce}`) return failed('nonce mismatch');
  const self = /^self (\d+)$/.exec(lines[1] ?? '');
  const selfPid = self ? canonicalPid(self[1] ?? '') : undefined;
  if (selfPid === undefined || selfPid === 0) return failed('malformed frame');
  const kernelLine = lines[2] ?? '';
  const kernel = parseKernel(kernelLine);
  if (kernel === 'bad') return failed('malformed frame');
  const countMatch = /^count (\d+)$/.exec(lines[3] ?? '');
  const count = countMatch ? canonicalPid(countMatch[1] ?? '') : undefined;
  if (count === undefined || count > MAX_ROWS) return failed('malformed frame');
  if (lines.length !== count + 5) return failed('truncated frame');
  if (lines[count + 4] !== `end ${nonce} ${count}`) return failed('truncated frame');
  if (count === 0) return failed('empty table');

  const rows: NativeRow[] = [];
  const seen = new Set<number>();
  let bad = 0;
  let badCommand = 0;
  let kernelCreated: string | undefined;
  for (const line of lines.slice(4, 4 + count)) {
    const parts = line.split(' ');
    const pid = canonicalPid(parts[0] ?? '');
    const ppid = canonicalPid(parts[1] ?? '');
    if (parts.length !== 5 || pid === undefined || ppid === undefined)
      return failed('malformed row');
    if (seen.has(pid)) return failed('duplicate pid');
    seen.add(pid);
    const startedAt = filetimeToUnixMs(parts[2] ?? '');
    if (pid === 4) kernelCreated = parts[2];
    if (startedAt === undefined) {
      bad += 1;
      continue;
    }
    const image = decodeField(parts[3] ?? '');
    const command = decodeField(parts[4] ?? '');
    if (image === undefined || command === undefined) badCommand += 1;
    rows.push({ pid, ppid, startedAt, image: image ?? null, command: command ?? null });
  }

  const kernelPid = kernel === 'missing' ? undefined : kernel.pid;
  const kernelAgrees =
    kernel !== 'missing' &&
    rows.some(
      (row) =>
        row.pid === kernel.pid &&
        row.ppid === kernel.ppid &&
        row.startedAt === kernel.startedAt &&
        kernelCreated === kernel.created
    );
  const selfAgrees = rows.some((row) => row.pid === selfPid);
  if (bad === 0 && badCommand === 0 && kernelAgrees && selfAgrees && kernelPid !== undefined) {
    return {
      supported: true,
      status: 'ok',
      value: { source: WIN32_FILETIME_MS_V1, rows, selfPid, kernelPid }
    };
  }
  const reason = !selfAgrees
    ? 'self witness missing'
    : !kernelAgrees
      ? 'kernel witness missing'
      : bad > 0
        ? `${bad} rows had no usable start`
        : `${badCommand} rows had unusable image or command metadata`;
  return {
    supported: true,
    status: 'incomplete',
    value: {
      source: WIN32_FILETIME_MS_V1,
      rows,
      selfPid,
      ...(kernelPid === undefined ? {} : { kernelPid })
    },
    reason
  };
}

function parseKernel(
  line: string
): { pid: number; ppid: number; startedAt: number; created: string } | 'missing' | 'bad' {
  if (line === 'kernel missing') return 'missing';
  const match = /^kernel (\d+) (\d+) (\S+)$/.exec(line);
  if (!match || match[1] !== '4') return 'bad';
  const pid = canonicalPid(match[1]);
  const ppid = canonicalPid(match[2] ?? '');
  const startedAt = filetimeToUnixMs(match[3] ?? '');
  if (pid === undefined || ppid === undefined) return 'bad';
  // A witness date that is not a start is a missing witness, not a broken frame.
  if (startedAt === undefined) return 'missing';
  return { pid, ppid, startedAt, created: match[3] ?? '' };
}

/** `-` is no value and `b64:` UTF-8 text; anything else is unusable. */
function decodeField(field: string): string | null | undefined {
  if (field === '-') return null;
  if (!field.startsWith('b64:')) return undefined;
  const text = field.slice(4);
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) return undefined;
  try {
    return new util.TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function canonicalPid(text: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= 0xffff_ffff ? value : undefined;
}

function failed(reason: string): NativeRead {
  return { supported: true, status: 'failed', reason };
}

function scriptFor(nonce: string): string {
  if (!/^[0-9a-f]{32}$/.test(nonce))
    throw new Error('process reader nonce must be 32 hex characters');
  return `${PRELUDE}
$nonce = '${nonce}'
& $writeTable`;
}

/**
 * One table per `read <nonce>` line on stdin, until EOF. A malformed request or
 * a failed table ends the process, as a failed one-shot does; the owner then
 * starts another.
 */
function loopScript(): string {
  return `${PRELUDE}
while ($true) {
  $request = [Console]::In.ReadLine()
  if ($null -eq $request) { exit 0 }
  if ($request -cnotmatch '^read ([0-9a-f]{32})$') { throw 'malformed process table request' }
  $nonce = $Matches[1]
  & $writeTable
}`;
}

export function loopArgs(): readonly string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(loopScript(), 'utf16le').toString('base64')
  ];
}

const PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8
$maxRows = ${MAX_ROWS}
$maxOutput = ${MAX_OUTPUT}
# Writes one frame for $nonce, read from the caller's scope.
$writeTable = {
$rows = New-Object System.Collections.Generic.List[string]
$kernel = $null
# Reserve the largest envelope before gathering, including CRLF and uint32 parent ids.
$bytes = $utf8.GetByteCount("v3 $nonce\`r\`nself $PID\`r\`nkernel 4 4294967295 ${FILETIME_MAX}\`r\`ncount $maxRows\`r\`nend $nonce $maxRows\`r\`n")
if ($bytes -gt $maxOutput) { throw 'process frame exceeds byte limit' }
# Streamed: a throw stops the enumeration before another row is gathered.
Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ForEach-Object {
  if ($rows.Count -ge $maxRows) { throw 'process table exceeds row limit' }
  $rawProcessId = $_.ProcessId
  $rawParentId = $_.ParentProcessId
  if ($null -eq $rawProcessId -or $null -eq $rawParentId) { throw 'process identity unavailable' }
  $processId = [uint32]$rawProcessId
  $parentId = [uint32]$rawParentId
  # 2026-10-26: CIM's Local DateTime round trip through ConvertTimeFromUtc and
  # ToFileTimeUtc was exact for two synthetic repeated-hour instants under a
  # per-process Pacific override; no real fall-back-hour process was observed.
  $created = '?'
  $date = $_.CreationDate
  if ($null -ne $date) { try { $created = [string]$date.ToFileTimeUtc() } catch { $created = '?' } }
  $prefix = "$processId $parentId $created "
  $image = $_.Name
  $command = $_.CommandLine
  $fieldBytes = 0
  $fields = foreach ($value in @($image, $command)) {
    if ($null -eq $value) { $fieldBytes += 1; '-'; continue }
    try {
      $size = 4 + 4 * [Math]::Ceiling($utf8.GetByteCount([string]$value) / 3.0)
      if ($bytes + $fieldBytes + $size -le $maxOutput) {
        $encoded = 'b64:' + [Convert]::ToBase64String($utf8.GetBytes([string]$value))
      }
    } catch { $fieldBytes += 1; '!'; continue }
    $fieldBytes += $size
    if ($bytes + $fieldBytes -gt $maxOutput) { throw 'process frame exceeds byte limit' }
    $encoded
  }
  $bytes += $utf8.GetByteCount($prefix) + $fieldBytes + 3
  if ($bytes -gt $maxOutput) { throw 'process frame exceeds byte limit' }
  if ($processId -eq 4) { $kernel = "$processId $parentId $created" }
  $rows.Add($prefix + ($fields -join ' '))
}
$writer = [Console]::Out
$writer.WriteLine("v3 $nonce")
$writer.WriteLine("self $PID")
if ($null -eq $kernel) { $writer.WriteLine('kernel missing') } else { $writer.WriteLine("kernel $kernel") }
$writer.WriteLine("count $($rows.Count)")
foreach ($line in $rows) { $writer.WriteLine($line) }
$writer.WriteLine("end $nonce $($rows.Count)")
$writer.Flush()
}`.trim();
