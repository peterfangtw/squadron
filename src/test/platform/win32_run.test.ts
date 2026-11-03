/**
 * The one-shot reader's production run: every settlement waits for the
 * child's close, and a child whose kill fails is held as unresolved, bounded,
 * rather than reported closed. Real Node children stand in for PowerShell.
 */

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { describe, it } from 'node:test';
import * as run from '../../core/platform/processes/win32_run';

type Seen = { children: ChildProcess[]; closed: Set<ChildProcess>; spawn: run.Spawn };

/** Real spawns, each child's close recorded the moment it fires. */
function spawns(rig: (child: ChildProcess) => void = () => {}): Seen {
  const seen: Seen = {
    children: [],
    closed: new Set(),
    spawn: (file, args, options) => {
      const child = spawn(file, [...args], options);
      child.once('close', () => seen.closed.add(child));
      seen.children.push(child);
      rig(child);
      return child;
    }
  };
  return seen;
}

const node = (code: string): [string, string[]] => [process.execPath, ['-e', code]];
const HOLD = 'setInterval(() => {}, 1000)';

/** The run's result, and whether its child had closed when it settled. */
async function settle(
  seen: Seen,
  promise: Promise<{ stdout: string; stderr: string; code: number }>
): Promise<{ ok?: { stdout: string; code: number }; error?: string; closedAtSettlement: boolean }> {
  try {
    const value = await promise;
    return { ok: { stdout: value.stdout, code: value.code }, closedAtSettlement: allClosed(seen) };
  } catch (error) {
    return { error: (error as Error).message, closedAtSettlement: allClosed(seen) };
  }
}

const allClosed = (seen: Seen) => seen.children.every((child) => seen.closed.has(child));

async function end(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  if (child.pid) process.kill(child.pid, 'SIGKILL');
  await closed;
}

describe('the production one-shot run', () => {
  const bounds = { maxBuffer: 1024, timeoutMs: 400 };

  it('answers a clean exit, and a nonzero one by its code, after close', async () => {
    const seen = spawns();
    const ok = await settle(
      seen,
      run.boundedRun(seen.spawn)(...node("process.stdout.write('hi')"), bounds)
    );
    assert.deepEqual(ok, { ok: { stdout: 'hi', code: 0 }, closedAtSettlement: true });
    const three = await settle(
      seen,
      run.boundedRun(seen.spawn)(...node('process.exit(3)'), bounds)
    );
    assert.deepEqual(three, { ok: { stdout: '', code: 3 }, closedAtSettlement: true });
  });

  it('refuses a missing executable', async () => {
    const seen = spawns();
    const missing = await settle(
      seen,
      run.boundedRun(seen.spawn)(`${process.execPath}-missing-squadron`, [], bounds)
    );
    assert.match(missing.error ?? '', /ENOENT/);
  });

  it('kills on timeout and settles only after the child closed', async () => {
    const seen = spawns();
    const late = await settle(seen, run.boundedRun(seen.spawn)(...node(HOLD), bounds));
    assert.match(late.error ?? '', /timed out/);
    assert.equal(late.closedAtSettlement, true);
  });

  for (const stream of ['stdout', 'stderr'] as const) {
    it(`kills on ${stream} past its buffer and settles only after close`, async () => {
      const seen = spawns();
      const big = await settle(
        seen,
        run.boundedRun(seen.spawn)(
          ...node(`process.${stream}.write('x'.repeat(4096)); ${HOLD}`),
          bounds
        )
      );
      assert.match(big.error ?? '', new RegExp(`${stream}.*exceeds`));
      assert.equal(big.closedAtSettlement, true);
    });
  }

  for (const how of ['false', 'throws'] as const) {
    it(`holds a child whose kill fails (${how}) as unresolved, and starts no other until it closes`, async () => {
      const seen = spawns((child) => {
        child.kill = () => {
          if (how === 'throws') throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
          process.nextTick(() =>
            child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))
          );
          return false;
        };
      });
      const runner = run.boundedRun(seen.spawn, 300);
      try {
        const began = performance.now();
        const stuck = await settle(seen, runner(...node(HOLD), { ...bounds, timeoutMs: 100 }));
        assert.match(stuck.error ?? '', /did not close/);
        assert.equal(stuck.closedAtSettlement, false, 'unresolved, not reported closed');
        assert.ok(performance.now() - began < 3_000, 'bounded');
        const refused = await settle(seen, runner(...node('0'), bounds));
        assert.match(refused.error ?? '', /did not close/);
        assert.equal(seen.children.length, 1, 'no second child while the first is unresolved');
        await end(seen.children[0]);
        await new Promise((resolve) => setImmediate(resolve));
        const after = await settle(seen, runner(...node('0'), bounds));
        assert.deepEqual(after.ok, { stdout: '', code: 0 });
        assert.equal(seen.children.length, 2);
      } finally {
        for (const child of seen.children) await end(child);
      }
    });
  }
});

describe('one-shot admission while a child is ending', () => {
  const bounds = { maxBuffer: 1024, timeoutMs: 100 };
  // A healthy child is never timed out here, however loaded the machine.
  const healthy = { maxBuffer: 1024, timeoutMs: 60_000 };
  /** Kills refused; `onKill` runs at the moment the first ending begins. */
  const refusing = (onKill: () => void = () => {}) =>
    spawns((child) => {
      child.kill = () => {
        onKill();
        onKill = () => {};
        return false;
      };
    });

  it('starts no second child for a request made during the close wait, and recovers after close', async () => {
    let second: Promise<unknown> | undefined;
    const seen = refusing(() => {
      second = settle(seen, runner(...node('0'), bounds));
    });
    const runner = run.boundedRun(seen.spawn, 200);
    try {
      const first = await settle(seen, runner(...node(HOLD), bounds));
      assert.match(first.error ?? '', /kill was refused; powershell did not close/);
      assert.ok(second, 'the second request was made while the first was ending');
      const refused = (await second) as { error?: string };
      assert.match(refused.error ?? '', /did not close; starting no other/);
      assert.equal(seen.children.length, 1, 'no child started during the close wait');
      await end(seen.children[0]);
      await new Promise((resolve) => setImmediate(resolve));
      const after = await settle(seen, runner(...node('0'), healthy));
      assert.deepEqual(after.ok, { stdout: '', code: 0 });
      assert.equal(seen.children.length, 2);
    } finally {
      for (const child of seen.children) await end(child);
    }
  });

  it('admits a concurrent burst one child at a time', async () => {
    let open = 0;
    let most = 0;
    const seen = spawns((child) => {
      open += 1;
      most = Math.max(most, open);
      child.once('close', () => (open -= 1));
    });
    const runner = run.boundedRun(seen.spawn, 200);
    try {
      const burst = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          settle(seen, runner(...node(`process.stdout.write('${n}')`), healthy))
        )
      );
      assert.deepEqual(
        burst.map((one) => one.ok?.stdout),
        ['1', '2', '3', '4']
      );
      assert.equal(most, 1, 'never two children at once');
    } finally {
      for (const child of seen.children) await end(child);
    }
  });

  it('keeps a burst behind a child whose kill was refused to that one child', async () => {
    const seen = refusing();
    const runner = run.boundedRun(seen.spawn, 200);
    try {
      const burst = await Promise.all(
        [0, 1, 2, 3, 4].map(() => settle(seen, runner(...node(HOLD), bounds)))
      );
      assert.equal(seen.children.length, 1);
      for (const one of burst) assert.match(one.error ?? '', /did not close/);
    } finally {
      for (const child of seen.children) await end(child);
    }
  });
});
