import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  askRequest,
  cardView,
  groupView,
  modelView,
  openPanel,
  questionView,
  stateMessage,
  threadView,
  workflowView
} from '../harness';
import type { Panel } from '../harness';

/**
 * Surfaces that cover one another, wired through the one layer stack
 * (`webview/layers.ts`): one Escape belongs to the top surface alone, and a
 * press that lands in a surface above a drawer is not a press past the drawer.
 *
 * A press is the three events a pointer sends, in order, because the kit menus
 * dismiss on `mousedown` and the drawers on `click`.
 */

const PID = 5;
const SHOT = { id: 'p|/tmp/a.png', w: 2460, h: 1702 };

type Thread = Parameters<typeof threadView>[0];

function panelWith(t: TestContext, over: Thread = {}): Panel {
  const p = openPanel(t);
  const groups = [groupView({ sessions: [cardView({ pid: PID, owned: true })] })];
  const extra = {
    workflows: [workflowView({ id: 'ship', label: 'Ship' })],
    models: [modelView({ value: 'opus', name: 'Opus' })]
  };
  p.push(stateMessage(groups, extra));
  $(p, '.card')?.click();
  p.push(
    stateMessage(groups, {
      ...extra,
      thread: threadView({
        pid: PID,
        exchanges: [{ role: 'user', text: 'look', blocks: [{ prose: 'look' }], images: [SHOT] }],
        ...over
      })
    })
  );
  return p;
}

const $ = (p: Panel, sel: string): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>(sel);

function need(p: Panel, sel: string): HTMLElement {
  const node = $(p, sel);
  assert.ok(node, `nothing at ${sel}`);
  return node;
}

function press(p: Panel, target: Element): void {
  const init = { bubbles: true, cancelable: true, button: 0 };
  // jsdom's window types no PointerEvent; the listeners read the type alone.
  target.dispatchEvent(new p.window.MouseEvent('pointerdown', init));
  target.dispatchEvent(new p.window.MouseEvent('mousedown', init));
  target.dispatchEvent(new p.window.MouseEvent('mouseup', init));
  target.dispatchEvent(new p.window.MouseEvent('click', init));
}

function escapeAt(p: Panel, target: Element): KeyboardEvent {
  const key = new p.window.KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true
  });
  target.dispatchEvent(key);
  return key;
}

const drawerUp = (p: Panel): boolean => need(p, '#bottomdrawer').hidden === false;
const overviewUp = (p: Panel): boolean => need(p, '#workflowoverviewdrawer').hidden === false;
const lightboxUp = (p: Panel): boolean => need(p, '#lightbox').hidden === false;

function raiseDrawer(p: Panel): void {
  need(p, '#bottomhub .warm-tab').click();
  assert.ok(drawerUp(p), 'the Warm word raised no drawer');
}

function openOverview(p: Panel): void {
  need(p, '#wattach .wflow.live').click();
  assert.ok(overviewUp(p), 'the live chip opened no overview drawer');
}

/** The composer's model pill: a kit menu that lives in the dock, so opening it
 *  is no press on the board. */
function openModelMenu(p: Panel): HTMLElement {
  const trigger = need(p, '#composer .fpill.model');
  press(p, trigger);
  const menu = trigger.parentElement?.querySelector<HTMLElement>('.fmenu');
  assert.ok(menu && !menu.hidden, 'the model pill opened no menu');
  return menu;
}

function openLightbox(p: Panel): void {
  need(p, '#thread .shotchip').click();
  p.push({ type: 'imageData', id: SHOT.id, dataUrl: 'data:image/png;base64,AAAA' });
  need(p, '#thread .shot img').click();
  assert.ok(lightboxUp(p), 'the thumbnail opened no lightbox');
}

function showAsk(p: Panel): HTMLElement {
  const ask = need(p, '#ask');
  if (ask.hidden) need(p, '#qlaunch').click();
  assert.equal(ask.hidden, false, 'the launcher showed no dialog');
  return ask;
}

const following = { workflow: { label: 'ship', steps: [{ id: 's1', label: 'Plan' }] } } as Thread;

describe('one Escape over two surfaces', () => {
  it('closes a kit menu over the raised bottom drawer, and only the menu', (t) => {
    const p = panelWith(t);
    raiseDrawer(p);
    const menu = openModelMenu(p);
    const row = menu.querySelector('button') ?? menu;
    escapeAt(p, p.window.document.activeElement ?? row);
    assert.equal(menu.hidden, true, 'the menu stayed open');
    assert.equal(drawerUp(p), true, 'the same Escape closed the drawer under the menu');
    escapeAt(p, p.window.document.activeElement ?? p.window.document.body);
    assert.equal(drawerUp(p), false, 'the second Escape did not reach the drawer');
  });

  it('closes a kit menu over the overview drawer, and only the menu', (t) => {
    const p = panelWith(t, following);
    openOverview(p);
    const menu = openModelMenu(p);
    escapeAt(p, p.window.document.activeElement ?? menu);
    assert.equal(menu.hidden, true, 'the menu stayed open');
    assert.equal(overviewUp(p), true, 'the same Escape closed the overview drawer');
  });
});

describe('a press in a surface above a drawer', () => {
  it('on the lightbox image leaves the bottom drawer raised', (t) => {
    const p = panelWith(t);
    raiseDrawer(p);
    openLightbox(p);
    press(p, need(p, '#lightbox img'));
    assert.equal(lightboxUp(p), true, 'a press on the image closed the lightbox');
    assert.equal(drawerUp(p), true, 'a press on the image closed the drawer under it');
  });

  it('on the lightbox frame closes only the lightbox', (t) => {
    const p = panelWith(t);
    raiseDrawer(p);
    openLightbox(p);
    press(p, need(p, '#lightbox'));
    assert.equal(lightboxUp(p), false, 'a press on the frame left the lightbox open');
    assert.equal(drawerUp(p), true, 'a press on the frame closed the drawer under it');
  });

  it('in a dialog leaves the bottom drawer raised', (t) => {
    const p = panelWith(t, {
      status: 'waiting',
      waitingFor: 'question',
      pending: [askRequest({ questions: [questionView()] })]
    });
    raiseDrawer(p);
    const ask = showAsk(p);
    // The question's words, not an option: a pick repaints the block and
    // detaches its own target before the press reaches the document.
    press(p, need(p, '#question .qtext'));
    assert.equal(ask.hidden, false, 'a press on the question closed the dialog');
    assert.equal(drawerUp(p), true, 'a press in the dialog closed the drawer under it');
  });

  it('on the lightbox leaves the overview drawer open', (t) => {
    const p = panelWith(t, following);
    openOverview(p);
    openLightbox(p);
    press(p, need(p, '#lightbox img'));
    assert.equal(overviewUp(p), true, 'a press on the image closed the overview drawer');
    press(p, need(p, '#lightbox'));
    assert.equal(lightboxUp(p), false);
    assert.equal(overviewUp(p), true, 'a press on the frame closed the overview drawer');
  });

  it('on the board outside a kit menu over the raised drawer still closes both', (t) => {
    const p = panelWith(t);
    raiseDrawer(p);
    const menu = openModelMenu(p);
    press(p, need(p, '#board .card'));
    assert.equal(menu.hidden, true, 'the menu stayed open');
    assert.equal(drawerUp(p), false, 'the drawer stayed raised');
  });
});
