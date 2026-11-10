/**
 * The panel's one layer stack: which open surface a key or a press belongs
 * to. A surface pushes itself when it opens and pops when it closes, and
 * states how it takes Escape, where focus returns, which surfaces it excludes
 * and which elements are it.
 *
 * Escape is offered from the top layer down, from one window-capture
 * listener, so it is heard before any document or element listener. A layer
 * that takes the key gets `preventDefault` and stopped propagation. The
 * interrupt (`composer.ts`) and editor Back (`editor.ts`) stay outside the
 * stack, on the window's bubble phase, and act only on a key no one
 * prevented.
 *
 * A press is attributed, not dismissed. The same window-capture position
 * records, for each `pointerdown`, `mousedown` and `click`, the top layer
 * whose `root` holds the target, before any handler runs. A handler that pops
 * a layer during dispatch therefore cannot change the answer `above` gives a
 * surface below it. What a surface does with a press stays its own.
 *
 * Order only: paint order is CSS z-index (`docs/reference/z_index.md`), and
 * nothing here moves focus on Escape except a pop's `restoreFocus`.
 * Field-level Escape (`num_input`, the rename boxes, the `@` menu,
 * ProseMirror's deferral) stays at its element and is not stacked. Such a
 * field `claim`s the key, and while it holds it no layer is offered one whose
 * target is that field: window capture runs before the field's own listener,
 * so a layer would otherwise close the surface around a draft the field
 * meant only to revert.
 */

import { imeKey } from './dom';

/**
 * How a layer takes Escape. `consume` takes the key and closes the layer.
 * `pass` lets the layer below have it. A handler decides per press, given
 * the event, and returns whether it took the key: a two-press layer (a
 * flyout, then its menu; a mode, then its drawer) is one handler.
 */
export type Escape = 'consume' | 'pass' | ((e: KeyboardEvent) => boolean);

export type Layer = {
  /** What another layer's `excludes` names this one by. */
  kind: string;
  /** Shuts the surface. Called on a `consume` Escape and on exclusion; the
   *  stack pops the layer afterwards if `close` did not. */
  close: () => void;
  escape: Escape;
  /** Focused on pop, when this layer was the top and the element is still
   *  connected. A thunk lets a surface decide at close time. */
  restoreFocus?: HTMLElement | (() => HTMLElement | null | undefined);
  /** Kinds this layer shuts when it is pushed: one sheet at a time. */
  excludes?: readonly string[];
  /** The elements that are this layer, its backdrop included. Asked per
   *  press. A layer with none (a wire drag) never claims a press. */
  root?: () => Iterable<Element | null | undefined>;
  /** With the caret in the composer or a dialog, pass Escape: there it is
   *  the interrupt's, or the ask layer's (H119). The one copy of that rule. */
  yieldsToComposer?: boolean;
  /**
   * A drawer: beneath every surface that opens over it, whatever order they
   * opened in. A ground layer is pushed under every other layer and above the
   * ground layers already open. Without it, a drawer a keyboard reader opened
   * behind an unscoped centred sheet would take that sheet's Escape. A tier,
   * not a z-index: ground layers keep push order among themselves.
   */
  ground?: boolean;
};

export type Handle = {
  /** Leaves the stack. Idempotent, and valid for a layer under the top. */
  pop: () => void;
  /** Still on the stack. */
  readonly open: boolean;
};

/** Whether the field takes this Escape itself. */
export type Claim = (e: KeyboardEvent) => boolean;

export type Stack = {
  push: (layer: Layer) => Handle;
  /** `field` takes Escape aimed at it, or inside it, whenever `when` says so. */
  claim: (field: Element, when?: Claim) => void;
  /** Whether `event` landed in a layer above `handle`'s. False for a press
   *  in `handle` itself, below it, or outside every layer. */
  above: (handle: Handle, event: Event) => boolean;
  dispose: () => void;
};

/** Where the caret means the reader is talking to a session, not a layer. */
const COMPOSER = '#input, #ask';
const PRESSES = ['pointerdown', 'mousedown', 'click'] as const;

type Entry = { layer: Layer; handle: Handle };
/** Where a press landed, and the stack's order as it stood at that moment. */
type Landing = { at: Entry | null; order: readonly Entry[] };

export function createStack(win: Window & typeof globalThis): Stack {
  const entries: Entry[] = [];
  // Keyed by the event, so nothing outlives its dispatch.
  const landed = new WeakMap<Event, Landing>();
  const fields = new WeakMap<Element, Claim>();

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || imeKey(e) || e.defaultPrevented || claimed(e)) return;
    // A snapshot: a handler may pop layers while the key is offered.
    for (const entry of [...entries].reverse()) {
      if (!entries.includes(entry)) continue;
      if (takes(entry, e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
  };

  const onPress = (e: Event): void => {
    landed.set(e, landing(e.target));
  };

  win.addEventListener('keydown', onKey, true);
  for (const type of PRESSES) win.addEventListener(type, onPress, true);

  return {
    push,
    claim: (field, when = () => true) => fields.set(field, when),
    above: (handle, event) => {
      // Read against the order the press found: a layer popped since then
      // still counts where it was.
      const { at, order } = landed.get(event) ?? landing(event.target);
      const own = order.findIndex((entry) => entry.handle === handle);
      return own !== -1 && !!at && order.indexOf(at) > own;
    },
    dispose: () => {
      win.removeEventListener('keydown', onKey, true);
      for (const type of PRESSES) win.removeEventListener(type, onPress, true);
      entries.length = 0;
    }
  };

  function push(layer: Layer): Handle {
    for (const entry of [...entries]) {
      if (layer.excludes?.includes(entry.layer.kind)) shut(entry);
    }
    const entry: Entry = {
      layer,
      handle: {
        pop: () => pop(entry),
        get open() {
          return entries.includes(entry);
        }
      }
    };
    if (layer.ground) {
      const above = entries.findIndex((open) => !open.layer.ground);
      entries.splice(above === -1 ? entries.length : above, 0, entry);
    } else entries.push(entry);
    return entry.handle;
  }

  function pop(entry: Entry): void {
    const at = entries.indexOf(entry);
    if (at < 0) return;
    const wasTop = at === entries.length - 1;
    entries.splice(at, 1);
    // A layer shutting under another must not take focus from the one above.
    if (!wasTop) return;
    const stated = entry.layer.restoreFocus;
    const target = typeof stated === 'function' ? stated() : stated;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  function shut(entry: Entry): void {
    entry.layer.close();
    pop(entry);
  }

  function takes(entry: Entry, e: KeyboardEvent): boolean {
    const { layer } = entry;
    if (layer.yieldsToComposer && inComposer(e.target)) return false;
    if (layer.escape === 'pass') return false;
    if (layer.escape === 'consume') {
      shut(entry);
      return true;
    }
    return layer.escape(e);
  }

  function claimed(e: KeyboardEvent): boolean {
    for (let at = e.target instanceof win.Element ? e.target : null; at; at = at.parentElement) {
      const when = fields.get(at);
      if (when?.(e)) return true;
    }
    return false;
  }

  function inComposer(target: EventTarget | null): boolean {
    return target instanceof win.Element && target.closest(COMPOSER) !== null;
  }

  function landing(target: EventTarget | null): Landing {
    const order = [...entries];
    return { at: target instanceof win.Node ? holder(target, order) : null, order };
  }

  function holder(target: Node, order: readonly Entry[]): Entry | null {
    for (let i = order.length - 1; i >= 0; i--) {
      const entry = order[i];
      if (!entry?.layer.root) continue;
      for (const node of entry.layer.root()) {
        if (node?.contains(target)) return entry;
      }
    }
    return null;
  }
}

let panel: Stack | undefined;

/** The panel's stack, on its window. `main.ts` mounts it at load; a push
 *  before that mounts it then. */
export function mount(win: Window & typeof globalThis = window): Stack {
  panel ??= createStack(win);
  return panel;
}

export function push(layer: Layer): Handle {
  return mount().push(layer);
}

export function claim(field: Element, when?: Claim): void {
  mount().claim(field, when);
}

export function above(handle: Handle, event: Event): boolean {
  return mount().above(handle, event);
}
