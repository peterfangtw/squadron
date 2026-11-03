import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { before, describe, it } from 'node:test';

import { modeBitsSkip } from '../helpers';

import { WARM_PROMPT, wrapMessage, wrapWait, wrapWarm } from '../../core/coordination/send';

import { thinkingBlock } from '../fixtures/signature';

import {
  allIn,
  askIn,
  assistant,
  calls,
  home,
  setup,
  text,
  tool,
  transcript,
  turnsIn,
  user,
  write
} from './claude_transcript_helpers';

before(setup);

describe('transcriptPath', () => {
  it('slugs the working directory the way the CLI does', () => {
    assert.equal(
      transcript.transcriptPath('/Users/x/dev/app.v2', 'abc'),
      path.join(home, '.claude', 'projects', '-Users-x-dev-app-v2', 'abc.jsonl')
    );
  });

  it('replaces every non-alphanumeric, not just slashes and dots', () => {
    // The bug this caught: an underscore was left standing, so a derived path
    // missed a real transcript by one character and the dock showed an empty
    // thread. Not one of the 289 project directories on this machine contains
    // an underscore.
    assert.equal(transcript.projectSlug('/tmp/my_project (old)'), '-tmp-my-project--old-');
    assert.equal(transcript.projectSlug('/Users/x/dev/app.v2'), '-Users-x-dev-app-v2');
  });

  it('truncates a long slug and hashes the path it came from', () => {
    // The CLI's own arithmetic: 200 characters, then a dash, then the original
    // path through a 32-bit rolling hash in base 36.
    const long = '/' + 'abcdefghij'.repeat(30);
    const slug = transcript.projectSlug(long);
    assert.equal(slug.slice(0, 200), long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
    assert.match(slug.slice(200), /^-[0-9a-z]+$/);
    // A different path of the same length gets a different name, which is the
    // whole point of the suffix.
    assert.notEqual(slug, transcript.projectSlug(long.replace('abcdefghij', 'abcdefghik')));
  });

  it('leaves a slug of exactly the limit alone', () => {
    const exact = '/' + 'a'.repeat(199);
    assert.equal(transcript.projectSlug(exact).length, 200);
  });
});

describe('locateTranscript', () => {
  /** A transcript where the CLI would file one for `cwd`, stating that cwd on
   *  its own entries the way every entry does. */
  const file = async (cwd: string, sessionId: string): Promise<string> => {
    const at = transcript.transcriptPath(cwd, sessionId);
    await fs.mkdir(path.dirname(at), { recursive: true });
    await fs.writeFile(
      at,
      [
        JSON.stringify({ type: 'custom-title', customTitle: 'named', sessionId }),
        JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })
      ].join('\n') + '\n'
    );
    return at;
  };

  it('takes the derived path for a session that has stayed put', async () => {
    const at = await file('/tmp/still', 'put');
    assert.deepEqual(await transcript.locateTranscript('/tmp/still', 'put'), {
      file: at,
      home: '/tmp/still'
    });
  });

  // The bug this caught: the CLI rewrites the pid file's `cwd` on every `cd`,
  // so a session that stepped into a subdirectory derived a path under a
  // project directory that had never existed — an empty thread, and a card in a
  // group named after the subdirectory.
  it('finds a transcript the session has walked away from, and where it lives', async () => {
    const at = await file('/tmp/repo', 'walked');
    assert.deepEqual(await transcript.locateTranscript('/tmp/repo/docs/mockups', 'walked'), {
      file: at,
      home: '/tmp/repo'
    });
  });

  it('answers with the derivation when nothing is filed anywhere, and looks again', async () => {
    const derived = transcript.transcriptPath('/tmp/late', 'late');
    assert.deepEqual(await transcript.locateTranscript('/tmp/late/sub', 'late'), {
      file: transcript.transcriptPath('/tmp/late/sub', 'late'),
      home: '/tmp/late/sub'
    });
    // Not remembered as missing: a session writes its first entry some time
    // after the panel first sees it.
    await file('/tmp/late', 'late');
    assert.deepEqual(await transcript.locateTranscript('/tmp/late/sub', 'late'), {
      file: derived,
      home: '/tmp/late'
    });
  });

  it('leaves the session where it says it is when its transcript states no cwd', async () => {
    const at = transcript.transcriptPath('/tmp/mute', 'mute');
    await fs.mkdir(path.dirname(at), { recursive: true });
    await fs.writeFile(at, JSON.stringify({ type: 'custom-title', customTitle: 'named' }) + '\n');
    assert.deepEqual(await transcript.locateTranscript('/tmp/mute/sub', 'mute'), {
      file: at,
      home: '/tmp/mute/sub'
    });
  });

  // The bug this caught: a session that steps into a worktree reports the new
  // cwd on every `init`, and the CLI goes on appending to the file it filed
  // under the directory the conversation *began* in. Deriving again from the
  // moved cwd names a bucket that has never existed, so the dock said the
  // conversation was gone — in every window that was open while it moved.
  it('keeps the path the pipe pinned when the session has since moved', async () => {
    const at = await file('/tmp/pinned', 'pin');
    assert.deepEqual(
      await transcript.locateTranscript('/tmp/pinned/.worktrees/w34/apps/web', 'pin', at),
      { file: at, home: '/tmp/pinned' }
    );
  });

  // The blind spot deriving can never reach: the CLI slugs the *real* path, so
  // both the pinned path and the derivation miss for a session under a symlink
  // and only the sweep answers. A pinned path is a candidate, never a promise.
  it('sweeps past a pinned path that is not there', async () => {
    const at = await file('/private/tmp/link', 'behind');
    const pinned = transcript.transcriptPath('/tmp/link', 'behind');
    assert.deepEqual(await transcript.locateTranscript('/tmp/link', 'behind', pinned), {
      file: at,
      home: '/private/tmp/link'
    });
  });

  // Two files for one id is a state the CLI refuses — a start whose id already
  // has a transcript is rejected — so this pins the tie-break rather than a
  // case in the wild: what has been placed stays placed, and a caller cannot
  // move a card by pinning something else.
  it('keeps the transcript it has already placed', async () => {
    const at = await file('/tmp/twoplaces', 'twinned');
    assert.deepEqual(await transcript.locateTranscript('/tmp/twoplaces/sub', 'twinned'), {
      file: at,
      home: '/tmp/twoplaces'
    });
    const second = await file('/tmp/twoplaces/sub', 'twinned');
    assert.deepEqual(await transcript.locateTranscript('/tmp/twoplaces/sub', 'twinned', second), {
      file: at,
      home: '/tmp/twoplaces'
    });
  });

  // The bug this caught: `EnterWorktree` *moves* the transcript into the new
  // cwd's slug and writes a `relocated` entry, so the path placed before the
  // move names nothing. Held rather than re-stat'd, it emptied the session's own
  // dock for the life of the panel and left its card in the group it started in
  // — reported 2026-08-18 against an `acme-web` session forty minutes after
  // it entered `.worktrees/discount-application`.
  it('lets go of a path the transcript was relocated away from', async () => {
    const at = await file('/tmp/entered', 'moved');
    assert.deepEqual(await transcript.locateTranscript('/tmp/entered', 'moved', at), {
      file: at,
      home: '/tmp/entered'
    });
    const worktree = '/tmp/entered/.worktrees/w1';
    const now = transcript.transcriptPath(worktree, 'moved');
    await fs.mkdir(path.dirname(now), { recursive: true });
    await fs.rename(at, now);
    // Derives from the cwd `init` now states, the pin having nothing at it.
    assert.deepEqual(await transcript.locateTranscript(worktree, 'moved', at), {
      file: now,
      home: worktree
    });
  });

  it('does not believe a head naming the checkout the conversation began in', async () => {
    // Resuming a conversation in another directory copies its entries into a
    // file filed under the new one, so the head names the old checkout. Taking
    // it would move a running session's card into that checkout's group and
    // read its branch, while the session is running here.
    const at = transcript.transcriptPath('/tmp/tree', 'copied');
    await fs.mkdir(path.dirname(at), { recursive: true });
    await fs.writeFile(
      at,
      JSON.stringify({ type: 'user', cwd: '/tmp/origin', message: { content: 'hi' } }) + '\n'
    );
    assert.deepEqual(await transcript.locateTranscript('/tmp/tree/apps/web', 'copied'), {
      file: at,
      home: '/tmp/tree/apps/web'
    });
    // And re-taken per call rather than frozen: the head still names nothing
    // this directory answers to, so the answer follows the session back out of
    // the subdirectory instead of leaving its card in a group named after
    // wherever it was standing the first time anyone looked.
    assert.deepEqual(await transcript.locateTranscript('/tmp/tree', 'copied'), {
      file: at,
      home: '/tmp/tree'
    });
  });
});

describe('readRecent', () => {
  it('yields nothing for a transcript that is not there', async () => {
    assert.deepEqual(await turnsIn(path.join(home, 'nope.jsonl')), []);
  });

  it('returns the conversation oldest first', async () => {
    const file = await write('plain', [
      user('hello'),
      assistant(text('hi')),
      user('and then?'),
      assistant(text('this'))
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => [x.role, x.text]),
      [
        ['user', 'hello'],
        ['assistant', 'hi'],
        ['user', 'and then?'],
        ['assistant', 'this']
      ]
    );
  });

  it('keeps the indentation a message was typed with, in the block that draws it', async () => {
    // Two readings of one turn. `text` is what an echo is matched against and
    // what the injected-tag regexes are run over, so its edges go; the block is
    // what the dock renders, and a person pressed those spaces.
    const file = await write('indented', [user(text('  step one\n      step two  '))]);
    const [turn] = await turnsIn(file);
    const first = turn?.blocks?.[0];
    assert.equal(first && 'text' in first ? first.text : undefined, '  step one\n      step two  ');
    assert.equal(turn?.text, 'step one\n      step two');
  });

  it('keeps narration as summarised prose, and still drops thinking', async () => {
    // 2.1.280 files the prose before a call as its own `thinking` entry, tagged
    // `narration` in the signature; the question after it points at those words.
    const file = await write('narration', [
      user('draft it'),
      assistant([thinkingBlock('weighing it up', 'thinking')]),
      assistant([thinkingBlock('I drafted the message.', 'narration')]),
      assistant(tool('AskUserQuestion'))
    ]);
    const said = (await turnsIn(file)).flatMap((t) => t.blocks ?? []).filter((b) => 'text' in b);
    assert.deepEqual(said, [
      { text: 'draft it' },
      { text: 'I drafted the message.', summarized: true }
    ]);
  });

  it('drops sidechains, tool results and harness-injected turns', async () => {
    const file = await write('noise', [
      user('real'),
      { ...assistant(text('subagent')), isSidechain: true },
      user([{ type: 'tool_result', content: 'ok' }]),
      user('<system-reminder>ignore me</system-reminder>'),
      user('<local-command-stdout>output</local-command-stdout>'),
      {
        ...user('<local-command-caveat>Caveat: generated while running…</local-command-caveat>'),
        isMeta: true
      },
      { type: 'summary', summary: 'not a turn' },
      assistant(text('answer'))
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['real', 'answer']
    );
  });

  it('drops injected content it does not recognise rather than naming it', async () => {
    // `isMeta` is the harness's mark, not a skill's: a re-invocation notice and
    // an output-style preamble wear it too. Inventing a chip for whatever falls
    // through would name the next shape the CLI adds after its neighbour.
    const file = await write('residual', [
      user('real'),
      { ...user(text('(Re-invocation of /ponytail-review — already loaded)')), isMeta: true },
      assistant(text('answer'))
    ]);
    assert.deepEqual(
      (await allIn(file)).map((x) => ('mark' in x ? x.mark : x.text)),
      ['real', 'answer']
    );
  });

  describe('turns nobody typed', () => {
    it('collapses a tool-invoked skill to its name, and drops the duplicate tool', async () => {
      const file = await write('skill-tool', [
        user('clean it up'),
        assistant([
          { type: 'text', text: 'on it' },
          { type: 'tool_use', name: 'Skill' }
        ]),
        user([{ type: 'tool_result', content: 'Launching skill: ponytail' }]),
        {
          ...user(
            text('Base directory for this skill: /Users/x/.claude/skills/ponytail\n\nBe lazy.')
          ),
          isMeta: true
        },
        assistant(text('cut four lines'))
      ]);
      assert.deepEqual(
        (await allIn(file)).map((x) =>
          'mark' in x ? [x.mark, x.skill] : [x.role, calls(x).length ? calls(x) : undefined]
        ),
        [
          ['user', undefined],
          ['assistant', undefined],
          ['skill', 'ponytail'],
          ['assistant', undefined]
        ]
      );
    });

    it('tells a skill the reader typed from one the session reached for', async () => {
      // Both write the same body. The command entry directly above it is the
      // only proof anybody asked — and it is what the dock needs to show the
      // reader's own turn, since a slash command never lands as one.
      const dir = (name: string) =>
        text(`Base directory for this skill: /Users/x/.claude/skills/${name}`);
      const file = await write('by-whom', [
        user('<command-message>ponytail</command-message>\n<command-name>/ponytail</command-name>'),
        { ...user(dir('ponytail')), isMeta: true },
        assistant([
          { type: 'text', text: 'lazy mode' },
          { type: 'tool_use', name: 'Skill' }
        ]),
        { ...user(dir('drawio')), isMeta: true },
        assistant(text('drawn'))
      ]);
      assert.deepEqual(
        (await allIn(file)).map((x) => ('mark' in x ? [x.skill, x.by] : x.role)),
        [['ponytail', 'you'], 'assistant', ['drawio', 'agent'], 'assistant']
      );
    });

    it('names a typed slash command from the entry above its body', async () => {
      // The typed path writes no `Base directory` line, so the name is only in
      // the command entry — which the backwards walk meets after the body.
      const file = await write('skill-typed', [
        user('<command-message>simplify</command-message>\n<command-name>/simplify</command-name>'),
        { ...user(text('You are improving the quality of the changed code…')), isMeta: true },
        assistant(text('four agents'))
      ]);
      assert.deepEqual(
        (await allIn(file)).map((x) => ('mark' in x ? [x.mark, x.skill, x.by] : [x.role, x.text])),
        [
          ['skill', 'simplify', 'you'],
          ['assistant', 'four agents']
        ]
      );
    });

    it('marks a command that expanded into nothing', async () => {
      // This used to assert the chip's absence, on the reading that a command
      // with no body expanded into nothing worth showing. What it actually
      // described was every built-in: `/model`, `/clear`, `/cost` all reach here,
      // and the thread showed their output with nothing saying who asked.
      const file = await write('bare-command', [
        user('<command-message>clear</command-message>\n<command-name>/clear</command-name>'),
        assistant(text('done'))
      ]);
      assert.deepEqual(
        (await allIn(file)).map((x) => ('mark' in x ? [x.mark, x.skill, x.by] : x.text)),
        [['skill', 'clear', 'you'], 'done']
      );
    });

    it('marks both spellings of an interrupt, and keeps their words out', async () => {
      const file = await write('breaks', [
        user('[Request interrupted by user]'),
        user('[Request interrupted by user for tool use]'),
        assistant(text('picking up'))
      ]);
      assert.deepEqual(
        (await allIn(file)).map((x) => ('mark' in x ? x.mark : x.text)),
        ['break', 'break', 'picking up']
      );
    });

    it('gives the CLI its own author when it answers in the model’s place', async () => {
      const file = await write('synthetic', [
        user('run it'),
        {
          ...assistant(text('API Error: Connection closed mid-response.')),
          message: {
            model: '<synthetic>',
            content: text('API Error: Connection closed mid-response.')
          }
        },
        // `isApiErrorMessage` is false on this one, which is why the model field
        // is what decides and the flag is not.
        {
          ...assistant(text('No response requested.')),
          message: { model: '<synthetic>', content: text('No response requested.') },
          isApiErrorMessage: false
        },
        {
          ...assistant(text('real answer')),
          message: { model: 'claude-opus-5', content: text('real answer') }
        }
      ]);
      assert.deepEqual(
        (await turnsIn(file)).map((x) => [x.role, x.text]),
        [
          ['user', 'run it'],
          ['cli', 'API Error: Connection closed mid-response.'],
          ['cli', 'No response requested.'],
          ['assistant', 'real answer']
        ]
      );
    });

    it('carries the skill a turn ran under, plugin scope and all', async () => {
      const file = await write('attribution', [
        user('commit it'),
        { ...assistant(text('writing it')), attributionSkill: 'caveman:caveman-commit' },
        assistant(text('unattributed'))
      ]);
      assert.deepEqual(
        (await turnsIn(file)).map((x) => x.skill),
        [undefined, 'caveman:caveman-commit', undefined]
      );
    });

    it('does not spend the turn budget on markers', async () => {
      // Twenty turns is twenty things somebody said. A session that ran skills
      // should not show fewer of them for it.
      const entries: unknown[] = [];
      for (let i = 0; i < 20; i++) {
        entries.push(user(`ask ${i}`), { ...user(text('[Request interrupted by user]')), i });
      }
      const file = await write('budget', entries);
      assert.equal((await turnsIn(file)).length, 20);
    });
  });

  it('drops the CLI note describing an attached image', async () => {
    const file = await write('shot', [
      user('look\n/tmp/shot.png'),
      user('[Image: original 2460x1702, displayed at 2000x1384. Multiply by 1.23.]'),
      assistant(text('seen'))
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['look\n/tmp/shot.png', 'seen']
    );
  });

  it('merges consecutive tool-only turns into one', async () => {
    const file = await write('tools', [
      user('do it'),
      assistant(tool('Bash')),
      assistant(tool('Read')),
      assistant(text('done'))
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(
      turns.map((x) => x.text),
      ['do it', '', 'done']
    );
    assert.deepEqual(calls(turns[1]), ['Bash', 'Read']);
  });

  it('keeps tools alongside the text of the turn that ran them', async () => {
    const file = await write('mixed', [
      user('go'),
      assistant([...text('running it'), ...tool('Edit')])
    ]);
    const turns = await turnsIn(file);
    assert.equal(turns[1]?.text, 'running it');
    assert.deepEqual(calls(turns[1]), ['Edit']);
  });

  describe('a message another session sent', () => {
    const wrapped = (from: string, body: string) =>
      `<squadron-message from="${from}">\n${body}\n</squadron-message>`;

    it('is a user turn holding the message, and names who sent it', async () => {
      const file = await write('peer-plain', [user(text(wrapped('sess-a', 'take the review')))]);
      const turns = await allIn(file);
      assert.deepEqual(
        turns.map((x) => ('mark' in x ? ['mark', x.mark] : [x.role, x.text, x.from])),
        [['user', 'take the review', 'sess-a']]
      );
    });

    it('keeps the message out of the blocks the wrapper was in', async () => {
      const file = await write('peer-blocks', [user(text(wrapped('sess-a', 'the brief')))]);
      const [turn] = await turnsIn(file);
      assert.deepEqual(turn?.blocks, [{ text: 'the brief' }]);
    });

    it('leaves a turn somebody typed alone', async () => {
      const file = await write('peer-human', [user(text('take the review'))]);
      const [turn] = await turnsIn(file);
      assert.equal(turn?.text, 'take the review');
      assert.equal(turn?.from, undefined);
    });

    // Anchored at both ends: a session explaining the wrapper is not wearing it.
    it('leaves a turn that merely quotes the tag alone', async () => {
      const quoted = `the reader sees ${wrapped('sess-a', 'this')} on arrival`;
      const file = await write('peer-quoted', [user(text(quoted))]);
      const [turn] = await turnsIn(file);
      assert.equal(turn?.text, quoted);
      assert.equal(turn?.from, undefined);
    });

    // The merge the plan accepts: our message goes ahead of a row the reader
    // was holding, and the CLI hands both to one turn as a block each.
    it('names the author of the one send that has one, in a batch', async () => {
      const file = await write('peer-batch', [
        user([
          { type: 'text', text: wrapped('sess-a', 'from the peer') },
          { type: 'text', text: 'and what I typed' }
        ])
      ]);
      const turns = await turnsIn(file);
      assert.deepEqual(
        turns.map((x) => [x.text, x.from]),
        [
          ['from the peer', 'sess-a'],
          ['and what I typed', undefined]
        ]
      );
    });

    it('is not what the prompt-nav stops on', async () => {
      const at = '2026-07-29T10:00:00.000Z';
      const later = '2026-07-29T11:00:00.000Z';
      const file = await write('peer-prompt-at', [
        { ...user(text('what I asked for')), timestamp: at },
        { ...user(text(wrapped('sess-a', 'and what arrived'))), timestamp: later }
      ]);
      assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
    });
  });

  describe('a wait converging', () => {
    // The CLI files it as an ordinary `user` entry — it entered as a prompt —
    // so attribution is recovered here, out of the words themselves.
    const converged = (body: string) => `<squadron-wait>\n${body}\n</squadron-wait>`;

    it('is its own author, and names nobody', async () => {
      const said = 'All 2 sessions you were waiting on have finished.';
      const file = await write('wait-plain', [user(text(converged(said)))]);
      const turns = await allIn(file);
      assert.deepEqual(
        turns.map((x) => ('mark' in x ? ['mark', x.mark] : [x.role, x.text, x.from])),
        [['wait', said, undefined]]
      );
    });

    it('keeps the resolution out of the blocks the wrapper was in', async () => {
      const file = await write('wait-blocks', [user(text(converged('- 201: finished')))]);
      const [turn] = await turnsIn(file);
      assert.deepEqual(turn?.blocks, [{ text: '- 201: finished' }]);
    });

    it('leaves a turn that merely quotes the tag alone', async () => {
      const quoted = `it arrives as ${converged('this')} on the pipe`;
      const file = await write('wait-quoted', [user(text(quoted))]);
      const [turn] = await turnsIn(file);
      assert.equal(turn?.role, 'user');
      assert.equal(turn?.text, quoted);
    });

    it('is not what the prompt-nav stops on', async () => {
      const at = '2026-07-29T10:00:00.000Z';
      const later = '2026-07-29T11:00:00.000Z';
      const file = await write('wait-prompt-at', [
        { ...user(text('go and review those three')), timestamp: at },
        { ...user(text(converged('All 3 have finished.'))), timestamp: later }
      ]);
      assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
    });
  });

  describe('a cache-warming ping', () => {
    it('is not what the prompt-nav stops on', async () => {
      // The CLI files it as an ordinary `user` entry, as it does a wait.
      const at = '2026-07-29T10:00:00.000Z';
      const later = '2026-07-29T11:00:00.000Z';
      const file = await write('warm-prompt-at', [
        { ...user(text('go and review those three')), timestamp: at },
        { ...user(text(wrapWarm(WARM_PROMPT))), timestamp: later },
        {
          type: 'assistant',
          timestamp: later,
          message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] }
        }
      ]);
      assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
    });

    it('is its own author, in its words without the envelope', async () => {
      // What the dock folds is this role; a ping read as `user` would draw as
      // the reader's own bubble off the CLI's file and nowhere else.
      const file = await write('warm-role', [
        user(text('go')),
        user(text(wrapWarm(WARM_PROMPT))),
        assistant(text('OK'))
      ]);
      const turns = await allIn(file);
      assert.deepEqual(
        turns.map((x) => ('mark' in x ? ['mark', x.mark] : [x.role, x.text, x.from])),
        [
          ['user', 'go', undefined],
          ['warm', WARM_PROMPT, undefined],
          ['assistant', 'OK', undefined]
        ]
      );
      const [, ping] = await turnsIn(file);
      assert.deepEqual(ping?.blocks, [{ text: WARM_PROMPT }]);
    });

    it('keeps output with no native warm ownership visible in a fallback', async () => {
      const file = await write('warm-unknown-owner', [
        user(text(wrapWarm(WARM_PROMPT))),
        assistant(text('OK')),
        assistant(text('unsolicited work'))
      ]);
      const rows = await turnsIn(file);
      assert.equal(
        rows[2]?.maintenance,
        false,
        'an anonymous assistant row does not extend maintenance'
      );
    });

    it('stays a ping when the CLI flags it as meta', async () => {
      const file = await write('warm-meta', [
        { ...user(text(wrapWarm(WARM_PROMPT))), isMeta: true }
      ]);
      assert.deepEqual(
        (await turnsIn(file)).map((x) => x.role),
        ['warm']
      );
    });
  });

  it('keeps the prose a session wrote before asking a question', async () => {
    // The shape every `AskUserQuestion` on this machine has: the preamble is an
    // entry of its own, the tool call is the next one, and the CLI appends both
    // only once the ask is answered. While the question is up the dock can show
    // neither — that gap is the CLI's and is documented in
    // `docs/reference/cli_state/claude/transcript.md`. What is ours is what happens after:
    // the preamble must not be merged away into the tool-only turn beside it.
    const file = await write('ask', [
      user('which one?'),
      assistant(text('Two ways to go, and they differ in cost.')),
      assistant(tool('AskUserQuestion')),
      user([{ type: 'tool_result', content: 'picked' }])
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(
      turns.map((x) => x.text),
      ['which one?', 'Two ways to go, and they differ in cost.', '']
    );
    assert.deepEqual(calls(turns[2]), ['AskUserQuestion']);
  });

  it('carries an answered ask’s whole record onto the call that asked it', async () => {
    // The record is on the result entry rather than in the block, so it is
    // attached where `walk` pairs the two. Everything a replay draws — the
    // options, the previews, the note — is here and nowhere else on screen.
    const record = {
      questions: [
        {
          question: 'Which way?',
          header: 'Route',
          multiSelect: false,
          options: [{ label: 'Left', preview: 'a sample' }, { label: 'Right' }]
        }
      ],
      answers: { 'Which way?': 'Left' },
      annotations: { 'Which way?': { notes: 'only while it stays flat' } }
    };
    const file = await write('answered-ask', [
      user('which one?'),
      assistant([{ type: 'tool_use', name: 'AskUserQuestion', id: 'ask-1' }]),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'picked' }] },
        toolUseResult: record
      }
    ]);
    const ask = await askIn(file);
    assert.equal(ask?.questions[0]?.options[0]?.preview, 'a sample');
    assert.deepEqual(ask?.answers, { 'Which way?': 'Left' });
    assert.equal(ask?.annotations['Which way?']?.notes, 'only while it stays flat');
  });

  it('leaves every other tool’s result record alone', async () => {
    // `toolUseResult` is on every result entry, so the parse runs against a
    // `Read`'s file record and a `Bash`'s output too. The shape is what
    // decides, never the tool's name.
    const file = await write('read-result', [
      assistant([{ type: 'tool_use', name: 'Read', id: 'read-1' }]),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'a file' }] },
        toolUseResult: { type: 'text', file: { filePath: '/proj/app.ts', numLines: 12 } }
      }
    ]);
    assert.equal(await askIn(file), undefined);
  });

  it('attaches nothing when one entry carries two results', async () => {
    // One record cannot say which of two calls it belongs to. Measured at 0 of
    // 89,285 entries, and kept because the failure it prevents is silent.
    const record = {
      questions: [{ question: 'Which way?', multiSelect: false, options: [{ label: 'Left' }] }],
      answers: { 'Which way?': 'Left' }
    };
    const file = await write('two-results', [
      assistant([
        { type: 'tool_use', name: 'AskUserQuestion', id: 'ask-2' },
        { type: 'tool_use', name: 'Read', id: 'read-2' }
      ]),
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'ask-2', content: 'picked' },
            { type: 'tool_result', tool_use_id: 'read-2', content: 'a file' }
          ]
        },
        toolUseResult: record
      }
    ]);
    assert.equal(await askIn(file), undefined, 'neither call takes it');
  });

  it('caps at the most recent turns', async () => {
    const many = Array.from({ length: 420 }, (_, i) => user(`turn ${i}`));
    const turns = await turnsIn(await write('long', many));
    assert.equal(turns.length, 400);
    assert.equal(turns.at(-1)?.text, 'turn 419');
  });

  it('re-reads a transcript only once it has changed', async () => {
    const file = await write('cached', [user('first')]);
    const before = await allIn(file);
    // Same file, untouched: the poll must get the very thing it got last time,
    // having read nothing — identity is the only way to see that from here, and
    // `turnsIn` filters, which would mint a new array every call and pass this
    // whatever the cache did.
    assert.equal(await allIn(file), before);

    await fs.appendFile(file, '\n' + JSON.stringify(assistant(text('second'))));
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['first', 'second']
    );
  });

  it('finds a transcript that only appears later, rather than remembering it missing', async () => {
    const file = path.join(home, 'late.jsonl');
    assert.deepEqual(await turnsIn(file), []);
    await write('late', [user('here now')]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['here now']
    );
  });

  it('reads only the tail of a large transcript, without choking on the cut line', async () => {
    // Past the tail window, so the read starts mid-line.
    const filler = 'x'.repeat(40_000);
    const entries = [
      ...Array.from({ length: 30 }, () => assistant(text(filler))),
      user('the last thing said')
    ];
    const turns = await turnsIn(await write('big', entries));
    assert.equal(turns.at(-1)?.text, 'the last thing said');
    assert.ok(turns.every((x) => x.text.length > 0));
  });

  it('keeps a prompt whose own line is enormous, an image having been pasted into it', async () => {
    // The other shape an image takes: pasted into the CLI rather than named by
    // path, its base64 lands in the same entry as the words the user typed. The
    // line runs to half a megabyte and every byte of the prompt is in there, so
    // nothing here may judge a line by its length.
    const shot = { type: 'image', source: { data: 'x'.repeat(600_000) } };
    const file = await write('inline-image', [
      user([{ type: 'text', text: 'what is wrong with this' }, shot]),
      assistant(text('the reply'))
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['what is wrong with this', 'the reply']
    );
  });

  it('names an image pasted into the turn, without carrying its bytes', async () => {
    const shot = { type: 'image', source: { media_type: 'image/png', data: 'AAAA' } };
    const file = await write('img-inline', [
      { ...user([{ type: 'text', text: 'what is this' }, shot]), uuid: 'u-1' }
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(turns[0]?.images, [{ id: 't|u-1|1' }]);
    // The bytes are the whole reason this is a ref and not a payload.
    assert.ok(!JSON.stringify(turns[0]).includes('AAAA'));
  });

  it('names an image the prompt named by path', async () => {
    const file = await write('img-path', [user('look at this\n/tmp/shot.png')]);
    assert.deepEqual((await turnsIn(file))[0]?.images, [{ id: 'p|/tmp/shot.png' }]);
  });

  it('takes an image path turn dimensions from the note the CLI left', async () => {
    // The note is written after the prompt and read before it, with the whole
    // Read cycle in between — so the dimensions have to survive the walk back.
    const file = await write('img-dims', [
      user('look at this\n/tmp/shot.png'),
      assistant(tool('Read')),
      user([{ type: 'tool_result', content: 'x'.repeat(2000) }]),
      user('[Image: original 2460x1702, displayed at 2000x1384.]'),
      assistant(text('seen'))
    ]);
    assert.deepEqual((await turnsIn(file))[0]?.images, [
      { id: 'p|/tmp/shot.png', w: 2460, h: 1702 }
    ]);
  });

  it('keeps a turn that is an image and nothing else', async () => {
    const shot = { type: 'image', source: { media_type: 'image/png', data: 'AAAA' } };
    const file = await write('img-only', [{ ...user([shot]), uuid: 'u-2' }]);
    const turns = await turnsIn(file);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]?.images, [{ id: 't|u-2|0' }]);
  });

  it('leaves an ordinary turn with no images at all', async () => {
    const file = await write('img-none', [user('nothing to see'), assistant(text('agreed'))]);
    assert.ok((await turnsIn(file)).every((x) => x.images === undefined));
  });

  it('splits a batched entry into the turns that were sent', async () => {
    // Messages sent while a session is busy pile up on stdin, and the CLI hands
    // the whole pile to one turn as one text block each (observed 2026-07-27,
    // 2.1.220). Joining them would show three sends as one turn, and leave the
    // outbox in `ui/views.ts` with nothing to match its entries against.
    const file = await write('batched', [
      user([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
        { type: 'text', text: 'third' }
      ]),
      assistant(text('answering all three'))
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['first', 'second', 'third', 'answering all three']
    );
  });

  it('leaves a batched send its own image', async () => {
    // The pile keeps each send's blocks in order, so the picture belongs to the
    // send it was pasted into rather than to the turn they were batched as.
    const shot = { type: 'image', source: { media_type: 'image/png', data: 'AAAA' } };
    const file = await write('batched-img', [
      {
        ...user([{ type: 'text', text: 'look' }, shot, { type: 'text', text: 'and this' }]),
        uuid: 'u-3'
      }
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(
      turns.map((x) => [x.text, x.images]),
      [
        ['look', [{ id: 't|u-3|1' }]],
        ['and this', undefined]
      ]
    );
  });

  it('does not split what the model wrote', async () => {
    // An assistant turn's blocks are one answer split by the API, not sends.
    const file = await write('assistant-blocks', [
      assistant([
        { type: 'text', text: 'one thought' },
        { type: 'text', text: 'and its second half' }
      ])
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['one thought\nand its second half']
    );
  });

  it('reaches back past a stretch of tool results, which the thread never shows', async () => {
    // What actually fills a transcript: one `Read` of a large file is a single
    // line of tool result, dropped from the thread but still read past.
    const dump = (i: number) =>
      user([{ type: 'tool_result', content: `${i}:${'x'.repeat(60_000)}` }]);
    const entries = Array.from({ length: 6 }, (_, i) => [
      user(`ask ${i}`),
      assistant(tool('Read')),
      dump(i),
      assistant(text(`answer ${i}`))
    ]).flat();
    const turns = await turnsIn(await write('tooly', entries));
    // 360 KiB of transcript for six exchanges, none of it shown. All six are
    // within both limits, so nothing but the file's start stops the walk.
    assert.equal(turns.at(0)?.text, 'ask 0');
    assert.equal(turns.filter((x) => x.text.startsWith('answer')).length, 6);
  });
});

describe('what a slash command answered', () => {
  /**
   * The entry a local command writes, as the CLI writes it — a `system` entry
   * with its words in `content`, and no assistant entry anywhere beside it.
   * Observed 2026-08-05, CLI 2.1.220 (`docs/reference/cli_state/claude/transcript.md`).
   */
  const local = (said: string) => ({
    type: 'system',
    subtype: 'local_command',
    level: 'info',
    content: `<local-command-stdout>${said}</local-command-stdout>`
  });

  it('keeps a command’s answer, wrapper off, as a turn the CLI authored', async () => {
    const file = await write('cmd-model', [
      user('<command-message>model</command-message>\n<command-name>/model</command-name>'),
      local('Current model: Opus 5 (1M context) (effort: high)\nUsage: /model <name>.')
    ]);
    const turns = await turnsIn(file);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.role, 'cli');
    assert.equal(turns[0]?.local, true);
    // Every newline the command printed survives — the wrapper is what goes,
    // not the shape of what it wrapped.
    assert.equal(
      turns[0]?.text,
      'Current model: Opus 5 (1M context) (effort: high)\nUsage: /model <name>.'
    );
  });

  it('hands the markdown on untouched, so a table can still become one', async () => {
    const said = '## Context Usage\n\n| Category | Tokens |\n|---|---|\n| Messages | 1.2k |';
    const turns = await turnsIn(await write('cmd-context', [local(said)]));
    assert.equal(turns[0]?.text, said);
    // One prose block, because the engine downstream is what renders it.
    assert.deepEqual(turns[0]?.blocks, [{ text: said }]);
  });

  it('draws nothing for a command that answered with nothing', async () => {
    // `/clear` writes the entry with an empty body. An empty turn in the thread
    // says less than no turn does.
    const file = await write('cmd-clear', [local(''), local('   \n  ')]);
    assert.deepEqual(await allIn(file), []);
  });

  it('marks a built-in command the reader typed, above the answer it printed', async () => {
    // The shape verified on disk (2026-08-07, entrypoint `sdk-cli`): the caveat
    // sits *above* the command entry and the answer below it, so the skill-body
    // rule — a body at `i + 1` — never fires and the command went unmarked.
    // Without the chip nothing in the thread says the reader asked, and the
    // dock's echo has nothing to settle against.
    const file = await write('cmd-marked', [
      { ...user('<local-command-caveat>Caveat: …</local-command-caveat>'), isMeta: true },
      user(
        '<command-name>/model</command-name>\n            <command-message>model</command-message>'
      ),
      local('Current model: Opus 5')
    ]);
    assert.deepEqual(
      (await allIn(file)).map((x) => ('mark' in x ? [x.mark, x.skill, x.by] : [x.role, x.text])),
      [
        ['skill', 'model', 'you'],
        ['cli', 'Current model: Opus 5']
      ]
    );
  });

  it('marks a command that printed nothing, so `/clear` is not a silent send', async () => {
    // 3 of the 4 local_command entries sampled on this machine had an empty
    // body, every one of them `/clear`. The answer cannot carry this one — there
    // is no answer — and the chip is the whole record that anything happened.
    const file = await write('cmd-quiet', [
      user(
        '<command-name>/clear</command-name>\n            <command-message>clear</command-message>'
      ),
      local('')
    ]);
    assert.deepEqual(
      (await allIn(file)).map((x) => ('mark' in x ? [x.mark, x.skill, x.by] : x.role)),
      [['skill', 'clear', 'you']]
    );
  });

  it('takes out the colour a command printed for a terminal that is not there', async () => {
    // Verbatim off this machine: `/model <name>` answers in bold, and `/context`
    // once drew its bar in 24-bit colour. Nothing downstream strips these — the
    // markdown engine passes control characters and the sanitizer keeps text —
    // so left in, the reader sees `Kept model as [1mOpus 5[22m`.
    const file = await write('cmd-ansi', [
      local('Kept model as \x1b[1mOpus 5 (1M context) (default)\x1b[22m'),
      local('\x1b[1mContext Usage\x1b[22m\n\x1b[38;2;136;136;136m⛀ \x1b[39m done')
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['Kept model as Opus 5 (1M context) (default)', 'Context Usage\n⛀  done']
    );
  });

  it('drops a body that was nothing but colour', async () => {
    assert.deepEqual(await allIn(await write('cmd-only-ansi', [local('\x1b[1m\x1b[22m')])), []);
  });

  it('drops the command echo that rides in the same subtype', async () => {
    // 25 of the 379 `local_command` entries on this machine carry the command
    // itself rather than its answer, unwrapped. Dropping them is what keeps the
    // thread from saying everything twice — and it falls out of the wrapper
    // being required, rather than needing a rule of its own.
    const file = await write('cmd-echo', [
      {
        type: 'system',
        subtype: 'local_command',
        content:
          '<command-name>/model</command-name>\n            <command-message>model</command-message>'
      },
      {
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Current model: Haiku 4.5</local-command-stdout>'
      }
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => x.text),
      ['Current model: Haiku 4.5']
    );
  });

  it('leaves every other kind of system entry alone', async () => {
    const file = await write('sys-other', [
      { type: 'system', subtype: 'hook_response', content: 'hook said something' },
      { type: 'system', content: 'no subtype at all' },
      assistant(text('done'))
    ]);
    assert.deepEqual(
      (await allIn(file)).map((x) => ('mark' in x ? x.mark : x.text)),
      ['done']
    );
  });

  it('does not flatten the CLI’s alarm into a readout', async () => {
    // The regression this pairs with: a `<synthetic>` assistant entry is still
    // `cli` and still *not* `local`, or an API error would be drawn as
    // something the reader asked for.
    const file = await write('alarm-vs-readout', [
      {
        ...assistant(text('API Error: Connection closed')),
        message: { model: '<synthetic>', content: text('API Error: Connection closed') }
      },
      local('Current model: Haiku 4.5')
    ]);
    assert.deepEqual(
      (await turnsIn(file)).map((x) => [x.role, x.local]),
      [
        ['cli', undefined],
        ['cli', true]
      ]
    );
  });
});

describe('readRecent truncation', () => {
  it('says nothing was cut when the whole transcript fits', async () => {
    const file = await write('whole', [user('hello'), assistant(text('hi'))]);
    assert.equal((await transcript.readRecent(file)).truncated, false);
  });

  it('reports a cut when the turn cap stops the walk short', async () => {
    // Past `MAX_TURNS`, and small enough that the tail holds every one of them —
    // so the only limit that can have stopped this walk is the cap.
    const many = Array.from({ length: 420 }, (_, i) => user(`turn ${i}`));
    const parsed = await transcript.readRecent(await write('capped', many));
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.exchanges.length, 400);
  });

  it('keeps every send in a batch that crosses the turn cap', async () => {
    const newer = Array.from({ length: 399 }, (_, i) => user(`newer ${i}`));
    for (const older of [[], [user('older than the batch')]]) {
      const file = await write(`batch-cap-${older.length}`, [
        ...older,
        user([...text('batch first'), ...text('batch second'), ...text('batch third')]),
        ...newer
      ]);
      const recent = await transcript.readRecent(file);
      assert.equal(recent.exchanges.length, 402);
      assert.deepEqual(
        recent.exchanges.slice(0, 3).map((x) => ('text' in x ? x.text : x.mark)),
        ['batch first', 'batch second', 'batch third']
      );
      assert.equal(recent.truncated, older.length > 0);
    }
  });

  it('holds a session longer than the old cap of a hundred whole', async () => {
    // The raise this cap was measured for: a session of this length was cut at
    // 100 and is not at 400, which is the only thing a reader notices.
    const many = Array.from({ length: 194 }, (_, i) => user(`turn ${i}`));
    const parsed = await transcript.readRecent(await write('mid', many));
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.exchanges.length, 194);
  });

  it('reaches back past a pasted image to the start of a short session', async () => {
    // The shape a screenshot makes: one `Read` whose result is base64 on a
    // single line, here sized past `TAIL_BYTES` so the first window cannot hold
    // it. Nothing behind it is out of reach — the session is five turns long,
    // and the dock must not claim otherwise.
    const entries = [
      user('look at this\n/tmp/shot.png'),
      assistant(tool('Read')),
      user([{ type: 'tool_result', content: 'x'.repeat(2_200_000) }]),
      user('[Image: original 2460x1702, displayed at 2000x1384.]'),
      assistant(text('seen it'))
    ];
    const parsed = await transcript.readRecent(await write('pasted', entries));
    assert.deepEqual(
      parsed.exchanges.map((x) => ('mark' in x ? x.mark : x.text)),
      ['look at this\n/tmp/shot.png', '', 'seen it']
    );
    assert.equal(parsed.truncated, false);
  });

  it('reports a cut once the widening read gives up', async () => {
    // Past the ceiling the escalation stops at, so the start stays unreachable.
    const dump = () => user([{ type: 'tool_result', content: 'x'.repeat(900_000) }]);
    const entries = [
      user('the first thing ever said'),
      ...Array.from({ length: 11 }, dump),
      user('the last thing said')
    ];
    const parsed = await transcript.readRecent(await write('deep', entries));
    assert.equal(parsed.truncated, true);
    assert.ok(
      !parsed.exchanges.some((x) => !('mark' in x) && x.text === 'the first thing ever said')
    );
  });

  it('says nothing was cut for a transcript that is not there', async () => {
    assert.equal((await transcript.readRecent(path.join(home, 'gone.jsonl'))).truncated, false);
  });
});

describe('a read the file refused', () => {
  it('is not remembered as an empty conversation', { skip: modeBitsSkip }, async (t) => {
    // Root opens anything, so there is no refusal to provoke.
    if (process.getuid?.() === 0) {
      t.skip('env: running as root');
      return;
    }
    const file = await write('refused', [user('hello'), assistant(text('hi'))]);
    // Refused before it was ever read, which is the only way this bites: a
    // transcript already in the cache is answered from there without the file
    // being opened at all. The first read a panel makes is the exposed one.
    await fs.chmod(file, 0o000);
    assert.equal((await turnsIn(file)).length, 0);
    await fs.chmod(file, 0o644);
    // The file never changed, so its stamp is the one the failed read would have
    // been remembered under — and the turns have to come back regardless.
    assert.equal((await turnsIn(file)).length, 2);
  });

  it('holds the turns it last read when the file stops answering', async () => {
    // The dock's own bug, in the smallest shape that produces it: a transcript
    // read once and then unreachable. A lost read says nothing about the
    // conversation, so the last reading stands — where returning nothing put
    // "No conversation found" over a session whose turns were on screen a frame
    // earlier, and took the whole thread down with it.
    const file = await write('held', [user('hello'), assistant(text('hi'))]);
    assert.equal((await turnsIn(file)).length, 2);
    await fs.rm(file);
    assert.equal((await turnsIn(file)).length, 2);
  });

  it('lets go of them once the file has stopped answering for good', async () => {
    // The other end of the hold, and the reason it has one. A lost read is
    // transient and the poll after it gets the file; a *deleted* transcript
    // fails every stat from here on, and holding its reading forever left the
    // dock drawing a conversation that no longer exists for the life of the
    // panel. A missing file has to shrink the card, which is what the root
    // standard says and what a frozen card is not.
    const file = await write('deleted-for-good', [user('hello'), assistant(text('hi'))]);
    assert.equal((await turnsIn(file)).length, 2);
    await fs.rm(file);
    // Two misses still hold — this is the window a transient failure lives in.
    assert.equal((await turnsIn(file)).length, 2);
    assert.equal((await turnsIn(file)).length, 2);
    // The third is different evidence, and the conversation goes.
    assert.equal((await turnsIn(file)).length, 0);
    // Still gone, rather than the count wrapping into another hold.
    assert.equal((await turnsIn(file)).length, 0);
  });

  it('starts the count over for a file that answers in between', async () => {
    // The misses have to be consecutive, or a session read across a long
    // enough life would accumulate unrelated failures into an eviction.
    const file = await write('intermittent', [user('hello'), assistant(text('hi'))]);
    assert.equal((await turnsIn(file)).length, 2);
    await fs.rm(file);
    assert.equal((await turnsIn(file)).length, 2);
    assert.equal((await turnsIn(file)).length, 2);
    await write('intermittent', [user('hello'), assistant(text('hi'))]);
    assert.equal((await turnsIn(file)).length, 2);
    await fs.rm(file);
    // Back to one miss, not three, so the reading is held again.
    assert.equal((await turnsIn(file)).length, 2);
  });

  it('lets go of them the moment the file answers again', async () => {
    // The other half, and what keeps the hold from being a stale cache: a
    // reading is held only while nothing better can be got, and a file that
    // stats again is read again.
    const file = await write('regained', [user('hello'), assistant(text('hi'))]);
    assert.equal((await turnsIn(file)).length, 2);
    await fs.rm(file);
    assert.equal((await turnsIn(file)).length, 2);
    await write('regained', [user('hello'), assistant(text('hi')), user('and again')]);
    assert.equal((await turnsIn(file)).length, 3);
  });

  it(
    'holds them through a refusal that lands after the file moved',
    { skip: modeBitsSkip },
    async (t) => {
      if (process.getuid?.() === 0) {
        t.skip('env: running as root');
        return;
      }
      // The *read* branch, which removing the file cannot reach: an absent file
      // fails the stat, so a fix that held only there passes every case above.
      // Appending moves the stamp, so the entry cannot be answered from and the
      // walk has to run — and it is the walk that is refused here.
      const file = await write('moved-then-refused', [user('hello'), assistant(text('hi'))]);
      assert.equal((await turnsIn(file)).length, 2);
      await fs.appendFile(file, `\n${JSON.stringify(user('and again'))}`);
      await fs.chmod(file, 0o000);
      assert.equal((await turnsIn(file)).length, 2);
      await fs.chmod(file, 0o644);
      assert.equal((await turnsIn(file)).length, 3);
    }
  );

  it('empties the thread for a transcript that really did go empty', async () => {
    // The hold is not "keep whichever answer was fuller". A zero-byte file is a
    // read that succeeded and found nothing — `tail` reports it whole and `ok`
    // — so it replaces what was held. Without this the fix would paper over a
    // history that had genuinely gone.
    const file = await write('emptied', [user('hello'), assistant(text('hi'))]);
    assert.equal((await turnsIn(file)).length, 2);
    await fs.writeFile(file, '');
    assert.equal((await turnsIn(file)).length, 0);
  });
});

describe('readLastPromptAt', () => {
  const at = '2026-07-29T10:00:00.000Z';
  const stamped = (entry: object, when = at) => ({ ...entry, timestamp: when });

  it('reports when somebody last sent something', async () => {
    const file = await write('lp-plain', [stamped(user(text('do the thing')))]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
  });

  it('takes the newest prompt, not the first', async () => {
    const older = '2026-07-29T09:00:00.000Z';
    const file = await write('lp-newest', [
      stamped(user(text('first')), older),
      stamped(user(text('second')))
    ]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
  });

  it('ignores a tool result, which the CLI also files as a user entry', async () => {
    const newer = '2026-07-29T11:00:00.000Z';
    const file = await write('lp-tool-result', [
      stamped(user(text('the prompt'))),
      stamped(user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), newer)
    ]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
  });

  it('ignores a subagent’s turn', async () => {
    const newer = '2026-07-29T11:00:00.000Z';
    const file = await write('lp-sidechain', [
      stamped(user(text('the prompt'))),
      { ...stamped(user(text('sub')), newer), isSidechain: true }
    ]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
  });

  it('ignores an injected body, which nobody typed', async () => {
    const newer = '2026-07-29T11:00:00.000Z';
    const file = await write('lp-injected', [
      stamped(user(text('the prompt'))),
      stamped(user(text('<system-reminder>watch out</system-reminder>')), newer)
    ]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
  });

  it('ignores a skill body, which is a load and not an ask', async () => {
    const newer = '2026-07-29T11:00:00.000Z';
    const file = await write('lp-skill', [
      stamped(user(text('the prompt'))),
      {
        ...stamped(user(text('Base directory for this skill: /skills/lavish')), newer),
        isMeta: true
      }
    ]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
  });

  it('does not count a delivery of peers and a wait as anybody’s prompt', async () => {
    const newer = '2026-07-29T11:00:00.000Z';
    const file = await write('lp-peers', [
      stamped(user(text('the prompt'))),
      stamped(
        user([
          { type: 'text', text: wrapMessage('from a peer', 'sess-a') + '\n\n' },
          { type: 'text', text: wrapWait('All 1 finished.') }
        ]),
        newer
      ),
      stamped(
        user([
          { type: 'text', text: wrapMessage('a picture for you', 'sess-b') },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
        ]),
        newer
      )
    ]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(at));
  });

  it('counts a delivery the person had a message in', async () => {
    const newer = '2026-07-29T11:00:00.000Z';
    const file = await write('lp-mixed', [
      stamped(user(text('the prompt'))),
      stamped(
        user([
          { type: 'text', text: wrapMessage('from a peer', 'sess-a') + '\n\n' },
          { type: 'text', text: 'and mine' }
        ]),
        newer
      )
    ]);
    assert.equal(await transcript.readLastPromptAt(file), Date.parse(newer));
  });

  it('yields nothing for a transcript holding no prompt', async () => {
    const file = await write('lp-none', [stamped(assistant(text('unprompted')))]);
    assert.equal(await transcript.readLastPromptAt(file), undefined);
  });

  it('yields nothing for a prompt the CLI wrote no timestamp on', async () => {
    const file = await write('lp-undated', [user(text('undated'))]);
    assert.equal(await transcript.readLastPromptAt(file), undefined);
  });

  it('yields nothing for a file that is not there', async () => {
    assert.equal(await transcript.readLastPromptAt(path.join(home, 'nope.jsonl')), undefined);
  });
});
