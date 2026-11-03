/** Shared readers for the mounted workflow editor. Registers no test and no hook. */

import * as assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import {
  cardView,
  groupView,
  openThread,
  threadView,
  typeProse,
  workflowView,
  type Panel
} from '../harness';

// Attach / New workflow only draw for sessions this panel drives
// (composer.ts). Default cardView is one another window drives.
export const board = (): GroupView[] => [
  groupView({ sessions: [cardView({ pid: 5, owned: true })] })
];

export const ship = workflowView({ id: 'ship', label: 'plan→build→review' });

export function select(p: Panel): void {
  p.window.document.querySelector<HTMLElement>('.card')?.click();
}

/** The sheet's door — the bar's `⋯`. Managing a workflow is what the sheet is
 *  for, and since the composer's pill went back to a menu this is its only one. */
export function openSheet(p: Panel): void {
  p.window.document.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
}

/** The rows the sheet is offering. */
export function sheetItems(p: Panel): HTMLElement[] {
  return [...p.window.document.querySelectorAll<HTMLElement>('#bottomdrawer-body .wsrow')];
}

/**
 * New, from the door that has it on an empty machine as well as a full one: the
 * composer's menu carries it in the footer, and the sheet — which is where the
 * list's own `+ New workflow` row lives — refuses to open with nothing in it
 * (S8).
 */
export function clickNew(p: Panel): void {
  p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
  p.window.document.querySelector<HTMLElement>('#wattach .fmenu .faction')?.click();
}

/** Edit is on every row now, behind the row's own `⋯`. */
export function openEditShip(p: Panel): void {
  editWorkflow(p, 'plan→build→review');
}

export function editWorkflow(p: Panel, label: string): void {
  select(p);
  openSheet(p);
  sheetItems(p)
    .find((el) => (el.querySelector('.nm')?.textContent ?? '').includes(label))
    ?.querySelector<HTMLElement>('.act.edit')
    ?.click();
}

/** A real keydown: cancelable, so an owner that takes it can say so. */
export function escOn(p: Panel, at: Element | null | undefined): void {
  at?.dispatchEvent(
    new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
}

export const interrupts = (p: Panel): number =>
  p.posted.filter((m) => m.type === 'interrupt').length;

/** `ship` open in the editor, over a dock whose session is mid-turn. */
export function editBehindBusy(t: TestContext): Panel {
  const p = openThread(t, threadView({ pid: 5, status: 'busy' }), { workflows: [ship] });
  openSheet(p);
  sheetItems(p)
    .find((el) => (el.querySelector('.nm')?.textContent ?? '').includes('plan→build→review'))
    ?.querySelector<HTMLElement>('.act.edit')
    ?.click();
  assert.equal(p.window.document.getElementById('wfeditor')?.hidden, false, 'no editor');
  return p;
}

/** Badge numbers drawn on each node, in document order. */
export function stepBadges(p: Panel): string[] {
  return [...p.window.document.querySelectorAll('#wfeditor .wcnode .wcg b')].map(
    (n) => n.textContent ?? ''
  );
}

/** Open the node at `index`. Edit starts closed; a field exists only once it is open. */
export function openNode(p: Panel, index: number): HTMLElement {
  const nodes = (): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#wfeditor .wcnode')
  ];
  nodes()[index]?.click();
  const node = nodes()[index];
  if (!node) throw new Error(`no node at ${index}`);
  return node;
}

/**
 * What the pointer is over when it is released. jsdom has no layout, so
 * `elementFromPoint` is lent the answer a real hit test would give.
 */
export function hitIs(p: Panel, target: Element | null): void {
  Object.defineProperty(p.window.document, 'elementFromPoint', {
    configurable: true,
    value: () => target
  });
}

/** A wire drawn from `from`'s port and released over `to`'s card. */
export function drawWire(p: Panel, from: string, to: string): void {
  const doc = p.window.document;
  hitIs(p, doc.querySelector(`#wfeditor .wcnode[data-node="${to}"]`));
  doc
    .querySelector(`#wfeditor .wcnode[data-node="${from}"] .wcport`)
    ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  doc.dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 40 }));
  doc.dispatchEvent(new p.window.MouseEvent('pointerup', { bubbles: true, clientX: 40 }));
}

export const doc = (p: Panel): Document => p.window.document;

export const key = (p: Panel, target: Element, k: string, over: KeyboardEventInit = {}): boolean =>
  target.dispatchEvent(
    new p.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over })
  );

export const save = (p: Panel): Extract<WebviewMessage, { type: 'saveWorkflow' }> => {
  doc(p).querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
  const msg = p.posted.filter((m) => m.type === 'saveWorkflow').at(-1);
  if (!msg || msg.type !== 'saveWorkflow') throw new Error('nothing was saved');
  return msg;
};

/** An input takes its value; a step prompt is an editor, typed into. */
export const type = (p: Panel, field: HTMLElement | null, value: string): void => {
  if (!field) throw new Error('no field to type into');
  if ((field as { prose?: unknown }).prose) {
    typeProse(p, field, value);
    return;
  }
  (field as HTMLInputElement).value = value;
  field.dispatchEvent(new p.window.Event('input', { bubbles: true }));
};
