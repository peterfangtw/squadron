import type { Failed, Success } from '../unsupported';
import type { Effects, Listeners, Range, Socket } from './index';

/**
 * A backstop, not a latency budget — the same reasoning `machine.ts` gives for
 * `vm_stat`. `lsof` walks every open file on the machine, and the state it can
 * block on (a wedged mount, an unresponsive NFS server) is invisible otherwise:
 * nothing throws, so the `catch` never runs and a picker never opens.
 */
const SPAWN_MS = 2000;

/**
 * Where `lsof` is, tried in order. Absolute paths because the extension host's
 * `PATH` is inherited from wherever the IDE was launched — a GUI start on macOS
 * need not have `/usr/sbin` on it, and a bare `lsof` would then be `ENOENT` on
 * exactly the machines this ships to. The bare name last, for a platform that
 * puts it somewhere neither guess covers.
 */
const BINARIES = ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof'];

export function listeners(effects: Effects): Listeners {
  // Remember the working path per capability/window, shared by both queries.
  let binary: string | undefined;

  async function lsof(args: string[]): Promise<Success<string> | Failed> {
    for (const candidate of binary ? [binary] : BINARIES) {
      try {
        const stdout = await effects.run(candidate, args, { timeout: SPAWN_MS });
        binary = candidate;
        return { supported: true, status: 'ok', value: stdout };
      } catch (error) {
        const failed = (error ?? {}) as { code?: unknown; killed?: unknown; stdout?: unknown };
        if (typeof failed.code === 'string') continue;
        // Measured 2026-08-05: a timeout carries partial stdout; never parse it.
        // Completed nonzero exits carry complete stdout too (notably exit 1
        // for no matches). Preserve that legacy answer; only interrupted output
        // and spawn/collection errors are unusable.
        if (failed.killed !== true) {
          binary = candidate;
          if (typeof failed.stdout === 'string') {
            return { supported: true, status: 'ok', value: failed.stdout };
          }
        }
        return { supported: true, status: 'failed', reason: 'lsof did not complete successfully' };
      }
    }
    return { supported: true, status: 'failed', reason: 'no runnable lsof binary' };
  }

  return {
    async read(block?: Range) {
      if (
        block &&
        (!Number.isInteger(block.base) || !Number.isInteger(block.span) || block.span < 1)
      ) {
        return { supported: true, status: 'ok', value: [] };
      }
      const selector = block ? `-iTCP:${block.base}-${block.base + block.span - 1}` : '-iTCP';
      const output = await lsof(['-nP', '+c', '0', selector, '-sTCP:LISTEN', '-Fpcn']);
      return output.status === 'ok' ? { ...output, value: parseListeners(output.value) } : output;
    },
    async cwds(pids) {
      const list = [...new Set(pids)];
      if (list.length === 0) return { supported: true, status: 'ok', value: new Map() };
      const output = await lsof(['-a', '-p', list.join(','), '-d', 'cwd', '-Fpn']);
      return output.status === 'ok' ? { ...output, value: parseCwds(output.value) } : output;
    }
  };
}

/**
 * `lsof -F` output -> one entry per field set.
 *
 * The format is one field per line, each prefixed by its identifier, and it is
 * **stateful**: a `p` line opens a process set and every `f`/`n` line after it
 * belongs to that process until the next `p`. A parse that treated the lines as
 * independent records would attribute every socket to whichever pid `lsof`
 * happened to print last.
 *
 */
function parseListeners(stdout: string): Socket[] {
  const found: Socket[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  for (const line of stdout.split('\n')) {
    const value = line.slice(1);
    switch (line[0]) {
      case 'p': {
        // A new process set: everything after this belongs to it, and the
        // previous set's command must not leak into it.
        const parsed = Number(value);
        pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
        command = undefined;
        break;
      }
      case 'c':
        command = value;
        break;
      case 'n': {
        const port = portOf(value);
        if (pid !== undefined && port !== undefined) {
          found.push({ port, pid, ...(command !== undefined ? { command } : {}) });
        }
        break;
      }
      default:
        break; // `f`, `t`, and any field a future `lsof` adds
    }
  }
  return found;
}

/**
 * The port out of an `lsof` name — `*:3000`, `127.0.0.1:3000`, `[::1]:3000`.
 *
 * The last colon, because an IPv6 address is made of them, and the bracket form
 * is what puts the address's own colons before the one that matters. A name with
 * an arrow in it is a connection rather than a listener (`-sTCP:LISTEN` should
 * have excluded it; this is the second lock) and a service name rather than a
 * number is `lsof` without `-P`, which is not how we call it.
 */
function portOf(name: string): number | undefined {
  if (name.includes('->')) {
    return undefined;
  }
  const port = Number(name.slice(name.lastIndexOf(':') + 1));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/**
 * `lsof -d cwd -F` output -> pid to directory.
 *
 * Same statefulness as `parseListeners` and the same reason it is its own
 * function: the `n` line holding a path is only meaningful under the `p` line
 * above it. A directory is taken as printed — it can hold anything a filesystem
 * allows, newlines excepted, which `lsof`'s line format already cannot express.
 */
function parseCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of stdout.split('\n')) {
    const value = line.slice(1);
    if (line[0] === 'p') {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (line[0] === 'n' && pid !== undefined && value) {
      cwds.set(pid, value);
    }
  }
  return cwds;
}
