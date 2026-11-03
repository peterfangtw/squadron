import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import type { RecordLine } from '../../core/record';
import type { Baseline } from '../../core/thread';
import { MAX_TURNS, type Authored, type Exchange } from '../../core/transcript';
import { tempHome } from '../helpers';

type ThreadModule = typeof import('../../core/thread');
type Record = typeof import('../../core/record');

let threads: ThreadModule;
let record: Record;
let checkpointRecord: typeof import('../../core/checkpoint_record');

before(async () => {
  // Imported after the home moves: `core/paths.ts` resolves its directories
  // once, at load.
  await tempHome();
  threads = await import('../../core/thread');
  record = await import('../../core/record');
  checkpointRecord = await import('../../core/checkpoint_record');
});

let made = 0;

function open(): InstanceType<ThreadModule['Thread']> {
  made += 1;
  return new threads.Thread({ cwd: '/repo', brand: 'claude' }, `thread-${made}`);
}

const said = (role: Authored['role'], text: string): Authored => ({
  role,
  text,
  blocks: [{ text }]
});

const CK = {
  tree: '/repo',
  from: { tree: 'aaa', at: 100 },
  to: { tree: 'bbb', at: 200 },
  changes: { files: ['/repo/file'], sizes: { '/repo/file': { add: 2, del: 0 } } }
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: () => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: () => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = () => no(new Error('build failed'));
  });
  return { promise, resolve, reject };
}

/** Long enough for the writer to append whatever it is free to. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

/** The record's lines after its header, as written. */
async function written(conversation: string): Promise<unknown[]> {
  const raw = await fs.readFile(record.recordFile(conversation), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .slice(1)
    .map((line) => JSON.parse(line) as unknown);
}

async function writtenPrefix(conversation: string, count: number): Promise<unknown[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const lines = await written(conversation);
    if (lines.length >= count) return lines;
    assert.ok(Date.now() < deadline, 'the record prefix did not finish writing');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const texts = (exchanges: readonly Exchange[]): string[] =>
  exchanges.map((one) => ('text' in one ? one.text : `[${one.mark}]`));

/** Memory and disk agree once the queue is idle — the convergence rule. */
async function converges(thread: InstanceType<ThreadModule['Thread']>): Promise<void> {
  assert.equal(await thread.idle(), true, 'everything queued is on disk');
  const conversation = thread.current.conversation;
  assert.deepEqual(thread.snapshot().history, await record.readRecord(conversation));
}

describe('thread: order is decided at enqueue', () => {
  it('lands a checkpoint that resolves after the next turn on its own turn', async () => {
    const thread = open();
    const at = thread.current;
    const capture = deferred<{ ck: typeof CK }>();
    at.complete('u1', [said('user', 'one')]);
    at.complete('a1', [said('assistant', 'did one')]);
    checkpointRecord.enqueue(at, capture.promise);
    at.complete('u2', [said('user', 'two')]);
    at.complete('a2', [said('assistant', 'did two')]);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), [
      'one',
      'did one',
      'two',
      'did two'
    ]);

    assert.deepEqual(
      await writtenPrefix(at.conversation, 2),
      [said('user', 'one'), said('assistant', 'did one')],
      'no later turn is written past the checkpoint'
    );

    capture.resolve({ ck: CK });
    await converges(thread);
    const { history } = thread.snapshot();
    assert.deepEqual(history.checkpoints.get(history.exchanges[1]!), CK);
    assert.equal(history.checkpoints.get(history.exchanges[3]!), undefined);
  });

  it('draws two pending entries resolving in reverse in ordinal order, and writes them so', async () => {
    const thread = open();
    const at = thread.current;
    const first = deferred<RecordLine[]>();
    const second = deferred<RecordLine[]>();
    at.pending('p1', () => first.promise, [said('user', 'first?')]);
    at.pending('p2', () => second.promise, [said('user', 'second?')]);
    at.complete('a', [said('assistant', 'after both')]);

    second.resolve([said('user', 'second')]);
    await settle();
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['first?', 'second', 'after both']);
    assert.deepEqual(await written(at.conversation), [], 'nothing passes an unresolved head');

    first.resolve([said('user', 'first')]);
    await converges(thread);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['first', 'second', 'after both']);
    assert.deepEqual(
      (await written(at.conversation)).map((line) => (line as Authored).text),
      ['first', 'second', 'after both']
    );
  });

  it('resolves a pending entry to nothing, leaving no trace', async () => {
    const thread = open();
    const at = thread.current;
    at.complete('u', [said('user', 'hello')]);
    at.pending('echo', () => [], [said('user', 'placeholder')]);
    at.complete('a', [said('assistant', 'hi')]);
    await converges(thread);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['hello', 'hi']);
  });

  it('resolves a pending entry to several, in order, under its one slot', async () => {
    const thread = open();
    const at = thread.current;
    const echo = deferred<RecordLine[]>();
    at.pending('echo', () => echo.promise);
    at.complete('a', [said('assistant', 'reply')]);
    echo.resolve([said('user', 'one'), said('user', 'two'), said('user', 'three')]);
    await converges(thread);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['one', 'two', 'three', 'reply']);
  });

  it('drops a rejected entry and writes what follows it', async () => {
    const thread = open();
    const at = thread.current;
    const build = deferred<RecordLine[]>();
    at.pending('lost', () => build.promise, [said('user', 'shown')]);
    at.complete('a', [said('assistant', 'after')]);
    build.reject();
    await converges(thread);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['after']);
    assert.deepEqual(await written(at.conversation), [said('assistant', 'after')]);
  });

  it('draws a merged send at once, and its image refs when the copy lands', async () => {
    const thread = open();
    const at = thread.current;
    const copied = deferred<RecordLine[]>();
    const shown = [said('user', 'look'), { ...said('user', 'and this'), from: 'peer' }];
    at.pending('send', () => copied.promise, shown);
    const sent = thread.snapshot();
    assert.deepEqual(texts(sent.recent.exchanges), ['look', 'and this']);

    const image = { id: 'r|x.png', mediaType: 'image/png', sizeBytes: 3 };
    copied.resolve([{ ...said('user', 'look'), images: [image] }, shown[1]!]);
    await converges(thread);
    const patched = thread.snapshot();
    assert.notEqual(patched.history, sent.history, 'an image patch is a history change');
    assert.deepEqual((patched.recent.exchanges[0] as Authored).images, [image]);
    assert.equal(patched.recent.exchanges.length, 2);
  });
});

describe('thread: the tail', () => {
  it('moves a streaming row into history in the same call that completes it', () => {
    const thread = open();
    const at = thread.current;
    at.stream('m1:0', 'Let me ', 5);
    at.stream('m1:0', 'check.');
    const streaming = thread.snapshot();
    assert.deepEqual(streaming.recent.exchanges, []);
    assert.deepEqual(
      streaming.tail.map((row) => [row.id, row.position, row.exchange.text]),
      [['m1:0', 0, 'Let me check.']]
    );

    at.complete('m1:0', [{ ...said('assistant', 'Let me check.'), m: 'm1' }]);
    const done = thread.snapshot();
    assert.deepEqual(done.tail, []);
    assert.deepEqual(texts(done.recent.exchanges), ['Let me check.']);
  });

  it("keeps Claude's aborted completing frame as the cut row, and a later result adds none", async () => {
    const thread = open();
    const at = thread.current;
    at.stream('m1:0', 'Half a sen');
    at.cut('m1:0', { ...said('assistant', 'Half a sentence'), m: 'm1' } as Authored);
    at.cutOpen(); // the interrupted `result`
    at.end();
    await converges(thread);
    const lines = await written(at.conversation);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { ...said('assistant', 'Half a sentence'), m: 'm1', cut: true });
  });

  it("closes Codex's item from every delta when turn/completed brings no item/completed", async () => {
    const thread = open();
    const at = thread.current;
    at.stream('item-1', 'Reading ', 7);
    at.stream('item-1', 'the files');
    at.cutOpen(); // interrupted turn/completed
    await converges(thread);
    assert.deepEqual(thread.snapshot().tail, []);
    assert.deepEqual(thread.snapshot().recent.exchanges, [
      {
        role: 'assistant',
        text: 'Reading the files',
        blocks: [{ text: 'Reading the files' }],
        at: 7,
        cut: true
      }
    ]);
  });

  it("keeps Grok's chunk after turn_completed on the cut row, written once", async () => {
    const thread = open();
    const at = thread.current;
    at.complete('u1', [said('user', 'go')]);
    at.stream('g1', 'All 118 chars but the last ');
    at.cut('g1', undefined, { late: true }); // turn_completed, cancelled
    at.cut('g1', undefined, { late: true }); // the prompt result: a second close path
    at.complete('u2', [said('user', 'next prompt')]);
    assert.equal(await at.idle(), false, 'the held row is not on disk yet');
    assert.deepEqual(await written(at.conversation), [said('user', 'go')]);
    const closed = thread.snapshot();
    assert.equal(texts(closed.recent.exchanges)[1], 'All 118 chars but the last ');

    at.stream('g1', 'seven.'); // older eventId, no promptId
    const late = thread.snapshot();
    assert.deepEqual(late.tail, [], 'the late chunk never reopens streaming');
    assert.deepEqual(texts(late.recent.exchanges), [
      'go',
      'All 118 chars but the last seven.',
      'next prompt'
    ]);

    at.seal('g1');
    await converges(thread);
    const lines = (await written(at.conversation)) as Authored[];
    assert.deepEqual(
      lines.map((line) => [line.text, line.cut]),
      [
        ['go', undefined],
        ['All 118 chars but the last seven.', true],
        ['next prompt', undefined]
      ]
    );
    at.stream('g1', ' too late');
    assert.equal(thread.snapshot(), thread.snapshot());
    assert.equal(texts(thread.snapshot().recent.exchanges)[1], 'All 118 chars but the last seven.');
  });

  it('answers whether a row took late text, and opens none for it', () => {
    // The one owner of the late deadline: the brand routes text of a stream it
    // closed to that row, and the row says whether it was still taking it.
    const thread = open();
    const at = thread.current;
    at.stream('g1', 'cut ');
    at.cut('g1', undefined, { late: true });
    assert.equal(at.stream('g1', 'late', undefined, { late: true }), true);
    at.seal('g1');
    assert.equal(at.stream('g1', ' sealed', undefined, { late: true }), false);
    assert.equal(at.stream('gone', 'nobody', undefined, { late: true }), false, 'no row opened');
    assert.deepEqual(thread.snapshot().tail, []);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['cut late']);
  });

  it('writes a cancelled row within its late bound when no closer seals it', async () => {
    const thread = new threads.Thread({ cwd: '/repo', brand: 'grok' }, 'thread-late-bound', {
      lateMs: 30
    });
    const at = thread.current;
    at.stream('g1', 'All but ');
    at.cut('g1', undefined, { late: true }); // turn_completed, cancelled
    at.stream('g1', 'the last.'); // the chunk after it
    at.cut('g1', undefined, { late: true }); // prompt_complete
    at.cut('g1', undefined, { late: true }); // the session/prompt result
    assert.equal(await at.idle(), false, 'held until its bound');
    assert.deepEqual(await written(at.conversation), [], 'nothing on disk yet');

    for (let wait = 0; wait < 100 && !(await at.idle()); wait++) await settle();
    assert.equal(await at.idle(), true, 'sealed with no further prompt');
    assert.deepEqual(await written(at.conversation), [
      { ...said('assistant', 'All but the last.'), cut: true }
    ]);
    at.stream('g1', ' too late');
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['All but the last.']);
    await converges(thread);
  });

  it('draws a held line at once and writes its last restatement, once, at its seal', async () => {
    const thread = new threads.Thread({ cwd: '/repo', brand: 'grok' }, 'thread-hold', {
      lateMs: 30
    });
    const at = thread.current;
    at.hold('alarm', [said('cli', 'The turn ended with an error.')]);
    at.complete('after', [said('user', 'next')]);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), [
      'The turn ended with an error.',
      'next'
    ]);
    assert.equal(await at.idle(), false, 'held, and the row behind it with it');
    at.hold('alarm', [said('cli', 'API error (status 402)')]);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['API error (status 402)', 'next']);
    at.seal('alarm');
    at.hold('alarm', [said('cli', 'after the seal')]);
    await converges(thread);
    assert.deepEqual(await written(at.conversation), [
      said('cli', 'API error (status 402)'),
      said('user', 'next')
    ]);

    const unsealed = thread.current;
    unsealed.hold('alarm 2', [said('cli', 'nobody seals this')]);
    for (let wait = 0; wait < 100 && !(await unsealed.idle()); wait++) await settle();
    assert.equal(await unsealed.idle(), true, 'written at its bound');
  });

  it('keeps text buffered after a kill, closing it when stdout closes', async () => {
    const thread = open();
    const at = thread.current;
    at.stream('m1:0', 'Before the kill, ');
    // SIGKILL sent; the process exits, and stdout still drains a delta.
    at.stream('m1:0', 'and after it.');
    at.end(); // stdout close
    await converges(thread);
    assert.deepEqual(await written(at.conversation), [
      { ...said('assistant', 'Before the kill, and after it.'), cut: true }
    ]);
  });

  describe('cut off on each terminal path', () => {
    const paths: [string, (thread: InstanceType<ThreadModule['Thread']>) => void][] = [
      ['an error', (thread) => thread.current.cutOpen()],
      ['the transport closing', (thread) => thread.current.end()],
      [
        'Send now',
        (thread) => {
          thread.current.cutOpen();
          thread.current.complete('send', [said('user', 'now')]);
        }
      ],
      ['/clear', (thread) => void thread.reset()]
    ];
    for (const [name, close] of paths) {
      it(name, async () => {
        const thread = open();
        const before = thread.current;
        before.stream('row', 'partial');
        close(thread);
        assert.deepEqual(before.snapshot().tail, [], 'nothing is left streaming');
        before.stream('row', ' more');
        assert.equal(await thread.idle(), true);
        const lines = (await written(before.conversation)) as Authored[];
        assert.deepEqual(lines[0], { ...said('assistant', 'partial'), cut: true });
        assert.equal(lines.filter((line) => line.cut).length, 1, 'one copy, however it closed');
      });
    }
  });

  it('never makes a second copy from duplicate terminal paths', async () => {
    const thread = open();
    const at = thread.current;
    at.stream('a', 'done');
    at.complete('a', [said('assistant', 'done')]);
    at.stream('b', 'cut');
    at.cutOpen();
    at.cutOpen();
    at.cut('b');
    at.cut('a');
    at.end();
    at.end();
    await converges(thread);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['done', 'cut']);
    assert.equal((await written(at.conversation)).length, 2);
  });
});

describe('thread: generations', () => {
  it('routes a pre-clear write to the old conversation and starts the new one empty', async () => {
    const thread = open();
    const old = thread.current;
    const capture = deferred<{ ck: typeof CK }>();
    old.complete('u', [said('user', 'before')]);
    old.complete('a', [said('assistant', 'reply')]);
    checkpointRecord.enqueue(old, capture.promise);
    old.stream('tail', 'cut by the clear');

    thread.reset();
    const fresh = thread.begin('thread-after-clear');
    assert.notEqual(fresh, old);
    assert.equal(fresh.generation, old.generation + 1);
    assert.deepEqual(thread.snapshot().recent.exchanges, []);
    assert.deepEqual(thread.snapshot().tail, []);
    fresh.complete('u', [said('user', 'after')]);

    capture.resolve({ ck: CK });
    assert.equal(await thread.idle(), true);
    const oldHistory = old.snapshot().history;
    assert.deepEqual(oldHistory, await record.readRecord(old.conversation));
    assert.deepEqual(oldHistory.checkpoints.get(oldHistory.exchanges[1]!), CK);
    assert.deepEqual(texts(oldHistory.exchanges), ['before', 'reply', 'cut by the clear']);
    assert.deepEqual(await written('thread-after-clear'), [said('user', 'after')]);
    await converges(thread);
  });

  it('answers for a generation begun while it waited', async () => {
    const thread = open();
    const old = thread.current;
    const capture = deferred<RecordLine[]>();
    old.pending('ck', () => capture.promise);
    const waiting = thread.idle();
    thread.reset();
    const fresh = thread.begin('thread-begun-while-idle-waited');
    fresh.stream('open', 'still streaming');
    capture.resolve([]);
    assert.equal(await waiting, false, 'the new generation has a row still open');
    assert.equal(await fresh.idle(), false);
    fresh.complete('open', [said('assistant', 'still streaming')]);
    assert.equal(await thread.idle(), true);
  });

  it('keeps the conversation through an id change no reset announced', async () => {
    // Only a reset starts a generation. An id the CLI changed without one is
    // the same conversation, filed under the new id from here.
    const logged: string[] = [];
    const thread = new threads.Thread({ cwd: '/repo', brand: 'claude' }, 'thread-forked-from', {
      log: (line) => logged.push(line)
    });
    const was = thread.current;
    was.complete('u', [said('user', 'before')]);
    assert.equal(await thread.idle(), true);
    assert.equal(thread.begin('thread-forked-to'), was, 'the same conversation');
    const shot = thread.snapshot();
    assert.equal(shot.generation, 0);
    assert.equal(shot.conversation, 'thread-forked-to');
    assert.deepEqual(texts(shot.recent.exchanges), ['before'], 'its history stays drawn');
    was.complete('a', [said('assistant', 'after')]);
    assert.equal(await thread.idle(), true);
    assert.deepEqual(await written('thread-forked-from'), [said('user', 'before')]);
    assert.deepEqual(await written('thread-forked-to'), [said('assistant', 'after')]);
    assert.equal(logged.length, 1, 'and says so');
  });

  it('holds lines until a conversation with no id yet is named', async () => {
    const thread = new threads.Thread({ brand: 'grok' });
    thread.current.complete('u', [said('user', 'early')]);
    assert.equal(await thread.idle(), false);
    thread.begin('thread-named-late');
    await converges(thread);
    assert.deepEqual(await written('thread-named-late'), [said('user', 'early')]);
  });
});

describe('thread: identity', () => {
  it('hands back the same snapshot until something changes', () => {
    const thread = open();
    const at = thread.current;
    at.complete('u', [said('user', 'hi')]);
    const first = thread.snapshot();
    assert.equal(thread.snapshot(), first);
    at.complete('u', [said('user', 'hi')]);
    at.stream('m:0', '');
    const opened = thread.snapshot();
    assert.equal(opened.history, first.history, 'opening a tail leaves history alone');
    at.stream('m:0', '');
    assert.equal(thread.snapshot(), opened, 'an empty delta is a no-op');
  });

  it('keeps history across tail deltas and replaces it on every history change', async () => {
    const thread = open();
    const at = thread.current;
    at.complete('a', [
      { role: 'assistant', text: '', blocks: [{ call: { id: 'call-1', name: 'Bash' } }] }
    ]);
    const base = thread.snapshot();
    at.stream('m:1', 'one');
    const delta = thread.snapshot();
    at.stream('m:1', ' two');
    const more = thread.snapshot();
    assert.notEqual(delta, base);
    assert.notEqual(more, delta);
    assert.equal(delta.history, base.history);
    assert.equal(more.history, base.history);

    at.note([{ ret: [{ id: 'call-1', output: 'ok' }] }]);
    const returned = thread.snapshot();
    assert.notEqual(returned.history, more.history, 'a ret');
    assert.equal(more.history.exchanges[0], base.history.exchanges[0], 'earlier snapshot intact');

    at.complete('m:1', [said('assistant', 'one two')]);
    at.note([{ ck: CK }]);
    const checked = thread.snapshot();
    assert.notEqual(checked.history, returned.history, 'a checkpoint');
    await converges(thread);
  });

  it('keeps history across notes that change nothing drawn', async () => {
    const thread = open();
    const at = thread.current;
    at.complete('a', [
      {
        role: 'assistant',
        text: '',
        blocks: [{ call: { id: 'call-1', name: 'Bash' } }],
        m: 'msg-1'
      }
    ]);
    const unchanged = (why: string, change: () => void): void => {
      const before = thread.snapshot();
      change();
      const after = thread.snapshot();
      assert.equal(after.history, before.history, why);
      assert.equal(after.recent, before.recent, why);
    };
    unchanged('an unknown call', () => at.note([{ ret: [{ id: 'never-seen', output: 'x' }] }]));
    at.note([{ ret: [{ id: 'call-1', output: 'ok' }] }]);
    unchanged('the same result again', () => at.note([{ ret: [{ id: 'call-1', output: 'ok' }] }]));
    unchanged('a witness already seen', () => at.note([{ m: 'msg-1' }]));
    at.note([{ ck: CK }]);
    unchanged('the same checkpoint again', () => at.note([{ ck: CK }]));
    at.complete('u', [said('user', 'next')]);
    unchanged('a checkpoint with no turn to land on', () => at.note([{ ck: CK }]));

    at.stream('m:9', 'open');
    unchanged('an unknown call past a streaming row', () =>
      at.note([{ ret: [{ id: 'never-seen', output: 'y' }] }])
    );
    at.complete('m:9', [said('assistant', 'open')]);
    await converges(thread);
  });

  it('refuses to change a row the writer already has', async () => {
    const thread = open();
    const at = thread.current;
    at.complete('a', [said('assistant', 'final')]);
    await thread.idle();
    const settled = thread.snapshot();
    at.complete('a', [said('assistant', 'rewritten')]);
    assert.equal(thread.snapshot(), settled);
    await converges(thread);
  });
});

describe('thread: change notice', () => {
  /** How many notices `act` raised, and whether the snapshot moved with them. */
  function notices(
    thread: InstanceType<ThreadModule['Thread']>,
    act: () => void
  ): { told: number; moved: boolean } {
    let told = 0;
    const stop = thread.onChange(() => told++);
    const was = thread.snapshot();
    act();
    stop();
    return { told, moved: thread.snapshot() !== was };
  }

  it('says every change a refresh could draw, as it happens', async () => {
    const thread = open();
    const at = thread.current;
    for (const [what, act] of [
      ['a delta', () => at.stream('r1', 'Hel')],
      ['the next delta', () => at.stream('r1', 'lo')],
      ['the completing line', () => at.complete('r1', [said('assistant', 'Hello')])],
      ['a note', () => at.note([{ mark: 'break' }])],
      ['a send drawn at once', () => at.pending('s1', () => [], [said('user', 'next')])]
    ] as const) {
      const { told, moved } = notices(thread, act);
      assert.ok(told > 0, `${what} is said`);
      assert.ok(moved, `${what} moves the snapshot`);
    }
    // A build resolving lands after the call that queued it.
    let told = 0;
    thread.onChange(() => told++);
    await thread.idle();
    assert.ok(told > 0, 'a resolved send is said');
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['Hello', '[break]']);
  });

  it('says a /clear, and nothing a retired conversation writes after it', async () => {
    const thread = open();
    const old = thread.current;
    old.stream('r1', 'before');
    assert.ok(notices(thread, () => thread.reset()).told > 0, 'the reset is said');
    assert.ok(notices(thread, () => thread.begin('after-clear')).told > 0, 'the new id is said');
    const late = notices(thread, () => old.note([{ mark: 'break' }]));
    assert.deepEqual(late, { told: 0, moved: false });
    await thread.idle();
  });

  it('stops saying once a listener lets go', () => {
    const thread = open();
    let told = 0;
    thread.onChange(() => told++)();
    thread.current.stream('r1', 'quiet');
    assert.equal(told, 0);
  });
});

describe('thread: trim', () => {
  it('trims past twice MAX_TURNS, keeping what is drawn and truncated from then on', async () => {
    const thread = open();
    const at = thread.current;
    for (let turn = 0; turn <= 2 * MAX_TURNS; turn++) {
      at.complete(`t${turn}`, [said(turn % 2 ? 'assistant' : 'user', `turn ${turn}`)]);
      if (turn === 2 * MAX_TURNS - 1) {
        assert.equal(thread.snapshot().history.exchanges.length, 2 * MAX_TURNS, 'not yet');
      }
    }
    const trimmed = thread.snapshot();
    assert.equal(trimmed.history.exchanges.length, MAX_TURNS);
    assert.equal(trimmed.recent.exchanges.length, MAX_TURNS);
    assert.equal(trimmed.recent.truncated, true, 'cumulative: the cap alone would say false');
    assert.equal(texts(trimmed.recent.exchanges)[0], `turn ${MAX_TURNS + 1}`);

    assert.equal(await thread.idle(), true);
    const disk = await record.readRecord(at.conversation);
    assert.equal(disk?.exchanges.length, 2 * MAX_TURNS + 1, 'the record is not trimmed');
    assert.deepEqual(trimmed.recent, record.drawable(disk, record.NO_WITNESS, false));

    at.stream('next', 'streaming');
    assert.equal(thread.snapshot().tail[0]?.position, MAX_TURNS);
  });

  it('retains ten complete user turns even when their activity exceeds the row cap', async () => {
    const thread = open();
    const at = thread.current;
    for (let user = 0; user < 11; user++) {
      at.complete(`user-${user}`, [said('user', `prompt ${user}`)]);
      for (let row = 0; row < 85; row++)
        at.complete(`reply-${user}-${row}`, [said('assistant', `reply ${user}.${row}`)]);
    }
    const shot = thread.snapshot();
    assert.ok(texts(shot.recent.exchanges).includes('prompt 1'));
    assert.ok(texts(shot.recent.exchanges).includes('reply 1.0'));
    assert.ok(texts(shot.recent.exchanges).includes('reply 10.84'));
    assert.equal(await thread.idle(), true);
    const baseline = await threads.readBaseline(at.conversation, () =>
      Promise.resolve({
        recent: { exchanges: [], truncated: false },
        witnessed: record.NO_WITNESS,
        order: []
      })
    );
    const recovered = open();
    await recovered.current.recover(() => Promise.resolve(baseline));
    assert.ok(texts(recovered.snapshot().recent.exchanges).includes('prompt 1'));
  });

  // A held cut row heads the queue, so every row behind it is still queued when
  // the trim runs; trimming it would strand its late text and the queue.
  for (const close of ['seal', 'end'] as const) {
    it(`keeps a held cut row through the trim, and its late text reaches disk on ${close}`, async () => {
      const thread = open();
      const at = thread.current;
      at.stream('g1', 'cut ');
      at.cut('g1', undefined, { late: true });
      for (let turn = 0; turn <= 2 * MAX_TURNS; turn++) {
        at.complete(`t${turn}`, [said(turn % 2 ? 'assistant' : 'user', `turn ${turn}`)]);
      }
      thread.snapshot();
      at.stream('g1', 'late');
      assert.ok(
        texts(thread.snapshot().history.exchanges).includes('cut late'),
        'the late text is drawn'
      );
      if (close === 'seal') at.seal('g1');
      else at.end();
      assert.equal(await thread.idle(), true, 'the queue drains past the sealed row');
      const lines = (await written(at.conversation)) as Authored[];
      assert.equal(lines.length, 2 * MAX_TURNS + 2);
      assert.deepEqual(lines[0], { ...said('assistant', 'cut late'), cut: true });
    });
  }
});

describe('thread: recovery', () => {
  it('places the baseline before rows that arrived while it was read, once', async () => {
    const thread = open();
    const at = thread.current;
    await record.appendLine(at.conversation, said('user', 'old prompt'));
    await record.appendLine(at.conversation, said('assistant', 'old reply'));
    const cached = await record.readRecord(at.conversation);
    assert.equal(await record.readRecord(at.conversation), cached);

    const read = deferred<Baseline>();
    const failed = at.recover(() => Promise.reject(new Error('EMFILE')));
    at.complete('u', [said('user', 'new prompt')]); // a replay ahead of the read
    await assert.rejects(failed);
    const recovering = at.recover(() => read.promise);
    at.stream('m:0', 'new');
    await settle();
    assert.equal(
      (await written(at.conversation)).length,
      2,
      'nothing is appended while the baseline may still read it'
    );
    read.resolve({
      lines: [said('user', 'old prompt'), said('assistant', 'old reply')],
      partial: false,
      ours: true
    });
    await recovering;

    const shot = thread.snapshot();
    assert.deepEqual(texts(shot.recent.exchanges), ['old prompt', 'old reply', 'new prompt']);
    assert.equal(shot.tail[0]?.position, 3);
    assert.notEqual(await record.readRecord(at.conversation), cached, 'the cached reading went');
    at.complete('m:0', [said('assistant', 'new reply')]);
    await converges(thread);
  });
});

describe('thread: a row a later frame settles', () => {
  it('is drawn at once, holds the queue without holding idle, and settles once', async () => {
    const thread = open();
    const at = thread.current;
    const settle = at.awaiting('send', [said('user', 'sent')]);
    at.complete('reply', [said('assistant', 'answer')]);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['sent', 'answer']);
    assert.equal(await thread.idle(), false, 'open, as a stream is: answered, not waited on');
    assert.equal(await record.readRecord(thread.current.conversation), undefined);
    settle([{ ...said('user', 'sent'), m: 'echo' }]);
    settle([]);
    assert.equal(await thread.idle(), true);
    const disk = await record.readRecord(thread.current.conversation);
    assert.deepEqual(texts(disk?.exchanges ?? []), ['sent', 'answer']);
    assert.deepEqual(thread.snapshot().history.exchanges, disk?.exchanges);
  });
});

describe('thread: the baseline a resume recovers', () => {
  /** The brand's own history: these exchanges, witnessing these keys, each
   *  key's exchange opening at the row `from` names (its own index if not). */
  const theirs =
    (
      keys: readonly string[],
      exchanges: Exchange[] = [],
      truncated = false,
      from: readonly number[] = keys.map((_, at) => at)
    ) =>
    () =>
      Promise.resolve({
        recent: { exchanges, truncated },
        witnessed: new Set(keys),
        order: keys.map((key, at) => ({ key, from: from[at] ?? 0 }))
      });

  async function recorded(conversation: string, lines: RecordLine[]): Promise<void> {
    for (const line of lines) await record.appendLine(conversation, line);
  }

  it('is our record, lines as written, when it witnessed everything the brand did', async () => {
    const lines: RecordLine[] = [
      said('user', 'asked'),
      { ...said('assistant', 'ours'), m: 'msg_1' }
    ];
    await recorded('base-ours', lines);
    const baseline = await threads.readBaseline('base-ours', theirs(['msg_1']));
    assert.deepEqual(baseline, { lines, partial: false, ours: true });
  });

  it('is our record and the turns it missed when they all came after it', async () => {
    const lines: RecordLine[] = [{ ...said('assistant', 'ours'), m: 'msg_1' }];
    await recorded('base-tail', lines);
    const cli = [said('assistant', 'one'), said('user', 'typed'), said('assistant', 'outside')];
    const baseline = await threads.readBaseline(
      'base-tail',
      theirs(['msg_1', 'msg_outside'], cli, false, [0, 1])
    );
    assert.deepEqual(baseline, {
      lines,
      missing: [{ m: 'msg_outside' }, said('user', 'typed'), said('assistant', 'outside')],
      partial: false,
      ours: true
    });
  });

  it("is the brand's history when a turn it missed came before one it shares", async () => {
    await recorded('base-theirs', [{ ...said('assistant', 'ours'), m: 'msg_1' }]);
    const cli = [said('assistant', 'outside'), said('assistant', 'one')];
    const baseline = await threads.readBaseline(
      'base-theirs',
      theirs(['msg_outside', 'msg_1'], cli)
    );
    assert.deepEqual(baseline, { lines: cli, partial: false, ours: false });
  });

  it("is the brand's history when our record is missing or refused", async () => {
    const cli = [said('user', 'theirs')];
    assert.deepEqual(await threads.readBaseline('base-missing', theirs([], cli)), {
      lines: cli,
      partial: false,
      ours: false
    });
    const file = record.recordFile('base-refused');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ v: record.SCHEMA + 1, sessionId: 'x' })}\n`);
    assert.equal((await threads.readBaseline('base-refused', theirs([], cli))).ours, false);
  });

  it("keeps drawable's floor: no further back than a bound read is evidence for", async () => {
    const lines: RecordLine[] = [
      said('user', 'asked'),
      { ...said('assistant', 'zero'), m: 'msg_0' },
      { ...said('assistant', 'one'), m: 'msg_1' },
      { ck: CK },
      { ...said('assistant', 'two'), m: 'msg_2' },
      { ...said('assistant', 'three'), m: 'msg_3' }
    ];
    await recorded('base-floor', lines);
    const witnessed = theirs(['msg_2', 'msg_3'], [], true);
    const baseline = await threads.readBaseline('base-floor', witnessed);
    assert.equal(baseline.ours, true);
    assert.equal(baseline.partial, true);
    assert.deepEqual(baseline.lines, lines.slice(4), 'cut keeps only notes whose owner remains');
    const drawn = record.drawable(
      await record.readRecord('base-floor'),
      (await witnessed()).witnessed,
      true
    );
    assert.deepEqual(texts(drawn?.exchanges ?? []), ['two', 'three']);

    const thread = open();
    await thread.current.recover(() => Promise.resolve(baseline));
    const shot = thread.snapshot();
    assert.deepEqual(shot.recent, drawn, 'memory draws what drawable draws');
    assert.equal(shot.history.checkpoints.size, 0, "a cut turn's checkpoint finds no turn");
  });

  describe('after the conversation went on in a terminal', () => {
    const ASK = {
      questions: [{ question: 'Which way?', multiSelect: false, options: [{ label: 'Left' }] }],
      answers: { 'Which way?': 'Left' },
      annotations: {}
    };
    /** Ours: an answered ask and its checkpoint, an image prompt, a cut
     *  reply — what the brand's history cannot hold. */
    const ours: RecordLine[] = [
      said('user', 'asked'),
      {
        role: 'assistant',
        text: 'ours',
        blocks: [{ text: 'ours' }, { call: { id: 'ask-1', name: 'AskUserQuestion' } }],
        m: 'm1'
      },
      { ret: [{ id: 'ask-1', ask: ASK }] },
      { ck: CK },
      { ...said('user', 'look'), images: [{ id: 'r|img-1' }] },
      { ...said('assistant', 'seen'), m: 'm2' },
      { ...said('assistant', 'cut before'), cut: true }
    ];
    /** Theirs: what we saw, then two turns typed at the terminal (`m3`). */
    const cli = [
      said('user', 'asked'),
      said('assistant', 'one'),
      said('user', 'look'),
      said('assistant', 'seen'),
      said('user', 'typed'),
      said('assistant', 'answered there')
    ];
    const tail = (truncated = false) => theirs(['m1', 'm2', 'm3'], cli, truncated, [0, 2, 4]);
    const drawn = ['asked', 'ours', 'look', 'seen', 'cut before', 'typed', 'answered there'];

    async function resume(
      conversation: string,
      history: Parameters<ThreadModule['readBaseline']>[1]
    ): Promise<InstanceType<ThreadModule['Thread']>> {
      const thread = new threads.Thread({ cwd: '/repo', brand: 'grok' }, conversation);
      await thread.current.recover(() => threads.readBaseline(conversation, history));
      return thread;
    }

    it('appends the turns it missed to our record, keeping every row of ours', async () => {
      await recorded('tail-keeps', ours);
      const before = await fs.readFile(record.recordFile('tail-keeps'), 'utf8');
      const thread = await resume('tail-keeps', tail());
      const shot = thread.snapshot();
      assert.deepEqual(texts(shot.recent.exchanges), drawn);
      assert.equal(shot.reconstructed, undefined, 'ours, and said to be');
      assert.equal(shot.history.checkpoints.size, 1, 'the checkpoint');
      const turn = shot.history.exchanges[1];
      const block = turn && 'blocks' in turn ? turn.blocks?.[1] : undefined;
      assert.deepEqual(block && 'call' in block ? block.call.ask : undefined, ASK, 'the ask');
      const look = shot.history.exchanges[2];
      assert.deepEqual(look && 'images' in look ? look.images : undefined, [{ id: 'r|img-1' }]);
      const cut = shot.history.exchanges[4];
      assert.equal(cut && 'cut' in cut ? cut.cut : undefined, true, 'the cut reply');

      await converges(thread);
      const after = await fs.readFile(record.recordFile('tail-keeps'), 'utf8');
      assert.ok(after.startsWith(before), 'nothing of ours is rewritten');
      assert.deepEqual(
        after
          .slice(before.length)
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown),
        [{ m: 'm3' }, said('user', 'typed'), said('assistant', 'answered there')],
        'the missed turns, behind their witness key'
      );
    });

    it('draws our record on the next resume, with no notice', async () => {
      await recorded('tail-again', ours);
      await converges(await resume('tail-again', tail()));
      const again = await resume('tail-again', tail());
      const shot = again.snapshot();
      assert.deepEqual(texts(shot.recent.exchanges), drawn);
      assert.equal(shot.reconstructed, undefined);
      await converges(again);
    });

    for (const [name, keys, from] of [
      ['a missed turn before one we share', ['m0', 'm1', 'm2', 'm3'], [0, 0, 2, 4]],
      ['no turn shared', ['m8', 'm9'], [0, 4]]
    ] as const) {
      it(`draws the brand's history and leaves our record as it was, for ${name}`, async () => {
        const conversation = `tail-not-${keys.length}`;
        await recorded(conversation, ours);
        const before = await fs.readFile(record.recordFile(conversation), 'utf8');
        const thread = await resume(conversation, theirs(keys, cli, false, from));
        const shot = thread.snapshot();
        assert.deepEqual(texts(shot.recent.exchanges), texts(cli));
        assert.equal(shot.reconstructed, true);
        assert.equal(await thread.idle(), true);
        assert.equal(await fs.readFile(record.recordFile(conversation), 'utf8'), before);
      });
    }

    // The brand's history never holds a cut reply (Step 2), so a cut row our
    // record took after a resume is the only copy of those words. A truncated
    // read draws from its floor, so memory is the record's tail, not all of it.
    for (const truncated of [false, true]) {
      it(`keeps a cut row written after the append through the next resume${truncated ? ', truncated' : ''}`, async () => {
        const conversation = `tail-cut-${truncated}`;
        await recorded(conversation, ours);
        const settles = async (thread: InstanceType<ThreadModule['Thread']>) =>
          truncated ? assert.equal(await thread.idle(), true) : converges(thread);
        const first = await resume(conversation, tail(truncated));
        first.current.stream('g1', 'cut short');
        first.current.cutOpen();
        await settles(first);

        const second = await resume(conversation, tail(truncated));
        const shot = second.snapshot();
        assert.deepEqual(texts(shot.recent.exchanges).slice(-3), [
          'typed',
          'answered there',
          'cut short'
        ]);
        assert.equal(shot.reconstructed, undefined);
        assert.equal(shot.recent.truncated, truncated);
        await settles(second);
      });
    }

    it('loses a cut row written after a fallback, which redraws the history', async () => {
      // Accepted: our record keeps the row on disk, but stays undrawable
      // while the history holds a turn it missed among its own.
      const conversation = 'tail-not-cut';
      await recorded(conversation, ours);
      const interleaved = theirs(['m0', 'm1', 'm2'], cli, false, [0, 0, 2]);
      const first = await resume(conversation, interleaved);
      first.current.stream('g1', 'cut short');
      first.current.cutOpen();
      assert.equal(await first.idle(), true);
      const second = await resume(conversation, interleaved);
      assert.deepEqual(texts(second.snapshot().recent.exchanges), texts(cli));
    });
  });

  it('leaves a record this build refuses as it was, recovering the history in memory', async () => {
    const file = record.recordFile('base-future');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const future = `${JSON.stringify({ v: record.SCHEMA + 1, sessionId: 'base-future' })}\n{"z":1}\n`;
    await fs.writeFile(file, future);
    const thread = new threads.Thread({ cwd: '/repo', brand: 'grok' }, 'base-future');
    await thread.current.recover(() =>
      threads.readBaseline('base-future', theirs(['m1'], [said('user', 'theirs')]))
    );
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['theirs']);
    assert.equal(await fs.readFile(file, 'utf8'), future);
  });

  it('throws when the record is there and cannot be read', async () => {
    await fs.mkdir(record.recordFile('base-unreadable'), { recursive: true });
    await assert.rejects(threads.readBaseline('base-unreadable', theirs([])));
  });

  it("says a baseline from the brand's history is a reconstruction", async () => {
    const thread = open();
    await thread.current.recover(() =>
      Promise.resolve({ lines: [said('user', 'theirs')], partial: false, ours: false })
    );
    assert.equal(thread.snapshot().reconstructed, true);
    const ours = open();
    await ours.current.recover(() =>
      Promise.resolve({ lines: [said('user', 'ours')], partial: false, ours: true })
    );
    assert.equal(ours.snapshot().reconstructed, undefined);
  });
});

describe('thread: recovering through failures', () => {
  const baseline = { lines: [said('user', 'before')], partial: false, ours: true };

  it('retries a transient failure and lands the baseline once', async () => {
    const thread = open();
    const at = thread.current;
    let reads = 0;
    const recovering = threads.recoverBaseline(
      at,
      () => (++reads < 3 ? Promise.reject(new Error('EMFILE')) : Promise.resolve(baseline)),
      { retryMs: [1, 1, 1] }
    );
    at.complete('u', [said('user', 'after')]);
    await recovering;
    assert.equal(reads, 3);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['before', 'after']);
    await thread.idle();
    assert.deepEqual(await written(at.conversation), [said('user', 'after')]);
  });

  it('gives up after its last wait, empty, and releases the queue', async () => {
    const thread = open();
    const at = thread.current;
    const logged: string[] = [];
    at.complete('u', [said('user', 'after')]);
    await threads.recoverBaseline(at, () => Promise.reject(new Error('EACCES')), {
      retryMs: [1],
      log: (line) => logged.push(line)
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? '', /2 reads \(EACCES\)/);
    assert.deepEqual(texts(thread.snapshot().recent.exchanges), ['after']);
    assert.equal(await thread.idle(), true, 'the queue is not held behind a read that never lands');
  });

  it('stops retrying once the session is gone', async () => {
    const at = open().current;
    let reads = 0;
    const started = Date.now();
    await threads.recoverBaseline(
      at,
      () => {
        reads++;
        return Promise.reject(new Error('closed'));
      },
      { retryMs: [60_000], stopped: () => true }
    );
    assert.equal(reads, 1);
    assert.ok(Date.now() - started < 30_000, 'no wait is spent on a closed session');
  });

  it('reads nothing for a fresh conversation, and holds nothing', async () => {
    const thread = open();
    await threads.recoverBaseline(thread.current, undefined);
    thread.current.complete('u', [said('user', 'first')]);
    assert.equal(await thread.idle(), true);
    assert.deepEqual(await written(thread.current.conversation), [said('user', 'first')]);
  });
});

describe('thread: convergence', () => {
  it('equals readRecord of the written file once the queue is idle', async () => {
    const thread = open();
    const at = thread.current;
    const copy = deferred<RecordLine[]>();
    const capture = deferred<RecordLine[]>();
    at.pending('send', () => copy.promise, [said('user', 'run it')]);
    at.complete('w', [{ m: 'msg-0' }]);
    at.stream('msg-1:0', 'Running');
    at.complete('msg-1:0', [{ ...said('assistant', 'Running'), m: 'msg-1' }]);
    at.complete('msg-1:1', [
      {
        role: 'assistant',
        text: '',
        blocks: [{ call: { id: 'call-1', name: 'Bash', input: { command: 'ls' } } }],
        m: 'msg-1'
      }
    ]);
    at.note([{ ret: [{ id: 'call-1', output: 'a\nb' }] }]);
    at.complete('skill', [{ mark: 'skill', skill: 'review', by: 'agent' }]);
    at.stream('msg-2:0', 'Then I was cut');
    at.cutOpen();
    at.pending('ck', () => capture.promise);
    at.complete('readout', [
      { role: 'cli', local: true, text: '/cost', blocks: [{ text: '/cost' }], at: undefined }
    ]);
    capture.resolve([{ ck: CK }]);
    copy.resolve([{ ...said('user', 'run it'), at: 1, images: undefined }]);
    await converges(thread);
    const { history } = thread.snapshot();
    assert.equal(history.firstSeen.get('msg-0'), 1);
    assert.deepEqual(history.checkpoints.get(history.exchanges[4]!), CK, 'past the marker');
  });
});

it('preserves warm ownership through late row completion and recovery', async () => {
  const thread = open();
  const c = thread.current;
  c.observeWarm({ id: 'warm-a', phase: 'written' });
  c.note([{ role: 'warm', warmId: 'warm-a', text: 'ping', at: 1000 }]);
  c.stream('warm-stream', 'OK', 2000);
  c.observeWarm({ id: 'warm-a', phase: 'closed', trafficAt: 2500, prefix: 32000, cached: 0 });
  c.stream('real-stream', 'real work', 3000);
  assert.equal(
    thread.snapshot().tail.find((row) => row.id === 'real-stream')?.exchange.maintenance,
    false
  );
  c.complete('warm-stream', [{ role: 'assistant', text: 'OK', at: 2000 }]);
  c.complete('real-stream', [{ role: 'assistant', text: 'real work', at: 3000 }]);
  await thread.idle();
  const raw = await record.readRecord(c.conversation);
  assert.equal(await record.recordedActivityAt(c.conversation), 3000);
  const ping = raw?.exchanges.find((x) => 'role' in x && x.role === 'warm');
  assert.ok(ping && 'warmEvidence' in ping && ping.warmEvidence?.cached === 0);
  const warm = raw?.exchanges.find((x) => 'role' in x && x.text === 'OK');
  assert.ok(warm && 'maintenance' in warm && warm.maintenance === true);
  assert.equal(warm.warmId, 'warm-a');
  const recovered = new threads.Thread({ brand: 'claude' }, c.conversation);
  await recovered.current.recover(() =>
    threads.readBaseline(c.conversation, () =>
      Promise.resolve({
        recent: { exchanges: [], truncated: false },
        witnessed: new Set(),
        order: []
      })
    )
  );
  assert.deepEqual(recovered.snapshot().recent.exchanges, raw?.exchanges);
});

it('preserves a real row opened before the first warm scope through a late completion', async () => {
  const thread = open();
  const c = thread.current;
  c.stream('real-before', 'real work', 1000);
  c.observeWarm({ id: 'first-warm', phase: 'written' });
  c.note([{ role: 'warm', warmId: 'first-warm', text: 'ping', at: 2000 }]);
  c.complete('real-before', [{ role: 'assistant', text: 'real work', at: 1000 }]);
  await thread.idle();
  const real = thread
    .snapshot()
    .recent.exchanges.find((x) => 'role' in x && x.text === 'real work');
  assert.equal(real && 'role' in real && real.maintenance, false);
  assert.equal(await record.recordedActivityAt(c.conversation), 1000);
});

it('ends a recovered warm span for unsolicited rows arriving during and after recovery', async () => {
  const thread = open();
  const c = thread.current;
  const reading = deferred<Baseline>();
  const loading = c.recover(() => reading.promise);
  c.stream('during', 'new work', 3000);
  reading.resolve({
    lines: [
      { role: 'warm', text: 'ping', at: 1000 },
      { role: 'assistant', text: 'OK', maintenance: true, at: 2000 }
    ],
    ours: true,
    partial: false
  });
  await loading;
  assert.equal(
    thread.snapshot().tail.find((row) => row.id === 'during')?.exchange.maintenance,
    false
  );
  c.complete('during', [{ role: 'assistant', text: 'new work', at: 3000 }]);
  c.stream('after', 'more work', 4000);
  assert.equal(
    thread.snapshot().tail.find((row) => row.id === 'after')?.exchange.maintenance,
    false
  );
  c.complete('after', [{ role: 'assistant', text: 'more work', at: 4000 }]);
  await thread.idle();
  assert.equal(await record.recordedActivityAt(c.conversation), 4000);
});

it('keeps captured reply and CLI ping ids through a newer warm scope', async () => {
  const thread = open();
  const c = thread.current;
  c.observeWarm({ id: 'w1', phase: 'written' });
  c.note([{ role: 'warm', text: 'ping', warmId: 'w1' }]);
  c.stream('w1-stream', 'OK');
  c.hold('w1-alarm', [{ role: 'cli', text: 'first error' }]);
  c.observeWarm({ id: 'w1', phase: 'closed' });
  c.observeWarm(undefined);
  c.note([{ role: 'user', text: 'real' }]);
  c.observeWarm({ id: 'w2', phase: 'written' });
  c.note([{ role: 'warm', text: 'ping', warmId: 'w2' }]);
  c.complete('w1-stream', [{ role: 'assistant', text: 'OK' }]);
  c.hold('w1-alarm', [{ role: 'cli', text: 'full error' }]);
  c.observeWarm({ id: 'w2', phase: 'closed' });
  c.seal('w1-alarm');
  await converges(thread);
  for (const text of ['OK', 'full error']) {
    const row = thread.snapshot().history.exchanges.find((x) => 'role' in x && x.text === text);
    assert.ok(row && 'role' in row);
    assert.equal(row.warmId, 'w1');
    assert.equal(row.maintenance, true);
  }
});
