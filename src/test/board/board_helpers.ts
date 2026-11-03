import type { Panel } from '../harness';

/** The copy button's title, which is also how the tests find it. */
export const COPY = 'Copy a reference to this session';

/**
 * A drag event jsdom cannot make: it implements neither `DragEvent` nor
 * `DataTransfer`, so the transfer is a hand-made object hung off a plain
 * `Event`. The handlers only ever call `getData`/`setData` on it, which is the
 * whole of what a ticket hand-off needs.
 */
export const fire = (p: Panel, node: HTMLElement, type: string, id?: string): Event => {
  const ev = new p.window.Event(type, { bubbles: true, cancelable: true });
  if (id !== undefined) {
    Object.defineProperty(ev, 'dataTransfer', {
      value: { getData: () => id, setData: () => {}, effectAllowed: '' }
    });
  }
  node.dispatchEvent(ev);
  return ev;
};

/** Open through the real trigger; closed menus have no option rows. */
export function statusMenu(p: Panel): HTMLElement {
  const trigger = p.window.document.getElementById('status-filter');
  if (!trigger) throw new Error('No status dropdown');
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  const menu = p.window.document.getElementById('status-menu');
  if (!menu || menu.hidden) throw new Error('Status dropdown did not open');
  return menu;
}

export function statusOption(p: Panel, status: string): HTMLElement | null {
  const label =
    status === 'all' ? 'All sessions' : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    [...statusMenu(p).querySelectorAll<HTMLElement>('.mitem')].find(
      (row) => row.querySelector('.nm')?.textContent === label
    ) ?? null
  );
}

export function filterTo(p: Panel, status: string): void {
  const option = statusOption(p, status);
  if (!option) throw new Error(`No ${status} filter`);
  option.click();
}
