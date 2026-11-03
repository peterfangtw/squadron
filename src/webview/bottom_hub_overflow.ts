import * as layout from '../ui/bottom_hub_layout';
import { el } from './dom';

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
  const stack = el('div', 'bottomhub-overflow');
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
  let version = 0;
  let animations: Animation[] = [];
  const expanded = (): boolean => more.getAttribute('aria-expanded') === 'true';

  function setExpanded(open: boolean, animate = true): void {
    if (animate && expanded() === open) return;
    const currentVersion = ++version;
    const wasHidden = stack.hidden;
    const chips = Array.from(stack.children) as HTMLElement[];
    const current = chips.map((chip) => {
      const style = getComputedStyle(chip);
      return { transform: style.transform, opacity: style.opacity, boxShadow: style.boxShadow };
    });
    animations.forEach((animation) => animation.cancel());
    animations = [];
    more.setAttribute('aria-expanded', String(open));
    stack.inert = !open;
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motion = animate && !reduced && chips.every((chip) => typeof chip.animate === 'function');
    if (!motion || (!open && wasHidden)) {
      stack.hidden = !open;
      if (!open) return;
    }
    if (open) {
      stack.hidden = false;
      positionStack();
    }
    if (!motion) return;
    const tucked = {
      transform: 'translateY(14px) scale(.88)',
      opacity: 0,
      boxShadow: '0 1px 3px #0002'
    };
    const resting = {
      transform: 'translateY(0) scale(1)',
      opacity: 1,
      boxShadow: '0 4px 12px #0005'
    };
    animations = chips.map((chip, i) =>
      chip.animate([wasHidden ? tucked : (current[i] ?? resting), open ? resting : tucked], {
        duration: open ? 230 : 150,
        delay: open ? (chips.length - 1 - i) * 28 : i * 18,
        easing: open ? 'cubic-bezier(.2,.85,.3,1.15)' : 'cubic-bezier(.4,0,1,1)',
        fill: 'both'
      })
    );
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (currentVersion !== version) return;
      stack.hidden = !open;
      animations.forEach((animation) => animation.cancel());
      animations = [];
    });
  }

  function positionStack(): void {
    const bounds = board.getBoundingClientRect();
    const barBounds = bar.getBoundingClientRect();
    stack.style.maxHeight = `${Math.max(32, bounds.height - barBounds.height - 62)}px`;
    const half = stack.getBoundingClientRect().width / 2;
    const trigger = more.getBoundingClientRect();
    const center = Math.max(
      bounds.left + half + 8,
      Math.min(bounds.right - half - 8, (trigger.left + trigger.right) / 2)
    );
    stack.style.left = `${center - barBounds.left - half}px`;
  }

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
    setExpanded(false, false);
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
    if (reopen && !more.hidden) setExpanded(true, false);
    if (focused === more) {
      (more.hidden ? options[0] : more)?.focus();
    } else if (focused instanceof HTMLElement && options.includes(focused as HTMLButtonElement)) {
      (stack.contains(focused) && !expanded() ? more : focused).focus();
    }
  }

  more.onclick = () => setExpanded(!expanded());
  bar.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const option = event.target.closest('button');
      if (option && options.includes(option) && option.getAttribute('aria-disabled') !== 'true')
        setExpanded(false);
    },
    { signal: events.signal }
  );
  document.addEventListener(
    'click',
    (event) => {
      if (expanded() && event.target instanceof Node && !bar.contains(event.target))
        setExpanded(false);
    },
    { signal: events.signal }
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !expanded()) return;
      event.preventDefault();
      setExpanded(false);
      more.focus();
    },
    { signal: events.signal }
  );
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : undefined;
  observer?.observe(board);
  return {
    row,
    refit,
    dispose: () => {
      setExpanded(false, false);
      observer?.disconnect();
      events.abort();
    }
  };
}
