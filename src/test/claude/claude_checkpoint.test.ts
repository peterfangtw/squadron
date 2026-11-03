import * as assert from 'node:assert/strict';

import { execFile } from 'node:child_process';

import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { after, before, describe, it } from 'node:test';

import { promisify } from 'node:util';

import {
  alive,
  claude,
  dispose,
  outbox,
  record,
  setup,
  stub,
  turnStarted
} from './claude_session_helpers';

before(async () => {
  await setup();
});

after(dispose);

/**
 * The handle driving `core/checkpoint.ts`, against a real repository.
 *
 * Nothing else covers the join: `checkpoint.test.ts` drives the lifecycle with
 * no session and `claude_session.test.ts` points every case at a directory in no
 * repository, which is what keeps those cases from staging this whole checkout.
 * The two rules that can only be broken here are the ones below.
 *
 * Every write is through `fs` and never through a frame — that is the feature.
 */
describe('a turn checkpoint on a real tree', () => {
  const run = promisify(execFile);
  /** `GIT_*` stripped, per `src/test/AGENTS.md`: the pre-commit hook exports
   *  `GIT_DIR` and `GIT_INDEX_FILE` at this checkout, and they beat `-C`. */
  const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const litter: string[] = [];

  after(async () => {
    await Promise.all(litter.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  /** The realpath matters: `os.tmpdir()` is a symlink on macOS, and the tree
   *  root a capture reports is the resolved one. */
  async function repo(): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-sess-')));
    litter.push(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(dir, 'kept.txt'), 'a\n');
    await git('add', '-A');
    await git('commit', '-m', 'first');
    return dir;
  }

  /** That conversation's checkpoint, once one has been written for it. Polled
   *  for the same reason `recorded` is: the append queue is private. */
  async function checkpointed(sessionId: string): Promise<Record<string, unknown>> {
    for (let look = 0; look < 200; look++) {
      const raw = await fs.readFile(record.recordFile(sessionId), 'utf8').catch(() => '');
      const note = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.ck);
      if (note) {
        return note.ck as Record<string, unknown>;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('no checkpoint was ever written');
  }

  const changed = (ck: Record<string, unknown>): string[] =>
    (ck.changes as { files: string[] }).files;

  it('claims a write no frame carried, across one turn', async () => {
    const dir = await repo();
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: dir,
      startedAt: 1000,
      sessionId: 'ck-tree-1111-2222-3333-444444444444'
    });
    alive.push(session);
    session.send('write it with sed');
    await outbox(session, 0);

    // The turn, and the write it makes without a frame to its name.
    rig.answer(turnStarted('claude-opus-5'));
    await fs.writeFile(path.join(dir, 'by-shell.txt'), 'one\ntwo\n');
    rig.answer({ type: 'result' });

    const ck = await checkpointed('ck-tree-1111-2222-3333-444444444444');
    assert.deepEqual(changed(ck), [path.join(dir, 'by-shell.txt')]);
  });

  /**
   * The one that was wrong, and the reason a drain holds `capturing` rather
   * than the end edge being unconditional: `close` consumes whatever baseline
   * it finds, so a `running` true→false landing inside the baseline's own
   * window spent the *next* turn's baseline on a span that wrote nothing — and
   * the turn that did the work then found none and skipped.
   */
  it('keeps the baseline a drain is still holding open', async () => {
    const dir = await repo();
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: dir,
      startedAt: 1000,
      sessionId: 'ck-race-1111-2222-3333-444444444444'
    });
    alive.push(session);
    session.send('write it with sed');
    // Inside the baseline's window — `send` returns with the capture in flight,
    // and a real `git add` is tens of ms. A turn that opens and closes here is
    // an `init`, an auto-compaction, or a frame that re-opened the turn.
    rig.answer(turnStarted('claude-opus-5'));
    rig.answer({ type: 'result' });
    await outbox(session, 0);

    // Settled before the write, and it is what makes this deterministic rather
    // than a coin toss. Unguarded, that edge's `close` is queued behind the
    // baseline and runs a capture of its own a few ms later — writing here first
    // let it pick the file up and answer a plausible-looking checkpoint for a
    // window the turn had not started in. Given a quiet tree it answers the
    // empty diff it should, and the turn below finds no baseline at all. 200ms
    // against a 24ms capture.
    await new Promise((settled) => setTimeout(settled, 200));

    rig.answer(turnStarted('claude-opus-5'));
    await fs.writeFile(path.join(dir, 'by-shell.txt'), 'one\ntwo\n');
    rig.answer({ type: 'result' });

    const ck = await checkpointed('ck-race-1111-2222-3333-444444444444');
    assert.deepEqual(changed(ck), [path.join(dir, 'by-shell.txt')]);
  });

  it('captures nothing across a cache-warming ping, even one that wrote', async () => {
    const dir = await repo();
    const rig = stub();
    const id = 'ck-warm-1111-2222-3333-444444444444';
    const session = new claude.OwnedSession(rig.transport, {
      cwd: dir,
      startedAt: 1000,
      sessionId: id
    });
    alive.push(session);
    session.state.contextPct = 10;
    assert.deepEqual(session.warm?.ping(), { ok: true });
    rig.answer(turnStarted('claude-opus-5'));
    await fs.writeFile(path.join(dir, 'by-shell.txt'), 'one\n');
    rig.answer({ type: 'result' });
    // The self-started fallback (`openUnknown`) and the end capture would each
    // land within a 24ms capture; 300ms is the wait for a note that must not come.
    await new Promise((settled) => setTimeout(settled, 300));
    const raw = await fs.readFile(record.recordFile(id), 'utf8').catch(() => '');
    assert.doesNotMatch(raw, /"(ck|ex)":/);
  });
});
