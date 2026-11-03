import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openPanel, stateMessage, workflowView, type Panel } from '../harness';
import { LANE_MODELS, openReview, review } from './workflow_review';
import { board, editWorkflow, doc, save } from './workflow_editor_helpers';

function chip(p: Panel, id: string, effort = false): HTMLElement | null {
  const node = p.window.document.querySelector<HTMLElement>(`#wfeditor .wcnode[data-node="${id}"]`);
  return (
    node?.querySelector<HTMLElement>(effort ? '.wcchip.effort' : '.wcchip:not(.effort)') ?? null
  );
}

/** The menu a chip just opened. `hidden` is a property, so it is not matched
 *  as an attribute selector under jsdom. */
function chipMenu(p: Panel): HTMLElement {
  const menu = [...p.window.document.querySelectorAll<HTMLElement>('.fmenu')].find(
    (m) => !m.hidden
  );
  if (!menu) throw new Error('the chip opened no menu');
  return menu;
}

describe('workflow editor', () => {
  it('opens the eleven-step review as four lanes', (t) => {
    const p = openPanel(t);
    openReview(p);
    assert.equal(p.window.document.querySelectorAll('#wfeditor .wchd').length, 4);
    assert.equal(chip(p, 'impl'), null, 'the armed session draws no chip');
    assert.equal(chip(p, 'ui')?.querySelector('span')?.textContent, 'opus-5');
    const uiEffort = chip(p, 'ui', true);
    assert.equal(uiEffort?.textContent, 'high');
    assert.ok(uiEffort?.classList.contains('inherit'), 'an unstated effort is the dashed default');
    const ruEffort = chip(p, 'ru', true);
    assert.equal(ruEffort?.textContent, 'medium');
    assert.equal(ruEffort?.classList.contains('inherit'), false);
  });

  it('the inherited-model row keeps its full label and height outside the canvas', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'last-peer',
      label: 'Last peer',
      steps: [
        { id: 'start', label: 'Start', prompt: 'Start' },
        {
          id: 'last',
          label: 'Last',
          prompt: 'Last',
          lane: 'peer',
          needs: ['start'],
          brand: 'claude',
          model: 'opus-5'
        }
      ]
    });
    const model = LANE_MODELS[0];
    assert.ok(model);
    const models = Array.from({ length: 20 }, (_, i) => ({
      ...model,
      value: `model-${i}`,
      id: `model-${i}`,
      name: `Model ${i}`
    }));
    p.push(stateMessage(board(), { workflows: [file], models }));
    editWorkflow(p, 'Last peer');
    chip(p, 'last')?.click();
    const menu = chipMenu(p);
    assert.equal(menu.parentElement, p.window.document.body, 'escapes both canvas scrollers');
    const row = menu.querySelector<HTMLElement>(':scope > .mitem');
    const label = row?.querySelector<HTMLElement>('.nm');
    assert.ok(row && label);
    assert.equal(label.textContent, 'Starting session’s default');
    assert.equal(p.window.getComputedStyle(row).flexShrink, '0', 'only the model list shrinks');
    const style = p.window.getComputedStyle(label);
    assert.equal(style.whiteSpace, 'normal', 'wraps when the viewport caps the width');
    assert.equal(style.overflow, 'visible', 'does not clip the inherited choice');
    row.click();
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    const msg = p.posted.find((m) => m.type === 'saveWorkflow');
    assert.ok(msg && msg.type === 'saveWorkflow');
    assert.equal(msg.steps.find((s) => s.id === 'last')?.model, undefined);
  });

  it('a model picked on ru is what save posts, and a reload draws it', (t) => {
    const p = openPanel(t);
    openReview(p);
    const ru = p.window.document.querySelector<HTMLElement>('#wfeditor .wcnode[data-node="ru"]');
    chip(p, 'ru')?.click();
    assert.equal(ru?.querySelector('.wcbody'), null, 'the chip does not open the node');
    const menu = chipMenu(p);
    [...menu.querySelectorAll<HTMLElement>('button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('Opus 5'))
      ?.click();
    assert.equal(chip(p, 'ru')?.querySelector('span')?.textContent, 'opus-5');
    assert.equal(chip(p, 'ru', true)?.textContent, 'medium', 'medium is still on the new row');

    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    const msg = p.posted.filter((m) => m.type === 'saveWorkflow').at(-1);
    assert.ok(msg && msg.type === 'saveWorkflow');
    if (!msg || msg.type !== 'saveWorkflow') return;
    const step = msg.steps.find((s) => s.id === 'ru');
    assert.equal(step?.model, 'opus-5');
    assert.equal(step?.brand, 'claude');
    assert.equal(step?.effort, 'medium');
    assert.equal(step?.lane, 's3');
    assert.deepEqual(step?.needs, ['ui']);
    assert.equal(msg.steps.find((s) => s.id === 'impl')?.model, undefined);

    p.push({ type: 'saveWorkflowResult', ok: true, id: 'review' });
    p.push(
      stateMessage(board(), {
        workflows: [
          workflowView({
            id: 'review',
            label: msg.label,
            steps: msg.steps.map((s) => ({
              id: s.id ?? '',
              label: s.label,
              prompt: s.prompt,
              ...(s.lane ? { lane: s.lane } : {}),
              ...(s.needs && s.needs.length > 0 ? { needs: s.needs } : {}),
              ...(s.brand ? { brand: s.brand } : {}),
              ...(s.model ? { model: s.model } : {}),
              ...(s.effort ? { effort: s.effort } : {})
            }))
          })
        ],
        models: LANE_MODELS
      })
    );
    editWorkflow(p, 'Review loop');
    assert.equal(chip(p, 'ru')?.querySelector('span')?.textContent, 'opus-5');
    assert.equal(chip(p, 'ru', true)?.textContent, 'medium');
  });

  it('picking a model with no effort clears the effort save posts', (t) => {
    const p = openPanel(t);
    openReview(p);
    chip(p, 'ru')?.click();
    [...chipMenu(p).querySelectorAll<HTMLElement>('button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('Haiku'))
      ?.click();
    assert.equal(chip(p, 'ru')?.querySelector('span')?.textContent, 'haiku');
    assert.equal(chip(p, 'ru', true), null, 'Haiku draws no effort chip');

    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    const msg = p.posted.filter((m) => m.type === 'saveWorkflow').at(-1);
    assert.ok(msg && msg.type === 'saveWorkflow');
    if (!msg || msg.type !== 'saveWorkflow') return;
    const step = msg.steps.find((s) => s.id === 'ru');
    assert.equal(step?.model, 'haiku');
    assert.equal(step?.brand, 'claude');
    assert.equal(step?.effort, undefined);
  });

  it('leaves a catalog sentence off the effort chip menu', (t) => {
    const p = openPanel(t);
    const models = LANE_MODELS.map((model) =>
      model.value === 'sonnet-5'
        ? {
            ...model,
            efforts: model.efforts?.map((effort) => ({
              ...effort,
              description: `${effort.value} reasoning`
            }))
          }
        : model
    );
    p.push(stateMessage(board(), { workflows: [review()], models }));
    editWorkflow(p, 'Review loop');
    chip(p, 'ru', true)?.click();
    const menu = chipMenu(p);
    assert.equal(menu.querySelector('.why'), null);
    assert.deepEqual(
      [...menu.querySelectorAll('.mitem')].map((row) => row.querySelector('.nm')?.textContent),
      ['high', 'medium', 'low']
    );
    assert.equal(
      [...menu.querySelectorAll('.mitem')]
        .find((row) => row.querySelector('.nm')?.textContent === 'high')
        ?.querySelector('.sub')?.textContent,
      'default'
    );
  });
});

/** The review of `ef6b3916`, as a reader of the editor meets it. */
describe('workflow editor after the v2 review', () => {
  it('a model pick writes no effort nobody chose', (t) => {
    const p = openPanel(t);
    openReview(p);
    chip(p, 'ui')?.click();
    [...chipMenu(p).querySelectorAll<HTMLElement>('button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('Sonnet 5'))
      ?.click();
    assert.ok(chip(p, 'ui', true)?.classList.contains('inherit'), 'still the dashed default');
    const step = save(p).steps.find((s) => s.id === 'ui');
    assert.equal(step?.model, 'sonnet-5');
    assert.equal(step !== undefined && 'effort' in step, false);
  });

  // A broken lane chain: `late` is listed first in s1 but drawn a row below
  // `early`, a named root. Save (disabled until the chain is mended) writes the
  // opener fields to the first listed, so that is where the chip goes — not on
  // the shallower step.
  it('puts the model chip on the step save writes it to, not the shallowest', (t) => {
    const p = openPanel(t);
    const broken = workflowView({
      id: 'broken',
      label: 'Broken chain',
      steps: [
        { id: 'root', label: 'Root', prompt: 'r' },
        { id: 'mid', label: 'Mid', prompt: 'm', needs: ['root'] },
        {
          id: 'late',
          label: 'Late',
          prompt: 'l',
          lane: 's1',
          needs: ['mid'],
          brand: 'claude',
          model: 'opus-5'
        },
        { id: 'early', label: 'Early', prompt: 'e', lane: 's1' }
      ]
    });
    p.push(stateMessage(board(), { workflows: [broken], models: LANE_MODELS }));
    editWorkflow(p, 'Broken chain');
    assert.ok(chip(p, 'late'), 'the first step listed in s1 offers the model');
    assert.equal(chip(p, 'early'), null);
    const heads = [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wchd')];
    assert.equal(heads[1]?.querySelector('span')?.textContent, 'opens at 3');
    assert.equal(doc(p).querySelector<HTMLButtonElement>('#wfeditor .wesave')?.disabled, true);
  });

  it('clearing the model posts no brand, model or effort', (t) => {
    const p = openPanel(t);
    openReview(p);
    const stated = chip(p, 'ru');
    assert.match(
      stated?.dataset.tip ?? '',
      /If it can’t start, this lane runs on the starting session’s model/
    );
    stated?.click();
    [...chipMenu(p).querySelectorAll<HTMLElement>('button')]
      .find((b) => (b.textContent ?? '').includes('Starting session’s default'))
      ?.click();
    const cleared = chip(p, 'ru');
    assert.equal(cleared?.querySelector('span')?.textContent, 'model/effort selection');
    assert.equal(cleared?.dataset.tip, 'No model in the file — pick a model/effort');
    const step = save(p).steps.find((s) => s.id === 'ru');
    assert.equal(step?.model, undefined);
    assert.equal(step?.brand, undefined);
    assert.equal(step?.effort, undefined);
  });
});
