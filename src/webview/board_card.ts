import { ctxLabel, ctxRank, dot, el } from './dom';
import { cards, ui } from './state';
import { iconAction, morphNode } from './kit';
import { since } from './board_stamps';
import { modelBit } from './board_settings';
import { reading } from '../ui/reading';
import * as warmRows from '../ui/warm_rows';
import * as warm from './board_warm';
import * as warmChoice from './warm_choice';

/**
 * A card's name is animated when it changes: the CLI can retitle a session
 * (cwd fallback -> AI title), and the new text decodes left to right rather
 * than popping in.
 *
 * **The ticker repaints the one card and never the board.** It used to call
 * `repaintBoard()` per frame, which was written when the 1s beat repainted
 * everything anyway and cost nothing extra. Step 5 of
 * `TASK_done_panel_repaint_cost.md` took the beat off the board, and left
 * this as the only thing still rebuilding the whole card tree at 60fps —
 * measured at 843 paints in 14 s against 26 pushes.
 *
 * It rebuilds that card through `card()` and morphs it, rather than writing the
 * name span it knows is moving. The stamp's narrow path is the other trade and
 * is deliberately not this one: a stamp is one span on one clock, where a card
 * mid-rename is also changing status, idle time and place. `card()` stays the
 * single description of a card, and a field added to it animates like the rest.
 */
const SCRAMBLE_MS = 500;
const GLYPHS = 'アカサタナハマヤラワ0123456789<>/\\=+*#';
const lastNames = new Map<number, string>();
const scrambles = new Map<number, { target: string; start: number }>();
let ticking = false;

/** Clear on identity change: a recycled pid must not animate the previous session's title. */
export function forget(pid: number): void {
  lastNames.delete(pid);
  scrambles.delete(pid);
}

export function scrambleFrame(target: string, elapsed: number): string {
  const revealed = Math.floor((elapsed / SCRAMBLE_MS) * target.length);
  let out = '';
  for (let i = 0; i < target.length; i++) {
    const ch = target[i] as string;
    out +=
      i < revealed || ch === ' ' ? ch : (GLYPHS[(Math.random() * GLYPHS.length) | 0] as string);
  }
  return out;
}

export function displayName(s: CardView): string {
  const prev = lastNames.get(s.pid);
  if (prev !== undefined && prev !== s.name)
    scrambles.set(s.pid, { target: s.name, start: Date.now() });
  lastNames.set(s.pid, s.name);

  const sc = scrambles.get(s.pid);
  if (!sc) return s.name;
  const elapsed = Date.now() - sc.start;
  if (sc.target !== s.name || elapsed >= SCRAMBLE_MS) {
    scrambles.delete(s.pid);
    return s.name;
  }
  ensureTicker();
  return scrambleFrame(sc.target, elapsed);
}

export function ensureTicker(): void {
  if (ticking) return;
  ticking = true;
  const step = (): void => {
    if (!tickScrambles()) {
      ticking = false;
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * `displayName` retires completed or superseded scrambles. Remove absent cards
 * here or their entries keep the animation loop running until reload.
 */
function tickScrambles(): boolean {
  for (const pid of [...scrambles.keys()]) {
    const node = cards.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`);
    const found = findCard(pid);
    if (!node || !found) {
      scrambles.delete(pid);
      continue;
    }
    morphNode(node, card(found.card), warm.carry);
  }
  return scrambles.size > 0;
}

/**
 * One card, drawn the same whether it is loose or inside a family container:
 * what a card spawned is the container header's to say, and nothing on the
 * strip repeats it.
 *
 * Four sections: header, two-line title, specs, and footer. The header wraps
 * actions together when the card cannot fit them beside its status.
 */
export function card(s: CardView): HTMLElement {
  const { word, tally } = reading(s);
  // A facet on top of the status, never in place of it: a done card is still an
  // idle card, and everything keyed on `.idle` still has to find it.
  const facet = tally === s.status ? '' : ' ' + tally;
  const node = el(
    'div',
    'card ' +
      s.status +
      facet +
      (warmRows.keptWarm(s.warm && { ...s.warm, on: warmChoice.shown(s) }) ? ' warm-on' : '') +
      (s.warming ? ' warming' : '') +
      (s.attention ? ' attention' : '') +
      (s.closing ? ' closing' : '') +
      (s.endStuck ? ' endstuck' : '') +
      (s.pid === ui.selected ? ' selected' : '')
  );
  node.dataset.tip = s.fullCwd;
  // Delegated actions read the pid here. Closures over `s` would retain an old view.
  node.dataset.pid = String(s.pid);
  node.dataset.key = String(s.pid);

  // Titles need their own full-width row. Sharing the status strip leaves about a third.
  const head = el('div', 'head');
  const state = el('div', 'header-state');
  const actions = el('div', 'header-actions');
  head.append(state, actions);
  // The word decided at the top of this function, and the dot wear
  // its hue: a card that finished is green, one that stopped short is orange.
  //
  // A card being ended says so in the same slot, and says nothing else there:
  // the state it is in is on its way out, and the twin the board is reading it
  // off by now answers `unknown` anyway. The spinner is the starting card's,
  // read the other way round — the wait is the same shape at both ends of a
  // session's life.
  if (s.closing) {
    state.append(el('div', 'spinner'), el('span', 'pill', 'Ending…'));
  } else if (s.endStuck) {
    state.append(dot(), el('span', 'pill', "Didn't end"));
    if (s.endFailure) {
      state.dataset.tip = s.endFailure;
      state.setAttribute('role', 'status');
      state.setAttribute('aria-label', `Didn't end. ${s.endFailure}`);
    }
  } else {
    state.append(dot(), el('span', 'pill', word));
  }
  // A command of the session's own is running. Beside the state word rather
  // than in place of it, because it is a second fact about the session and not
  // a fourth state: the CLI collapses the two into one field and calls the
  // result `shell`, which is what this splits back apart.
  if (s.hasCommand) {
    const cmd = el('span', 'cmd');
    cmd.innerHTML = ICONS.terminal;
    cmd.setAttribute('role', 'img');
    cmd.setAttribute('aria-label', 'Running a command');
    cmd.dataset.tip = 'Running a command of its own — a tool call, or one sent to the background.';
    state.append(cmd);
  }
  // Keyed, and by the act rather than by where it sits: some are conditional, so
  // a turn ending takes the first away and slides the rest one place left.
  // Positional matching resolves that by rewriting the button under the pointer
  // into the next one along — a press aimed at "Interrupt turn" comes up on
  // "End session" and ends the session. Keyed, the button that went is a
  // removal and the ones that stayed are themselves.
  const button = (markup: string, title: string, does: string): HTMLElement => {
    const control = iconAction(markup, title, does);
    control.dataset.key = s.pid + ':' + does;
    return control;
  };
  if (s.canControl) {
    // Only while there is a turn to end. Absent rather than disabled: an idle
    // session has nothing to interrupt, and a `waiting` one would read the same
    // ESC as "cancel the dialog".
    // Never on a session being ended either, and it is the *only* control an
    // end takes away: the pipe it would put the frame on is closed. End stays
    // — an end that was not honoured is exactly when a second one is wanted,
    // and the dock's own End is on screen for the same session regardless, so
    // taking this one away would only make the two surfaces disagree.
    if (s.status === 'busy' && !s.turnPending && !s.closing && !s.endStuck) {
      actions.append(button(ICONS.interrupt, 'Interrupt turn', 'interrupt'));
    }
    if (s.warm && s.warm.held !== 'unsupported') {
      const toggle = button(ICONS.flame, 'Keep prompt cache warm', 'warm');
      toggle.setAttribute('aria-pressed', String(warmChoice.shown(s)));
      actions.append(toggle);
    }
  }
  // Background transcripts can be quoted too. Copying needs no session control.
  actions.append(button(ICONS.link, 'Copy a reference to this session', 'copyRef'));
  if (s.canControl) actions.append(button(ICONS.stop, 'End session', 'close'));
  node.append(head);

  // The title tooltip carries text clipped after two lines. The card tooltip is the cwd.
  const name = el('div', 'name', displayName(s));
  name.dataset.tip = s.name;
  node.append(name);

  // Density rules hide each bit with its leading separator, avoiding a stray ·.
  const specs = el('div', 'specs');
  const bit = (cls: string, text: string, sepCls?: string): HTMLElement => {
    if (specs.childElementCount) {
      specs.append(el('span', sepCls ? 'sep ' + sepCls : 'sep', '·'));
    }
    const span = el('span', cls, text);
    specs.append(span);
    return span;
  };
  modelBit(specs, s);
  if (s.effort) bit('s-effort', s.effort, 's-sep-effort');
  // A separate idle-time row costs every card a line. The group and tooltip carry cwd.
  specs.append(since(s));
  node.append(specs);

  node.append(footer(s));

  return node;
}

/** Mark only a smaller window. Equal or wider windows are not this warning. */
function held(view: CardView): { asked: number; size: number } | undefined {
  const { contextAsked: asked, contextSize: size } = view;
  return asked !== undefined && size !== undefined && size < asked ? { asked, size } : undefined;
}

/**
 * Keep the smaller-window warning beside the footer reading.
 * The notice names the account and model, per the root glossary.
 */
function heldBelow(bit: HTMLElement, view: CardView): void {
  const under = held(view);
  if (!under) {
    return;
  }
  bit.append(el('span', 'ctx-held', '↓'));
  // **Says what happened, not why.** The card cannot tell the causes apart: a
  // plan without the 1M entitlement, an org-managed setting, and a repo's own
  // `.claude/settings.local.json` all hold a session down the same way, and the
  // last of those is not the account's doing at all
  // (`docs/reference/cli_state/claude/protocol.md`). Naming one would be right
  // most of the time and confidently wrong the rest.
  bit.dataset.tip =
    (bit.dataset.tip ? bit.dataset.tip + '\n' : '') +
    `asked for ${ctxLabel(under.asked)}, running in ${ctxLabel(under.size)}. ` +
    `The narrow window is the one a launch can pin; the wide one is a request, ` +
    `and something above this session refused it.`;
}

/** Auto top margin aligns the footer with add and starting slots of different heights. */
export function footer(s: CardView): HTMLElement {
  const foot = el('div', ('foot ' + ctxRank(s.contextPct ?? 0)).trim());
  if (s.contextPct !== undefined) {
    const fill = el('span', 'strip-fill');
    fill.style.width = Math.max(0, Math.min(100, s.contextPct)) + '%';
    fill.setAttribute('aria-hidden', 'true');
    fill.hidden = s.contextPct === 0;
    foot.append(fill);
  }
  if (s.branch) {
    // A worktree has to be legible at a glance, because the group heading no
    // longer distinguishes it — its sessions sit under the repo's heading now.
    const glyph = s.worktree ? '⑂' : s.detached ? '@' : '⎇';
    const br = el('span', 'br' + (s.worktree ? ' wt' : ''));
    br.append(el('span', 'g', glyph), el('span', 'n', s.branch));
    // The tooltip shows the full clipped branch and spells out its glyph.
    br.dataset.tip =
      (s.worktree ? 'worktree · ' : '') + (s.detached ? 'detached at ' : 'branch ') + s.branch;
    foot.append(br);
  }
  mode(foot, s);
  const value =
    s.contextPct !== undefined
      ? Math.round(s.contextPct) + '%'
      : s.contextTokens !== undefined
        ? ctxLabel(s.contextTokens) + ' used'
        : '—';
  const context = el('span', 'strip-reading', value);
  if (s.contextSize !== undefined) {
    context.append(el('span', 'capacity', ' / ' + ctxLabel(s.contextSize)));
  }
  context.dataset.tip =
    s.contextPct !== undefined
      ? `Context used · ${value}${s.contextSize !== undefined ? ' of ' + ctxLabel(s.contextSize) : ''}`
      : s.contextTokens !== undefined
        ? `Context used · ${ctxLabel(s.contextTokens)} tokens`
        : 'Context usage unavailable';
  if (s.contextPct !== undefined) {
    context.setAttribute('role', 'meter');
    context.setAttribute('aria-label', 'Context used');
    context.setAttribute('aria-valuemin', '0');
    context.setAttribute('aria-valuemax', '100');
    context.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, s.contextPct))));
    context.setAttribute('aria-valuetext', context.textContent ?? value);
  }
  heldBelow(context, s);
  foot.append(context);
  return foot;
}

/** One waiting predicate keeps the alert bar, family count and ask action consistent. */
export const blocked = (s: CardView): boolean => s.status === 'waiting';

/**
 * A card and the group holding it, by pid — the whole of how any lineage
 * surface turns a pid into something to say. `alertBar` walks the same flat
 * list; this returns the group too, because the family header names the one a
 * parent is under.
 *
 * A pid that finds nothing is the contract's central case, not an error: a
 * closed parent, a `/clear`ed one, a swept edge and a session nothing spawned
 * are one absence, and the caller's answer to all four is to render nothing.
 */
export function findCard(pid: number): { card: CardView; group: GroupView } | undefined {
  for (const group of ui.state.groups) {
    const found = group.sessions.find((s) => s.pid === pid);
    if (found) return { card: found, group };
  }
  return undefined;
}

/**
 * The permission mode, after the branch when the card has one.
 *
 * Read-only, and no control: what would flip it is a burst of shift+tabs, and
 * the transcript this reading comes from confirms a change minutes late — a
 * button whose effect the panel cannot see landing is a button that lies. The
 * terminal is where the mode is changed, and the tooltip says so.
 *
 * Appended by `footer` in both its exits, because a card with no branch still
 * has a mode worth stating — it then sits at the start of the strip, and the
 * reading stays at the right.
 */
export function mode(foot: HTMLElement, s: CardView): HTMLElement {
  if (!s.mode) return foot;
  const node = el('span', 'mode' + (s.mode.bypass ? ' bypass' : ''));
  node.append(el('span', 'g', s.mode.holds ? '⏸' : '⏵⏵'), el('span', null, s.mode.label));
  // The reading's age is the honest part: the CLI states the mode on its own
  // schedule, so this can be a minute or two behind the transcript it is read
  // from.
  //
  // It used to add "change it in its terminal with shift+tab", which was the one
  // explanation of that in the panel. It went with row 53: every card is a
  // session on a pipe, and a pipe has no TUI to press shift+tab in — so the
  // sentence was about to become advice that is false on every card rather than
  // on some. Nothing replaces it, because nothing here can change the mode.
  node.dataset.tip = `permission mode: ${s.mode.label} · as its transcript last stated it.`;
  foot.append(node);
  return foot;
}

/**
 * A family, as a box in the group's grid holding a grid of its own: the
 * parent's card first when it belongs here, then its children in spawn order —
 * the order `members` already arrived in.
 *
 * A rectangle: `--span` columns of the group's grid by as many rows as the
 * members need. As wide as it has cards and no wider, which the box's own grid
 * then divides back into the same `--span` columns, so a card inside a
 * container is sized like a loose one. Capped at the column count because a
 * span past the explicit grid has the grid invent implicit `auto` columns,
 * which would resize every loose card in the group.
 *
 * An under-filled last row is enclosed rather than cut away: the box keeps its
 * four corners, and a family of 5 on a 4-column board is 4x2 with a gap.
 *
 * Always open. A fold would hide a `waiting` peer by default and leave the nav
 * tally disagreeing with the screen, and it would be live state in a surface
 * that replaces its children every second.
 *
 * No handlers of its own, deliberately: the ticket drop targets stay on the
 * cards, so the box can never swallow a drop aimed at one inside it.
 */
export function family(f: FamilyView, sessions: CardView[]): HTMLElement | undefined {
  const members = f.members.flatMap((pid) => sessions.filter((s) => s.pid === pid));
  const head = findCard(f.parent);
  if (!members.length || !head) return undefined;

  const box = el('div', 'fam');
  const span = Math.min(members.length, ui.cols);
  box.style.setProperty('--span', String(span));
  box.append(familyHead(f, head, members));
  const grid = el('div', 'grid');
  for (const s of members) {
    const node = card(s);
    if (s.pid === f.parent) node.classList.add('is-parent');
    grid.append(node);
  }
  box.append(grid);
  return box;
}

/**
 * The container's one line: what the family is, and how much of it is here.
 *
 * Two shapes and no third — a head that is not on the board produces no
 * container at all, so there is nothing to say about one. The name links only
 * when it is somewhere else to go; the head's own card, when it is in this box,
 * is right underneath.
 *
 * The head is the origin's card while the origin is running and the eldest
 * member after it has closed (`ui/views.ts`), so this line can name a session
 * that spawned nothing — `all` floors at what is on screen for that reason, and
 * a box then reads its own size rather than a count only an origin has.
 */
export function familyHead(
  f: FamilyView,
  head: { card: CardView; group: GroupView },
  members: CardView[]
): HTMLElement {
  const row = el('div', 'fam-head');
  row.append(el('span', 'g', '↳'));
  const mine = f.members.includes(f.parent);
  if (!mine) row.append(el('span', 'k', 'from'));

  const who = el(mine ? 'span' : 'button', 'who', head.card.name);
  who.dataset.tip = head.card.fullCwd;
  if (!mine) {
    who.dataset.act = 'select';
    who.dataset.pid = String(head.card.pid);
    // Keyed with the rest of the acting nodes: the boxes are ordered by their
    // earliest member and reorder as families form, so the parent this names
    // has to be the parent it named when the press began.
    who.dataset.key = 'who:' + head.card.pid;
  }
  row.append(who);
  if (!mine) row.append(el('span', 'where', 'in ' + head.group.label));

  const here = members.filter((s) => s.pid !== f.parent).length;
  // Floor the count at visible children so it never claims less than the reader sees.
  const all = Math.max(head.card.children?.length ?? 0, here);
  const n = el('span', 'n', here < all ? `${here} here of ${all}` : `${all} spawned`);
  const stuck = members.filter(blocked).length;
  if (stuck) n.append(el('span', 'warn', ` · ${stuck} waiting`));
  row.append(n);
  return row;
}
