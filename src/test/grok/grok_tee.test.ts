import * as path from 'node:path';
import { wrapMessage } from '../../core/coordination/send';
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

import { before, describe, it } from 'node:test';

import { wrapWait } from '../../core/coordination/send';

import type { RecordLine } from '../../core/record';

import type { Exchange } from '../../core/transcript';

import { isMarker } from '../../core/transcript';

import {
  AT,
  callAt,
  endLines,
  GrokTee,
  linesOf,
  setup,
  take,
  Tee,
  update
} from './grok_tee_helpers';

let LATE_MS: number;

/** An absolute path under `/repo` as the tee resolves one: on win32 that is
 *  `C:\repo\…`, so a POSIX literal would never match. */
const repo = (...parts: string[]): string => path.resolve('/repo', ...parts);

/** A message from another session, in the one spelling `core/coordination/send.ts` writes. */
const WRAPPED = wrapMessage('look at this', 'peer 42');

/** The text of the one line a close landed, or nothing. */
function onlyText(lines: readonly RecordLine[]): string | undefined {
  const [line] = lines;
  return line && 'text' in line ? line.text : undefined;
}
before(async () => {
  await setup();
  ({ LATE_MS } = await import('../../core/thread'));
});

describe('GrokTee.teed', () => {
  it('preserves write metadata before bounding tool input and keeps it on its batch', () => {
    const tee = new Tee(repo());
    const context = 'unchanged\n'.repeat(100);
    const calls = [
      { title: 'write', rawInput: { file_path: repo('a.ts'), content: 'x\n'.repeat(200) } },
      {
        title: 'search_replace',
        rawInput: {
          file_path: 'b.ts',
          old_string: context + 'old\n',
          new_string: context + 'new\nextra\n'
        }
      },
      {
        title: 'search_replace',
        rawInput: { file_path: 'b.ts', old_string: 'a\n', new_string: 'b\nc\n' }
      }
    ];
    for (const [index, call] of calls.entries()) {
      assert.deepEqual(
        take(tee, update('tool_call', { toolCallId: `call-aaa-${index}`, ...call })),
        []
      );
    }
    const [written] = take(
      tee,
      update('tool_call', {
        toolCallId: 'call-bbb-0',
        title: 'read_file',
        rawInput: { file_path: '/repo/read.ts' }
      })
    ) as Exchange[];
    assert.ok(written && !isMarker(written));
    assert.deepEqual(written.files, [repo('a.ts'), repo('b.ts')]);
    assert.deepEqual(written.sizes, {
      [repo('a.ts')]: { add: 200, del: 0 },
      [repo('b.ts')]: { add: 4, del: 2 }
    });
    assert.equal((callAt(written, 0)?.input?.content as string).length, 300);
    const [read] = endLines(tee) as Exchange[];
    assert.ok(read && !isMarker(read));
    assert.equal(read.files, undefined);
    assert.equal(read.sizes, undefined);
    assert.deepEqual(endLines(tee), []);
  });

  it('keeps an unreadable write size unknown and ignores malformed input and unresolved paths', () => {
    const tee = new Tee();
    const inputs = [
      { file_path: repo('unknown.ts'), old_string: 'a' },
      { file_path: 'relative.ts', old_string: 'a', new_string: 'b' },
      null,
      [],
      'bad',
      7
    ];
    for (const [index, rawInput] of inputs.entries()) {
      take(
        tee,
        update('tool_call', { toolCallId: `call-aaa-${index}`, title: 'search_replace', rawInput })
      );
    }
    const [line] = endLines(tee) as Exchange[];
    assert.ok(line && !isMarker(line));
    assert.deepEqual(line.files, [repo('unknown.ts')]);
    assert.equal(line.sizes, undefined);
  });

  it('is total over what another program wrote', () => {
    const tee = new Tee();
    for (const params of [null, undefined, 0, 'x', [], {}, { update: null }, { update: {} }]) {
      assert.deepEqual(take(tee, params), [], `${JSON.stringify(params ?? null)} is not a line`);
    }
    assert.deepEqual(take(tee, update('never_heard_of_it')), []);
    assert.deepEqual(take(tee, update('available_commands_update', { tools: [] })), []);
    assert.deepEqual(
      take(tee, update('agent_thought_chunk', { content: { type: 'text', text: 'hmm' } })),
      [],
      'reasoning is not a turn on either side'
    );
  });

  it('drops a replayed notification, whichever meta wears the flag', () => {
    // Probed 2026-08-20, 1.0.5: `session/load` puts `isReplay` on `params._meta`
    // and the replayed `user_message_chunk` carries an `update._meta` holding
    // `promptIndex` with no flag beside it.
    const outer = new Tee();
    assert.deepEqual(
      take(
        outer,
        update('user_message_chunk', { content: { type: 'text', text: 'old' } }, { isReplay: true })
      ),
      [],
      'the flag rides the params on this build'
    );
    const inner = new Tee();
    assert.deepEqual(
      take(inner, {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'old' },
          _meta: { isReplay: true, promptIndex: 3 }
        }
      }),
      [],
      'and the inner one is tested anyway'
    );
  });

  it('makes the echo the user turn, with the prompt ordinal on its own line', () => {
    const tee = new Tee();
    const [line] = take(tee, {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'ping' },
        _meta: { modelId: 'grok-4.6', promptIndex: 0 }
      }
    });
    assert.deepEqual(line, {
      role: 'user',
      text: 'ping',
      at: AT,
      // The dock paints `blocks`; a turn with only `text` is a label over an
      // empty body.
      blocks: [{ text: 'ping' }],
      m: '0'
    });
  });

  it('does not duplicate a prompt seen on both the live pipe and disk', () => {
    const tee = new Tee();
    const params = update('user_message_chunk', {
      content: { type: 'text', text: 'same prompt' },
      _meta: { promptIndex: 8 }
    });
    assert.equal(take(tee, params).length, 1);
    assert.equal(tee.recoveredUser('session/update', params, AT), undefined);
    const diskFirst = new Tee();
    assert.ok(diskFirst.recoveredUser('session/update', params, AT));
    assert.deepEqual(take(diskFirst, params), []);
  });

  it('still writes the turn when the echo names no ordinal', () => {
    const tee = new Tee();
    const [line] = take(
      tee,
      update('user_message_chunk', { content: { type: 'text', text: 'yo' } })
    );
    assert.deepEqual(line, { role: 'user', text: 'yo', at: AT, blocks: [{ text: 'yo' }] });
  });

  it('writes the turn for an echo of nothing but a picture, so its ordinal is stamped', () => {
    // Probed 2026-08-20 (1.0.5): an image-only prompt echoes
    // `{type:"image",data,mimeType}` and no text, while the disk row for it
    // still carries `prompt_index`. Dropped here, that ordinal is in `theirs`
    // and never in ours — the card falls back for the rest of the
    // conversation, and the pictures the drain copied go with it.
    const tee = new Tee();
    const [line] = take(tee, {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
        _meta: { modelId: 'grok-4.6', promptIndex: 4 }
      }
    });
    assert.deepEqual(line, { role: 'user', text: '', at: AT, m: '4' });
  });

  it('writes nothing for an echo with neither text nor an ordinal', () => {
    const tee = new Tee();
    assert.deepEqual(take(tee, update('user_message_chunk', { content: {} })), []);
  });

  it('unwraps a cross-session message the way the disk walk does', () => {
    const tee = new Tee();
    const [line] = take(
      tee,
      update('user_message_chunk', { content: { type: 'text', text: WRAPPED } })
    );
    const turn = line as Exchange;
    assert.ok(!isMarker(turn) && turn.role === 'user');
    assert.equal(!isMarker(turn) && turn.text, 'look at this');
    assert.ok((turn as { from?: unknown }).from, 'and it says who sent it');
  });

  it('draws a converged wait as its own author, naming nobody', () => {
    const tee = new Tee();
    const said = 'All 2 sessions you were waiting on have finished.';
    const [line] = take(
      tee,
      update('user_message_chunk', { content: { type: 'text', text: wrapWait(said) } })
    );
    const turn = line as Exchange;
    assert.ok(!isMarker(turn) && turn.role === 'wait');
    assert.equal(!isMarker(turn) && turn.text, said);
    // No author, and that is the point: nothing composed this but the window,
    // and a `from` would win over the role and draw it as a peer's message.
    assert.equal((turn as { from?: unknown }).from, undefined);
    // The dock paints `blocks` and has no fallback — a `wait` turn with only
    // `text` is a label over an empty body.
    assert.deepEqual(!isMarker(turn) && turn.blocks, [{ text: said }]);
  });
});

describe('the open assistant line', () => {
  it('joins the chunks of one message, so a burst is one turn', () => {
    // **A chunk is a token delta, not a message.** Measured 2026-08-22
    // (grok-4.6, session `01a02588`): one 68-character reply came as 14 chunks
    // of a word or two, and a tee that opened a line per chunk wrote 44
    // assistant rows where `chat_history.jsonl` wrote 4 — the dock drew a
    // column of one-word turns.
    const tee = new Tee();
    for (const text of ['one', ' and', ' two']) {
      assert.deepEqual(
        take(tee, update('agent_message_chunk', { content: { type: 'text', text } })),
        [],
        'nothing lands until something closes the line'
      );
    }
    assert.deepEqual(endLines(tee), [
      { role: 'assistant', text: 'one and two', blocks: [{ text: 'one and two' }], at: AT }
    ]);
  });

  it('stamps the joined turn with when it started, not when it ended', () => {
    const tee = new Tee();
    linesOf(
      tee.teed(
        'session/update',
        update('agent_message_chunk', { content: { type: 'text', text: 'a' } }),
        AT
      )
    );
    linesOf(
      tee.teed(
        'session/update',
        update('agent_message_chunk', { content: { type: 'text', text: 'b' } }),
        AT + 900
      )
    );
    assert.deepEqual(endLines(tee), [
      { role: 'assistant', text: 'ab', blocks: [{ text: 'ab' }], at: AT }
    ]);
  });

  it('closes the row at its batch, so the prose after a call is the next turn', () => {
    // The whole assistant half of the live conversation `01a02588`, at the
    // wire's own granularity. `chat_history.jsonl` holds it as two assistant
    // rows — prose plus the call it made, then the prose that followed the
    // result — and so must this.
    const tee = new Tee();
    const said = ["I'll", ' run', ' the', ' command', '.'];
    const then = ['Exit', ' code', ': ', '**0**'];
    const out: RecordLine[] = [];
    for (const text of said) {
      out.push(...take(tee, update('agent_message_chunk', { content: { type: 'text', text } })));
    }
    out.push(
      ...take(
        tee,
        update('tool_call', { toolCallId: 'call-fe8d-0', title: 'run_terminal_command' })
      )
    );
    for (const text of then) {
      out.push(...take(tee, update('agent_message_chunk', { content: { type: 'text', text } })));
    }
    out.push(...endLines(tee));

    assert.equal(out.length, 2, 'two assistant rows, as the CLI wrote two');
    const [first, second] = out as Exchange[];
    assert.ok(first && !isMarker(first) && first.text === "I'll run the command.");
    assert.equal(callAt(first, 1)?.id, 'call-fe8d-0', 'the call is on the row its prose opened');
    assert.ok(second && !isMarker(second) && second.text === 'Exit code: **0**');
    assert.deepEqual(
      second && !isMarker(second) ? second.blocks : undefined,
      [{ text: 'Exit code: **0**' }],
      'and carries no call of its own'
    );
  });

  it('puts the calls that follow a chunk on that chunk s turn', () => {
    const tee = new Tee();
    take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'reading' } }));
    take(
      tee,
      update('tool_call', {
        toolCallId: 'c1',
        title: 'read_file',
        rawInput: { target_file: '/tmp/a.ts' },
        _meta: { 'x.ai/tool': { name: 'read_file', label: 'Read' } }
      })
    );
    const [line] = endLines(tee) as Exchange[];
    assert.ok(line && !isMarker(line));
    const call = callAt(line, 1);
    assert.equal(call?.id, 'c1');
    assert.equal(call?.name, 'Read', 'named as the disk reader names it, not `read_file`');
    assert.deepEqual(call?.input, { target_file: '/tmp/a.ts' });
  });

  it('starts a new turn when the batch changes, and is not fooled by a nameless call', () => {
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'call-aaa-0', title: 'read_file' }));
    take(tee, update('tool_call', { toolCallId: 'call-aaa-1', title: 'read_file' }));
    // Same batch so far: one row, two calls — as `chat_history.jsonl` writes it.
    assert.deepEqual(take(tee, update('tool_call', { toolCallId: 'call-bbb-0', title: 'grep' })), [
      {
        role: 'assistant',
        text: '',
        blocks: [
          { call: { id: 'call-aaa-0', name: 'Read' } },
          { call: { id: 'call-aaa-1', name: 'Read' } }
        ],
        at: AT
      }
    ]);
    // A call the CLI named nothing must not hold the line open across the
    // batches after it: `batchOf('')` is `''`, which reads as falsy.
    const nameless = new Tee();
    take(nameless, update('tool_call', { title: 'read_file' }));
    assert.equal(
      take(nameless, update('tool_call', { toolCallId: 'call-ccc-0', title: 'grep' })).length,
      1
    );
  });

  it('fills a result into the call while its line is still open', () => {
    const tee = new Tee();
    take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'ls' } }));
    take(tee, update('tool_call', { toolCallId: 'c1', title: 'run_terminal_command' }));
    const nothing = take(
      tee,
      update('tool_call_update', {
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a.ts\nb.ts' } }]
      })
    );
    assert.deepEqual(nothing, [], 'no `{ret}` — the call has not been written yet');
    const [line] = endLines(tee) as Exchange[];
    // `blocks[0]` is the chunk's prose; the call follows it on the same turn.
    const call = callAt(line, 1);
    assert.equal(call?.output, 'a.ts\nb.ts', 'the output rides the call it belongs to');
  });

  it('writes a `{ret}` for a call whose line has already landed', () => {
    const tee = new Tee();
    take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'ls' } }));
    take(tee, update('tool_call', { toolCallId: 'c1', title: 'run_terminal_command' }));
    endLines(tee);
    const lines = take(
      tee,
      update('tool_call_update', { toolCallId: 'c1', status: 'failed', rawOutput: 'boom' })
    );
    assert.deepEqual(lines, [{ ret: [{ id: 'c1', output: 'boom', failed: true }] }]);
  });

  it('lifts a markdown image out of the flushed prose, as the disk reader does', () => {
    const tee = new Tee(repo(), 's1');
    take(
      tee,
      update('agent_message_chunk', {
        content: { type: 'text', text: 'see\n\n![Aperture](.impeccable/mocks/a.jpg)\n' }
      })
    );
    const [line] = endLines(tee) as Exchange[];
    assert.ok(line && !isMarker(line));
    assert.deepEqual(line.images, [{ id: `f|s1.t0.${AT}|0.0|${repo('.impeccable/mocks/a.jpg')}` }]);
    assert.doesNotMatch(
      (line.blocks ?? []).flatMap((block) => ('text' in block ? [block.text] : [])).join(''),
      /!\[|a\.jpg/
    );
    assert.match(line.text, /!\[Aperture\]/);
  });

  it('numbers flushed turns so two renders of one path do not share a cache key', () => {
    const tee = new Tee('', 's1');
    take(
      tee,
      update('agent_message_chunk', { content: { type: 'text', text: '![a](/tmp/x.png)' } })
    );
    const [first] = endLines(tee) as Exchange[];
    take(
      tee,
      update('agent_message_chunk', { content: { type: 'text', text: '![b](/tmp/x.png)' } })
    );
    const [second] = endLines(tee) as Exchange[];
    assert.equal(
      first && !isMarker(first) ? first.images?.[0]?.id : undefined,
      `f|s1.t0.${AT}|0.0|/tmp/x.png`
    );
    assert.equal(
      second && !isMarker(second) ? second.images?.[0]?.id : undefined,
      `f|s1.t1.${AT}|0.0|/tmp/x.png`
    );
  });

  it('cuts a long output to the ceiling the disk reader uses', () => {
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'c1', title: 'read_file' }));
    endLines(tee);
    const [line] = take(
      tee,
      update('tool_call_update', {
        toolCallId: 'c1',
        status: 'completed',
        rawOutput: 'x'.repeat(400)
      })
    ) as { ret: { output: string }[] }[];
    assert.equal(line?.ret[0]?.output.length, 181, '180 and the ellipsis that says it was cut');
  });

  it('takes a turn end on the method 1.0.5 actually sends it on', () => {
    // 7/7 `turn_completed` rode `_x.ai/session_notification` on the 1.0.5 probe
    // and zero rode `session/update`. Every other case here goes through
    // `take`, which hardcodes `session/update`, and the fixture's own
    // `turn_completed` is the disk spelling — so without this case a tee that
    // stopped reading the live method would never flush a turn's last line and
    // nothing would fail.
    const tee = new Tee();
    linesOf(
      tee.teed(
        'session/update',
        update('agent_message_chunk', { content: { type: 'text', text: 'done' } }),
        AT
      )
    );
    const lines = linesOf(tee.teed('_x.ai/session_notification', update('turn_completed', {}), AT));
    assert.deepEqual(lines, [
      { role: 'assistant', text: 'done', blocks: [{ text: 'done' }], at: AT }
    ]);
  });

  it("writes the CLI's own alarm turn, which the record would otherwise not have", () => {
    // An API error or a usage limit is not a `chat_history.jsonl` type at all:
    // the fallback reader rebuilds it from `updates.jsonl` (`placeAlarms`), so
    // a record drawn instead of that file would simply not have the turn.
    const tee = new Tee();
    take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'working' } }));
    const lines = take(
      tee,
      update('turn_completed', {
        stop_reason: 'error',
        agent_result: 'API error (status 402 Payment Required): balance exhausted'
      })
    );
    assert.deepEqual(lines, [
      { role: 'assistant', text: 'working', blocks: [{ text: 'working' }], at: AT },
      {
        role: 'cli',
        text: 'API error (status 402 Payment Required): balance exhausted',
        blocks: [{ text: 'API error (status 402 Payment Required): balance exhausted' }],
        at: AT
      }
    ]);
  });

  it('fills an answered ask onto its call while that line is still open', () => {
    // An ask **is** a tool call here, so the answer lands while the line
    // carrying it is open. A `{ret}` written then names a call `readRecord` has
    // not walked and is dropped by the fold — the peer review of 2026-08-20.
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'call-ask-1', title: 'ask_user_question' }));
    const ask = { questions: [], answers: { Which: 'Left' }, annotations: {} };
    assert.deepEqual(tee.answered('call-ask-1', ask), [], 'no `{ret}`: the call is still open');
    const [line] = endLines(tee) as Exchange[];
    assert.equal(callAt(line, 0)?.ask, ask);
  });

  it('writes a `{ret}` for an ask whose call has already landed', () => {
    const tee = new Tee();
    take(tee, update('tool_call', { toolCallId: 'call-ask-1', title: 'ask_user_question' }));
    endLines(tee);
    const ask = { questions: [], answers: { Which: 'Left' }, annotations: {} };
    assert.deepEqual(tee.answered('call-ask-1', ask), [{ ret: [{ id: 'call-ask-1', ask }] }]);
  });

  it('lands the line on a turn that ended', () => {
    const tee = new Tee();
    take(tee, update('agent_message_chunk', { content: { type: 'text', text: 'done' } }));
    assert.deepEqual(endLines(tee), [
      { role: 'assistant', text: 'done', blocks: [{ text: 'done' }], at: AT }
    ]);
    assert.deepEqual(endLines(tee), [], 'flushing twice is free — the second finds nothing open');
  });
});

describe('GrokTee.teed', () => {
  const said = (text: string) => ({ content: { type: 'text', text } });
  const chunk = (tee: GrokTee, text: string, stream: number, promptId?: string) =>
    tee.teed(
      'session/update',
      update('agent_message_chunk', said(text), { streamStartMs: stream, promptId }),
      AT
    );
  const closed = (tee: GrokTee, prompt: string, stop: string) =>
    tee.teed(
      'session/update',
      update('turn_completed', { prompt_id: prompt, stop_reason: stop }),
      AT
    );

  it('streams a line under its row and lands it on that row', () => {
    const tee = new Tee();
    const [first] = chunk(tee, 'Hello', 1, 'p1');
    assert.ok(first?.kind === 'stream');
    assert.deepEqual(chunk(tee, ' there', 1, 'p1'), [
      { kind: 'stream', row: first.row, delta: ' there', at: AT }
    ]);
    assert.deepEqual(closed(tee, 'p1', 'end_turn'), [
      {
        kind: 'close',
        row: first.row,
        cut: false,
        line: { role: 'assistant', text: 'Hello there', blocks: [{ text: 'Hello there' }], at: AT }
      }
    ]);
  });

  it('cuts a line its close did not complete, and binds what that stream sends after', () => {
    const tee = new Tee();
    const [first] = chunk(tee, 'Half', 1, 'p1');
    assert.ok(first?.kind === 'stream');
    assert.deepEqual(
      closed(tee, 'p1', 'cancelled').map((op) => (op.kind === 'close' ? [op.row, op.cut] : op)),
      [[first.row, true], { kind: 'line', line: { mark: 'break' } }]
    );
    assert.deepEqual(
      chunk(tee, ' more', 1),
      [{ kind: 'stream', row: first.row, delta: ' more', at: AT, late: true }],
      'the cut row takes it; no line opens'
    );
    assert.deepEqual(endLines(tee), [], 'nothing is open');
    assert.deepEqual(tee.closeTurn({ turn: 'p1', stop: 'cancelled', last: true }, AT), [
      { kind: 'seal', row: first.row }
    ]);
  });

  it('marks a new interrupt even when it also names an already superseded wake', () => {
    const tee = new Tee();
    const divider = [{ kind: 'line', line: { mark: 'break' } }];
    assert.deepEqual(tee.closeTurn({ cut: true, interrupted: ['wake'] }, AT), divider);
    assert.deepEqual(tee.closeTurn({ cut: true, interrupted: ['next', 'wake'] }, AT), divider);
    assert.deepEqual(tee.closeTurn({ turn: 'next', stop: 'cancelled' }, AT), []);
    assert.deepEqual(tee.closeTurn({ turn: 'wake', stop: 'cancelled' }, AT), []);
  });

  it("routes a cut line's late text past another model call's line, without closing it", () => {
    // Send now: the first prompt's stream is cut, the next prompt streams, and
    // the cut stream's last chunk arrives only then.
    const tee = new Tee();
    const [first] = chunk(tee, 'Cut', 1, 'p1');
    assert.ok(first?.kind === 'stream');
    closed(tee, 'p1', 'cancelled');
    const [next] = chunk(tee, 'Next', 2, 'p2');
    assert.ok(
      next?.kind === 'stream' && next.row !== first.row,
      'the next call opens its own line'
    );
    assert.deepEqual(
      chunk(tee, ' late', 1),
      [{ kind: 'stream', row: first.row, delta: ' late', at: AT, late: true }],
      'the late text goes to the cut row, and the open line stays open'
    );
    assert.deepEqual(chunk(tee, ' more', 2, 'p2'), [
      { kind: 'stream', row: next.row, delta: ' more', at: AT }
    ]);
    assert.deepEqual(tee.closeTurn({ turn: 'p1', stop: 'cancelled', last: true }, AT), [
      { kind: 'seal', row: first.row }
    ]);
  });

  it('routes text of a stream its last closer sealed to its row, and opens nothing', () => {
    // Whether the row still takes it is the thread's to say (`Conversation.stream`).
    const tee = new Tee();
    const [first] = chunk(tee, 'Cut', 1, 'p1');
    assert.ok(first?.kind === 'stream');
    closed(tee, 'p1', 'cancelled');
    tee.closeTurn({ turn: 'p1', stop: 'cancelled', last: true }, AT);
    chunk(tee, 'Next', 2, 'p2');
    assert.deepEqual(chunk(tee, ' stale', 1), [
      { kind: 'stream', row: first.row, delta: ' stale', at: AT, late: true }
    ]);
    assert.deepEqual(
      endLines(tee).map((line) => 'text' in line && line.text),
      ['Next']
    );
  });

  it('routes text of a cut stream to its row however late, and opens nothing', () => {
    // No clock here: the thread seals the row at its own deadline.
    const tee = new Tee();
    const [first] = chunk(tee, 'Cut', 1, 'p1');
    assert.ok(first?.kind === 'stream');
    closed(tee, 'p1', 'cancelled');
    const late = tee.teed(
      'session/update',
      update('agent_message_chunk', said(' too late'), { streamStartMs: 1 }),
      AT + LATE_MS + 1
    );
    assert.deepEqual(late, [
      { kind: 'stream', row: first.row, delta: ' too late', at: AT + LATE_MS + 1, late: true }
    ]);
    assert.deepEqual(endLines(tee), [], 'no line opened');
  });

  describe("the sent prompt's echo", () => {
    const echo = (tee: GrokTee, text: string, index: number) =>
      tee.teed(
        'session/update',
        update('user_message_chunk', { ...said(text), _meta: { promptIndex: index } }),
        AT
      );
    const ours = (text: string) => (line: RecordLine) => 'text' in line && line.text === text;

    it('leaves the reply it is answering open, however late it comes', () => {
      const tee = new Tee();
      tee.sent(ours('question'));
      const [reply] = chunk(tee, 'reply before echo', 1, 'p1');
      assert.ok(reply?.kind === 'stream');
      const ops = echo(tee, 'question', 0);
      assert.deepEqual(
        ops.map((op) => op.kind),
        ['echo'],
        'nothing closes'
      );
      assert.deepEqual(chunk(tee, ' and after', 1, 'p1'), [
        { kind: 'stream', row: reply.row, delta: ' and after', at: AT }
      ]);
    });

    it('is taken once: a second echo of the same words is a turn', () => {
      const tee = new Tee();
      tee.sent(ours('again'));
      assert.deepEqual(
        echo(tee, 'again', 0).map((op) => op.kind),
        ['echo']
      );
      assert.deepEqual(
        echo(tee, 'again', 1).map((op) => op.kind),
        ['line']
      );
    });

    it('closes a line opened before the prompt went: a turn whose close was lost', () => {
      const tee = new Tee();
      chunk(tee, 'wake words', 1, 'task-1');
      tee.sent(ours('ours'));
      assert.deepEqual(
        echo(tee, 'ours', 0).map((op) => op.kind),
        ['close', 'echo']
      );
    });

    it('a turn Grok started itself still closes the open line', () => {
      const tee = new Tee();
      tee.sent(ours('ours'));
      chunk(tee, 'our reply', 1, 'p1');
      assert.deepEqual(
        echo(tee, 'a wake', 3).map((op) => op.kind),
        ['close', 'line']
      );
    });
  });

  it("closes a line another model call wrote before this one's prose joins it", () => {
    // A wake whose `turn_completed` was lost, then our reply.
    const tee = new Tee();
    const [wake] = chunk(tee, 'woke', 1, 'task-1');
    assert.ok(wake?.kind === 'stream');
    const ops = chunk(tee, 'ours', 2, 'p1');
    assert.deepEqual(ops[0], {
      kind: 'close',
      row: wake.row,
      cut: false,
      line: { role: 'assistant', text: 'woke', blocks: [{ text: 'woke' }], at: AT }
    });
    assert.ok(ops[1]?.kind === 'stream' && ops[1].row !== wake.row);
  });

  it('leaves a line open across a close that names another prompt', () => {
    const tee = new Tee();
    chunk(tee, 'mine', 1, 'p2');
    assert.deepEqual(closed(tee, 'p1', 'cancelled'), []);
    assert.equal(onlyText(endLines(tee)), 'mine');
  });

  it('says an alarm once per turn, falling back when no closer has words', () => {
    const tee = new Tee();
    const [alarm] = tee.closeTurn({ turn: 'p1', stop: 'rate_limit' }, AT);
    assert.ok(alarm?.kind === 'alarm');
    assert.deepEqual(alarm.line, {
      role: 'cli',
      text: 'The turn stopped at a rate limit.',
      blocks: [{ text: 'The turn stopped at a rate limit.' }],
      at: AT
    });
    assert.deepEqual(tee.closeTurn({ turn: 'p1', stop: 'rate_limit', last: true }, AT), [
      { kind: 'seal', row: alarm.row }
    ]);
    assert.deepEqual(tee.closeTurn({ turn: 'p2', stop: 'end_turn', said: 'fine' }, AT), []);
  });

  it("restates a wordless alarm in a later closer's words, on the same row", () => {
    const tee = new Tee();
    const [alarm] = tee.closeTurn({ turn: 'p1', stop: 'error' }, AT);
    assert.ok(alarm?.kind === 'alarm');
    assert.equal(alarm.line.text, 'The turn ended with an error.');
    const said = 'API error (status 402)';
    assert.deepEqual(tee.closeTurn({ turn: 'p1', stop: 'error', said }, AT + 1), [
      {
        kind: 'alarm',
        row: alarm.row,
        line: { role: 'cli', text: said, blocks: [{ text: said }], at: AT }
      }
    ]);
    assert.deepEqual(
      tee.closeTurn({ turn: 'p1', stop: 'error', said: 'other words', last: true }, AT + 2),
      [{ kind: 'seal', row: alarm.row }],
      'the first words the CLI gave stand, and the last closer seals'
    );
    assert.deepEqual(tee.closeTurn({ turn: 'p1', stop: 'error', said }, AT + 3), [], 'once');
  });
});

describe('GrokTee warm ownership across integration', () => {
  it('keeps an anonymous warm row open across historical text and an error close', () => {
    const tee = new Tee();
    const owner = { maintenance: true, warmId: 'W2' };
    const [opened] = tee.teed(
      'session/update',
      update('agent_message_chunk', { content: { type: 'text', text: 'new ' } }),
      AT,
      false,
      owner
    );
    assert.deepEqual(opened, {
      kind: 'stream',
      row: 'line:0',
      delta: 'new ',
      at: AT,
      owner
    });
    assert.deepEqual(
      tee.teed(
        'session/update',
        update(
          'agent_message_chunk',
          { content: { type: 'text', text: 'old reply' } },
          { promptId: 'W1' }
        ),
        AT + 1,
        true
      ),
      [
        {
          kind: 'line',
          line: {
            role: 'assistant',
            text: 'old reply',
            blocks: [{ text: 'old reply' }],
            at: AT + 1
          }
        }
      ]
    );
    assert.deepEqual(
      tee.teed(
        '_x.ai/session/prompt_complete',
        { promptId: 'W1', stopReason: 'error', agentResult: 'old error' },
        AT + 2,
        true
      ),
      [
        {
          kind: 'alarm',
          row: 'alarm:0',
          line: { role: 'cli', text: 'old error', blocks: [{ text: 'old error' }], at: AT + 2 }
        }
      ]
    );
    assert.deepEqual(
      tee.teed(
        'session/update',
        update('agent_message_chunk', { content: { type: 'text', text: 'reply' } }),
        AT + 3,
        false,
        { maintenance: false }
      ),
      [{ kind: 'stream', row: 'line:0', delta: 'reply', at: AT + 3, owner }]
    );
    assert.deepEqual(tee.closeTurn({ stop: 'end_turn' }, AT + 4), [
      {
        kind: 'close',
        row: 'line:0',
        cut: false,
        line: {
          role: 'assistant',
          ...owner,
          text: 'new reply',
          blocks: [{ text: 'new reply' }],
          at: AT
        }
      }
    ]);
  });

  it('retains warm identity and write evidence when a tool-only row is cut', () => {
    const tee = new Tee(repo());
    const owner = { maintenance: true, warmId: 'W1' };
    assert.deepEqual(
      tee.teed(
        'session/update',
        update(
          'tool_call',
          {
            toolCallId: 'call-write-0',
            title: 'write',
            rawInput: { file_path: repo('a.ts'), content: 'x\n' }
          },
          { promptId: 'W1' }
        ),
        AT,
        false,
        owner
      ),
      []
    );
    const [closed] = tee.closeTurn({ turn: 'W1', stop: 'cancelled' }, AT + 1);
    assert.ok(closed?.kind === 'close');
    assert.equal(closed.cut, true);
    assert.equal(closed.line.maintenance, true);
    assert.equal(closed.line.warmId, 'W1');
    assert.equal(closed.line.at, AT);
    assert.deepEqual(closed.line.files, [repo('a.ts')]);
    assert.deepEqual(closed.line.sizes, { [repo('a.ts')]: { add: 1, del: 0 } });
    assert.deepEqual(closed.line.blocks, [
      {
        call: {
          id: 'call-write-0',
          name: 'Write',
          input: { file_path: repo('a.ts'), content: 'x\n' }
        }
      }
    ]);
  });
});
