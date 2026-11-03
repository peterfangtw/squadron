import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ClaudeTasks, exchangeForSend, lineForFrame } from '../../core/claude/tee';
import { wrapMessage, wrapWait } from '../../core/coordination/send';
import type { RecordLine } from '../../core/record';
import { thinkingBlock } from '../fixtures/signature';
import { repoRoot } from '../helpers';

const AT = 1_700_000_000_000;

/** An absolute path under `/repo` as the tee resolves one: on win32 that is
 *  `C:\repo\…`, so a POSIX literal would never match. */
const repo = (...parts: string[]) => path.resolve('/repo', ...parts);

/**
 * The one line a frame becomes, asserting that it became no more than one.
 *
 * `lineForFrame` answers a list because a turn can carry a skill chip after it;
 * every scenario but that one is a single line, and saying so here is stronger
 * than reading `[0]` and ignoring the rest.
 */
function oneLine(value: unknown, at: number, cwd?: string): RecordLine | undefined {
  const lines = lineForFrame(value, at, cwd);
  assert.ok(lines.length <= 1, `expected at most one line, got ${lines.length}`);
  return lines[0];
}

/** An `assistant` frame in the CLI's own shape, as Step 4's probe recorded it. */
const assistant = (content: unknown[], model = 'claude-opus-5') => ({
  type: 'assistant',
  message: { role: 'assistant', model, content }
});

/** The same, wearing the `message.id` every real one carries. */
const said = (id: string, content: unknown[], model = 'claude-opus-5') => ({
  type: 'assistant',
  message: { role: 'assistant', id, model, content }
});

describe('lineForFrame', () => {
  it('keeps a model turn, with its prose and its calls in order', () => {
    const frame = assistant([
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: 'found it' }
    ]);
    assert.deepEqual(oneLine(frame, AT), {
      role: 'assistant',
      text: 'let me check\n\nfound it',
      blocks: [
        { text: 'let me check' },
        { call: { id: 'tu_1', name: 'Bash', input: { command: 'ls' } } },
        { text: 'found it' }
      ],
      at: AT
    });
  });

  it('bounds a tool input rather than storing what the turn wrote', () => {
    // `ToolCall.input`'s contract is "bounded: strings cut, arrays cut, depth
    // capped" — a `Write` carries a whole file, and this store is never swept.
    const frame = assistant([
      { type: 'tool_use', id: 'tu_2', name: 'Write', input: { content: 'x'.repeat(5000) } }
    ]);
    const exchange = oneLine(frame, AT);
    const blocks = exchange && 'blocks' in exchange ? (exchange.blocks ?? []) : [];
    const first = blocks[0];
    const content = first && 'call' in first ? first.call.input?.content : undefined;
    assert.equal(typeof content, 'string');
    assert.ok(
      typeof content === 'string' && content.length < 5000,
      `the payload should be cut, kept ${typeof content === 'string' ? content.length : '?'}`
    );
  });

  it('preserves write metadata before bounding tool input', () => {
    const context = 'unchanged\n'.repeat(100);
    const frame = assistant([
      {
        type: 'tool_use',
        id: 'write',
        name: 'Write',
        input: { file_path: repo('a.ts'), content: 'x\n'.repeat(200) }
      },
      {
        type: 'tool_use',
        id: 'edit',
        name: 'Edit',
        input: {
          file_path: 'b.ts',
          old_string: context + 'old\n',
          new_string: context + 'new\nextra\n'
        }
      },
      {
        type: 'tool_use',
        id: 'edit-again',
        name: 'Edit',
        input: { file_path: 'b.ts', old_string: 'a\n', new_string: 'b\nc\n' }
      },
      {
        type: 'tool_use',
        id: 'multi',
        name: 'MultiEdit',
        input: {
          file_path: 'c.ts',
          edits: Array.from({ length: 10 }, () => ({ old_string: 'a\n', new_string: 'b\n' }))
        }
      }
    ]);
    const line = oneLine(frame, AT, repo());
    assert.ok(line && 'role' in line);
    assert.deepEqual(line.files, [repo('a.ts'), repo('b.ts'), repo('c.ts')]);
    assert.deepEqual(line.sizes, {
      [repo('a.ts')]: { add: 200, del: 0 },
      [repo('b.ts')]: { add: 4, del: 2 },
      [repo('c.ts')]: { add: 10, del: 10 }
    });
    const calls = (line.blocks ?? []).flatMap((block) => ('call' in block ? [block.call] : []));
    assert.equal((calls[0]?.input?.content as string).length, 300);
    assert.equal((calls[3]?.input?.edits as unknown[]).length, 8);
  });

  it('keeps an unreadable write size unknown and ignores reads and unresolved paths', () => {
    const frame = assistant([
      {
        type: 'tool_use',
        id: 'unknown',
        name: 'Edit',
        input: { file_path: repo('unknown.ts'), old_string: 'a' }
      },
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/repo/read.ts' } },
      {
        type: 'tool_use',
        id: 'relative',
        name: 'Write',
        input: { file_path: 'relative.ts', content: 'a\n' }
      },
      ...[null, [], 'bad', 7].map((input, index) => ({
        type: 'tool_use',
        id: `invalid-${index}`,
        name: 'Write',
        input
      }))
    ]);
    const line = oneLine(frame, AT);
    assert.ok(line && 'role' in line);
    assert.deepEqual(line.files, [repo('unknown.ts')]);
    assert.equal(line.sizes, undefined);
  });

  it('files a local command answer as the CLI speaking, not the model', () => {
    // Measured 2026-08-19: a local command comes back as an ordinary
    // `assistant` frame, and the only thing separating it from a real turn is
    // `message.model` reading `<synthetic>`. On disk it is a
    // `system`/`local_command`, drawn `role: 'cli'`.
    const frame = assistant([{ type: 'text', text: 'Session renamed to: probe' }], '<synthetic>');
    assert.deepEqual(oneLine(frame, AT), {
      role: 'cli',
      local: true,
      text: 'Session renamed to: probe',
      blocks: [{ text: 'Session renamed to: probe' }],
      at: AT
    });
  });

  it('drops a subagent frame rather than filing it in the parent conversation', () => {
    // The CLI files these under `subagents/` and the transcript walk drops them
    // from the parent's thread, so recording one here would put a turn in this
    // conversation that no reader of the `.jsonl` ever sees.
    const frame = { ...assistant([{ type: 'text', text: 'from the subagent' }]) } as Record<
      string,
      unknown
    >;
    frame.parent_tool_use_id = 'tu_parent';
    assert.equal(oneLine(frame, AT), undefined);
  });

  it('drops a replayed echo', () => {
    const frame = { ...assistant([{ type: 'text', text: 'Set model to haiku' }]), isReplay: true };
    assert.equal(oneLine(frame, AT), undefined);
  });

  it('files an interrupted turn as the same break the disk walk mints', () => {
    // The CLI writes `[Request interrupted by user]` as a user entry on disk
    // and never on the pipe. `error_during_execution` is the pipe's spelling
    // of that fact, and `transcript.ts` turns the text into `{mark:'break'}`.
    assert.deepEqual(oneLine({ type: 'result', subtype: 'error_during_execution' }, AT), {
      mark: 'break'
    });
  });

  it('keeps nothing for the frames that are not turns', () => {
    for (const frame of [
      { type: 'stream_event' },
      { type: 'result', subtype: 'success' },
      { type: 'system', subtype: 'init' },
      { type: 'conversation_reset' },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }
    ]) {
      assert.equal(oneLine(frame, AT), undefined, JSON.stringify(frame));
    }
  });

  it('keeps nothing for an assistant frame with no content worth drawing', () => {
    assert.equal(oneLine(assistant([]), AT), undefined);
    assert.equal(oneLine({ type: 'assistant' }, AT), undefined);
  });

  it('lifts a skill call out of the turn as the chip the disk walk draws', () => {
    // The `.jsonl` mints this chip off the skill body's `Base directory for
    // this skill:` line — an `isMeta` entry that never reaches the pipe — and
    // `unduplicateSkill` then deletes the call from the turn above it. Both
    // halves happen here instead, or the same session reads as a `Skill` step
    // row when the record draws it and as a pill when the fallback does.
    const frame = said('msg_s', [
      { type: 'text', text: 'on it' },
      { type: 'tool_use', id: 'tu_s', name: 'Skill', input: { skill: 'squadron' } }
    ]);
    assert.deepEqual(lineForFrame(frame, AT), [
      {
        role: 'assistant',
        text: 'on it',
        blocks: [{ text: 'on it' }],
        at: AT,
        m: 'msg_s'
      },
      { mark: 'skill', skill: 'squadron', by: 'agent' }
    ]);
  });

  it('leaves a chip alone where the turn was nothing but the call', () => {
    // The ordinary shape: the model answers with the `Skill` call and no prose.
    // A turn of no blocks is not drawn, so the witness stands on its own line
    // and the chip is the whole of what the reader sees.
    const frame = said('msg_s2', [
      { type: 'tool_use', id: 'tu_s2', name: 'Skill', input: { skill: 'matt-code-review' } }
    ]);
    assert.deepEqual(lineForFrame(frame, AT), [
      { m: 'msg_s2' },
      { mark: 'skill', skill: 'matt-code-review', by: 'agent' }
    ]);
  });

  it('keeps the row for a skill call that names no skill', () => {
    // `Marker.skill` is on every `skill` marker, so a nameless chip would say
    // less than the step it replaced.
    const frame = assistant([{ type: 'tool_use', id: 'tu_s3', name: 'Skill', input: {} }]);
    assert.deepEqual(oneLine(frame, AT), {
      role: 'assistant',
      text: '',
      blocks: [{ call: { id: 'tu_s3', name: 'Skill', input: {} } }],
      at: AT
    });
  });

  it('survives a frame shaped like nothing it expects', () => {
    // Every field here was written by another program; none may be trusted.
    assert.equal(oneLine({ type: 'assistant', message: { content: 'no' } }, AT), undefined);
    assert.equal(oneLine(null, AT), undefined);
  });
});

describe('lineForFrame, what a call returned', () => {
  it('pairs a result onto the call it answers, by the id both halves carry', () => {
    // Probed on the wire 2026-08-20: a `user` frame's `tool_result` blocks carry
    // `tool_use_id`, `is_error` and a string `content`. Without this the record
    // draws a call row with no output where the `.jsonl` has one.
    const frame = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello\n' }]
      }
    };
    assert.deepEqual(oneLine(frame, AT), { ret: [{ id: 'toolu_1', output: 'hello' }] });
  });

  it('says a call failed when the result did', () => {
    const frame = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Exit code 1', is_error: true }
        ]
      }
    };
    assert.deepEqual(oneLine(frame, AT), {
      ret: [{ id: 'toolu_2', output: 'Exit code 1', failed: true }]
    });
  });

  it('cuts a result to the ceiling the disk reader uses', () => {
    // One ceiling for both sources, so a call's row does not change length when
    // the dock swaps which of the two it is drawing.
    const frame = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'x'.repeat(400) }]
      }
    };
    const line = oneLine(frame, AT);
    const output = line && 'ret' in line ? line.ret[0]?.output : undefined;
    assert.ok(output && output.length < 400, `kept ${output?.length}`);
    assert.ok(output?.endsWith('…'));
  });

  it('keeps a result that names no call out of the record', () => {
    // Nothing could pair it, and a line that can never fold is a line that only
    // grows the file.
    const frame = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
    assert.equal(oneLine(frame, AT), undefined);
  });
});

describe('lineForFrame, the message it witnessed', () => {
  it('stamps the CLI message id on the turn it made', () => {
    // The one field both halves of the CLI write for the same message, and the
    // whole of what `record.ts`'s `whole` compares.
    const line = oneLine(said('msg_1', [{ type: 'text', text: 'hi' }]), AT);
    assert.deepEqual(line, {
      role: 'assistant',
      text: 'hi',
      blocks: [{ text: 'hi' }],
      at: AT,
      m: 'msg_1'
    });
  });

  it('records a message that produced no turn as a witness of its own', () => {
    // A message of nothing but `thinking` still happened — 1 of 3014 here — and
    // the disk side counts it, so a record that skipped it would read as holed.
    assert.deepEqual(oneLine(said('msg_2', [{ type: 'thinking', thinking: '…' }]), AT), {
      m: 'msg_2'
    });
  });

  it('keeps narration as prose, marked as the server summary it is', () => {
    // The prose a question points at ("send the message above?") arrives as a
    // `thinking` block tagged `narration`; dropping it left the question with
    // nothing above it.
    const frame = said('msg_4', [
      thinkingBlock('I drafted the message.', 'narration'),
      { type: 'tool_use', id: 'tu_4', name: 'AskUserQuestion', input: {} }
    ]);
    assert.deepEqual(oneLine(frame, AT), {
      role: 'assistant',
      text: 'I drafted the message.',
      blocks: [
        { text: 'I drafted the message.', summarized: true },
        { call: { id: 'tu_4', name: 'AskUserQuestion', input: {} } }
      ],
      at: AT,
      m: 'msg_4'
    });
  });

  it('still drops thinking that is not narration, or narration with no words', () => {
    for (const block of [
      thinkingBlock('private reasoning', 'thinking'),
      thinkingBlock('  ', 'narration'),
      { type: 'thinking', thinking: 'unsigned' },
      { type: 'thinking', thinking: 'mangled', signature: '!!not base64' }
    ]) {
      assert.deepEqual(oneLine(said('msg_5', [block]), AT), { m: 'msg_5' });
    }
  });

  it('witnesses a local command answer without filing it as the model', () => {
    const line = oneLine(said('msg_3', [{ type: 'text', text: 'Renamed' }], '<synthetic>'), AT);
    assert.deepEqual(line, {
      role: 'cli',
      local: true,
      text: 'Renamed',
      blocks: [{ text: 'Renamed' }],
      at: AT,
      m: 'msg_3'
    });
  });
});

describe('lineForFrame, markdown images', () => {
  it('lifts a markdown image out of the drawn prose, as the disk reader does', () => {
    const line = oneLine(
      said('msg_img', [{ type: 'text', text: 'see\n\n![Aperture](.impeccable/mocks/a.jpg)\n' }]),
      AT,
      repo()
    );
    assert.deepEqual(line, {
      role: 'assistant',
      text: 'see\n\n![Aperture](.impeccable/mocks/a.jpg)\n',
      blocks: [{ text: 'see\n\n\n' }],
      at: AT,
      m: 'msg_img',
      images: [{ id: `f|msg_img|0.0|${repo('.impeccable/mocks/a.jpg')}` }]
    });
  });

  it('keys two messages of one path apart so the fetch cache cannot serve the first for the second', () => {
    const first = oneLine(said('msg_a', [{ type: 'text', text: '![a](/tmp/x.png)' }]), AT, '/repo');
    const second = oneLine(
      said('msg_b', [{ type: 'text', text: '![b](/tmp/x.png)' }]),
      AT,
      '/repo'
    );
    assert.equal(
      first && 'images' in first ? first.images?.[0]?.id : undefined,
      'f|msg_a|0.0|/tmp/x.png'
    );
    assert.equal(
      second && 'images' in second ? second.images?.[0]?.id : undefined,
      'f|msg_b|0.0|/tmp/x.png'
    );
  });

  it('draws an image-only reply as the chip with no empty row above it', () => {
    const line = oneLine(
      said('msg_only', [{ type: 'text', text: '![icon](media/icon.png)' }]),
      AT,
      repo()
    );
    assert.deepEqual(line, {
      role: 'assistant',
      text: '![icon](media/icon.png)',
      blocks: [],
      at: AT,
      m: 'msg_only',
      images: [{ id: `f|msg_only|0.0|${repo('media/icon.png')}` }]
    });
  });

  it('leaves a relative dest a link when it has no directory to resolve against', () => {
    const line = oneLine(said('msg_rel', [{ type: 'text', text: '![icon](media/icon.png)' }]), AT);
    assert.equal(line && 'images' in line ? line.images : undefined, undefined);
    assert.deepEqual(line && 'blocks' in line ? line.blocks : undefined, [
      { text: '[icon](media/icon.png)' }
    ]);
  });

  it('does not eat image syntax quoted in a fence', () => {
    const line = oneLine(
      said('msg_q', [{ type: 'text', text: 'use `![a](/tmp/x.png)`' }]),
      AT,
      '/repo'
    );
    assert.equal(line && 'images' in line ? line.images : undefined, undefined);
    assert.deepEqual(line && 'blocks' in line ? line.blocks : undefined, [
      { text: 'use `![a](/tmp/x.png)`' }
    ]);
  });

  it('lifts once across the split frames of one message', () => {
    // protocol.md, 2026-07-28: a turn that speaks then calls a tool is two
    // `assistant` frames sharing `message.id` — first `text`, then `tool_use`.
    // The thinking/text split is the same shape. Neither second frame carries
    // prose, so `message.id` as the uuid cannot collide the way two text
    // frames of one id would.
    const prose = oneLine(
      said('msg_split', [{ type: 'text', text: '![shot](/tmp/shot.png)' }]),
      AT,
      '/repo'
    );
    const call = oneLine(
      said('msg_split', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }]),
      AT,
      '/repo'
    );
    assert.deepEqual(prose && 'images' in prose ? prose.images : undefined, [
      { id: 'f|msg_split|0.0|/tmp/shot.png' }
    ]);
    assert.equal(call && 'images' in call ? call.images : undefined, undefined);
    assert.ok(call && 'blocks' in call && call.blocks?.some((block) => 'call' in block));
  });
});

describe('exchangeForSend', () => {
  it('gives a typed message blocks as well as text', () => {
    // The dock paints `blocks` and has no fallback to `text`: a turn without
    // them is a YOU label above an empty body (`core/grok/transcript.ts` records
    // the same trap). The `.jsonl` walk fills both, so this must too.
    assert.deepEqual(exchangeForSend({ text: 'do the thing' }, AT), [
      { role: 'user', text: 'do the thing', blocks: [{ text: 'do the thing' }], at: AT }
    ]);
  });

  it('files no chip for an injected /effort', () => {
    assert.deepEqual(exchangeForSend({ text: '/effort high', command: true }, AT), []);
  });

  it('does not mistake a message that merely starts with a slash', () => {
    // Only the outbox's `command` flag decides, never the text. A session told
    // `/clear the table` means the table, so a slash the reader types is their
    // turn.
    assert.deepEqual(exchangeForSend({ text: '/clear the table' }, AT), [
      { role: 'user', text: '/clear the table', blocks: [{ text: '/clear the table' }], at: AT }
    ]);
  });

  it('unwraps a cross-session message and keeps who sent it', () => {
    assert.deepEqual(exchangeForSend({ text: wrapMessage('take this over', 'peer-session') }, AT), [
      {
        role: 'user',
        text: 'take this over',
        blocks: [{ text: 'take this over' }],
        at: AT,
        from: 'peer-session'
      }
    ]);
  });

  it('draws a converged wait as its own author, naming nobody', () => {
    // The one turn here no session composed — the extension host did. `from`
    // would be a lie, and would win over the role downstream and draw it as a
    // peer's. `blocks` is filled like every other authored turn: the dock
    // paints `blocks` and has no fallback.
    const said = 'All 2 sessions you were waiting on have finished.';
    assert.deepEqual(exchangeForSend({ text: wrapWait(said) }, AT), [
      { role: 'wait', text: said, blocks: [{ text: said }], at: AT }
    ]);
  });

  it('records a merged delivery as one turn per message, each under its author', () => {
    const row = {
      text: 'joined on the wire',
      parts: [
        { id: 'p', text: wrapMessage('from a peer', 'peer-session') },
        { id: 'w', text: wrapWait('All 1 finished.') },
        { id: 'a', text: 'and mine' }
      ]
    };
    assert.deepEqual(
      exchangeForSend(row, AT).map((turn) =>
        'role' in turn ? [turn.role, turn.text, turn.from] : turn
      ),
      [
        ['user', 'from a peer', 'peer-session'],
        ['wait', 'All 1 finished.', undefined],
        ['user', 'and mine', undefined]
      ]
    );
  });

  it('keeps a send that was only a picture, and nothing for an empty one', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    assert.deepEqual(exchangeForSend({ text: '', images: [shot] }, AT, [{ id: 'a' }]), [
      { role: 'user', text: '', at: AT, images: [{ id: 'a' }] }
    ]);
    assert.deepEqual(exchangeForSend({ text: '' }, AT), []);
  });
});

describe("lineForFrame, a background command's end", () => {
  // The frames `cli_state/claude/background_cmd_2026_10_13/` captured
  // (2.1.296), trimmed to what the tee may read.
  const call = 'toolu_01QRtGxtrzr4F432WVqr7Y7Z';
  const started = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'bl4llhify',
    tool_use_id: call,
    is_backgrounded: true
  };
  const running = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: call,
          type: 'tool_result',
          content: 'Command running in background with ID: bl4llhify.',
          is_error: false
        }
      ]
    }
  };
  const ended = (status: unknown) => ({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'bl4llhify',
    tool_use_id: call,
    status,
    output_file: '$TMPDIR/claude-501/x/tasks/bl4llhify.output',
    summary: 'Background command "Sleep then echo in background" completed (exit code 0)'
  });
  const init = { type: 'system', subtype: 'init', session_id: 's' };
  /** A ledger that has seen `started`, as the session's would by the end. */
  const knowing = () => {
    const tasks = new ClaudeTasks();
    tasks.take(started);
    return tasks;
  };

  it('folds the end onto its call, then marks the turn the CLI starts for it', () => {
    const tasks = new ClaudeTasks();
    const lines = [started, running, ended('completed'), init].flatMap((frame) => {
      const out = lineForFrame(frame, AT, undefined, tasks);
      tasks.take(frame);
      return out;
    });
    assert.deepEqual(lines, [
      { ret: [{ id: call, output: 'Command running in background with ID: bl4llhify.' }] },
      {
        ret: [
          {
            id: call,
            output: 'Background command "Sleep then echo in background" completed (exit code 0)'
          }
        ]
      },
      { mark: 'trigger', trigger: 'task', status: 'completed', at: AT }
    ]);
  });

  it('carries each status the CLI states, and none it does not know', () => {
    for (const status of ['failed', 'stopped'] as const) {
      assert.deepEqual(lineForFrame(ended(status), AT, undefined, knowing())[1], {
        mark: 'trigger',
        trigger: 'task',
        status,
        at: AT
      });
    }
    assert.deepEqual(lineForFrame(ended('exploded'), AT, undefined, knowing())[1], {
      mark: 'trigger',
      trigger: 'task',
      at: AT
    });
  });

  it('keeps an end that names no call out of the record', () => {
    const { tool_use_id: _, ...nameless } = ended('completed');
    assert.deepEqual(lineForFrame(nameless, AT, undefined, knowing()), []);
  });
});

describe('lineForFrame, which task ends start a turn', () => {
  // `cli_state/claude/subagent_cmd_2026_10_14/` (2.1.296): `task_notification`
  // fires for every task the CLI tracks, and only the `task_started` before it
  // says whose task it was and whether it was backgrounded.
  const capture = (...name: string[]) =>
    path.join(repoRoot(), 'docs', 'reference', 'cli_state', 'claude', ...name);

  /** Every frame through the tee and a ledger, as `OwnedSession.record` runs them. */
  async function replay(file: string): Promise<RecordLine[]> {
    const tasks = new ClaudeTasks();
    const lines: RecordLine[] = [];
    for (const raw of (await fs.readFile(file, 'utf8')).split('\n')) {
      if (!raw) continue;
      const row = JSON.parse(raw) as { t: number; frame: unknown };
      lines.push(...lineForFrame(row.frame, AT + Math.round(row.t * 1000), undefined, tasks));
      tasks.take(row.frame);
    }
    return lines;
  }

  const triggers = (lines: RecordLine[]) => lines.filter((line) => 'mark' in line);
  const returns = (lines: RecordLine[], id: string) =>
    lines.flatMap((line) => ('ret' in line ? line.ret.filter((r) => r.id === id) : []));

  it('marks a background agent ending, and nothing for the commands it ran', async () => {
    const lines = await replay(capture('subagent_cmd_2026_10_14', 'frames-async.jsonl'));
    assert.deepEqual(triggers(lines), [
      { mark: 'trigger', trigger: 'agent', status: 'completed', at: AT + 29_400 }
    ]);
    for (const child of ['toolu_01Hgkz8W9T5rrib8V3ZapXUz', 'toolu_01E5guapzYigcnxHdWwpyj2q']) {
      assert.deepEqual(returns(lines, child), [], `no line names the subagent's ${child}`);
    }
  });

  it('marks nothing for a subagent the turn waited on', async () => {
    const lines = await replay(capture('subagent_cmd_2026_10_14', 'frames-sync.jsonl'));
    assert.deepEqual(triggers(lines), []);
  });

  it("marks the session's own background command, as on 10-13", async () => {
    for (const file of [
      capture('subagent_cmd_2026_10_14', 'frames-control.jsonl'),
      capture('background_cmd_2026_10_13', 'frames.jsonl')
    ]) {
      const marks = triggers(await replay(file));
      assert.equal(marks.length, 1, file);
      assert.equal(marks[0] && 'trigger' in marks[0] ? marks[0].trigger : undefined, 'task');
    }
  });

  it('marks nothing for a long foreground command, and keeps its real output', async () => {
    const lines = await replay(capture('subagent_cmd_2026_10_14', 'frames-fgparent.jsonl'));
    assert.deepEqual(triggers(lines), []);
    const outputs = returns(lines, 'toolu_01T9AsLLuqeYoHbn8wM71GFd').map((r) => r.output);
    assert.equal(outputs.length, 1, 'only the tool_result wrote the call');
    assert.match(outputs[0] ?? '', /fg-done/);
  });

  it('writes nothing for an end whose start it never saw', () => {
    const end = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'unseen',
      tool_use_id: 'toolu_x',
      status: 'completed',
      summary: 'Background command "x" completed (exit code 0)'
    };
    assert.deepEqual(lineForFrame(end, AT, undefined, new ClaudeTasks()), []);
    assert.deepEqual(lineForFrame(end, AT), []);
  });

  it('never seeds the ledger from a replayed start', () => {
    const tasks = new ClaudeTasks();
    tasks.take({
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'toolu_1',
      is_backgrounded: true,
      task_type: 'local_bash',
      isReplay: true
    });
    assert.equal(tasks.classify('t1'), undefined);
  });

  it("never seeds the ledger from a subagent's frame", () => {
    const tasks = new ClaudeTasks();
    tasks.take({
      type: 'system',
      subtype: 'task_started',
      task_id: 't2',
      tool_use_id: 'toolu_2',
      is_backgrounded: true,
      parent_tool_use_id: 'toolu_agent'
    });
    assert.equal(tasks.classify('t2'), undefined);
  });
});
