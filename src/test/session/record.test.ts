import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { HOLD_MISSES, type Exchange } from '../../core/transcript';
import { repoRoot, tempHome } from '../helpers';

type Record = typeof import('../../core/record');
type Transcript = typeof import('../../core/claude/transcript');

let record: Record;
let transcript: Transcript;

before(async () => {
  // Imported after the home moves: `core/paths.ts` resolves its directories
  // once, at load.
  await tempHome();
  record = await import('../../core/record');
  transcript = await import('../../core/claude/transcript');
});

const said = (role: 'user' | 'assistant', text: string): Exchange => ({ role, text });

/** An assistant turn that made one call, as the tee writes it. */
const called = (id: string, name = 'Bash'): Exchange => ({
  role: 'assistant',
  text: '',
  blocks: [{ call: { id, name } }]
});

describe('appendLine', () => {
  it('opens the record with a header, then one line per exchange', async () => {
    await record.appendLine('open-1', said('user', 'first'));
    await record.appendLine('open-1', said('assistant', 'second'));

    const raw = await fs.readFile(record.recordFile('open-1'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'header plus two exchanges');
    assert.equal(lines[0], JSON.stringify({ v: record.SCHEMA, sessionId: 'open-1' }));
    assert.deepEqual(JSON.parse(lines[1] ?? ''), { role: 'user', text: 'first' });
  });

  it('keeps the birth context from the first append', async () => {
    await record.appendLine('open-3', said('user', 'first'), {
      cwd: '/repo/first',
      brand: 'claude'
    });
    await record.appendLine('open-3', said('assistant', 'second'), {
      cwd: '/repo/other',
      brand: 'codex'
    });

    const raw = await fs.readFile(record.recordFile('open-3'), 'utf8');
    const [header] = raw.split('\n').filter(Boolean);
    assert.deepEqual(JSON.parse(header ?? ''), {
      v: record.SCHEMA,
      sessionId: 'open-3',
      cwd: '/repo/first',
      brand: 'claude'
    });
    assert.deepEqual((await record.readRecord('open-3'))?.exchanges, [
      said('user', 'first'),
      said('assistant', 'second')
    ]);
  });

  it('writes the header once, however many appends follow', async () => {
    for (const n of [1, 2, 3, 4]) {
      await record.appendLine('open-2', said('user', `turn ${n}`));
    }
    const raw = await fs.readFile(record.recordFile('open-2'), 'utf8');
    const headers = raw.split('\n').filter((l) => l.includes('"v"'));
    assert.equal(headers.length, 1);
  });

  it('names the file after the conversation and nothing else', () => {
    // The whole point of the store: no cwd in the path, so none of the four ways
    // a derived transcript path has missed can reach it.
    assert.match(record.recordFile('abc-def'), /transcripts[\\/]abc-def\.jsonl$/);
  });
});

describe('RecordFold', () => {
  it('folds before writing without losing witnesses or changing earlier snapshots', async () => {
    const fold = new record.RecordFold();
    const line = { ...called('fold-call'), m: 'fold-message' };
    const original = structuredClone(line);
    const empty = fold.snapshot();
    fold.push(line);
    const before = fold.snapshot();
    assert.equal(fold.snapshot(), before);
    assert.deepEqual(line, original);
    assert.equal('m' in before.exchanges[0]!, false);
    assert.equal(before.firstSeen.get('fold-message'), 0);
    await record.appendLine('fold-roundtrip', line);

    const returned = { ret: [{ id: 'fold-call', output: 'done', failed: true as const }] };
    fold.push(returned);
    await record.appendLine('fold-roundtrip', returned);
    const after = fold.snapshot();
    assert.deepEqual(empty.exchanges, []);
    assert.equal(empty.firstSeen.size, 0);
    assert.deepEqual(before.exchanges, [called('fold-call')]);
    assert.deepEqual(line, original);
    assert.notEqual(after, before);
    assert.deepEqual(after, await record.readRecord('fold-roundtrip'));
    const raw = await fs.readFile(record.recordFile('fold-roundtrip'), 'utf8');
    assert.equal(JSON.parse(raw.split('\n')[1] ?? '').m, 'fold-message');
    const turn = after.exchanges[0]!;
    assert.ok(!('mark' in turn));
    assert.deepEqual(turn.blocks, [
      { call: { id: 'fold-call', name: 'Bash', output: 'done', failed: true } }
    ]);
  });

  it('owns nested input values and keeps notes linked when a call is replaced', () => {
    const fold = new record.RecordFold();
    const line = called('fold-notes');
    const ck = {
      tree: '/repo',
      from: { tree: 'aaa', at: 100 },
      to: { tree: 'bbb', at: 200 },
      changes: { files: ['/repo/file'], sizes: { '/repo/file': { add: 2, del: 0 } } }
    };
    fold.push(line);
    const beforeNotes = fold.snapshot();
    const ex: import('../../core/checkpoint').ExecutionCoverage = {
      version: 1,
      kind: 'coverage',
      owner: 'claude\0fold-notes',
      runtime: 'runtime',
      turn: 'first',
      tree: '/repo',
      start: 100,
      end: 200,
      source: 'execution',
      calls: [],
      windows: []
    };
    fold.push({ ck });
    fold.push({ ex });
    const noted = fold.snapshot();
    const oldTurn = noted.exchanges[0]!;
    assert.equal(beforeNotes.checkpoints.size, 0);
    assert.equal(beforeNotes.execution, undefined);
    fold.push({ ret: [{ id: 'fold-notes', output: 'done' }] });
    const after = fold.snapshot();
    assert.notEqual(after.exchanges[0], oldTurn);
    assert.deepEqual(after.checkpoints.get(after.exchanges[0]!), ck);
    assert.equal(after.checkpoints.has(oldTurn), false);
    assert.deepEqual(noted.checkpoints.get(oldTurn), ck);
    assert.deepEqual(noted.execution?.get(oldTurn), ex);
    assert.deepEqual(after.execution?.get(after.exchanges[0]!), ex);
    assert.equal(after.execution?.has(oldTurn), false);
    ck.changes.files.push('/repo/later');
    assert.deepEqual(after.checkpoints.get(after.exchanges[0]!)?.changes.files, ['/repo/file']);
    assert.ok(!('mark' in line));
    line.blocks!.push({ text: 'later' });
    assert.deepEqual(beforeNotes.exchanges, [called('fold-notes')]);
  });
});

describe('readRecord', () => {
  it('round-trips a fixture to the same Recent the .jsonl parser produces', async () => {
    // Step 5's done-when: the record stores the parser's `Exchange` shape, so
    // a conversation the disk walk already knows must come back unchanged.
    // `JSON.parse(JSON.stringify)` is the store's own contract — undefined
    // fields are not written — and `truncated` is always false here.
    const fixture = path.join(repoRoot(), 'src', 'test', 'fixtures', 'record-roundtrip.jsonl');
    const fromFile = await transcript.readRecent(fixture);
    assert.ok(fromFile.exchanges.length >= 4, 'the fixture should be a conversation');
    assert.ok(
      fromFile.exchanges.some((e) => 'mark' in e && e.mark === 'break'),
      'the fixture includes the interrupt the disk walk mints'
    );
    assert.ok(
      fromFile.exchanges.some((e) => 'mark' in e && e.mark === 'skill'),
      'and the /rename the disk walk marks'
    );

    for (const exchange of fromFile.exchanges) {
      await record.appendLine('fixture-1', exchange);
    }
    const fromRecord = await record.readRecord('fixture-1');
    assert.deepEqual(fromRecord?.exchanges, JSON.parse(JSON.stringify(fromFile.exchanges)));
    assert.equal(record.drawable(fromRecord, new Set(), true)?.truncated, false);
  });

  it('round-trips what was appended', async () => {
    const written: Exchange[] = [
      said('user', 'what is it'),
      { role: 'assistant', text: 'this', blocks: [{ text: 'this' }] },
      { mark: 'skill', skill: 'ponytail', by: 'you' }
    ];
    for (const exchange of written) {
      await record.appendLine('round-1', exchange);
    }

    const recent = await record.readRecord('round-1');
    assert.deepEqual(recent?.exchanges, written);
    // Nothing was cut: the record is read whole, never tailed.
    assert.equal(record.drawable(recent, new Set(), true)?.truncated, false);
  });

  it('answers nothing for a conversation with no record', async () => {
    assert.equal(await record.readRecord('never-written'), undefined);
  });

  it('refuses a record written by a schema this build does not know', async () => {
    const file = record.recordFile('future-1');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `${JSON.stringify({ v: record.SCHEMA + 1, sessionId: 'future-1' })}\n` +
        `${JSON.stringify(said('user', 'from the future'))}\n`
    );
    // There is no migration by design, so a record this build cannot read is
    // refused outright and the dock falls back to the CLI's file.
    assert.equal(await record.readRecord('future-1'), undefined);
  });

  it('refuses a record whose header names another conversation', async () => {
    const file = record.recordFile('mismatch-1');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ v: record.SCHEMA, sessionId: 'other' })}\n`);
    assert.equal(await record.readRecord('mismatch-1'), undefined);
  });

  it('skips the torn last line a crashed write leaves', async () => {
    await record.appendLine('torn-1', said('user', 'whole'));
    await fs.appendFile(record.recordFile('torn-1'), '{"role":"assistant","text":"cut off');

    const recent = await record.readRecord('torn-1');
    assert.deepEqual(recent?.exchanges, [said('user', 'whole')]);
  });

  it('reads a record with a header and no turns as empty rather than missing', async () => {
    // Distinct from `undefined`: the conversation exists and has said nothing,
    // which is not the same as having no record to draw.
    const file = record.recordFile('empty-1');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ v: record.SCHEMA, sessionId: 'empty-1' })}\n`);
    assert.deepEqual((await record.readRecord('empty-1'))?.exchanges, []);
  });
});

describe('readRecordLines', () => {
  it('answers the lines as written, witness and torn line as readRecord takes them', async () => {
    await record.appendLine('lines-1', said('user', 'asked'));
    await record.appendLine('lines-1', { ...said('assistant', 'answered'), m: 'msg_1' });
    await fs.appendFile(record.recordFile('lines-1'), '{"role":"assistant","text":"cut off');
    assert.deepEqual(await record.readRecordLines('lines-1'), {
      lines: [said('user', 'asked'), { ...said('assistant', 'answered'), m: 'msg_1' }]
    });
  });

  it('answers nothing for a record that is not there or is refused', async () => {
    assert.equal(await record.readRecordLines('lines-never'), undefined);
    const file = record.recordFile('lines-future');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ v: record.SCHEMA + 1, sessionId: 'x' })}\n`);
    assert.equal(await record.readRecordLines('lines-future'), undefined);
  });

  it('throws for a record that is there and cannot be read', async () => {
    // Where `readRecord` holds its last reading, a recovery has none to hold:
    // answering nothing here would be taken as a conversation with no history.
    await fs.mkdir(record.recordFile('lines-unreadable'), { recursive: true });
    await assert.rejects(record.readRecordLines('lines-unreadable'), { code: 'EISDIR' });
  });
});

describe('readRecord, what a call returned', () => {
  it("replaces a background command's running notice with its end, and keeps the trigger", async () => {
    // The Claude tee's lines for `background_cmd_2026_10_13`: the call, its
    // immediate result, then the end and the turn the CLI started for it.
    const { ClaudeTasks, lineForFrame } = await import('../../core/claude/tee');
    const tasks = new ClaudeTasks();
    tasks.take({
      type: 'system',
      subtype: 'task_started',
      task_id: 'b1',
      tool_use_id: 'toolu_bg',
      is_backgrounded: true
    });
    const lines = [
      called('toolu_bg'),
      { ret: [{ id: 'toolu_bg', output: 'Command running in background with ID: b1.' }] },
      ...lineForFrame(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'b1',
          tool_use_id: 'toolu_bg',
          status: 'completed',
          summary: 'Background command "probe" completed (exit code 0)'
        },
        1_700_000_000_000,
        undefined,
        tasks
      ),
      said('assistant', 'finished')
    ];
    for (const line of lines) await record.appendLine('ret-bg', line);

    const recent = await record.readRecord('ret-bg');
    const first = recent?.exchanges[0];
    const block = first && 'blocks' in first ? first.blocks?.[0] : undefined;
    assert.deepEqual(block && 'call' in block ? block.call : undefined, {
      id: 'toolu_bg',
      name: 'Bash',
      output: 'Background command "probe" completed (exit code 0)'
    });
    assert.deepEqual(recent?.exchanges.slice(1), [
      { mark: 'trigger', trigger: 'task', status: 'completed', at: 1_700_000_000_000 },
      said('assistant', 'finished')
    ]);
  });

  it('folds a result onto the call it answers', async () => {
    // The two arrive whole turns apart and the file is append-only, so pairing
    // is the read's job. Without it every call in the record draws with no
    // output while the `.jsonl` has one.
    await record.appendLine('ret-1', called('toolu_1'));
    await record.appendLine('ret-1', { ret: [{ id: 'toolu_1', output: 'hello' }] });

    const recent = await record.readRecord('ret-1');
    const first = recent?.exchanges[0];
    const block = first && 'blocks' in first ? first.blocks?.[0] : undefined;
    assert.deepEqual(block && 'call' in block ? block.call : undefined, {
      id: 'toolu_1',
      name: 'Bash',
      output: 'hello'
    });
  });

  it('merges an ask and its result onto one call, whichever landed first', async () => {
    // Two lines name one call: `respond()` tees the picks the moment they are
    // made, and the tool's own `tool_result` comes back off the pipe after.
    const ask = {
      questions: [{ question: 'Which way?', multiSelect: false, options: [{ label: 'Left' }] }],
      answers: { 'Which way?': 'Left' },
      annotations: {}
    };
    await record.appendLine('ret-2', called('toolu_2', 'AskUserQuestion'));
    await record.appendLine('ret-2', { ret: [{ id: 'toolu_2', ask }] });
    await record.appendLine('ret-2', { ret: [{ id: 'toolu_2', output: 'Left' }] });

    const recent = await record.readRecord('ret-2');
    const first = recent?.exchanges[0];
    const block = first && 'blocks' in first ? first.blocks?.[0] : undefined;
    const call = block && 'call' in block ? block.call : undefined;
    assert.deepEqual(call?.ask, ask);
    assert.equal(call?.output, 'Left');
  });

  it('drops a result whose call this record never held', async () => {
    // Reachable: a `--resume` reopens a record whose earlier turns are in the
    // CLI's file. Nothing to fold it onto, and nothing to draw it as.
    await record.appendLine('ret-3', said('user', 'go'));
    await record.appendLine('ret-3', { ret: [{ id: 'toolu_gone', output: 'orphan' }] });
    assert.deepEqual((await record.readRecord('ret-3'))?.exchanges, [said('user', 'go')]);
  });
});

describe('readRecord, what it witnessed', () => {
  it('gathers every message id and keeps it off the turns', async () => {
    // The id is the record's own bookkeeping — `Exchange` has no field for it,
    // and the dock must never see one.
    await record.appendLine('wit-1', { ...said('assistant', 'one'), m: 'msg_1' });
    await record.appendLine('wit-1', { m: 'msg_2' });

    const recent = await record.readRecord('wit-1');
    assert.deepEqual(recent?.exchanges, [said('assistant', 'one')]);
    // `msg_1` is the turn's own line, so it sits at that turn. `msg_2` said
    // nothing drawable and resolves to the next turn there would be.
    assert.deepEqual(
      [...(recent?.firstSeen ?? [])],
      [
        ['msg_1', 0],
        ['msg_2', 1]
      ]
    );
  });

  it('hands the same object back while the file has not moved', async () => {
    // `renderTranscript` skips a ~148 KB view rebuild on object identity alone.
    // Re-parsed every poll, that check could never hit.
    await record.appendLine('cache-1', said('user', 'go'));
    const first = await record.readRecord('cache-1');
    assert.equal(await record.readRecord('cache-1'), first);

    await record.appendLine('cache-1', said('assistant', 'done'));
    const second = await record.readRecord('cache-1');
    assert.notEqual(second, first);
    assert.equal(second?.exchanges.length, 2);
  });
});

describe('a record whose file would not read', () => {
  /**
   * The hold `core/claude/transcript.ts` already keeps, for the reason its own
   * comment gives: "one lost read used to take the whole thread off screen and
   * put it back a poll later."
   *
   * This reader used to answer a lost stat with nothing outright, on the
   * grounds that it "only moves the thread to the other source, which still
   * draws it". That is untrue for every session whose CLI file is not there —
   * a brand that writes none, a conversation the CLI has yet to open a file
   * for — and for those the other source draws *nothing*. So a single
   * transient miss blanked the whole dock for one push and healed on the next.
   */
  it('holds what it last read across a transient loss', async () => {
    await record.appendLine('held-1', said('user', 'first'));
    const before = await record.readRecord('held-1');
    assert.equal(before?.exchanges.length, 1, 'readable to start with');

    const file = record.recordFile('held-1');
    const kept = await fs.readFile(file);
    await fs.rm(file);
    const during = await record.readRecord('held-1');
    assert.deepEqual(during?.exchanges, before?.exchanges, 'still drawn while the file is away');

    await fs.writeFile(file, kept);
    assert.equal((await record.readRecord('held-1'))?.exchanges.length, 1, 'and again after');
  });

  it('lets go once the loss stops looking transient', async () => {
    // A record really deleted — a `/clear`, a prune — must empty rather than be
    // drawn for the life of the panel. Same count and same reasoning as the
    // `.jsonl` reader's, so the two degrade alike.
    await record.appendLine('held-2', said('user', 'first'));
    assert.ok(await record.readRecord('held-2'), 'readable to start with');

    await fs.rm(record.recordFile('held-2'));
    for (let miss = 1; miss < HOLD_MISSES; miss++) {
      assert.ok(await record.readRecord('held-2'), `still held on miss ${miss}`);
    }
    assert.equal(await record.readRecord('held-2'), undefined, 'let go on the last');
  });

  it('does not hold for a record this build refuses', async () => {
    // A refusal is an answer, not a lost read: the file was there and said
    // something we will not draw. Holding one would redraw a schema we just
    // declined every poll after the first.
    await record.appendLine('held-3', said('user', 'first'));
    assert.ok(await record.readRecord('held-3'), 'readable to start with');

    const file = record.recordFile('held-3');
    await fs.writeFile(file, `${JSON.stringify({ v: record.SCHEMA + 1, sessionId: 'held-3' })}\n`);
    assert.equal(await record.readRecord('held-3'), undefined);

    // The half that is actually new: the refusal takes the reading it replaced
    // with it, so a lost read *after* one cannot hand back what the refusal
    // just declined. Without the drop this answers the pre-refusal turns.
    await fs.rm(file);
    assert.equal(await record.readRecord('held-3'), undefined, 'a refusal left something to hold');
  });
});

describe('a record that lost a line', () => {
  it('is refused for the rest of this process, hole or no hole', async () => {
    // `drawable` compares `message.id`s, and only a message the CLI *sent* has
    // one. The lines this writer authors — the drain's user turn, a `break`, a
    // `ret` — carry none, so a lost user-turn append would leave a record
    // silently missing what the reader typed and still pass every check.
    await record.appendLine('lost-1', said('user', 'first'));
    assert.ok(await record.readRecord('lost-1'), 'readable before the loss');

    // The store's directory replaced by a file is the cheapest real `appendFile`
    // failure to stage; any errno lands in the same branch.
    const file = record.recordFile('lost-2');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ v: record.SCHEMA, sessionId: 'lost-2' })}\n`);
    await fs.chmod(file, 0o444);
    const ok = await record.appendLine('lost-2', said('user', 'never landed'));
    await fs.chmod(file, 0o644);
    assert.equal(ok, false, 'the append should have failed');

    // Refused even though the file on disk parses perfectly — which is the whole
    // point: nothing in it says a line is missing.
    assert.equal(await record.readRecord('lost-2'), undefined);
  });
});

describe('readRecord, how much it draws', () => {
  it('draws the last MAX_TURNS authored turns and says the rest were not read', async () => {
    // Without a cap a conversation drawn from the record grows the dock's push
    // without bound, where the same one drawn from the `.jsonl` never exceeds
    // 400 authored turns. Same cap for both, so the dock's size does not depend
    // on which source won.
    for (let n = 0; n < 405; n++) {
      await record.appendLine('cap-1', said('user', `turn ${n}`));
    }
    const drawn = record.drawable(await record.readRecord('cap-1'), new Set(), true);
    assert.equal(drawn?.exchanges.length, 400);
    assert.equal(drawn?.truncated, true);
    // The *last* of them: a thread is read from its end.
    const last = drawn?.exchanges[399];
    assert.equal(last && 'text' in last ? last.text : undefined, 'turn 404');
  });

  it('does not count a marker against the cap', async () => {
    // A session that ran four skills should not show four fewer things anybody
    // said — the walk's own rule.
    for (let n = 0; n < 200; n++) {
      await record.appendLine('cap-2', { mark: 'skill', skill: 'ponytail', by: 'you' });
      await record.appendLine('cap-2', said('user', `turn ${n}`));
    }
    const drawn = record.drawable(await record.readRecord('cap-2'), new Set(), true);
    assert.equal(drawn?.truncated, false, '200 turns is under the cap however many markers');
    assert.equal(drawn?.exchanges.length, 400);
  });

  it('keeps witnessing what it no longer draws', async () => {
    // `drawable` asks what the record was there for, not what it is currently
    // showing. Cutting the two together would fall back on every long
    // conversation, which is the opposite of what the cap is for.
    for (let n = 0; n < 405; n++) {
      await record.appendLine('cap-3', { ...said('assistant', `turn ${n}`), m: `msg_${n}` });
    }
    const recorded = await record.readRecord('cap-3');
    assert.equal(recorded?.exchanges.length, 405, 'the read itself is whole');
    assert.equal(recorded?.firstSeen.size, 405);
    assert.equal(recorded?.firstSeen.get('msg_0'), 0, 'the oldest message is still witnessed');
    assert.equal(record.drawable(recorded, new Set(), true)?.exchanges.length, 400);
  });
});

describe('drawable', () => {
  /** A record of `turns` assistant turns, the nth witnessed as `msg_<n>`.
   *
   *  **Every turn witnessed, which no real conversation is** — see `opened`,
   *  which has the shape they do have. This one is why an `oldest` of 1 on every
   *  conversation ever held went unseen: nothing here can distinguish it from 0.
   *  Fine for what it is used for below, which is the cut's arithmetic. */
  const ours = (turns: number): Parameters<typeof record.drawable>[0] => ({
    exchanges: Array.from({ length: turns }, (_, n) => said('assistant', `turn ${n}`)),
    firstSeen: new Map(Array.from({ length: turns }, (_, n) => [`msg_${n}`, n])),
    checkpoints: new Map()
  });

  it('draws our record when it witnessed every message the CLI wrote down', () => {
    const drawn = record.drawable(ours(3), new Set(['msg_0', 'msg_1', 'msg_2']), true);
    assert.equal(drawn?.exchanges.length, 3);
    assert.equal(drawn?.truncated, false);
  });

  it('falls back when the CLI has a message we never saw', () => {
    // A conversation carried on with `claude --resume` outside the panel, and
    // the hole it leaves can be anywhere — which is why this is a set and not a
    // count or a clock.
    assert.equal(record.drawable(ours(3), new Set(['msg_1', 'msg_outside']), true), undefined);
  });

  it('draws no further back than the CLI window is evidence for', () => {
    // The review of 2026-08-20: our record has no byte window and draws up to
    // 400 turns, where theirs is a 2–8 MiB tail averaging 23.8 turns on a
    // tool-heavy conversation. A yes/no answer would license drawing 400 turns
    // on the evidence of 24, and any hole older than the tail would be
    // invisible — which is the very case this rule exists to catch.
    const drawn = record.drawable(ours(10), new Set(['msg_7', 'msg_8', 'msg_9']), true);
    assert.equal(drawn?.exchanges.length, 3, 'only the range the tail reached');
    assert.equal(drawn?.truncated, true, 'and the reader is told so');
    const first = drawn?.exchanges[0];
    assert.equal(first && 'text' in first ? first.text : undefined, 'turn 7');
  });

  it('cuts nothing when a bound window happens to reach the whole conversation', () => {
    // Reaching turn 0 is the tail's own doing here, not the whole-read floor:
    // `msg_0` is in the set and this fixture is the shape that lets it be.
    const drawn = record.drawable(ours(10), new Set(['msg_0', 'msg_9']), true);
    assert.equal(drawn?.exchanges.length, 10);
    assert.equal(drawn?.truncated, false);
  });

  it('draws our record whole when the CLI file could not be located', () => {
    // "Not found", "empty" and "failed" are one value at that boundary. There is
    // then no evidence either way, and the plan's answer is to draw the record.
    const drawn = record.drawable(ours(10), new Set(), false);
    assert.equal(drawn?.exchanges.length, 10);
    assert.equal(drawn?.truncated, false);
  });

  it('falls back when there is no record, or one that has said nothing', () => {
    assert.equal(record.drawable(undefined, new Set(), false), undefined);
    assert.equal(record.drawable(ours(0), new Set(), false), undefined);
  });

  /** The shape every real conversation has: the prompt that opened it, then the
   *  assistant turns it produced. The CLI writes a `message.id` for none of the
   *  first kind, so no `firstSeen` entry can ever point at index 0. */
  const opened = (turns: number): Parameters<typeof record.drawable>[0] => ({
    exchanges: [
      said('user', 'the prompt'),
      ...Array.from({ length: turns }, (_, n) => said('assistant', `turn ${n}`))
    ],
    firstSeen: new Map(Array.from({ length: turns }, (_, n) => [`msg_${n}`, n + 1])),
    checkpoints: new Map()
  });

  it('draws the opening prompt, which the CLI wrote no id for', () => {
    // The bug this argument exists to kill: `theirs` names assistant messages
    // and nothing else, so `oldest` is 1 on every conversation ever held and the
    // reader lost their own first turn to a notice saying more was unread.
    const drawn = record.drawable(opened(3), new Set(['msg_0', 'msg_1', 'msg_2']), false);
    assert.equal(drawn?.exchanges.length, 4);
    assert.equal(drawn?.truncated, false);
    const first = drawn?.exchanges[0];
    assert.equal(first && 'text' in first ? first.text : undefined, 'the prompt');
  });

  it('still cuts to the oldest message a bound window named', () => {
    // Unchanged where the premise holds: the turn above the oldest witnessed
    // message may be inside their window or older than it, and guessing which is
    // the hole this rule exists to catch.
    const drawn = record.drawable(opened(3), new Set(['msg_0', 'msg_1', 'msg_2']), true);
    assert.equal(drawn?.exchanges.length, 3);
    assert.equal(drawn?.truncated, true);
  });

  it('falls back on a hole however the window was read', () => {
    // The set test is evidence of a conversation carried on elsewhere, and a
    // whole read makes that more certain rather than less.
    assert.equal(record.drawable(opened(3), new Set(['msg_0', 'msg_outside']), false), undefined);
  });

  it('keeps a complete user turn beyond the retained-row target in a whole window', () => {
    const drawn = record.drawable(opened(405), new Set(['msg_0', 'msg_404']), false);
    assert.equal(drawn?.exchanges.length, 406);
    assert.equal(drawn?.truncated, false);
  });

  it('does not mind our record holding messages the CLI window has dropped', () => {
    // Extra on our side inside the compared range is not a hole.
    const drawn = record.drawable(ours(5), new Set(['msg_2']), true);
    assert.equal(drawn?.exchanges.length, 3);
  });
});

describe('drawableFor', () => {
  const recorded = {
    exchanges: [said('assistant', 'one')],
    firstSeen: new Map([['msg_0', 0]]),
    checkpoints: new Map()
  };

  it('hands the same reading back while neither side has moved', () => {
    // The cut depends on both inputs, so the `Recent` is minted rather than
    // cached upstream — and a fresh one per poll would defeat the identity
    // check `renderTranscript` skips its whole view rebuild on.
    const theirs = new Set(['msg_0']);
    const first = record.drawableFor('memo-1', recorded, theirs, true);
    assert.equal(record.drawableFor('memo-1', recorded, theirs, true), first);
  });

  it('re-cuts when the CLI window moves under an unchanged record', () => {
    const first = record.drawableFor('memo-2', recorded, new Set(['msg_0']), true);
    const second = record.drawableFor('memo-2', recorded, new Set(['msg_0']), true);
    assert.notEqual(second, first, 'a different set is a different reading');
  });
});

describe('missingTail', () => {
  /** Ours: one prompt, then the replies keyed `k1` and `k2`. */
  const ours = () => {
    const fold = new record.RecordFold();
    fold.push(said('user', 'go'));
    fold.push({ ...said('assistant', 'one'), m: 'k1' });
    fold.push({ ...said('assistant', 'two'), m: 'k2' });
    return fold.snapshot();
  };
  const rows = [
    said('user', 'go'),
    said('assistant', 'one'),
    said('assistant', 'two'),
    said('user', 'typed'),
    said('assistant', 'three'),
    said('assistant', 'four')
  ];
  const theirs = (order: [string, number][]) => ({
    recent: { exchanges: rows, truncated: false },
    order: order.map(([key, from]) => ({ key, from }))
  });

  it('answers the rows after the last shared key, each missed key ahead of its own', () => {
    assert.deepEqual(
      record.missingTail(
        ours(),
        theirs([
          ['k1', 0],
          ['k2', 2],
          ['k3', 3],
          ['k4', 5]
        ])
      ),
      [{ m: 'k3' }, said('user', 'typed'), said('assistant', 'three'), { m: 'k4' }, rows[5]]
    );
  });

  it('keeps a missed key with no rows, after the rows before it', () => {
    // A Claude message of nothing but `thinking` still has a key.
    assert.deepEqual(
      record.missingTail(
        ours(),
        theirs([
          ['k2', 0],
          ['k3', 3],
          ['k4', 6]
        ])
      ),
      [{ m: 'k3' }, said('user', 'typed'), said('assistant', 'three'), rows[5], { m: 'k4' }]
    );
  });

  it('answers nothing for a missed key among the shared ones', () => {
    assert.equal(
      record.missingTail(
        ours(),
        theirs([
          ['k1', 0],
          ['k0', 1],
          ['k2', 2],
          ['k3', 3]
        ])
      ),
      undefined
    );
  });

  it('answers nothing when no key is shared, or none is missed', () => {
    assert.equal(record.missingTail(ours(), theirs([['k9', 0]])), undefined);
    assert.equal(record.missingTail(ours(), theirs([])), undefined);
    assert.equal(
      record.missingTail(
        ours(),
        theirs([
          ['k1', 0],
          ['k2', 2]
        ])
      ),
      undefined
    );
  });

  it('answers nothing when the first missed exchange opens before the window', () => {
    assert.equal(
      record.missingTail(
        ours(),
        theirs([
          ['k2', -4],
          ['k3', -1],
          ['k4', 0]
        ])
      ),
      undefined
    );
  });
});

describe('refFile', () => {
  it('reads the path out of both shapes that name one', () => {
    assert.equal(record.refFile('p|/tmp/a.png'), '/tmp/a.png');
    assert.equal(record.refFile('f|u1|0.0|/tmp/a.png'), '/tmp/a.png');
  });

  it('returns a path holding a bar whole', () => {
    assert.equal(record.refFile('f|u1|0.0|/tmp/a|b.png'), '/tmp/a|b.png');
  });

  it('names no file for a ref that is not one, or for a malformed id', () => {
    assert.equal(record.refFile('t|uuid|1'), undefined);
    assert.equal(record.refFile(`${record.REF_PREFIX}sess-abc.png`), undefined);
    assert.equal(record.refFile('f|'), undefined);
    assert.equal(record.refFile('f|u1|0.0'), undefined);
    assert.equal(record.refFile(''), undefined);
  });

  it("resolves a ref every brand's reader mints", () => {
    // `p|` is Claude's reader and Grok's alike; `f|` is `core/prose_images.ts`,
    // which all three call, and `codex/transcript.ts`. Nothing here is one
    // CLI's spelling, which is why the host may ask it without a brand.
    assert.equal(record.refFile('p|/tmp/grok-attachment.png'), '/tmp/grok-attachment.png');
    assert.equal(record.refFile('f|item_42|0.0|/tmp/codex.png'), '/tmp/codex.png');
  });
});

describe('attachmentFile', () => {
  it('resolves our own scheme to a file in the store', () => {
    const file = record.attachmentFile(`${record.REF_PREFIX}sess-abc.png`);
    assert.equal(file, path.join(record.ATTACHMENTS_DIR, 'sess-abc.png'));
  });

  it('answers nothing for another scheme', () => {
    assert.equal(record.attachmentFile('p|/tmp/x.png'), undefined);
    assert.equal(record.attachmentFile('f|uuid|0|/tmp/x.png'), undefined);
  });

  it('cannot be walked out of the store', () => {
    // A ref reaches here off the wire, and the extension host can read anything
    // this machine can.
    const out = record.attachmentFile(`${record.REF_PREFIX}../../.ssh/id_rsa`);
    assert.equal(out, path.join(record.ATTACHMENTS_DIR, 'id_rsa'));
    assert.equal(record.attachmentFile(`${record.REF_PREFIX}..`), undefined);
  });
});

describe('writeAttachment', () => {
  const png = { mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') };

  it('copies the bytes and answers a ref carrying id, type and size', async () => {
    const ref = await record.writeAttachment('att-1', png);
    assert.ok(ref?.id.startsWith(record.REF_PREFIX), ref?.id);
    // t3code's rule, and Phase 0's: the durable side stores no path.
    assert.ok(!ref?.id.includes('/'));
    assert.equal(ref?.mediaType, 'image/png');
    assert.equal(ref?.sizeBytes, 3);
  });

  it('writes the file under the extension the stated media type earns', async () => {
    const ref = await record.writeAttachment('att-2', png);
    // The extension rides the ref, because the ref is all a reader opening a
    // chip hands back — the media type beside it never makes that trip.
    assert.ok(ref?.id.endsWith('.png'), ref?.id);
    const bytes = await fs.readFile(record.attachmentFile(ref?.id ?? '') ?? '');
    assert.deepEqual([...bytes], [1, 2, 3]);
  });

  it('refuses a media type the CLI would not take, rather than renaming it', async () => {
    assert.equal(
      await record.writeAttachment('att-3', { mediaType: 'image/tiff', data: 'AA' }),
      undefined
    );
  });

  it('refuses empty data and a media type that is not a string', async () => {
    assert.equal(
      await record.writeAttachment('att-4', { mediaType: 'image/png', data: '' }),
      undefined
    );
    // `mediaType` reaches here from `File.type`; a non-string would have thrown
    // out of an un-awaited promise before this guard existed.
    assert.equal(
      await record.writeAttachment('att-5', { mediaType: undefined as never, data: 'AA' }),
      undefined
    );
  });
});

describe('a checkpoint note', () => {
  it('reads additive execution decisions onto the completed assistant exchange without changing schema', async () => {
    const sid = 'execution-note';
    const ex: import('../../core/checkpoint').ExecutionCoverage = {
      version: 1,
      kind: 'coverage',
      owner: 'claude\0execution-note',
      runtime: 'runtime',
      turn: 'first',
      tree: '/repo',
      start: 100,
      end: 200,
      source: 'execution',
      calls: [],
      windows: []
    };
    await record.appendLine(sid, said('user', 'first'));
    await record.appendLine(sid, said('assistant', 'done'));
    await record.appendLine(sid, { mark: 'break' });
    await record.appendLine(sid, { ex });
    await record.appendLine(sid, said('user', 'next'));
    const read = await record.readRecord(sid);
    assert.equal(record.SCHEMA, 2);
    assert.deepEqual(read?.execution?.get(read.exchanges[1]!), ex);
    assert.equal(read?.execution?.has(read.exchanges[3]!), false);
  });

  const ck = (over: Partial<import('../../core/checkpoint').TurnCheckpoint> = {}) => ({
    tree: '/repo',
    from: { tree: 'aaa', head: 'h0', at: 100 },
    to: { tree: 'bbb', head: 'h0', at: 200 },
    changes: { files: ['/repo/by-shell.txt'], sizes: { '/repo/by-shell.txt': { add: 2, del: 0 } } },
    ...over
  });

  /**
   * The whole linkage, and why no witness key is needed: the record is
   * append-only and ordered, so "the turn this note belongs to" is "the last
   * exchange written before it".
   */
  it('folds onto the assistant exchange written before it', async () => {
    await record.appendLine('ck-1', said('user', 'write it with sed'));
    await record.appendLine('ck-1', said('assistant', 'done'));
    await record.appendLine('ck-1', { ck: ck() });

    const read = await record.readRecord('ck-1');
    const last = read?.exchanges.at(-1);
    assert.equal(read?.exchanges.length, 2, 'the note is not an exchange of its own');
    assert.equal(read?.checkpoints.get(last!)?.changes.files[0], '/repo/by-shell.txt');
  });

  it('attaches to nothing when it opens a record, rather than throwing', async () => {
    await record.appendLine('ck-2', { ck: ck() });
    const read = await record.readRecord('ck-2');
    assert.deepEqual(read?.exchanges, []);
    assert.equal(read?.checkpoints.size, 0);
  });

  it('keeps one checkpoint per turn, the last one written for it', async () => {
    await record.appendLine('ck-3', said('assistant', 'one'));
    await record.appendLine('ck-3', { ck: ck() });
    await record.appendLine('ck-3', said('assistant', 'two'));
    await record.appendLine('ck-3', { ck: ck({ tree: '/other' }) });

    const read = await record.readRecord('ck-3');
    assert.equal(read?.exchanges.length, 2);
    assert.equal(read?.checkpoints.get(read.exchanges[0]!)?.tree, '/repo');
    assert.equal(read?.checkpoints.get(read.exchanges[1]!)?.tree, '/other');
  });

  /**
   * The case rule 1 exists for, and it was silently lost: the tee mints
   * `{mark:'break'}` from the same `result` frame that ends an interrupted turn
   * and writes it *before* `handle` drains, so the marker is the last line
   * standing when the note lands.
   */
  it('folds past the break an interrupted turn left, onto the turn itself', async () => {
    await record.appendLine('ck-8', said('user', 'do it'));
    await record.appendLine('ck-8', said('assistant', 'writing'));
    await record.appendLine('ck-8', { mark: 'break' });
    await record.appendLine('ck-8', { ck: ck() });

    const read = await record.readRecord('ck-8');
    const turn = read?.exchanges[1];
    assert.equal(read?.checkpoints.get(turn!)?.changes.files[0], '/repo/by-shell.txt');
  });

  /** A checkpoint is what the session did about a prompt, never the prompt. A
   *  turn that produced no exchange of its own has nowhere honest to put one. */
  it('never folds onto a user turn', async () => {
    await record.appendLine('ck-9', said('user', 'do it'));
    await record.appendLine('ck-9', { ck: ck() });

    const read = await record.readRecord('ck-9');
    assert.equal(read?.checkpoints.size, 0);
  });

  /** Spent inside `attribute` on every poll, so a shape that does not hold has
   *  to die here rather than throw a thread away there. */
  it('drops a note whose shape does not hold, and keeps reading', async () => {
    await record.appendLine('ck-10', said('assistant', 'one'));
    await record.appendLine('ck-10', { ck: { tree: '/repo' } as never });
    await record.appendLine('ck-10', said('assistant', 'two'));

    const read = await record.readRecord('ck-10');
    assert.equal(read?.exchanges.length, 2, 'the lines after it still read');
    assert.equal(read?.checkpoints.size, 0);
  });

  /**
   * The compatibility direction that matters, and the reason `SCHEMA` is *not*
   * bumped for this: a build that knows nothing of `ck` meets the note at
   * `readRecord`'s existing `role === undefined && mark === undefined` guard and
   * skips it. Bumping instead would refuse every record whole on the day this
   * shipped, dropping every live conversation to the CLI-file fallback.
   */
  it('is skipped by the guard that predates it, not treated as a turn', async () => {
    await record.appendLine('ck-4', said('assistant', 'one'));
    await record.appendLine('ck-4', { ck: ck() });
    const raw = await fs.readFile(record.recordFile('ck-4'), 'utf8');
    const note = JSON.parse(raw.split('\n').filter(Boolean).at(-1) ?? '{}');
    assert.equal(note.role, undefined);
    assert.equal(note.mark, undefined);
    assert.equal(note.ret, undefined);
  });

  it('reads a record that has no checkpoints at all', async () => {
    await record.appendLine('ck-5', said('assistant', 'one'));
    const read = await record.readRecord('ck-5');
    assert.equal(read?.checkpoints.size, 0);
  });
});

describe('recordedPromptAt', () => {
  /** A prompt as either tee writes one: the role, the words, and when the line
   *  reached us. `said` above leaves `at` off, which is the unstamped case. */
  const asked = (text: string, at: number): Exchange => ({ role: 'user', text, at });

  it('is when the newest prompt reached us', async () => {
    await record.appendLine('pat-1', asked('first', 1000));
    await record.appendLine('pat-1', said('assistant', 'working'));
    await record.appendLine('pat-1', asked('second', 3000));
    await record.appendLine('pat-1', { role: 'assistant', text: 'later', at: 9000 });

    // The assistant's own turn is newer and is not somebody asking for
    // something — the whole reason this is not an activity clock.
    assert.equal(await record.recordedPromptAt('pat-1'), 3000);
  });

  it('walks past a peer message and a converged wait, as Claude does', async () => {
    // Neither is somebody typing at this session, and `claude/transcript.ts`
    // skips both by way of `origin` returning `authored`
    // (`TASK_done_cross_session_verbs.md`). Counting them here would mean an
    // `squadron-send` silenced a Grok tally where the same send left a Claude
    // one alone — one product word, two rules.
    await record.appendLine('pat-2', asked('go', 1000));
    await record.appendLine('pat-2', { role: 'wait', text: 'peer finished', at: 5000 });
    await record.appendLine('pat-2', { role: 'user', text: 'from a peer', at: 7000, from: 'sib' });

    assert.equal(await record.recordedPromptAt('pat-2'), 1000);
  });

  it('walks past a cache-warming ping', async () => {
    await record.appendLine('pat-5', asked('go', 1000));
    await record.appendLine('pat-5', { role: 'warm', text: 'keep-alive', at: 5000 });
    await record.appendLine('pat-5', { role: 'assistant', text: 'OK', at: 6000 });

    assert.equal(await record.recordedPromptAt('pat-5'), 1000);
  });

  it('says nothing for a record with no prompt, and for no record at all', async () => {
    await record.appendLine('pat-3', said('assistant', 'alone'));

    assert.equal(await record.recordedPromptAt('pat-3'), undefined);
    assert.equal(await record.recordedPromptAt('pat-none'), undefined);
    assert.equal(await record.recordedPromptAt(''), undefined);
  });

  it('walks past an unstamped prompt to the newest turn that has a time', async () => {
    // `scanBack` does the same with an entry whose timestamp will not parse:
    // the pick returns nothing and the walk carries on.
    await record.appendLine('pat-4', asked('first', 1000));
    await record.appendLine('pat-4', said('user', 'newest, unstamped'));

    assert.equal(await record.recordedPromptAt('pat-4'), 1000);
  });
});

describe('recordedActivityAt', () => {
  it('returns the newest authored timestamp, whatever the role', async () => {
    await record.appendLine('aat-1', { role: 'user', text: 'go', at: 1000 });
    await record.appendLine('aat-1', { role: 'assistant', text: 'done', at: 3000 });

    assert.equal(await record.recordedActivityAt('aat-1'), 3000);
    assert.equal(await record.recordedActivityAt('aat-1', { includeWarm: true }), 3000);
  });

  it('skips a ping and what answers it, unless asked for the cache clock', async () => {
    // A resume reads this as its `updatedAt`: keeping the cache warm is not
    // activity. A `cli` turn is the CLI speaking inside the ping, so it is the
    // ping's too.
    await record.appendLine('aat-3', { role: 'user', text: 'go', at: 1000 });
    await record.appendLine('aat-3', { role: 'assistant', text: 'done', at: 2000 });
    await record.appendLine('aat-3', { role: 'warm', text: 'keep-alive', at: 5000 });
    await record.appendLine('aat-3', { role: 'assistant', text: 'OK', at: 6000 });
    await record.appendLine('aat-3', { role: 'warm', text: 'keep-alive', at: 8000 });
    await record.appendLine('aat-3', { role: 'cli', text: 'API Error', at: 9000 });

    assert.equal(await record.recordedActivityAt('aat-3'), 2000);
    assert.equal(await record.recordedActivityAt('aat-3', { includeWarm: true }), 6000);
  });

  it('ends a ping at the next input, a wait or a peer as much as the reader', async () => {
    // Bounded by input, not by role: what answers a wait answers the wait.
    const after = async (id: string, input: Exchange) => {
      await record.appendLine(id, { role: 'warm', text: 'keep-alive', at: 5000 });
      await record.appendLine(id, { role: 'assistant', text: 'OK', at: 6000 });
      await record.appendLine(id, input);
      await record.appendLine(id, { role: 'assistant', text: 'on it', at: 8000 });
      return record.recordedActivityAt(id);
    };
    assert.equal(await after('aat-4', { role: 'wait', text: 'all finished', at: 7000 }), 8000);
    assert.equal(await after('aat-5', { role: 'user', text: 'hi', at: 7000, from: 'sib' }), 8000);
    assert.equal(await after('aat-6', { role: 'user', text: 'go', at: 7000 }), 8000);
    assert.equal(await after('aat-7', { mark: 'skill', skill: 'review', by: 'you' }), 8000);
    assert.equal(await after('aat-8', { mark: 'break' }), undefined);
  });

  it('says nothing for an unstamped or missing record', async () => {
    await record.appendLine('aat-2', said('assistant', 'done'));

    assert.equal(await record.recordedActivityAt('aat-2'), undefined);
    assert.equal(await record.recordedActivityAt('aat-none'), undefined);
    assert.equal(await record.recordedActivityAt(''), undefined);
  });
});

describe('confirmed warm traffic and ownership', () => {
  for (const phase of ['confirmed', 'attempted', 'failed', 'ambiguous', 'orphan'] as const) {
    for (const evidenceFirst of [false, true]) {
      it(`resolves named late receipts from ${phase} input evidence (${evidenceFirst ? 'before' : 'after'} input)`, async () => {
        const id = `named-clock-${phase}-${String(evidenceFirst)}`;
        const evidence = {
          wm: {
            id: 'W1',
            phase: phase === 'attempted' ? ('written' as const) : ('closed' as const),
            ...(phase === 'confirmed' ? { trafficAt: 2000 } : {}),
            ...(phase === 'failed' ? { failed: true as const } : {})
          }
        };
        if (evidenceFirst) await record.appendLine(id, evidence);
        if (phase !== 'orphan')
          await record.appendLine(id, { role: 'warm', text: 'ping', warmId: 'W1', at: 1000 });
        await record.appendLine(id, {
          role: 'assistant',
          text: 'real R',
          maintenance: false,
          at: 4000
        });
        await record.appendLine(id, { role: 'warm', text: 'ping', warmId: 'W2', at: 5000 });
        await record.appendLine(id, { wm: { id: 'W2', phase: 'closed', trafficAt: 6000 } });
        await record.appendLine(id, {
          role: 'assistant',
          text: 'late W1',
          maintenance: true,
          warmId: 'W1',
          at: 3600000
        });
        if (!evidenceFirst) await record.appendLine(id, evidence);
        assert.equal(await record.recordedActivityAt(id), 4000);
        assert.equal(await record.recordedActivityAt(id, { includeWarm: true }), 6000);
        await record.appendLine(id, { wm: { ...evidence.wm, cached: 900 } });
        assert.equal(await record.recordedActivityAt(id, { includeWarm: true }), 6000);
      });
    }
  }

  it('never invents named receipt traffic without an owning confirmed input', async () => {
    const id = 'named-clock-missing';
    await record.appendLine(id, {
      role: 'assistant',
      text: 'orphan',
      maintenance: true,
      warmId: 'missing',
      at: 9000
    });
    assert.equal(await record.recordedActivityAt(id), undefined);
    assert.equal(await record.recordedActivityAt(id, { includeWarm: true }), undefined);
  });

  it('resolves a receipt before its input and keeps later accounting clock-neutral', async () => {
    const id = 'named-clock-reversed';
    await record.appendLine(id, {
      role: 'assistant',
      text: 'receipt',
      maintenance: true,
      warmId: 'W1',
      at: 9000
    });
    assert.equal(await record.recordedActivityAt(id, { includeWarm: true }), undefined);
    await record.appendLine(id, { wm: { id: 'W1', phase: 'closed', trafficAt: 2000 } });
    await record.appendLine(id, { role: 'warm', text: 'ping', warmId: 'W1', at: 1000 });
    assert.equal(await record.recordedActivityAt(id, { includeWarm: true }), 2000);
    await record.appendLine(id, {
      wm: { id: 'W1', phase: 'closed', trafficAt: 2000, cached: 900 }
    });
    assert.equal(await record.recordedActivityAt(id, { includeWarm: true }), 2000);
  });

  it('does not date the cache from a reserved input or a local error', async () => {
    await record.appendLine('attempt-only', { role: 'assistant', text: 'done', at: 1000 });
    await record.appendLine('attempt-only', { role: 'warm', text: 'ping', at: 5000 });
    await record.appendLine('attempt-only', { role: 'cli', text: 'write failed', at: 6000 });
    assert.equal(await record.recordedActivityAt('attempt-only', { includeWarm: true }), 1000);
    await record.appendLine('unknown-attempt', { role: 'warm', text: 'ping', at: 5000 });
    assert.equal(
      await record.recordedActivityAt('unknown-attempt', { includeWarm: true }),
      undefined
    );
  });
  it('keeps unsolicited output after the correlated warm completion', async () => {
    await record.appendLine('unsolicited', { role: 'warm', text: 'ping', at: 5000 });
    await record.appendLine('unsolicited', {
      role: 'assistant',
      text: 'OK',
      at: 6000,
      maintenance: true
    });
    await record.appendLine('unsolicited', {
      role: 'assistant',
      text: 'real work',
      at: 7000,
      maintenance: false
    });
    assert.equal(await record.recordedActivityAt('unsolicited'), 7000);
  });
});
