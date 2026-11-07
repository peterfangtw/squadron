import * as place from '../ui/place';

export interface PillStack {
  open: () => boolean;
  setOpen: (open: boolean) => void;
  refresh: () => void;
  dispose: () => void;
}

let active: PillStack | undefined;

/** Hover, keyboard and touch access to the upward pills shared by Agents and More. */
export function create(
  trigger: HTMLElement,
  stack: HTMLElement,
  board: HTMLElement,
  toggleOnClick: boolean
): PillStack {
  const events = new AbortController();
  const signal = events.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let touch = false;
  let pinned = false;
  const expandedAttribute = toggleOnClick ? 'aria-expanded' : 'data-waiting-expanded';
  const blocked = (): boolean =>
    board.classList.contains('drawer-open') ||
    board.classList.contains('editing') ||
    document.getElementById('ask')?.hidden === false ||
    document.hidden;
  const controls: PillStack = {
    open: () => !stack.hidden,
    setOpen: (open) => {
      clearTimeout(timer);
      open = open && stack.childElementCount > 0 && !trigger.hidden && !blocked();
      if (!open) pinned = false;
      if (open) {
        if (active !== controls) active?.setOpen(false);
        active = controls;
      } else if (active === controls) active = undefined;
      if (stack.hidden === !open) return;
      stack.hidden = !open;
      stack.inert = !open;
      trigger.setAttribute(expandedAttribute, String(open));
      if (open) {
        position();
        stack.scrollTop = stack.scrollHeight;
      }
    },
    refresh: () => {
      if (blocked() || trigger.hidden || !stack.childElementCount) controls.setOpen(false);
      else if (controls.open()) position();
    },
    dispose: () => {
      controls.setOpen(false);
      events.abort();
      observer?.disconnect();
      mutation.disconnect();
    }
  };

  function position(): void {
    const bounds = board.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const anchor = trigger.getBoundingClientRect();
    const parent = stack.offsetParent ?? stack.parentElement;
    if (!parent) return;
    stack.style.maxWidth = `${Math.min(320, Math.max(0, bounds.width - 16))}px`;
    stack.style.maxHeight = `${Math.min(300, Math.max(32, anchor.top - bounds.top - 16))}px`;
    const left = place.clampAxis(
      anchor.left - bounds.left,
      stack.getBoundingClientRect().width,
      bounds.width,
      8
    );
    stack.style.left = `${bounds.left + left - parent.getBoundingClientRect().left - parent.clientLeft}px`;
  }

  const enter = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') controls.setOpen(true);
  };
  const leave = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stack.contains(document.activeElement) && document.activeElement !== trigger)
        controls.setOpen(false);
    }, 220);
  };
  for (const node of [trigger, stack]) {
    node.addEventListener('pointerenter', enter, { signal });
    node.addEventListener('pointerleave', leave, { signal });
    node.addEventListener('focusout', leave, { signal });
    node.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && controls.open()) {
          event.preventDefault();
          event.stopPropagation();
          controls.setOpen(false);
          trigger.focus();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          if (node === trigger && event.key !== 'ArrowUp') return;
          event.preventDefault();
          controls.setOpen(true);
          const buttons = [...stack.querySelectorAll<HTMLButtonElement>('button')];
          const index = buttons.findIndex((button) => button === document.activeElement);
          const next =
            node === trigger ? buttons.at(-1) : buttons[index + (event.key === 'ArrowUp' ? -1 : 1)];
          (next ?? trigger).focus();
        }
      },
      { signal }
    );
  }
  trigger.addEventListener(
    'pointerdown',
    (event) => {
      touch = event.pointerType === 'touch';
    },
    { signal }
  );
  trigger.addEventListener(
    'click',
    (event) => {
      if (toggleOnClick || (touch && !controls.open())) {
        event.preventDefault();
        event.stopImmediatePropagation();
        controls.setOpen(
          toggleOnClick ? !controls.open() || (!touch && event.detail > 0 && !pinned) : true
        );
        pinned = toggleOnClick && controls.open();
      } else controls.setOpen(false);
      touch = false;
    },
    { signal, capture: true }
  );
  stack.addEventListener('click', () => controls.setOpen(false), { signal });
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.target instanceof Node &&
        !stack.contains(event.target) &&
        !trigger.contains(event.target)
      )
        controls.setOpen(false);
    },
    { signal }
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && controls.open()) {
        event.preventDefault();
        controls.setOpen(false);
        trigger.focus();
      }
    },
    { signal }
  );
  document.addEventListener('visibilitychange', controls.refresh, { signal });
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(controls.refresh) : undefined;
  observer?.observe(board);
  const mutation = new MutationObserver(controls.refresh);
  mutation.observe(board, { attributes: true, attributeFilter: ['class'] });
  const ask = document.getElementById('ask');
  if (ask) mutation.observe(ask, { attributes: true, attributeFilter: ['hidden'] });
  return controls;
}
