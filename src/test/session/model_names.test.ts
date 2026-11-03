import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogFor } from '../../core/catalog';
import { effortFor, modelEfforts } from '../../core/model_names';

describe('effortFor', () => {
  it('keeps a configured value valid on the opening row', () => {
    assert.equal(effortFor(catalogFor('grok'), 'grok-4.6', 500_000, 'medium'), 'medium');
  });

  it('uses the row default when no value is supplied', () => {
    assert.equal(effortFor(catalogFor('grok'), 'grok-4.5', 500_000, undefined), 'high');
  });

  it('uses the row default when a configured value is invalid', () => {
    assert.equal(effortFor(catalogFor('grok'), 'grok-4.5', 500_000, 'ultra'), 'high');
  });

  it('Haiku drops effort entirely', () => {
    assert.equal(effortFor(catalogFor('claude'), 'claude-haiku-4-5', 200_000, 'ultra'), undefined);
  });
});

/** `squadron.efforts` is hand-editable `settings.json`, so anything may be in it. */
describe('modelEfforts', () => {
  it('keeps string entries, trimmed, and drops the rest', () => {
    assert.deepEqual(
      modelEfforts({ opus: ' medium ', fable: '', grok: 3, codex: null, sonnet: 'low' }),
      { opus: 'medium', sonnet: 'low' }
    );
  });

  it('reads anything that is not an object as nothing saved', () => {
    for (const raw of [undefined, null, 'medium', 4, ['high']]) {
      assert.deepEqual(modelEfforts(raw), {});
    }
  });
});

import { Model } from '../../core/claude/models';
import { resolveModel } from '../../core/model_names';

/**
 * Which row a session is on, given what it says about itself.
 *
 * The CLI spells one model three ways and only one of them is a row's `value`:
 * `--model opus[1m]` starts a session whose `init` says `claude-opus-5[1m]` and
 * whose `message_start` says `claude-opus-5` (probed 2026-08-14, 2.1.220). So a
 * control that ticks a row cannot compare a reading to a `value`, and this is
 * the one place that knows the spellings.
 */
describe('resolveModel', () => {
  const MODELS: Model[] = [
    { value: 'opus[1m]', name: 'Opus (1M context)', id: 'claude-opus-5[1m]', brand: 'claude' },
    { value: 'claude-fable-5[1m]', name: 'Fable', id: 'claude-fable-5', brand: 'claude' },
    { value: 'sonnet', name: 'Sonnet', id: 'claude-sonnet-5', brand: 'claude' },
    { value: 'opus', name: 'Opus', id: 'claude-opus-5', brand: 'claude' }
  ];
  const named = (reading?: string, pick?: string): string | undefined =>
    resolveModel(MODELS, reading, pick)?.name;

  it('names the row a session started on before it has said anything', () => {
    assert.equal(named(undefined, 'opus[1m]'), 'Opus (1M context)');
  });

  it('takes a reading that is a row’s own value', () => {
    assert.equal(named('sonnet'), 'Sonnet');
  });

  it('takes a reading that is a row’s resolved id', () => {
    assert.equal(named('claude-sonnet-5'), 'Sonnet');
  });

  it('keeps the start’s row when `init` resolves the alias', () => {
    assert.equal(named('claude-opus-5[1m]', 'opus[1m]'), 'Opus (1M context)');
  });

  /**
   * A reading that names a row outright is believed over the start's alias, and
   * this is the case that decides it: `claude-opus-5` is the shorter row's id
   * *and* the 1M row's id with the suffix off. Reading it as the pick would
   * make a `/model opus` typed into the session invisible for good — so the row
   * wins, and `core/live.ts` is what makes that safe: it keeps the spelling
   * `init` gave, so a 1M session never reports the shorter one.
   */
  it('believes a reading that names a row over the start’s alias', () => {
    assert.equal(named('claude-opus-5', 'opus[1m]'), 'Opus');
    assert.equal(named('claude-opus-5'), 'Opus');
  });

  /**
   * The tie the pick is actually for: a spelling no row carries, which two rows
   * answer to once the suffix is off.
   *
   * The second assertion changed with `core/catalog.ts`. It used to expect the
   * 1M row, which was `loose[0]` — the first row written, not a fact about the
   * session. With two rows surviving `base()` and no pick to choose between
   * them, there is nothing here anybody knows, and the caller states the
   * reading verbatim instead of being handed a row at random.
   */
  it('breaks a suffix-only tie with the start’s alias, and guesses without one', () => {
    const rows: Model[] = [
      { value: 'opus[1m]', name: 'Opus (1M context)', id: 'claude-opus-5-1m', brand: 'claude' },
      { value: 'opus', name: 'Opus', id: 'claude-opus-5-1m[200k]', brand: 'claude' }
    ];
    assert.equal(resolveModel(rows, 'claude-opus-5-1m[8k]', 'opus')?.name, 'Opus');
    assert.equal(resolveModel(rows, 'claude-opus-5-1m[8k]', undefined), undefined);
  });

  /** The half of `base()` that survives the narrowing: one row answers to the
   *  stripped spelling, so an unseen suffix on it is still that row. */
  it('still takes an unseen suffix where only one row could carry it', () => {
    assert.equal(named('claude-sonnet-5[8k]'), 'Sonnet');
  });

  it('drops the pick once the session has moved somewhere else', () => {
    assert.equal(named('claude-sonnet-5', 'opus[1m]'), 'Sonnet');
  });

  it('answers nothing for a model the list does not name', () => {
    assert.equal(resolveModel(MODELS, 'claude-tiny-1', 'tiny'), undefined);
    assert.equal(resolveModel([], 'claude-opus-5', 'opus'), undefined);
    assert.equal(resolveModel(MODELS, undefined, undefined), undefined);
  });

  /** A value typed into the setting by hand is not a row, and the reading is
   *  what is left to answer with. */
  it('falls back to the reading when the pick names no row', () => {
    assert.equal(named('claude-sonnet-5', 'claude-sonnet-5'), 'Sonnet');
  });
});
