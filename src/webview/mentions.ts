/**
 * The `@` menu that names a model, a skill or a session, shared by the composer
 * and the workflow editor. What it draws and every spelling a pick sends is
 * `mention_text.ts`. This is the DOM and keyboard half over it.
 *
 * A caller supplies the box (a `MentionTarget`), what it offers (`sources`), and
 * how to write a `Mention` once a pick has cleared the run (`write`). The prose
 * editor answers the box (`Prose.selection`), for the composer and every step
 * prompt (`TASK_done_prose_input.md`, Key Decisions, "Our `@` menu stays ours").
 *
 * **One menu node, one owner.** Both boxes are on screen at once (the editor is
 * board mode, which leaves the dock live), so every global listener asks which
 * box the open menu belongs to. Without that, the composer's Enter is swallowed
 * by a menu the reader opened in the editor.
 */

import { el, imeKey } from './dom';
import * as mentionText from './mention_text';
import type { Mention, MentionSources, RecentId } from './mention_text';

export type { Mention, MentionSources } from './mention_text';
export { kindOf } from './mention_text';

/** The `@` run under the caret and the query after the sigil, in the box's positions. */
export type MentionSpot = { at: number; end: number; query: string };

/** Why a box changed: an edit, a caret move, or the start of an IME composition. */
export type MentionChange = 'edit' | 'move' | 'compose';

/** What the menu needs of a box. */
export interface MentionTarget {
  /** Where its keys land, and the edge the menu's left aligns to. */
  readonly node: HTMLElement;
  /** Where the caret is, or null for a range. */
  caret(): number | null;
  /** The caret's line in viewport coordinates, which the menu opens against;
   *  null for a range. */
  caretLine(): { top: number; bottom: number } | null;
  /** Text in the box's positions, with boundaries for blocks and non-text leaves. */
  text(from: number, to: number): string;
  /** The whole `@query` run around the caret, or null: none there, or a range
   *  selected. */
  spot(): MentionSpot | null;
  onChange(listener: (change: MentionChange) => void): void;
  /** The pick just before `at` (the caret by default), for `===` alone: the
   *  same pick reads equal, and an identical one written elsewhere does not.
   *  Null for a range or a position outside the box. */
  picked(at?: number): unknown;
  /** Whether a pick may be written at the caret. */
  accepts(): boolean;
  /** Writes `text` over `from`–`to`, leaves the caret after it, and tells the
   *  box's listeners, as the reader's own edit would. */
  replace(from: number, to: number, text: string): void;
}

type Attachment = {
  sources: () => MentionSources;
  opened: () => void;
  skillsChanged: (skills: readonly string[]) => void;
  /**
   * Called with the run (or the pill being replaced) already cut from the text
   * and the caret where it began. Stores and inserts the mention, syncs the
   * caller's own text, leaves the caret after the insertion, and returns the
   * whole insertion — lead space, pill and separator — or nothing when it
   * wrote nothing.
   */
  write: (mention: Mention) => string;
};

/** Weak, so a step prompt's editor is collectable once the workflow editor
 *  has destroyed it. Keyed by the box's node, which is what a keydown names. */
const attachments = new WeakMap<HTMLElement, { target: MentionTarget; attachment: Attachment }>();

let menu: HTMLElement | null = null;

/** Whose text the menu is filtering, including a run with no matching rows. */
let owner: MentionTarget | null = null;
let run: { box: MentionTarget; at: number } | null = null;
let drawnRows: mentionText.Row[] = [];

/**
 * Where a run the reader dismissed with Escape starts, while they are still on
 * it. The menu derives from the text and the caret, and Escape changes neither,
 * so without this the next `keyup` builds it straight back. Carries its box, as
 * `owner` does, because a bare offset lets an Escape in the editor suppress the
 * composer's menu at the same offset.
 */
let dismissed: { box: MentionTarget; at: number } | null = null;

/**
 * Which row Enter takes, and the list it was chosen in: the `@` offset and
 * `mention_text`'s `Mode`. A new list starts at the top, and typing within one
 * keeps the row. Held here because `sync` throws every row away on each
 * keystroke.
 */
let row = 0;
let listKey: string | null = null;

/**
 * The model pill waiting for an effort: the box's `picked` for it, where the
 * insertion runs, the row it was picked from, and which pick this is. Checked
 * against the box on every sync, because the text cannot say which of two
 * identical pills was just written. Escape, outside press, close, or a sync
 * that finds the caret outside its letter query ends it for good.
 */
let pending: {
  box: MentionTarget;
  chip: unknown;
  from: number;
  to: number;
  model: RecentId;
  pick: number;
} | null = null;

/** Picks so far, so each effort list is a new list. */
let picks = 0;

/** The last few picks, every box's, for this webview's lifetime. Identities
 *  only; `mention_text` resolves them against the current sources. */
let recent: RecentId[] = [];

/** The `@` run under the caret, or null where the box cannot take a pick. */
function spotIn(box: MentionTarget): MentionSpot | null {
  return box.accepts() ? box.spot() : null;
}

/**
 * Portalled to `<body>` and `position: fixed` because both boxes sit inside
 * surfaces that clip their overflow (see `opensMenu`'s `portal`). `opensMenu`
 * does not serve: it toggles an `aria-haspopup` control, and this trigger is a
 * keystroke.
 */
function ensureMenu(): HTMLElement {
  if (menu) return menu;
  const node = el('div', 'fmenu mnmenu');
  node.id = 'mentionmenu';
  node.hidden = true;
  // The pointer moves the same highlight the arrows do. `mousemove`, not
  // `mouseenter`: measured in Chromium against the shipped bundle, a scroll
  // under a parked pointer dispatches the boundary events, so on `mouseenter` a
  // held ArrowDown scrolled the next row under the cursor and was dragged
  // back, and the highlight oscillated between two rows. Delegated, so a
  // rebuild's rows need no closure each.
  node.addEventListener('mousemove', (e) => {
    const hit = (e.target as Element | null)?.closest('.mnrow');
    const at = hit ? rows().indexOf(hit as HTMLElement) : -1;
    if (at < 0 || at === row) return;
    row = at;
    paintRow();
  });
  // A row is a button, and a button takes focus on mousedown: a pointer pick
  // left the box unfocused, so the keystroke after it went nowhere — and an
  // effort step waiting on the box's caret could not be typed past. The click
  // still fires. Measured in the smoke host; jsdom moves no focus on a click.
  node.addEventListener('mousedown', (e) => {
    if ((e.target as Element | null)?.closest('.mnrow')) e.preventDefault();
  });
  // The caret moves under a scroll or a resize with no edit or caret move to
  // redraw on, and the menu is anchored to it. Capture: scroll does not bubble,
  // and the box that scrolls is any ancestor of the caret.
  const follow = (): void => {
    const box = menuOwner();
    if (box) place(box, node);
  };
  document.addEventListener('scroll', follow, { capture: true, passive: true });
  window.addEventListener('resize', follow, { passive: true });
  document.body.append(node);
  menu = node;
  return node;
}

const rows = (): HTMLElement[] => [...(menu?.querySelectorAll<HTMLElement>('.mnrow') ?? [])];

function menuOwner(): MentionTarget | null {
  return menu && !menu.hidden ? owner : null;
}

/** Shut it. Exported because selecting another session has to, and so does any
 *  rebuild of a surface holding an attached box: the handle is bound to a node
 *  that is about to be replaced. */
export function closeMentionMenu(): void {
  if (menu) menu.hidden = true;
  owner = null;
  pending = null;
  // A list that went away and came back is a new choice, even at the same `@`.
  listKey = null;
  run = null;
  drawnRows = [];
}

export function refreshMentionSources(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-mentions]')) {
    const attachment = attachments.get(node)?.attachment;
    if (attachment) attachment.skillsChanged(attachment.sources().skills ?? []);
  }
  const box = run?.box ?? menuOwner();
  if (!box) return;
  if (!box.node.isConnected) {
    closeMentionMenu();
    return;
  }
  const attachment = attachments.get(box.node)?.attachment;
  if (!attachment) return;
  sync(box, false, attachment.sources());
}

/** The pending pill is still where it was written, followed by a letter query. */
function holds(wait: NonNullable<typeof pending>): boolean {
  const caret = wait.box.caret();
  return (
    caret !== null &&
    caret >= wait.to &&
    wait.box.accepts() &&
    wait.box.picked(wait.to) === wait.chip &&
    /^[a-z]*$/i.test(wait.box.text(wait.to, caret)) &&
    !/[a-z]/i.test(wait.box.text(caret, caret + 1))
  );
}

/** Resume stays clamped: lapping its oldest row onto its newest is a different gesture. */
function move(by: number): void {
  const n = rows().length;
  if (!n) return;
  row = (row + by + n) % n;
  paintRow();
}

/**
 * The one place `.on` is written, so an arrow, a hover and a rebuild paint the
 * same way and all get the filter's clamp. `block: 'nearest'` scrolls only
 * `.mnmenu`'s own overflow: the menu is `position: fixed` inside the viewport,
 * so the document has nothing to scroll and `place()`'s coordinates hold.
 * Measured in Chromium: the menu's rect is unchanged across a 24-row walk.
 */
function paintRow(): void {
  const all = rows();
  if (!all.length) return;
  row = Math.max(0, Math.min(all.length - 1, row));
  all.forEach((node, i) => node.classList.toggle('on', i === row));
  all[row]?.scrollIntoView({ block: 'nearest' });
}

/**
 * Park the menu against the caret's line, at the box's left edge: above by
 * default, below when there is no room. Not the box's own rect: a multi-line
 * box's top is lines above the caret, and above the visible box once it
 * scrolls. A step field is anywhere in a scrolling column, and a
 * `max-height: 40vh` menu opened upward off the first step goes off the top of
 * the panel. Rects are all zero under jsdom, so the smoke cases carry geometry.
 */
function place(box: MentionTarget, node: HTMLElement): void {
  const rect = box.node.getBoundingClientRect();
  const line = box.caretLine() ?? rect;
  node.style.left = `${Math.round(rect.left)}px`;
  const room = line.top - 8;
  if (node.offsetHeight > room && window.innerHeight - line.bottom > room) {
    node.style.top = `${Math.round(line.bottom + 4)}px`;
    node.style.bottom = 'auto';
    return;
  }
  node.style.top = 'auto';
  node.style.bottom = `${Math.round(window.innerHeight - line.top + 4)}px`;
}

/**
 * Open, filter, or close the menu against what is in a box right now. Driven
 * from the `input` event, the only one that sees a paste, an IME commit and a
 * plain keystroke alike. The `@` keydown calls it too, so the menu opens on the press.
 */
function sync(box: MentionTarget, opening = true, sources?: MentionSources): void {
  const attachment = attachments.get(box.node)?.attachment;
  if (!attachment) return;
  const current = sources ?? attachment.sources();
  const spot = pending?.box === box ? null : spotIn(box);
  if (spot && !(dismissed?.box === box && dismissed.at === spot.at)) {
    if (opening && (run?.box !== box || run.at !== spot.at)) {
      run = { box, at: spot.at };
      attachment.skillsChanged(current.skills ?? []);
      attachment.opened();
    }
  }
  const now = listFor(box, current);
  if (!now) {
    if (owner === box || owner === null) closeMentionMenu();
    return;
  }
  draw(box, now.key, now.lines, now.squares, !opening);
}

/**
 * What the menu is for `box` right now: the waiting pill's efforts, or the run
 * under the caret's rows — always out of the current sources, so a row the
 * catalog no longer offers is never drawn or taken. Null when nothing is up.
 */
function listFor(
  box: MentionTarget,
  sources: MentionSources
): { key: string; lines: mentionText.Line[]; squares: boolean } | null {
  if (pending?.box === box) {
    const models = sources.models ?? [];
    const model = holds(pending) ? mentionText.modelOf(models, pending.model) : undefined;
    if (model) {
      return {
        key: `effort:${pending.pick}`,
        lines: mentionText.effortLines(
          model,
          models,
          box.text(pending.to, box.caret() ?? pending.to)
        ),
        squares: true
      };
    }
    pending = null;
  }
  const spot = spotIn(box);
  const shut = dismissed?.box === box && dismissed.at === spot?.at;
  if (!spot || shut) return null;
  const { mode, lines } = mentionText.linesFor(sources, spot.query, recent);
  return {
    key: `${spot.at}:${mode}`,
    lines,
    squares: mentionText.offered(sources).length > 1
  };
}

/** Paint `lines` as the open menu for `box`, or shut it when there is no row. */
function draw(
  box: MentionTarget,
  key: string,
  lines: mentionText.Line[],
  squares = true,
  preserve = false
): void {
  const selected = preserve && owner === box ? drawnRows[row] : undefined;
  const nextRows = lines.filter((line): line is mentionText.Row => 'act' in line);
  if (!lines.some((line) => 'act' in line)) {
    if (pending?.box === box) {
      closeMentionMenu();
      return;
    }
    if (owner === box || owner === null) {
      if (menu) menu.hidden = true;
      owner = box;
      drawnRows = [];
    }
    return;
  }
  if (listKey !== key || owner !== box) {
    listKey = key;
    row = 0;
  }
  if (selected) {
    const retained = mentionText.rowFor(lines, selected.act);
    if (retained) row = nextRows.indexOf(retained);
  }
  drawnRows = nextRows;
  const node = ensureMenu();
  node.textContent = '';
  for (const line of lines) {
    if (!('act' in line)) {
      node.append(el('div', line.crumb ? 'mnhead mncrumb' : 'mnhead', line.head));
      continue;
    }
    const button = el('button', line.gated ? 'mnrow gated' : 'mnrow') as HTMLButtonElement;
    // Inside no form, but stated anyway: the default is `submit`, and a stray
    // one in a webview is a navigation nobody asked for.
    button.type = 'button';
    // The square only says which kind a row is when there is more than one;
    // the editor's skills-only list stays the plain list it was.
    if (squares) button.append(el('span', `k ${line.kind}`));
    button.append(el('span', 'nm', line.name));
    if (line.meta !== undefined) button.append(el('span', 'meta', line.meta));
    if (line.more) button.append(el('span', 'go', '›'));
    button.onclick = () => pick(box, line);
    node.append(button);
  }
  // Said where the choosing happens, because it cannot be detected anywhere
  // else: 8 of 36 names on this machine were measured non-invocable, nothing on
  // the wire separates them, and at that rate saying nothing reads as a claim
  // that every row works. Only under skill rows: it is about them.
  if (
    lines.some(
      (line) => 'act' in line && 'mention' in line.act && line.act.mention.kind === 'skill'
    )
  ) {
    const foot = el('div', 'mnfoot');
    foot.textContent =
      'Not every skill listed here can be loaded — the session says so if it cannot.';
    node.append(foot);
  }
  owner = box;
  node.hidden = false;
  place(box, node);
  // After the unhide: a hidden box has no scroll to move, and the filter can
  // have shortened the list under the highlight.
  paintRow();
}

/**
 * Take one row: narrow to a kind, or cut the `@query` the reader typed (or the
 * pill waiting for its effort) and let the caller write the mention there.
 */
function pick(box: MentionTarget, line: mentionText.Row): void {
  const attachment = attachments.get(box.node)?.attachment;
  const waiting = pending?.box === box;
  const now = attachment ? listFor(box, attachment.sources()) : null;
  const current = now ? mentionText.rowFor(now.lines, line.act) : undefined;
  const wait = pending?.box === box ? pending : null;
  const spot = wait ? null : spotIn(box);
  if (!attachment || !current || waiting !== Boolean(wait) || (!wait && !spot)) {
    // The menu outlived what it was drawn from: the caret moved, a selection
    // crossed the run, or a push changed the rows. Redraw, because an open menu
    // owns Enter and a stale one leaves Enter dead. Write nothing unseen.
    if (waiting && !wait) closeMentionMenu();
    else sync(box);
    return;
  }
  const act = current.act;
  const from = wait?.from ?? spot?.at ?? 0;
  const to = (wait ? box.caret() : spot?.end) ?? from;
  if ('scope' in act) {
    // Written into the text rather than held here, because the menu is rebuilt
    // from the text on every sync: `@model:` is the kind, and the reader can
    // type it too. Announced, so the caller's own sync sees it first.
    box.replace(from, to, mentionText.scopeText(act.scope));
    return;
  }
  box.replace(from, to, '');
  recent = mentionText.remember(recent, act.recent);
  const written = attachment.write(act.mention);
  closeMentionMenu();
  if (!act.follow || !written) return;
  const caret = box.caret();
  const chip = box.picked();
  if (caret === null || chip === null) return;
  picks += 1;
  pending = { box, chip, from, to: caret, model: act.recent, pick: picks };
  sync(box);
}

/**
 * Give a box an `@` menu. Every listener it needs (edit, caret move, keydown
 * precedence, outside press) is wired here or by the target, not handed back,
 * because a missing one is a bug and a caller handed `sync` would wire most.
 */
export function attachMentions(box: MentionTarget, attachment: Attachment): void {
  attachments.set(box.node, { target: box, attachment });
  box.node.dataset.mentions = '';
  box.node.addEventListener('blur', () => {
    if (run?.box === box || owner === box) closeMentionMenu();
  });
  box.node.addEventListener('focus', () => sync(box));
  box.onChange((change) => {
    // Typing on a dismissed run reopens it.
    if (change === 'edit') dismissed = null;
    // A composition's commit must not land while the effort list owns Enter.
    if (change !== 'move' && (change !== 'edit' || pending?.box !== box)) pending = null;
    // A caret move syncs too, because a pick against a stale run cuts the
    // reader's own letters adrift.
    sync(box);
  });
}

/**
 * The precedence, taken on `document` in the capture phase. Not on the box: a
 * caller's keydown may be registered before or after this one, and at the
 * target element listeners run in registration order whatever their phase, so
 * a bubble listener here would race the composer's send. Capturing at the
 * document runs before every element listener, and `stopPropagation` keeps the
 * claimed key from reaching one. `e.target` names the box (one menu, one owner).
 */
document.addEventListener(
  'keydown',
  (e) => {
    const box = attachments.get(e.target as HTMLElement)?.target;
    if (!box) return;
    // An open `@` menu owns Enter, Escape and the arrows, and must be asked
    // first: Enter is otherwise the send, Escape is otherwise the interrupt, and
    // an arrow is otherwise the caret — which in a multi-line prose box it stays
    // whenever no menu is up.
    const arrow = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    // Every modifier yields, not just Shift: a row is picked by a bare key,
    // and a modified one is whatever the box under the menu makes it. An IME's
    // Enter sent to a menu row eats the character it commits, and
    // `stopPropagation` means nothing downstream can recover it.
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (
      ((menuOwner() === box && (e.key === 'Enter' || e.key === 'Escape' || arrow)) ||
        (run?.box === box && e.key === 'Escape')) &&
      plain &&
      !imeKey(e)
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        // Remembered, not just shut — see `dismissed`. Typing clears it. An
        // effort step keeps the default.
        pending = null;
        const at = spotIn(box)?.at;
        dismissed = at === undefined ? null : { box, at };
        closeMentionMenu();
      } else if (arrow) {
        move(e.key === 'ArrowDown' ? 1 : -1);
      } else {
        rows()[row]?.click();
      }
      return;
    }
    // The press, not the frame after it. In a browser the character is not in
    // the box yet, so this closes and the `input` event immediately reopens; the
    // call is here so the menu is never a repaint behind the reader.
    if (e.key === '@') sync(box);
  },
  true
);

// A press anywhere else shuts it. The menu's rows are excluded because a pick
// is a press and lands here first. So is the open menu's own box, not the
// composer's: a press into the composer shuts the editor's menu.
document.addEventListener('pointerdown', (e) => {
  const at = e.target as HTMLElement | null;
  if (at && (at.closest('#mentionmenu') || menuOwner()?.node.contains(at))) return;
  closeMentionMenu();
});
