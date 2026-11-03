/**
 * Editors kept across the paints that place them: the boxes the dialog layer
 * types into, each a plain-mode editor (`prose.ts`), and the two controls built
 * around one — `sayBox` (a box and the button that sends it) and `bailBox` (the
 * way past a request that answers nothing). The workflow editor's step prompts
 * are kept here too (`keptBox`), rich, and placed by the canvas the same way.
 *
 * Its own module rather than `kit.ts`, because `kit.ts` is imported by most of
 * the webview and by tests that run it outside the bundle, and the editor is
 * TipTap: nothing that wants a menu should load an editor to get one.
 */

import { el } from './dom';
import { awaiting } from './kit';
import { createProse, type Prose } from './prose';

/**
 * Who keeps a held box, and so how long it lives. `key` names the box across
 * the panel: the owner's incarnation, its request and the field. `alive` says
 * whether that owner still exists; a box whose owner is gone is destroyed once
 * no paint shows it (`sweepHeld`).
 */
export type Holder = { key: string; alive: () => boolean };

/** What a held box is made with, and what every paint after that updates. */
export type HeldOptions = Holder & {
  /** The host's class, which is what its surface styles. */
  cls: string;
  /** `data-say`: the key a paint asks for to put the caret in this box. */
  say: string;
  /** What the owner has staged. The editor is put back to it where the two
   *  differ, which only happens when the owner cleared it. */
  value: string;
  placeholder: string;
  label: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  /** The editor's key hook (`ProseOptions.onKey`): a send key is claimed here. */
  onKey: (event: KeyboardEvent) => boolean;
};

type Held = { host: HTMLElement; prose: Prose; alive: () => boolean };

/**
 * The boxes the dialog layer types into, kept across the paints that place
 * them. An editor's focus, selection, Undo history and any IME composition live
 * on its node, and a paint that rebuilds the layer would otherwise make a new
 * one on every stage, every push, and every keystroke in a box whose input
 * repaints. So a box is made once per owner and placed again by each paint:
 * `heldBox` hands the paint either the host itself (out of the document, so
 * moving it costs nothing) or a stand-in, and `rebuild` keeps a host that is
 * already in the document where it is.
 *
 * A box a paint does not place is parked, not destroyed: off screen with its
 * history, until a paint places it again. It is destroyed when its owner is
 * gone (`sweepHeld`).
 */
const keptBoxes = new Map<string, Held>();

/** The class of what a paint places where a box already in the document goes. */
const STAND = 'held-stand';

/**
 * The box for `o.key`, made on first use and updated in place after that: the
 * callbacks, the read-only state, the placeholder and the label are this
 * paint's, so no closure on the editor outlives the paint that made it. Returns
 * the node the paint puts where the box goes, and the editor.
 */
export function heldBox(o: HeldOptions): { node: HTMLElement; prose: Prose } {
  const options = {
    placeholder: o.placeholder,
    label: o.label,
    readOnly: o.readOnly,
    onKey: o.onKey
  };
  const box = keptBox({
    key: o.key,
    alive: o.alive,
    make: () => {
      const host = el('div', o.cls);
      const prose = createProse(host, { mode: 'plain', ...options });
      prose.importMarkdown(o.value);
      return { host, prose };
    }
  });
  const { host, prose } = box;
  if (!box.made && prose.value() !== o.value) {
    // The owner cleared what was typed (a note dropped with its pick). Its
    // history goes too: Undo cannot bring back words the owner threw away.
    prose.importMarkdown(o.value);
  }
  host.dataset.say = o.say;
  prose.update({ ...options, onChange: () => o.onChange(prose.value()) });
  return { node: box.node, prose };
}

/**
 * The box kept under `key`, made by `make` the first time it is asked for and
 * the same host and editor every time after, until `sweepHeld` finds its owner
 * gone. `node` is what the paint puts where the box goes: the host while it is
 * out of the document, a stand-in for `rebuild` while it is in. `made` says
 * this call made it.
 */
export function keptBox(o: Holder & { make: () => { host: HTMLElement; prose: Prose } }): {
  node: HTMLElement;
  host: HTMLElement;
  prose: Prose;
  made: boolean;
} {
  let box = keptBoxes.get(o.key);
  const made = !box;
  if (!box) {
    box = { ...o.make(), alive: o.alive };
    keptBoxes.set(o.key, box);
  }
  const { host, prose } = box;
  if (!host.isConnected) return { node: host, host, prose, made };
  const stand = el('div', STAND);
  stand.dataset.held = o.key;
  return { node: stand, host, prose, made };
}

/** Destroy every box whose owner is gone and that nothing shows. */
export function sweepHeld(): void {
  for (const [key, box] of keptBoxes) {
    if (box.host.isConnected || box.alive()) continue;
    box.prose.destroy();
    keptBoxes.delete(key);
  }
}

/** Put the caret in the held box `host` is, if it is one. */
export function focusHeld(host: Element | null): boolean {
  for (const box of keptBoxes.values()) {
    if (box.host !== host || !host.isConnected) continue;
    box.prose.focus();
    return true;
  }
  return false;
}

/** The held box in `root` the caret is in, if any. */
function heldFocus(root: HTMLElement): Held | undefined {
  const focused = document.activeElement;
  if (!focused || !root.contains(focused)) return undefined;
  for (const box of keptBoxes.values()) if (box.host.contains(focused)) return box;
  return undefined;
}

/**
 * `root.replaceChildren(...fresh)`, except that a held box already in `root`
 * is never taken out of the document. Detaching an editor drops its focus and
 * cancels a composition, and appending it to a fresh tree is a detach.
 *
 * Every fresh node goes in as it was built, closures and all, as a rebuild's
 * would. The exceptions are a held box's ancestors: the live ones stay, take
 * the fresh ones' attributes and handlers, and have their other children
 * swapped for the fresh ones around the kept child. Where the fresh tree puts
 * a box somewhere its live ancestors cannot follow (a different depth or tag),
 * the box is moved after all, and the caret is put back after the move.
 */
export function rebuild(root: HTMLElement, fresh: Node[]): void {
  const typing = heldFocus(root);
  const stage = el('div');
  stage.append(...fresh);
  const kept = new Map<Node, Element>();
  for (const stand of [...stage.querySelectorAll<HTMLElement>('.' + STAND)]) {
    const box = keptBoxes.get(stand.dataset.held ?? '');
    if (!box) stand.remove();
    else if (!keepChain(stand, box.host, stage, root, kept)) stand.replaceWith(box.host);
  }
  adopt(root, stage, kept);
  if (typing?.host.isConnected && !typing.host.contains(document.activeElement)) {
    typing.prose.focus();
  }
}

/**
 * Pair a stand-in's ancestors with its box's, level by level up to the two
 * roots, into `kept`. `false`, and `kept` untouched, where the two chains do
 * not line up or a live ancestor is already paired with another fresh one.
 */
function keepChain(
  stand: Element,
  host: Element,
  stage: Element,
  root: Element,
  kept: Map<Node, Element>
): boolean {
  const chain: [Element, Element][] = [];
  let fresh = stand;
  let live = host;
  for (;;) {
    chain.push([fresh, live]);
    const up = fresh.parentElement;
    const liveUp = live.parentElement;
    if (!up || !liveUp) return false;
    if (up === stage || liveUp === root) {
      if (up !== stage || liveUp !== root) return false;
      break;
    }
    if (up.tagName !== liveUp.tagName) return false;
    fresh = up;
    live = liveUp;
  }
  const taken = new Map([...kept].map(([f, l]) => [l, f]));
  if (chain.some(([f, l]) => (kept.get(f) ?? l) !== l || (taken.get(l) ?? f) !== f)) return false;
  for (const [f, l] of chain) kept.set(f, l);
  return true;
}

/**
 * Give `live` the children `fresh` has, a kept live node standing in for each
 * fresh node it was paired with. Nodes not wanted go first; then each wanted
 * node is inserted before the next one in place, so a kept node already in
 * order is never moved.
 */
function adopt(live: Element, fresh: Element, kept: Map<Node, Element>): void {
  const inner: [Element, Element][] = [];
  const target = [...fresh.childNodes].map((child) => {
    const twin = kept.get(child);
    if (!twin) return child;
    if (!(child instanceof Element && child.classList.contains(STAND))) {
      inner.push([twin, child as Element]);
    }
    return twin;
  });
  const wanted = new Set<Node>(target);
  for (const child of [...live.childNodes]) if (!wanted.has(child)) child.remove();
  let at = live.firstChild;
  for (const node of target) {
    if (node === at) at = at.nextSibling;
    else live.insertBefore(node, at);
  }
  for (const [twin, child] of inner) {
    takeOver(twin, child);
    adopt(twin, child, kept);
  }
}

/** A kept node becomes its fresh twin: attributes, and every `on*` handler,
 *  since the twin's closures are this paint's. */
function takeOver(live: Element, fresh: Element): void {
  for (const { name } of [...live.attributes]) {
    if (!fresh.hasAttribute(name)) live.removeAttribute(name);
  }
  for (const { name, value } of [...fresh.attributes]) {
    if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  }
  const from = fresh as unknown as Record<string, unknown>;
  const to = live as unknown as Record<string, unknown>;
  for (const name in fresh)
    if (name.startsWith('on') && to[name] !== from[name]) to[name] = from[name];
}

/** Claims ⌘/Ctrl+Enter for `send`: in a box Enter is a newline, so the send
 *  needs the modifier every editor on the machine uses for it. */
export const sendKey =
  (send: () => void) =>
  (e: KeyboardEvent): boolean => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return false;
    e.preventDefault();
    send();
    return true;
  };

/**
 * A box to say something in, and the button that sends what is in it. Two
 * surfaces want exactly this pair and differ only in wording — the ask's reply
 * and the permission dialog's reason under *Deny* — so one builder, since the
 * second copy of a control is where two drift.
 *
 * `needsText` is the real difference: a reply with nothing in it says nothing,
 * where a denial with nothing in it is an ordinary denial.
 *
 * The box is a held one (`heldBox`), kept by `hold`, so the words, the caret
 * and the history outlive the paint. The value is read at press time. `onType`
 * is for a caller with somewhere to stage it, so a repaint cannot take what
 * was typed.
 */
export function sayBox(o: {
  placeholder: string;
  /** The button's words. */
  action: string;
  /** The button's class, so each surface keeps the weight it already has. */
  cls: string;
  /** Dead until something is typed. */
  needsText: boolean;
  onSend: (text: string) => void;
  value?: string;
  onType?: (text: string) => void;
  /** What a repaint puts the caret back in, read off `data-say`. */
  key: string;
  hold: Holder;
  /** Which control this dialog was answered on, if any, and which one this box
   *  sends from — `awaiting`'s pair. */
  sent?: string;
  at?: string;
}): HTMLElement {
  const wrap = el('div', 'say');
  const value = o.value ?? '';
  const button = el('button', o.cls, o.action) as HTMLButtonElement;
  const box = heldBox({
    ...o.hold,
    cls: 'say-in',
    say: o.key,
    value,
    placeholder: o.placeholder,
    label: o.placeholder,
    // Words already sent are not words still being written: the box goes
    // read-only with the button, or a repaint carrying the request back would
    // show what was typed after the send as though that were the answer.
    readOnly: !!o.sent,
    onChange: (text) => {
      if (o.sent) return;
      button.disabled = o.needsText && !text.trim();
      o.onType?.(text);
    },
    // Bound here rather than on the layer: this is the one box that knows
    // which button it belongs to.
    onKey: sendKey(() => button.click())
  });
  button.disabled = o.needsText && !value.trim();
  button.onclick = () => {
    const text = box.prose.value().trim();
    if (o.needsText && !text) return;
    o.onSend(text);
  };
  awaiting(button, o.sent, o.at);
  wrap.append(box.node, button);
  return wrap;
}

/**
 * The way past a request that answers nothing: a tool denial carrying words.
 *
 * Both surfaces that want one are a denial with feedback — the ask's reply,
 * which is the CLI's own `Chat about this`, and the permission dialog's reason
 * — and both had the same failure: a box the same size and shape as the box
 * beside it that *does* answer, with nothing saying which was which. So the box
 * is shut until it is asked for, and opening it leads with the consequence
 * rather than with the field.
 *
 * `trigger` is for a caller with no control of its own to open this — the ask,
 * whose alternative is the CTA. A caller that already has a button (the
 * permission dialog's *Deny…*) passes none, and gets nothing at all while shut.
 */
export function bailBox(o: {
  open: boolean;
  /** The shut state's own button, and the quieter clause after its words. */
  trigger?: string;
  hint?: string;
  /** What opening it does, as a consequence rather than as a label. */
  cap: string;
  why: string;
  back: string;
  say: Parameters<typeof sayBox>[0];
  onOpen: (open: boolean) => void;
}): HTMLElement {
  const wrap = el('div', 'qbail');
  // The disclosure follows the box it hides: with a decision already on the pipe
  // there is nothing left to open or to go back to. Read off the box rather than
  // passed, so a caller cannot freeze it and leave its handles live — and with
  // no `at`, so neither handle can claim a decision it does not make.
  if (!o.open) {
    if (!o.trigger) return wrap;
    const trigger = el('button', 'qbail-t') as HTMLButtonElement;
    trigger.append(
      el('span', 'cv', '↩'),
      el('span', null, o.trigger),
      el('span', 'why', o.hint ?? '')
    );
    trigger.onclick = () => o.onOpen(true);
    awaiting(trigger, o.say.sent);
    wrap.append(trigger);
    return wrap;
  }
  const open = el('div', 'qbail-open');
  open.append(el('div', 'qbail-cap', o.cap), el('div', 'qbail-why', o.why), sayBox(o.say));
  const back = el('button', 'qbail-back', o.back) as HTMLButtonElement;
  back.onclick = () => o.onOpen(false);
  awaiting(back, o.say.sent);
  wrap.append(open, back);
  return wrap;
}
