import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { css as editorCss } from '../../ui/css/editor';
import { css as canvasCss } from '../../ui/css/wfcanvas';
import { toCanvas } from '../../webview/wfgraph';
import type { CanvasSource } from '../../webview/wfgraph';
import { openPanel, proseOf, proseRoot, typeProse, workflowView } from '../harness';
import type { Panel } from '../harness';
import { openReview, openWorkflow } from './workflow_review';

/**
 * The lane canvas, through the editor that mounts it.
 *
 * **Structure only.** jsdom lays nothing out, so nothing here may claim a
 * pixel: the two-line clamp, the 10px track bleed, four lanes overflowing the
 * board and every wire coordinate are hand-checked in a real host, and the
 * geometry that *can* be checked lives in `wfroute.test.ts` against
 * rectangles. What this file is for is the arithmetic made visible as DOM —
 * which lane a node lands in, which rows a track spans, and which nodes carry
 * a model chip.
 */

/** Five steps, one lane: the armed session, and nothing that opens another. */
const solo = (): WorkflowView =>
  workflowView({
    id: 'solo',
    label: 'One lane',
    steps: [
      { id: 'a', label: 'Read the task', prompt: 'Read it.' },
      { id: 'b', label: 'Make the change', prompt: 'Change it.', needs: ['a'] },
      { id: 'c', label: 'Run the gate', prompt: 'Run it.', needs: ['b'] },
      { id: 'd', label: 'Review your own diff', prompt: 'Review it.', needs: ['c'] },
      { id: 'e', label: 'Commit', prompt: 'Commit it.', needs: ['d'] }
    ]
  });

/** One step is a grid like any other. */
const one = (): WorkflowView =>
  workflowView({
    id: 'one',
    label: 'One step',
    steps: [
      { id: 'only', label: 'Do the thing', prompt: 'One step is a prompt with a name on it.' }
    ]
  });

const canvas = (p: Panel): HTMLElement => {
  const node = p.window.document.getElementById('wfcanvas');
  assert.ok(node, 'no #wfcanvas in the document');
  return node;
};

const nodes = (p: Panel): HTMLElement[] => [...canvas(p).querySelectorAll<HTMLElement>('.wcnode')];

const byId = (p: Panel, id: string): HTMLElement => {
  const node = canvas(p).querySelector<HTMLElement>(`[data-node="${id}"]`);
  assert.ok(node, `no node ${id}`);
  return node;
};

describe('the workflow lane canvas', () => {
  it('renders every step of the review as a closed node', (t) => {
    const p = openPanel(t);
    openReview(p);
    assert.equal(nodes(p).length, 11);
    // Closed is the default face: title and description as prose, no fields.
    // The workflow name sits outside the canvas, so the count is the canvas's.
    assert.equal(canvas(p).querySelectorAll('textarea').length, 0);
    assert.equal(canvas(p).querySelectorAll('input').length, 0);
    assert.equal(byId(p, 'impl').querySelector('.wcname')?.textContent, 'Implement this task');
    assert.equal(
      byId(p, 'impl').querySelector('.wcdesc')?.textContent,
      'Read the task and split it.'
    );
  });

  it('puts a node in its lane’s column and its depth’s row', (t) => {
    const p = openPanel(t);
    openReview(p);
    // Row 1 is the header. Depth 0 is the first step row, so a node at depth 0
    // is on row 2.
    assert.equal(byId(p, 'impl').style.gridRow, '2');
    assert.equal(byId(p, 'impl').style.gridColumn, '1');
    // `ui` is depth 1 in the first peer lane; `ship` is the last tier, back in
    // the armed session's own lane.
    assert.equal(byId(p, 'ui').style.gridRow, '3');
    assert.equal(byId(p, 'ui').style.gridColumn, '2');
    assert.equal(byId(p, 'ship').style.gridRow, '8');
    assert.equal(byId(p, 'ship').style.gridColumn, '1');
  });

  it('draws one column per lane and one header per session', (t) => {
    const p = openPanel(t);
    openReview(p);
    const pipe = canvas(p).querySelector<HTMLElement>('.wcpipe');
    assert.equal(pipe?.style.getPropertyValue('--wc-lanes'), '4');
    assert.equal(canvas(p).querySelectorAll<HTMLElement>('.wchd')[3]?.style.gridColumn, '4');
    assert.equal(pipe?.classList.contains('onelane'), false, 'four lanes keep the lane floor');
    const heads = [...canvas(p).querySelectorAll<HTMLElement>('.wchd')];
    assert.equal(heads.length, 4);
    assert.deepEqual(
      heads.map((h) => h.style.gridRow),
      ['1', '1', '1', '1']
    );
    assert.equal(canvas(p).querySelectorAll('.wclane').length, 0);
    // One divider per gap. The ghost column is a gap too, so four lanes draw four.
    assert.equal(canvas(p).querySelectorAll('.wcdiv').length, 4);
  });

  it('names the armed session apart from the lanes a file named', (t) => {
    const p = openPanel(t);
    openReview(p);
    const heads = [...canvas(p).querySelectorAll<HTMLElement>('.wchd')];
    assert.equal(heads[0]?.classList.contains('armed'), true);
    assert.deepEqual(
      heads.slice(1).map((h) => h.classList.contains('armed')),
      [false, false, false]
    );
    assert.equal(heads[0]?.querySelector('b')?.textContent, 'starting session');
    assert.equal(heads[0]?.querySelector('span')?.textContent, 'where you start it');
    // A peer's name is a button. The file's own lane name, not `session ${index}`.
    assert.equal(heads[3]?.querySelector('button.name')?.textContent, 's3');
    assert.equal(heads[1]?.querySelector('span')?.textContent, 'opens at 2b');
    assert.equal(heads[2]?.querySelector('span')?.textContent, 'opens at 3a');
    assert.equal(heads[3]?.querySelector('span')?.textContent, 'opens at 3b');
  });

  it('draws no session count above the columns', (t) => {
    const p = openPanel(t);
    openReview(p);
    assert.equal(canvas(p).querySelector('.wcbar'), null);
  });

  it('puts the model chip on the node that opens a lane, and on no other', (t) => {
    const p = openPanel(t);
    openReview(p);
    const chipped = nodes(p)
      .filter((n) => n.querySelector('.wcchip'))
      .map((n) => n.dataset.node);
    // Opening a lane is positional. `impl` runs in a session that already has
    // a model, so it gets no chip. `ui`, `rw` and `ru` each open a lane.
    assert.deepEqual(chipped, ['ui', 'rw', 'ru']);
    assert.equal(byId(p, 'impl').querySelector('.wcchip'), null);
    assert.equal(byId(p, 'ui').querySelector('.wcchip span')?.textContent, 'opus-5');
  });

  it('numbers a node by its badge, not by its position in the list', (t) => {
    const p = openPanel(t);
    openReview(p);
    // Tiers, not file order: a tier of one is a bare number, a tier that holds
    // more than one gets a letter. Eleven steps over seven tiers.
    assert.deepEqual(
      nodes(p).map((n) => n.querySelector('.wcg b')?.textContent),
      ['1', '2a', '2b', '3a', '3b', '4a', '4b', '5', '6a', '6b', '7']
    );
  });

  it('opens one node at a time, in place, as fields', (t) => {
    const p = openPanel(t);
    openReview(p);
    byId(p, 'ru').click();
    // Open-in-place, and no inspector: exactly one node grows fields and every
    // other stays closed where it is.
    assert.equal(canvas(p).querySelectorAll('.wcbody').length, 1);
    assert.equal(canvas(p).querySelectorAll('.wcnode.editing').length, 1);
    assert.equal(nodes(p).length, 11, 'the rest of the graph stays drawn');
    const open = byId(p, 'ru');
    assert.ok(open.classList.contains('editing'));
    assert.equal(open.querySelector<HTMLInputElement>('input.wctitle')?.value, 'Review the UI');
    assert.equal(proseOf(open.querySelector('.wcbody')).value(), 'Review the UI diff.');
    // The chip is the one thing the closed face keeps beyond the two fields,
    // and it stays on the open one too.
    assert.ok(open.querySelector('.wcchip'), 'the chip survives opening');
  });

  it('moves the open node rather than opening a second', (t) => {
    const p = openPanel(t);
    openReview(p);
    byId(p, 'ru').click();
    byId(p, 'wire').click();
    assert.equal(canvas(p).querySelectorAll('.wcnode.editing').length, 1);
    assert.ok(byId(p, 'wire').classList.contains('editing'));
    assert.equal(byId(p, 'ru').classList.contains('editing'), false);
  });

  it('does not rebuild while a field is being typed in', (t) => {
    const p = openPanel(t);
    openReview(p);
    byId(p, 'rw').click();
    const box = byId(p, 'rw').querySelector<HTMLElement>('.wcbody');
    assert.ok(box);
    typeProse(p, box, 'Review the wiring diff, and the tests under it.');
    // The same element, still in the document: a rebuild on every keystroke
    // would take the caret with it.
    assert.equal(byId(p, 'rw').querySelector('.wcbody'), box);
    // And the draft moved, so closing and reopening finds the new text.
    byId(p, 'rw').querySelector<HTMLElement>('.wcdone')?.click();
    assert.equal(
      byId(p, 'rw').querySelector('.wcdesc')?.textContent,
      'Review the wiring diff, and the tests under it.'
    );
  });

  it('closes the open node without opening another', (t) => {
    const p = openPanel(t);
    openReview(p);
    byId(p, 'ru').click();
    byId(p, 'ru').querySelector<HTMLElement>('.wcdone')?.click();
    assert.equal(canvas(p).querySelectorAll('textarea').length, 0);
    assert.equal(canvas(p).querySelectorAll('.wcnode.editing').length, 0);
  });

  it('lets the chip be pressed without opening the node under it', (t) => {
    const p = openPanel(t);
    openReview(p);
    byId(p, 'ui').querySelector<HTMLElement>('.wcchip')?.click();
    // The node's own click-to-open is the other target on this box. Without
    // the chip stopping the event, pressing a model opens the editor instead.
    assert.equal(canvas(p).querySelectorAll('.wcnode.editing').length, 0);
    assert.equal(byId(p, 'ui').querySelector('.wcchip span')?.textContent, 'opus-5');
  });

  it('ends every wire in an arrowhead at the step that waits', (t) => {
    const p = openPanel(t);
    openReview(p);
    assert.ok(canvas(p).querySelector('svg.wcwires marker#wcarrow'));
    const wires = [...canvas(p).querySelectorAll('svg.wcwires path:not(.wchit):not(.wcarrowhead)')];
    assert.ok(wires.length > 0);
    assert.ok(wires.every((w) => w.getAttribute('marker-end') === 'url(#wcarrow)'));
  });

  it('draws a wire layer for every graph, one step included', (t) => {
    const p = openPanel(t);
    openReview(p);
    // Only that it exists. Every rect is zero in jsdom, so every path is
    // degenerate — wfroute.test.ts holds the geometry.
    assert.ok(canvas(p).querySelector('svg.wcwires'), 'no wire layer');
    const lone = openPanel(t);
    openWorkflow(lone, one());
    assert.ok(canvas(lone).querySelector('svg.wcwires'), 'one step is a grid like any other');
  });

  it('draws a single-lane workflow with a header and a divider before the ghost', (t) => {
    const p = openPanel(t);
    openWorkflow(p, solo());
    assert.equal(nodes(p).length, 5);
    const heads = [...canvas(p).querySelectorAll<HTMLElement>('.wchd')];
    assert.equal(heads.length, 1);
    assert.equal(heads[0]?.classList.contains('armed'), true);
    assert.equal(heads[0]?.querySelector('b')?.textContent, 'starting session');
    // The ghost column is the one gap.
    assert.equal(canvas(p).querySelectorAll('.wcdiv').length, 1);
    assert.equal(canvas(p).querySelectorAll('.wclane').length, 0);
    // No chip anywhere: one lane is the armed session's, and nothing opens one.
    assert.equal(canvas(p).querySelectorAll('.wcchip').length, 0);
    assert.equal(
      canvas(p).querySelector('.wcpipe.onelane'),
      null,
      'one lane is a lane like any other'
    );
    assert.equal(canvas(p).querySelector('.wcbar'), null);
  });

  it('draws one step on the grid like any other, header included', (t) => {
    const p = openPanel(t);
    openWorkflow(p, one());
    assert.equal(nodes(p).length, 1);
    assert.equal(canvas(p).querySelectorAll('.wchd').length, 1);
    assert.equal(canvas(p).querySelectorAll('.wclattice').length, 1);
    // The ghost column is the one gap.
    assert.equal(canvas(p).querySelectorAll('.wcdiv').length, 1);
    assert.equal(canvas(p).querySelector('.wcbar'), null);
    assert.equal(canvas(p).querySelector('.wcpipe.solo'), null);
    assert.equal(nodes(p)[0]?.style.gridColumn, '1');
  });

  it('does not give the armed column a lane named s0', () => {
    const graph = toCanvas([
      { id: 'a', label: 'A', description: 'a' },
      { id: 'c', label: 'C', description: 'c', lane: 's0', needs: ['a'] }
    ]);
    assert.deepEqual(graph.lanes, ['', 's0']);
    assert.equal(graph.nodes.find((n) => n.id === 'a')?.lane, '');
    assert.equal(graph.nodes.find((n) => n.id === 'c')?.lane, 's0');
  });

  it('gives two steps of one lane in one tier their own rows', () => {
    const graph = toCanvas([
      { id: 'plan', label: 'Plan', description: 'plan' },
      { id: 'review', label: 'Review', description: 'review' }
    ]);
    assert.equal(graph.nodes.find((n) => n.id === 'plan')?.depth, 0);
    assert.equal(graph.nodes.find((n) => n.id === 'review')?.depth, 1);
  });

  it('posts nothing to the host', (t) => {
    const p = openPanel(t);
    openReview(p);
    const before = p.posted.length;
    byId(p, 'ru').click();
    byId(p, 'ui').querySelector<HTMLElement>('.wcchip')?.click();
    // Opening a node and pressing a chip save nothing. Save is its own button.
    assert.equal(p.posted.length, before);
  });

  it('puts an effort chip beside the model chip, and only on a lane that opens', (t) => {
    const p = openPanel(t);
    openReview(p);
    const effortOn = (id: string): HTMLElement | null =>
      byId(p, id).querySelector<HTMLElement>('.wcchip.effort');
    // Both chips, on the three nodes that open a session, and on no other.
    for (const id of ['ui', 'rw', 'ru']) {
      assert.ok(byId(p, id).querySelector('.wcchip:not(.effort)'), `${id} has a model chip`);
      assert.ok(effortOn(id), `${id} has an effort chip`);
    }
    for (const id of ['impl', 'wire', 'aw', 'au', 'int', 'riw', 'riu', 'ship']) {
      assert.equal(byId(p, id).querySelector('.wcchip'), null, `${id} opens nothing`);
    }
    // `ui` states no effort, so the chip is the model's own default, dashed.
    // The reviewers state `medium`, which is a solid chip.
    assert.equal(effortOn('ui')?.classList.contains('inherit'), true);
    assert.equal(effortOn('ui')?.querySelector('span')?.textContent, 'high');
    assert.equal(effortOn('rw')?.classList.contains('inherit'), false);
    assert.equal(effortOn('rw')?.querySelector('span')?.textContent, 'medium');
    assert.equal(effortOn('ru')?.querySelector('span')?.textContent, 'medium');
  });
});

describe('a model with no effort setting', () => {
  // Haiku draws the model chip and nothing beside it. A hand-written effort
  // does not bring the chip back — the model has no ladder to put it on.
  it('draws no effort chip', () => {
    const steps: CanvasSource[] = [
      { id: 'root', label: 'Arm', description: 'In this session.' },
      {
        id: 'fast',
        lane: 's1',
        needs: ['root'],
        model: 'haiku-4.5',
        effort: 'high',
        label: 'Draft it',
        description: 'Haiku has no effort setting.'
      }
    ];
    const node = toCanvas(steps).nodes.find((n) => n.id === 'fast');
    assert.ok(node);
    assert.equal(node.model, 'haiku-4.5');
    assert.equal(node.effort, undefined);
    assert.equal(node.stated?.model, true);
  });
});

/**
 * Claims from the review of the retired canvas, checked against this one.
 *
 * Each is a guard: where the kept canvas already holds, the test stays so a
 * later edit cannot quietly drop it. Geometry that jsdom cannot see is stubbed
 * onto `getBoundingClientRect`, which is the one seam `paintWires` has.
 */
describe('what the review found', () => {
  it('does not close an open node when the click is aimed at its prompt', (t) => {
    const p = openPanel(t);
    openReview(p);
    byId(p, 'ru').click();
    const area = proseRoot(byId(p, 'ru').querySelector('.wcbody'));
    area.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.ok(byId(p, 'ru').classList.contains('editing'), 'the field took the click');
    assert.equal(canvas(p).querySelectorAll('.wcnode.editing').length, 1);
  });

  it('measures wires against the element that is the SVG’s viewport', (t) => {
    const p = openPanel(t);
    openReview(p);
    const pipe = canvas(p).querySelector<HTMLElement>('.wcpipe');
    const impl = byId(p, 'impl');
    const wire = byId(p, 'wire');
    assert.ok(pipe);
    // The pipe is the SVG's origin. A grid inset by the pipe's padding would
    // report the same nodes 22px to the left, and the path would start at 50.
    const box = (
      el: HTMLElement,
      left: number,
      top: number,
      width: number,
      height: number
    ): void => {
      el.getBoundingClientRect = () => ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON() {
          return this;
        }
      });
    };
    box(pipe, 0, 0, 500, 800);
    box(impl, 22, 40, 100, 40);
    box(wire, 22, 120, 100, 40);
    p.window.dispatchEvent(new p.window.Event('resize'));
    const svg = canvas(p).querySelector('svg.wcwires');
    assert.equal(svg?.getAttribute('viewBox'), '0 0 500 800');
    const paths = [...(svg?.querySelectorAll('path') ?? [])].map((n) => n.getAttribute('d'));
    assert.ok(
      paths.includes('M72 80 V120'),
      `expected the pipe-relative wire, got ${paths.join(' | ')}`
    );
  });

  it('keeps the canvas sheet winning inside #wfeditor', () => {
    const selectors = canvasCss
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((block) => block.split('{')[0]?.trim() ?? '')
      .filter((sel) => sel.length > 0 && !sel.startsWith('@'));
    for (const group of selectors) {
      for (const sel of group.split(',')) {
        // Everything that paints the graph is anchored on `#wfcanvas`,
        // because a class root loses to `#wfeditor` on the way in.
        if (!sel.includes('.wc') && !sel.includes('#wfcanvas')) continue;
        assert.ok(sel.includes('#wfcanvas'), `a class root loses to #wfeditor: ${sel.trim()}`);
      }
    }
    // `#wfeditor input` is (1, 0, 1) and sets the editor's padding. The canvas
    // field has to beat that on specificity, not on source order — the sheets
    // are concatenated and a reorder would otherwise hand the field back.
    const editorField = specificity('#wfeditor input');
    const canvasField = specificity('#wfcanvas .wctitle');
    assert.ok(
      outranks(canvasField, editorField),
      `(${canvasField.join(',')}) should beat (${editorField.join(',')})`
    );
    assert.match(canvasCss, /#wfcanvas \.wctitle, #wfcanvas \.wcbody \{[^}]*padding:/);
    assert.match(editorCss, /#wfeditor input \{[^}]*padding:/);
  });
});

/** (ids, classes and pseudo-classes, elements). Enough to compare the two sheets. */
const specificity = (selector: string): [number, number, number] => {
  const ids = selector.match(/#[-\w]+/g)?.length ?? 0;
  const classes = selector.match(/\.[-\w]+/g)?.length ?? 0;
  const pseudos = selector.match(/::?[-\w]+(\([^)]*\))?/g)?.length ?? 0;
  const rest = selector
    .replace(/#[-\w]+/g, ' ')
    .replace(/\.[-\w]+/g, ' ')
    .replace(/::?[-\w]+(\([^)]*\))?/g, ' ')
    .replace(/[>+~*,]/g, ' ');
  const elements = rest.split(/\s+/).filter((token) => token.length > 0 && token !== '*').length;
  return [ids, classes + pseudos, elements];
};

const outranks = (a: [number, number, number], b: [number, number, number]): boolean => {
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
};
