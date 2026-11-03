import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { after, before, describe, it } from 'node:test';

import { tempHome, writeJson } from '../helpers';

import { isMarker, type Authored } from '../../core/transcript';

import { WARM_PROMPT, wrapWarm } from '../../core/coordination/send';

import {
  INDEXED,
  LINES,
  dispose,
  file,
  fromRows,
  grokCwdSlug,
  grokTranscriptPath,
  readGrokChrome,
  readGrokTranscript,
  readSentUserUpdate,
  readWitnessed,
  setup
} from './grok_transcript_helpers';

before(setup);

after(dispose);

describe('Grok transcript path', () => {
  it('URL-encodes the cwd, including slashes', () => {
    assert.equal(grokCwdSlug('/Users/me/src/squadron'), '%2FUsers%2Fme%2Fsrc%2Fsquadron');
    assert.match(grokTranscriptPath('/tmp/project', 'abc'), /chat_history\.jsonl$/);
  });
});

describe('Grok chat_history.jsonl', () => {
  it('keeps the typed turns and drops injected system / reminders', async () => {
    const { exchanges, truncated } = await readGrokTranscript(file);
    assert.equal(truncated, false);
    const authored = exchanges.filter((x) => !isMarker(x));
    assert.deepEqual(
      authored.map((x) => ('role' in x ? [x.role, x.text, x.blocks?.length ?? 0] : [])),
      [
        ['user', 'are u claude', 1],
        ['assistant', 'No. I’m Grok, built by xAI.', 1],
        ['user', 'yo', 1],
        ['assistant', 'Yo. What’s up?', 1],
        ['assistant', '', 1]
      ]
    );
  });

  it('maps run_terminal_command to Bash so the dock reads a command', async () => {
    const { exchanges } = await readGrokTranscript(file);
    const last = exchanges.at(-1);
    assert.ok(last && !isMarker(last) && last.blocks);
    const call = last.blocks.find((b) => 'call' in b);
    assert.ok(call && 'call' in call);
    assert.equal(call.call.name, 'Bash');
    assert.equal(call.call.input?.['command'], 'ls');
    assert.equal(call.call.output, 'a.ts\nb.ts');
  });

  it('does not paint a tool_call that has no tool_result', async () => {
    const hang = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-hang-')),
      'chat_history.jsonl'
    );
    await fs.writeFile(
      hang,
      [
        '{"type":"user","content":[{"type":"text","text":"<user_query>\\nfetch\\n</user_query>"}]}',
        '{"type":"assistant","content":"","tool_calls":[{"id":"hang","name":"run_terminal_command","arguments":"{\\"command\\":\\"cd \\\\\\"$(pwd)\\\\\\" && echo hi\\"}"}]}'
      ].join('\n') + '\n'
    );
    const { exchanges } = await readGrokTranscript(hang);
    await fs.rm(path.dirname(hang), { recursive: true, force: true });
    const authored = exchanges.filter((x) => !isMarker(x));
    assert.deepEqual(
      authored.map((x) => ('role' in x ? [x.role, x.text, x.blocks?.length ?? 0] : [])),
      [['user', 'fetch', 1]],
      'unpaired run_terminal_command must not become Ran command or an empty GROK turn'
    );
  });

  it('still paints a tool whose tool_result content is empty', async () => {
    const file = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-empty-')),
      'chat_history.jsonl'
    );
    await fs.writeFile(
      file,
      [
        '{"type":"assistant","content":"","tool_calls":[{"id":"c2","name":"read_file"}]}',
        '{"type":"tool_result","tool_call_id":"c2","content":""}'
      ].join('\n') + '\n'
    );
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
    const last = exchanges.at(-1);
    assert.ok(last && !isMarker(last) && last.blocks);
    const call = last.blocks.find((block) => 'call' in block);
    assert.ok(call && 'call' in call);
    assert.equal(call.call.name, 'Read');
    assert.equal(call.call.output, undefined);
  });

  it('never surfaces encrypted reasoning', async () => {
    const { exchanges } = await readGrokTranscript(file);
    assert.equal(
      exchanges.some((x) => !isMarker(x) && x.text.includes('nope')),
      false
    );
  });

  it('is empty for a missing file', async () => {
    const { exchanges } = await readGrokTranscript('/no/such/chat_history.jsonl');
    assert.deepEqual(exchanges, []);
  });
});

describe('Grok CLI-authored alarms', () => {
  const ERROR = 'API error (status 402 Payment Required): Grok Build usage balance exhausted';

  function userChunk(promptIndex: number, text: string) {
    return {
      timestamp: 1_786_937_686,
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: { promptIndex }
        }
      }
    };
  }

  function turnCompleted(stop: string, agent_result = '') {
    return {
      timestamp: 1_786_937_687,
      method: '_x.ai/session/update',
      params: {
        update: {
          sessionUpdate: 'turn_completed',
          stop_reason: stop,
          agent_result
        }
      }
    };
  }

  async function session(history: unknown[], updates: unknown[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-cli-'));
    const file = path.join(dir, 'chat_history.jsonl');
    await fs.writeFile(file, history.map((row) => JSON.stringify(row)).join('\n') + '\n');
    if (updates.length) {
      await fs.writeFile(
        path.join(dir, 'updates.jsonl'),
        updates.map((row) => JSON.stringify(row)).join('\n') + '\n'
      );
    }
    return file;
  }

  function query(text: string, prompt_index: number) {
    return {
      type: 'user',
      prompt_index,
      content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }]
    };
  }

  async function roles(file: string) {
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
    return exchanges.filter((x) => !isMarker(x)).map((x) => ('role' in x ? [x.role, x.text] : []));
  }

  it('sits the alarm after a mid-turn that already wrote tools', async () => {
    const file = await session(
      [
        query('add the roadmap item', 3),
        { type: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file' }] },
        { type: 'tool_result', tool_call_id: 'c1', content: 'ok' },
        query('commit the docs', 4)
      ],
      [
        userChunk(3, 'add the roadmap item'),
        turnCompleted('error', ERROR),
        userChunk(4, 'commit the docs'),
        turnCompleted('end_turn')
      ]
    );
    assert.deepEqual(await roles(file), [
      ['user', 'add the roadmap item'],
      ['assistant', ''],
      ['cli', ERROR],
      ['user', 'commit the docs']
    ]);
  });

  it('sits the alarm on an immediate fail, after the user turn', async () => {
    const file = await session(
      [query('commit the docs', 4), query('yo', 5)],
      [
        {
          method: '_x.ai/session/update',
          params: {
            update: {
              sessionUpdate: 'retry_state',
              type: 'failed',
              error_type: 'api',
              message: ERROR
            }
          }
        },
        userChunk(4, 'commit the docs'),
        turnCompleted('error', ERROR),
        userChunk(5, 'yo'),
        turnCompleted('error', ERROR)
      ]
    );
    assert.deepEqual(await roles(file), [
      ['user', 'commit the docs'],
      ['cli', ERROR],
      ['user', 'yo'],
      ['cli', ERROR]
    ]);
  });

  it('does not turn a cancelled or finished turn into an alarm', async () => {
    const file = await session(
      [query('hello', 0)],
      [userChunk(0, 'hello'), turnCompleted('cancelled'), turnCompleted('end_turn')]
    );
    assert.deepEqual(await roles(file), [['user', 'hello']]);
  });

  it('keeps one alarm when two turn_completed errors share a prompt', async () => {
    const file = await session(
      [query('yo', 5)],
      [userChunk(5, 'yo'), turnCompleted('error', ERROR), turnCompleted('error', ERROR)]
    );
    assert.deepEqual(await roles(file), [
      ['user', 'yo'],
      ['cli', ERROR]
    ]);
  });

  it('keeps chronological order when two alarms share an insertion index', async () => {
    const first = 'API error (status 402 Payment Required): first';
    const second = 'API error (status 402 Payment Required): second';
    const file = await session(
      [
        {
          type: 'user',
          content: [{ type: 'text', text: '<user_query>\none\n</user_query>' }]
        },
        {
          type: 'user',
          content: [{ type: 'text', text: '<user_query>\ntwo\n</user_query>' }]
        }
      ],
      [
        userChunk(0, 'one'),
        turnCompleted('error', first),
        userChunk(1, 'two'),
        turnCompleted('error', second)
      ]
    );
    assert.deepEqual(await roles(file), [
      ['user', 'one'],
      ['user', 'two'],
      ['cli', first],
      ['cli', second]
    ]);
  });

  it('drops an error with empty agent_result', async () => {
    const file = await session(
      [query('yo', 5)],
      [userChunk(5, 'yo'), turnCompleted('error', '  '), turnCompleted('error', ERROR)]
    );
    assert.deepEqual(await roles(file), [
      ['user', 'yo'],
      ['cli', ERROR]
    ]);
  });

  it('ignores a missing updates.jsonl', async () => {
    const file = await session([query('yo', 5)], []);
    assert.deepEqual(await roles(file), [['user', 'yo']]);
  });
});

describe('Grok: a message another session sent', () => {
  async function fromRows(rows: unknown[]): Promise<string> {
    const file = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-peer-')),
      'chat_history.jsonl'
    );
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return file;
  }

  const wrapped = (from: string, body: string) =>
    `<squadron-message from="${from}">\n${body}\n</squadron-message>`;

  /** How this CLI files a prompt on disk: inside `<user_query>` (probe,
   *  2026-08-19). The wrapper is what we put inside that. */
  const row = (text: string) => ({
    type: 'user',
    content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }],
    prompt_index: 0
  });

  it('unwraps a message nested inside <user_query>, and names the sender', async () => {
    const file = await fromRows([row(wrapped('sess-a', 'take the review'))]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });

    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.role, 'user');
    assert.equal(turn.text, 'take the review');
    assert.equal(turn.from, 'sess-a');
    assert.deepEqual(turn.blocks, [{ text: 'take the review' }]);
  });

  it('leaves a prompt somebody typed alone', async () => {
    const file = await fromRows([row('take the review')]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });

    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.text, 'take the review');
    assert.equal(turn.from, undefined);
  });

  it('leaves a prompt that merely quotes the tag alone', async () => {
    const quoted = `arriving messages look like ${wrapped('sess-a', 'this')} here`;
    const file = await fromRows([row(quoted)]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });

    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.text, quoted);
    assert.equal(turn.from, undefined);
  });

  it('draws a converged wait as its own author, naming nobody', async () => {
    const said = 'All 2 sessions you were waiting on have finished.';
    const file = await fromRows([row(`<squadron-wait>\n${said}\n</squadron-wait>`)]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });

    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.role, 'wait');
    assert.equal(turn.text, said);
    // No author, by construction: nothing composed it but the window, and a
    // `from` would win over the role and draw it as a peer's message.
    assert.equal(turn.from, undefined);
    assert.deepEqual(turn.blocks, [{ text: said }]);
  });
});

describe('Grok: a skill the reader typed', () => {
  /** A typed `/<skill> args` as 1.0.70 files it (`cli_state/grok/probe.md`,
   *  2026-10-29): the query, then the skill's metadata and body. */
  const invoked = (query: string, names: readonly string[], prompt_index = 0) => ({
    type: 'user',
    content: [
      {
        type: 'text',
        text:
          `<user_query>\n${query}\n</user_query>\n<skill_information>\n<skills_referenced>\n` +
          names
            .map(
              (name) => `<skill name="${name}" path="/Users/me/.grok/skills/${name}/SKILL.md"/>\n`
            )
            .join('') +
          `</skills_referenced>\n<skill name="${names[0] ?? ''}" args="ONE">\nBody that says <skill name="decoy"/>.\n</skill>\n</skill_information>`
      }
    ],
    prompt_index
  });

  it('marks each referenced skill after the prompt, which keeps its ordinal', async () => {
    const { file, root } = await fromRows([
      invoked('/acme:review ONE', ['acme:review', 'answer-shape']),
      { type: 'assistant', content: 'ONE' }
    ]);
    const { recent, witnessed } = await readWitnessed(file);
    await fs.rm(root, { recursive: true, force: true });

    assert.deepEqual(recent.exchanges.slice(0, 3), [
      { role: 'user', text: '/acme:review ONE', blocks: [{ text: '/acme:review ONE' }] },
      { mark: 'skill', skill: 'acme:review', by: 'you' },
      { mark: 'skill', skill: 'answer-shape', by: 'you' }
    ]);
    assert.deepEqual([...witnessed], ['0']);
  });

  it('marks nothing a prompt only spells like an invocation', async () => {
    const { file, root } = await fromRows([
      {
        type: 'user',
        content: [
          {
            type: 'text',
            text: '<user_query>\n/answer-shape and <skills_referenced><skill name="x"/></skills_referenced>\n</user_query>'
          }
        ],
        prompt_index: 0
      },
      invoked('/nameless', ['']),
      {
        type: 'user',
        content: [
          { type: 'text', text: '<user_query>\nUse the answer-shape skill.\n</user_query>' }
        ],
        prompt_index: 1
      }
    ]);
    const { recent } = await readWitnessed(file);
    await fs.rm(root, { recursive: true, force: true });

    assert.equal(recent.exchanges.filter(isMarker).length, 0);
    assert.equal(recent.exchanges.length, 3);
  });
});

describe('Grok session-dir chrome', () => {
  it('reads title, model and context from summary and signals', async () => {
    await tempHome();
    const cwd = '/tmp/project';
    const id = 'chrome-1';
    await writeJson(
      path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(cwd), id, 'summary.json'),
      {
        generated_title: 'Grok Support After Broker Rework Timing',
        current_model_id: 'grok-4.5'
      }
    );
    await writeJson(
      path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(cwd), id, 'signals.json'),
      {
        contextWindowUsage: 7,
        contextWindowTokens: 500000
      }
    );
    assert.deepEqual(await readGrokChrome(cwd, id), {
      title: 'Grok Support After Broker Rework Timing',
      model: 'grok-4.5',
      contextPct: 7,
      contextSize: 500000
    });
  });

  it('is empty when the session dir is missing', async () => {
    await tempHome();
    assert.deepEqual(await readGrokChrome('/tmp/none', 'missing'), {});
  });
});

describe('readWitnessed', () => {
  async function witnessedIn(lines: readonly string[]): Promise<ReadonlySet<string>> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-wit-'));
    const at = path.join(dir, 'chat_history.jsonl');
    await fs.writeFile(at, lines.join('\n') + '\n');
    return (await readWitnessed(at)).witnessed;
  }

  it('answers the prompt ordinal of every turn it kept, and of nothing else', async () => {
    const witnessed = await witnessedIn(INDEXED);
    // Not the reminder's 7: a row the walk drops would sit in `theirs` for
    // ever, match nothing the tee stamped, and pin the card to the fallback.
    assert.deepEqual([...witnessed].sort(), ['0', '1']);
  });

  it('counts a ping as the prompt the CLI filed it as', async () => {
    const ping = wrapWarm(WARM_PROMPT);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-wit-'));
    const at = path.join(dir, 'chat_history.jsonl');
    await fs.writeFile(
      at,
      [
        ...INDEXED,
        JSON.stringify({
          type: 'user',
          content: [{ type: 'text', text: `<user_query>\n${ping}\n</user_query>` }],
          prompt_index: 2
        })
      ].join('\n') + '\n'
    );
    const { witnessed, recent } = await readWitnessed(at);
    // Our record stamps the ping's ordinal too; one missing here reads as a
    // prompt the record holds and the CLI lost.
    assert.deepEqual([...witnessed].sort(), ['0', '1', '2']);
    const last = recent.exchanges.at(-1);
    assert.ok(last && !isMarker(last) && last.role === 'warm');
  });

  it('answers an empty set for a file that names no ordinal', async () => {
    assert.equal((await witnessedIn(LINES)).size, 0);
  });

  it('answers an empty set for a file that is not there', async () => {
    const { witnessed, recent } = await readWitnessed('/nowhere/chat_history.jsonl');
    assert.equal(witnessed.size, 0, 'no evidence either way, which draws the record');
    assert.deepEqual(recent, { exchanges: [], truncated: false });
  });

  it('hands back the same objects while neither file has moved', async () => {
    // `drawableFor` compares both by reference, and `renderTranscript` skips a
    // whole view rebuild when the reading is the one it drew last.
    const first = await readWitnessed(file);
    const second = await readWitnessed(file);
    assert.equal(second.recent, first.recent);
    assert.equal(second.witnessed, first.witnessed);
  });

  it('re-reads when only the sibling updates.jsonl has moved', async () => {
    // The alarms in the thread come out of `updates.jsonl` and are exactly the
    // events that never touch `chat_history.jsonl` (README P7), so a cache
    // stamped on the history alone freezes them out for good.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-alarm-'));
    const at = path.join(dir, 'chat_history.jsonl');
    await fs.writeFile(at, INDEXED.join('\n') + '\n');
    await fs.writeFile(path.join(dir, 'updates.jsonl'), '');
    const before = (await readWitnessed(at)).recent;
    assert.equal(before.exchanges.filter((x) => !isMarker(x) && x.role === 'cli').length, 0);

    await fs.writeFile(
      path.join(dir, 'updates.jsonl'),
      [
        JSON.stringify({
          method: 'session/update',
          params: {
            update: { sessionUpdate: 'user_message_chunk', _meta: { promptIndex: 1 } }
          }
        }),
        JSON.stringify({
          method: '_x.ai/session/update',
          params: {
            update: {
              sessionUpdate: 'turn_completed',
              stop_reason: 'error',
              agent_result: 'API error (status 402): balance exhausted'
            }
          }
        })
      ].join('\n') + '\n'
    );
    const after = (await readWitnessed(at)).recent;
    const alarms = after.exchanges.filter((x) => !isMarker(x) && x.role === 'cli');
    assert.equal(alarms.length, 1, 'the alarm arrives without the history file moving');
  });
});

describe('disk-only prompt echo', () => {
  const sentAt = 1_700_000_000_550;
  const seconds = Math.floor(sentAt / 1_000);
  const row = (overrides: object = {}) => ({
    method: '_x.ai/session/update',
    timestamp: seconds,
    params: {
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'same' } }
    },
    ...overrides
  });
  const timed = (at: number, timestamp: number) =>
    row({
      timestamp,
      params: {
        _meta: { agentTimestampMs: at },
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'same' } }
      }
    });
  const indexed = (at: number, promptIndex: number) => {
    const value = timed(at, seconds);
    return {
      ...value,
      params: {
        ...value.params,
        update: { ...value.params.update, _meta: { promptIndex } }
      }
    };
  };
  for (const offset of [-3, 2]) {
    it(`accepts a millisecond echo ${offset} ms beyond the send window`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-boundary-'));
      try {
        await fs.writeFile(
          path.join(dir, 'updates.jsonl'),
          JSON.stringify(timed(sentAt + offset, seconds)) + '\n'
        );
        assert.equal(
          (await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, 'same', sentAt))
            ?.at,
          sentAt + offset
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('searches an older byte window for an early echo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-window-'));
    try {
      const filler = JSON.stringify({ padding: 'x'.repeat(1_100_000) });
      const oldest = timed(sentAt - 3, seconds);
      await fs.writeFile(
        path.join(dir, 'updates.jsonl'),
        [
          oldest,
          filler,
          { timestamp: seconds, params: { _meta: { agentTimestampMs: sentAt - 3 } } }
        ]
          .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
          .join('\n') + '\n'
      );
      assert.equal(
        (await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, 'same', sentAt))
          ?.at,
        sentAt - 3
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  for (const scenario of [
    {
      name: 'skips malformed update lines',
      before: ['{"sessionUpdate":"user_message_chunk"'],
      match: row(),
      at: seconds * 1_000
    },
    {
      name: 'skips echoes on the wrong method',
      before: [JSON.stringify(row({ method: 'other' }))],
      match: row(),
      at: seconds * 1_000
    },
    {
      name: 'rejects stale milliseconds despite newer seconds',
      before: [JSON.stringify(timed(sentAt - 4, seconds + 1))],
      match: row(),
      at: seconds * 1_000
    },
    {
      name: 'accepts milliseconds despite older seconds',
      before: [],
      match: timed(sentAt, seconds - 1),
      at: sentAt
    },
    {
      name: 'accepts seconds-only echoes within the send second',
      before: [JSON.stringify(row({ timestamp: seconds - 1 }))],
      match: row(),
      at: seconds * 1_000
    },
    {
      name: 'matches trimmed prompt text',
      before: [],
      match: row({
        params: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: '  same\n\n' }
          }
        }
      }),
      at: seconds * 1_000
    }
  ]) {
    it(scenario.name, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-echo-'));
      try {
        await fs.writeFile(
          path.join(dir, 'updates.jsonl'),
          [...scenario.before, JSON.stringify(scenario.match)].join('\n') + '\n'
        );
        assert.deepEqual(
          await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, ' same '),
          {
            method: scenario.match.method,
            params: scenario.match.params,
            at: scenario.at
          }
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('returns no echo for an empty transcript path or missing update file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-echo-'));
    try {
      assert.equal(await readSentUserUpdate('', sentAt, 'same'), undefined);
      assert.equal(
        await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, 'same'),
        undefined
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  for (const offset of [-4, 3]) {
    it(`rejects an adjacent same-text echo ${offset} ms outside the send window`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-outside-'));
      try {
        await fs.writeFile(
          path.join(dir, 'updates.jsonl'),
          JSON.stringify(timed(sentAt + offset, seconds)) + '\n'
        );
        assert.equal(
          await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, 'same', sentAt),
          undefined
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('refuses indistinguishable adjacent prompts in overlapping windows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-ambiguous-'));
    try {
      await fs.writeFile(
        path.join(dir, 'updates.jsonl'),
        [indexed(sentAt - 3, 0), indexed(sentAt + 2, 1)]
          .map((value) => JSON.stringify(value))
          .join('\n') + '\n'
      );
      assert.equal(
        await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, 'same', sentAt),
        undefined
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not confuse repeated chunks of one prompt with adjacent prompt ordinals', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-chunks-'));
    try {
      for (const indexes of [
        [4, 4],
        [4, 5]
      ]) {
        await fs.writeFile(
          path.join(dir, 'updates.jsonl'),
          indexes.map((index) => JSON.stringify(indexed(sentAt - 1, index))).join('\n') + '\n'
        );
        const found = await readSentUserUpdate(
          path.join(dir, 'chat_history.jsonl'),
          sentAt,
          'same',
          sentAt
        );
        assert.equal(found?.at, indexes[0] === indexes[1] ? sentAt - 1 : undefined);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  for (const settledAt of [undefined, sentAt + 800]) {
    it(`keeps the first exact same-text echo with settlement ${settledAt === undefined ? 'unknown' : 'after the successor'}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-exact-'));
      try {
        const first = indexed(sentAt + 2, 0);
        await fs.writeFile(
          path.join(dir, 'updates.jsonl'),
          [first, indexed(sentAt + 500, 1)].map((value) => JSON.stringify(value)).join('\n') + '\n'
        );
        assert.deepEqual(
          await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, 'same', settledAt),
          { method: first.method, params: first.params, at: sentAt + 2 }
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('prefers an exact echo over conflicting tolerance-only ordinals', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-priority-'));
    try {
      const exact = indexed(sentAt, 2);
      await fs.writeFile(
        path.join(dir, 'updates.jsonl'),
        [indexed(sentAt - 3, 0), indexed(sentAt - 1, 1), exact]
          .map((value) => JSON.stringify(value))
          .join('\n') + '\n'
      );
      assert.deepEqual(
        await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, 'same', sentAt),
        { method: exact.method, params: exact.params, at: sentAt }
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  for (const offset of [-1, 0]) {
    it(`keeps the first image chunk of an ordinal at offset ${offset}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-first-image-'));
      try {
        const images = ['first', 'second'].map((data) => {
          const value = indexed(sentAt + offset, 4);
          return {
            ...value,
            params: {
              ...value.params,
              update: {
                ...value.params.update,
                content: { type: 'image', data, mimeType: 'image/png' }
              }
            }
          };
        });
        await fs.writeFile(
          path.join(dir, 'updates.jsonl'),
          images.map((value) => JSON.stringify(value)).join('\n') + '\n'
        );
        assert.deepEqual(
          (await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), sentAt, '', sentAt))
            ?.params,
          images[0]?.params
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('retains second precision when the tolerated start crosses a second boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-seconds-'));
    try {
      const send = seconds * 1_000 + 1;
      await fs.writeFile(
        path.join(dir, 'updates.jsonl'),
        [row({ timestamp: seconds - 2 }), row({ timestamp: seconds - 1 })]
          .map((value) => JSON.stringify(value))
          .join('\n') + '\n'
      );
      assert.equal(
        (await readSentUserUpdate(path.join(dir, 'chat_history.jsonl'), send, 'same', send))?.at,
        (seconds - 1) * 1_000
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses Grok millisecond metadata to distinguish repeated prompts and an image-only turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-echo-'));
    const transcript = path.join(dir, 'chat_history.jsonl');
    const start = 1_700_000_000_000;
    const echo = (at: number, promptIndex: number, content: object) => ({
      timestamp: Math.floor(at / 1_000),
      method: 'session/update',
      params: {
        _meta: { agentTimestampMs: at },
        update: { sessionUpdate: 'user_message_chunk', content, _meta: { promptIndex } }
      }
    });
    await fs.writeFile(
      path.join(dir, 'updates.jsonl'),
      [
        echo(start - 20, 3, { type: 'text', text: 'same' }),
        echo(start + 10, 4, { type: 'text', text: 'same' }),
        { method: 'tool_update', padding: 'x'.repeat(1_100_000) },
        echo(start + 20, 5, { type: 'text', text: 'same' }),
        echo(start + 30, 6, { type: 'image', data: 'iVBOR', mimeType: 'image/png' })
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
    const textEcho = await readSentUserUpdate(transcript, start, 'same', start + 15);
    const imageEcho = await readSentUserUpdate(transcript, start + 25, '');
    assert.equal(
      (textEcho?.params as { update?: { _meta?: { promptIndex?: number } } })?.update?._meta
        ?.promptIndex,
      4
    );
    assert.equal(
      (imageEcho?.params as { update?: { _meta?: { promptIndex?: number } } })?.update?._meta
        ?.promptIndex,
      6
    );
    assert.equal(textEcho?.at, start + 10);
  });
});

describe('what a Grok turn wrote', () => {
  const repo = path.resolve('/repo');
  const at = (name: string): string => path.join(repo, name);
  const call = (name: string, args: unknown, id = 'c1') => ({
    id,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args)
  });

  const wrote = async (
    rows: unknown[],
    cwd = repo
  ): Promise<{ files?: string[]; sizes?: Record<string, { add: number; del: number }> }> => {
    const { file, root } = await fromRows(rows, cwd);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(root, { recursive: true, force: true });
    const turn = exchanges.find((x): x is Authored => !isMarker(x) && x.role === 'assistant');
    assert.ok(turn, 'expected an assistant turn');
    return { files: turn.files, sizes: turn.sizes };
  };

  it('names both writers and sizes each', async () => {
    const got = await wrote([
      {
        type: 'assistant',
        content: 'done',
        tool_calls: [
          call(
            'search_replace',
            { file_path: at('a.ts'), old_string: 'a\nb\n', new_string: 'a\nB\nc\n' },
            'c1'
          ),
          call('write', { file_path: at('b.ts'), content: 'x\ny\nz\n' }, 'c2')
        ]
      },
      { type: 'tool_result', tool_call_id: 'c1', content: 'ok' },
      { type: 'tool_result', tool_call_id: 'c2', content: 'ok' }
    ]);
    assert.deepEqual(got.files, [at('a.ts'), at('b.ts')]);
    assert.deepEqual(got.sizes, {
      [at('a.ts')]: { add: 2, del: 1 },
      [at('b.ts')]: { add: 3, del: 0 }
    });
  });

  it('resolves a relative file_path against the cwd in the session dir', async () => {
    const proj = path.resolve('/Users/me/proj');
    const got = await wrote(
      [
        {
          type: 'assistant',
          content: '',
          tool_calls: [
            call('search_replace', { file_path: 'src/a.ts', old_string: 'a\n', new_string: 'b\n' })
          ]
        },
        { type: 'tool_result', tool_call_id: 'c1', content: 'ok' }
      ],
      proj
    );
    assert.deepEqual(got.files, [path.join(proj, 'src', 'a.ts')]);
  });

  it('sums two edits to one file into one path and one pill', async () => {
    const got = await wrote([
      {
        type: 'assistant',
        content: '',
        tool_calls: [
          call(
            'search_replace',
            { file_path: at('a.ts'), old_string: 'a\n', new_string: 'b\n' },
            'c1'
          ),
          call(
            'search_replace',
            { file_path: at('a.ts'), old_string: 'x\n', new_string: 'y\nz\n' },
            'c2'
          )
        ]
      },
      { type: 'tool_result', tool_call_id: 'c1', content: 'ok' },
      { type: 'tool_result', tool_call_id: 'c2', content: 'ok' }
    ]);
    assert.deepEqual(got.files, [at('a.ts')], 'one path, deduped');
    assert.deepEqual(got.sizes, { [at('a.ts')]: { add: 3, del: 2 } }, 'summed, not replaced');
  });

  it('lets a read contribute nothing, since it names its path differently', async () => {
    // `read_file` writes `target_file`, so the `WRITES` gate has no false
    // positive to guard against on this brand — the census is in the task file.
    const got = await wrote([
      {
        type: 'assistant',
        content: '',
        tool_calls: [
          call('read_file', { target_file: at('a.ts') }, 'c1'),
          call('grep', { pattern: 'x', path: repo }, 'c2')
        ]
      },
      { type: 'tool_result', tool_call_id: 'c1', content: 'ok' },
      { type: 'tool_result', tool_call_id: 'c2', content: 'ok' }
    ]);
    assert.equal(got.files, undefined);
    assert.equal(got.sizes, undefined);
  });

  it('keeps the path of a write it could not size', async () => {
    // The `±?` pill: in `WRITES`, names a file, but the size keys arrived wrong.
    const got = await wrote([
      {
        type: 'assistant',
        content: '',
        tool_calls: [call('search_replace', { file_path: at('a.ts'), old_string: 'a\n' })]
      },
      { type: 'tool_result', tool_call_id: 'c1', content: 'ok' }
    ]);
    assert.deepEqual(got.files, [at('a.ts')]);
    assert.equal(got.sizes, undefined);
  });

  it('takes a write whose result never came', async () => {
    // Gathered off every call in the row, not off the paired ones the turn
    // draws: an unpaired call is still running or blocked on a permission, and
    // the write is still one the turn asked for.
    const got = await wrote([
      {
        type: 'assistant',
        content: 'working on it',
        tool_calls: [call('write', { file_path: at('pending.ts'), content: 'a\nb\n' }, 'c9')]
      }
    ]);
    assert.deepEqual(got.files, [at('pending.ts')]);
    assert.deepEqual(got.sizes, { [at('pending.ts')]: { add: 2, del: 0 } });
  });

  it('names no file when the arguments string will not parse', async () => {
    const got = await wrote([
      {
        type: 'assistant',
        content: '',
        tool_calls: [call('search_replace', '{"file_path": "/repo/a.ts", "old_str')]
      },
      { type: 'tool_result', tool_call_id: 'c1', content: 'ok' }
    ]);
    assert.equal(got.files, undefined);
    assert.equal(got.sizes, undefined);
  });
});

it('keeps anonymous fallback assistant rows outside an unproven warm span', async () => {
  const file = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'warm-unowned-')),
    'chat_history.jsonl'
  );
  try {
    await fs.writeFile(
      file,
      [
        {
          type: 'user',
          content: [{ type: 'text', text: `<user_query>${wrapWarm(WARM_PROMPT)}</user_query>` }],
          prompt_index: 0
        },
        { type: 'assistant', content: 'OK' },
        { type: 'assistant', content: 'unsolicited work' }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')
    );
    const read = await readGrokTranscript(file);
    const real = read.exchanges.find((x) => 'role' in x && x.text === 'unsolicited work');
    assert.ok(real && 'maintenance' in real && real.maintenance === false);
  } finally {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  }
});
