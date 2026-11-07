import * as layout from '../ui/bottom_hub_layout';
import { el } from './dom';
import * as pillStack from './pill_stack';

interface Overflow {
  row: HTMLElement;
  refit(): void;
  dispose(): void;
}

const bars = new WeakMap<HTMLElement, Overflow>();

export function sync(bar: HTMLElement, board: HTMLElement): void {
  let overflow = bars.get(bar);
  if (overflow && !bar.contains(overflow.row)) {
    overflow.dispose();
    overflow = undefined;
  }
  if (!overflow) {
    overflow = createOverflow(bar, board);
    bars.set(bar, overflow);
  }
  overflow.refit();
}

function createOverflow(bar: HTMLElement, board: HTMLElement): Overflow {
  const options = Array.from(bar.querySelectorAll<HTMLButtonElement>(':scope > button'));
  const row = el('div', 'bottomhub-row');
  const stack = el('div', 'bottomhub-overflow pill-stack');
  stack.id = 'bottomhub-overflow';
  stack.hidden = true;
  stack.inert = true;
  stack.setAttribute('role', 'group');
  stack.setAttribute('aria-label', 'More options');
  const more = el('button', 'hpill more') as HTMLButtonElement;
  more.id = 'bottomhub-more';
  more.append('More', el('span', 'dot'));
  more.querySelector('.dot')?.setAttribute('aria-hidden', 'true');
  more.setAttribute('aria-controls', stack.id);
  more.setAttribute('aria-expanded', 'false');
  more.hidden = true;
  row.append(...options, more);
  bar.replaceChildren(row, stack);

  const events = new AbortController();
  let signature = '';
  let boardWidth = 0;
  let boardHeight = 0;
  const pills = pillStack.create(more, stack, board, true);
  const expanded = (): boolean => pills.open();

  function syncSummary(): void {
    const dot = more.querySelector('.dot');
    const tones = ['fault', 'held', 'pending', 'live', 'on', 'elsewhere'];
    const tone = tones.find((candidate) => stack.querySelector(`.dot.${candidate}`));
    const dotClass = tone ? `dot ${tone}` : 'dot';
    if (dot && dot.className !== dotClass) dot.className = dotClass;
    const label = tone ? 'More options, hidden services active' : 'More options';
    if (more.getAttribute('aria-label') !== label) more.setAttribute('aria-label', label);
  }

  function refit(): void {
    const { width, height } = board.getBoundingClientRect();
    const nextSignature = JSON.stringify([
      width,
      height,
      ...options.map((option) => option.textContent)
    ]);
    syncSummary();
    // jsdom has no layout; leave its unmeasured row intact.
    if (width <= 0 || nextSignature === signature) return;
    signature = nextSignature;
    const focused = document.activeElement;
    const reopen = expanded() && width === boardWidth && height === boardHeight;
    boardWidth = width;
    boardHeight = height;
    if (!reopen) pills.setOpen(false);
    row.replaceChildren(...options, more);
    more.hidden = false;
    const style = getComputedStyle(bar);
    const gap = parseFloat(style.gap) || 9;
    const padding =
      (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + 2;
    row.classList.add('measuring');
    const count = layout.visibleOptions(
      options.map((option) => option.getBoundingClientRect().width),
      width - 36 - padding,
      more.getBoundingClientRect().width,
      gap
    );
    row.classList.remove('measuring');
    stack.replaceChildren(...options.slice(count));
    more.hidden = count === options.length;
    syncSummary();
    if (more.hidden) pills.setOpen(false);
    else if (reopen) pills.refresh();
    if (focused === more) {
      (more.hidden ? options[0] : more)?.focus();
    } else if (focused instanceof HTMLElement && options.includes(focused as HTMLButtonElement)) {
      (stack.contains(focused) && !expanded() ? more : focused).focus();
    }
  }

  bar.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const option = event.target.closest('button');
      if (option && options.includes(option) && option.getAttribute('aria-disabled') !== 'true')
        pills.setOpen(false);
    },
    { signal: events.signal }
  );
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : undefined;
  observer?.observe(board);
  return {
    row,
    refit,
    dispose: () => {
      pills.setOpen(false);
      observer?.disconnect();
      pills.dispose();
      events.abort();
    }
  };
}
