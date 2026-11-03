import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, writeJson } from '../helpers';
import { checkSend } from '../../core/coordination/send';
import { SEND_BURST } from '../../core/coordination/guards';
import type { SendAction } from '../../core/coordination/actions';

type Actions = typeof import('../../core/coordination/actions');

let home: string;
let actions: Actions;

const dir = () => path.join(home, '.squadron', 'actions');

before(async () => {
  home = await tempHome();
  actions = await import('../../core/coordination/actions');
});

const send = (over: Partial<SendAction> = {}): SendAction => ({
  schema: 1,
  kind: 'send',
  from: 'session-a',
  toPid: 4242,
  at: 1000,
  requestId: 'req-1',
  ...over
});

async function reset(): Promise<void> {
  await fs.rm(dir(), { recursive: true, force: true });
}

describe('the actions store', () => {
  it('has nothing to say before anything has been sent', async () => {
    await reset();
    assert.deepEqual(await actions.readActions(), []);
  });

  it('round-trips a send', async () => {
    await reset();
    await actions.writeAction(send({ toSessionId: 'session-b' }));

    assert.deepEqual(await actions.readActions(), [
      {
        schema: 1,
        kind: 'send',
        from: 'session-a',
        toPid: 4242,
        toSessionId: 'session-b',
        at: 1000,
        requestId: 'req-1'
      }
    ]);
  });

  // The counters read the whole directory, so two sends in one tick that shared
  // a name would count as one — which is the guard failing open.
  it('keeps both of two sends written in the same millisecond', async () => {
    await reset();
    await Promise.all([
      actions.writeAction(send({ requestId: 'req-1' })),
      actions.writeAction(send({ requestId: 'req-2' }))
    ]);

    const filed = await actions.readActions();
    assert.equal(filed.length, 2);
    assert.deepEqual(filed.map((row) => (row.kind === 'send' ? row.requestId : row.kind)).sort(), [
      'req-1',
      'req-2'
    ]);
    assert.equal((await fs.readdir(dir())).length, 2);
  });

  it('skips a half-written file rather than losing the rest', async () => {
    await reset();
    await actions.writeAction(send());
    await fs.writeFile(path.join(dir(), 'torn.json'), '{"schema":1,"kind":"se');

    const filed = await actions.readActions();
    assert.equal(filed.length, 1);
    assert.equal(filed[0]?.kind === 'send' && filed[0].requestId, 'req-1');
  });

  // A resolution is not a send and is counted with them: §5.7 takes no
  // carve-out, and a guard cannot count what it cannot read. Left out of this
  // read, the wait would be the one path that can wake a session with no
  // counter watching it.
  it('counts a wait resolving alongside the sends', async () => {
    await reset();
    await actions.writeAction(send());
    await actions.writeAction({
      schema: 1,
      kind: 'wait',
      from: 'window-1',
      toPid: 100,
      at: 1
    });

    const filed = await actions.readActions();
    assert.deepEqual(filed.map((row) => row.kind).sort(), ['send', 'wait']);
  });

  // An answer is put on a session's pipe like a message, so the same guards
  // count it — under its own kind, so the directory says what was done.
  it('counts an answer alongside the sends', async () => {
    await reset();
    await actions.writeAction(send());
    await actions.writeAction({
      schema: 1,
      kind: 'answer',
      from: 'session-a',
      toPid: 4242,
      askId: 'req_7',
      at: 1,
      requestId: 'req-2'
    });

    const filed = await actions.readActions();
    assert.deepEqual(filed.map((row) => row.kind).sort(), ['answer', 'send']);
  });

  // A `stop` variant is expected to land in this directory later. The counters
  // are about sends, so the reader states the kind it wants rather than
  // trusting the directory to hold one thing.
  it('leaves a row of another kind to whatever reads that kind', async () => {
    await reset();
    await actions.writeAction(send());
    await writeJson(path.join(dir(), 'stop-1.json'), {
      schema: 1,
      kind: 'stop',
      from: 'session-a',
      toPid: 99,
      at: 2000,
      requestId: 'req-9'
    });

    const filed = await actions.readActions();
    assert.equal(filed.length, 1);
    assert.equal(filed[0]?.kind, 'send');
  });

  it('drops a row with no usable time, which nothing can count', async () => {
    await reset();
    await actions.writeAction(send());
    await writeJson(path.join(dir(), 'undated.json'), {
      schema: 1,
      kind: 'send',
      from: 'session-a',
      toPid: 7,
      requestId: 'req-8'
    });

    assert.equal((await actions.readActions()).length, 1);
  });

  it('reports a write it could not make, and delivers anyway', async () => {
    await reset();
    // A file where the directory has to go: the mkdir fails, and the caller is
    // told without the send being refused for it.
    await fs.mkdir(path.dirname(dir()), { recursive: true });
    await fs.writeFile(dir(), 'not a directory');

    assert.equal(await actions.writeAction(send()), false);
    await fs.rm(dir(), { force: true });
  });
});

/** A target the cost guards pass, so only the burst can answer. */
const warm = (now: number) => ({ pid: 100, updatedAt: now });

describe('window send admission', () => {
  it('serializes checking through recording, including waits and answers', async () => {
    await reset();
    const now = 100_000;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        actions.serializeSends(async () => {
          const verdict = checkSend({
            windowId: 'w1',
            target: warm(now),
            text: 'handoff',
            now,
            actions: await actions.readActions()
          });
          if (!verdict.ok) return false;
          const base = {
            schema: 1 as const,
            windowId: 'w1',
            from: 'session-a',
            toPid: 100 + i,
            at: now
          };
          await actions.writeAction(
            i % 3 === 0
              ? { ...base, kind: 'wait' }
              : i % 3 === 1
                ? { ...base, kind: 'answer', askId: 'ask', requestId: `req-${i}` }
                : { ...base, kind: 'send', requestId: `req-${i}` }
          );
          return true;
        })
      )
    );
    assert.equal(results.filter(Boolean).length, SEND_BURST);
    const filed = await actions.readActions();
    assert.equal(filed.length, SEND_BURST);
    assert.deepEqual(
      checkSend({ windowId: 'w2', target: warm(now), text: 'handoff', now, actions: filed }),
      {
        ok: true
      }
    );
  });

  it('continues accepting work after an operation rejects', async () => {
    await assert.rejects(
      actions.serializeSends(() => Promise.reject(new Error('delivery failed')))
    );
    assert.equal(await actions.serializeSends(() => Promise.resolve('next')), 'next');
  });
});

describe('accepted send accounting under persistence failures', () => {
  it('retains the tenth acceptance after a failed write and refuses the eleventh', async () => {
    await reset();
    const now = Date.now();
    for (let i = 0; i < SEND_BURST - 1; i++) {
      await actions.writeAction(send({ windowId: 'failed-write-window', at: now }));
    }
    await fs.rm(dir(), { recursive: true });
    await fs.writeFile(dir(), 'unwritable store');
    try {
      assert.equal(
        await actions.writeAction(send({ windowId: 'failed-write-window', at: now })),
        false
      );
      const rows = await actions.readActions();
      assert.equal(rows.filter((row) => row.windowId === 'failed-write-window').length, SEND_BURST);
      assert.equal(
        checkSend({
          windowId: 'failed-write-window',
          target: warm(now),
          text: 'eleventh',
          now,
          actions: rows
        }).ok,
        false
      );
      assert.deepEqual(
        checkSend({
          windowId: 'failed-write-window',
          target: warm(now),
          text: 'after expiry',
          now: now + 60_000,
          actions: rows
        }),
        { ok: true }
      );
    } finally {
      await fs.rm(dir(), { force: true });
    }
  });

  it('counts an accepted action once across its memory and file copies', async () => {
    await reset();
    const row = send({ windowId: 'deduplicated-window', at: Date.now() });
    assert.equal(await actions.writeAction(row), true);
    const rows = await actions.readActions();
    assert.equal(rows.filter((one) => one.windowId === 'deduplicated-window').length, 1);
  });
});
