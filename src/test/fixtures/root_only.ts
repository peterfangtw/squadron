/**
 * What a sign-in or MCP login cancel may touch: its own root, by its owner's
 * ask, and nothing below it. A browser or another app the CLI launched must
 * never be ended by a cancel, so the controls hold a detached descendant and
 * pin that the cancel neither read the process table nor signalled through it.
 */
import * as assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

/**
 * Fixture source: start a detached, held descendant and, before anything else
 * can fail, write both pids to `file` (a JS expression; `nodeCli`'s `seen`).
 * The record is ownership, apart from any readiness marker.
 */
export function heldDescendant(file = 'seen'): string {
  return (
    `const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: 'ignore', windowsHide: true });\n` +
    `kid.unref();\n` +
    `require('node:fs').writeFileSync(${file}, process.pid + ' ' + kid.pid);\n`
  );
}

/**
 * Counts table reads and table signals from here on. Imported at the call, so a
 * suite that points its home first does not load `scan` before it.
 */
export async function watchTable(
  t: TestContext
): Promise<{ reads(): number; signals(): number }> {
  const scan = await import('../../core/scan');
  const platform = await import('../../core/platform');
  const reads = t.mock.method(scan, 'scanProcesses');
  const signals = t.mock.method(platform.processes, 'signal');
  return { reads: () => reads.mock.callCount(), signals: () => signals.mock.callCount() };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const began = Date.now();
  while (!check()) {
    assert.ok(Date.now() - began < ms, 'the fixture did not reach its state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export type Held = {
  /** Both pids, once the fixture recorded them. */
  pids(): Promise<{ root: number; descendant: number }>;
  /** Ends whatever the record names and waits until both are gone. Idempotent. */
  dispose(): Promise<void>;
};

/**
 * Owns a held fixture's root and descendant from before it is spawned: the
 * teardown is registered here, so a failed start, readiness wait or assertion
 * still ends both and waits for their exit. The fixtures' 20 s caps stay a
 * backstop only.
 */
export function ownHeld(t: TestContext, read: () => Promise<string | undefined>): Held {
  const recorded = async (): Promise<{ root: number; descendant: number } | undefined> => {
    const text = await read();
    if (!text?.includes(' ')) return undefined;
    const [root = 0, descendant = 0] = text.trim().split(' ').map(Number);
    return { root, descendant };
  };
  let disposing: Promise<void> | undefined;
  const held: Held = {
    async pids() {
      const began = Date.now();
      for (;;) {
        const pids = await recorded();
        if (pids) return pids;
        assert.ok(Date.now() - began < 5_000, 'the fixture never recorded its pids');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    dispose() {
      disposing ??= (async () => {
        const pids = await recorded();
        if (!pids) return;
        for (const pid of [pids.descendant, pids.root]) {
          if (!alive(pid)) continue;
          try {
            process.kill(pid);
          } catch {
            // Gone between the check and the kill.
          }
        }
        await until(() => !alive(pids.descendant) && !alive(pids.root));
      })();
      return disposing;
    }
  };
  t.after(() => held.dispose());
  return held;
}
