import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openPanel, proseRoot, stateMessage, workflowView } from '../harness';
import { LANE_MODELS, openReview, review } from './workflow_review';
import {
  board,
  ship,
  openEditShip,
  editWorkflow,
  escOn,
  interrupts,
  editBehindBusy,
  openNode,
  stepBadges,
  hitIs,
  drawWire,
  doc,
  key,
  save,
  type
} from './workflow_editor_helpers';

/** The review of `ef6b3916`, as a reader of the editor meets it. */
describe('workflow editor after the v2 review', () => {
  it("refuses the chain's own wire and clears the line on the next edit", (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="plan"][data-to="build"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wirex')?.click();
    assert.match(
      doc(p).querySelector('#wfeditor .wcnode[data-node="build"] .wcwhy')?.textContent ?? '',
      /Kept\./
    );
    openNode(p, 1);
    const title = doc(p).querySelector<HTMLInputElement>('#wfeditor .wcnode.editing input.wctitle');
    type(p, title, 'Built');
    assert.equal(doc(p).querySelector('#wfeditor .wcwhy'), null);
  });

  it('wires a step from a port, and deletes a wire that is not the lane’s order', (t) => {
    const p = openPanel(t);
    openReview(p);
    // From another lane: `impl` is three steps above `ship` in its own, a skip.
    drawWire(p, 'ui', 'ship');
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="riw"][data-to="ship"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wirex')?.click();
    const step = save(p).steps.find((s) => s.id === 'ship');
    assert.ok(step?.needs?.includes('ui'));
    assert.equal(step?.needs?.includes('riw'), false);
    assert.ok(step?.needs?.includes('riu'));
  });

  it('a handle drag states the wait its drop would add, until it ends', (t) => {
    const p = openPanel(t);
    openReview(p);
    const tip = (): string | null => doc(p).querySelector('.wctip')?.textContent ?? null;
    hitIs(p, doc(p).querySelector('#wfeditor .wcnode[data-node="ship"]'));
    doc(p)
      .querySelector('#wfeditor .wcnode[data-node="ui"] .wcport')
      ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 40 }));
    assert.equal(tip(), 'Converge, test, commit waits for Do the UI');
    doc(p).dispatchEvent(new p.window.MouseEvent('pointerup', { bubbles: true, clientX: 40 }));
    assert.equal(tip(), null);
  });

  it('a loaded break keeps Save blocked until the step follows its lane', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'broke',
      label: 'Broke',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        {
          id: 'build',
          label: 'Build',
          prompt: 'build',
          lane: 'builder',
          needs: ['plan'],
          brand: 'claude',
          model: 'opus-5'
        },
        { id: 'test', label: 'Test', prompt: 'test', lane: 'builder', needs: ['plan'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file], models: LANE_MODELS }));
    editWorkflow(p, 'Broke');
    assert.equal(
      p.posted.some((m) => m.type === 'saveWorkflow'),
      false
    );
    const saveBtn = doc(p).querySelector<HTMLButtonElement>('#wfeditor .wesave');
    assert.equal(saveBtn?.disabled, true);
    assert.match(
      doc(p).querySelector('#wfeditor .wcnode[data-node="test"] .wcwhy')?.textContent ?? '',
      /test does not follow build/
    );
    drawWire(p, 'build', 'test');
    assert.equal(doc(p).querySelector<HTMLButtonElement>('#wfeditor .wesave')?.disabled, false);
    assert.ok(
      save(p)
        .steps.find((s) => s.id === 'test')
        ?.needs?.includes('build')
    );
  });

  it('keeps a wire’s Escape from a session busy behind the editor', (t) => {
    const p = editBehindBusy(t);
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="plan"][data-to="build"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.ok(doc(p).querySelector('#wfeditor path.sel'), 'no wire selected');
    escOn(p, doc(p).body);
    assert.equal(doc(p).querySelector('#wfeditor path.sel'), null);
    assert.equal(doc(p).getElementById('wfeditor')?.hidden, false, 'one Escape was two levels');
    assert.equal(interrupts(p), 0);
  });

  it('selects a wire, Escape puts it back, and the trash refuses the one holding the chain', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    const select = (): void => {
      doc(p)
        .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="plan"][data-to="build"]')
        ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    };
    select();
    assert.ok(doc(p).querySelector('#wfeditor path.sel'));
    assert.ok(doc(p).querySelector('#wfeditor .wirex'));
    key(p, doc(p).body, 'Escape');
    assert.equal(doc(p).querySelector('#wfeditor path.sel'), null);
    assert.equal(doc(p).querySelector('#wfeditor .wirex'), null);
    select();
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wirex')?.click();
    assert.match(
      doc(p).querySelector('#wfeditor .wcnode[data-node="build"] .wcwhy')?.textContent ?? '',
      /Kept\./
    );
  });

  it('leaves a selected wire up on an Escape typed in a step prompt', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    openNode(p, 0);
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="plan"][data-to="build"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.ok(doc(p).querySelector('#wfeditor .wirex'), 'no wire selected');
    key(p, proseRoot(doc(p).querySelector('#wfeditor .wcnode.editing .wcbody')), 'Escape');
    assert.ok(doc(p).querySelector('#wfeditor .wirex'), 'the prompt’s Escape took the trash');
    key(p, doc(p).body, 'Escape');
    assert.equal(doc(p).querySelector('#wfeditor .wirex'), null);
  });

  it('no key edits the structure: chords and Delete do nothing', (t) => {
    const p = openPanel(t);
    openReview(p);
    openNode(p, 1);
    const title = doc(p).querySelector('#wfeditor .wcnode.editing input.wctitle');
    if (!title) throw new Error('the node did not open');
    for (const k of ['Enter', 'ArrowUp', 'ArrowDown']) {
      assert.equal(key(p, title, k, { altKey: true }), true, `Alt+${k} is the platform's`);
    }
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="riw"][data-to="ship"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    key(p, doc(p).body, 'Delete');
    key(p, doc(p).body, 'Backspace');
    assert.ok(doc(p).querySelector('#wfeditor path.sel'), 'the wire is still selected');
    const msg = save(p);
    assert.deepEqual(
      msg.steps.map((s) => s.id),
      review().steps.map((s) => s.id)
    );
    assert.ok(msg.steps.find((s) => s.id === 'ship')?.needs?.includes('riw'));
  });

  it('a wire reads as clickable', (t) => {
    const p = openPanel(t);
    openReview(p);
    const hit = doc(p).querySelector<SVGPathElement>('#wfeditor path.wchit');
    assert.ok(hit);
    assert.equal(p.window.getComputedStyle(hit).cursor, 'pointer');
  });

  it('a clicked wire offers a trash where it was clicked; a click elsewhere takes it back', (t) => {
    const p = openPanel(t);
    openReview(p);
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="riw"][data-to="ship"]')
      ?.dispatchEvent(
        new p.window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 30 })
      );
    const trash = doc(p).querySelector<HTMLButtonElement>('#wfeditor .wirex');
    assert.equal(trash?.getAttribute('aria-label'), 'Delete wire');
    assert.ok(trash?.querySelector('svg'), 'a trash glyph, not a ×');
    // jsdom measures every rect at zero, so the canvas origin is the viewport's.
    assert.equal(trash?.style.left, '40px');
    assert.equal(trash?.style.top, '30px');
    doc(p)
      .querySelector('#wfeditor .wclattice')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.equal(doc(p).querySelector('#wfeditor .wirex'), null);
    assert.equal(doc(p).querySelector('#wfeditor path.sel'), null);
  });

  it('a click on a control that stops its own click still takes the trash back', (t) => {
    const p = openPanel(t);
    openReview(p);
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="riw"][data-to="ship"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.ok(doc(p).querySelector('#wfeditor .wirex'));
    const chip = doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcchip');
    assert.ok(chip, 'a model chip to press');
    chip.click();
    assert.equal(doc(p).querySelector('#wfeditor .wirex'), null);
    assert.equal(doc(p).querySelector('#wfeditor path.sel'), null);
  });

  it('a handle drag marks the steps a wire back to would loop', (t) => {
    const p = openPanel(t);
    openReview(p);
    hitIs(p, doc(p).querySelector('#wfeditor .wcnode[data-node="impl"]'));
    const port = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="wire"] .wcport');
    port?.dispatchEvent(
      new p.window.MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 })
    );
    port?.dispatchEvent(
      new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 12, clientY: 4 })
    );
    assert.equal(
      doc(p).querySelector('#wfeditor .wcnode[data-node="impl"]')?.classList.contains('refuse'),
      true
    );
    assert.equal(
      doc(p).querySelector('#wfeditor .wcnode[data-node="wire"]')?.classList.contains('refuse'),
      false
    );
    // A refused card's own words say it; no second sentence.
    assert.equal(doc(p).querySelector('.wctip'), null);
    doc(p).body.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(doc(p).querySelector('#wfeditor .wcnode.refuse'), null);

    // Released on a step it would loop through: nothing is linked. The drag
    // already said why, so the card grows no note.
    drawWire(p, 'wire', 'impl');
    assert.equal(doc(p).querySelector('#wfeditor .wcnode[data-node="impl"] .wcwhy'), null);
    assert.equal(save(p).steps.find((s) => s.id === 'impl')?.needs, undefined);
  });

  it('a handle drag marks the steps of its own lane a wire would skip', (t) => {
    const p = openPanel(t);
    openReview(p);
    const marked = (id: string) =>
      doc(p).querySelector(`#wfeditor .wcnode[data-node="${id}"]`)?.classList.contains('refuse');
    doc(p)
      .querySelector<HTMLElement>('#wfeditor .wcnode[data-node="wire"] .wcport')
      ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true }));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 12 }));
    // The armed lane runs impl, wire, aw, int, ship: aw is next, the rest are skips.
    assert.equal(marked('aw'), false);
    assert.equal(marked('int'), true);
    assert.equal(marked('ship'), true);
    assert.equal(marked('ru'), false, 'another lane is not a skip');
    const node = (id: string): HTMLElement | null =>
      doc(p).querySelector<HTMLElement>(`#wfeditor .wcnode[data-node="${id}"]`);
    // aw is the step right after wire. A skip names that step. impl already
    // waits on wire's chain, so it is a loop and keeps the other words.
    assert.equal(node('int')?.classList.contains('skip'), true);
    assert.equal(node('ship')?.classList.contains('skip'), true);
    assert.equal(node('int')?.dataset.skips, 'Apply the findings');
    assert.equal(node('ship')?.dataset.skips, 'Apply the findings');
    assert.equal(node('aw')?.classList.contains('skip'), false);
    assert.equal(node('impl')?.classList.contains('refuse'), true);
    assert.equal(node('impl')?.classList.contains('skip'), false);
    assert.equal(node('impl')?.hasAttribute('data-skips'), false);
    // jsdom does not compute ::after (measured: the pseudo is dropped, and a
    // value containing var() computes to nothing). The rule is the label.
    const declared = (selector: string, prop: 'content' | 'color'): string => {
      for (const sheet of doc(p).styleSheets) {
        for (const rule of sheet.cssRules) {
          if (!(rule instanceof p.window.CSSStyleRule) || rule.selectorText !== selector) continue;
          return rule.style[prop];
        }
      }
      return '';
    };
    assert.equal(
      declared('#wfcanvas .wcnode.refuse.skip::after', 'content'),
      '"skips " attr(data-skips)'
    );
    assert.equal(declared('#wfcanvas .wcnode.refuse::after', 'content'), '"would loop"');
    // Both refusals. Grey on a card already at 38% opacity does not read.
    assert.equal(declared('#wfcanvas .wcnode.refuse::after', 'color'), 'var(--av-red)');
    assert.equal(declared('#wfcanvas .wcnode.refuse.skip::after', 'color'), 'var(--av-red)');
    doc(p).body.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(doc(p).querySelector('#wfeditor .wcnode.skip'), null);
    assert.equal(doc(p).querySelector('#wfeditor [data-skips]'), null);

    drawWire(p, 'wire', 'ship');
    assert.equal(doc(p).querySelector('#wfeditor .wcnode[data-node="ship"] .wcwhy'), null);
    assert.equal(
      save(p)
        .steps.find((s) => s.id === 'ship')
        ?.needs?.includes('wire'),
      false
    );
  });

  it('keeps step 1 when an unwired session step is wired onto it', (t) => {
    const p = openPanel(t);
    const orphan = workflowView({
      id: 'orphan',
      label: 'Orphan',
      steps: [
        { id: 'one', label: 'One', prompt: 'one' },
        { id: 'two', label: 'Two', prompt: 'two', lane: 'session 1' }
      ]
    });
    p.push(stateMessage(board(), { workflows: [orphan] }));
    editWorkflow(p, 'Orphan');
    const one = () => doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="one"]');
    doc(p)
      .querySelector<HTMLElement>('#wfeditor .wcnode[data-node="two"] .wcport')
      ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true }));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 12 }));
    assert.equal(one()?.classList.contains('refuse'), true);
    assert.equal(one()?.classList.contains('starts'), true);
    const label = [...doc(p).styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .find(
        (rule): rule is CSSStyleRule =>
          rule instanceof p.window.CSSStyleRule &&
          rule.selectorText === '#wfcanvas .wcnode.refuse.starts::after'
      );
    assert.equal(label?.style.content, '"starts the run"');
    doc(p).body.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );

    drawWire(p, 'two', 'one');
    assert.deepEqual(stepBadges(p), ['1', '2']);
    assert.equal(one()?.style.gridRow, '2');
    assert.equal(save(p).steps.find((s) => s.id === 'one')?.needs, undefined);
  });

  it('marks no wire into step 1 of a draft that already starts on a wait', (t) => {
    // `link` leaves a draft that began so as the author wrote it, and takes the wire.
    const p = openPanel(t);
    const waiting = workflowView({
      id: 'waiting',
      label: 'Waiting',
      steps: [
        { id: 'notes', label: 'Notes', prompt: 'notes', lane: 'session 1' },
        { id: 'one', label: 'One', prompt: 'one', needs: ['notes'] },
        { id: 'extra', label: 'Extra', prompt: 'extra', lane: 'session 2' }
      ]
    });
    p.push(stateMessage(board(), { workflows: [waiting] }));
    editWorkflow(p, 'Waiting');
    doc(p)
      .querySelector<HTMLElement>('#wfeditor .wcnode[data-node="extra"] .wcport')
      ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true }));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 12 }));
    const one = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="one"]');
    assert.equal(one?.classList.contains('refuse'), false);
    assert.equal(one?.classList.contains('starts'), false);
  });

  it('draws a line while a wire is dragged, and Escape takes it down', (t) => {
    const p = openPanel(t);
    openReview(p);
    doc(p)
      .querySelector('#wfeditor .wcnode[data-node="wire"] .wcport')
      ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 30 }));
    assert.ok(doc(p).querySelector('#wfeditor .wcrubber'));
    doc(p).body.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(doc(p).querySelector('#wfeditor .wcrubber'), null);
    assert.equal(doc(p).querySelector('#wfeditor .wcnode.refuse'), null);
    // The drag is over: a release now links nothing.
    hitIs(p, doc(p).querySelector('#wfeditor .wcnode[data-node="ship"]'));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointerup', { bubbles: true }));
    assert.equal(
      save(p)
        .steps.find((s) => s.id === 'ship')
        ?.needs?.includes('wire'),
      false
    );
  });

  it('ends a wire drag when the canvas is rebuilt under it', (t) => {
    const p = openPanel(t);
    openReview(p);
    doc(p)
      .querySelector('#wfeditor .wcnode[data-node="impl"] .wcport')
      ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    openNode(p, 1);
    hitIs(p, doc(p).querySelector('#wfeditor .wcnode[data-node="ship"]'));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointerup', { bubbles: true }));
    assert.equal(
      save(p)
        .steps.find((s) => s.id === 'ship')
        ?.needs?.includes('impl'),
      false
    );
  });

  it('cancels a wire drag on Escape while a field has the caret', (t) => {
    const p = openPanel(t);
    openReview(p);
    openNode(p, 0);
    doc(p).querySelector<HTMLInputElement>('#wfeditor .wcnode.editing input.wctitle')?.focus();
    doc(p)
      .querySelector('#wfeditor .wcnode[data-node="wire"] .wcport')
      ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    doc(p).dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 30 }));
    doc(p)
      .querySelector('#wfeditor .wcnode.editing input.wctitle')
      ?.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    assert.equal(doc(p).querySelector('#wfeditor .wcrubber'), null);
  });
});
