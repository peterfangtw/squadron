import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { Workflow } from '../../core/workflows/workflows';
import * as state from '../../ui/state';
import * as harness from '../harness';
import { repoRoot } from '../helpers';

const views = ['example-read-do-review', 'example-multiple-models'].map((id) => {
  const file = path.resolve(repoRoot(), 'install/workflows', `${id}.json`);
  const workflow = JSON.parse(fs.readFileSync(file, 'utf8')) as Workflow;
  return state.toWorkflowView({ ...workflow, path: file });
});

function open(t: TestContext): harness.Panel {
  const p = harness.openPanel(t);
  p.push(harness.stateMessage([], { workflows: views }));
  p.window.document.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
  assert.equal(p.window.document.getElementById('bottomdrawer')?.hidden, false);
  return p;
}

function action(p: harness.Panel, id: string, label: string): void {
  const button = p.window.document.querySelector<HTMLElement>(
    `#bottomdrawer-body .wsrow[data-id="${id}"] .act[aria-label^="${label} "]`
  );
  assert.ok(button);
  button.click();
}

describe('workflow examples in the existing editor', () => {
  it('lists the examples, applying none', (t) => {
    const p = open(t);
    const names = [...p.window.document.querySelectorAll('#bottomdrawer-body .wsrow .nm')].map(
      (el) => el.textContent
    );
    assert.deepEqual(
      names,
      views.map((v) => v.label)
    );
    assert.equal(p.window.document.querySelector('#wattach .wflow.armed'), null);
  });

  it('opens the basic example as one lane with prose-driven peer review', (t) => {
    const p = open(t);
    action(p, 'example-read-do-review', 'Edit');
    assert.equal(p.window.document.getElementById('wfeditor')?.hidden, false);
    assert.equal(p.window.document.querySelectorAll('#wfeditor .wchd').length, 1);
    assert.equal(p.window.document.querySelectorAll('#wfeditor .wcnode').length, 6);
    p.window.document
      .querySelector<HTMLElement>('#wfeditor .wcnode[data-node="peer-review"]')
      ?.click();
    const prompt = harness.proseOf(p.window.document.querySelector('#wfeditor .wcbody'));
    assert.match(prompt.value(), /squadron-spawn/);
  });

  it('opens the advanced example with editable explicit model choices', (t) => {
    const p = open(t);
    action(p, 'example-multiple-models', 'Edit');
    assert.equal(p.window.document.querySelectorAll('#wfeditor .wchd').length, 3);
    assert.match(
      p.window.document.querySelector(
        '#wfeditor .wcnode[data-node="review-plan"] .wcchip:not(.effort)'
      )?.textContent ?? '',
      /claude-opus-5-5|Opus 5.5/
    );
    assert.match(
      p.window.document.querySelector(
        '#wfeditor .wcnode[data-node="implement"] .wcchip:not(.effort)'
      )?.textContent ?? '',
      /grok-4.7|Grok 4.7/
    );
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    const save = p.posted.find((m) => m.type === 'saveWorkflow');
    assert.ok(save?.type === 'saveWorkflow');
    assert.deepEqual(
      save.steps.filter((s) => s.model).map((s) => [s.lane, s.brand, s.model]),
      [
        ['Reviewer', 'claude', 'claude-opus-5-5'],
        ['Implementer', 'grok', 'grok-4.7']
      ]
    );
  });

  it('duplicates an example through the ordinary workflow action', (t) => {
    const p = open(t);
    action(p, 'example-read-do-review', 'Duplicate');
    assert.deepEqual(p.posted.at(-1), { type: 'duplicateWorkflow', id: 'example-read-do-review' });
  });

  it('deletes both examples and reaches the normal empty-workflow state', (t) => {
    const p = open(t);
    for (const [index, view] of views.entries()) {
      action(p, view.id, 'Delete');
      const confirm = [
        ...p.window.document.querySelectorAll<HTMLElement>(
          '#bottomdrawer-body .wsrow.confirming .fbtn'
        )
      ].find((el) => el.textContent === 'Delete');
      assert.ok(confirm);
      confirm.click();
      assert.deepEqual(p.posted.at(-1), { type: 'deleteWorkflow', id: view.id });
      p.push({ type: 'deleteWorkflowResult', ok: true });
      p.push(harness.stateMessage([], { workflows: views.slice(index + 1) }));
    }
    assert.equal(p.window.document.getElementById('bottomdrawer')?.hidden, true);
    assert.equal(
      p.window.document.querySelector('#bottomhub .fpill')?.textContent,
      '+ New workflow'
    );
  });
});
