import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BURST_MAX, BURST_WINDOW_MS, FLEET_MAX } from '../../core/coordination/guards';
import {
  checkFleet,
  checkPrompt,
  checkSpawnIdentity,
  checkVerbSpawn,
  promptLabel,
  resolveSpawnIdentity,
  sessionName
} from '../../core/coordination/spawn';
import type { Model } from '../../core/model_names';
import { parseContext } from '../../cli/spawn';
import { ORCHESTRATION_OFF } from '../../core/verbs';
import { catalogFor } from '../../core/catalog';

describe('checkPrompt', () => {
  it('accepts an ordinary hand-off', () => {
    assert.equal(checkPrompt('take ENG-412 and open a PR').ok, true);
  });

  it('accepts a multi-line ticket body', () => {
    assert.equal(checkPrompt('Title\n\nA description\twith a tab.').ok, true);
  });

  it('refuses an empty prompt', () => {
    assert.equal(checkPrompt('').ok, false);
    assert.equal(checkPrompt('   \n ').ok, false);
  });

  it('refuses a prompt past the length cap, and says how long it was', () => {
    const refusal = checkPrompt('x'.repeat(5000));
    assert.equal(refusal.ok, false);
    assert.match(refusal.ok === false ? refusal.reason : '', /5000/);
  });

  it('refuses a prompt carrying the attribution wrapper, open or close', () => {
    assert.equal(
      checkPrompt('pass on: <squadron-message from="x">\nhi\n</squadron-message>').ok,
      false
    );
    assert.equal(checkPrompt('ends with </squadron-message>').ok, false);
  });

  it('refuses the control characters a terminal would act on', () => {
    // Escape starts a sequence, ETX is the CLI's interrupt, CR submits.
    assert.equal(checkPrompt('answer\x1b[B2').ok, false);
    assert.equal(checkPrompt('stop\x03').ok, false);
    assert.equal(checkPrompt('one\rtwo').ok, false);
    assert.equal(checkPrompt('nul\x00').ok, false);
  });
});

describe('sessionName', () => {
  it('has nothing to say about a promptless spawn', () => {
    // The panel's own button. The CLI derives `<dir>-<suffix>` and the card
    // folds that to `agent-3f`, which is the behaviour this must not disturb.
    assert.equal(sessionName(), undefined);
    assert.equal(sessionName(''), undefined);
    assert.equal(sessionName('   \n  '), undefined);
  });

  it('folds a newline rather than stopping at one', () => {
    // Somebody who typed two lines meant both, and the fold is what keeps one
    // frame one command — `promptLabel` below is the opposite case.
    assert.equal(sessionName('checkout\nmilestones'), 'checkout milestones');
  });

  it('flattens what a card cannot draw', () => {
    // A prompt is a ticket body someone else wrote; a label is a slice of it.
    assert.equal(sessionName('take\tENG-412  now'), 'take ENG-412 now');
    assert.equal(sessionName('\x1b[31mred'), '[31mred');
  });

  it('cuts a long name, and says that it cut', () => {
    const name = sessionName('Rewrite the discovery pass so a missing session file shrinks a card');
    assert.ok(name !== undefined);
    assert.ok(name.length <= 40, `${name.length} characters`);
    assert.equal(name, 'Rewrite the discovery pass so a missing…');
  });

  it('cuts a name with no word breaks in it at all', () => {
    assert.equal(sessionName('a'.repeat(60)), `${'a'.repeat(39)}…`);
  });

  it('leaves a name that already fits alone, mark and all', () => {
    assert.equal(sessionName('a'.repeat(40)), 'a'.repeat(40));
  });
});

describe('promptLabel', () => {
  it('takes the line the prompt states its task on, not the rest', () => {
    assert.equal(
      promptLabel('Fix the login redirect.\n\nThe files are in src/auth.'),
      'Fix the login redirect.'
    );
  });

  it('has nothing to say about a promptless spawn', () => {
    assert.equal(promptLabel(), undefined);
    assert.equal(promptLabel('   \n  '), undefined);
  });

  it('shapes that line exactly as a typed name is shaped', () => {
    assert.equal(promptLabel('take\tENG-412  now\nand hurry'), 'take ENG-412 now');
  });
});

describe('checkFleet', () => {
  const NOW = 10_000_000;
  /** `n` spawns, all just now, all still running. */
  const fresh = (n: number) =>
    Array.from({ length: n }, () => ({ spawnedAt: NOW - 1000, alive: true }));

  it('allows a spawn when nothing has spawned', () => {
    assert.deepEqual(checkFleet([], NOW), { ok: true });
  });

  it('allows the burst up to the limit and refuses the one past it', () => {
    assert.equal(checkFleet(fresh(BURST_MAX - 1), NOW).ok, true);

    const verdict = checkFleet(fresh(BURST_MAX), NOW);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /last minute/);
  });

  it('counts a burst by starts, not by survivors', () => {
    // Five started and killed inside the minute cost the same five CLI launches.
    const dead = Array.from({ length: BURST_MAX }, () => ({
      spawnedAt: NOW - 1000,
      alive: false
    }));
    assert.equal(checkFleet(dead, NOW).ok, false);
  });

  it('forgets a burst once its window has passed', () => {
    const old = Array.from({ length: BURST_MAX }, () => ({
      spawnedAt: NOW - BURST_WINDOW_MS - 1,
      alive: false
    }));
    assert.deepEqual(checkFleet(old, NOW), { ok: true });
  });

  it('refuses a standing fleet that never bursted', () => {
    // A peer a minute, all day: no burst ever, and the machine still fills up.
    const drip = Array.from({ length: FLEET_MAX }, (_, i) => ({
      spawnedAt: NOW - (i + 2) * BURST_WINDOW_MS,
      alive: true
    }));
    const verdict = checkFleet(drip, NOW);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /still running/);
  });

  it('counts only the living toward the fleet', () => {
    const gone = Array.from({ length: FLEET_MAX * 2 }, (_, i) => ({
      spawnedAt: NOW - (i + 2) * BURST_WINDOW_MS,
      alive: false
    }));
    assert.deepEqual(checkFleet(gone, NOW), { ok: true });
  });
});

describe('checkVerbSpawn — what the window decides', () => {
  const NOW = 10_000_000;
  const CWD = '/repo';
  /** A standing fleet at the cap, no burst: later checks fail, so a earlier
   *  refusal is only proven if its reason wins. */
  const full = Array.from({ length: FLEET_MAX }, (_, i) => ({
    spawnedAt: NOW - (i + 2) * BURST_WINDOW_MS,
    alive: true
  }));

  const ask = (over: Partial<Parameters<typeof checkVerbSpawn>[0]> = {}) =>
    checkVerbSpawn({
      enabled: true,
      prompt: 'take the review',
      cwdIsDirectory: true,
      cwd: CWD,
      spawns: [],
      now: NOW,
      ...over
    });

  // The composition this suite exists for. Each later check is failing too,
  // so the reason names the first one that actually runs — the class that
  // bit send, when both halves were tested and their order was not.
  for (const { name, over, reason } of [
    {
      name: 'the flag, before anything else',
      over: { enabled: false, prompt: '', cwdIsDirectory: undefined, spawns: full },
      reason: new RegExp(`^${ORCHESTRATION_OFF.replace(/\./g, '\\.')}$`)
    },
    {
      name: 'an empty prompt, before the cwd',
      over: { prompt: '', cwdIsDirectory: undefined, spawns: full },
      reason: /empty/
    },
    {
      name: 'a missing cwd, before the fleet',
      over: { cwdIsDirectory: undefined, spawns: full },
      reason: /No such directory: \/repo/
    },
    {
      name: 'a path that is a file, before the fleet',
      over: { cwdIsDirectory: false, spawns: full },
      reason: /Not a directory: \/repo/
    },
    {
      name: 'a standing fleet, last',
      over: { spawns: full },
      reason: /still running/
    }
  ] as const) {
    it(`refuses ${name}`, () => {
      const decided = ask(over);
      assert.equal(decided.ok, false);
      assert.match(decided.ok ? '' : decided.reason, reason);
    });
  }

  it('allows a spawn that passes every check', () => {
    assert.deepEqual(ask(), { ok: true });
  });

  it('passes the prompt guard through, reason and all', () => {
    const decided = ask({ prompt: 'x'.repeat(5000) });
    assert.equal(decided.ok, false);
    assert.match(decided.ok ? '' : decided.reason, /5000/);
  });
});

describe('checkSpawnIdentity', () => {
  it('allows neither, brand alone, or both when the id names no other brand', () => {
    assert.equal(checkSpawnIdentity({}).ok, true);
    assert.equal(checkSpawnIdentity({ brand: 'grok' }).ok, true);
    assert.equal(checkSpawnIdentity({ brand: 'claude', model: 'opus' }).ok, true);
    assert.equal(checkSpawnIdentity({ brand: 'grok', model: 'grok-4.6' }).ok, true);
  });

  it('refuses a model with no brand', () => {
    const verdict = checkSpawnIdentity({ model: 'opus' });
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /--model-id needs --brand/);
  });

  it('refuses a Grok id on a Claude start, and not an unplaced id on Grok', () => {
    const mismatch = checkSpawnIdentity({ brand: 'claude', model: 'grok-4.6' });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.ok ? '' : mismatch.reason, /does not belong/);
    // brandForModel only places grok-*. Membership in the menu would refuse
    // a new Grok id the hardcoded list has not grown yet.
    assert.equal(checkSpawnIdentity({ brand: 'grok', model: 'opus' }).ok, true);
  });

  it('reads empty strings as absent', () => {
    assert.equal(checkSpawnIdentity({ brand: 'claude', model: '  ' }).ok, true);
    const verdict = checkSpawnIdentity({ brand: '', model: 'opus' } as { model: string });
    assert.equal(verdict.ok, false);
  });
});

describe('resolveSpawnIdentity', () => {
  const opus: Model = { value: 'opus[1m]', name: 'Opus', id: 'claude-opus-5[1m]', brand: 'claude' };

  it('inherits the parent brand and pick when nothing was stated', () => {
    assert.deepEqual(resolveSpawnIdentity({}, { brand: 'grok', modelPick: 'grok-4.6' }), {
      ok: true,
      brand: 'grok',
      model: 'grok-4.6'
    });
  });

  it('resolves a reading against the menu when the parent has no pick', () => {
    assert.deepEqual(
      resolveSpawnIdentity({}, { brand: 'claude', model: 'claude-opus-5[1m]' }, [opus]),
      { ok: true, brand: 'claude', model: 'opus[1m]' }
    );
  });

  it('degrades to no model when the parent reading cannot be resolved', () => {
    assert.deepEqual(resolveSpawnIdentity({}, { brand: 'claude', model: 'claude-opus-5[1m]' }), {
      ok: true,
      brand: 'claude'
    });
  });

  it('degrades to Claude and no model when there is no parent record', () => {
    assert.deepEqual(resolveSpawnIdentity({}), { ok: true, brand: 'claude' });
  });

  it('starts the stated brand with no model, and does not inherit one', () => {
    assert.deepEqual(
      resolveSpawnIdentity({ brand: 'grok' }, { brand: 'claude', modelPick: 'opus' }),
      { ok: true, brand: 'grok' }
    );
  });

  it('passes both as stated', () => {
    assert.deepEqual(resolveSpawnIdentity({ brand: 'claude', model: 'sonnet' }), {
      ok: true,
      brand: 'claude',
      model: 'sonnet'
    });
  });

  it('refuses the same cases checkSpawnIdentity does', () => {
    assert.equal(resolveSpawnIdentity({ model: 'opus' }).ok, false);
    assert.equal(resolveSpawnIdentity({ brand: 'claude', model: 'grok-4.6' }).ok, false);
  });

  it('drops an inherited pick that does not belong to the inherited brand', () => {
    assert.deepEqual(resolveSpawnIdentity({}, { brand: 'claude', modelPick: 'grok-4.6' }), {
      ok: true,
      brand: 'claude'
    });
  });

  /**
   * **Every arm, not only the stated ones.**
   *
   * No menu is passed here, so no row can speak and each is posted as stated.
   * Carrying it where a brand was stated and dropping it where one was
   * inherited is how an `--effort` passed without `--brand` would vanish with
   * no word said.
   */
  it('carries a stated effort on every arm', () => {
    assert.deepEqual(resolveSpawnIdentity({ brand: 'claude', model: 'sonnet', effort: 'high' }), {
      ok: true,
      brand: 'claude',
      model: 'sonnet',
      effort: 'high'
    });
    assert.deepEqual(resolveSpawnIdentity({ brand: 'grok', effort: 'high' }), {
      ok: true,
      brand: 'grok',
      effort: 'high'
    });
    assert.deepEqual(
      resolveSpawnIdentity({ effort: 'high' }, { brand: 'grok', modelPick: 'grok-4.6' }),
      { ok: true, brand: 'grok', model: 'grok-4.6', effort: 'high' }
    );
    assert.deepEqual(resolveSpawnIdentity({ effort: 'high' }), {
      ok: true,
      brand: 'claude',
      effort: 'high'
    });
  });

  /** Absent says "no override" once, rather than twice. `''` is absent too —
   *  the same reading `model` and `name` already take of an empty flag. */
  it('names no effort when none was stated', () => {
    assert.deepEqual(resolveSpawnIdentity({ brand: 'claude' }), { ok: true, brand: 'claude' });
    assert.deepEqual(resolveSpawnIdentity({ brand: 'claude', effort: '  ' }), {
      ok: true,
      brand: 'claude'
    });
  });
});

/**
 * The window a child is started in — the other half of what a spawn names.
 *
 * A fan-out that inherits the model but not the window puts its children in a
 * different window from the session that asked for them, which is the failure
 * this pair exists to prevent.
 */
describe('the window a spawn names', () => {
  it('carries a stated pair through as stated', () => {
    assert.deepEqual(
      resolveSpawnIdentity({ brand: 'claude', model: 'claude-opus-5', window: 200_000 }),
      { ok: true, brand: 'claude', model: 'claude-opus-5', window: 200_000 }
    );
  });

  it('refuses a window the model does not have, naming the ones it does', () => {
    const decided = checkSpawnIdentity({
      brand: 'claude',
      model: 'claude-haiku-4-5',
      window: 1_000_000
    });
    assert.equal(decided.ok, false);
    assert.match(decided.ok ? '' : decided.reason, /no 1000000-token context window/);
    assert.match(decided.ok ? '' : decided.reason, /offers 200000/);
  });

  /** The catalog has no standing to refuse an id it has simply not added: that
   *  is still a model the binary will run, and the window falls away at the
   *  host rather than blocking the spawn. */
  it('lets a window through on a model the catalog does not carry', () => {
    assert.equal(
      checkSpawnIdentity({ brand: 'claude', model: 'claude-tiny-1', window: 200_000 }).ok,
      true
    );
  });

  describe('inheriting from a parent', () => {
    const models = catalogFor('claude');

    it('takes the parent’s own window, not the catalog’s first', () => {
      // A parent pinned to 200k on Sonnet 5 — whose *first* catalog entry is
      // 1M. Answering with the row's window would fan out at the opposite of
      // what the parent was deliberately held to.
      const decided = resolveSpawnIdentity(
        {},
        { brand: 'claude', modelPick: 'claude-sonnet-5', window: 200_000 },
        models
      );
      assert.deepEqual(decided, {
        ok: true,
        brand: 'claude',
        model: 'claude-sonnet-5',
        window: 200_000,
        effort: 'high'
      });
    });

    /** The parent is a `Session` record with no pick, so the model comes from
     *  its reading and the window from what its card states. Written for the
     *  cross-window parent, whose second source in `parentIdentity` went with
     *  row 71; the resolution is the same for any parent handed on as a card. */
    it('resolves a published parent’s reading and keeps its window', () => {
      const decided = resolveSpawnIdentity(
        {},
        { brand: 'claude', model: 'claude-opus-5[1m]', window: 1_000_000 },
        models
      );
      assert.deepEqual(decided, {
        ok: true,
        brand: 'claude',
        model: 'claude-opus-5',
        window: 1_000_000,
        effort: 'medium'
      });
    });

    /** A parent that asked for nothing hands down nothing. Answering with the
     *  resolved row's window instead would pin the child at the catalog's first
     *  entry — the widest — which its parent never asked for. */
    it('names no window when the parent asked for none', () => {
      const decided = resolveSpawnIdentity(
        {},
        { brand: 'claude', model: 'claude-opus-5[1m]' },
        models
      );
      assert.deepEqual(decided, {
        ok: true,
        brand: 'claude',
        model: 'claude-opus-5',
        effort: 'medium'
      });
    });

    it('names no window when there is nothing to inherit one from', () => {
      assert.deepEqual(resolveSpawnIdentity({}, { brand: 'claude' }, models), {
        ok: true,
        brand: 'claude'
      });
    });
  });
});

/**
 * The effort a child opens at — Phase 2 of `PRD_shipped_effort_configuration.md`.
 *
 * Checked against the child's model however that model was reached, because the
 * window is the one place that knows an inherited model and a live Codex row.
 * Omitted, it is the row's native default: the value the panel's `+` sends for
 * the same model, where the CLI's own default would differ (`medium` on Claude).
 */
describe('the effort a spawn names', () => {
  const models = [...catalogFor('claude'), ...catalogFor('grok')];

  it('opens at the model’s native default when none was stated', () => {
    assert.deepEqual(
      resolveSpawnIdentity({ brand: 'claude', model: 'claude-sonnet-5-5' }, undefined, models),
      { ok: true, brand: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }
    );
  });

  it('keeps a stated effort the model offers', () => {
    for (const effort of ['xhigh', 'low']) {
      assert.deepEqual(
        resolveSpawnIdentity(
          { brand: 'claude', model: 'claude-opus-5-5', effort },
          undefined,
          models
        ),
        { ok: true, brand: 'claude', model: 'claude-opus-5-5', effort }
      );
    }
  });

  it('refuses an effort the model does not offer, naming the ones it does', () => {
    const decided = resolveSpawnIdentity(
      { brand: 'grok', model: 'grok-4.5', effort: 'xhigh' },
      undefined,
      models
    );
    assert.equal(decided.ok, false);
    assert.match(decided.ok ? '' : decided.reason, /--effort xhigh/);
    assert.match(decided.ok ? '' : decided.reason, /high, medium, low/);
  });

  /** Dropping a value the caller named would be the silent substitution the
   *  PRD refuses everywhere else. Omitting one is fine: nothing is sent. */
  it('refuses any effort on a model that has none, and sends none unasked', () => {
    const decided = resolveSpawnIdentity(
      { brand: 'claude', model: 'claude-haiku-4-5', effort: 'low' },
      undefined,
      models
    );
    assert.equal(decided.ok, false);
    assert.match(decided.ok ? '' : decided.reason, /no effort setting/);
    assert.deepEqual(
      resolveSpawnIdentity({ brand: 'claude', model: 'claude-haiku-4-5' }, undefined, models),
      { ok: true, brand: 'claude', model: 'claude-haiku-4-5' }
    );
  });

  it('checks an inherited model the same way', () => {
    const parent = { brand: 'grok' as const, modelPick: 'grok-4.5' };
    assert.deepEqual(resolveSpawnIdentity({}, parent, models), {
      ok: true,
      brand: 'grok',
      model: 'grok-4.5',
      effort: 'high'
    });
    assert.deepEqual(resolveSpawnIdentity({ effort: 'low' }, parent, models), {
      ok: true,
      brand: 'grok',
      model: 'grok-4.5',
      effort: 'low'
    });
    assert.equal(resolveSpawnIdentity({ effort: 'xhigh' }, parent, models).ok, false);
  });

  /** The stance `--model` and `--context` take: a row we have not added is
   *  still a model the binary runs, so the CLI is the one to refuse. */
  it('posts an effort as stated where no row can speak', () => {
    assert.deepEqual(
      resolveSpawnIdentity(
        { brand: 'claude', model: 'claude-tiny-1', effort: 'turbo' },
        undefined,
        models
      ),
      { ok: true, brand: 'claude', model: 'claude-tiny-1', effort: 'turbo' }
    );
    assert.deepEqual(resolveSpawnIdentity({ brand: 'claude', effort: 'low' }, undefined, models), {
      ok: true,
      brand: 'claude',
      effort: 'low'
    });
  });
});

/**
 * `--context`, as a person and as a script write it. None of these spellings is
 * the CLI's — it has no `[200k]` and no window flag — so they stop at the
 * command line and everything below sees tokens.
 */
describe('parseContext', () => {
  it('reads the spellings a caller actually types', () => {
    assert.equal(parseContext('1m'), 1_000_000);
    assert.equal(parseContext('1M'), 1_000_000);
    assert.equal(parseContext('200k'), 200_000);
    assert.equal(parseContext('200K'), 200_000);
    assert.equal(parseContext('  500k '), 500_000);
    assert.equal(parseContext('200000'), 200_000);
  });

  it('answers nothing rather than guessing', () => {
    for (const raw of [undefined, '', '   ', '0', 'big', '1g', '-200', '1.5m', '200 k']) {
      assert.equal(parseContext(raw), undefined, `${String(raw)} was read as a window`);
    }
  });
});
