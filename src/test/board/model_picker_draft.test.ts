import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogFor } from '../../core/catalog';
import { enter, groupView, lastOpen, openPanel, stateMessage, typeIn } from '../harness';
import {
  MODELS,
  EFFORT_MODELS,
  draft,
  pill,
  value,
  pillMenu,
  drill,
  pick,
  sent
} from './model_picker_helpers';

/**
 * What the setting is *for*, now that the pill is where a start is decided: it
 * is what the pill opens on.
 *
 * The rule is `defaultPick`, and these are its three answers — a setting the
 * list names, one it does not, and none at all. Read at the pill rather than
 * asserted on the helper directly, because the thing that matters is that the
 * two surfaces agree.
 */
describe('the setting seeds a draft', () => {
  it('opens the pill on the setting, not on the list’s first row', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p, { model: 'haiku' })), 'Haiku');
    assert.deepEqual(sent(p), { brand: 'claude', model: 'haiku', window: 200_000 });
  });

  /** The stored window picks which of two entries sharing a value the draft
   *  opens on — the same rule the gear row labels itself by. */
  it('opens on the window the setting stores', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p, { model: 'opus', contextWindow: 200_000 })), 'Opus (200k)');
    assert.deepEqual(sent(p), { brand: 'claude', model: 'opus', window: 200_000 });
  });

  /**
   * **The brand comes off the row, not off a second setting.**
   * `agentsview.cli` was that second key and it stayed retired: a default
   * naming a Grok model starts Grok because the row the setting resolves to
   * says so.
   */
  it('starts the brand the setting’s row belongs to', (t) => {
    const p = openPanel(t);
    const models: ModelView[] = [
      ...MODELS,
      { value: 'grok-4.6', name: 'Grok 4.6', id: 'grok-4.6', brand: 'grok', window: 500_000 }
    ];
    assert.equal(value(draft(p, { models, model: 'grok-4.6' })), 'Grok 4.6');
    assert.deepEqual(sent(p), { brand: 'grok', model: 'grok-4.6', window: 500_000 });
  });

  /**
   * The fourth member of the pick, and the reason `startOwned` stopped reading
   * a setting at launch: `squadron.efforts` is resolved here, with the model,
   * rather than an application-wide value being paired with it later.
   */
  it('carries the effort setting to the start it makes', (t) => {
    const p = openPanel(t);
    typeIn(draft(p, { models: EFFORT_MODELS, model: 'opus', efforts: { opus: 'high' } }), 'begin');
    enter(p);
    assert.equal(lastOpen(p).target?.effort, 'high');
  });

  /** Unset states nothing, rather than an empty string the adapter would have
   *  to know to ignore. Absent is "let the CLI decide". */
  it('names no effort when the setting is unset', (t) => {
    const p = openPanel(t);
    typeIn(draft(p, { model: 'haiku' }), 'begin');
    enter(p);
    assert.equal(
      'effort' in (lastOpen(p).target ?? {}),
      false,
      'an unset setting still named an effort'
    );
  });

  /** With no row there is no native vocabulary against which the stored value
   *  can be trusted, so the start leaves the CLI to decide. */
  it('drops the effort when the host offers no model', (t) => {
    const p = openPanel(t);
    typeIn(draft(p, { models: [], efforts: { opus: 'high' } }), 'begin');
    enter(p);
    const open = lastOpen(p).target ?? {};
    assert.equal(open.model, undefined, 'an empty list named a model');
    assert.equal('effort' in open, false, 'an unverified effort reached the start');
  });

  /**
   * An id typed into the gear's footer rides verbatim, because that string is
   * exactly what the start will pass. The CLI refuses it on turn one if it is
   * wrong, in a turn that names it.
   *
   * **No brand rides with it**, and that is `brandForModel` declining to guess:
   * a name that is neither `grok*` nor `gpt-*` names no brand, and the host
   * folds an absent one to Claude — the default every unbranded start has
   * always taken. A `grok-` id typed there does carry `grok`, which is the case
   * `spawn.ts` refuses a mismatch on.
   */
  it('carries a setting the list does not name, verbatim and unbranded', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p, { model: 'mystery', efforts: { mystery: 'ultra' } })), 'mystery');
    assert.deepEqual(sent(p), { model: 'mystery' });
    assert.equal(lastOpen(p).target?.effort, undefined, 'a typed id carried an unverified effort');
  });

  /** The other half of that: an unlisted id that *does* spell a brand out
   *  carries it, so a typed Grok id starts Grok rather than a Claude child with
   *  a Grok `--model`. */
  it('brands an unlisted setting when the id names one', (t) => {
    const p = openPanel(t);
    assert.deepEqual(sent(draft(p, { model: 'grok-9' })), { brand: 'grok', model: 'grok-9' });
  });

  /** Unset falls through to the list's first row, which the catalog ranks
   *  host-side — the behaviour every draft had before the setting came back. */
  it('falls back to the list’s first row when nothing is set', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p)), 'Opus (1M)');
    assert.deepEqual(sent(p), { brand: 'claude', model: 'opus', window: 1_000_000 });
  });

  /**
   * **Seeded once.** A default changed while a draft is open does not move it:
   * the draft has its answer, and the setting says what a *new* start opens on.
   *
   * The guard is `draft.pick?.model === undefined`, and this is the case that holds
   * it — without it every repaint would re-seed, and a reader who picked Haiku
   * on the draft would watch the pill snap back to the gear's row on the next
   * three-second push.
   */
  it('does not move a draft that is already open', (t) => {
    const p = openPanel(t);
    draft(p, { model: 'haiku' });
    assert.equal(value(p), 'Haiku');
    p.push(stateMessage([groupView({ sessions: [] })], { models: MODELS, model: 'opus' }));
    assert.equal(value(p), 'Haiku', 'a changed default moved a draft already open');
    assert.deepEqual(sent(p), { brand: 'claude', model: 'haiku', window: 200_000 });
  });

  /**
   * A pick on the draft changes that one start and **writes nothing back**.
   * That is the whole difference between the two surfaces, and the reason the
   * gear can stay a machine-wide answer without deciding every New.
   */
  it('is left alone by a pick on the draft', (t) => {
    const p = openPanel(t);
    draft(p, { model: 'haiku' });
    pick(pillMenu(p), 'Opus', '1M').click();
    assert.equal(
      p.posted.some((m) => m.type === 'setModel'),
      false,
      'the draft wrote its pick back to the setting'
    );
    assert.deepEqual(sent(p), { brand: 'claude', model: 'opus', window: 1_000_000 });
  });
});

describe('the draft’s model pill', () => {
  // What the pick is *for*, said where the pick is made: the row this replaced
  // needed a sentence because the gear is three surfaces from any session, and
  // a pill in the box the message is being typed into does not.
  it('says what it decides', (t) => {
    assert.equal(pill(draft(openPanel(t)))?.dataset.tip, 'What this session will start on');
  });

  /**
   * The first row of `state.models`, which the catalog already ranks host-side.
   *
   * That order is load-bearing rather than incidental: `CatalogRow.windows`
   * runs widest first, so the first current row is the wide one, and it is the
   * same tie-break `resolveModel` takes.
   */
  it('opens on the first row of the list the host offered', (t) => {
    assert.equal(value(draft(openPanel(t))), 'Opus (1M)');
  });

  it('opens on the first row of the real catalog', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p, { models: [...catalogFor('claude')] })), 'Opus 5.5 (1M)');
  });

  /** A brand with one window per model, on a machine that has only this CLI. */
  it('opens on the first row of a Grok-only board', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p, { models: [...catalogFor('grok')] })), 'Grok 4.7');
  });

  /**
   * A machine with no brand it can run still draws the pill, reading `default`.
   *
   * `gatherModels` filters on a binary and an account, so an empty list means
   * no CLI here is both installed and signed in — and the menu is the only
   * place a reader is ever told that. Removing the control would be the tidier
   * answer and the wrong one. The start it makes names no model, which is what
   * the account's own default has always been.
   */
  it('reads default when the host offers no model, and says why', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p, { models: [] })), 'default');
    typeIn(p, 'begin');
    enter(p);
    assert.equal(lastOpen(p).target?.model, undefined, 'an empty list still named a model');
  });

  /** The pick states itself on the pill at once, rather than waiting for a push
   *  that carries nothing about it — there is no session for one to describe. */
  it('says the model just picked', (t) => {
    const p = openPanel(t);
    const fly = drill(p);
    pick(fly, 'Haiku').click();
    assert.equal(value(p), 'Haiku');
  });

  /**
   * Two rows sharing a value are one model at two windows, and this pill has
   * no card under it to state which — the same reason the gear's own row
   * composes `Opus 5 (200k)`. A value that is only one row is the name alone.
   */
  it('names the window when two rows share the pick, and not when one does', (t) => {
    const p = openPanel(t);
    assert.equal(value(draft(p)), 'Opus (1M)');
    pick(pillMenu(p), 'Opus', '200k').click();
    assert.equal(value(p), 'Opus (200k)');
    pick(pillMenu(p), 'Haiku').click();
    assert.equal(value(p), 'Haiku');
  });

  it('drops the effort when the model is changed to one that states none', (t) => {
    const p = openPanel(t);
    draft(p, {
      models: EFFORT_MODELS,
      model: 'opus',
      contextWindow: 1_000_000,
      efforts: { opus: 'high' }
    });
    pick(pillMenu(p), 'Haiku').click();
    assert.equal(value(p), 'Haiku');
    typeIn(p, 'begin');
    enter(p);
    const open = lastOpen(p).target;
    assert.equal(open?.model, 'haiku', 'the pick did not reach the start');
    assert.equal(
      open !== undefined && 'effort' in open,
      false,
      'Haiku carried the old model’s effort'
    );
  });

  it('opens a picked model on the effort saved for it', (t) => {
    const p = openPanel(t);
    draft(p, { models: EFFORT_MODELS, model: 'haiku', efforts: { opus: 'low' } });
    pick(pillMenu(p), 'Opus', '1M').click();
    typeIn(p, 'begin');
    enter(p);
    assert.equal(lastOpen(p).target?.effort, 'low');
  });
});
