import * as assert from 'node:assert/strict';
import {
  Panel,
  enter,
  groupView,
  lastOpen,
  newDraft,
  openSettings,
  stateMessage,
  switchRow,
  typeIn
} from '../harness';

/**
 * The two surfaces that say what a start runs on: the gear's `Default model`
 * row, and the draft's model pill.
 *
 * One invariant over both. Either says what a *start* will pass, never what any
 * session is running — a card reads that off its own transcript, and the three
 * are allowed to disagree.
 *
 * **They are not two answers to one question.** The gear writes
 * `squadron.model`, which is where a start *opens*: the draft's pill is
 * seeded from it (`defaultPick`) and a resume with no control of its own
 * passes it through. The pill is where a start *lands*: a pick there rides the
 * `open` its first send makes and writes nothing back, so the reader who wants
 * one model for this New and another for the next gets both without a trip to
 * the gear.
 *
 * The menu itself — its rows, its window pills, its ticks, its fold, its search
 * and its brand marks — is `modelItems`, one list drawn by both openers. Most
 * of what is asserted below is that list.
 *
 * Where the menu is *placed* is `flyout.test.ts` — jsdom has no layout engine,
 * so every rect here is zero and the arithmetic is tested where it can be.
 */

/**
 * The rows as the host puts them on the wire — one entry per (model × window),
 * which is what `catalogFor` hands `offeredModels` since the flatten.
 *
 * **Two Opus entries sharing a `value`, on purpose.** They are one model at two
 * windows, not two models: the name is the same on both and `window` is the
 * whole of the difference, so a menu that keyed on `value` would tick both and
 * a pick that omitted the window could not say which was pressed. Haiku is the
 * other case worth a fixture — a model that runs in one window, and therefore
 * draws one pill.
 *
 * Every entry states a `window`. A row with none still draws (`modelItems`
 * falls back to the old single-control row), and that degradation has its own
 * case rather than leaking into every other one here.
 */
export const MODELS: ModelView[] = [
  { value: 'opus', name: 'Opus', id: 'claude-opus-5', brand: 'claude', window: 1_000_000 },
  { value: 'opus', name: 'Opus', id: 'claude-opus-5', brand: 'claude', window: 200_000 },
  {
    value: 'haiku',
    name: 'Haiku',
    id: 'claude-haiku-4-5-20251001',
    brand: 'claude',
    window: 200_000
  }
];

export const CLAUDE_EFFORTS = [
  { value: 'max' },
  { value: 'xhigh' },
  { value: 'high' },
  { value: 'medium' },
  { value: 'low' }
];

export const EFFORT_MODELS: ModelView[] = [
  {
    value: 'opus',
    name: 'Opus',
    id: 'claude-opus-5',
    brand: 'claude',
    window: 1_000_000,
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    value: 'opus',
    name: 'Opus',
    id: 'claude-opus-5',
    brand: 'claude',
    window: 200_000,
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    value: 'haiku',
    name: 'Haiku',
    id: 'claude-haiku-4-5-20251001',
    brand: 'claude',
    window: 200_000
  }
];

/** A board with a list to offer, and a draft open on it. */
export function draft(p: Panel, over: Partial<StateMessage> = {}): Panel {
  p.push(stateMessage([groupView({ sessions: [] })], { models: MODELS, ...over }));
  newDraft(p);
  return p;
}

/** The pill the draft draws, or `null` for a machine offering nothing. */
export const pill = (p: Panel): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>('#ctools .fpill.model');

/** What the closed pill reads. */
export const value = (p: Panel): string => pill(p)?.querySelector('.nm')?.textContent ?? '';

/**
 * The pill's menu while it is open.
 *
 * `hidden` is read as a property rather than matched as `:not([hidden])`:
 * nwsapi answers that attribute selector inconsistently for a property-set
 * `hidden` under jsdom, which reads as a menu that never closes.
 */
export const flyout = (p: Panel): HTMLElement | null => {
  const menu = p.window.document.querySelector<HTMLElement>('#ctools .fwrap .fmenu');
  return menu && !menu.hidden ? menu : null;
};

/** Reopen the pill's menu on a draft that is already up — what a pick has to
 *  survive, and what an assertion about a tick has to read. */
export function pillMenu(p: Panel): HTMLElement {
  pill(p)?.click();
  const fly = flyout(p);
  assert.ok(fly, 'the pill opened no menu');
  return fly;
}

/** The menu, opened by pressing the pill — which is what a reader does. */
export function drill(p: Panel, over: Partial<StateMessage> = {}): HTMLElement {
  pill(draft(p, over))?.click();
  const fly = flyout(p);
  assert.ok(fly, 'the pill opened no menu');
  return fly;
}

/**
 * The row a model draws, by the name on it.
 *
 * A row is not a control since shape B — it is a `role="presentation"` box
 * holding a label and one pill per window. Reach for this to read a row; reach
 * for `pick` to press one.
 */
export const modelRow = (fly: HTMLElement, name: string): HTMLElement => {
  const found = [...fly.querySelectorAll<HTMLElement>('.mitem')].find(
    (r) => r.querySelector('.nm')?.textContent === name
  );
  assert.ok(found, `no "${name}" row in the flyout`);
  return found;
};

/**
 * The control a reader presses: one window of one model.
 *
 * `window` is optional because a model that runs in one window draws one pill,
 * and naming it there would be a fixture restating the catalog — but where a
 * row has two, leaving it out is the bug this signature exists to make
 * impossible, so it asserts rather than guessing.
 */
export const pick = (fly: HTMLElement, name: string, window?: string): HTMLElement => {
  const row = modelRow(fly, name);
  const own = [...row.querySelectorAll<HTMLElement>('.wp')];
  if (window === undefined) {
    // A row with no pill at all is the degraded draw — the row is the control,
    // and it is what `menuItem` still builds for an entry stating no window.
    if (!own.length) return row;
    assert.equal(own.length, 1, `"${name}" offers ${own.length} windows — name the one to press`);
    return own[0]!;
  }
  const hit = own.find((w) => w.textContent === window);
  assert.ok(
    hit,
    `"${name}" offers no ${window} window — it draws ${own.map((w) => w.textContent).join(', ')}`
  );
  return hit;
};

/**
 * What the pick actually reaches the host as: the `open` its first send makes.
 *
 * A pick on the pill posts nothing on its own — it is a fact about a message
 * not yet sent — so every assertion that would have read a `setModel` reads
 * this instead. The brand rides too, which no setting carries: `agentsview.cli`
 * was a second key that had to be moved in step with `squadron.model`, and it
 * retired precisely because a pick that moved one without the other is how a
 * Grok row still started Claude.
 */
export function sent(p: Panel): { brand?: BrandId; model?: string; window?: number } {
  typeIn(p, 'begin');
  enter(p);
  // Effort stays off this comparison. Callers read it from `target`, and a
  // catalog default would otherwise fail every brand, model and window check.
  const target = lastOpen(p).target;
  return {
    ...(target?.brand === undefined ? {} : { brand: target.brand }),
    ...(target?.model === undefined ? {} : { model: target.model }),
    ...(target?.window === undefined ? {} : { window: target.window })
  };
}

/** The gear's own row, by the label a reader presses. */
export const gearRow = (p: Panel, over: Partial<StateMessage> = {}): HTMLElement => {
  p.push(stateMessage([groupView()], { models: MODELS, ...over }));
  return switchRow(openSettings(p), 'Default model');
};

/** What the closed gear row reads. */
export const gearValue = (p: Panel, over: Partial<StateMessage> = {}): string =>
  gearRow(p, over).querySelector('.val')?.textContent ?? '';

/** The gear's flyout, drilled out of its row — a different menu from the
 *  pill's, and reached by a different selector. */
export function gearFly(p: Panel, over: Partial<StateMessage> = {}): HTMLElement {
  gearRow(p, over).click();
  const fly = p.window.document.querySelector<HTMLElement>('.fmenu.fly:not([hidden])');
  assert.ok(fly, 'the row opened no flyout');
  return fly;
}
