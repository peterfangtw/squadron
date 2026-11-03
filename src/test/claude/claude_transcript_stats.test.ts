import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { before, describe, it } from 'node:test';

import { modeBitsSkip } from '../helpers';

import { home, setup, text, transcript, user, write } from './claude_transcript_helpers';

before(setup);

describe('readStats', () => {
  /** An answer as the CLI writes one down: the server's usage block, verbatim. */
  const answered = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
    type: 'assistant',
    effort: 'high',
    message: {
      model: 'claude-opus-5',
      content: text('done'),
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1352,
        cache_read_input_tokens: 108635,
        output_tokens: 3,
        ...usage
      }
    },
    ...over
  });

  it('yields nothing for a transcript that is not there', async () => {
    assert.equal(await transcript.readStats(path.join(home, 'nope.jsonl')), undefined);
  });

  it('yields nothing for a session that has not been answered yet', async () => {
    const file = await write('st-unanswered', [user(text('hello?'))]);
    assert.equal(await transcript.readStats(file), undefined);
  });

  it('reports the newest answer, output excluded as the dump excludes it', async () => {
    const file = await write('st-newest', [
      answered({}, { cache_read_input_tokens: 10 }),
      user(text('and again')),
      answered()
    ]);
    // The sum the dump calls total_input_tokens: the three input figures, and
    // not output_tokens, which the CLI counts against the window separately.
    assert.deepEqual(await transcript.readStats(file), {
      model: 'Opus 5',
      modelId: 'claude-opus-5',
      effort: 'high',
      tokens: 109989
    });
  });

  it('skips a subagent, whose context is its own and not the session’s', async () => {
    const file = await write('st-sidechain', [
      answered(),
      answered({ isSidechain: true }, { cache_read_input_tokens: 5 })
    ]);
    assert.equal((await transcript.readStats(file))?.tokens, 109989);
  });

  it('reports where the session stands, off its newest entry', async () => {
    const file = await write('st-cwd', [
      answered({ cwd: '/proj' }),
      user(text('into the worktree')),
      answered({ cwd: '/proj/.claude/worktrees/side' })
    ]);
    assert.equal((await transcript.readStats(file))?.cwd, '/proj/.claude/worktrees/side');
  });

  it('takes no directory from a subagent, which may be somewhere of its own', async () => {
    const file = await write('st-cwd-sidechain', [
      answered({ cwd: '/proj' }),
      answered({ isSidechain: true, cwd: '/proj/.claude/worktrees/agent' })
    ]);
    assert.equal((await transcript.readStats(file))?.cwd, '/proj');
  });

  it('spells a dated model id the way the dump would have', async () => {
    const file = await write('st-dated', [
      answered({ message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 7 } } })
    ]);
    assert.equal((await transcript.readStats(file))?.model, 'Haiku 4.5');
  });

  it('carries the raw id, which is what a window size is remembered by', async () => {
    const file = await write('st-1m', [
      answered({ message: { model: 'claude-opus-4-8[1m]', usage: { input_tokens: 7 } } })
    ]);
    const stats = await transcript.readStats(file);
    // The suffix goes the way the dump's own `(1M context)` does — the window
    // is shown beside the percentage — but the lookup key keeps it.
    assert.equal(stats?.model, 'Opus 4.8');
    assert.equal(stats?.modelId, 'claude-opus-4-8[1m]');
  });

  it('shows an unfamiliar model id as it is rather than guessing at it', async () => {
    const file = await write('st-odd-model', [
      answered({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 7 } } })
    ]);
    assert.equal((await transcript.readStats(file))?.model, 'claude-3-5-sonnet');
  });

  it('reads past a turn that recorded no usage at all', async () => {
    const file = await write('st-no-usage', [answered(), { type: 'assistant', message: {} }]);
    // An answer the CLI wrote down without a usage block states nothing about
    // the context; the answer before it still does.
    assert.equal((await transcript.readStats(file))?.tokens, 109989);
  });

  /** The CLI's own title entry, which it rewrites as the conversation turns. */
  const titled = (aiTitle: unknown) => ({ type: 'ai-title', aiTitle });

  it('reports the newest title, which the CLI rewrites in place', async () => {
    const file = await write('st-title', [
      titled('Investigate unnamed sessions'),
      answered(),
      titled('Name a session from its transcript')
    ]);
    assert.equal((await transcript.readStats(file))?.title, 'Name a session from its transcript');
  });

  it('finds a title written before the newest answer', async () => {
    // Where the dump would have had to wait for the next status bar: the title
    // was settled a turn ago and nothing has retitled since.
    const file = await write('st-title-early', [titled('Settled a turn ago'), answered()]);
    assert.deepEqual(await transcript.readStats(file), {
      model: 'Opus 5',
      modelId: 'claude-opus-5',
      effort: 'high',
      tokens: 109989,
      title: 'Settled a turn ago',
      titleSource: 'ai-title'
    });
  });

  it('reports a title for a session that has no answer in the tail', async () => {
    const file = await write('st-title-only', [user(text('hello?')), titled('Only a title')]);
    assert.deepEqual(await transcript.readStats(file), {
      title: 'Only a title',
      titleSource: 'ai-title'
    });
  });

  it('ignores a title entry that names nothing', async () => {
    const file = await write('st-title-empty', [titled(''), titled(7), answered()]);
    assert.equal((await transcript.readStats(file))?.title, undefined);
  });

  /** A name somebody gave: what `--name` was started with, or what `/rename`
   *  last set. The CLI restamps it beside the guess as the conversation turns. */
  const given = (customTitle: unknown) => ({ type: 'custom-title', customTitle });

  // The bug this caught: `/rename` renamed the session, the CLI went on
  // restamping the pre-rename `ai-title` after every `custom-title`, and a
  // newest-wins scan handed the card the guess it had just been renamed away
  // from — one poll after the rename landed, for the rest of the session.
  it('takes the name somebody gave over the guess the CLI writes after it', async () => {
    const file = await write('st-title-given', [
      titled('Before the rename'),
      answered(),
      given('After the rename'),
      titled('Before the rename')
    ]);
    const stats = await transcript.readStats(file);
    assert.equal(stats?.title, 'After the rename');
    assert.equal(stats?.titleSource, 'custom-title');
  });

  it('keeps looking past the guess for a name stated further back', async () => {
    // Measured over this machine's transcripts: the two sit one line apart in
    // 43 of the 44 files whose guess is newest, and 21 apart in the last — so
    // the pass runs to the end of the tail rather than to a fixed lookback.
    // Every other field is answered above the guess, so a pass that treated the
    // guess as the title would stop right there and never reach the name.
    const file = await write('st-title-far', [
      given('Named a while ago'),
      ...Array.from({ length: 25 }, () => answered()),
      { type: 'user', permissionMode: 'plan', message: { content: text('carry on') } },
      answered(),
      titled('Guessed since')
    ]);
    assert.equal((await transcript.readStats(file))?.title, 'Named a while ago');
  });

  it('falls back to the guess when the name given is empty', async () => {
    const file = await write('st-title-blank', [given(''), given(7), titled('Guessed')]);
    const stats = await transcript.readStats(file);
    assert.equal(stats?.title, 'Guessed');
    assert.equal(stats?.titleSource, 'ai-title');
  });

  /** The CLI's own periodic snapshot of the permission mode, as observed on
   *  2.1.220: written every 30s-2.5min and again at exit, never per change. */
  const modeAt = (permissionMode: string) => ({ type: 'permission-mode', permissionMode });

  it('reports the newest snapshot when no turn states a mode', async () => {
    const file = await write('st-mode', [
      modeAt('default'),
      answered(),
      modeAt('bypassPermissions')
    ]);
    assert.equal((await transcript.readStats(file))?.permissionMode, 'bypassPermissions');
  });

  it('takes the mode off a human turn when that is the newest record', async () => {
    // The two sources are what keeps the reading inside the tail: a snapshot can
    // be a megabyte of tool output back, where the prompts are near the end.
    const file = await write('st-mode-turn', [
      modeAt('default'),
      { ...user(text('carry on')), permissionMode: 'plan' }
    ]);
    assert.equal((await transcript.readStats(file))?.permissionMode, 'plan');
  });

  it('takes the mode off a human turn over a newer snapshot', async () => {
    // A session resumed under --dangerously-skip-permissions: every snapshot
    // after the resume restates the mode from before it, and only the turns say
    // what the session is actually running under.
    const file = await write('st-mode-stale-snapshot', [
      modeAt('auto'),
      { ...user(text('carry on')), permissionMode: 'bypassPermissions' },
      answered(),
      modeAt('auto')
    ]);
    assert.equal((await transcript.readStats(file))?.permissionMode, 'bypassPermissions');
  });

  it('chases a human turn past the stats tail rather than believe a snapshot', async () => {
    // What a real session looks like: the prompt that stated the mode is a few
    // hundred KB of tool output back, and every snapshot since the resume is
    // still restating the mode from before it.
    const bulk = user(text('x'.repeat(200 * 1024)));
    const file = await write('st-mode-far-turn', [
      { ...user(text('carry on')), permissionMode: 'bypassPermissions' },
      bulk,
      answered(),
      modeAt('auto')
    ]);
    assert.equal((await transcript.readStats(file))?.permissionMode, 'bypassPermissions');
  });

  it('ignores a subagent turn, which states its own mode and not the session’s', async () => {
    const file = await write('st-mode-sidechain', [
      modeAt('acceptEdits'),
      { ...user(text('sub')), isSidechain: true, permissionMode: 'bypassPermissions' }
    ]);
    assert.equal((await transcript.readStats(file))?.permissionMode, 'acceptEdits');
  });

  it('reports a mode for a session with no answer in the tail', async () => {
    // A session one prompt in has no assistant entry yet, and the mode is the
    // one thing about it worth knowing early.
    const file = await write('st-mode-only', [modeAt('bypassPermissions')]);
    assert.deepEqual(await transcript.readStats(file), { permissionMode: 'bypassPermissions' });
  });

  it('yields no mode for a transcript that never states one', async () => {
    const file = await write('st-mode-absent', [answered()]);
    assert.equal((await transcript.readStats(file))?.permissionMode, undefined);
  });

  describe('the stamp it remembers a read under', () => {
    it('answers an unchanged file without opening it', { skip: modeBitsSkip }, async (t) => {
      // Root opens anything, so a locked file proves nothing there.
      if (process.getuid?.() === 0) {
        t.skip('env: running as root');
        return;
      }
      const file = await write('st-cached', [answered()]);
      assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
      // Unreadable, but its size and mtime are unmoved — so a reader that went
      // back to the file would come back with nothing, and one answering off
      // the stamp comes back with what it already had.
      await fs.chmod(file, 0o000);
      assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
      await fs.chmod(file, 0o644);
    });

    it('reads again once the session has written more', async () => {
      const file = await write('st-restamped', [answered()]);
      assert.equal((await transcript.readStats(file))?.title, undefined);
      await fs.appendFile(file, `\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Retitled' })}`);
      assert.equal((await transcript.readStats(file))?.title, 'Retitled');
    });

    it('does not remember a read the file refused', { skip: modeBitsSkip }, async (t) => {
      if (process.getuid?.() === 0) {
        t.skip('env: running as root');
        return;
      }
      const file = await write('st-refused', [answered()]);
      // Refused before the first read, so nothing is in the map to answer from.
      await fs.chmod(file, 0o000);
      assert.equal(await transcript.readStats(file), undefined);
      await fs.chmod(file, 0o644);
      // The file never moved, so the stamp is the one that failure would have
      // been remembered under — and the card's specs have to come back anyway.
      assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
    });

    it('holds the specs it last read when the file stops answering', async () => {
      // `parse()`'s rule, on the reading a card is drawn from: a lost read is
      // not evidence that a session has no model, and blanking the specs line
      // on one is the board's version of the empty thread.
      const file = await write('st-held', [answered()]);
      assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
      await fs.rm(file);
      assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
    });

    it(
      'holds them through a refusal that lands after the file moved',
      { skip: modeBitsSkip },
      async (t) => {
        if (process.getuid?.() === 0) {
          t.skip('env: running as root');
          return;
        }
        // The scan branch, which an absent file cannot reach — the same gap the
        // thread's own tests had.
        const file = await write('st-moved-refused', [answered()]);
        assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
        await fs.appendFile(file, `\n${JSON.stringify(titled('Retitled after'))}`);
        await fs.chmod(file, 0o000);
        assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
        await fs.chmod(file, 0o644);
        assert.equal((await transcript.readStats(file))?.title, 'Retitled after');
      }
    );

    it('drops them for a transcript that has stopped saying anything', async () => {
      // A scan that succeeded and found no answer is an answer: the specs go,
      // rather than the card keeping a model out of a file that no longer names
      // one. The mirror of the thread emptying on a truthful empty read.
      const file = await write('st-silenced', [answered()]);
      assert.equal((await transcript.readStats(file))?.model, 'Opus 5');
      await write('st-silenced', [user(text('only a prompt now'))]);
      assert.equal(await transcript.readStats(file), undefined);
    });
  });
});
