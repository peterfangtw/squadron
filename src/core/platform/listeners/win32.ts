import * as path from 'node:path';
import { unsupported } from '../unsupported';
import type { Failed } from '../unsupported';
import type { Effects, Listeners, Socket } from './index';

/** `darwin.ts` argues this backstop. */
const SPAWN_MS = 2000;

export type WindowsEffects = Effects & { windowsDirectory: string | undefined };

/**
 * `netstat -ano`, not the CIM provider: 25–46 ms and about 5 MiB against
 * 654–699 ms and 85 MiB, on a poll that repeats every seven seconds
 * (`TASK_planned_windows_dev_servers.md`). `-p tcp` is not used: it lists IPv4
 * only, and Vite binds `::1`.
 */
export function listeners(effects: WindowsEffects): Listeners {
  return {
    async read() {
      const file = netstatPath(effects.windowsDirectory);
      if (!file) return failed('Windows directory must be an absolute local path');
      let stdout: string;
      try {
        stdout = await effects.run(file, ['-ano'], { timeout: SPAWN_MS });
      } catch {
        return failed('netstat did not complete successfully');
      }
      const found = parseListening(stdout);
      return found
        ? { supported: true, status: 'ok', value: found }
        : failed('netstat printed a row this reader cannot follow');
    },
    cwds: () =>
      Promise.resolve(
        unsupported('listeners.cwds', 'win32', 'no supported read of another process directory')
      )
  };
}

function failed(reason: string): Failed {
  return { supported: true, status: 'failed', reason };
}

function netstatPath(directory: string | undefined): string | undefined {
  if (!directory || !path.win32.isAbsolute(directory) || directory.startsWith('\\\\')) {
    return undefined;
  }
  return path.win32.join(directory, 'System32', 'netstat.exe');
}

/**
 * The listening sockets of one table, or undefined for a TCP row that does not
 * read as one: a misread table must draw no chip, never a wrong one.
 *
 * A listener is a TCP row whose remote port is 0. The state column is a
 * localized word, so nothing here reads it; on the table observed 2026-11-02,
 * remote port 0 and `LISTENING` chose the same 37 of 132 TCP rows. A UDP row is
 * skipped by name, and the headings have no `TCP` in their first column.
 */
function parseListening(stdout: string): Socket[] | undefined {
  const found: Socket[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'TCP') continue;
    const [, local, remote] = columns;
    const pidText = columns.at(-1);
    if (columns.length < 5 || local === undefined || remote === undefined) return undefined;
    const port = portOf(local);
    if (port === undefined || portOf(remote) === undefined) return undefined;
    if (!pidText || !/^\d+$/.test(pidText)) return undefined;
    if (portOf(remote) !== 0) continue;
    found.push({ port, pid: Number(pidText) });
  }
  return found;
}

/** After the last colon, because an IPv6 address is made of them. */
function portOf(address: string): number | undefined {
  const text = address.slice(address.lastIndexOf(':') + 1);
  const port = Number(text);
  return /^\d+$/.test(text) && port < 65536 ? port : undefined;
}
