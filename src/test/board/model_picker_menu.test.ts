import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogFor } from '../../core/catalog';
import type { Model } from '../../core/model_names';
import { ctxLabel } from '../../webview/dom';
import { SEARCH_ABOVE } from '../../webview/picker';
import {
  Panel,
  enter,
  groupView,
  lastOpen,
  openPanel,
  stateMessage,
  typeIn,
  composerTarget
} from '../harness';
import {
  MODELS,
  draft,
  pill,
  value,
  flyout,
  pillMenu,
  drill,
  modelRow,
  pick,
  sent,
  gearFly
} from './model_picker_helpers';

const rows = (fly: HTMLElement): string[] =>
  [...fly.querySelectorAll<HTMLElement>('.mitem')].map(
    (r) => r.querySelector('.nm')?.textContent ?? ''
  );

/** Every window that row offers, in the order it draws them. */
const pills = (fly: HTMLElement, name: string): string[] =>
  [...modelRow(fly, name).querySelectorAll<HTMLElement>('.wp')].map((w) => w.textContent ?? '');

/** Catalog rows as the host would put them on the wire: stamped with the word
 *  their brand goes by, which `offeredModels` does and no fixture should spell
 *  three times. */
const labelled = (rows: readonly Model[], brandLabel: string): ModelView[] =>
  rows.map((m) => ({ ...m, brandLabel }));

/**
 * Every node a menu draws, in DOM order: a row by its name, a rule as `—`, a
 * heading as `#Name`, a fold as `>7 older`. Recursive, because a headed brand
 * run is a `role="group"` holding its own rows, and because the list itself is
 * a band of the menu now (`.fscroll`) rather than the menu's own children — an
 * unheaded menu is flat inside that band and reads the same either way.
 *
 * **A folded-away row is still in this list.** It is drawn and hidden rather
 * than left out, and what a reader can *see* is `visible` below — keeping the
 * two apart is what lets a test say which of the two it means.
 *
 * One copy, shared by both blocks below: two walks that agreed only by accident
 * is how one of them comes to be asserting a shape the other has left.
 */
const flow = (menu: HTMLElement): string[] =>
  [...menu.children].flatMap((node) => {
    if (node.classList.contains('fsep')) return ['—'];
    if (node.classList.contains('mhead')) return ['#' + (node.textContent ?? '')];
    if (node.classList.contains('mfold')) {
      return ['>' + (node.querySelector('.nm')?.textContent ?? '')];
    }
    if (node.classList.contains('fscroll') || node.getAttribute('role') === 'group') {
      return flow(node as HTMLElement);
    }
    const name = node.querySelector('.nm')?.textContent;
    return name ? [name] : [];
  });

/** The model rows a reader can see: every row the fold is not holding shut. */
const visible = (fly: HTMLElement): string[] =>
  [...fly.querySelectorAll<HTMLElement>('.mitem.wins:not([hidden])')].map(
    (r) => r.querySelector('.nm')?.textContent ?? ''
  );

/** The fold rows, in the order they are drawn — one per brand that has older
 *  models, and none for a brand that has not. */
const folds = (fly: HTMLElement): HTMLElement[] => [
  ...fly.querySelectorAll<HTMLElement>('.mitem.mfold')
];

/** The one fold this menu draws. Asserts, because a test that reached for a
 *  fold in a menu with two of them is a test asking the wrong question. */
const fold = (fly: HTMLElement): HTMLElement => {
  const own = folds(fly);
  assert.equal(own.length, 1, `the menu draws ${own.length} folds, not one`);
  return own[0]!;
};

/** The search box, when the list is long enough to have earned one. */
const search = (fly: HTMLElement): HTMLInputElement | null =>
  fly.querySelector<HTMLInputElement>('.fsearch');

/** Type into it the way a reader does — the handler is `oninput`. */
const type = (fly: HTMLElement, text: string): void => {
  const box = search(fly);
  assert.ok(box, 'the menu offers no search box to type into');
  box.value = text;
  box.dispatchEvent(new box.ownerDocument.defaultView!.Event('input', { bubbles: true }));
};

const key = (p: Panel, k: string): void => {
  p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
};

describe('the model flyout', () => {
  it('opens from the pill, and says so while it is open', (t) => {
    const p = openPanel(t);
    assert.ok(drill(p), 'no menu');
    assert.equal(pill(p)?.getAttribute('aria-expanded'), 'true');
  });

  /**
   * One row per *model*, not per entry — the shape B change a reader sees.
   *
   * The two Opus entries share a `value` and a name, so they are one row with
   * two pills. The id column is gone with them: it existed to tell `Opus` from
   * `Opus (1M context)` apart, and the pill does that better, which is what
   * freed the column (`docs/mockups/model-menu-windows.html`).
   */
  it('draws one row per model, with a pill per window', (t) => {
    const fly = drill(openPanel(t));
    // No trailing `default`: the item is gone, and the models are the whole list.
    assert.deepEqual(rows(fly), ['Opus', 'Haiku']);
    assert.deepEqual(pills(fly, 'Opus'), ['1M', '200k']);
    assert.deepEqual(pills(fly, 'Haiku'), ['200k']);
    assert.equal(fly.querySelector('.sub'), null, 'the id column is still drawn');
  });

  /** The row is a label. A reader who presses it must get nothing, because the
   *  thing they meant is the pill beside it — and a `<button>` inside a
   *  `<button>` is not markup a browser keeps, which is why the row gave up
   *  being one. */
  it('makes a label of the row and a control of the pill', (t) => {
    const fly = drill(openPanel(t));
    const row = modelRow(fly, 'Opus');
    assert.equal(row.tagName, 'DIV');
    assert.equal(row.getAttribute('role'), 'presentation');
    assert.equal(row.getAttribute('aria-checked'), null, 'the row still claims a checked state');
    for (const wp of row.querySelectorAll('.wp')) {
      assert.equal(wp.tagName, 'BUTTON');
      assert.equal(wp.getAttribute('role'), 'menuitemradio');
    }
  });

  /**
   * WCAG 2.5.3, Label in Name. The row is `presentation`, so a pill announced
   * as `1M` alone would name a window with no model attached — and a
   * voice-control reader has to be able to say the words they can see, which
   * rules out spelling the figure out longhand.
   */
  it('names the model as well as the window, to a reader who cannot see the row', (t) => {
    const fly = drill(openPanel(t));
    const wide = pick(fly, 'Opus', '1M');
    assert.equal(wide.getAttribute('aria-label'), 'Opus (1M)');
    assert.ok(
      wide.getAttribute('aria-label')?.includes(wide.textContent ?? ''),
      'the visible text is not a substring of the accessible name'
    );
    assert.equal(pick(fly, 'Haiku').getAttribute('aria-label'), 'Haiku (200k)');
  });

  it('draws a Grok row the host listed, and posts that id', (t) => {
    const p = openPanel(t);
    const fly = drill(p, {
      models: [
        ...MODELS,
        { value: 'grok-4.6', name: 'Grok 4.6', id: 'grok-4.6', brand: 'grok', window: 500_000 }
      ]
    });
    assert.ok(rows(fly).includes('Grok 4.6'));
    pick(fly, 'Grok 4.6').click();
    assert.deepEqual(sent(p), { brand: 'grok', model: 'grok-4.6', window: 500_000 });
  });

  /**
   * The degradation, and it has to stay pressable. `ModelView.window` is
   * optional on the wire — a typed id has none, and so does any row a producer
   * we did not write hands over — so a value with no window draws the old
   * single-control row rather than a row with nothing to press.
   */
  it('draws a row with no window as the control itself', (t) => {
    const p = openPanel(t);
    const fly = drill(p, {
      models: [{ value: 'mystery', name: 'Mystery', id: 'mystery-1', brand: 'claude' }]
    });
    const row = modelRow(fly, 'Mystery');
    assert.equal(row.tagName, 'BUTTON', 'a row with no pill is not pressable');
    assert.equal(row.querySelectorAll('.wp').length, 0);
    row.click();
    assert.deepEqual(sent(p), { brand: 'claude', model: 'mystery' });
  });

  // `default` is the absence of a pick rather than a model, and the rule above
  // it is what says so without a sentence.
  /** The `default` item is gone: an item meaning "no pick" is not something a
   *  reader wants from a list of models, and the account's default is whatever
   *  the first current row already is. What stays under the rule is the way to
   *  a model the catalog has not got. */
  /**
   * No `default` row, and no footer under the list.
   *
   * `default` was an item meaning "no pick", which is not a thing a reader
   * wants from a list of models — a draft opens on the setting's row, or on the
   * first current one, and picking that by name is the same start with
   * something to show for it.
   *
   * The **typed-id footer is the gear's alone.** `idField` belongs to a setting
   * somebody types into; this menu is picked from. Reinstating it here is a
   * change of its own, and nothing has asked for it.
   */
  it('offers neither a default row nor a footer', (t) => {
    const fly = drill(openPanel(t));
    assert.equal(
      [...fly.querySelectorAll('.nm')].some((n) => n.textContent === 'default'),
      false,
      'the default row is still drawn'
    );
    assert.equal(fly.querySelector('.ffoot'), null, 'the typed-id footer is still drawn');
    assert.equal(fly.querySelector('.fsep'), null, 'the list still follows a rule');
  });

  /**
   * The tick splits in two: the row that holds the value is `.lit`, and the one
   * pill whose window matches is `.on`. Two marks because they answer two
   * questions — which model, and which of its windows — and a reader scanning
   * for the model should not have to find the pill first.
   */
  it('ticks the model that is picked, and the window with it', (t) => {
    const p = openPanel(t);
    pick(drill(p), 'Haiku').click();
    const fly = pillMenu(p);
    assert.equal(modelRow(fly, 'Haiku').classList.contains('lit'), true);
    assert.equal(pick(fly, 'Haiku').getAttribute('aria-checked'), 'true');
    assert.equal(fly.querySelectorAll('.mitem.lit').length, 1, 'more than one row is lit');
    assert.equal(fly.querySelectorAll('.wp.on').length, 1, 'more than one window is ticked');
  });

  /** The case `value` alone cannot answer: one row, two pills, and only the
   *  stored window says which. Ticking on `value` would fill both. */
  it('ticks one pill of a row offered at two windows', (t) => {
    const p = openPanel(t);
    pick(drill(p), 'Opus', '200k').click();
    const fly = pillMenu(p);
    assert.equal(modelRow(fly, 'Opus').classList.contains('lit'), true);
    assert.equal(pick(fly, 'Opus', '200k').classList.contains('on'), true);
    assert.equal(pick(fly, 'Opus', '1M').classList.contains('on'), false);
  });

  /** An unset value ticks the row it resolves to — the same row the label above
   *  already names. Ticking nothing there would leave the reader looking at a
   *  row that names a model and a list agreeing with none of it. */
  it('ticks the row an unset value resolves to', (t) => {
    const fly = drill(openPanel(t));
    assert.equal(modelRow(fly, 'Opus').classList.contains('lit'), true);
    assert.equal(pick(fly, 'Opus', '1M').classList.contains('on'), true);
    assert.equal(fly.querySelectorAll('.wp.on').length, 1);
  });

  /**
   * **A pick posts nothing at all**, and that is the whole difference between
   * this surface and the gear's. The pick is a fact about a message not yet
   * sent; it rides the `open` that first send makes, and `squadron.model`
   * goes on saying what the next New opens on.
   *
   * A lone pill carries what a pill of a two-window row carries: the pair. Its
   * row offers no choice, and that is not a reason to keep half a pick.
   */
  it('posts nothing, and carries the pick on the open', (t) => {
    const p = openPanel(t);
    pick(drill(p), 'Haiku').click();
    assert.deepEqual(p.posted, [], 'the pick reached the host before the send did');
    typeIn(p, 'begin');
    enter(p);
    const open = lastOpen(p);
    assert.equal(open.brand, 'claude');
    assert.equal(open.model, 'haiku');
    assert.equal(open.window, 200_000);
  });

  /** The two pills of one row are two different starts, and the value is the
   *  same on both — so the window is the only thing distinguishing the two. */
  it('carries the window the pressed pill stands for', (t) => {
    const p = openPanel(t);
    pick(drill(p), 'Opus', '200k').click();
    typeIn(p, 'begin');
    enter(p);
    assert.equal(lastOpen(p).window, 200_000);
  });

  it('carries the other window when the other pill is pressed', (t) => {
    const p = openPanel(t);
    pick(drill(p), 'Opus', '1M').click();
    typeIn(p, 'begin');
    enter(p);
    assert.equal(lastOpen(p).window, 1_000_000);
  });

  // The pick closes its own menu and relabels the pill under the finger.
  it('closes the menu on a pick, and the pill takes it', (t) => {
    const p = openPanel(t);
    pick(drill(p), 'Haiku').click();
    assert.equal(flyout(p), null, 'the menu stayed open');
    assert.equal(value(p), 'Haiku', 'the pill did not take the pick');
  });

  /**
   * The sentence changed with the catalog. Nothing asks a CLI any more, so an
   * empty list cannot mean "the CLI named none" — the host filters a brand out
   * only for a missing binary or a missing account, so those are what it says.
   */
  it('says what an empty list actually means', (t) => {
    const p = openPanel(t);
    const fly = drill(p, { models: [] });
    // Empty is empty now — there is no `default` row left to stand in a list
    // that has nothing in it, which is what makes the sentence below the only
    // thing the flyout says.
    assert.deepEqual(rows(fly), []);
    assert.equal(
      fly.querySelector('.fnone')?.textContent,
      'No CLI here is both installed and signed in.'
    );
  });
});

/**
 * The flyout over the rows the panel actually ships.
 *
 * Driven off the catalog rather than a fixture restating it: what is under test
 * is that the catalog reaches the reader intact, and a literal written to match
 * would pass whatever the catalog said.
 *
 * **`catalogFor('claude')`, not `CLAUDE_MODELS` — changed 2026-08-28.** Since
 * the flatten those are two different lists: `CLAUDE_MODELS` is the authoring
 * shape, ten rows each carrying its windows, and the panel is handed the
 * eighteen flattened entries by the adapters' `models` port. Feeding the
 * authoring rows here passed while seeing none of the eight entries the flatten
 * adds, which is the failure mode this whole describe exists to prevent.
 */
describe('the model flyout over the real catalog', () => {
  const OFFERED = catalogFor('claude');
  const catalog = (p: Panel, over: Partial<StateMessage> = {}): HTMLElement =>
    drill(p, { models: [...OFFERED], ...over });

  /**
   * Our own name, not the CLI's. The row this task exists for is Haiku: the
   * CLI's own answer spells it `claude-haiku-4-5-20251001`, and the catalog
   * names the model `Haiku 4.5` and starts it on the undated id.
   *
   * The id is no longer *drawn* — the pills took that column — so it is read
   * off the entry rather than out of the DOM, and what the menu is asserted to
   * show is the name.
   */
  it('draws our own spelling under our own name', (t) => {
    const fly = catalog(openPanel(t));
    assert.ok(rows(fly).includes('Haiku 4.5'));
    const haiku = OFFERED.find((m) => m.name === 'Haiku 4.5');
    assert.equal(haiku?.id, 'claude-haiku-4-5');
    assert.deepEqual(pills(fly, 'Haiku 4.5'), ['200k']);
  });

  /**
   * Both Opus 5 entries are reachable, as **one row with two pills**.
   *
   * They used to be two rows told apart by the sub-line, then by the name. Both
   * readings are gone: the flatten made the id the same on both (the `[1m]` is
   * composed at the launch seam, not stored) and shape B made the name the
   * same too. The window is the only difference there has ever really been, and
   * now it is the only one drawn.
   */
  it('draws the two Opus 5 windows as two pills on one row', (t) => {
    const p = openPanel(t);
    const fly = catalog(p);
    assert.equal(rows(fly).filter((n) => n === 'Opus 5').length, 1, 'Opus 5 draws twice');
    assert.deepEqual(pills(fly, 'Opus 5'), ['1M', '200k']);
    assert.notEqual(pick(fly, 'Opus 5', '1M'), pick(fly, 'Opus 5', '200k'));
    pick(fly, 'Opus 5', '200k').click();
    assert.deepEqual(sent(p), {
      brand: 'claude',
      model: 'claude-opus-5',
      window: 200_000
    });
  });

  /**
   * A window the account may be refused, drawn as such and still pressable.
   *
   * `claude-sonnet-4-6[1m]` runs and answers *"usage credits required for 1M
   * context"* — a billing gate on a variant that exists, so hiding it would
   * hide a model the account has. The catalog states what a model *has*; what
   * an account may reach is the account's answer, and it arrives as a 400 in
   * that session's own thread.
   *
   * Exactly one, over the real catalog: a second gated window would be a
   * measurement nobody took, and a zeroth means the flag stopped reaching the
   * wire. `catalog.test.ts` pins the data; this is what the reader meets.
   */
  it('draws a gated window dashed, and lets it be picked anyway', (t) => {
    const p = openPanel(t);
    const fly = catalog(p);
    const gated = [...fly.querySelectorAll<HTMLElement>('.wp.gated')];
    assert.equal(gated.length, 1, `${gated.length} windows are drawn as gated`);
    // Sonnet 4.6's wide window, and not its narrow one — the gate is on the
    // pair, not on the model.
    assert.equal(pick(fly, 'Sonnet 4.6', '1M').classList.contains('gated'), true);
    assert.equal(pick(fly, 'Sonnet 4.6', '200k').classList.contains('gated'), false);
    // A dashed border explains nothing on its own.
    assert.equal(gated[0]?.dataset.tip, 'Runs, but this account is asked for usage credits first');
    assert.equal(pick(fly, 'Sonnet 4.6', '200k').dataset.tip, undefined);
    // Pickable, and it posts what any other pill posts. `.off` would be the
    // wrong mark precisely because that promises the opposite.
    assert.equal(gated[0]?.classList.contains('off'), false);
    pick(fly, 'Sonnet 4.6', '1M').click();
    assert.deepEqual(sent(p), {
      brand: 'claude',
      model: 'claude-sonnet-4-6',
      window: 1_000_000
    });
  });

  it('puts every legacy row behind one fold, below every current one', (t) => {
    const fly = catalog(openPanel(t));
    const order = flow(fly);
    // By name and de-duplicated: one row stands for every window of a model
    // now, so the eighteen entries draw ten rows.
    const current = [...new Set(OFFERED.filter((m) => !m.legacy).map((m) => m.name))];
    const legacy = [...new Set(OFFERED.filter((m) => m.legacy).map((m) => m.name))];
    assert.ok(legacy.length, 'the catalog carries no legacy row to fold');
    // The fold replaced the rule outright: a fold *and* a rule would be the
    // boundary drawn twice, once by a control and once by paint.
    assert.equal(order.indexOf('—'), -1, 'a rule is still drawn beside the fold');
    const at = order.indexOf(`>${legacy.length} older`);
    assert.ok(at > 0, `no fold standing for ${legacy.length} rows: ${order.join(' / ')}`);
    for (const name of current) {
      assert.ok(order.indexOf(name) < at, `${name} is a current row and fell below the fold`);
    }
    for (const name of legacy) {
      assert.ok(order.indexOf(name) > at, `${name} is a legacy row and sits above the fold`);
    }
    // Drawn, and not one of them showing.
    assert.deepEqual(visible(fly), current);
  });

  /** What the fold is for: the list opens at the models anyone is choosing, and
   *  the rest are one press away rather than gone. */
  it('shows every older row on the fold, and says so to a reader who cannot see it', (t) => {
    const fly = catalog(openPanel(t));
    const legacy = [...new Set(OFFERED.filter((m) => m.legacy).map((m) => m.name))];
    const older = fold(fly);
    assert.equal(older.getAttribute('aria-expanded'), 'false');
    assert.equal(older.getAttribute('role'), 'menuitem');
    older.click();
    assert.equal(older.getAttribute('aria-expanded'), 'true');
    for (const name of legacy) {
      assert.ok(visible(fly).includes(name), `${name} is still hidden after the fold was opened`);
    }
    // And shut again on a second press: it is a fold, not a reveal.
    older.click();
    for (const name of legacy) {
      assert.ok(!visible(fly).includes(name), `${name} stayed out after the fold was shut`);
    }
  });

  /**
   * The one case a shut fold cannot survive: the model in force is inside it.
   *
   * A menu whose tick is behind a fold answers "which one am I on" with
   * nothing — and it is also where the focus is sent, so a shut fold would land
   * the keyboard on the first row instead of the picked one.
   */
  it('opens the fold when the model in force is one of the older ones', (t) => {
    const p = openPanel(t);
    const first = catalog(p);
    fold(first).click();
    pick(first, 'Opus 4.8', '1M').click();
    const fly = pillMenu(p);
    assert.equal(fold(fly).getAttribute('aria-expanded'), 'true');
    assert.ok(visible(fly).includes('Opus 4.8'), 'the ticked row is folded away');
  });

  /** A legacy model is one press further than a current one, and no further:
   *  it is still an ordinary row, which is the whole reason the catalog can
   *  name one the CLI stopped advertising. */
  it('offers a legacy model as an ordinary row', (t) => {
    const p = openPanel(t);
    const fly = catalog(p);
    fold(fly).click();
    pick(fly, 'Opus 4.8', '1M').click();
    // The window rides beside the id since the flatten: `claude-opus-4-8` alone
    // names two entries, and the pick has to say which pill was pressed.
    assert.deepEqual(sent(p), {
      brand: 'claude',
      model: 'claude-opus-4-8',
      window: 1_000_000
    });
  });
});

/**
 * The search box, and the one rule that decides whether there is one.
 *
 * `SEARCH_ABOVE` in `webview/picker.ts` is the panel's own answer to how long a
 * list gets before it is worth searching — eight — and it is asserted against
 * the constant rather than against the number, so a list this menu draws and a
 * list a filter pill draws can never disagree about it.
 */
describe('finding a model by typing', () => {
  const CLAUDE = catalogFor('claude');
  const GROK = catalogFor('grok');
  const both: ModelView[] = [...labelled(CLAUDE, 'Claude'), ...labelled(GROK, 'Grok')];

  it('offers no search box for a list short enough to read', (t) => {
    const fly = drill(openPanel(t));
    assert.ok(MODELS.length <= SEARCH_ABOVE, 'the fixture outgrew the rule it is testing');
    assert.equal(search(fly), null, 'a three-row menu grew a search box');
  });

  it('offers one past the length the panel already calls long', (t) => {
    const fly = drill(openPanel(t), { models: both });
    assert.ok(search(fly), 'a list this long offers no way to search it');
  });

  /**
   * The gate counts **rows**, and this is the case that tells the two apart:
   * the wire carries one entry per (model x window), so a menu of five models
   * at two windows each arrives as ten entries and draws five rows. Counting
   * entries grew a search box over a list a reader can see all of.
   *
   * The two cases above cannot catch it — one is three entries in three rows,
   * the other is past the line on either count.
   */
  it('counts the rows it draws, not the windows they carry', (t) => {
    const wide = ['a', 'b', 'c', 'd', 'e'].flatMap((value) =>
      [1_000_000, 200_000].map((window) => ({
        value,
        name: value.toUpperCase(),
        id: value,
        brand: 'claude' as const,
        window
      }))
    );
    assert.ok(wide.length > SEARCH_ABOVE, 'the fixture has too few entries to tell them apart');
    const fly = drill(openPanel(t), { models: wide });
    assert.equal(visible(fly).length, 5, 'the fixture did not draw one row per model');
    assert.equal(search(fly), null, 'five rows grew a search box off ten entries');
  });

  it('narrows to what was typed, across every brand at once', (t) => {
    const fly = drill(openPanel(t), { models: both });
    type(fly, 'grok');
    assert.deepEqual(
      visible(fly),
      [...new Set(GROK.map((m) => m.name))],
      'the needle kept rows it does not match, or dropped ones it does'
    );
  });

  /** A heading is a fact about the rows under it. With one brand left there is
   *  nothing to tell apart, which is the same rule an unfiltered single-brand
   *  list already follows. */
  it('keeps a run heading only while that run still has a row', (t) => {
    const fly = drill(openPanel(t), { models: both });
    type(fly, 'opus');
    assert.deepEqual(
      [...fly.querySelectorAll<HTMLElement>('.mhead')].map((h) => h.textContent),
      []
    );
    type(fly, '5');
    assert.deepEqual(
      [...fly.querySelectorAll<HTMLElement>('[role="group"]')].map((g) =>
        g.getAttribute('aria-label')
      ),
      ['Claude', 'Grok']
    );
  });

  /** The fold and the search cannot both be in charge — `paint` in
   *  `webview/board_settings.ts` says which wins and why. */
  it('reaches a row the fold was holding, without being opened first', (t) => {
    const fly = drill(openPanel(t), { models: both });
    assert.ok(!visible(fly).includes('Opus 4.7'), 'the row was not folded away to begin with');
    type(fly, 'opus 4.7');
    assert.deepEqual(visible(fly), ['Opus 4.7']);
    assert.deepEqual(folds(fly), [], 'a filtered list still drew a fold');
  });

  it('matches an id and a brand as well as a name', (t) => {
    const fly = drill(openPanel(t), { models: both });
    // The id is not drawn any more — the pills took that column — and it is
    // still what a reader who came from a launch line or a card has in hand.
    type(fly, 'claude-haiku');
    assert.deepEqual(visible(fly), ['Haiku 5.5', 'Haiku 4.5']);
    type(fly, 'claude');
    assert.equal(visible(fly).includes('Opus 5'), true);
    assert.equal(
      visible(fly).some((n) => n.startsWith('Grok')),
      false
    );
  });

  /** Two different silences, and they are not the same fact: nothing offered at
   *  all is an account problem, nothing matching is a typing one. */
  it('says nothing matches, which is not the same as nothing offered', (t) => {
    const fly = drill(openPanel(t), { models: both });
    type(fly, 'gpt-4');
    assert.deepEqual(visible(fly), []);
    assert.equal(fly.querySelector('.fnone')?.textContent, 'Nothing matches.');
  });

  /** Cleared, the menu is the menu again — fold and all. */
  it('puts the fold back when the needle goes', (t) => {
    const fly = drill(openPanel(t), { models: both });
    type(fly, 'opus 4.7');
    type(fly, '');
    assert.equal(folds(fly).length, 2);
    assert.ok(!visible(fly).includes('Opus 4.7'));
    assert.ok(!visible(fly).includes('Grok 4.6'));
  });

  /**
   * The caret keys belong to the box. `onMenuKey` is a document listener and
   * ArrowLeft means *leave this menu level* — so before the guard, a reader
   * pressing left to fix a typo mid-needle had the flyout torn down and the
   * needle thrown away. Escape still closes from inside the box, and
   * ArrowDown still walks out of it.
   */
  it('keeps the flyout open on a caret key inside the search box', (t) => {
    const p = openPanel(t);
    const fly = drill(p, { models: both });
    type(fly, 'son');
    search(fly)!.focus();
    key(p, 'ArrowLeft');
    assert.equal(flyout(p), fly, 'a caret key closed the flyout');
    assert.equal(search(fly)?.value, 'son', 'the needle was thrown away');
    // The two that must still act from inside the box.
    key(p, 'ArrowDown');
    assert.ok(
      (p.window.document.activeElement as HTMLElement)?.classList.contains('wp'),
      'ArrowDown no longer walks out of the box'
    );
    search(fly)!.focus();
    key(p, 'Escape');
    assert.equal(flyout(p), null, 'Escape no longer closes from inside the box');
  });

  /** The composer is a field too, though it is no `input`: the prose
   *  editor's root is `contenteditable`, and a caret key there is its own. */
  it('keeps a nested flyout open on a caret key in the composer', (t) => {
    const p = draft(openPanel(t));
    gearFly(p);
    const open = (): Element | null => p.window.document.querySelector('.fmenu.fly:not([hidden])');
    composerTarget(p).focus();
    key(p, 'ArrowLeft');
    assert.ok(open(), 'a caret key in the composer closed the flyout');
    // Out of the box, the same key leaves the level.
    composerTarget(p).blur();
    key(p, 'ArrowLeft');
    assert.equal(open(), null, 'ArrowLeft no longer leaves a nested menu');
  });

  /**
   * Focus, on open. `opensMenu` sends it to a search box where there is one —
   * a menu long enough to be searched is one a reader reaches by typing, and
   * the ticked pill is one ArrowDown away either way.
   */
  it('lands the focus in the search box rather than on the tick', (t) => {
    const p = openPanel(t);
    const fly = drill(p, { models: both });
    assert.equal(p.window.document.activeElement, search(fly));
    key(p, 'ArrowDown');
    assert.ok(
      (p.window.document.activeElement as HTMLElement)?.classList.contains('wp'),
      'the first arrow out of the box did not land on a window'
    );
  });
});

/** Which CLI a row is, on the row. Why, and why only past one brand:
 *  `manyBrands` in `webview/board_settings.ts`. */
describe('the brand mark on a model row', () => {
  const CLAUDE = catalogFor('claude');
  const GROK = catalogFor('grok');

  it('marks every row when the board offers more than one brand', (t) => {
    const fly = drill(openPanel(t), {
      models: [...labelled(CLAUDE, 'Claude'), ...labelled(GROK, 'Grok')]
    });
    const marked = [...fly.querySelectorAll<HTMLElement>('.mitem.wins')].filter((row) =>
      row.querySelector('.bmwrap')
    );
    assert.equal(marked.length, fly.querySelectorAll('.mitem.wins').length);
    // The mark leads the row, and says nothing out loud: the row's name is the
    // name, and a brand read twice per row is noise.
    const first = fly.querySelector<HTMLElement>('.mitem.wins');
    assert.equal(first?.firstElementChild?.className, 'bmwrap');
    assert.equal(first?.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
  });

  it('marks nothing when every row is one brand', (t) => {
    const fly = drill(openPanel(t), { models: labelled(CLAUDE, 'Claude') });
    assert.equal(fly.querySelector('.mitem .bmwrap'), null, 'a single-brand list was marked');
  });

  /** The fold is not a model, so it carries no mark — it is inside the run that
   *  names it, one row below its heading. */
  it('marks no fold', (t) => {
    const fly = drill(openPanel(t), {
      models: [...labelled(CLAUDE, 'Claude'), ...labelled(GROK, 'Grok')]
    });
    assert.equal(folds(fly).length, 2);
    for (const row of folds(fly)) assert.equal(row.querySelector('.bmwrap'), null);
  });
});

describe('the model flyout over the Codex catalog shape', () => {
  it('keeps Sol 6 and every Codex model below GPT-6 in Older', (t) => {
    const fly = drill(openPanel(t), { models: [...catalogFor('codex')] });
    assert.deepEqual(visible(fly), ['Sol 6.1', 'Terra 6.1', 'Astra 6', 'Luna 6']);
    fold(fly).click();
    assert.deepEqual(visible(fly).slice(4), [
      'Sol 6',
      'Sol 5.6',
      'Terra 5.6',
      'Luna 5.6',
      'GPT-5.5',
      'GPT-5.4',
      'Mini 5.4',
      'Spark 5.3'
    ]);
  });

  it('draws Haiku 5.5 with the current models and keeps Haiku 4.5 under Older', (t) => {
    const fly = drill(openPanel(t), { models: [...catalogFor('claude')] });
    assert.deepEqual(visible(fly), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1']);
    assert.deepEqual(pills(fly, 'Haiku 5.5'), ['1M', '200k']);
    fold(fly).click();
    assert.ok(visible(fly).includes('Haiku 4.5'));
  });

  for (const [label, window] of [
    ['1M', 1_000_000],
    ['200k', 200_000]
  ] as const) {
    it(`posts Haiku 5.5 with its ${label} window and catalog effort`, (t) => {
      const p = openPanel(t);
      const fly = drill(p, { models: [...catalogFor('claude')] });
      pick(fly, 'Haiku 5.5', label).click();
      assert.deepEqual(sent(p), {
        brand: 'claude',
        model: 'claude-haiku-5-5',
        window
      });
      assert.equal(lastOpen(p).effort, 'high');
    });
  }

  for (const [name, model, label, window] of [
    ['Sol 6.1', 'gpt-6.1-sol', '475k', 475_000],
    ['Terra 6.1', 'gpt-6.1-terra', '475k', 475_000],
    ['Astra 6', 'gpt-6-astra', '258k', 258_400]
  ] as const) {
    it(`draws ${name}'s runtime window and posts the same value with the model`, (t) => {
      const p = openPanel(t);
      const fly = drill(p, { models: [...catalogFor('codex')] });
      assert.deepEqual(pills(fly, name), [label]);
      pick(fly, name, label).click();
      assert.deepEqual(sent(p), { brand: 'codex', model, window });
    });
  }
});

/**
 * A list with more than one brand in it: rows run together by brand, and the
 * legacy rule a brand's internal business. Why that is the order, and what it
 * replaced, is on `modelItems` in `webview/board_settings.ts`.
 *
 * Driven over the real catalogs for the same reason the block above is: a
 * literal written to match would pass whatever the catalogs said.
 */
/**
 * The gear is start-side, and a start composes its own line.
 *
 * `fixed` says a *running* session cannot be moved onto a window, because
 * `--settings` was composed at spawn and no env var joins a live process. That
 * is a fact about one session, and this flyout is about the next one — so
 * nothing here is ever dimmed for it, whatever the board's sessions are doing.
 * `modelsForSession` is the dock-only path and the only thing that stamps.
 */
describe('the model flyout is never fixed', () => {
  it('draws every window of the real catalog pickable', (t) => {
    const fly = drill(openPanel(t), { models: [...catalogFor('claude')] });
    assert.ok(fly.querySelectorAll('.wp').length > 0, 'the flyout drew no pills at all');
    const dimmed = [...fly.querySelectorAll<HTMLElement>('.wp')].filter(
      (w) => w.classList.contains('off') || w.getAttribute('aria-disabled') === 'true'
    );
    assert.deepEqual(dimmed, [], 'the start flyout dimmed a window');
  });
});

describe('the flyout over more than one brand', () => {
  const CLAUDE = catalogFor('claude');
  const GROK = catalogFor('grok');
  const both: ModelView[] = [...labelled(CLAUDE, 'Claude'), ...labelled(GROK, 'Grok')];
  const mixed = (p: Panel): HTMLElement => drill(p, { models: both });

  /** One row per model, which is what a flattened list draws after shape B. */
  const MODEL_ROWS = new Set([...CLAUDE, ...GROK].map((m) => m.name)).size;

  /** Every Grok row below every Claude one, whatever else the menu did. */
  const grokLast = (order: string[]): void => {
    const last = Math.max(...CLAUDE.map((m) => order.indexOf(m.name)));
    for (const grok of GROK) {
      assert.ok(order.indexOf(grok.name) > last, `${grok.name} sits inside the Claude rows`);
    }
  };

  it('keeps a brand whole rather than splitting it on legacy', (t) => {
    const order = flow(mixed(openPanel(t)));
    for (const m of [...CLAUDE, ...GROK]) {
      assert.ok(order.includes(m.name), `no "${m.name}" row in the flyout`);
    }
    grokLast(order);
  });

  it('heads each brand with what the host called it', (t) => {
    const order = flow(mixed(openPanel(t)));
    assert.equal(order[0], '#Claude', 'the first brand is not headed');
    assert.equal(
      order[order.indexOf(GROK[0]!.name) - 1],
      '#Grok',
      'the Grok run does not open with its own heading'
    );
  });

  /** Each brand folds its own older rows, without reaching the next brand. */
  it('folds the older rows of a brand without reaching the next brand', (t) => {
    const fly = mixed(openPanel(t));
    const order = flow(fly);
    const oldClaude = new Set(CLAUDE.filter((m) => m.legacy).map((m) => m.name)).size;
    const oldGrok = new Set(GROK.filter((m) => m.legacy).map((m) => m.name)).size;
    assert.ok(oldClaude > 0, 'the Claude catalog carries no legacy row to fold');
    assert.equal(oldGrok, 2, 'Grok 4.5 and 4.6 should be Older');
    const own = folds(fly);
    assert.deepEqual(
      own.map((row) => row.closest('[role="group"]')?.getAttribute('aria-label')),
      ['Claude', 'Grok']
    );
    const at = order.indexOf(`>${oldClaude} older`);
    const grokFold = order.indexOf(`>${oldGrok} older`);
    const grokAt = order.indexOf('#Grok');
    const spot = (m: { name: string }): number => order.indexOf(m.name);
    assert.ok(at < Math.min(...CLAUDE.filter((m) => m.legacy).map(spot)));
    assert.ok(at > Math.max(...CLAUDE.filter((m) => !m.legacy).map(spot)));
    assert.ok(at < grokAt, 'the fold fell into the Grok run');
    assert.ok(grokFold > Math.max(...GROK.filter((m) => !m.legacy).map(spot)));
    assert.ok(grokFold < Math.min(...GROK.filter((m) => m.legacy).map(spot)));
    const grokRun = own[1]?.closest<HTMLElement>('[role="group"]');
    assert.ok(grokRun);
    assert.ok(!visible(grokRun).includes('Grok 4.6'));
    assert.ok(!visible(grokRun).includes('Grok 4.5'));
    own[1]?.click();
    assert.ok(visible(grokRun).includes('Grok 4.6'));
    assert.ok(visible(grokRun).includes('Grok 4.5'));
    // And no rule anywhere: the fold is the boundary now, drawn once.
    assert.equal(order.filter((n) => n === '—').length, 0);
  });

  /**
   * The boundary, for a reader who cannot see it. A heading is paint; what a
   * keyboard walk crosses is the group, and `menuItem` in `kit.ts` is explicit
   * that the role has to come with the paint.
   */
  it('names each run to a reader who is not looking at it', (t) => {
    const fly = mixed(openPanel(t));
    const runs = [...fly.querySelectorAll<HTMLElement>('[role="group"]')];
    assert.deepEqual(
      runs.map((run) => run.getAttribute('aria-label')),
      ['Claude', 'Grok']
    );
    // Every row is inside the run that names it, and the heading is not read
    // out a second time on the way past.
    const claude = runs[0];
    assert.ok(claude?.querySelector('.mitem'), 'the Claude run holds no rows');
    assert.equal(claude?.querySelector('.mhead')?.getAttribute('aria-hidden'), 'true');
    // The rows are still this menu's own rows, wrapper or not (`levelRows`
    // filters on the nearest `.fmenu`).
    //
    // `MODEL_ROWS`, not `both.length`: a row stands for a model and its windows
    // are pills inside it, so a two-window model is two entries and one row.
    // Counting entries here is exactly the mistake shape B is easiest to make.
    // Derived rather than written down — the catalog grows, and a number here
    // was already stale before `grok-4.7` made it more so.
    //
    // `.mitem.wins` and not every `.mitem`: the fold wears the row's box so it
    // is a target and a walk stop without a second opinion about either, which
    // makes it an `.mitem` that stands for no model.
    assert.equal(
      fly.querySelectorAll('.mitem.wins').length,
      MODEL_ROWS,
      'the wrapper lost rows out of the menu, or added some'
    );
  });

  /**
   * The walk crosses a run boundary, which is the one thing the wrapper could
   * have broken: `levelRows` filters on the nearest `.fmenu`, so a row inside a
   * group is still this menu's row — but that is a fact about `kit.ts`, not
   * about this markup, and the two only agree until somebody changes one.
   * Neither the heading nor the group box may take the focus on the way past.
   */
  it('walks from the last pill of one brand onto the first of the next', (t) => {
    const p = openPanel(t);
    const fly = mixed(p);
    // **Pill to pill, not row to row.** Both ends are `div`s now, and jsdom
    // neither moves focus onto one nor throws for trying — so a walk written
    // against rows would report "the walk stopped on the heading" while the
    // real cause was that nothing at either end was focusable.
    /** An entry's own pill, named the way the menu spells it. */
    const pillOf = (entry: Model | undefined): HTMLElement => {
      assert.ok(entry?.window !== undefined, 'the catalog handed back an entry with no window');
      return pick(fly, entry.name, ctxLabel(entry.window));
    };
    //
    // The last thing a reader can *see* in the Claude run, which since the fold
    // is the fold itself — the legacy entries below it are drawn and hidden,
    // and `levelRows` skips anything inside a hidden box.
    const current = CLAUDE.filter((m) => !m.legacy);
    const from = pillOf(current[current.length - 1]);
    const to = pillOf(GROK[0]);
    const shut = folds(fly)[0];
    assert.ok(shut);
    from.focus();
    key(p, 'ArrowDown');
    assert.equal(p.window.document.activeElement, shut, 'the walk skipped the fold');
    key(p, 'ArrowDown');
    assert.equal(
      p.window.document.activeElement,
      to,
      'the walk stopped on a folded row, the heading, or the run box between the two brands'
    );
    key(p, 'ArrowUp');
    assert.equal(p.window.document.activeElement, shut);
  });

  /**
   * What the walk stops on, over the whole menu: pills and the footer button,
   * and never a row.
   *
   * A row is `role="presentation"` and carries no tabindex, so this is really
   * asking whether `MENU_ROWS` in `kit.ts` still matches `.mitem` — it does,
   * for every other menu in the panel, and the model flyout is the one place
   * that must be excluded. Asserted over the walk rather than over the
   * selector, because the selector is not what a reader meets.
   */
  it('stops on a window, on a fold, and never on a model', (t) => {
    const p = openPanel(t);
    const fly = mixed(p);
    // What a reader can reach, in the order it is drawn: a pill, the one fold,
    // and the footer button — and nothing a fold is holding shut.
    const stops = [...fly.querySelectorAll<HTMLElement>('.wp, .mitem.mfold, .fbtn')].filter(
      (node) => node.closest('[hidden]') === null
    );
    // More stops than rows, which is what having a pill per window means —
    // and not `MODEL_ROWS`, which counts the folded rows this walk cannot see.
    assert.ok(stops.length > visible(fly).length, 'no menu of pills to walk');
    stops[0]!.focus();
    const visited: Element[] = [];
    for (let i = 0; i < stops.length; i++) {
      const at = p.window.document.activeElement;
      if (at) visited.push(at);
      key(p, 'ArrowDown');
    }
    for (const node of visited) {
      assert.ok(
        node.classList.contains('wp') ||
          node.classList.contains('mfold') ||
          node.classList.contains('fbtn'),
        `the walk stopped on ${node.className || node.tagName}`
      );
    }
    assert.deepEqual(visited, stops);
  });

  /** A heading over the only run in a menu is a word that tells a reader
   *  nothing. This is the gear's flyout; the second surface is asserted in
   *  `chat_composer.test.ts`, which is the one that can open it. */
  it('heads nothing when every row is one brand', (t) => {
    const p = openPanel(t);
    const fly = drill(p, { models: labelled(CLAUDE, 'Claude') });
    assert.equal(fly.querySelector('.mhead'), null, 'a single-brand list was headed');
  });

  /**
   * The degraded draw, not a design. Unlabelled rows cannot reach the panel —
   * `offeredModels` is their only producer and it stamps every one — so this
   * pins what happens if they ever did: still grouped, silently. It is the
   * mockup's rejected ordering 3, and it is asserted as a fallback rather than
   * as an option anyone may choose.
   */
  it('falls back to grouping in silence when nothing states a word', (t) => {
    const p = openPanel(t);
    const order = flow(drill(p, { models: [...CLAUDE, ...GROK] }));
    assert.equal(order.filter((n) => n.startsWith('#')).length, 0);
    grokLast(order);
  });
});

// `describe('an id typed into the flyout')` and `describe('two menus, one
// stack')` stood here, and both died with the surface they were about. The
// typed-id field was `idField`, the gear's own footer, and the two-menu stack
// was this menu having been opened out of *another* menu — the pill opens it
// directly. `TASK_done_draft_new_session.md` Step 8 retired both.
//
// What survived the move is the one invariant that was never about the gear:
// the poll must not replace a menu that is open under the reader's finger.

describe('the menu under a poll', () => {
  /**
   * A push lands every 3s, and it repaints the composer. `heldOpen` is what
   * keeps the pill and its menu still while one is open — without it the node
   * the mousedown landed on is detached before the mouseup, and the press is
   * never dispatched at all.
   */
  it('holds the composer still while the menu is open', (t) => {
    const p = openPanel(t);
    const fly = drill(p);
    p.push(stateMessage([groupView({ sessions: [] })], { models: MODELS, soundLevel: 'normal' }));
    assert.equal(flyout(p), fly, 'the poll replaced the menu');
    assert.equal(pick(fly, 'Haiku').isConnected, true, 'the menu was detached from the document');
  });
});
