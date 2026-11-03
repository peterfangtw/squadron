import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  assertedMessageBody,
  cardView,
  enter,
  groupView,
  openPanel,
  openThread,
  stateMessage,
  unreachableThread,
  threadView,
  Panel,
  importComposer
} from '../harness';
import { catalogFor } from '../../core/catalog';

/**
 * The model on the hint row — `docs/mockups/composer-shell.html` §3, where it is
 * the third of the reference's `+ ⫽ Agent Models ⚙` and the only one that was
 * drawn ahead of the feature (its Q9). What made it real is `set_model` on the
 * pipe, already shipped on the card (`TASK_done_model_mid_session.md`).
 *
 * The card and this are one control drawn twice, so the menu body is shared and
 * these scenarios say what is *this* surface's: where it is, what it is called,
 * and that the pick carries the thread's pid rather than the board's selection.
 */

describe('the composer’s model pill', () => {
  /** As the host sends them: one entry per (model × window), every one stating
   *  its `window`. Both models run in one window here — the two-pill row has
   *  its own scenarios in `model_picker_menu.test.ts`, and what this file is about
   *  is the second surface the same builder draws on. */
  const MODELS: ModelView[] = [
    { value: 'opus', name: 'Opus 5', id: 'claude-opus-5[1m]', brand: 'claude', window: 1_000_000 },
    {
      value: 'haiku',
      name: 'Haiku 4.5',
      id: 'claude-haiku-4-5-20251001',
      brand: 'claude',
      window: 200_000
    }
  ];

  const pill = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#hintrow .fpill.model');

  /**
   * What the menu ticks, read where the tick now lives.
   *
   * `aria-checked` moved off the row with shape B: a row is
   * `role="presentation"` and answers `null`, and the window pill is the
   * `menuitemradio`. Read through one helper so the three cases below cannot
   * drift back onto `.mitem` one at a time.
   */
  const checked = (menu: HTMLElement): (string | null)[] =>
    [...menu.querySelectorAll<HTMLElement>('.wp')].map((w) => w.getAttribute('aria-checked'));

  /** The pill of a named model. Every fixture row here runs in one window, so
   *  the row's only `.wp` is unambiguous. */
  const wp = (menu: HTMLElement, name: string): HTMLElement => {
    const row = [...menu.querySelectorAll<HTMLElement>('.mitem')].find(
      (r) => r.querySelector('.nm')?.textContent === name
    );
    assert.ok(row, `no ${name} row`);
    const own = row.querySelector<HTMLElement>('.wp');
    assert.ok(own, `the ${name} row draws no window to press`);
    return own;
  };

  const openModels = (p: Panel): HTMLElement => {
    const trigger = pill(p);
    assert.ok(trigger, 'no model pill on the hint row');
    trigger.click();
    const menu = trigger.parentElement?.querySelector<HTMLElement>('.fmenu');
    assert.ok(menu && !menu.hidden, 'the model pill opened no menu');
    return menu;
  };

  /**
   * The second surface the model rows are drawn on, and the one the gear's own
   * scenarios cannot reach: `modelMenuBody` here, `modelRow` there, one
   * `modelItems` under both. A brand run headed on one and not the other is the
   * drift that shared builder exists to prevent, so it is claimed on this side
   * too rather than assumed from the other.
   *
   * The thread states no models of its own, so this falls through to
   * `ui.state.models` — which is the board's whole list, brands and all.
   */
  it('runs the rows together by brand here too, headed the same way', (t) => {
    const p = openThread(t, threadView({ model: 'opus' }), {
      models: [
        ...MODELS.map((m) => ({ ...m, brandLabel: 'Claude' })),
        {
          value: 'grok-4.6',
          name: 'Grok 4.6',
          id: 'grok-4.6',
          brand: 'grok',
          brandLabel: 'Grok',
          window: 500_000
        }
      ]
    });
    const menu = openModels(p);
    assert.deepEqual(
      [...menu.querySelectorAll<HTMLElement>('[role="group"]')].map((run) =>
        run.getAttribute('aria-label')
      ),
      ['Claude', 'Grok']
    );
    // The rows a brand's run holds are that brand's, and nobody else's.
    const claude = menu.querySelector<HTMLElement>('[role="group"]');
    assert.deepEqual(
      [...(claude?.querySelectorAll('.nm') ?? [])].map((n) => n.textContent),
      ['Opus 5', 'Haiku 4.5']
    );
  });

  /** One brand is the ordinary case for this surface — `modelsForSession`
   *  filters the thread's own list to the session's brand — and a heading over
   *  the only run in a menu is a word that tells a reader nothing. */
  it('heads nothing when one brand is all the session can run', (t) => {
    const p = openThread(t, threadView({ model: 'opus' }), { models: MODELS });
    const menu = openModels(p);
    assert.equal(menu.querySelector('.mhead'), null, 'a single-brand menu was headed');
    assert.equal(menu.querySelector('[role="group"]'), null, 'a lone run was wrapped anyway');
  });

  it('says which model the next turn runs on, by name', (t) => {
    const p = openThread(t, threadView({ model: 'opus' }), { models: MODELS });
    const trigger = pill(p);
    assert.ok(trigger, 'no model pill');
    // The CLI's own name for it, not the alias the wire takes: the mock's pill
    // says "Opus 5", and the value is what the menu posts.
    assert.equal(trigger.querySelector('.nm')?.textContent, 'Opus 5');
    assert.equal(trigger.tagName, 'BUTTON');
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  });

  /**
   * The reported bug: a session started from the panel `+` has run no turn, so
   * nothing on the pipe has named a model — and the pill said nothing while the
   * session was on the one the setting passed as `--model`.
   */
  it('names the model a session was started on, before it has run a turn', (t) => {
    const p = openThread(t, threadView({ model: undefined, modelPick: 'opus' }), {
      models: MODELS
    });
    assert.equal(pill(p)?.querySelector('.nm')?.textContent, 'Opus 5');
    assert.deepEqual(checked(openModels(p)), ['true', 'false']);
  });

  /**
   * And the half that made fixing only the first one worse: `init` resolves the
   * alias to an id no row's `value` carries, so the pill went on to state
   * `claude-opus-5[1m]` verbatim the moment the session did run a turn.
   */
  it('keeps naming it once the CLI answers in its own spelling', (t) => {
    const p = openThread(t, threadView({ model: 'claude-opus-5[1m]', modelPick: 'opus' }), {
      models: MODELS
    });
    assert.equal(pill(p)?.querySelector('.nm')?.textContent, 'Opus 5');
  });

  /**
   * The reported bug's second half: a draft's pill read `Opus 5.5 (1M)`, and
   * the same session's pill dropped the window the moment it was sent — so a
   * model offered at two windows no longer said which one the turn runs in.
   */
  it('names the window of a model offered at two, as the draft pill does', (t) => {
    const TWO: ModelView[] = [
      {
        value: 'claude-opus-5-5',
        name: 'Opus 5.5',
        id: 'claude-opus-5-5[1m]',
        brand: 'claude',
        window: 1_000_000
      },
      {
        value: 'claude-opus-5-5',
        name: 'Opus 5.5',
        id: 'claude-opus-5-5',
        brand: 'claude',
        window: 200_000
      }
    ];
    const at = (contextSize: number) =>
      openThread(t, threadView({ modelPick: 'claude-opus-5-5', contextSize }), { models: TWO });
    assert.equal(pill(at(1_000_000))?.querySelector('.nm')?.textContent, 'Opus 5.5 (1M)');
    assert.equal(pill(at(200_000))?.querySelector('.nm')?.textContent, 'Opus 5.5 (200k)');
  });

  it('follows the session when it is moved somewhere nobody here picked', (t) => {
    // `/model haiku` typed into the session itself: the start's alias is stale
    // and the reading is the only thing to believe.
    const p = openThread(t, threadView({ model: 'claude-haiku-4-5-20251001', modelPick: 'opus' }), {
      models: MODELS
    });
    assert.equal(pill(p)?.querySelector('.nm')?.textContent, 'Haiku 4.5');
  });

  it('falls back to what the session stated when the list does not name it', (t) => {
    const p = openThread(t, threadView({ model: 'sonnet' }), { models: MODELS });
    assert.equal(pill(p)?.querySelector('.nm')?.textContent, 'sonnet');
  });

  it('lists what the CLI answered, ticking the one in force', (t) => {
    const p = openThread(t, threadView({ model: 'opus' }), { models: MODELS });
    const menu = openModels(p);
    assert.deepEqual(
      [...menu.querySelectorAll<HTMLElement>('.mitem')].map(
        (r) => r.querySelector('.nm')?.textContent
      ),
      ['Opus 5', 'Haiku 4.5']
    );
    assert.deepEqual(checked(menu), ['true', 'false']);
  });

  it('lists only the models the thread named, not the gear’s union', (t) => {
    const p = openThread(
      t,
      threadView({
        model: 'opus',
        models: [
          { value: 'opus', name: 'Opus 5', id: 'claude-opus-5', brand: 'claude', window: 1_000_000 }
        ]
      }),
      {
        models: [
          ...MODELS,
          { value: 'grok-4.6', name: 'Grok 4.6', id: 'grok-4.6', brand: 'grok', window: 500_000 }
        ]
      }
    );
    const rows = [...openModels(p).querySelectorAll<HTMLElement>('.mitem')];
    assert.deepEqual(
      rows.map((r) => r.querySelector('.nm')?.textContent),
      ['Opus 5']
    );
  });

  it('holds the pick until a message sends it, and shuts the menu', (t) => {
    const p = openThread(t, threadView({ pid: 404, model: 'opus', models: MODELS }), {
      models: MODELS
    });
    const menu = openModels(p);
    const before = p.posted.length;
    wp(menu, 'Haiku 4.5').click();
    assert.equal(p.posted.length, before);
    assert.ok(menu.hidden, 'the menu stayed open over its own pick');
    importComposer(p, 'use the cheap one');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 404,
      text: 'use the cheap one',
      target: { model: 'haiku', window: 200_000 }
    });
  });

  /**
   * The pick, before any turn has run on it.
   *
   * `set_model` lands on the next turn, so the session goes on reading as the
   * model it last ran on — and the host's refresh cannot make that early. A
   * pill that waited for it said the model the reader had just switched away
   * from until they sent a message, which reads as the switch not having
   * happened. The card is still the reading (`board.test.ts`); this is what the
   * next turn will run on, and a pick is that answer immediately.
   */
  describe('a pick that no turn has run on yet', () => {
    const STARTED_AT = 5_000;
    const groups = (pids: number[]): GroupView[] => [
      groupView({ sessions: pids.map((pid) => cardView({ pid, startedAt: STARTED_AT })) })
    ];

    /** Another push of the same state, the way the host sends one every 3s. */
    const repush = (p: Panel, thread: ThreadView): void => {
      p.push(stateMessage(groups([thread.pid]), { thread, models: MODELS }));
    };

    const pickHaiku = (p: Panel): void => wp(openModels(p), 'Haiku 4.5').click();

    const label = (p: Panel): string | null | undefined =>
      pill(p)?.querySelector('.nm')?.textContent;

    it('is on the pill at once, and survives the pushes that follow', (t) => {
      const p = openThread(t, threadView({ pid: 404, startedAt: STARTED_AT, model: 'opus' }), {
        models: MODELS
      });
      pickHaiku(p);
      assert.equal(label(p), 'Haiku 4.5', 'the pill waited for a turn to agree with it');
      // The session still says what it last ran on, and will until a turn runs.
      repush(p, threadView({ pid: 404, startedAt: STARTED_AT, model: 'opus' }));
      assert.equal(label(p), 'Haiku 4.5', 'a push put the old model back');
      assert.equal(pill(p)?.dataset.tip, 'Model for the next message');
    });

    it('goes out with one message and stays on the pill after it', (t) => {
      const p = openThread(t, threadView({ pid: 404, startedAt: STARTED_AT, model: 'opus' }), {
        models: MODELS
      });
      pickHaiku(p);
      importComposer(p, 'use the cheap one');
      enter(p);
      importComposer(p, 'and again');
      enter(p);
      assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
        type: 'send',
        pid: 404,
        text: 'and again'
      });
      assert.equal(label(p), 'Haiku 4.5');
    });

    it('is what the menu ticks when it is opened again', (t) => {
      const p = openThread(t, threadView({ pid: 404, startedAt: STARTED_AT, model: 'opus' }), {
        models: MODELS
      });
      pickHaiku(p);
      assert.deepEqual(checked(openModels(p)), ['false', 'true']);
    });

    it('keeps the held pick when the session reading moves', (t) => {
      const p = openThread(t, threadView({ pid: 404, startedAt: STARTED_AT, model: 'opus' }), {
        models: MODELS
      });
      pickHaiku(p);
      repush(p, threadView({ pid: 404, startedAt: STARTED_AT, model: 'sonnet' }));
      assert.equal(label(p), 'Haiku 4.5');
    });

    /** The pick is this reader's last action, not a fact about the session:
     *  leaving the chat forgets it, and coming back states the reading. */
    it('is forgotten when the chat is left and opened again', (t) => {
      const p = openPanel(t);
      const both = groups([404, 405]);
      p.push(stateMessage(both, { models: MODELS }));
      const card = (at: number): HTMLElement | undefined =>
        p.window.document.querySelectorAll<HTMLElement>('.card')[at];
      card(0)?.click();
      p.push(
        stateMessage(both, {
          thread: threadView({ pid: 404, startedAt: STARTED_AT, model: 'opus' }),
          models: MODELS
        })
      );
      pickHaiku(p);
      card(1)?.click();
      card(0)?.click();
      p.push(
        stateMessage(both, {
          thread: threadView({ pid: 404, startedAt: STARTED_AT, model: 'opus' }),
          models: MODELS
        })
      );
      assert.equal(label(p), 'Opus 5');
    });
  });

  /** The card's menu already says this; the pill opens the same body, and the
   *  figure is the thread's own context rather than a constant. */
  it('says what a switch costs before it is bought', (t) => {
    const p = openThread(t, threadView({ model: 'opus', contextPct: 50, contextSize: 90_000 }), {
      models: MODELS
    });
    assert.match(openModels(p).querySelector('.mwarn')?.textContent ?? '', /45k/);
  });

  /**
   * A window this session's own launch line cannot reach.
   *
   * `--settings` is composed once, at spawn, so whether a session runs under
   * `CLAUDE_CODE_DISABLE_1M_CONTEXT` is fixed for its life — and the menu used
   * to offer every window regardless. Pressing `200k` on a session started at
   * 1M relabelled the pill and left the session running at a million, with
   * nothing anywhere saying so. The host stamps `fixed` and these are what the
   * panel does with it.
   *
   * Two pills per row here, unlike `MODELS` above: this is the shape the rule
   * is about, one of a row's windows reachable and the other not.
   */
  describe('a window the session cannot be moved to', () => {
    const PAIR: ModelView[] = [
      {
        value: 'opus',
        name: 'Opus 5',
        id: 'claude-opus-5',
        brand: 'claude',
        window: 1_000_000,
        fixed: true
      },
      { value: 'opus', name: 'Opus 5', id: 'claude-opus-5', brand: 'claude', window: 200_000 },
      {
        value: 'haiku',
        name: 'Haiku 4.5',
        id: 'claude-haiku-4-5',
        brand: 'claude',
        window: 200_000
      }
    ];

    /** Every pill of a named row, in the order the catalog authored them. */
    const wps = (menu: HTMLElement, name: string): HTMLElement[] => {
      const row = [...menu.querySelectorAll<HTMLElement>('.mitem')].find(
        (r) => r.querySelector('.nm')?.textContent === name
      );
      assert.ok(row, `no ${name} row`);
      return [...row.querySelectorAll<HTMLElement>('.wp')];
    };

    const opened = (t: TestContext, models: ModelView[] = PAIR) => {
      const p = openThread(t, threadView({ pid: 404, model: 'opus', models }), { models: [] });
      return { p, menu: openModels(p) };
    };

    it('draws it dimmed and says so to a reader who cannot see dim', (t) => {
      const [wide, narrow] = wps(opened(t).menu, 'Opus 5');
      assert.ok(wide?.classList.contains('off'), 'the fixed pill is not dimmed');
      assert.equal(wide?.getAttribute('aria-disabled'), 'true');
      assert.ok(!narrow?.classList.contains('off'), 'the reachable pill was dimmed too');
      assert.equal(narrow?.getAttribute('aria-disabled'), null);
      // Dim with nothing to explain it is a mark a reader cannot read. That the
      // tip *shows* is a dev-host check; that it is on the node is this one.
      assert.match(wide?.dataset.tip ?? '', /new session/);
      assert.equal(narrow?.dataset.tip, undefined);
    });

    it('posts nothing when it is pressed', (t) => {
      const { p, menu } = opened(t);
      const before = p.posted.length;
      wps(menu, 'Opus 5')[0]?.click();
      assert.equal(p.posted.length, before);
      assert.ok(!menu.hidden, 'a press that does nothing still shut the menu');
    });

    /** The row is never dropped — only the windows this line cannot carry are
     *  dimmed. Dropping it would take a model out of the menu over a window,
     *  which is the failure `setModel`'s own rule was rewritten for. */
    it('leaves the row pickable through the window that does work', (t) => {
      const { p, menu } = opened(t);
      const before = p.posted.length;
      wps(menu, 'Opus 5')[1]?.click();
      assert.equal(p.posted.length, before);
    });

    it('still draws a row whose every window is fixed', (t) => {
      const all = PAIR.map((m) => (m.value === 'opus' ? { ...m, fixed: true as const } : m));
      const { menu } = opened(t, all);
      assert.deepEqual(
        [...menu.querySelectorAll<HTMLElement>('.mitem .nm')].map((n) => n.textContent),
        ['Opus 5', 'Haiku 4.5']
      );
      assert.deepEqual(
        wps(menu, 'Opus 5').map((w) => w.classList.contains('off')),
        [true, true]
      );
    });

    /**
     * The other account, drawn the other way up. `PAIR` above is a session
     * granted the wide window, so its narrow pill is the dead one; here the
     * account is never given the million, so the million is dead and 200k is
     * what works. The panel paints whichever the host stamped and holds no
     * opinion about plans, which is the whole reason that decision is upstream.
     */
    it('dims the wide pill instead when the narrow one is what works', (t) => {
      const narrowPlan: ModelView[] = [
        {
          value: 'opus',
          name: 'Opus 5',
          id: 'claude-opus-5',
          brand: 'claude',
          window: 1_000_000,
          fixed: true
        },
        { value: 'opus', name: 'Opus 5', id: 'claude-opus-5', brand: 'claude', window: 200_000 },
        {
          value: 'haiku',
          name: 'Haiku 4.5',
          id: 'claude-haiku-4-5',
          brand: 'claude',
          window: 200_000
        }
      ];
      const [wide, narrow] = wps(opened(t, narrowPlan).menu, 'Opus 5');
      assert.ok(wide?.classList.contains('off'), 'the refusable window stayed live');
      assert.ok(!narrow?.classList.contains('off'), 'the window that works was dimmed');
      assert.equal(narrow?.getAttribute('aria-disabled'), null);
    });

    /**
     * Unreachable beats gated, and it is one mark rather than two. We know for
     * certain the switch cannot move the window; the billing gate is a maybe
     * that would never be reached to be seen. `claude-sonnet-4-6[1m]` on a
     * flagged line is both, and it is the case this is written from.
     */
    it('draws an entry that is both as unreachable, not as gated', (t) => {
      const both = PAIR.map((m) => (m.window === 1_000_000 ? { ...m, gated: true as const } : m));
      const [wide] = wps(opened(t, both).menu, 'Opus 5');
      assert.ok(wide?.classList.contains('off'), 'the fixed pill is not dimmed');
      assert.ok(!wide?.classList.contains('gated'), 'it was dashed as gated as well');
      // And one sentence, not two stacked into one attribute.
      assert.match(wide?.dataset.tip ?? '', /new session/);
      assert.ok(!/usage credits/.test(wide?.dataset.tip ?? ''), 'both tips were written');
    });
  });

  /** The sentence changed with the catalog: nothing asks a CLI any more, so an
   *  empty list is the host's availability filter and says so. */
  it('says what an empty list means, and posts nothing', (t) => {
    const p = openThread(t, threadView({ model: 'opus' }), { models: [] });
    const menu = openModels(p);
    assert.equal(menu.querySelectorAll('.mitem').length, 0);
    assert.equal(
      menu.querySelector('.fnone')?.textContent,
      'No CLI here is both installed and signed in.'
    );
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 0);
  });

  /**
   * The card's menu draws the same rows through the same builder as the gear's
   * flyout, so the rule lands here too. Asserted on both surfaces rather than
   * once: they were two copies of this loop until this task, and the reason to
   * check is that they can become two again.
   *
   * **`catalogFor('claude')`, not `CLAUDE_MODELS` — changed 2026-08-28.** Those
   * are two different lists since the flatten: `CLAUDE_MODELS` is the authoring
   * shape, ten rows each holding a `windows` array and no `window` of its own,
   * and the panel is handed the eighteen flattened entries. Fed the authoring
   * rows this passed while every row took the *degraded* draw — no window
   * means no pill — so it was green over a menu with no controls in it at all.
   */
  it('folds legacy rows away here too', (t) => {
    const OFFERED = catalogFor('claude');
    // **The lit model must be a current row.** `board_settings.ts:261` starts
    // the fold *open* when the selected row is a legacy one, which unhides
    // every legacy row and fails the loop below on the first of them. This was
    // `claude-opus-5` until 2.1.280 demoted it (2026-09-23) and the gate went
    // red on Opus 4.8.
    const p = openThread(t, threadView({ model: 'claude-opus-5-5' }), { models: [...OFFERED] });
    const menu = openModels(p);
    // The list is a band of the menu now (`.fscroll`) rather than its own
    // children, which is what makes room for a search box that stays put.
    const list = menu.querySelector<HTMLElement>('.fscroll');
    assert.ok(list, 'the composer menu draws no list band');
    const shown = [...list.querySelectorAll<HTMLElement>('.mitem.wins:not([hidden])')].map(
      (r) => r.querySelector('.nm')?.textContent
    );
    const older = menu.querySelector<HTMLElement>('.mitem.mfold');
    assert.ok(older, 'no fold standing for the legacy rows');
    for (const model of OFFERED) {
      assert.equal(
        shown.includes(model.name),
        !model.legacy,
        `${model.name} fell on the wrong side of the fold`
      );
    }
    // And they are drawn rather than dropped: one press brings every one of
    // them back, on this surface as on the gear's.
    older.click();
    for (const model of OFFERED) {
      assert.ok(
        [...list.querySelectorAll<HTMLElement>('.mitem.wins:not([hidden])')].some(
          (r) => r.querySelector('.nm')?.textContent === model.name
        ),
        `${model.name} is still folded away after the fold was opened`
      );
    }
    // The entries the flatten adds really reach this surface: a model offered
    // at two windows is one row with two pills, and every row has a control.
    const opus = [...menu.querySelectorAll<HTMLElement>('.mitem.wins')].find(
      (r) => r.querySelector('.nm')?.textContent === 'Opus 5.5'
    );
    assert.deepEqual(
      [...(opus?.querySelectorAll('.wp') ?? [])].map((w) => w.textContent),
      ['1M', '200k']
    );
    for (const row of menu.querySelectorAll<HTMLElement>('.mitem.wins')) {
      assert.ok(row.querySelector('.wp'), `${row.querySelector('.nm')?.textContent} draws no pill`);
    }
  });

  /**
   * A model switch is a frame on a pipe this window holds. A session another
   * window drives takes none of them here, so the pill is withheld rather than
   * offered and refused.
   */
  it('is not drawn for a session this window does not drive', (t) => {
    const p = openThread(t, unreachableThread({ model: 'opus' }), { models: MODELS });
    assert.equal(pill(p), null, 'an unreachable session was offered a model switch');
  });

  /** The host pushes the same state every 3s. A rebuild under an open menu
   *  detaches the trigger it hangs off — `heldOpen`'s whole reason. */
  it('survives a poll landing while it is open', (t) => {
    const p = openThread(t, threadView({ model: 'opus' }), { models: MODELS });
    const menu = openModels(p);
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        thread: threadView({ model: 'opus' }),
        models: MODELS
      })
    );
    assert.ok(!menu.hidden, 'a poll shut the menu');
    assert.ok(menu.isConnected, 'a poll detached the menu');
    assert.equal(menu.querySelectorAll('.mitem').length, 2, 'a poll emptied the menu');
  });

  it('closes a held menu before a host reveal paints another session', (t) => {
    const groups = [
      groupView({
        sessions: [
          cardView({ pid: 101, startedAt: 1_000 }),
          cardView({ pid: 202, startedAt: 2_000 })
        ]
      })
    ];
    const p = openPanel(t);
    p.push(
      stateMessage(groups, {
        models: MODELS,
        thread: threadView({ pid: 202, startedAt: 2_000, model: 'haiku', canModel: false })
      })
    );
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(
      stateMessage(groups, {
        models: MODELS,
        thread: threadView({ pid: 101, startedAt: 1_000, model: 'opus' })
      })
    );
    const menu = openModels(p);

    p.push({ type: 'reveal', pid: 202, startedAt: 2_000 });

    assert.ok(menu.hidden, "the previous owner's menu stayed open");
    assert.equal(pill(p)?.querySelector('.nm')?.textContent, 'Haiku 4.5');
    assert.equal((pill(p) as HTMLButtonElement | null)?.disabled, true);
  });
});
