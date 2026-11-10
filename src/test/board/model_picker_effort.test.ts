import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Panel,
  assertedMessageBody,
  cardView,
  enter,
  groupView,
  lastOpen,
  newDraft,
  openPanel,
  openThread,
  stateMessage,
  threadView,
  typeIn,
  importComposer
} from '../harness';
import {
  CLAUDE_EFFORTS,
  EFFORT_MODELS,
  draft,
  pill,
  flyout,
  pillMenu,
  pick
} from './model_picker_helpers';

describe('the effort pill', () => {
  const effortPill = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#ctools .fpill.effort');

  const effortMenu = (p: Panel): HTMLElement => {
    const trigger = effortPill(p);
    assert.ok(trigger, 'no effort pill');
    trigger.click();
    const menu = trigger.parentElement?.querySelector<HTMLElement>('.fmenu');
    assert.ok(menu && !menu.hidden, 'the effort pill opened no menu');
    return menu;
  };

  const pickEffort = (p: Panel, value: string): void => {
    const row = [...effortMenu(p).querySelectorAll<HTMLElement>('.mitem')].find(
      (item) => item.querySelector('.nm')?.textContent === value
    );
    assert.ok(row, `no ${value} effort row`);
    row.click();
  };

  it('draws beside the model only for a draft whose model advertises effort', (t) => {
    const p = draft(openPanel(t), { models: EFFORT_MODELS });
    assert.deepEqual(
      [...p.window.document.querySelectorAll<HTMLElement>('#ctools .fpill')].map((node) =>
        node.classList.contains('effort') ? 'effort' : 'model'
      ),
      ['model', 'effort']
    );
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'medium');

    pick(pillMenu(p), 'Haiku').click();
    assert.equal(effortPill(p), null, 'Haiku kept an effort pill');
    assert.equal(
      p.window.document.querySelectorAll('#ctools .fpill').length,
      1,
      'the model pill went with it'
    );
  });

  it('holds a running pick without posting it', (t) => {
    const p = openThread(
      t,
      threadView({ model: 'opus', effort: 'medium', models: EFFORT_MODELS }),
      { models: EFFORT_MODELS }
    );
    assert.ok(p.window.document.querySelector('#ctools .fpill.model'));
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'medium');
    const before = p.posted.length;
    pickEffort(p, 'high');
    assert.equal(p.posted.length, before);
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'high');
    assert.equal(effortPill(p)?.dataset.tip, 'Effort for the next message');
    importComposer(p, 'think harder');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'think harder',
      target: { effort: 'high' }
    });
  });

  it('reopens a running model pick on its held window', (t) => {
    const p = openThread(
      t,
      threadView({ model: 'opus', contextSize: 200_000, models: EFFORT_MODELS }),
      { models: EFFORT_MODELS }
    );
    pick(pillMenu(p), 'Opus', '1M').click();

    const selected = pillMenu(p).querySelector<HTMLElement>('.wp.on');
    assert.equal(selected?.textContent, '1M');
  });

  it('does not carry a held target onto a recycled pid', (t) => {
    const first = [groupView({ sessions: [threadView({ pid: 101, startedAt: 5_000 })] })];
    const p = openPanel(t);
    p.push(
      stateMessage(first, {
        models: EFFORT_MODELS,
        thread: threadView({ pid: 101, startedAt: 5_000, model: 'opus', models: EFFORT_MODELS })
      })
    );
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    pickEffort(p, 'high');

    p.push(
      stateMessage([groupView({ sessions: [threadView({ pid: 101, startedAt: 11_000 })] })], {
        models: EFFORT_MODELS,
        thread: threadView({ pid: 101, startedAt: 11_000, model: 'opus', models: EFFORT_MODELS })
      })
    );
    typeIn(p, 'new process');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'new process'
    });
  });

  it('offers a running choice when the CLI has not stated an effort', (t) => {
    const p = openThread(t, threadView({ model: 'opus', models: EFFORT_MODELS }), {
      models: EFFORT_MODELS
    });
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'effort');
    const menu = effortMenu(p);
    assert.equal(menu.querySelectorAll('.mitem').length, CLAUDE_EFFORTS.length);
    assert.equal(menu.querySelector('.mitem.on'), null);
  });

  it('switches a running session onto the effort saved for the model', (t) => {
    const p = openThread(t, threadView({ model: 'haiku', models: EFFORT_MODELS }), {
      models: EFFORT_MODELS,
      efforts: { opus: 'low' }
    });
    pick(pillMenu(p), 'Opus', '1M').click();
    typeIn(p, 'next');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'next',
      target: { model: 'opus', window: 1_000_000, effort: 'low' }
    });
  });

  it('offers a draft choice when the model states no default effort', (t) => {
    const models: ModelView[] = [
      {
        value: 'opus',
        name: 'Opus',
        id: 'claude-opus-5',
        brand: 'claude',
        window: 1_000_000,
        efforts: CLAUDE_EFFORTS
      }
    ];
    const p = draft(openPanel(t), { models, model: 'opus' });
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'effort');
    const menu = effortMenu(p);
    assert.equal(menu.querySelectorAll('.mitem').length, CLAUDE_EFFORTS.length);
    assert.equal(menu.querySelector('.mitem.on'), null);
  });

  it('does not keep the previous effort when a held model states none', (t) => {
    const models: ModelView[] = [
      ...EFFORT_MODELS,
      {
        value: 'sonnet',
        name: 'Sonnet',
        id: 'claude-sonnet-5',
        brand: 'claude',
        window: 200_000,
        efforts: CLAUDE_EFFORTS
      }
    ];
    const p = openThread(t, threadView({ model: 'opus', effort: 'medium', models }), { models });
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'medium');
    pick(pillMenu(p), 'Sonnet').click();
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'effort');
    const menu = effortMenu(p);
    assert.equal(menu.querySelector('.mitem.on'), null);
    typeIn(p, 'next');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'next',
      target: { model: 'sonnet', window: 200_000 }
    });
  });

  it('draws Grok model read-only and leaves effort changeable', (t) => {
    const models: ModelView[] = [
      {
        value: 'grok-4.6',
        name: 'Grok 4.6',
        id: 'grok-4.6',
        brand: 'grok',
        efforts: [{ value: 'high' }, { value: 'low' }],
        defaultEffort: 'high'
      }
    ];
    const p = openThread(
      t,
      threadView({ brand: 'grok', model: 'grok-4.6', effort: 'high', canModel: false }),
      { models }
    );
    const model = pill(p) as HTMLButtonElement | null;
    assert.ok(model, 'the fixed model was hidden');
    assert.equal(model.querySelector('.nm')?.textContent, 'Grok 4.6');
    assert.equal(model.disabled, true);
    assert.equal(model.querySelector('.caret'), null, 'a read-only pill kept a menu affordance');
    model.click();
    assert.equal(flyout(p), null, 'the read-only model pill opened a menu');
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'high');
    assert.equal((effortPill(p) as HTMLButtonElement | null)?.disabled, false);
    pickEffort(p, 'low');
    typeIn(p, 'think lightly');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'think lightly',
      target: { effort: 'low' }
    });
  });

  it('opens a Grok model menu and sends an effort the picked model offers', (t) => {
    const models: ModelView[] = [
      {
        value: 'grok-4.7',
        name: 'Grok 4.7',
        id: 'grok-4.7',
        brand: 'grok',
        efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
        defaultEffort: 'high'
      },
      {
        value: 'grok-4.5',
        name: 'Grok 4.5',
        id: 'grok-4.5',
        brand: 'grok',
        efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
        defaultEffort: 'high'
      }
    ];
    const p = openThread(t, threadView({ brand: 'grok', model: 'grok-4.7', effort: 'xhigh' }), {
      models,
      efforts: { 'grok-4.5': 'xhigh' }
    });
    const model = pill(p) as HTMLButtonElement | null;
    assert.ok(model, 'the model pill was hidden');
    assert.equal(model.disabled, false);
    pick(pillMenu(p), 'Grok 4.5').click();
    typeIn(p, 'switch');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'switch',
      target: { model: 'grok-4.5', effort: 'high' }
    });
  });

  for (const destination of ['draft', 'session'] as const) {
    it(`keeps model before effort when leaving Grok for a ${destination}`, (t) => {
      const models: ModelView[] = [
        ...EFFORT_MODELS,
        {
          value: 'grok-4.6',
          name: 'Grok 4.6',
          id: 'grok-4.6',
          brand: 'grok',
          efforts: [{ value: 'high' }]
        }
      ];
      const groups = [groupView({ sessions: [cardView(), cardView({ pid: 102 })] })];
      const grok = threadView({
        brand: 'grok',
        model: 'grok-4.6',
        effort: 'high',
        canModel: false
      });
      const p = openThread(t, grok, { models, model: 'opus' });
      p.push(stateMessage(groups, { thread: grok, models, model: 'opus' }));
      assert.equal((pill(p) as HTMLButtonElement | null)?.disabled, true);
      assert.ok(effortPill(p));

      const next = stateMessage(groups, {
        models,
        model: 'opus',
        thread: threadView({ pid: 102, model: 'opus', effort: 'medium' })
      });
      if (destination === 'draft') {
        newDraft(p);
      } else {
        const card = p.window.document.querySelector<HTMLElement>('.card[data-pid="102"]');
        assert.ok(card);
        card.click();
        p.push(next);
      }
      assert.deepEqual(
        [...p.window.document.querySelectorAll('#ctools .fpill')].map((node) =>
          node.classList.contains('model') ? 'model' : 'effort'
        ),
        ['model', 'effort']
      );
      const model = pill(p);
      assert.ok(model);
      model.focus();
      p.push(next);
      assert.equal(pill(p), model);
      assert.equal(p.window.document.activeElement, model);
    });
  }

  it('draws Codex efforts as the value alone and keeps the default mark', (t) => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({
      value,
      description: `${value} reasoning`
    }));
    const p = draft(openPanel(t), {
      models: [
        {
          value: 'gpt-6-astra',
          name: 'GPT-6-Astra',
          id: 'gpt-6-astra',
          brand: 'codex',
          window: 400_000,
          efforts,
          defaultEffort: 'medium'
        }
      ]
    });
    const menu = effortMenu(p);
    const rows = [...menu.querySelectorAll<HTMLElement>('.mitem')];
    assert.deepEqual(
      rows.map((row) => row.querySelector('.nm')?.textContent),
      efforts.map((effort) => effort.value)
    );
    assert.equal(menu.querySelector('.why'), null);
    assert.equal(
      rows.find((row) => row.querySelector('.nm')?.textContent === 'medium')?.querySelector('.sub')
        ?.textContent,
      'default'
    );
  });

  it('draws Claude values as one-line rows in source order', (t) => {
    const menu = effortMenu(draft(openPanel(t), { models: EFFORT_MODELS }));
    const rows = [...menu.querySelectorAll<HTMLElement>('.mitem')];
    assert.deepEqual(
      rows.map((row) => row.querySelector('.nm')?.textContent),
      CLAUDE_EFFORTS.map((effort) => effort.value)
    );
    assert.equal(menu.querySelector('.why'), null);
  });

  it('holds a pick on the draft and posts nothing', (t) => {
    const p = draft(openPanel(t), { models: EFFORT_MODELS });
    pickEffort(p, 'high');
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'high');
    assert.deepEqual(p.posted, []);
  });

  it('PRD 1: sends an untouched Codex draft at its stated default', (t) => {
    const p = draft(openPanel(t), {
      models: [
        {
          value: 'gpt-6-astra',
          name: 'GPT-6-Astra',
          id: 'gpt-6-astra',
          brand: 'codex',
          window: 400_000,
          efforts: [
            { value: 'low', description: 'Low reasoning' },
            { value: 'medium', description: 'Medium reasoning' },
            { value: 'high', description: 'High reasoning' }
          ],
          defaultEffort: 'medium'
        }
      ]
    });
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'medium');
    typeIn(p, 'begin');
    enter(p);
    const { brand, model, window, effort } = lastOpen(p).target ?? {};
    assert.deepEqual(
      { brand, model, window, effort },
      {
        brand: 'codex',
        model: 'gpt-6-astra',
        window: 400_000,
        effort: 'medium'
      }
    );
  });

  it('PRD 2: resets to each model’s default on every model change', (t) => {
    const models: ModelView[] = [
      {
        value: 'fable',
        name: 'Fable 5.1',
        id: 'claude-fable-5-1',
        brand: 'claude',
        window: 1_000_000,
        efforts: CLAUDE_EFFORTS,
        defaultEffort: 'medium'
      },
      {
        value: 'opus',
        name: 'Opus 5',
        id: 'claude-opus-5',
        brand: 'claude',
        window: 1_000_000,
        efforts: CLAUDE_EFFORTS,
        defaultEffort: 'high'
      }
    ];
    const p = draft(openPanel(t), { models });
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'medium');
    pick(pillMenu(p), 'Opus 5').click();
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'high');
    pickEffort(p, 'max');
    pick(pillMenu(p), 'Fable 5.1').click();
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'medium');
    typeIn(p, 'begin');
    enter(p);
    assert.equal(lastOpen(p).target?.effort, 'medium');
  });

  it('PRD 3: resets to a model’s native default when it has no saved effort', (t) => {
    const p = draft(openPanel(t), {
      efforts: { 'grok-4.6': 'medium' },
      models: [
        {
          value: 'grok-4.6',
          name: 'Grok 4.6',
          id: 'grok-4.6',
          brand: 'grok',
          window: 500_000,
          efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
          defaultEffort: 'high'
        },
        {
          value: 'grok-4.5',
          name: 'Grok 4.5',
          id: 'grok-4.5',
          brand: 'grok',
          window: 500_000,
          efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
          defaultEffort: 'high'
        }
      ]
    });
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'medium');
    pick(pillMenu(p), 'Grok 4.5').click();
    assert.equal(effortPill(p)?.querySelector('.nm')?.textContent, 'high');
    typeIn(p, 'begin');
    enter(p);
    assert.equal(lastOpen(p).target?.effort, 'high');
  });

  it('PRD 4: drops a stale global effort from Haiku', (t) => {
    const p = draft(openPanel(t), {
      models: EFFORT_MODELS,
      model: 'haiku',
      efforts: { haiku: 'ultra' }
    });
    assert.equal(effortPill(p), null);
    typeIn(p, 'begin');
    enter(p);
    assert.equal('effort' in (lastOpen(p).target ?? {}), false);
  });
});
