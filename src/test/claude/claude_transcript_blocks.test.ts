import * as assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { assistant, setup, text, turnsIn, user, write } from './claude_transcript_helpers';
before(setup);

describe('the blocks a turn is made of', () => {
  /** One call as the CLI writes it: an id, a name, and whatever input. */
  const call = (name: string, input?: unknown, id = 'toolu_1') => ({
    type: 'tool_use',
    id,
    name,
    input
  });
  /** What each block is, flattened to something an assertion can read. */
  const shapes = (blocks: import('../../core/transcript').Block[] | undefined) =>
    (blocks ?? []).map((b) => ('text' in b ? `text:${b.text}` : `call:${b.call.name}`));

  it('keeps the entry’s own interleaving', async () => {
    const file = await write('interleaved', [
      user('go'),
      assistant([
        { type: 'text', text: 'let me check' },
        call('Bash', { command: 'ls' }),
        { type: 'text', text: 'found it' },
        call('Read', { file_path: '/a/b.ts' }, 'toolu_2')
      ])
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(shapes(turns.at(1)?.blocks), [
      'text:let me check',
      'call:Bash',
      'text:found it',
      'call:Read'
    ]);
  });

  it('carries a call’s id, name and input', async () => {
    const file = await write('call-shape', [
      user('go'),
      assistant([call('Bash', { command: 'ls', description: 'List files' }, 'toolu_9')])
    ]);
    const blocks = (await turnsIn(file)).at(1)?.blocks ?? [];
    assert.deepEqual(blocks, [
      {
        call: {
          id: 'toolu_9',
          name: 'Bash',
          input: { command: 'ls', description: 'List files' }
        }
      }
    ]);
  });

  it('writes no block for the empty run the CLI opens a tool turn with', async () => {
    const file = await write('empty-run', [
      user('go'),
      assistant([{ type: 'text', text: '  ' }, call('Bash', { command: 'ls' })])
    ]);
    assert.deepEqual(shapes((await turnsIn(file)).at(1)?.blocks), ['call:Bash']);
  });

  it('cuts a string the size of a file down at ingest', async () => {
    const file = await write('fat-input', [
      user('go'),
      assistant([call('Write', { file_path: '/a/b.ts', content: 'x'.repeat(50_000) })])
    ]);
    const blocks = (await turnsIn(file)).at(1)?.blocks ?? [];
    const first = blocks[0];
    assert.ok(first && 'call' in first);
    assert.equal(String(first.call.input?.['content']).length, 300);
    // The path is what a row is about, and is nowhere near the cut.
    assert.equal(first.call.input?.['file_path'], '/a/b.ts');
  });

  it('caps an input that is deep, and an array that is long', async () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const deep = { a: { b: { c: { d: { e: { f: 'too far' } } } } } };
    const file = await write('big-input', [
      user('go'),
      assistant([call('Weird', { ...wide, list: Array.from({ length: 40 }, (_, i) => i), deep })])
    ]);
    const blocks = (await turnsIn(file)).at(1)?.blocks ?? [];
    const first = blocks[0];
    assert.ok(first && 'call' in first);
    const input = first.call.input ?? {};
    assert.equal((input['list'] as unknown[]).length, 8);
    assert.equal((input['k0'] as number) + 1, 1);
    // Says both halves of the cut at once: nothing five levels down survived,
    // and what was cut left no `null` behind to be read as a value the tool sent.
    assert.equal(JSON.stringify(input['deep']), '{"a":{"b":{"c":{}}}}');
  });

  it('drops an array entry the depth cut, rather than holing the array', async () => {
    // The other half of the same cut, and the one an object can never show: a
    // cut *key* simply is not there, where a cut *element* stayed as a hole and
    // serialised to `null` — which reads back as a null the tool sent.
    //
    // The array has to sit *at* the cut for its elements to be past it, which is
    // why this fixture is deeper than the ask that motivated the depth. Nothing
    // measured on this machine goes six levels down (see `MAX_INPUT_DEPTH`), so
    // this is the guard rather than a case in the wild.
    const deep = { a: { b: { c: { list: [{ x: 1 }, { y: 2 }] } } } };
    const file = await write('holed-array', [user('go'), assistant([call('Weird', deep)])]);
    const blocks = (await turnsIn(file)).at(1)?.blocks ?? [];
    const first = blocks[0];
    assert.ok(first && 'call' in first);
    assert.equal(JSON.stringify(first.call.input?.['a']), '{"b":{"c":{"list":[]}}}');
  });

  it('keeps a named key an author wrote late in a wide input', async () => {
    // The count is not the weight: a long string is, and that is cut on its
    // own. Dropping fields past the eighth cost the summary the one key it
    // reads — measured over 974 transcripts, an input wider than eight fields
    // turned up twice and both times the drop took a key `ui/activity.ts`
    // looks for.
    const before = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    const file = await write('late-key', [
      user('go'),
      assistant([call('mcp__tool__do', { ...before, file_path: '/a/b.ts', query: 'why' })])
    ]);
    const blocks = (await turnsIn(file)).at(1)?.blocks ?? [];
    const first = blocks[0];
    assert.ok(first && 'call' in first);
    assert.equal(first.call.input?.['file_path'], '/a/b.ts');
    assert.equal(first.call.input?.['query'], 'why');
  });

  it('holds an ask’s options whole, which is what the depth is sized for', async () => {
    // Why `MAX_INPUT_DEPTH` is what it is — the census is on the constant. What
    // this adds is the stake: an unanswered ask has only its input, so cutting
    // the options erased the picks from the one call our record is meant to hold
    // better than the CLI's file does.
    const questions = [
      {
        question: 'Which ticket?',
        header: 'FE ticket',
        multiSelect: true,
        options: [
          { label: 'ENG-1926', description: 'the CRUD UI' },
          { label: 'ENG-1232 only', description: 'change no status anywhere' }
        ]
      }
    ];
    const file = await write('ask-input', [
      user('go'),
      assistant([call('AskUserQuestion', { questions })])
    ]);
    const blocks = (await turnsIn(file)).at(1)?.blocks ?? [];
    const first = blocks[0];
    assert.ok(first && 'call' in first);
    assert.deepEqual(first.call.input?.['questions'], questions);
  });

  it('holds no input for a call whose input is not an object', async () => {
    const file = await write('odd-input', [
      user('go'),
      assistant([call('Bash', 'ls -la'), call('Read', null, 'toolu_2')])
    ]);
    const blocks = (await turnsIn(file)).at(1)?.blocks ?? [];
    assert.deepEqual(
      blocks.map((b) => ('call' in b ? b.call.input : 'text')),
      [undefined, undefined]
    );
  });

  it('stamps a turn with when the CLI wrote it', async () => {
    const file = await write('stamped', [
      { ...user('go'), timestamp: '2026-07-29T10:00:00.000Z' },
      { ...assistant(text('done')), timestamp: '2026-07-29T10:01:12.000Z' },
      { ...assistant(text('and this')), timestamp: 'never' }
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.at),
      [Date.parse('2026-07-29T10:00:00.000Z'), Date.parse('2026-07-29T10:01:12.000Z'), undefined]
    );
  });

  it('merges a run of wordless tool entries in the order they ran', async () => {
    const file = await write('merged-blocks', [
      user('go'),
      assistant(text('checking')),
      assistant([call('Bash', { command: 'ls' })]),
      assistant([call('Read', { file_path: '/a/b.ts' }, 'toolu_2')]),
      assistant([call('Edit', { file_path: '/a/b.ts' }, 'toolu_3')])
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(shapes(turns.at(1)?.blocks), ['text:checking']);
    assert.deepEqual(shapes(turns.at(2)?.blocks), ['call:Bash', 'call:Read', 'call:Edit']);
  });

  it('gives each message of a batched send its own words', async () => {
    const file = await write('batched-blocks', [
      user([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' }
      ])
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => shapes(x.blocks)),
      [['text:first'], ['text:second']]
    );
  });

  it('drops the Skill call the chip beside it already names', async () => {
    const file = await write('skill-block', [
      user('clean it up'),
      assistant([
        call('Skill', { skill: 'ponytail' }),
        call('Read', { file_path: '/a' }, 'toolu_2')
      ]),
      { ...user('Base directory for this skill: /skills/ponytail'), isMeta: true },
      assistant(text('done'))
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(shapes(turns.at(1)?.blocks), ['call:Read']);
  });
});

describe('what a call returned', () => {
  const call = (name: string, input?: unknown, id = 'toolu_1') => ({
    type: 'tool_use',
    id,
    name,
    input
  });
  const result = (id: string, content: unknown, is_error?: boolean) => [
    { type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error } : {}) }
  ];
  /** Every call of a turn, in order. */
  const callsOf = (turn: import('../../core/transcript').Authored | undefined) =>
    (turn?.blocks ?? []).flatMap((b) => ('call' in b ? [b.call] : []));

  it('pairs a result written on the entry after its call', async () => {
    const file = await write('paired', [
      user('go'),
      assistant([call('Bash', { command: 'ls' })]),
      user(result('toolu_1', 'a.ts\nb.ts')),
      assistant(text('done'))
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(callsOf(turns.at(1)), [
      { id: 'toolu_1', name: 'Bash', input: { command: 'ls' }, output: 'a.ts\nb.ts' }
    ]);
  });

  it('marks a call the result called an error', async () => {
    const file = await write('failed', [
      user('go'),
      assistant([call('Bash', { command: 'nope' })]),
      user(result('toolu_1', 'Exit code 1\ncommand not found', true))
    ]);
    const first = callsOf((await turnsIn(file)).at(1)).at(0);
    assert.equal(first?.failed, true);
    // The line that says what went wrong is the first one, which is why nothing
    // is stripped off the end.
    assert.match(String(first?.output), /^Exit code 1/);
  });

  it('cuts a long result at ingest, and says it was cut', async () => {
    const file = await write('long-result', [
      user('go'),
      assistant([call('Bash', { command: 'cat big' })]),
      user(result('toolu_1', 'y'.repeat(5000)))
    ]);
    const output = callsOf((await turnsIn(file)).at(1)).at(0)?.output ?? '';
    assert.equal(output.length, 181);
    assert.ok(output.endsWith('…'));
  });

  it('reads a result written as blocks, and keeps only its words', async () => {
    const file = await write('block-result', [
      user('go'),
      assistant([call('Read', { file_path: '/a/b.ts' })]),
      user(
        result('toolu_1', [
          { type: 'tool_reference', name: 'x' },
          { type: 'text', text: 'the file' }
        ])
      )
    ]);
    assert.equal(callsOf((await turnsIn(file)).at(1)).at(0)?.output, 'the file');
  });

  it('answers two calls of one entry with their own results', async () => {
    const file = await write('two-calls', [
      user('go'),
      assistant([
        call('Read', { file_path: '/a' }, 'toolu_1'),
        call('Read', { file_path: '/b' }, 'toolu_2')
      ]),
      user([
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'first' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'second' }
      ])
    ]);
    assert.deepEqual(
      callsOf((await turnsIn(file)).at(1)).map((c) => c.output),
      ['first', 'second']
    );
  });

  it('leaves a call still running with no output at all', async () => {
    const file = await write('in-flight', [
      user('go'),
      assistant([call('Bash', { command: 'sleep 30' })])
    ]);
    const first = callsOf((await turnsIn(file)).at(1)).at(0);
    assert.equal(first?.output, undefined);
    assert.equal(first?.failed, undefined);
  });

  it('ignores a result whose call this read never reached', async () => {
    const file = await write('orphan-result', [
      user([{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'from before' }]),
      user('go'),
      assistant(text('done'))
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['go', 'done']
    );
  });

  it('keeps a result out of the words, whatever else it does with it', async () => {
    // The turn a result rides is still not a turn: it is the same entry the
    // reader has always skipped, now read for one field on the way past.
    const file = await write('result-not-a-turn', [
      user('go'),
      assistant([call('Bash', { command: 'ls' })]),
      user(result('toolu_1', 'a.ts'))
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['go', '']
    );
  });
});
