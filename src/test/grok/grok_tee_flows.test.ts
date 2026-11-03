import type { GrokTee } from './grok_tee_helpers';
/**
 * `core/grok/tee.ts` — Grok's notifications as the lines of our own record.
 *
 * The last case is the one worth having: the whole recorded turn 01a019f2 is
 * replayed through the tee and then **read back** through `readRecord`, because
 * the way this tee can lose data is invisible in the lines it emits. A `{ret}`
 * written before the line carrying its call is dropped by the fold, silently,
 * for good.
 */

import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { before, describe, it } from 'node:test';

import type { RecordLine } from '../../core/record';

import type { Authored, Exchange } from '../../core/transcript';

import { isMarker } from '../../core/transcript';

import {
  AT,
  Tee,
  callAt,
  endLines,
  linesOf,
  record,
  setup,
  take,
  update
} from './grok_tee_helpers';

import { repoRoot } from '../helpers';

let readGrokTranscript: typeof import('../../core/grok/transcript').readGrokTranscript;

const DIR = path.join(repoRoot(), 'src', 'test', 'fixtures', 'grok-01a019f2');

/** A `<system-reminder>` echo, as the wire delivers one: a `user_message_chunk`
 *  wearing the prompt ordinal Grok spends on its own synthetic turns. */
function reminder(body: string, promptIndex?: number): unknown {
  return {
    sessionId: 'g1',
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` },
      ...(promptIndex === undefined ? {} : { _meta: { promptIndex } })
    }
  };
}

/** The two notices observed here. `Monitor` says "for full output" where the
 *  other says "to see the full output" — which is why the line is dropped by
 *  its opening and not matched whole. */
const EXITED = (id: string): string =>
  `Background task "${id}" completed (exit code: 143).\n` +
  `Command: npm run dev | Duration: 195.0s\n` +
  `Use get_command_or_subagent_output("${id}") to see the full output.`;

/** **Its `Command:` block dropped, which is the only reason it fits.** The real
 *  one (record `01a02959`, line 9) echoes a python heredoc and its stripped body
 *  is 1198 characters against `cutOutput`'s 180 — 10 of the 26 notices on disk
 *  are over that cap. `truncates at the ceiling the disk reader sets` below is
 *  the case that holds the length; this one is here for the grammar. */
const WATCHED = (id: string): string =>
  `Monitor "${id}" ended: [monitor ended: exited (code 0)].\n` +
  `Description: Watch target session until it goes idle\n\n` +
  `Duration: 97.2s\n` +
  `Use get_command_or_subagent_output("${id}") for full output.`;

/** A monitor's completed update, which is the whole of where its task id is:
 *  `content` is `null` on this shape and the id is `rawOutput.taskId`, camel
 *  where the backgrounded-shell shape spells it `task_id`. Probed 2026-08-23
 *  over every `updates.jsonl` here — 8 monitor calls, all of them this. */
const monitorDone = (call: string, task: string): unknown =>
  update('tool_call_update', {
    toolCallId: call,
    status: 'completed',
    content: null,
    rawOutput: { type: 'Monitor', taskId: task, timeoutMs: 36_000_000, persistent: false }
  });

/** `_x.ai/task_completed` as 1.0.50 sends it (`background_cmd_2026_10_13`),
 *  trimmed to what the tee may read. */
const taskCompleted = (task: string, snapshot: object = {}, wake: unknown = true): unknown => ({
  sessionId: 'g1',
  update: {
    sessionUpdate: 'task_completed',
    task_snapshot: {
      task_id: task,
      output: 'probe-done\n',
      exit_code: 0,
      explicitly_killed: false,
      completed: true,
      owner_session_id: 'g1',
      ...snapshot
    },
    will_wake: wake
  }
});

/** A backgrounded shell call, its `BackgroundTaskStarted` result, and its
 *  turn's end — what the capture shows before the end arrives. */
function backgrounded(tee: GrokTee, call: string, task: string): void {
  take(tee, update('tool_call', { toolCallId: call, title: 'run_terminal_command' }));
  take(
    tee,
    update('tool_call_update', {
      toolCallId: call,
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: `Background task ${task} started` } }
      ],
      rawOutput: { type: 'BackgroundTaskStarted', task_id: task, task_type: 'bash' }
    })
  );
  endLines(tee);
}

const ended = (tee: GrokTee, params: unknown, at = AT): RecordLine[] =>
  linesOf(tee.teed('_x.ai/task_completed', params, at));
before(async () => {
  await setup();
  ({ readGrokTranscript } = await import('../../core/grok/transcript'));
});

describe('the recorded turn 01a019f2, teed and read back', () => {
  /** Every line the tee makes of the fixture's whole wire. */
  async function lines(): Promise<RecordLine[]> {
    const body = await fs.readFile(path.join(DIR, 'updates.jsonl'), 'utf8');
    const tee = new Tee();
    const out: RecordLine[] = [];
    for (const line of body.split('\n')) {
      if (!line) {
        continue;
      }
      const row = JSON.parse(line) as { method: string; params: unknown };
      out.push(...linesOf(tee.teed(row.method, row.params, AT)));
    }
    out.push(...endLines(tee));
    return out;
  }

  it("draws the same turns the CLI's own file does, shape for shape", async () => {
    // **Against `chat_history.jsonl` itself, not against a number.** The plan
    // said this conversation was "17 chunks, 17 assistant rows" and the first
    // build asserted 17 without ever opening the file. The file has **60**
    // assistant rows: the CLI writes one per batch of parallel calls, and only
    // 17 of them carry prose. A tee that piled every call onto the last chunk
    // passed a hardcoded 17 while a source swap changed the thread from 60
    // turns to 17. Peer review of 2026-08-20 (Grok, matt-code-review).
    const assistants = (turns: readonly unknown[]): Authored[] =>
      turns.filter(
        (turn): turn is Authored =>
          typeof turn === 'object' && turn !== null && 'role' in turn && turn.role === 'assistant'
      );
    const theirs = assistants(
      (await readGrokTranscript(path.join(DIR, 'chat_history.jsonl'))).exchanges
    );
    const ours = assistants(await lines());

    const shape = (turns: readonly Authored[]): string[] =>
      turns.map(
        (turn) =>
          `${turn.text.trim() ? 'prose' : 'silent'}+${(turn.blocks ?? []).filter((block) => 'call' in block).length}`
      );
    assert.deepEqual(shape(ours), shape(theirs), 'same turns, same calls on each');
    assert.equal(ours.length, 60, 'the row count the file actually holds');
    assert.equal(ours.filter((turn) => turn.text.trim()).length, 17, '17 of them said something');
  });

  it('keeps all 101 calls on the turns they were made from, through a round trip', async () => {
    for (const line of await lines()) {
      await record.appendLine('grok-fixture', line);
    }
    const read = await record.readRecord('grok-fixture');
    const turns = (read?.exchanges ?? []).filter((turn) => !isMarker(turn));
    const calls = turns
      .flatMap((turn) => (isMarker(turn) ? [] : (turn.blocks ?? [])))
      .flatMap((block) => ('call' in block ? [block.call] : []));
    assert.equal(calls.length, 101, "one prompt, 101 tools, every one on its own batch's turn");
    assert.equal(turns.length, 60, 'and the record reads back as the file reads');
  });
});

describe('a result that arrives before its own turn has been written', () => {
  it('survives the read back, which is the only place it can be seen to', async () => {
    // **The case the plan-review found.** `readRecord` folds a `{ret}` onto a
    // call it has *already walked*, so a result written before the line
    // carrying its call is dropped by the fold — silently, and for good. On
    // this wire that is the ordinary order: `tool_call_update` completed
    // arrives while the assistant line is still open, waiting for the next
    // chunk. Asserted after a round trip, because the emitted lines look right
    // either way.
    const tee = new Tee();
    const lines = [
      ...take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'listing' } })),
      ...take(tee, update('tool_call', { toolCallId: 'c1', title: 'run_terminal_command' })),
      ...take(
        tee,
        update('tool_call_update', {
          toolCallId: 'c1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'a.ts' } }]
        })
      ),
      ...take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'found it' } })),
      ...endLines(tee)
    ];
    for (const line of lines) {
      await record.appendLine('grok-ret', line);
    }
    const read = await record.readRecord('grok-ret');
    const calls = (read?.exchanges ?? [])
      .flatMap((turn) => (isMarker(turn) ? [] : (turn.blocks ?? [])))
      .flatMap((block) => ('call' in block ? [block.call] : []));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.output, 'a.ts', 'the call kept what it returned');
  });
});

describe('a background task reporting that it ended', () => {
  it('is the call it came from, not something the reader said', () => {
    // Grok wakes the model with a synthetic user turn when a backgrounded task
    // exits. Nine of these across the records here, none of them typed. The
    // disk walk has always refused them (`grok/transcript.ts` `userTurn`); this
    // wire echo is the half that drew them as YOU.
    const tee = new Tee();
    // The call it reports on, which is always on the wire first when the CLI
    // backgrounded it on timeout — that path names the call itself.
    take(
      tee,
      update('tool_call', { toolCallId: 'call-dfac7efa-109', title: 'run_terminal_command' })
    );
    endLines(tee);
    const lines = take(tee, reminder(EXITED('call-dfac7efa-109'), 1));
    assert.deepEqual(lines, [
      {
        ret: [
          {
            id: 'call-dfac7efa-109',
            output:
              'Background task completed (exit code: 143).\nCommand: npm run dev | Duration: 195.0s'
          }
        ]
      }
    ]);
  });

  it('reads the other grammar the same way', () => {
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'call-mon-3', title: 'Monitor' }));
    endLines(tee);
    const [line] = take(tee, reminder(WATCHED('call-mon-3')));
    assert.deepEqual(line, {
      ret: [
        {
          id: 'call-mon-3',
          output:
            'Monitor ended: [monitor ended: exited (code 0)].\n' +
            'Description: Watch target session until it goes idle\n\nDuration: 97.2s'
        }
      ]
    });
  });

  it('finds the call behind a task id the notice names instead', () => {
    // **`background: true` mints an id of its own.** Five of the nine notices
    // name a uuid rather than a call id, and the call ties itself to that uuid
    // on `rawOutput.task_id` — snake here, camel on a monitor. The prose beside
    // it says the same thing and is not read: it is absent on the other shape.
    // Auto-backgrounding on timeout is the other three, and those name the call
    // directly, which `task_id` also carries.
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'c9', title: 'run_terminal_command' }));
    take(
      tee,
      update('tool_call_update', {
        toolCallId: 'c9',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'Background task 01a02872 started' } }
        ],
        rawOutput: { type: 'BackgroundTaskStarted', task_id: '01a02872', task_type: 'bash' }
      })
    );
    // The turn ends, which clears `openCalls` — the notice lands long after.
    endLines(tee);
    const [line] = take(tee, reminder(EXITED('01a02872'), 2));
    assert.equal((line as { ret: { id: string }[] }).ret[0]?.id, 'c9');
  });

  it("finds the call behind a monitor's own task id, which is nowhere in its output", () => {
    // **The shape that has no prose to read.** A monitor completes with
    // `content: null` and its id only on `rawOutput.taskId`, so a build that
    // took the id out of `outputOf`'s string found nothing and dropped every
    // monitor notice — all four on disk, including the one the census filed as
    // "originating call outside the record's window". Record `01a02959` has
    // that call three lines above its notice, with no output, for good.
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'call-31d1aff9-10', title: 'monitor' }));
    take(tee, monitorDone('call-31d1aff9-10', '01a0295a-9763'));
    endLines(tee);
    const [line] = take(tee, reminder(WATCHED('01a0295a-9763'), 1));
    assert.equal((line as { ret: { id: string }[] }).ret[0]?.id, 'call-31d1aff9-10');
  });

  it('truncates at the ceiling the disk reader sets, and the exit status leads', () => {
    // 10 of the 26 notices on disk are over `cutOutput`'s 180, because
    // `Command:` carries the whole script. `Duration:` is the last kept line of
    // both grammars, so it is the first thing to go — the exit status is on
    // line 1 and always survives, which is the half that had to.
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'c8', title: 'monitor' }));
    take(tee, monitorDone('c8', 'task-long'));
    endLines(tee);
    const body =
      `Monitor "task-long" ended: [monitor ended: exited (code 0)].\n` +
      `Description: Wait until both review files are written\n` +
      `Command: while true; do\n${'  echo waiting for the reviews to land\n'.repeat(6)}done\n\n` +
      `Duration: 97.2s\n` +
      `Use get_command_or_subagent_output("task-long") for full output.`;
    const [line] = take(tee, reminder(body, 1));
    const output = (line as { ret: { output: string }[] }).ret[0]?.output ?? '';
    assert.equal(output.length, 181, '180 and the ellipsis `cutOutput` adds');
    assert.match(output, /^Monitor ended: \[monitor ended: exited \(code 0\)\]\./);
    assert.equal(output.includes('Duration:'), false, 'the duration is what truncation costs');
  });

  it('drops a notice with no call to fold onto, rather than inventing a turn', () => {
    // Observed once here: the originating call sat outside the window this
    // record covers. A line naming a task the reader cannot see is worse than
    // no line, and it is the same rule as every other reminder below.
    const tee = new Tee();
    assert.deepEqual(take(tee, reminder(EXITED('01a0295a-never-seen'), 1)), []);
  });

  it('drops a reminder that is not a notice at all', () => {
    const tee = new Tee();
    assert.deepEqual(take(tee, reminder('Skills are available.')), []);
    assert.deepEqual(take(tee, reminder('MCP servers that failed to connect:\n- linear')), []);
  });

  it('leaves a prompt that merely mentions one alone', () => {
    const tee = new Tee();
    const [line] = take(tee, {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'why did Background task "x" completed show up?' },
        _meta: { promptIndex: 4 }
      }
    });
    assert.equal((line as Authored).role, 'user', 'the wrapper is what makes it injected');
  });

  it('lands on the call after a read back, and witnesses nothing', async () => {
    // The fold is the only place this can be seen to work: a `{ret}` naming a
    // call `readRecord` has not walked is dropped silently. Here the call's
    // line was written turns ago, which is the case `Returned` exists for.
    const tee = new Tee();
    const lines = [
      ...take(
        tee,
        update('agent_message_chunk', { content: { type: 'text', text: 'starting it' } })
      ),
      ...take(tee, update('tool_call', { toolCallId: 'c1', title: 'run_terminal_command' })),
      ...take(
        tee,
        update('tool_call_update', {
          toolCallId: 'c1',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Command "npm run dev" … moved to background.' }
            }
          ]
        })
      ),
      ...endLines(tee),
      ...take(tee, reminder(EXITED('c1'), 1))
    ];
    for (const line of lines) {
      await record.appendLine('grok-notice', line);
    }
    const read = await record.readRecord('grok-notice');
    const calls = (read?.exchanges ?? [])
      .flatMap((turn) => (isMarker(turn) ? [] : (turn.blocks ?? [])))
      .flatMap((block) => ('call' in block ? [block.call] : []));
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.output ?? '', /^Background task completed \(exit code: 143\)\./);
    assert.equal(calls[0]?.failed, undefined, 'a kill is not the call reporting an error');
    assert.equal(
      (read?.exchanges ?? []).filter((turn) => !isMarker(turn) && turn.role === 'user').length,
      0,
      'nobody said anything'
    );
    assert.equal(read?.firstSeen.has('1'), false, 'and the ordinal goes with the turn');
  });

  it('lands even when the line carrying its call has not been flushed yet', async () => {
    // **The order inside `take` is the whole of why this works**, and nothing
    // else asserted it: `[...this.flush(), ...this.userTurn(…)]` writes the open
    // assistant line *before* the `{ret}` that names a call on it. Swap the two
    // spreads and every case above stays green — they all `endTurn()` first —
    // while the fold silently drops the notice, because `readRecord` only folds
    // onto calls it has already walked. No `turn_completed` here, which is the
    // one way the wire leaves a line open across a prompt.
    const tee = new Tee();
    const lines = [
      ...take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'watching' } })),
      ...take(tee, update('tool_call', { toolCallId: 'c2', title: 'monitor' })),
      ...take(tee, monitorDone('c2', 'task-open')),
      ...take(tee, reminder(WATCHED('task-open'), 1))
    ];
    for (const line of lines) {
      await record.appendLine('grok-open', line);
    }
    const read = await record.readRecord('grok-open');
    const calls = (read?.exchanges ?? [])
      .flatMap((turn) => (isMarker(turn) ? [] : (turn.blocks ?? [])))
      .flatMap((block) => ('call' in block ? [block.call] : []));
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.output ?? '', /^Monitor ended: \[monitor ended: exited \(code 0\)\]\./);
  });
});

describe('a background task ending, as 1.0.50 says it live', () => {
  it('replays the capture into the end on its call, then the trigger, ahead of the wake', async () => {
    const file = path.join(
      repoRoot(),
      'docs',
      'reference',
      'cli_state',
      'grok',
      'background_cmd_2026_10_13',
      'frames.jsonl'
    );
    const tee = new Tee();
    const lines: RecordLine[] = [];
    let endAt = 0;
    for (const raw of (await fs.readFile(file, 'utf8')).split('\n')) {
      if (!raw) continue;
      const row = JSON.parse(raw) as {
        t: number;
        dir: string;
        msg?: { method?: unknown; params?: unknown };
      };
      const method = row.msg?.method;
      if (row.dir !== 'in' || typeof method !== 'string' || 'id' in (row.msg ?? {})) continue;
      if (method === '_x.ai/task_completed') endAt = AT + row.t;
      lines.push(...linesOf(tee.teed(method, row.msg?.params, AT + row.t)));
    }
    const call = 'call-7bec4c7f-a969-43d1-9ee4-5a5131b1b996-0';
    const at = lines.findIndex((line) => 'ret' in line && line.ret[0]?.output === 'probe-done');
    assert.ok(at > 0, 'the end reached its call');
    assert.deepEqual(lines.slice(at, at + 2), [
      { ret: [{ id: call, output: 'probe-done' }] },
      { mark: 'trigger', trigger: 'task', status: 'completed', at: endAt }
    ]);
    assert.ok(
      lines
        .slice(0, at)
        .some(
          (line) => 'blocks' in line && line.blocks?.some((b) => 'call' in b && b.call.id === call)
        ),
      "the call's line was written before its end"
    );
    assert.ok(
      lines.slice(at + 2).some((line) => 'role' in line && line.role === 'assistant'),
      "the wake's answer follows the trigger"
    );
  });

  it('maps the snapshot to the status the marker carries', () => {
    const cases: [object, string | undefined][] = [
      [{ exit_code: 0 }, 'completed'],
      [{ exit_code: 2 }, 'failed'],
      [{ exit_code: 143, explicitly_killed: true }, 'stopped'],
      [{ exit_code: null }, undefined]
    ];
    for (const [snapshot, status] of cases) {
      const tee = new Tee();
      backgrounded(tee, 'c1', 't1');
      assert.deepEqual(ended(tee, taskCompleted('t1', snapshot))[1], {
        mark: 'trigger',
        trigger: 'task',
        ...(status ? { status } : {}),
        at: AT
      });
    }
  });

  it('marks nothing when the CLI starts no turn for it', () => {
    const tee = new Tee();
    backgrounded(tee, 'c1', 't1');
    assert.deepEqual(ended(tee, taskCompleted('t1', {}, false)), [
      { ret: [{ id: 'c1', output: 'probe-done' }] }
    ]);
  });

  it('overwrites the started notice when the command printed nothing', () => {
    const tee = new Tee();
    backgrounded(tee, 'c1', 't1');
    const [ret] = ended(tee, taskCompleted('t1', { output: '' }, false));
    assert.deepEqual(ret, { ret: [{ id: 'c1', output: '' }] });
  });

  it('drops an end whose task this record never saw, when no turn follows', () => {
    // One that wakes is a subagent's command handed over, and is marked: see
    // "a subagent ending, and the command it handed over".
    const tee = new Tee();
    assert.deepEqual(ended(tee, taskCompleted('elsewhere', {}, false)), []);
  });

  it('lands on a call whose line is still open, wake or not', () => {
    // `callFor` is seeded while the call's line is unflushed, and a `{ret}`
    // written ahead of its call is dropped by the read for good.
    for (const wake of [true, false]) {
      const tee = new Tee();
      take(tee, update('tool_call', { toolCallId: 'c1', title: 'run_terminal_command' }));
      take(
        tee,
        update('tool_call_update', {
          toolCallId: 'c1',
          status: 'completed',
          rawOutput: { type: 'BackgroundTaskStarted', task_id: 't1' }
        })
      );
      const lines = [...ended(tee, taskCompleted('t1', {}, wake)), ...endLines(tee)];
      const fold = new record.RecordFold();
      for (const line of lines) fold.push(line);
      const [turn, ...rest] = fold.snapshot().exchanges;
      assert.equal(callAt(turn, 0)?.output, 'probe-done', `wake ${wake}`);
      assert.deepEqual(
        rest.filter(isMarker),
        wake ? [{ mark: 'trigger', trigger: 'task', status: 'completed', at: AT }] : []
      );
    }
  });

  it('puts work still open from another call ahead of the trigger', () => {
    // The ended call flushed long ago; a new tool-only line is still open when
    // Grok wakes. That line is the old turn's work and must not land in the
    // woken turn's fold.
    const tee = new Tee();
    backgrounded(tee, 'c1', 't1');
    take(tee, update('tool_call', { toolCallId: 'c2', title: 'read_file' }));
    const lines = ended(tee, taskCompleted('t1'));
    assert.deepEqual(
      lines.map((line) => ('mark' in line ? 'trigger' : 'ret' in line ? 'ret' : 'line')),
      ['line', 'ret', 'trigger']
    );
    assert.equal(callAt(lines[0] as Exchange, 0)?.id, 'c2');
  });

  it('adds nothing when an older build also echoes the reminder', () => {
    const tee = new Tee();
    backgrounded(tee, 'c1', 't1');
    ended(tee, taskCompleted('t1'));
    assert.deepEqual(take(tee, reminder(EXITED('t1'), 3)), []);
  });
});

describe('a subagent ending, and the command it handed over, as 1.0.52 says it', () => {
  // `cli_state/grok/subagent_cmd_2026_10_14/`: a subagent is a child session
  // on the same pipe, dropped by `GrokSession` before the tee, so this replay
  // drops it too. Two of its ends still wake the parent.
  const capture = (name: string) =>
    path.join(
      repoRoot(),
      'docs',
      'reference',
      'cli_state',
      'grok',
      'subagent_cmd_2026_10_14',
      name
    );

  /** The parent's notifications through one tee, as `GrokSession` hands them over. */
  async function replay(name: string): Promise<RecordLine[]> {
    const tee = new Tee();
    const lines: RecordLine[] = [];
    let parent: string | undefined;
    for (const raw of (await fs.readFile(capture(name), 'utf8')).split('\n')) {
      if (!raw) continue;
      const row = JSON.parse(raw) as {
        t: number;
        dir: string;
        msg?: { method?: unknown; params?: unknown; result?: unknown };
      };
      if (row.dir !== 'in') continue;
      const result = row.msg?.result;
      if (!parent && result && typeof result === 'object' && 'sessionId' in result) {
        parent = String(result.sessionId);
      }
      const method = row.msg?.method;
      if (typeof method !== 'string' || 'id' in (row.msg ?? {})) continue;
      const params = row.msg?.params;
      const session =
        params && typeof params === 'object' && 'sessionId' in params
          ? params.sessionId
          : undefined;
      if (typeof session === 'string' && session !== parent) continue;
      lines.push(...linesOf(tee.teed(method, params, AT + row.t)));
    }
    return lines;
  }

  const triggers = (lines: RecordLine[]) => lines.filter((line) => 'mark' in line);

  it('marks a background subagent ending as an agent', async () => {
    assert.deepEqual(triggers(await replay('bgsubagent.frames.jsonl')), [
      { mark: 'trigger', trigger: 'agent', status: 'completed', at: AT + 17_502 }
    ]);
  });

  it('marks the command a subagent handed over, with no call of its own here', async () => {
    const lines = await replay('subagent.frames.jsonl');
    const marks = triggers(lines);
    assert.equal(marks.length, 1);
    assert.equal(marks[0] && 'trigger' in marks[0] ? marks[0].trigger : undefined, 'task');
    assert.equal(marks[0] && 'status' in marks[0] ? marks[0].status : undefined, 'completed');
    const at = lines.indexOf(marks[0] as RecordLine);
    assert.ok(
      !('ret' in (lines[at - 1] ?? {})),
      'no {ret} rides with it: the call is in the child'
    );
  });

  it('marks nothing when the subagent ran everything in the foreground', async () => {
    assert.deepEqual(triggers(await replay('subagent_run1_not_backgrounded.frames.jsonl')), []);
  });

  it("marks the session's own background command as before", async () => {
    const marks = triggers(await replay('control.frames.jsonl'));
    assert.equal(marks.length, 1);
    assert.equal(marks[0] && 'trigger' in marks[0] ? marks[0].trigger : undefined, 'task');
  });

  it('writes nothing for a replayed subagent end, wherever the replay flag sits', () => {
    const update = {
      sessionUpdate: 'subagent_finished',
      subagent_id: 'a1',
      status: 'completed',
      will_wake: true
    };
    for (const params of [
      { sessionId: 's', update, _meta: { isReplay: true } },
      { sessionId: 's', update: { ...update, _meta: { isReplay: true } } }
    ]) {
      assert.deepEqual(linesOf(new Tee().teed('_x.ai/session_notification', params, AT)), []);
    }
  });

  it('writes nothing for a subagent the turn waited on', () => {
    const params = {
      sessionId: 's',
      update: { sessionUpdate: 'subagent_finished', subagent_id: 'a1', will_wake: false }
    };
    assert.deepEqual(linesOf(new Tee().teed('_x.ai/session_notification', params, AT)), []);
  });

  it('flushes the open line before a call-less wake, so the work stays in the turn before', () => {
    const tee = new Tee();
    const open = linesOf(
      tee.teed(
        'session/update',
        {
          sessionId: 's',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'waiting on it' }
          }
        },
        AT
      )
    );
    assert.deepEqual(open, []);
    const lines = linesOf(
      tee.teed(
        '_x.ai/session_notification',
        {
          sessionId: 's',
          update: {
            sessionUpdate: 'subagent_finished',
            subagent_id: 'a1',
            status: 'completed',
            will_wake: true
          }
        },
        AT + 5
      )
    );
    assert.equal(lines.length, 2);
    assert.equal(lines[0] && 'role' in lines[0] ? lines[0].role : undefined, 'assistant');
    assert.deepEqual(lines[1], {
      mark: 'trigger',
      trigger: 'agent',
      status: 'completed',
      at: AT + 5
    });
  });

  it('marks a wake once when its call becomes known after it, and lands the output', () => {
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'c1', title: 'run_terminal_command' }));
    const first = ended(tee, taskCompleted('t1'));
    assert.deepEqual(first.filter((line) => 'mark' in line).length, 1);
    take(
      tee,
      update('tool_call_update', {
        toolCallId: 'c1',
        status: 'completed',
        rawOutput: { type: 'BackgroundTaskStarted', task_id: 't1' }
      })
    );
    endLines(tee);
    const again = ended(tee, taskCompleted('t1'), AT + 1);
    assert.deepEqual(again, [{ ret: [{ id: 'c1', output: 'probe-done' }] }]);
  });

  it('marks a repeated call-less end once, for either cause', () => {
    const tee = new Tee();
    const finished = {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'subagent_finished',
        subagent_id: 'a1',
        status: 'completed',
        will_wake: true
      }
    };
    const marks = [
      ...ended(tee, taskCompleted('t9')),
      ...ended(tee, taskCompleted('t9')),
      ...linesOf(tee.teed('_x.ai/session_notification', finished, AT)),
      ...linesOf(tee.teed('_x.ai/session_notification', finished, AT))
    ].filter((line) => 'mark' in line);
    assert.deepEqual(
      marks.map((line) => ('trigger' in line ? line.trigger : undefined)),
      ['task', 'agent']
    );
  });

  it('lets a live end through after a replayed one, which changed nothing', () => {
    const tee = new Tee();
    const finished = (meta?: object) => ({
      sessionId: 'g1',
      update: {
        sessionUpdate: 'subagent_finished',
        subagent_id: 'a2',
        status: 'completed',
        will_wake: true
      },
      ...(meta ? { _meta: meta } : {})
    });
    assert.deepEqual(
      linesOf(tee.teed('_x.ai/session_notification', finished({ isReplay: true }), AT)),
      []
    );
    assert.deepEqual(linesOf(tee.teed('_x.ai/session_notification', finished(), AT)), [
      { mark: 'trigger', trigger: 'agent', status: 'completed', at: AT }
    ]);
  });
});
