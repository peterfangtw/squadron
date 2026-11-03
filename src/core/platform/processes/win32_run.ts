/**
 * The one-shot reader's bounded run, as production effects give it
 * (`ReaderEffects.run`): one hidden child, settled only after its `close`.
 *
 * `execFile` is not enough here: its callback can run from the child's
 * `error` before `close`, so a failed kill on timeout reported a read failed
 * while its PowerShell lived on. Here a timeout or an overflow ends the child
 * and waits for `close`; a kill that fails leaves it unresolved for at most
 * `closeWaitMs`, after which the run reports that and keeps it.
 *
 * Admission is the backend's (`win32_children.ts`): the reader reserves the
 * slot and passes it as `options.slot`, so a run starts its one child only
 * when no other child of the backend holds it. From the moment a child's
 * ending begins it keeps the slot; one still open at its deadline refuses
 * every start until its `close` arrives. A caller that passes no slot is
 * admitted through this runner's own set, one child at a time.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import * as win32Children from './win32_children';
import type { ReaderEffects } from './win32_reader';

export type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** After a kill, how long a child has to close before it is unresolved. */
export const CLOSE_WAIT_MS = 5_000;

export function boundedRun(spawn: Spawn, closeWaitMs = CLOSE_WAIT_MS): ReaderEffects['run'] {
  // Only for a caller that passes no slot: the backend always passes its own.
  const own = win32Children.children();
  return async (file, args, options) => {
    const slot = options.slot ?? (await own.admit());
    if (typeof slot === 'string') throw new Error(slot);
    return once(spawn, file, args, options, slot, closeWaitMs);
  };
}

function once(
  spawn: Spawn,
  file: string,
  args: readonly string[],
  options: { maxBuffer: number; timeoutMs: number },
  slot: win32Children.Slot,
  closeWaitMs: number
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      slot.release();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const tracked = slot.started(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const sizes = { stdout: 0, stderr: 0 };
    let failure: Error | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let markClosed: () => void = () => {};
    const closed = new Promise<true>((settle) => (markClosed = () => settle(true)));
    const fail = (error: Error) => {
      failure ??= error;
      if (deadline) return;
      // The exclusion starts with the ending, not at its deadline.
      tracked.ending(
        Promise.race([
          closed,
          new Promise<false>((settle) => {
            deadline = setTimeout(() => {
              settle(false);
              reject(new Error(`${failure?.message ?? 'failed'}; powershell did not close`));
            }, closeWaitMs);
          })
        ])
      );
      try {
        if (!child.kill()) failure = new Error(`${failure.message}; its kill was refused`);
      } catch (thrown) {
        failure = new Error(`${failure.message}; its kill threw: ${String(thrown)}`);
      }
    };
    const collect = (stream: 'stdout' | 'stderr', into: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      sizes[stream] += chunk.length;
      if (sizes[stream] > options.maxBuffer)
        fail(new Error(`${stream} exceeds ${options.maxBuffer} bytes`));
      else into.push(chunk);
    };
    child.stdout?.on('data', collect('stdout', stdout));
    child.stderr?.on('data', collect('stderr', stderr));
    const timer = setTimeout(() => fail(new Error('powershell timed out')), options.timeoutMs);
    // Spawn failures and kill errors both arrive here; only `close` ends a run
    // whose process started.
    child.on('error', (error) => {
      failure ??= error;
      // No process started: there is only Node's own close to wait for.
      if (child.pid === undefined && !deadline)
        deadline = setTimeout(() => {
          tracked.closed();
          reject(error);
        }, closeWaitMs);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(deadline);
      tracked.closed();
      markClosed();
      // A run already reported unresolved has settled; this only frees the bound.
      if (failure) reject(failure);
      else if (code === null)
        reject(new Error(`powershell ended by ${signal ?? 'an unknown signal'}`));
      else
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code
        });
    });
  });
}
