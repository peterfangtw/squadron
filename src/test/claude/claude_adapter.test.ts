import * as assert from 'node:assert/strict';

import { before, describe, it } from 'node:test';

import { windowOf } from '../../core/catalog';

import { tempHome } from '../helpers';
import * as executables from '../../core/platform/executables';

type AdapterModule = typeof import('../../core/adapter');

let mod: AdapterModule;

before(async () => {
  await tempHome();
  mod = await import('../../core/adapter');
});

describe('the Claude adapter', () => {
  const claude = () => {
    const cli = mod.adapter('claude');
    assert.ok(cli);
    return cli;
  };

  it('opens the launch line with the protocol flags, then the start’s own', () => {
    const program = executables.named('/bin/claude');
    const { bin, args, env } = claude().launch({
      bin: program,
      cwd: '/tmp',
      sessionId: 'fresh-id',
      model: 'haiku',
      effort: 'high',
      name: 'a name',
      skipPermissions: true
    });
    assert.equal(bin, program);
    // Stdin is a protocol rather than a keyboard, and the ask tool is only
    // enabled by the permission flag — `core/session.ts` argues each one.
    assert.deepEqual(args.slice(0, 9), [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio'
    ]);
    assert.deepEqual(args.slice(9), [
      '--dangerously-skip-permissions',
      '--effort',
      'high',
      '--model',
      'haiku',
      '--name',
      'a name',
      '--session-id',
      'fresh-id'
    ]);
    // The IDE's own variable is deleted rather than passed on, and the one that
    // buys a turn's end from the CLI is set.
    assert.equal(env?.CLAUDE_CODE_SSE_PORT, undefined);
    assert.ok(env && 'CLAUDE_CODE_SSE_PORT' in env, 'deleted, not merely absent');
    assert.equal(env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  });

  it('never hands a start two ids: a resume displaces the fresh one', () => {
    // `Session ID <uuid> is already in use.` is what the CLI answers a start
    // carrying both, permanently — the caller passes the fresh id either way
    // and this is where the exclusion lives.
    const { args } = claude().launch({
      bin: executables.named('/bin/claude'),
      cwd: '/tmp',
      sessionId: 'fresh-id',
      resume: 'old-id'
    });
    assert.ok(args.includes('--resume'));
    assert.equal(args[args.indexOf('--resume') + 1], 'old-id');
    assert.ok(!args.includes('--session-id'));
    assert.ok(!args.includes('fresh-id'));
  });

  it('passes nothing the start did not decide', () => {
    // Empty is the account's own default for the model, no effort, and the
    // CLI's own `<dir>-<suffix>` for the name. None of the three may be named
    // by us on their behalf.
    const { args } = claude().launch({ bin: executables.named('/bin/claude'), cwd: '/tmp' });
    assert.deepEqual(args.slice(9), []);
  });

  /**
   * The window on the launch line, one case per `reach`.
   *
   * This is the only function in `src/` that may compose `[1m]` or name
   * `CLAUDE_CODE_DISABLE_1M_CONTEXT`, so these are the assertions that keep the
   * brand seam where `catalog.ts`'s header says it is. The readings behind each
   * case are in `docs/reference/cli_state/claude/protocol.md`, probed on
   * 2.1.241.
   */
  describe('the window a start asked for', () => {
    const line = (model: string, window?: number): string[] =>
      claude()
        .launch({ bin: executables.named('/bin/claude'), cwd: '/tmp', model, window })
        .args.slice(9);

    const SETTINGS = JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } });

    /**
     * One case per reach, and per way of having none. The readings behind each
     * are in `docs/reference/cli_state/claude/protocol.md`, probed on 2.1.241.
     */
    for (const [why, model, window, want] of [
      // Opus 5 is 1M by suffix, composed here and stored nowhere: the catalog
      // carries the raw id for both of its windows.
      ['suffix widens the id', 'claude-opus-5', 1_000_000, ['claude-opus-5[1m]']],
      // The same model at 200k. `[1m]` must not appear — the flag outranks it
      // anyway, but a line carrying both says two different things.
      ['flag narrows, id left raw', 'claude-opus-5', 200_000, ['claude-opus-5', '--settings']],
      // Sonnet 5 reaches 1M plain; there is no `[1m]` for it to take.
      ['plain needs nothing said', 'claude-sonnet-5', 1_000_000, ['claude-sonnet-5']],
      // And the flag is its only route down, which is why that pair is probed.
      ['flag is the only way down', 'claude-sonnet-5', 200_000, ['claude-sonnet-5', '--settings']],
      // Haiku's one window needs no flag to sit in it.
      ['a single window is plain', 'claude-haiku-4-5', 200_000, ['claude-haiku-4-5']],
      // What every start did before this existed, and what a stored setting
      // from before it still gets.
      ['no window named', 'claude-opus-5', undefined, ['claude-opus-5']],
      // A typed id, and a real model at a window it does not have. Neither is an
      // error: the start goes out plain and the account decides, the same
      // degradation an unknown model already got.
      ['an uncatalogued id', 'claude-tiny-1', 200_000, ['claude-tiny-1']],
      ['a window the model lacks', 'claude-haiku-4-5', 1_000_000, ['claude-haiku-4-5']]
    ] as const) {
      it(`${why}`, () => {
        const want2 = want[1] === '--settings' ? ['--settings', SETTINGS] : [];
        assert.deepEqual(line(model, window), ['--model', want[0], ...want2]);
      });
    }

    /**
     * The invariant `host/sessions.ts` records `plain` on: **a pair the catalog
     * does not state never puts the flag on the line.** The three cases above
     * assert it one pair at a time; this asserts it as the rule, because a
     * start naming no window is the commonest start there is — every one that
     * is not a draft whose picked model has a window — and what its
     * `launchReach` says decides whether the dock's menu blocks anything on it.
     */
    it('says nothing about a window when the catalog states no such pair', () => {
      for (const [model, window] of [
        ['claude-opus-5', undefined],
        ['claude-tiny-1', 200_000],
        ['claude-haiku-4-5', 1_000_000],
        ['', 200_000]
      ] as const) {
        assert.equal(windowOf('claude', model || undefined, window), undefined, `${model}`);
        assert.deepEqual(line(model, window).slice(2), [], `${model} spelled a window`);
      }
    });

    it('keeps the flag off the inherited environment', () => {
      // It rides `--settings` precisely so it is not inherited: a session that
      // spawns its own `claude` would otherwise pin every descendant.
      const { env } = claude().launch({
        bin: executables.named('/bin/claude'),
        cwd: '/tmp',
        model: 'claude-opus-5',
        window: 200_000
      });
      assert.ok(!(env && 'CLAUDE_CODE_DISABLE_1M_CONTEXT' in env));
    });
  });
});

describe('Claude startup briefing', () => {
  it('appends instructions on starts and resumes without changing the other arguments', () => {
    const cli = mod.adapter('claude');
    assert.ok(cli);
    for (const resume of [undefined, 'existing-session']) {
      const options = { bin: executables.named('/bin/claude'), cwd: '/tmp', resume };
      const plain = cli.launch(options);
      const briefed = cli.launch({ ...options, briefing: 'startup instructions' });
      assert.deepEqual(briefed.args, [
        ...plain.args,
        '--append-system-prompt',
        'startup instructions'
      ]);
      assert.deepEqual(briefed.env, plain.env);
    }
  });
});
