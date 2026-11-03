import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogFor } from '../../core/catalog';
import { Panel, groupView, openPanel, openSettings, stateMessage, switchRow } from '../harness';
import {
  MODELS,
  CLAUDE_EFFORTS,
  EFFORT_MODELS,
  pick,
  gearRow,
  gearValue,
  gearFly
} from './model_picker_helpers';

describe('the default model row', () => {
  // The second clause is the one a reader will actually want: they can see six
  // cards while they read it, and none of them is going to change. The first
  // says the row is a starting point rather than a verdict — the pill on the
  // draft is what finally decides.
  it('says what it does and does not change', (t) => {
    assert.equal(
      gearRow(openPanel(t)).querySelector('.d')?.textContent,
      'What a new session starts on, before its own pill is touched. A session already running keeps the model it is on.'
    );
  });

  // `''` is a fresh profile rather than a choice: the flyout offers no way to
  // write one. The row reads the model a start would actually land on — saying
  // `default` named a model nobody could see.
  it('reads the first current model when nothing is set', (t) => {
    assert.equal(gearValue(openPanel(t)), 'Opus (1M)');
  });

  // The gear's closed row is the one surface that spells a window into a name:
  // one value, no pill beside it, no card under it. `named()` composes it with
  // `ctxLabel`, off `window` — the row itself carries `Opus`.
  it('reads the name of the model that is set, and the window with it', (t) => {
    assert.equal(gearValue(openPanel(t), { model: 'haiku' }), 'Haiku (200k)');
  });

  /** Two entries share `opus`, so the stored window is what picks which of them
   *  the row names. Without one it reads the first, which is the wide one — the
   *  same tie-break `resolveModel` takes, and the reason `windows` runs
   *  widest-first. */
  it('names the window the setting stores, not the model’s first entry', (t) => {
    assert.equal(gearValue(openPanel(t), { model: 'opus', contextWindow: 200_000 }), 'Opus (200k)');
  });

  // A model id typed by hand, or one the CLI has since dropped: the row says
  // the string it will actually pass rather than a name it cannot look up.
  it('reads a set value the list does not name, verbatim', (t) => {
    assert.equal(gearValue(openPanel(t), { model: 'claude-opus-4-5' }), 'claude-opus-4-5');
  });

  /**
   * Against the rows the panel actually ships, not the fixture — which is what
   * makes this an assertion about the product rather than about this file.
   *
   * `Opus 5.5 (1M)` and not `(200k)`: `CatalogRow.windows` runs widest first, and
   * that order is load-bearing for `resolveModel`'s tie-break (`catalog.ts`).
   */
  it('resolves an unset value against the real catalog', (t) => {
    assert.equal(gearValue(openPanel(t), { models: [...catalogFor('claude')] }), 'Opus 5.5 (1M)');
  });

  /** A brand with one window per model, so the composed label is the whole of
   *  what the flatten adds — and the row resolves for a machine that has only
   *  this CLI installed. */
  it('resolves an unset value on a Grok-only board', (t) => {
    assert.equal(gearValue(openPanel(t), { models: [...catalogFor('grok')] }), 'Grok 4.7 (500k)');
  });

  /** With no list there is nothing to resolve against, and the row will not
   *  invent a name — `default` is what it falls back to saying. */
  it('reads default when nothing is set and no list arrived', (t) => {
    assert.equal(gearValue(openPanel(t), { models: [] }), 'default');
  });

  /** A lone pill posts what a pill of a two-window row posts: the pair. Its row
   *  offers no choice, and that is not a reason to send half a pick. */
  it('posts the picked model and its window', (t) => {
    const p = openPanel(t);
    pick(gearFly(p), 'Haiku').click();
    assert.deepEqual(p.posted.at(-1), { type: 'setModel', model: 'haiku', window: 200_000 });
  });

  /** The two pills of one row are two different starts and the value is the
   *  same on both, so the window is the only thing telling the messages apart. */
  it('posts the window the pressed pill stands for', (t) => {
    const p = openPanel(t);
    pick(gearFly(p), 'Opus', '200k').click();
    assert.deepEqual(p.posted.at(-1), { type: 'setModel', model: 'opus', window: 200_000 });
  });

  /**
   * The typed-id footer, which is the gear's alone: this is the surface a model
   * the catalog has not got can be named on, and the draft's menu is picked
   * from rather than typed into.
   *
   * `idField` is a button rather than a menu item, so it is read off `.fbtn`.
   * It is the menu's last band rather than a row under a rule: the list scrolls
   * in `.fscroll` and the footer draws its own edge, so a `.fsep` above it
   * would be a line under a line.
   */
  it('keeps the way to a model the catalog has not got', (t) => {
    const p = openPanel(t);
    const fly = gearFly(p);
    const foot = fly.lastElementChild;
    assert.equal(foot?.className, 'ffoot');
    assert.equal(foot?.textContent, 'Enter an id…');
    assert.equal(fly.querySelector('.fsep'), null, 'the footer still follows a rule');
    fly.querySelector<HTMLElement>('.fbtn')?.click();
    const field = fly.querySelector<HTMLInputElement>('.ffoot input');
    assert.ok(field, 'the button became no field');
    field.value = 'claude-opus-4-5';
    field.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(p.posted.at(-1), { type: 'setModel', model: 'claude-opus-4-5' });
  });

  /** Nothing typed is nothing meant. There is no row here that clears the
   *  setting, so an empty field would be a way to do it by accident. */
  it('posts nothing for an empty field', (t) => {
    const p = openPanel(t);
    const fly = gearFly(p);
    fly.querySelector<HTMLElement>('.fbtn')?.click();
    const field = fly.querySelector<HTMLInputElement>('.ffoot input');
    field?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(
      p.posted.some((m) => m.type === 'setModel'),
      false
    );
  });
});

describe('the default effort row', () => {
  const settings = (p: Panel, over: Partial<StateMessage> = {}): HTMLElement => {
    p.push(stateMessage([groupView()], { models: EFFORT_MODELS, model: 'opus', ...over }));
    return openSettings(p);
  };

  const effortRow = (p: Panel, over: Partial<StateMessage> = {}): HTMLElement =>
    switchRow(settings(p, over), 'Default effort');

  it('resolves an unset value to the model’s native default', (t) => {
    const p = openPanel(t);
    const row = effortRow(p);
    assert.equal(row.querySelector('.val')?.firstChild?.textContent, 'medium');
    row.click();
    const fly = p.window.document.querySelector<HTMLElement>('.fmenu.fly:not([hidden])');
    assert.ok(fly, 'the row opened no effort menu');
    const items = [...fly.querySelectorAll<HTMLElement>('.mitem')];
    assert.deepEqual(
      items.map((item) => item.querySelector('.nm')?.textContent),
      CLAUDE_EFFORTS.map((effort) => effort.value)
    );
    const selected = items.find((item) => item.getAttribute('aria-checked') === 'true');
    assert.equal(selected?.querySelector('.nm')?.textContent, 'medium');
    assert.equal(selected?.querySelector('.sub')?.textContent, 'default');
  });

  it('paints the value and the default mark, and leaves the catalog sentence off the row', (t) => {
    const efforts = [
      { value: 'low', description: 'Fast responses with lighter reasoning' },
      { value: 'high', description: 'Greater reasoning depth for complex problems' }
    ];
    const p = openPanel(t);
    const row = effortRow(p, {
      models: [
        {
          value: 'gpt-6.1-sol',
          name: 'GPT-6.1-Sol',
          id: 'gpt-6.1-sol',
          brand: 'codex',
          efforts,
          defaultEffort: 'high'
        }
      ],
      model: 'gpt-6.1-sol'
    });
    row.click();
    const fly = p.window.document.querySelector<HTMLElement>('.fmenu.fly:not([hidden])');
    assert.ok(fly, 'the row opened no effort menu');
    assert.equal(fly.querySelector('.why'), null);
    assert.deepEqual(
      [...fly.querySelectorAll('.mitem')].map((item) => item.querySelector('.nm')?.textContent),
      ['low', 'high']
    );
    assert.equal(
      [...fly.querySelectorAll('.mitem')]
        .find((item) => item.querySelector('.nm')?.textContent === 'high')
        ?.querySelector('.sub')?.textContent,
      'default'
    );
  });

  it('draws no row when the default model states no effort values', (t) => {
    const menu = settings(openPanel(t), { model: 'haiku' });
    assert.equal(
      [...menu.querySelectorAll<HTMLElement>('.mrow')].some(
        (row) => row.querySelector('.t')?.firstChild?.textContent === 'Default effort'
      ),
      false
    );
  });

  /** Against the rows the panel ships rather than the fixture above: what the
   *  reader meets on a real row, where `catalog.test.ts` holds the rule. */
  it('reads the shipped default of a real row, rather than nothing', (t) => {
    const row = effortRow(openPanel(t), {
      models: [...catalogFor('claude')],
      model: 'claude-fable-5-1',
      contextWindow: 1_000_000
    });
    assert.equal(row.querySelector('.val')?.firstChild?.textContent, 'medium');
  });

  it('posts a picked native effort', (t) => {
    const p = openPanel(t);
    const row = effortRow(p);
    row.click();
    const high = [...p.window.document.querySelectorAll<HTMLElement>('.fmenu.fly .mitem')].find(
      (item) => item.querySelector('.nm')?.textContent === 'high'
    );
    assert.ok(high, 'the menu offers no high effort');
    high.click();
    assert.deepEqual(p.posted.at(-1), { type: 'setEffort', model: 'opus', effort: 'high' });
    assert.equal(row.querySelector('.val')?.firstChild?.textContent, 'high');
  });

  /** The bug this row shipped with: one stored effort, overwritten by every
   *  model pick, so switching away and back lost what the reader had set. */
  it('keeps each model’s own effort across a default model switch', (t) => {
    const models: ModelView[] = [
      {
        value: 'fable',
        name: 'Fable',
        id: 'claude-fable-5-1',
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
        window: 1_000_000,
        efforts: CLAUDE_EFFORTS,
        defaultEffort: 'high'
      }
    ];
    const p = openPanel(t);
    const menu = settings(p, { models, model: 'fable', efforts: { fable: 'low' } });
    const effort = (): string | null | undefined =>
      switchRow(menu, 'Default effort').querySelector('.val')?.firstChild?.textContent;
    const choose = (name: string): void => {
      switchRow(menu, 'Default model').click();
      const fly = p.window.document.querySelector<HTMLElement>('.fmenu.fly:not([hidden])');
      assert.ok(fly, 'the model row opened no flyout');
      pick(fly, name).click();
    };
    assert.equal(effort(), 'low');
    choose('Opus');
    assert.equal(effort(), 'high', 'a model with nothing saved did not open on its default');
    assert.deepEqual(p.posted.at(-1), {
      type: 'setModel',
      model: 'opus',
      window: 1_000_000
    });
    choose('Fable');
    assert.equal(effort(), 'low', 'switching back lost the effort saved for Fable');
  });
});

/**
 * The settings menu scrolls when the window is too short to hold it
 * (`.smenu:not(.accts)`, css/tickets.ts), and a flyout drilled out of one of its
 * rows is `position: fixed` — placed once, in viewport coordinates, and blind to
 * the scroll that moves the row out from under it. So the scroll shuts it.
 *
 * jsdom lays nothing out and scrolls nothing, so what these drive is the
 * listener rather than the overflow: a `scroll` event on the menu is what a
 * wheel over a real one produces, and the flyout's answer to it is the whole
 * behaviour. Whether the menu can scroll at all is a question only a real
 * engine answers, and the figure it answered with is in the rule's own comment.
 */
describe('a scroll of the settings menu', () => {
  it('shuts the flyout standing open over it', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { models: MODELS }));
    const menu = openSettings(p);
    switchRow(menu, 'Default model').click();
    assert.ok(
      p.window.document.querySelector('.fmenu.fly:not([hidden])'),
      'the model row opened no flyout'
    );
    menu.querySelector('#settings-model')?.dispatchEvent(new p.window.Event('scroll'));
    assert.ok(
      !p.window.document.querySelector('.fmenu.fly:not([hidden])'),
      'the flyout stayed open under a scroll'
    );
  });

  // The settings menu itself is what the reader is scrolling *in*, so it is the
  // one thing the scroll must not take with it. This is the case the top-of-
  // stack guard exists for: a flyout opened and shut four times leaves four
  // listeners waiting on the same node, and bare `closeTopMenu()` calls would
  // pop the settings menu on the fifth.
  it('leaves the menu it scrolled standing, however often the flyout was opened', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { models: MODELS }));
    const menu = openSettings(p);
    for (let i = 0; i < 4; i++) {
      const row = switchRow(menu, 'Default model');
      row.click();
      row.click();
    }
    switchRow(menu, 'Default model').click();
    menu.querySelector('#settings-model')?.dispatchEvent(new p.window.Event('scroll'));
    assert.ok(
      !p.window.document.querySelector('.fmenu.fly:not([hidden])'),
      'the flyout stayed open under a scroll'
    );
    assert.ok(!menu.hidden, 'the scroll closed the menu it was scrolling');
  });

  // And a scroll with nothing drilled open closes nothing at all: the listener
  // from the flyout's last open is still waiting on this menu, and the only
  // thing standing is the menu itself.
  it('closes nothing when no flyout is open', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { models: MODELS }));
    const menu = openSettings(p);
    switchRow(menu, 'Default model').click();
    switchRow(menu, 'Default model').click();
    menu.querySelector('#settings-model')?.dispatchEvent(new p.window.Event('scroll'));
    assert.ok(!menu.hidden, 'the scroll closed the menu it was scrolling');
  });
});
