import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachWorkflow,
  openPanel,
  proseOf,
  proseRoot,
  stateMessage,
  typeProse,
  workflowView,
  type Panel
} from '../harness';
import { LANE_MODELS, openReview, review } from './workflow_review';
import {
  board,
  ship,
  select,
  clickNew,
  openEditShip,
  editWorkflow,
  openNode,
  stepBadges,
  hitIs,
  drawWire,
  doc,
  key,
  save,
  type
} from './workflow_editor_helpers';

/** Step names, in document order. An open node has a field; a closed one is text. */
function stepNames(p: Panel): string[] {
  return [...p.window.document.querySelectorAll('#wfeditor .wcnode')].map((node) => {
    const field = node.querySelector<HTMLInputElement>('input.wctitle');
    return field ? field.value : (node.querySelector('.wcname:not(.empty)')?.textContent ?? '');
  });
}

/** Each column's Add step, the append under that lane's last step. */
function addSteps(p: Panel): HTMLButtonElement[] {
  return [...p.window.document.querySelectorAll<HTMLButtonElement>('#wfeditor .wcaddstep')];
}

/**
 * jsdom has no layout, so for the length of `fn` each column is lent a 100px
 * band in header order, the new-session tile the band after them, and the grid
 * 400px of empty canvas past those, as on a wide board. Each card, cell and
 * Add step is lent row `n`'s band, `[n * 100, n * 100 + 90]`, so the 10px
 * under it is a row gap. `x` is the middle of `target`'s band; -50, left of
 * the grid, when it is in none.
 */
function inColumns<T>(p: Panel, fn: (x: (target: Element | null) => number) => T): T {
  const doc = p.window.document;
  const columns = [...doc.querySelectorAll<HTMLElement>('#wfeditor .wchd, #wfeditor .wcghost')];
  const proto = p.window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function rect(this: Element) {
    const grid = this.classList.contains('wcgrid');
    const row = Number((this as HTMLElement).dataset?.row);
    if (!grid && this.matches('.wcnode, .wccell, .wcaddstep') && Number.isInteger(row)) {
      const top = row * 100;
      return { left: 0, right: 0, width: 0, top, bottom: top + 90, height: 90 } as DOMRect;
    }
    const i = columns.indexOf(this as HTMLElement);
    const left = grid ? 0 : i * 100;
    const width = grid ? columns.length * 100 + 400 : i < 0 ? 0 : 90;
    const height = grid || i >= 0 ? 1000 : 0;
    return { left, right: left + width, width, top: 0, bottom: height, height } as DOMRect;
  };
  const x = (target: Element | null): number => {
    const lane = target?.closest<HTMLElement>('[data-lane]')?.dataset.lane;
    const at = target?.closest('.wcghost')
      ? columns.findIndex((c) => c.classList.contains('wcghost'))
      : columns.findIndex((c) => c.classList.contains('wchd') && c.dataset.lane === lane);
    return at < 0 ? -50 : at * 100 + 45;
  };
  try {
    return fn(x);
  } finally {
    proto.getBoundingClientRect = real;
  }
}

/**
 * A card carried by its grip and released in `target`'s column, in the middle
 * of `target`'s row (`y` overrides it), over `over` (default `target`, which is
 * what a real hit test would find; the body when both are null). `x` overrides
 * the column's middle.
 */
function dropCard(
  p: Panel,
  id: string,
  target: Element | null,
  at: { y?: number; over?: Element | null; x?: number } = {}
): void {
  const doc = p.window.document;
  inColumns(p, (x) => {
    const over = at.over === undefined ? target : at.over;
    hitIs(p, over);
    const grip = doc.querySelector<HTMLElement>(`#wfeditor .wcnode[data-node="${id}"] .wegrip`);
    if (!grip) return;
    const row = Number((target as HTMLElement | null)?.dataset?.row);
    const y = at.y ?? (Number.isInteger(row) ? row * 100 + 45 : 10);
    const into = (over as HTMLElement | null) ?? doc.body;
    fire(p, grip, 'dragstart');
    // A browser raises `drop` only where the last `dragover` took it.
    if (fire(p, into, 'dragover', y, at.x ?? x(target)).defaultPrevented) {
      fire(p, into, 'drop', y, at.x ?? x(target));
    }
    fire(p, grip, 'dragend');
  });
}

/**
 * A drag event jsdom cannot make — it implements neither `DragEvent` nor
 * `DataTransfer`, so the transfer is a hand-made object on a plain `Event`
 * (same shim as `board.test.ts`).
 */
function fire(
  p: Panel,
  node: HTMLElement,
  type: string,
  clientY = 0,
  clientX = 0,
  // jsdom has no DataTransfer, so what the editor gets is whatever is built
  // here. A case that needs a method this mock omits adds it rather than
  // everything paying for it — `setDragImage` is only meaningful to one test,
  // and the editor calls it optionally for exactly that reason.
  equip?: (dt: Record<string, unknown>) => void
): Event {
  const ev = new p.window.Event(type, { bubbles: true, cancelable: true });
  const sent: Record<string, string> = {};
  const dt: Record<string, unknown> = {
    getData: (k: string) => sent[k] ?? '',
    setData: (k: string, v: string) => (sent[k] = v),
    effectAllowed: '',
    dropEffect: '',
    sent
  };
  equip?.(dt);
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  Object.defineProperty(ev, 'clientX', { value: clientX });
  node.dispatchEvent(ev);
  return ev;
}

/** What a `fire`d drag event ended up carrying. */
function payload(ev: Event): Record<string, string> {
  return (ev as unknown as { dataTransfer: { sent: Record<string, string> } }).dataTransfer.sent;
}

function grips(p: Panel): HTMLElement[] {
  return [...p.window.document.querySelectorAll<HTMLElement>('#wfeditor .wegrip')];
}

describe('workflow editor', () => {
  it('the column’s Add step is a tab stop', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    assert.equal(addSteps(p)[0]?.tabIndex, 0);
  });

  it('save after an Add step posts the new step with ids intact', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);

    addSteps(p)[0]?.click();
    const root = p.window.document.getElementById('wfeditor')!;
    const newName = root.querySelector<HTMLInputElement>(
      '.wcnode[data-node="step-1"] input.wctitle'
    );
    const newPrompt = root.querySelector<HTMLElement>('.wcnode[data-node="step-1"] .wcbody');
    assert.ok(newName && newPrompt);
    assert.equal(p.window.document.activeElement, newName, 'the caret lands in its name');
    newName.value = 'gate';
    newName.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    typeProse(p, newPrompt, 'confirm risk before implement');

    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    const posted = p.posted.filter((m) => m.type === 'saveWorkflow');
    assert.equal(posted.length, 1);
    const msg = posted[0];
    assert.ok(msg && msg.type === 'saveWorkflow');
    if (!msg || msg.type !== 'saveWorkflow') return;
    assert.deepEqual(
      msg.steps.map((s) => s.id),
      ['plan', 'build', 'review', 'step-1'],
      'the draft mints an id the canvas can open by'
    );
    assert.equal(msg.steps[3]?.label, 'gate');
    assert.equal(msg.steps[3]?.prompt, 'confirm risk before implement');
  });

  it('names a step closed before it was named, rather than drawing a blank node', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    const root = p.window.document.getElementById('wfeditor')!;
    root.querySelector<HTMLButtonElement>('.wcnode.editing .wcdone')?.click();

    const name = root.querySelector('.wcnode .wcname');
    assert.equal(name?.textContent, 'Untitled step');
    assert.ok(name?.classList.contains('empty'), 'drawn as a placeholder, not as a name');
  });

  /**
   * A step is one object. The grip and the badge used to be siblings of the
   * card in a three-column step, which meant the rail was drawn outside the
   * thing being dragged: two nodes to dim, two geometries to measure a drop
   * against, and a drop indicator that had to be routed around a line belonging
   * to no card. Inside, the card's border, padding and focus wash cover the
   * whole step, and the gutter between cards carries nothing.
   */
  it('draws a step as one node, grip and badge inside it', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    const root = p.window.document.getElementById('wfeditor')!;
    const step = root.querySelector<HTMLElement>('.wcnode[data-node="plan"]')!;

    assert.ok(step.querySelector(':scope > .wegrip'), 'grip is inside the node');
    assert.ok(step.querySelector('.wcg'), 'badge is inside the node');
    assert.ok(step.querySelector('.wcname'), 'a closed node shows its name');
    assert.equal(step.querySelector('.wcbody'), null, 'a closed node has no prompt field');
    openNode(p, 0);
    const open = p.window.document.querySelector<HTMLElement>('#wfeditor .wcnode.editing')!;
    assert.ok(open.querySelector('input.wctitle'));
    proseOf(open.querySelector('.wcbody'));
  });

  it('offers a reorder grip on every step, and only the grip is draggable', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    const g = grips(p);
    assert.equal(g.length, 3);
    assert.equal(g[0]?.getAttribute('draggable'), 'true');
    // Announced as nothing: it is not a tab stop and Enter does not work it, so
    // a `button` role would name a control a keyboard cannot reach.
    assert.equal(g[0]?.getAttribute('aria-hidden'), 'true');
    assert.equal(g[0]?.getAttribute('role'), null);
    // The card itself never carries the gesture — R2 is explicitly not this.
    assert.equal(
      p.window.document.querySelector('#wfeditor .wcnode')?.getAttribute('draggable'),
      null
    );
  });

  it('a grip drag lifts its step; a field keeps its own text drag', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    const root = p.window.document.getElementById('wfeditor')!;

    // Dragging a selection inside a prompt is the platform's text move. It
    // starts no reorder, and refusing it would take it away to prevent nothing.
    openNode(p, 0);
    const prompt = proseRoot(root.querySelector('.wcnode[data-node="plan"] .wcbody'));
    const native = fire(p, prompt, 'dragstart');
    assert.equal(native.defaultPrevented, false, 'native text drag survives');
    // A selection's drag starts on its text node, which has no `closest`.
    const text = prompt.querySelector('p')?.firstChild;
    assert.ok(text, 'no text in the prompt');
    const fromText = fire(p, text as unknown as HTMLElement, 'dragstart');
    assert.equal(fromText.defaultPrevented, false, 'a drag off the text itself survives');
    assert.equal(p.window.document.body.classList.contains('dragging-step'), false);

    // A press on Remove is a press, and it is prevented.
    openNode(p, 1);
    const rm = root.querySelector<HTMLElement>('.wcnode[data-node="build"] .werm')!;
    assert.equal(fire(p, rm, 'dragstart').defaultPrevented, true);

    const grip = grips(p)[0]!;
    const started = fire(p, grip, 'dragstart');
    assert.ok(p.window.document.body.classList.contains('dragging-step'));
    assert.ok(root.querySelector('.wcnode[data-node="plan"]')?.classList.contains('lifted'));
    // Never advertised as text: every editable on the page accepts text/plain,
    // and the dock's composer stays live under the editor.
    assert.deepEqual(payload(started), { 'application/x-squadron-step': 'plan' });

    fire(p, grip, 'dragend');
    assert.equal(p.window.document.body.classList.contains('dragging-step'), false);
    assert.equal(root.querySelector('.wcnode.lifted'), null);
  });

  const nodeOf = (p: Panel, id: string) =>
    p.window.document.querySelector(`#wfeditor .wcnode[data-node="${id}"]`);

  it('a grip drop on the lane’s Add step moves the step last and renumbers', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);

    dropCard(p, 'plan', p.window.document.querySelector('#wfeditor .wcaddstep[data-lane=""]'));
    assert.equal(stepNames(p).join(','), 'Build,Review,Plan');
    assert.equal(stepBadges(p).join(','), '1,2,3');
    assert.equal(p.window.document.body.classList.contains('dragging-step'), false);
  });

  it('a drop on a card above the carried one takes its row', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    dropCard(p, 'review', nodeOf(p, 'plan'));
    assert.equal(stepNames(p).join(','), 'Review,Plan,Build');
  });

  it('a drop back on its own card, or the gap under it, changes nothing', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    dropCard(p, 'build', nodeOf(p, 'build'));
    assert.equal(stepNames(p).join(','), 'Plan,Build,Review');
    // Build is lent [200, 290]: 292 is the gap under it, nearer Build than Review.
    dropCard(p, 'build', nodeOf(p, 'build'), { y: 292 });
    assert.equal(stepNames(p).join(','), 'Plan,Build,Review');
    assert.equal(p.window.document.querySelector('#wfeditor .wcwhy'), null);
  });

  it('a drop in the gap under a row lands in that row', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    // Review is lent [300, 390] and the Add step [400, 490]: 392 is Review's.
    dropCard(p, 'plan', nodeOf(p, 'review'), { y: 392 });
    assert.equal(stepNames(p).join(','), 'Build,Review,Plan');
  });

  it('lights the row a drop would land in, and nothing on its own card', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    const doc = p.window.document;
    const grid = doc.querySelector<HTMLElement>('#wfeditor .wcgrid')!;
    const lit = () => [...doc.querySelectorAll<HTMLElement>('#wfeditor .target')];
    inColumns(p, (x) => {
      const plan = nodeOf(p, 'plan');
      hitIs(p, plan);
      fire(p, grips(p)[0]!, 'dragstart');
      assert.deepEqual(lit(), [], 'nothing drawn before the pointer says where');

      const over = fire(p, grid, 'dragover', 345, x(plan));
      assert.deepEqual(lit(), [nodeOf(p, 'review')]);
      assert.equal(over.defaultPrevented, true, 'a row of its own column takes the drop');

      const own = fire(p, grid, 'dragover', 145, x(plan));
      assert.deepEqual(lit(), [], 'its own row is no move');
      assert.equal(own.defaultPrevented, false, 'and says so with the no-drop cursor');

      fire(p, grid, 'dragover', 345, x(plan));
      fire(p, grips(p)[0]!, 'dragend');
      assert.deepEqual(lit(), [], 'the release clears it');
    });
  });

  it('the drag carries the step, not the three bars it started on', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    // Read at the moment of the call, not after: the platform snapshots when
    // the handler returns, and `.lifted` is added before it does.
    let carried: Element | null = null;
    let dimmed: boolean | null = null;
    fire(p, grips(p)[1]!, 'dragstart', 0, 0, (dt) => {
      dt.setDragImage = (node: Element) => {
        carried = node;
        dimmed = node.classList.contains('lifted');
      };
    });
    assert.equal(
      carried,
      p.window.document.querySelector('#wfeditor .wcnode[data-node="build"]'),
      'the ghost under the cursor is the whole row'
    );
    assert.equal(dimmed, false, 'snapshotted before the row dims, or the ghost dims with it');
  });

  it('a release outside the list still ends the flight', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    fire(p, grips(p)[0]!, 'dragstart');
    assert.ok(p.window.document.body.classList.contains('dragging-step'));

    // Neither of the list's own terminal events fires when the release lands
    // outside the webview. Left set, every field in the form is pointer-dead.
    fire(p, p.window.document.body, 'dragend');
    assert.equal(p.window.document.body.classList.contains('dragging-step'), false);
    assert.equal(p.window.document.querySelector('#wfeditor .wcnode.lifted'), null);
  });

  it('Back during a drag leaves no flight behind', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    fire(p, grips(p)[0]!, 'dragstart');
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .weback')?.click();
    assert.equal(p.window.document.body.classList.contains('dragging-step'), false);
  });

  it('save after a grip drop posts the new order with ids intact', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    const root = p.window.document.getElementById('wfeditor')!;

    dropCard(p, 'review', nodeOf(p, 'plan'));

    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    const msg = p.posted.filter((m) => m.type === 'saveWorkflow')[0];
    assert.ok(msg && msg.type === 'saveWorkflow');
    if (!msg || msg.type !== 'saveWorkflow') return;
    assert.deepEqual(
      msg.steps.map((s) => s.id),
      ['review', 'plan', 'build'],
      'the dragged object carries its id past the splice'
    );
  });

  /**
   * Two lanes interleaved in step order, so a step's index in the draft is not
   * its place in its lane: the main lane is plan, build, review at 0, 2, 4 and
   * `s1` is docs, notes at 1, 3. A grip reorders inside its own lane
   * (`placeInLane`), so the row it lands in is its own lane's.
   */
  const twoLanes = workflowView({
    id: 'two',
    label: 'Two lanes',
    steps: [
      { id: 'plan', label: 'Plan', prompt: 'plan' },
      { id: 'docs', label: 'Docs', prompt: 'docs', lane: 's1', needs: ['plan'] },
      { id: 'build', label: 'Build', prompt: 'build', needs: ['plan'] },
      { id: 'notes', label: 'Notes', prompt: 'notes', lane: 's1', needs: ['docs'] },
      { id: 'review', label: 'Review', prompt: 'review', needs: ['build'] }
    ]
  });

  it('a grip drop lands at the lane’s row, not the draft index', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [twoLanes], models: LANE_MODELS }));
    editWorkflow(p, 'Two lanes');

    // Review onto Build's row: between Plan and Build in its lane. Two draft
    // indices up, but one lane row — read as two it overshoots to first.
    dropCard(p, 'review', nodeOf(p, 'build'));
    const main = [...p.window.document.querySelectorAll<HTMLElement>('#wfeditor .wcnode')]
      .filter((n) => n.dataset.lane !== 's1')
      .map((n) => n.dataset.node);
    assert.deepEqual(main, ['plan', 'review', 'build']);
  });

  it('a reorder and an Add step still compose', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);

    dropCard(p, 'review', nodeOf(p, 'plan'));
    assert.equal(stepNames(p).join(','), 'Review,Plan,Build');

    // Add step reads the new order: under Build, now the lane's last.
    addSteps(p)[0]?.click();
    assert.equal(stepNames(p).join(','), 'Review,Plan,Build,');
    assert.equal(stepBadges(p).join(','), '1,2,3,4');
  });

  it('a saving form refuses a grip drag', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    openNode(p, 0);
    const root = p.window.document.getElementById('wfeditor')!;
    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    assert.equal(root.querySelector<HTMLButtonElement>('.wesave')?.disabled, true, 'is saving');

    const live = p.window.document.getElementById('wfeditor')!;
    const grip = live.querySelector<HTMLElement>('.wegrip')!;
    assert.equal(grip.getAttribute('draggable'), 'false');
    fire(p, grip, 'dragstart');
    assert.equal(p.window.document.body.classList.contains('dragging-step'), false);
    assert.equal(stepNames(p).join(','), 'Plan,Build,Review');
  });

  /**
   * A prompt grows with its content, so typing changes how far the form
   * scrolls without ever firing a scroll — the one event the overlay thumb
   * used to listen for. Everything else about the thumb is geometry and stays
   * a hand-check; what is asserted here is only that typing repaints it.
   *
   * jsdom has no layout, so both dimensions read 0 and every paint takes the
   * "nothing to scroll" branch. The two stubs below are the smallest thing
   * that makes the other branch reachable; the numbers they return are not
   * what is under test, the fact that a keystroke re-reads them is.
   */
  it('a prompt that grows repaints the scroll thumb, with no scroll event', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    // Opening a node rebuilds the editor, so the body these dimensions are
    // stubbed on has to be the one still in the document.
    openNode(p, 0);
    const root = p.window.document.getElementById('wfeditor')!;
    const body = root.querySelector<HTMLElement>('.webody')!;
    const rail = root.querySelector<HTMLElement>('.wescroll')!;
    const thumb = root.querySelector<HTMLElement>('.wethumb')!;

    // Guard, so the assertion after the keystroke cannot pass vacuously: a
    // thumb only ever gets a height from a paint, and none has sized one here.
    assert.equal(thumb.style.height, '', 'no thumb sized yet');

    const fake = (el: HTMLElement, prop: string, value: number): void => {
      Object.defineProperty(el, prop, { value, configurable: true });
    };
    fake(body, 'clientHeight', 500);
    fake(body, 'scrollHeight', 2000);

    typeProse(
      p,
      root.querySelector('.wcnode[data-node="plan"] .wcbody'),
      'a prompt long enough to have grown'
    );

    assert.equal(rail.hidden, false, 'typing re-read the height');
    // Floor of the thumb, since a zero-height track cannot give it a share.
    assert.equal(thumb.style.height, '28px');
  });
});

/** The review of `ef6b3916`, as a reader of the editor meets it. */
describe('workflow editor after the v2 review', () => {
  it('never mints a new step an id the file already had', (t) => {
    const p = openPanel(t);
    const minted = workflowView({
      id: 'minted',
      label: 'Minted',
      steps: [
        { id: 'step-1', label: 'One', prompt: 'one' },
        { id: 'step-2', label: 'Two', prompt: 'two' }
      ]
    });
    p.push(stateMessage(board(), { workflows: [minted] }));
    editWorkflow(p, 'Minted');
    openNode(p, 1);
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcnode.editing .werm')?.click();
    addSteps(p)[0]?.click();
    const open = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    type(p, open?.querySelector('input.wctitle') ?? null, 'Three');
    type(p, open?.querySelector<HTMLElement>('.wcbody') ?? null, 'three');
    assert.deepEqual(
      save(p).steps.map((step) => step.id),
      ['step-1', 'step-3']
    );
  });

  it('offers a grip on every lane, and Remove once a step is open', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [review()], models: LANE_MODELS }));
    editWorkflow(p, 'Review loop');
    assert.equal(doc(p).querySelector('#wfeditor .werm'), null);
    assert.ok(grips(p).length > 0);
    openNode(p, 1);
    assert.equal(doc(p).querySelector('#wfeditor .wcnode.editing .werm')?.textContent, 'Remove');
    type(p, doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing .wcbody'), 'rewritten');
    assert.equal(save(p).steps.find((s) => s.id === 'wire')?.prompt, 'rewritten');
  });

  it('puts Remove to the left of Done, at the right of an open step', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    assert.equal(doc(p).querySelector('#wfeditor .werm'), null, 'a closed tile has no remove');
    assert.equal(doc(p).querySelector('#wfeditor .wchead')?.textContent?.includes('×'), false);

    const open = openNode(p, 1);
    const foot = open.querySelector('.wcfoot');
    if (!foot) throw new Error('an open step has no foot');
    assert.deepEqual(
      [...foot.querySelectorAll('button')].map((b) => b.textContent),
      ['Remove', 'Done']
    );
    assert.equal(open.querySelector('.wchead .werm'), null);
    assert.equal(p.window.getComputedStyle(foot).justifyContent, 'flex-end');
    const remove = foot.querySelector('button');
    assert.equal(remove?.getAttribute('aria-label'), 'Remove step 2');
    remove?.click();
    assert.deepEqual(stepNames(p), ['Plan', 'Review']);
  });

  it('draws no Remove on the step that starts the run', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [review()], models: LANE_MODELS }));
    editWorkflow(p, 'Review loop');
    const feet = (id: string) => {
      doc(p).querySelector<HTMLElement>(`#wfeditor .wcnode[data-node="${id}"]`)?.click();
      const open = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
      assert.equal(open?.dataset.node, id);
      const buttons = [...(open?.querySelectorAll('.wcfoot button') ?? [])];
      open?.querySelector<HTMLButtonElement>('.wcdone')?.click();
      return buttons.map((b) => b.textContent);
    };
    assert.deepEqual(feet('impl'), ['Done']);
    assert.deepEqual(feet('wire'), ['Remove', 'Done']);
    assert.deepEqual(feet('ui'), ['Remove', 'Done']);
    // Reordered, the step that now starts the run is the one without it.
    dropCard(p, 'wire', doc(p).querySelector('#wfeditor .wcnode[data-node="impl"]'));
    assert.deepEqual(feet('wire'), ['Done']);
    assert.deepEqual(feet('impl'), ['Remove', 'Done']);
  });

  it('names the starting session and where a peer opens', (t) => {
    const p = openPanel(t);
    openReview(p);
    const heads = [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wchd')];
    assert.equal(heads[0]?.querySelector('b')?.textContent, 'starting session');
    assert.equal(heads[0]?.querySelector('span')?.textContent, 'where you start it');
    assert.equal(heads[1]?.querySelector('span')?.textContent, 'opens at 2b');
    assert.equal(doc(p).querySelector('.wcbar'), null);
  });

  it('offers a new session on a one-step draft, in row 2', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    type(p, doc(p).querySelector<HTMLInputElement>('#wfeditor .wefield input'), 'Ship');
    type(p, doc(p).querySelector<HTMLInputElement>('#wfeditor input.wctitle'), 'Plan');
    type(p, doc(p).querySelector<HTMLElement>('#wfeditor .wcbody'), 'plan it');
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcghost .wcadd')?.click();
    const spawned = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    assert.equal(spawned?.querySelector('.wcg b')?.textContent, '2');
    type(p, spawned?.querySelector('input.wctitle') ?? null, 'Notes');
    type(p, spawned?.querySelector<HTMLElement>('.wcbody') ?? null, 'write them');
    const msg = save(p);
    const peer = msg.steps.find((s) => s.label === 'Notes');
    assert.equal(peer?.lane, 'session 1');
    assert.equal(peer?.needs, undefined);
  });

  it('draws an unwired session step dashed in row 2, over a grid of empty cells', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    type(p, doc(p).querySelector<HTMLInputElement>('#wfeditor input.wctitle'), 'Plan');
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcghost .wcadd')?.click();
    const notes = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-lane="session 1"]');
    // Row 1 is the header, so row 2 of steps is grid row 3.
    assert.equal(notes?.style.gridRow, '3');
    assert.equal(notes?.classList.contains('waiting'), true);
    assert.equal(notes?.querySelector('.wcwait')?.textContent, 'needs a wire');
    const at = (lane: string, row: number) =>
      doc(p).querySelector(`#wfeditor [data-lane="${lane}"][data-row="${row}"]:not(.wcnode)`);
    assert.equal(at('session 1', 1), null);
    assert.ok(at('', 2), 'no drop target under step 1');
    assert.ok(at('', 3), 'no cell one row past the deepest step');
    assert.equal(
      doc(p).querySelector('#wfeditor .wcnode[data-lane=""]')?.classList.contains('waiting'),
      false
    );
  });

  describe('a card dropped into a row', () => {
    const draftOf = (p: Panel, withSession: boolean) => {
      p.push(stateMessage(board(), { workflows: [] }));
      select(p);
      clickNew(p);
      type(p, doc(p).querySelector<HTMLInputElement>('#wfeditor .wefield input'), 'Rows');
      type(p, doc(p).querySelector<HTMLInputElement>('#wfeditor input.wctitle'), 'Plan');
      type(p, doc(p).querySelector<HTMLElement>('#wfeditor .wcbody'), 'plan it');
      if (withSession) {
        doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcghost .wcadd')?.click();
      } else {
        addSteps(p)[0]?.click();
      }
      const added = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
      type(p, added?.querySelector('input.wctitle') ?? null, 'Build');
      type(p, added?.querySelector<HTMLElement>('.wcbody') ?? null, 'build it');
      added?.querySelector<HTMLButtonElement>('.wcdone')?.click();
    };
    const nodeOf = (p: Panel, label: string) =>
      [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wcnode')].find((n) =>
        n.textContent?.includes(label)
      ) ?? null;
    const cell = (p: Panel, lane: string, row: number) =>
      doc(p).querySelector(`#wfeditor [data-lane="${lane}"][data-row="${row}"]:not(.wcnode)`);

    it('takes a card of its own column’s row, and puts it there', (t) => {
      const p = openPanel(t);
      draftOf(p, false);
      const build = nodeOf(p, 'Build')?.dataset.node ?? '';
      dropCard(p, build, nodeOf(p, 'Plan'));
      const msg = save(p);
      assert.deepEqual(
        msg.steps.map((s) => s.label),
        ['Build', 'Plan']
      );
    });

    it('refuses a row with no step of its column above it, in the card', (t) => {
      const p = openPanel(t);
      draftOf(p, true);
      const plan = nodeOf(p, 'Plan')?.dataset.node ?? '';
      dropCard(p, plan, cell(p, '', 3));
      assert.equal(
        nodeOf(p, 'Plan')?.querySelector('.wcwhy')?.textContent,
        'Draw a wire from a row-2 step to put it here.'
      );
    });

    it('takes a lower row of its own column as though it were lifted out', (t) => {
      const p = openPanel(t);
      draftOf(p, false);
      const plan = nodeOf(p, 'Plan')?.dataset.node ?? '';
      dropCard(p, plan, nodeOf(p, 'Build'));
      assert.deepEqual(
        save(p).steps.map((s) => s.label),
        ['Build', 'Plan']
      );
    });

    it('leaves the last step where it is when dropped on its own Add step', (t) => {
      const p = openPanel(t);
      draftOf(p, false);
      const build = nodeOf(p, 'Build')?.dataset.node ?? '';
      dropCard(p, build, doc(p).querySelector('#wfeditor .wcaddstep[data-lane=""]'));
      assert.equal(nodeOf(p, 'Build')?.querySelector('.wcwhy'), null);
    });

    it('says which wire keeps a card below the row it was dropped in', (t) => {
      const p = openPanel(t);
      const held = workflowView({
        id: 'held',
        label: 'Held',
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'p' },
          { id: 'n', label: 'Note', prompt: 'n', lane: 's1', needs: ['plan'] },
          { id: 'n2', label: 'Note again', prompt: 'n', lane: 's1', needs: ['n'] },
          { id: 'build', label: 'Build', prompt: 'b', needs: ['plan', 'n2'] }
        ]
      });
      p.push(stateMessage(board(), { workflows: [held] }));
      editWorkflow(p, 'Held');
      dropCard(p, 'build', cell(p, '', 2));
      assert.equal(
        nodeOf(p, 'Build')?.querySelector('.wcwhy')?.textContent,
        'Kept in row 4: it waits on Note again. Delete that wire to move it up.'
      );
    });

    // `b` and `c` share tier 2, so it is two rows tall and `d` is drawn in row
    // 4 while its tier is 3. Read by tier, the row above `d`'s held `d` itself.
    it('places a card after the step drawn above it, below a tier two rows tall', (t) => {
      const p = openPanel(t);
      const tall = workflowView({
        id: 'tall',
        label: 'Tall',
        steps: [
          { id: 'a', label: 'A', prompt: 'a' },
          { id: 'b', label: 'B', prompt: 'b', needs: ['a'] },
          { id: 'c', label: 'C', prompt: 'c', needs: ['a'] },
          { id: 'd', label: 'D', prompt: 'd', needs: ['b'] },
          { id: 'e', label: 'E', prompt: 'e', needs: ['d'] }
        ]
      });
      p.push(stateMessage(board(), { workflows: [tall] }));
      editWorkflow(p, 'Tall');
      const d = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="d"]');
      assert.equal(d?.dataset.row, '4');
      dropCard(p, 'e', d);
      const wire = (from: string, to: string) =>
        doc(p).querySelector(`#wfeditor path.wchit[data-from="${from}"][data-to="${to}"]`);
      assert.ok(wire('c', 'e'), 'it waits on the step drawn in row 3');
      assert.equal(wire('d', 'e'), null);
    });
  });

  it('adds the next step in this session, then a session beside a wired draft', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    const name = doc(p).querySelector<HTMLInputElement>('#wfeditor .wefield input');
    const stepName = doc(p).querySelector<HTMLInputElement>('#wfeditor input.wctitle');
    const prompt = doc(p).querySelector<HTMLElement>('#wfeditor .wcbody');
    type(p, name, 'Ship');
    type(p, stepName, 'Plan');
    type(p, prompt, 'plan it');
    addSteps(p)[0]?.click();
    const added = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    type(p, added?.querySelector('input.wctitle') ?? null, 'Build');
    type(p, added?.querySelector<HTMLElement>('.wcbody') ?? null, 'build it');
    assert.ok(doc(p).querySelector('#wfeditor .wcadd'));
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcadd')?.click();
    const spawned = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    type(p, spawned?.querySelector('input.wctitle') ?? null, 'Notes');
    type(p, spawned?.querySelector<HTMLElement>('.wcbody') ?? null, 'write them');
    const msg = save(p);
    const peer = msg.steps.find((s) => s.label === 'Notes');
    assert.equal(peer?.lane, 'session 1');
    assert.equal(peer?.needs, undefined);
    assert.deepEqual(msg.steps.find((s) => s.label === 'Build')?.needs, ['step-1']);
    assert.equal(doc(p).querySelector('.wcbar'), null);
  });

  describe('a card released outside its own column', () => {
    // PRD §5.3, 2026-10-05.
    // Lane one runs three deep, and s1 has one step in row 2: rows 3 and 4 of
    // s1 are its Add step and an empty cell with no s1 step above it.
    const steps = [
      { id: 'plan', label: 'Plan', prompt: 'plan' },
      { id: 'build', label: 'Build', prompt: 'build', needs: ['plan'] },
      { id: 'ship', label: 'Ship', prompt: 'ship', needs: ['build'] },
      { id: 'docs', label: 'Docs', prompt: 'docs', lane: 's1', needs: ['plan'] }
    ];
    const deep = (p: Panel) => {
      p.push(
        stateMessage(board(), { workflows: [workflowView({ id: 'deep', label: 'Deep', steps })] })
      );
      editWorkflow(p, 'Deep');
    };
    const shape = (list: readonly { id?: string; lane?: string; needs?: string[] }[]) =>
      list.map((s) => ({ id: s.id, lane: s.lane, needs: s.needs }));
    const unmoved = (p: Panel) => {
      assert.equal(doc(p).querySelector('#wfeditor .wcwhy'), null);
      const heads = [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wchd')];
      assert.deepEqual(
        heads.map((h) => h.dataset.lane),
        ['', 's1']
      );
      assert.deepEqual(shape(save(p).steps), shape(steps));
    };

    it('stays in its lane when released on another session’s card', (t) => {
      const p = openPanel(t);
      deep(p);
      dropCard(p, 'build', doc(p).querySelector('#wfeditor .wcnode[data-node="docs"]'));
      dropCard(p, 'docs', doc(p).querySelector('#wfeditor .wcnode[data-node="build"]'));
      unmoved(p);
    });

    it('stays in its lane when released on an empty row of another session', (t) => {
      const p = openPanel(t);
      deep(p);
      dropCard(p, 'build', doc(p).querySelector('#wfeditor .wccell[data-lane="s1"][data-row="4"]'));
      const s1 = doc(p).querySelector('#wfeditor .wchd[data-lane="s1"]');
      dropCard(p, 'build', s1, { y: 500, over: doc(p).querySelector('#wfeditor .wcgrid') });
      unmoved(p);
    });

    it('opens no session when released on the new-session tile', (t) => {
      const p = openPanel(t);
      deep(p);
      const ghost = doc(p).querySelector('#wfeditor .wcghost');
      const grid = doc(p).querySelector('#wfeditor .wcgrid');
      dropCard(p, 'build', ghost);
      dropCard(p, 'plan', ghost, { y: 500, over: grid });
      dropCard(p, 'docs', ghost);
      unmoved(p);
    });

    it('moves nothing when released outside the canvas', (t) => {
      const p = openPanel(t);
      deep(p);
      const cell = doc(p).querySelector('#wfeditor .wccell[data-lane="s1"][data-row="4"]');
      const grid = doc(p).querySelector('#wfeditor .wcgrid');
      dropCard(p, 'build', null);
      // Level with s1, but over the dock: the grid runs on unclipped under it.
      dropCard(p, 'build', cell, { over: doc(p).body });
      dropCard(p, 'build', cell, { y: 2000 });
      // Blank canvas past the new-session tile, on a board wider than its columns.
      dropCard(p, 'build', null, { over: grid, x: 600 });
      unmoved(p);
    });

    it('clears an earlier drop’s refusal when it snaps back', (t) => {
      const p = openPanel(t);
      deep(p);
      // No s1 step in row 3, so row 4 refuses — and says so on Docs.
      dropCard(p, 'docs', doc(p).querySelector('#wfeditor .wccell[data-lane="s1"][data-row="4"]'));
      assert.ok(doc(p).querySelector('#wfeditor .wcnode[data-node="docs"] .wcwhy'));
      // Released in another column, it goes back; the old note is not its reason.
      dropCard(p, 'docs', doc(p).querySelector('#wfeditor .wcnode[data-node="build"]'));
      unmoved(p);
    });

    it('lights nothing in another column, and its own rows', (t) => {
      const p = openPanel(t);
      deep(p);
      const cell = doc(p).querySelector('#wfeditor .wccell[data-lane="s1"][data-row="4"]');
      const own = doc(p).querySelector('#wfeditor .wcaddstep[data-lane=""]');
      const ghost = doc(p).querySelector('#wfeditor .wcghost');
      const grid = doc(p).querySelector<HTMLElement>('#wfeditor .wcgrid')!;
      inColumns(p, (x) => {
        fire(
          p,
          doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="build"] .wegrip')!,
          'dragstart'
        );
        for (const target of [cell, ghost]) {
          hitIs(p, target);
          fire(p, grid, 'dragover', 445, x(target));
          assert.equal(doc(p).querySelector('#wfeditor .target'), null);
        }
        hitIs(p, own);
        fire(p, grid, 'dragover', 445, x(own));
        assert.ok(own?.matches('.target'));
        assert.equal(doc(p).querySelector('#wfeditor .wchd.target'), null);
      });
    });
  });

  it('draws no lane menu and no needs chips in an open card', (t) => {
    const p = openPanel(t);
    openReview(p);
    openNode(p, 1);
    assert.equal(
      doc(p).querySelector('#wfeditor .wckeys, #wfeditor .wcsel, #wfeditor .wcneed'),
      null
    );
  });

  it('refuses a blank or taken lane name', (t) => {
    const p = openPanel(t);
    openReview(p);
    const rename = (value: string): void => {
      doc(p)
        .querySelector<HTMLButtonElement>('#wfeditor .wchd[data-lane="s1"] button.name')
        ?.click();
      const input = doc(p).querySelector<HTMLInputElement>(
        '#wfeditor .wchd[data-lane="s1"] input.name'
      );
      if (!input) throw new Error('the lane name did not open');
      input.value = value;
      input.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    };
    rename('s2');
    assert.match(doc(p).querySelector('#wfeditor .wchd .wcwhy')?.textContent ?? '', /s2 is taken/);
    rename('');
    assert.match(
      doc(p).querySelector('#wfeditor .wchd .wcwhy')?.textContent ?? '',
      /a lane needs a name/
    );
    rename('builder');
    assert.equal(
      save(p)
        .steps.filter((s) => s.lane === 'builder')
        .map((s) => s.id)
        .join(','),
      'ui,au'
    );
  });

  it('a deleted step leaves a step in another session unwired', (t) => {
    const p = openPanel(t);
    openReview(p);
    doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="wire"]')?.click();
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcnode[data-node="wire"] .werm')?.click();
    const msg = save(p);
    assert.equal(msg.steps.find((s) => s.id === 'rw')?.needs, undefined);
    assert.deepEqual(msg.steps.find((s) => s.id === 'aw')?.needs, ['rw', 'impl']);
    assert.equal(
      msg.steps.find((s) => s.id === 'wire'),
      undefined
    );
  });

  it('draws no + session on a card, closed or open', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    assert.equal(doc(p).querySelector('#wfeditor .wctool'), null);
    openNode(p, 1);
    const words = [...doc(p).querySelectorAll('#wfeditor .wcnode.editing button')].map(
      (b) => b.textContent
    );
    assert.equal(words.includes('+ session'), false);
  });

  it('names one past the highest session, not the gap between 1 and 3', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'gaps',
      label: 'Gaps',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'a', label: 'One', prompt: 'one', lane: 'session 1', needs: ['plan'] },
        { id: 'c', label: 'Three', prompt: 'three', lane: 'session 3', needs: ['plan'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Gaps');
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcadd')?.click();
    const spawned = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    type(p, spawned?.querySelector('input.wctitle') ?? null, 'Two');
    type(p, spawned?.querySelector<HTMLElement>('.wcbody') ?? null, 'two');
    const peer = save(p).steps.find((s) => s.label === 'Two');
    assert.equal(peer?.lane, 'session 4');
    assert.equal(peer?.needs, undefined);
  });

  // A lane's column is when it was added, not the row it opens on: an unwired
  // new session sits on row 2 and used to take session 1's column from under it.
  it('adds a new session as the last column, after a lane that opens lower', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'late',
      label: 'Late',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'mock', label: 'Mock', prompt: 'mock', needs: ['plan'] },
        { id: 'impl', label: 'Impl', prompt: 'impl', needs: ['mock'] },
        { id: 'ra', label: 'Review', prompt: 'review', needs: ['impl'] },
        { id: 'rb', label: 'Peer', prompt: 'peer', lane: 'session 1', needs: ['impl'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Late');
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcghost .wcadd')?.click();
    const heads = () =>
      [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wchd')].map((h) => h.dataset.lane);
    assert.deepEqual(heads(), ['', 'session 1', 'session 2']);
    const spawned = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    type(p, spawned?.querySelector('input.wctitle') ?? null, 'Notes');
    type(p, spawned?.querySelector<HTMLElement>('.wcbody') ?? null, 'notes');
    assert.deepEqual(save(p).lanes, ['session 1', 'session 2']);
  });

  it('draws the lanes in the order the file lists them, not the order they open', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'listed',
      label: 'Listed',
      lanes: ['session 2', 'session 1'],
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'a', label: 'One', prompt: 'one', lane: 'session 1', needs: ['plan'] },
        { id: 'b', label: 'Two', prompt: 'two', lane: 'session 2', needs: ['a'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Listed');
    const heads = [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wchd')].map(
      (h) => h.dataset.lane
    );
    assert.deepEqual(heads, ['', 'session 2', 'session 1']);
  });

  it('drops an emptied lane from the order and still adds the next session last', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'reused',
      label: 'Reused',
      lanes: ['session 1', 'session 2'],
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'a', label: 'One', prompt: 'one', lane: 'session 1', needs: ['plan'] },
        { id: 'b', label: 'Two', prompt: 'two', lane: 'session 2', needs: ['plan'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Reused');
    doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="a"]')?.click();
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcnode[data-node="a"] .werm')?.click();
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcghost .wcadd')?.click();
    const heads = [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wchd')].map(
      (h) => h.dataset.lane
    );
    assert.deepEqual(heads, ['', 'session 2', 'session 3']);
  });

  // Run order says session 2 first, so only the list keeps session 1 ahead.
  it('keeps a renamed lane in its column, and saves the new name', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'renamed',
      label: 'Renamed',
      lanes: ['session 1', 'session 2'],
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'b', label: 'Two', prompt: 'two', lane: 'session 2', needs: ['plan'] },
        { id: 'a', label: 'One', prompt: 'one', lane: 'session 1', needs: ['b'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Renamed');
    const name = doc(p).querySelector<HTMLElement>(
      '#wfeditor .wchd[data-lane="session 1"] button.name'
    );
    name?.click();
    const input = doc(p).querySelector<HTMLInputElement>('#wfeditor .wchd input');
    if (!input) throw new Error('no lane name field');
    input.value = 'writer';
    key(p, input, 'Enter');
    const heads = [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wchd')].map(
      (h) => h.dataset.lane
    );
    assert.deepEqual(heads, ['', 'writer', 'session 2']);
    assert.deepEqual(save(p).lanes, ['writer', 'session 2']);
  });

  it('keeps a lane renamed to s0 in its own column', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'esszero',
      label: 'Ess zero',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'docs', label: 'Docs', prompt: 'docs', lane: 'session 1', needs: ['plan'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Ess zero');
    const name = doc(p).querySelector<HTMLElement>(
      '#wfeditor .wchd[data-lane="session 1"] button.name'
    );
    name?.click();
    const input = doc(p).querySelector<HTMLInputElement>('#wfeditor .wchd input');
    if (!input) throw new Error('no lane name field');
    input.value = 's0';
    key(p, input, 'Enter');
    const peer = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="docs"]');
    const armed = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="plan"]');
    const head = doc(p).querySelector<HTMLElement>('#wfeditor .wchd[data-lane="s0"]');
    assert.equal(head?.dataset.lane, 's0');
    assert.equal(peer?.dataset.lane, 's0');
    assert.equal(armed?.dataset.lane, '');
    assert.notEqual(armed?.style.gridColumn, peer?.style.gridColumn);
    assert.equal(head?.style.gridColumn, peer?.style.gridColumn);
    assert.equal(
      addSteps(p).find((slot) => slot.dataset.lane === 's0')?.style.gridColumn,
      peer?.style.gridColumn
    );
  });

  it('keeps the canvas’s sideways place across a rebuild, and not into another workflow', (t) => {
    const p = openPanel(t);
    const wide = workflowView({
      id: 'wide',
      label: 'Wide',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['a'] },
        { id: 'c', label: 'C', prompt: 'c', lane: 'builder', needs: ['a'] }
      ]
    });
    const other = workflowView({
      id: 'other',
      label: 'Other',
      steps: [{ id: 'z', label: 'Z', prompt: 'z' }]
    });
    p.push(stateMessage(board(), { workflows: [wide, other] }));
    editWorkflow(p, 'Wide');
    const scroller = (): HTMLElement | null =>
      doc(p).querySelector<HTMLElement>('#wfeditor .wcscroll');
    const first = scroller();
    if (!first) throw new Error('no canvas scroller');
    first.scrollLeft = 408;
    doc(p)
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="a"][data-to="c"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wirex')?.click();
    const rebuilt = scroller();
    assert.equal(
      doc(p).querySelector('#wfeditor path.wchit[data-from="a"][data-to="c"]'),
      null,
      'the wire was removed'
    );
    assert.notEqual(rebuilt, first, 'the scroller was rebuilt');
    assert.equal(rebuilt?.scrollLeft, 408);

    attachWorkflow(p, 'Other');
    doc(p).querySelector<HTMLElement>('#wattach .wflow .wedit')?.click();
    assert.equal(scroller()?.scrollLeft, 0, 'another workflow starts at the left');

    const second = scroller();
    if (!second) throw new Error('no scroller on the other workflow');
    second.scrollLeft = 200;
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .weback')?.click();
    editWorkflow(p, 'Wide');
    assert.equal(scroller()?.scrollLeft, 0, 'closing the editor drops the place');
  });

  it('puts a lane whose name is not a CSS identifier in its own column', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    type(p, doc(p).querySelector<HTMLInputElement>('#wfeditor input.wctitle'), 'Plan');
    doc(p).querySelector<HTMLButtonElement>('#wfeditor .wcghost .wcadd')?.click();
    // A space in the lane name used to be the custom property Chromium dropped,
    // so the card auto-placed. The column is the track index; the name stays
    // on `data-lane`.
    const notes = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-lane="session 1"]');
    const armed = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-lane=""]');
    assert.equal(notes?.dataset.lane, 'session 1');
    assert.equal(armed?.style.gridColumn, '1');
    assert.equal(notes?.style.gridColumn, '2');
    const slot = addSteps(p).find((s) => s.dataset.lane === 'session 1');
    assert.equal(slot?.style.gridColumn, '2');
    const head = doc(p).querySelector<HTMLElement>('#wfeditor .wchd[data-lane="session 1"]');
    assert.equal(head?.style.gridColumn, '2');
  });

  it('ends a card drag when the editor is rebuilt under it', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'trio',
      label: 'Trio',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'build', label: 'Build', prompt: 'build', needs: ['plan'] },
        { id: 'docs', label: 'Docs', prompt: 'docs', lane: 's1', needs: ['plan'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Trio');
    const grip = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode[data-node="build"] .wegrip')!;
    fire(p, grip, 'dragstart');
    // The rebuild detaches the grip, so its own dragend would reach nobody.
    openNode(p, 0);
    assert.equal(doc(p).body.classList.contains('dragging-step'), false);
    assert.equal(doc(p).querySelector('#wfeditor .wcnode.lifted'), null);
    const grid = doc(p).querySelector<HTMLElement>('#wfeditor .wcgrid')!;
    inColumns(p, (x) => {
      const plan = doc(p).querySelector('#wfeditor .wcnode[data-node="plan"]');
      hitIs(p, plan);
      fire(p, grid, 'drop', 145, x(plan));
    });
    assert.deepEqual(
      save(p).steps.map((s) => s.id),
      ['plan', 'build', 'docs']
    );
  });

  it('moves nothing while a save is in flight', (t) => {
    const p = openPanel(t);
    const file = workflowView({
      id: 'trio',
      label: 'Trio',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'build', label: 'Build', prompt: 'build', needs: ['plan'] },
        { id: 'docs', label: 'Docs', prompt: 'docs', lane: 's1', needs: ['plan'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [file] }));
    editWorkflow(p, 'Trio');
    save(p);
    // Save is in flight now: a drop may not change what was posted.
    dropCard(p, 'build', doc(p).querySelector('#wfeditor .wcnode[data-node="plan"]'));
    drawWire(p, 'docs', 'build');
    assert.deepEqual(
      [...doc(p).querySelectorAll<HTMLElement>('#wfeditor .wcnode')].map((n) => n.dataset.node),
      ['plan', 'build', 'docs']
    );
    assert.equal(
      doc(p).querySelector('#wfeditor .wcnode[data-node="build"]')?.getAttribute('data-lane'),
      ''
    );
  });

  it('a grip drop to the top of a review lane keeps the chain rule', (t) => {
    const p = openPanel(t);
    openReview(p);

    // Wiring onto Implement's row: first in this session's lane.
    dropCard(p, 'wire', doc(p).querySelector('#wfeditor .wcnode[data-node="impl"]'));
    assert.equal(doc(p).querySelector('#wfeditor .wcnode')?.getAttribute('data-node'), 'wire');
    // aw still waited on the old order, so the chain is what blocks Save.
    assert.equal(doc(p).querySelector<HTMLButtonElement>('#wfeditor .wesave')?.disabled, true);
    assert.match(
      doc(p).querySelector('#wfeditor .wcnode[data-node="aw"] .wcwhy')?.textContent ?? '',
      /aw does not follow impl/
    );
  });

  it('opens a closed node from the keyboard, and only from the node itself', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    const node = (id: string) =>
      doc(p).querySelector<HTMLElement>(`#wfeditor .wcnode[data-node="${id}"]`);
    assert.equal(node('build')?.getAttribute('role'), 'button');
    assert.equal(node('build')?.tabIndex, 0);

    const remove = node('build')?.querySelector('.werm');
    if (remove) key(p, remove, 'Enter');
    assert.equal(node('build')?.querySelector('.wcbody'), null, 'Enter on the × is the ×’s own');

    const one = node('build');
    if (one) key(p, one, 'Enter');
    assert.ok(node('build')?.querySelector('.wcbody'), 'Enter opens it');
    assert.equal(doc(p).activeElement, node('build')?.querySelector('input.wctitle'));
    node('build')?.querySelector<HTMLButtonElement>('.wcdone')?.click();
    assert.equal(node('build')?.querySelector('.wcbody'), null);
    assert.equal(doc(p).activeElement, node('build'), 'Done hands focus back to the node');

    const two = node('review');
    if (two) key(p, two, ' ');
    assert.ok(node('review')?.querySelector('.wcbody'), 'Space opens it');
  });

  it('draws an Add step under each lane’s last step, on the row after it', (t) => {
    const p = openPanel(t);
    openReview(p);
    const slots = addSteps(p);
    assert.equal(slots.length, 4);
    const row = (id: string): number =>
      Number(
        doc(p).querySelector<HTMLElement>(`#wfeditor .wcnode[data-node="${id}"]`)?.style.gridRow
      );
    const s1 = slots.find((s) => s.dataset.lane === 's1');
    assert.equal(s1?.style.gridColumn, '2');
    assert.equal(Number(s1?.style.gridRow), row('au') + 1);
    const armed = slots.find((s) => s.dataset.lane === '');
    assert.equal(armed?.style.gridColumn, '1');
    assert.equal(Number(armed?.style.gridRow), row('ship') + 1);
  });

  it('a lane’s Add step adds a step in that lane, after its last', (t) => {
    const p = openPanel(t);
    openReview(p);
    addSteps(p)
      .find((s) => s.dataset.lane === 's1')
      ?.click();
    const open = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    type(p, open?.querySelector('input.wctitle') ?? null, 'Polish');
    type(p, open?.querySelector<HTMLElement>('.wcbody') ?? null, 'polish the UI');
    const added = save(p).steps.find((s) => s.label === 'Polish');
    assert.equal(added?.lane, 's1');
    assert.deepEqual(added?.needs, ['au']);
  });

  it('a one-step draft has one Add step and the new-session tile', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    assert.equal(addSteps(p).length, 1);
    const ghost = doc(p).querySelector<HTMLElement>('#wfeditor .wcghost');
    assert.equal(ghost?.style.gridColumn, '2');
    assert.equal(ghost?.style.gridRow, '2', 'on the first step row, the size of a step');
  });

  it('never draws a step’s prompt under five lines', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    // Sized to its content: the floor is what holds an empty one open, on the
    // editing root, so a press anywhere in it lands in the text.
    const root = doc(p).querySelector<HTMLElement>('#wfeditor .wcbody .ProseMirror');
    assert.ok(root);
    assert.equal(p.window.getComputedStyle(root).minHeight, '5lh');
  });

  it('puts + New session in a ghost column after the last lane, not in the bar', (t) => {
    const p = openPanel(t);
    openReview(p);
    const ghost = doc(p).querySelector<HTMLElement>('#wfeditor .wcghost');
    assert.equal(ghost?.style.gridColumn, '5');
    assert.ok(ghost?.querySelector('.wcadd'));
    assert.equal(doc(p).querySelector('#wfeditor .wcbar'), null);
  });

  it('this session’s Add step on a chain appends and writes the chain', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);
    addSteps(p)[0]?.click();
    assert.equal(stepBadges(p).join(','), '1,2,3,4');
    const names = stepNames(p);
    assert.equal(names[3], '');
    assert.equal(names[0], 'Plan');
    assert.equal(names[2], 'Review');
    const open = doc(p).querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    type(p, open?.querySelector('input.wctitle') ?? null, 'Ship');
    type(p, open?.querySelector<HTMLElement>('.wcbody') ?? null, 'ship it');
    const added = save(p).steps.at(-1);
    assert.deepEqual(added?.needs, ['review']);
    assert.equal(added?.lane, undefined);
  });
});
