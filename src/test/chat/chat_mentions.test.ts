/**
 * The composer's `@` menu across kinds: models, skills and this window's other
 * sessions. `chat_skills.test.ts` keeps the single-kind claims; this file is
 * what changes once a box offers more than one.
 *
 * Product shape: `docs/PRD/PRD_shipped_at_mention_menu.md`.
 */

import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import * as catalog from '../../core/catalog';
import type { ProseHook } from '../../webview/prose';
import {
  answerSend,
  cardView,
  composerKey,
  composerPills,
  composerSelection,
  composerShown,
  composerTarget,
  composerValue,
  enter,
  modelView,
  groupView,
  openPanel,
  proseOf,
  selectComposer,
  stateMessage,
  threadView,
  typeIn,
  type Panel
} from '../harness';

const opus1m = modelView();
const opus200k = modelView({ window: 200_000 });
const grok = modelView({
  value: 'grok-4.7',
  name: 'Grok 4.7',
  id: 'grok-4.7',
  brand: 'grok',
  brandLabel: 'Grok',
  window: 500_000,
  defaultEffort: 'low'
});
const haiku = modelView({
  value: 'claude-haiku-4-5',
  name: 'Haiku 4.5',
  id: 'claude-haiku-4-5',
  window: 200_000,
  efforts: [],
  legacy: true
});
const MODELS = [opus1m, opus200k, grok, haiku];

const OPUS = '(squadron-spawn --brand claude --model-id claude-opus-5-5 --context 1000000';

const ME = 101;
const PEER_REF = '@squadron[7][/h/.claude/projects/x/peer.jsonl]';

/** A board of this window's cards: the one being written in, a peer with a
 *  transcript, and one without — which a session pick cannot name. */
const cards = (): CardView[] => [
  cardView({ pid: ME, name: 'me', ref: '@squadron[101][/h/me.jsonl]' }),
  cardView({ pid: 7, name: 'Refine PRDs', ref: PEER_REF }),
  cardView({ pid: 8, name: 'No transcript yet' })
];

type Board = { skills?: string[]; sessions?: CardView[]; models?: ModelView[] };

function open(t: TestContext, board: Board = {}): Panel {
  const p = openPanel(t);
  p.push(
    stateMessage([groupView({ sessions: board.sessions ?? cards() })], {
      models: board.models ?? []
    })
  );
  select(p, ME, board);
  return p;
}

/** Select a card and answer with its thread, as the host does. */
function select(p: Panel, pid: number, board: Board = {}): void {
  const groups = [groupView({ sessions: board.sessions ?? cards() })];
  p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`)?.click();
  p.push(
    stateMessage(groups, {
      models: board.models ?? [],
      thread: threadView({ pid, skills: board.skills ?? ['dataviz', 'ponytail'] })
    })
  );
}

const menu = (p: Panel): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>('#mentionmenu:not([hidden])');

/** What the menu draws, in order: a heading as `# text`, a row as its name. */
const lines = (p: Panel): string[] =>
  [...(menu(p)?.querySelectorAll('.mnhead, .mnrow') ?? [])].map((node) =>
    node.classList.contains('mnhead')
      ? `# ${node.textContent ?? ''}`
      : (node.querySelector('.nm')?.textContent ?? node.textContent ?? '')
  );

const metas = (p: Panel): string[] =>
  [...(menu(p)?.querySelectorAll('.mnrow') ?? [])].map(
    (node) => node.querySelector('.meta')?.textContent ?? ''
  );

const highlit = (p: Panel): string[] =>
  [...(menu(p)?.querySelectorAll('.mnrow.on .nm') ?? [])].map((n) => n.textContent ?? '');

/**
 * Type into the box and let the edit rebuild the menu. Where `value` only adds
 * to what the box holds, with the caret at its end, only the added keys are
 * typed, so a chip already there stays one: retyping the box would make it
 * text and close the menu between the first key and the last.
 */
function type(p: Panel, value: string): void {
  const now = composerValue(p);
  if (now && value.startsWith(now) && composerSelection(p).start === now.length) {
    proseOf(p.window.document.getElementById('input')).type(value.slice(now.length));
    return;
  }
  typeIn(p, value, value.length);
}

function key(p: Panel, k: string): KeyboardEvent {
  return composerKey(p, k);
}

/** jsdom does not perform a browser's text deletion after a Backspace key. */
function backspace(p: Panel): void {
  const box = proseOf(p.window.document.getElementById('input')) as ProseHook;
  const caret = box.selection.caret();
  assert.ok(caret !== null);
  box.selection.replace(caret - 1, caret, '');
}

function press(p: Panel, name: string): void {
  const row = [...(menu(p)?.querySelectorAll<HTMLElement>('.mnrow') ?? [])].find(
    (r) => r.querySelector('.nm')?.textContent === name
  );
  assert.ok(row, `no row ${name} in ${lines(p).join(', ')}`);
  row.click();
}

const pills = (p: Panel): string[] =>
  composerPills(p).map((n) => `${n.className}:${n.textContent ?? ''}`);

const sent = (p: Panel): string => (p.posted.at(-1) as { text: string }).text;

describe('@ across kinds', () => {
  it('finds older Codex models by family name and sends their original ids', (t) => {
    const models = catalog.catalogFor('codex').map((row) => modelView(row));
    const p = open(t, { models });
    type(p, '@sol');
    assert.deepEqual(lines(p), ['# Models', 'Sol 6.1', 'Sol 6', 'Sol 5.6']);
    press(p, 'Sol 5.6');
    assert.equal(composerShown(p), '@Sol 5.6 ');
    press(p, 'default');
    enter(p);
    assert.equal(
      sent(p),
      'a peer on Sol 5.6 (squadron-spawn --brand codex --model-id gpt-5.6-sol --context 258400)'
    );
  });

  it('offers the kinds with their counts on a bare @', (t) => {
    const p = open(t);
    type(p, '@');
    assert.deepEqual(lines(p), ['Skills', 'Sessions']);
    // This box's own card and the card with nothing to reference are not
    // counted.
    assert.deepEqual(metas(p), ['2', '1']);
  });

  it('narrows to a kind by writing its scope word, and starts that list at the top', (t) => {
    const p = open(t);
    type(p, '@');
    key(p, 'ArrowDown');
    assert.deepEqual(highlit(p), ['Sessions']);
    key(p, 'Enter');
    assert.equal(composerValue(p), '@session:');
    assert.deepEqual(lines(p), ['# Sessions', 'Refine PRDs']);
    assert.deepEqual(highlit(p), ['Refine PRDs'], 'the new list kept the old list’s row');
  });

  it('widens again when Backspace takes the colon', (t) => {
    const p = open(t);
    type(p, '@session:');
    type(p, '@session');
    assert.deepEqual(lines(p), ['Sessions']);
  });

  it('narrows the same way when the scope word is typed by hand', (t) => {
    const p = open(t);
    type(p, '@skill:');
    assert.deepEqual(lines(p), ['# Skills', 'dataviz', 'ponytail']);
    type(p, '@skill:pon');
    assert.deepEqual(lines(p), ['# Skills', 'ponytail']);
  });

  it('searches every kind at once, grouped', (t) => {
    const p = open(t, { skills: ['refine-prd', 'ponytail'] });
    type(p, '@refine');
    assert.deepEqual(lines(p), ['# Skills', 'refine-prd', '# Sessions', 'Refine PRDs']);
  });

  it('sends a picked session as its reference, under a session pill', (t) => {
    const p = open(t);
    type(p, '@session:');
    press(p, 'Refine PRDs');
    assert.equal(composerShown(p), '@Refine PRDs ');
    assert.deepEqual(pills(p), ['pchip session:@Refine PRDs']);
    type(p, `ask ${PEER_REF} about it`);
    enter(p);
    assert.equal(sent(p), `ask ${PEER_REF} about it`);
  });

  it('keeps a skill one step: @pon and Enter, then the same phrase on send', (t) => {
    const p = open(t);
    type(p, '@pon');
    assert.deepEqual(highlit(p), ['ponytail']);
    key(p, 'Enter');
    assert.equal(composerShown(p), '@ponytail ');
    assert.deepEqual(pills(p), ['pchip skill:@ponytail']);
    enter(p);
    assert.equal(sent(p), 'the ponytail skill');
  });

  it('remembers a pick under Recent on the next bare @', (t) => {
    const p = open(t);
    type(p, '@pon');
    key(p, 'Enter');
    type(p, '@ponytail @');
    assert.deepEqual(lines(p), ['Skills', 'Sessions', '# Recent', 'ponytail']);
  });

  it('opens a composer with skills alone straight onto them', (t) => {
    const p = open(t, { sessions: [cardView({ pid: ME, name: 'me' })] });
    type(p, '@');
    assert.deepEqual(lines(p), ['dataviz', 'ponytail']);
  });

  it('says that not every skill loads only under skill rows', (t) => {
    const p = open(t);
    type(p, '@session:');
    assert.equal(menu(p)?.querySelector('.mnfoot'), null);
    type(p, '@skill:');
    assert.ok(menu(p)?.querySelector('.mnfoot'));
  });
});

describe('@ a model', () => {
  /** A scope or search typed after what is there, then a model row: the pill
   *  lands and its efforts are offered. */
  function pickModel(p: Panel, name: string, scope = '@model:'): void {
    type(p, composerValue(p) + scope);
    press(p, name);
  }

  it('lands the pill at the default, then offers that model’s efforts', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    assert.equal(composerShown(p), '@Opus 5.5 1M ');
    assert.deepEqual(lines(p), [
      '# Models › Opus 5.5 1M › effort',
      'default',
      'low',
      'medium',
      'high'
    ]);
    assert.deepEqual(highlit(p), ['default']);
    press(p, 'high');
    assert.equal(composerShown(p), '@Opus 5.5 1M · high ');
    assert.equal(menu(p), null);
    enter(p);
    assert.equal(sent(p), `a peer on Opus 5.5 1M at high effort ${OPUS} --effort high)`);
  });

  it('lists current models under Models, and older ones once searched', (t) => {
    const p = open(t, { models: MODELS });
    type(p, '@');
    assert.deepEqual(lines(p).slice(0, 3), ['Models', 'Skills', 'Sessions']);
    type(p, '@model:');
    assert.deepEqual(lines(p), ['# Models', 'Opus 5.5 1M', 'Opus 5.5 200k', 'Grok 4.7']);
    type(p, '@hai');
    assert.deepEqual(lines(p), ['# Models', 'Haiku 4.5']);
  });

  it('releases the default pill’s token when an effort replaces it', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    press(p, 'high');
    // The old label, typed by hand, is prose: nothing stands behind it now.
    type(p, `${composerValue(p)}then @Opus 5.5 1M`);
    enter(p);
    assert.equal(
      sent(p),
      `a peer on Opus 5.5 1M at high effort ${OPUS} --effort high) then @Opus 5.5 1M`
    );
  });

  it('takes the default row as the same pill, with no #2', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    press(p, 'default');
    assert.equal(composerShown(p), '@Opus 5.5 1M ');
    assert.equal(menu(p), null);
    enter(p);
    assert.equal(sent(p), `a peer on Opus 5.5 1M ${OPUS})`);
  });

  for (const query of ['hi', 'Hi']) {
    it(`filters an effort as ${query} is typed and cuts the query on Enter`, (t) => {
      const p = open(t, { models: MODELS });
      type(p, 'ask ');
      pickModel(p, 'Opus 5.5 1M');
      const before = composerValue(p);
      type(p, `${before}${query.slice(0, 1)}`);
      assert.deepEqual(lines(p), ['# Models › Opus 5.5 1M › effort', 'high']);
      type(p, `${before}${query}`);
      assert.deepEqual(highlit(p), ['high']);
      key(p, 'Enter');
      assert.equal(composerShown(p), 'ask @Opus 5.5 1M · high ');
      assert.equal(menu(p), null);
      enter(p);
      assert.equal(sent(p), `ask a peer on Opus 5.5 1M at high effort ${OPUS} --effort high)`);
    });
  }

  it('ends the effort step when ArrowLeft moves the caret inside its query', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    type(p, `${composerValue(p)}hi`);
    assert.deepEqual(highlit(p), ['high']);
    const box = proseOf(p.window.document.getElementById('input')) as ProseHook;
    const caret = box.selection.caret();
    assert.ok(caret !== null);
    box.select(caret - 1);
    assert.equal(menu(p), null);
    assert.equal(composerShown(p), '@Opus 5.5 1M hi');
    enter(p);
    assert.equal(sent(p), `a peer on Opus 5.5 1M ${OPUS}) hi`);
  });

  it('clamps the effort highlight while filtering and restores rows on Backspace', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    key(p, 'ArrowUp');
    assert.deepEqual(highlit(p), ['high']);
    type(p, `${composerValue(p)}h`);
    assert.deepEqual(highlit(p), ['high']);
    backspace(p);
    assert.deepEqual(lines(p), [
      '# Models › Opus 5.5 1M › effort',
      'default',
      'low',
      'medium',
      'high'
    ]);
    assert.deepEqual(highlit(p), ['default']);
    type(p, `${composerValue(p)}def`);
    assert.deepEqual(lines(p), ['# Models › Opus 5.5 1M › effort', 'default']);
    press(p, 'default');
    assert.equal(composerShown(p), '@Opus 5.5 1M ');
    enter(p);
    assert.equal(sent(p), `a peer on Opus 5.5 1M ${OPUS})`);
  });

  for (const suffix of [' ', '-', '1', 'x']) {
    it(`ends a filtered effort on ${JSON.stringify(suffix)}, keeping the typed text`, (t) => {
      const p = open(t, { models: MODELS });
      pickModel(p, 'Opus 5.5 1M');
      type(p, `${composerValue(p)}hi`);
      assert.deepEqual(highlit(p), ['high']);
      type(p, `${composerValue(p)}${suffix}`);
      assert.equal(menu(p), null);
      assert.equal(composerShown(p), `@Opus 5.5 1M hi${suffix}`);
      backspace(p);
      assert.equal(menu(p), null, 'deleting the suffix revived the effort step');
      assert.equal(composerShown(p), '@Opus 5.5 1M hi');
      enter(p);
      assert.equal(sent(p), `a peer on Opus 5.5 1M ${OPUS}) hi`);
    });
  }

  for (const gesture of ['Escape', 'outside press', 'session change']) {
    it(`keeps a filtered effort's text and default on ${gesture}`, (t) => {
      const p = open(t, { models: MODELS });
      pickModel(p, 'Opus 5.5 1M');
      type(p, `${composerValue(p)}hi`);
      assert.deepEqual(highlit(p), ['high']);
      if (gesture === 'Escape') key(p, 'Escape');
      else if (gesture === 'outside press') {
        p.window.document.body.dispatchEvent(new p.window.Event('pointerdown', { bubbles: true }));
      } else {
        select(p, 7, { models: MODELS });
        select(p, ME, { models: MODELS });
      }
      assert.equal(menu(p), null);
      assert.equal(composerShown(p), '@Opus 5.5 1M hi');
      enter(p);
      assert.equal(sent(p), `a peer on Opus 5.5 1M ${OPUS}) hi`);
    });
  }

  const endings: [string, (p: Panel) => void][] = [
    ['a letter no effort starts with', (p) => type(p, `${composerValue(p)}x`)],
    ['a paste of a reference', (p) => type(p, `${composerValue(p)}${PEER_REF}`)],
    [
      'a composition starting',
      (p) => composerTarget(p).dispatchEvent(new p.window.CompositionEvent('compositionstart'))
    ],
    ['Escape', (p) => void key(p, 'Escape')],
    [
      'a caret moved away and back',
      (p) => {
        selectComposer(p, 0);
        composerTarget(p).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
      }
    ],
    [
      'a selection across the pill',
      (p) => {
        selectComposer(p, 0, composerValue(p).length);
        composerTarget(p).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
      }
    ],
    [
      'another session selected and this one again',
      (p) => {
        select(p, 7, { models: MODELS });
        select(p, ME, { models: MODELS });
      }
    ]
  ];
  for (const [gesture, act] of endings) {
    it(`ends the effort step for good on ${gesture}, keeping the default`, (t) => {
      const p = open(t, { models: MODELS });
      pickModel(p, 'Opus 5.5 1M');
      assert.ok(menu(p)?.querySelector('.mncrumb'), 'no effort step to end');
      act(p);
      assert.equal(menu(p)?.querySelector('.mncrumb') ?? null, null, `${gesture} left it up`);
      // Back where the pill ends: the step does not revive.
      const end = composerValue(p).indexOf(')') + 1;
      selectComposer(p, end);
      composerTarget(p).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
      assert.equal(menu(p)?.querySelector('.mncrumb') ?? null, null, 'the effort step revived');
    });
  }

  it('does not revive the effort step after the caret visits another run', (t) => {
    // The one departure that keeps the menu open: the caret lands in another
    // `@` run, so nothing closes the menu that would also forget the pill.
    const p = open(t, { models: MODELS });
    type(p, '@pon ');
    pickModel(p, 'Opus 5.5 1M');
    selectComposer(p, 4);
    composerTarget(p).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(highlit(p), ['ponytail']);
    selectComposer(p, composerValue(p).length);
    composerTarget(p).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.equal(menu(p)?.querySelector('.mncrumb') ?? null, null, 'the effort step revived');
  });

  it('offers only the efforts the catalog still lists when a push lands mid-step', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    const stale = [...(menu(p)?.querySelectorAll<HTMLElement>('.mnrow') ?? [])].find(
      (r) => r.querySelector('.nm')?.textContent === 'high'
    );
    const narrowed = [{ ...opus1m, efforts: [{ value: 'low' }] }, opus200k, grok, haiku];
    p.push(
      stateMessage([groupView({ sessions: cards() })], {
        models: narrowed,
        thread: threadView({ pid: ME, skills: ['dataviz', 'ponytail'] })
      })
    );
    stale?.click();
    assert.equal(composerShown(p), '@Opus 5.5 1M ', 'a removed effort was written');
    assert.deepEqual(lines(p), ['# Models › Opus 5.5 1M › effort', 'default', 'low']);
  });

  it('ends the effort step when a push takes its model away', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    const stale = [...(menu(p)?.querySelectorAll<HTMLElement>('.mnrow') ?? [])].find(
      (r) => r.querySelector('.nm')?.textContent === 'high'
    );
    p.push(
      stateMessage([groupView({ sessions: cards() })], {
        models: [grok],
        thread: threadView({ pid: ME, skills: ['dataviz', 'ponytail'] })
      })
    );
    stale?.click();
    assert.equal(composerShown(p), '@Opus 5.5 1M ', 'a removed model was written');
    assert.equal(menu(p)?.querySelector('.mncrumb') ?? null, null);
  });

  it('writes a Recent model as the catalog names it at the moment of the pick', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Grok 4.7', '@grok');
    key(p, 'Escape');
    type(p, `${composerValue(p)}@`);
    const stale = [...(menu(p)?.querySelectorAll<HTMLElement>('.mnrow') ?? [])].find(
      (r) => r.querySelector('.nm')?.textContent === 'Grok 4.7'
    );
    assert.ok(stale, 'no Recent row for the model');
    const renamed = [opus1m, opus200k, { ...grok, name: 'Grok 4.7 Fast' }, haiku];
    p.push(
      stateMessage([groupView({ sessions: cards() })], {
        models: renamed,
        thread: threadView({ pid: ME, skills: ['dataviz', 'ponytail'] })
      })
    );
    stale.click();
    assert.equal(composerShown(p), '@Grok 4.7 @Grok 4.7 Fast ');
  });

  it('replaces only the copy just picked when two pills name one model', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    pickModel(p, 'Opus 5.5 1M');
    assert.equal(composerShown(p), '@Opus 5.5 1M @Opus 5.5 1M ');
    type(p, `${composerValue(p)}hi`);
    key(p, 'Enter');
    assert.equal(composerShown(p), '@Opus 5.5 1M @Opus 5.5 1M · high ');
    enter(p);
    assert.equal(
      sent(p),
      `a peer on Opus 5.5 1M ${OPUS}) a peer on Opus 5.5 1M at high effort ${OPUS} --effort high)`
    );
  });

  it('leaves a deleted pill’s label as prose when it is typed again', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    key(p, 'Escape');
    selectComposer(p, composerValue(p).trimEnd().length);
    key(p, 'Backspace');
    assert.equal(composerValue(p).trim(), '', 'Backspace left part of a model pill');
    type(p, '@Opus 5.5 1M');
    enter(p);
    assert.equal(sent(p), '@Opus 5.5 1M');
  });

  it('sends a model with no efforts straight away, then the reader’s own words', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Haiku 4.5', '@model:hai');
    assert.equal(menu(p), null, 'a model with no efforts offered an effort step');
    type(p, `${composerValue(p)}now`);
    enter(p);
    assert.equal(
      sent(p),
      'a peer on Haiku 4.5 (squadron-spawn --brand claude --model-id claude-haiku-4-5 --context 200000) now'
    );
  });

  it('paints a model pill as a model, and sends the words typed after an effort', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Grok 4.7', '@grok');
    press(p, 'medium');
    assert.deepEqual(pills(p), ['pchip model:@Grok 4.7 · medium']);
    type(p, `${composerValue(p)}go`);
    enter(p);
    assert.equal(
      sent(p),
      'a peer on Grok 4.7 at medium effort (squadron-spawn --brand grok --model-id grok-4.7 --context 500000 --effort medium) go'
    );
  });

  it('paints a model pill in the model control’s grey, never an accent', (t) => {
    // jsdom resolves the cascade but not var(): the declaration that won is
    // what is checked. Every accent already names a kind of pill.
    const p = open(t, { models: MODELS });
    pickModel(p, 'Grok 4.7', '@grok');
    const pill = composerPills(p, 'model')[0];
    assert.ok(pill, 'no model pill painted');
    const style = p.window.getComputedStyle(pill);
    // `background` and `box-shadow`: jsdom cannot compute a color-mix() into
    // `background-color`, and keeps both declarations as written.
    for (const value of [style.getPropertyValue('background'), style.boxShadow]) {
      assert.match(value, /var\(--av-fg-3\)/);
      assert.doesNotMatch(value, /--av-(orange|yellow|green|purple|link)/);
    }
  });

  it('hands two model pills back working after a refused send, with no effort step', (t) => {
    const p = open(t, { models: MODELS });
    pickModel(p, 'Opus 5.5 1M');
    press(p, 'high');
    pickModel(p, 'Grok 4.7');
    key(p, 'Escape');
    const typed = composerValue(p);
    enter(p);
    answerSend(p, { ok: false, reason: 'nope' });
    assert.equal(composerValue(p), typed, 'the draft did not come back');
    assert.equal(menu(p), null);
    select(p, 7, { models: MODELS });
    select(p, ME, { models: MODELS });
    assert.equal(composerValue(p), typed, 'switching away and back lost the draft');
    assert.equal(menu(p), null);
    enter(p);
    assert.equal(
      sent(p),
      `a peer on Opus 5.5 1M at high effort ${OPUS} --effort high) ` +
        'a peer on Grok 4.7 (squadron-spawn --brand grok --model-id grok-4.7 --context 500000)'
    );
  });
});
