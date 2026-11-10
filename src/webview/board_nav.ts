import { ago, el, noLimitLabel, pctRank, until } from './dom';
import {
  cards,
  chats,
  nav,
  sessionsHead,
  ticketsHead,
  ticketsList,
  setBoardView,
  ui,
  vscode
} from './state';
import { closeMenu, heldOpen, morph } from './kit';
import {
  accountsControl,
  appendUsageSlots,
  brandMark,
  flipUsageChip,
  keepUsageFlip,
  snapshotUsageFace,
  usageHover
} from './accounts';
import type { LaunchTarget } from '../core/model';
import type { Draft, SendInput } from '../ui/chat_state';
import { tipRows, type TipRow } from './tip';
import * as settings from './settings';
import { picker, type Picker } from './picker';
import { renderTickets } from './tickets';
import { editing } from './editor';
import { repaintBoard, repaintDraft } from './board_repaint';
import { reading } from '../ui/reading';
import { pickUsageAccount, usageSlots } from '../ui/usage_chip';
import { isMidTurn } from '../core/model';

/**
 * The face's geometry: a half-dial of radius 11 about (13,13), which is the
 * largest that rides in a 40px bar rather than setting its height. Everything
 * drawn on it is a fraction of `R`, so the shape is one instrument and not a
 * pile of magic numbers. See `ui/css/nav.ts`.
 */
const R = 11;
const CX = 13;
const CY = 13;
const ARC = `M${CX - R} ${CY}A${R} ${R} 0 0 1 ${CX + R} ${CY}`;
const SWEEP = Math.PI * R;
const REDLINE = 0.8;
const DIAL_TICKS = 5;

/** Degrees for a reading: -90 at nothing, +90 at full, 1.8 per percent. */
const dialAngle = (pct: number): number => -90 + Math.max(0, Math.min(100, pct)) * 1.8;

/**
 * The gauge's face, as markup: a printed half-dial with its redline, and a
 * needle at the reading.
 *
 * A needle rather than the twelve lit ticks this used to draw. Ticks quantise —
 * 6% and 12% were the same one tick — and the reason they were chosen, that the
 * card counts its context in ticks, argued for a grammar the reading did not
 * want. What a dial buys over the number beside it is *angle*, read at a glance
 * and without being parsed, so the needle is the thing and the face is chrome:
 * a hairline arc, four quarter ticks, and the redline printed whatever the
 * reading is, so a reading is against a scale rather than against nothing.
 *
 * The needle is a tapered blade with a short counterweight past the pivot,
 * which is the shape that reads as an instrument rather than as a line at an
 * angle. The needle never animates: the face is rebuilt on each poll, so a
 * transition would have nothing persistent to run on. The scan does, and can,
 * because a waiting face's markup is the same every poll — the morph keeps the
 * node, and with it the animation's place.
 *
 * A string rather than built nodes because these are SVG elements, which `el`
 * cannot make — it speaks `createElement`, and an SVG child of an HTML parent
 * needs the namespace or it renders as nothing. `ICONS` reaches the panel the
 * same way, so this is the file's existing idiom rather than a new one.
 *
 * `undefined` is a face with no needle at all — a dial that has not been read,
 * which is a different statement from one reading zero. `scan` adds the dash
 * that runs the arc while that reading is still being taken
 * (`docs/mockups/nav-loading-states.html`).
 */
export function dial(pct: number | undefined, scan = false): string {
  const ticks = Array.from({ length: DIAL_TICKS }, (_, i) => {
    const deg = -90 + i * (180 / (DIAL_TICKS - 1));
    return `<line class="tick" x1="${CX}" y1="${CY - R - 1.5}" x2="${CX}" y2="${CY - R + 2}" transform="rotate(${deg.toFixed(2)} ${CX} ${CY})"/>`;
  }).join('');
  const red =
    `<path class="red" d="${ARC}" stroke-dasharray="${(SWEEP * (1 - REDLINE)).toFixed(2)} ` +
    `${SWEEP.toFixed(2)}" stroke-dashoffset="${(-SWEEP * REDLINE).toFixed(2)}"/>`;
  const needle =
    pct === undefined
      ? ''
      : `<polygon class="${`needle ${pctRank(pct)}`.trimEnd()}" points="${blade()}" ` +
        `transform="rotate(${dialAngle(pct).toFixed(2)} ${CX} ${CY})"/>` +
        `<circle class="hub" cx="${CX}" cy="${CY}" r="${(R * 0.16).toFixed(2)}"/>`;
  return (
    `<svg class="dial" width="26" height="16" viewBox="0 0 26 16" aria-hidden="true">` +
    `<path class="arc" d="${ARC}"/>${ticks}${red}${scan ? `<path class="scan" d="${ARC}"/>` : ''}` +
    `${needle}</svg>`
  );
}

/** The blade, pointing straight up: tip, both shoulders, and the counterweight
 *  past the pivot. Stubby on purpose — at r=11 a tail long enough to notice is
 *  a tail long enough to read as a second pointer. */
export function blade(): string {
  const w = R * 0.105;
  const tail = R * 0.17;
  return (
    `${CX},${(CY - R + 1.2).toFixed(2)} ${(CX + w).toFixed(2)},${(CY - 1.6).toFixed(2)} ` +
    `${CX},${(CY + tail).toFixed(2)} ${(CX - w).toFixed(2)},${(CY - 1.6).toFixed(2)}`
  );
}

/**
 * How busy the machine is, as the nav bar's leftmost readout: a tachometer and
 * a percentage.
 *
 * Machine-wide, for the reason the plan usage beside it is account-wide — every
 * card would say the same thing. It answers one question, "is this laptop the
 * thing that is slow", and deliberately not "which session is doing it": that
 * would want a `ps` tree per poll, and the per-session placements it would need
 * are drawn and passed over in `docs/mockups/resource-usage-placement.html`.
 *
 * A poll with no earlier sample to diff — the first after a start, the first
 * after a resume from sleep — is a reading still being taken, and waits. Not
 * `0%`, which is a claim about an idle machine, not "-", which is an answer of
 * nothing, and not absence, which would take the slot away and slide everything
 * right of it under the pointer a poll later.
 */
export function machineGauge(): HTMLElement {
  const cpu = ui.state.machine?.cpu;
  // A dial states no units, so the marker says which reading this is and the
  // phrase says what it is a percentage *of*. The phrase carries the figure
  // too: a narrow board prints the face and nothing beside it, and a needle
  // with no number anywhere is a reading that cannot be got back.
  const read = cpu === undefined ? undefined : Math.round(cpu) + '%';
  return face(
    'CPU',
    cpu,
    read,
    cpu === undefined
      ? 'This machine, across every core'
      : `${read} of this machine, across every core`
  );
}

/**
 * One gauge: the marker, the face, the figure, and the phrase that says what
 * any of them mean.
 *
 * Shared because both readouts are the same six statements and differ only in
 * what they are counting — the ratio the needle points at, the word before it,
 * the text beside it, and the hover. What is *not* shared is why each exists;
 * that stays on the callers.
 *
 * The marker is a word rather than a glyph: two faces of the same instrument
 * side by side are told apart by their units alone otherwise, which asks the
 * reader to parse `%` against `G` before knowing which is which. A chip and a
 * memory-module glyph were drawn against it in
 * `docs/mockups/machine-gauge-needle.html` and cost ~10px less each — the word
 * won because it needs learning by nobody.
 *
 * No `label` is a reading still being taken: a needleless face with the scan
 * on its arc, and a placeholder where the figure lands. The face is drawn
 * either way, so a reading that lands a poll late fills a slot that was already
 * there. A `label` with no `pct` is an answer with nothing to point at — "-".
 */
export function face(
  mark: string,
  pct: number | undefined,
  label: string | undefined,
  tip: string
): HTMLElement {
  const waiting = label === undefined;
  const node = el('span', waiting ? 'mach wait' : 'mach');
  node.append(el('span', 'k', mark));
  node.insertAdjacentHTML('beforeend', dial(pct, waiting));
  const figure = el('span', pct === undefined ? 'v' : ('v ' + pctRank(pct)).trim(), label);
  if (waiting) figure.append(el('span', 'bone'));
  node.append(figure);
  node.dataset.tip = tip;
  return node;
}

/** Bytes as the nav bar says them: one decimal and a `G`, the rendering
 * `resource-usage-placement.html` drew. */
export const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1) + 'G';

/**
 * How much of the machine's RAM is in use, as a second face beside the load.
 *
 * **Absolute, where the CPU face is a percentage.** Two adjacent percentages
 * would read as the same kind of thing, and the one question this answers —
 * "is the laptop out of room" — is asked in gigabytes. The dial still fills on
 * the ratio, so the face answers *roughly, and is it bad* while the figure
 * answers *how much*; the phrase carries the total the ratio is against, since
 * nothing else on screen states it.
 *
 * A separate element rather than a second reading inside `.mach`, so that the
 * load gauge's own rules — the tick count, the two thresholds — keep being
 * about one number. The two ranks are deliberately independent: a machine can
 * be swapping while its cores idle.
 *
 * A platform with no honest answer — which is `core/machine.ts`'s call and not
 * this file's, and arrives as `null` — reads "-" rather than going away. See
 * `docs/reference/machine_memory.md`. No `memory` at all is a read still out,
 * and waits.
 */
export function memoryGauge(): HTMLElement {
  const memory = ui.state.machine?.memory;
  // `readMemory` refuses a total of nothing, so this is the wire being checked
  // rather than the reader — a host that posted one would divide by zero here.
  const read = memory && memory.total > 0 ? memory : undefined;
  const pct = read ? Math.max(0, Math.min(100, (read.used / read.total) * 100)) : undefined;
  // The figure is in the phrase for the reason the load's is — see there.
  return face(
    'MEM',
    pct,
    memory === undefined ? undefined : read ? gib(read.used) : '-',
    read ? `${gib(read.used)} in use, of ${gib(read.total)} installed` : 'Memory in use'
  );
}

/**
 * The account's plan usage, as the nav bar's right-hand readout: `5h 10% · wk
 * 22%`, with what is left of each window in the tooltip.
 *
 * Account-wide, which is why it is here and not on a card — every card would
 * say the same thing. Both windows are always drawn, and one nobody has
 * reported yet reads "-": the readout is a fixed place on the bar, so a reading
 * that arrives a poll late lands in its own slot instead of shoving the
 * controls beside it under the pointer.
 *
 * A window with no reset time still shows its reading; the countdown is what
 * goes missing, not the number.
 *
 * Every reading is dated in the tip and none of them is drawn differently for
 * its age. The bar is a fixed width of a few characters and there is nowhere to
 * say it that would not cost the readings their place; the tip is where the age
 * goes, and the host is what keeps the figure worth drawing — it takes the
 * newest reading there is and clears a window that has rolled over.
 */
let usagePin: string | undefined;
let usageBrand: string | undefined;
/** pid → brand of every card currently mid-turn. A pid that then reads idle
 *  (or has left the board) is the session whose turn just ended. */
let usageMidTurn = new Map<number, string>();

function noteUsagePin(): void {
  const sessions = ui.state.groups.flatMap((g) => g.sessions);
  const midTurn = new Map<number, string>();
  for (const s of sessions) {
    if (isMidTurn(s.status) && s.brand) midTurn.set(s.pid, s.brand);
  }
  for (const [pid, brand] of usageMidTurn) {
    if (midTurn.has(pid)) continue;
    const now = sessions.find((s) => s.pid === pid);
    if (!now || now.status === 'idle') usagePin = brand;
  }
  usageMidTurn = midTurn;
}

function chipUsage(): { usage: UsageView | undefined; mark?: string } {
  // Before the first auth poll no account carries a reading; there is no fallback.
  const rows = ui.state.accounts;
  if (!rows) return { usage: undefined };
  noteUsagePin();
  const acct = pickUsageAccount(rows, {
    pin: usagePin,
    frozen: usageHover,
    currentBrand: usageBrand
  });
  usageBrand = acct?.brand;
  return { usage: acct?.usage, mark: acct?.mark };
}

export function planUsage(): HTMLElement {
  const chosen = chipUsage();
  const slots = usageSlots(chosen.usage);

  const fill = (lim: HTMLElement): void => {
    if (chosen.mark) lim.append(brandMark(chosen.mark));
    // Spaces in the text rather than gaps in the layout: the readout is one
    // phrase, and a gap would leave "5hwk22%" behind on a copy of it.
    appendUsageSlots(lim, chosen.usage);
    const at = chosen.usage?.at;
    const dated: TipRow[] =
      at === undefined ? [] : [['updated', ago(Date.now() - at) + ' ago', '']];
    tipRows(lim, 'resets in', [
      ...slots.flatMap((slot): TipRow[] => {
        if (slot.pct === null) return [[slot.id, noLimitLabel(slot.short), '']];
        return slot.resetsAt === undefined
          ? []
          : [
              [slot.id, until(slot.resetsAt), typeof slot.pct === 'number' ? pctRank(slot.pct) : '']
            ];
      }),
      ...dated
    ]);
  };

  // Once accounts are on the wire, the slot is the accounts control (usage or
  // Log in). Before the first auth poll it is a passive span: waiting, with the
  // host's labels and a placeholder per figure, when the host said which
  // windows there will be — and empty, as it always was, when it did not.
  //
  // **Each shape names its own key, here, where the shape is built.** They are
  // two different elements — a `.fwrap` holding a button and a menu, and a bare
  // span — and morphdom's key means *this one node*, so one key across both had
  // it morph the span into the wrap rather than replace it: same key, same tag,
  // so the old node is kept and rewritten and the wrap's button and menu are
  // moved into it while the wrap itself is discarded. That wrap is what
  // `opensMenu` closed over and what `openMenus` records, so `heldOpen(nav)`
  // stopped seeing this one control — and the bar repainted under an open
  // popover and morphed it shut on the next tick. The key used to be stamped by
  // the caller, which could not tell the two apart; that is why the collision
  // survived a review.
  if (ui.state.accounts) {
    return accountsControl(fill);
  }

  const lim = el('span', 'lim');
  lim.dataset.key = 'usage-plain';
  const pending = ui.state.usageWindows;
  if (pending) {
    lim.classList.add('wait');
    const mark = el('span', 'bmwrap');
    mark.append(el('span', 'bone'));
    lim.append(mark);
    appendUsageSlots(lim, { windows: pending }, true);
  } else {
    if (ui.ready) fill(lim);
    else {
      lim.classList.add('wait');
      lim.setAttribute('aria-label', 'Loading accounts…');
      lim.dataset.tip = 'Loading accounts…';
      lim.append(el('span', 'bone'));
    }
  }
  return lim;
}

export function addCard(g: GroupView): HTMLElement {
  // Keep the slot inert during a start: removing it reflows the grid and a
  // second click could start a session in another group.
  const busy = chats.openInFlight(g.cwd);
  // A draft has no pid or card. Mark New so the board says this press reopens
  // the draft without changing the reader's gesture.
  const drafting = !busy && chats.draftFor(g.cwd) !== undefined;
  const node = el('div', 'card add' + (busy ? ' busy' : '') + (drafting ? ' drafting' : ''));
  // Keyed by the folder it starts in, so the slot under the pointer is the same
  // element after a paint — including the one that slides a "Starting…" card in
  // ahead of it, which positional matching would resolve by turning this very
  // node into that spinner.
  node.dataset.key = 'add:' + g.cwd;

  // Two halves of one slot: carry a conversation on, or begin one. Resuming is
  // a way *in*, not a repair — the conversation worth continuing usually ended
  // hours ago and has no card left on the board to press — and it sits left of
  // the new session because that is the older, likelier of the two.
  //
  // Both halves carry the cwd and the window, because the click reads them off
  // whichever half was pressed and a repaint can move this node between the
  // press and the read.
  const half = (does: string, label: string, glyph: string, title: string): HTMLElement => {
    const it = el('div', 'half');
    it.innerHTML = glyph;
    it.append(el('span', null, label));
    it.dataset.act = does;
    it.dataset.key = 'half:' + does + ':' + g.cwd;
    it.dataset.cwd = g.cwd;
    it.dataset.tip = title;
    // The picker returns focus here. A div otherwise cannot take it, and this
    // is not a tab stop.
    if (does === 'resume') it.tabIndex = -1;
    return it;
  };
  node.append(
    half('resume', 'Resume', ICONS.refresh, 'Carry on a conversation in ' + g.cwd),
    half(
      'open',
      busy ? 'Starting…' : 'New',
      ICONS.plus,
      busy
        ? 'Waiting for the last session in ' + g.cwd + ' to come up'
        : drafting
          ? 'Back to the session being written for ' + g.cwd
          : 'Start a session in ' + g.cwd
    )
  );
  return node;
}

export function startingCard(cwd: string): HTMLElement {
  const node = el('div', 'card starting');
  node.dataset.key = 'starting:' + cwd;
  node.append(el('div', 'spinner'), el('span', null, 'Starting…'));
  node.dataset.tip = 'Waiting for the CLI to come up';
  return node;
}

/**
 * A draft's first send, which is the act that spawns.
 *
 * Everything the start runs on rides the message: the brand and model the
 * draft's own control picked, the window that model names, the folder and the
 * window the slot carried, and the draft's id — which is what the host's reveal
 * comes back naming, and what promotes this surface onto the card that answers
 * it.
 *
 * **The prompt is not here.** It stays in the webview and goes as the ordinary
 * `send` once the reveal names a pid, so the first turn gets `sendResult`, the
 * echo, image blocks and the staged workflow write for free. Only its first
 * line goes, as `placeholder`, so the card comes up labelled the way a spawn's
 * would — and gives way to the CLI's own title just as readily. Never as
 * `name`: a CLI cannot tell one of those from a name somebody chose, and stops
 * titling the conversation for good (`core/naming.ts`).
 */
export function startDraft(draft: Readonly<Draft>, snapshot: SendInput): void {
  const { cwd } = draft;
  if (chats.openInFlight(cwd)) return;
  const group = ui.state.groups.find((g) => g.cwd === cwd);
  if (!group && cwd !== ui.state.defaultCwd) {
    // The window holding this folder closed while the draft sat open, so there
    // is no baseline to measure a start against and no slot on the board any
    // more. Said on the draft rather than returned silently: the reader's Enter
    // did nothing, and this is the only surface that can tell them why.
    chats.refuseDraft(draft.id, 'This folder is no longer on the board.');
    repaintDraft();
    return;
  }
  const attempt = chats.beginDraftStart(cwd, Date.now());
  if (attempt === undefined) return;
  const placeholder = firstLine(snapshot.delivered);
  const target = draft.pick === undefined ? undefined : stated(draft.pick);
  vscode.postMessage({
    type: 'open',
    cwd,
    ...(target === undefined ? {} : { target }),
    ...(placeholder === undefined ? {} : { placeholder }),
    draftId: attempt
  });
  repaintBoard();
}

/** Absent fields stay off the message. A key whose value is undefined is not a stated pick. */
function stated(pick: LaunchTarget): LaunchTarget {
  return Object.fromEntries(Object.entries(pick).filter(([, value]) => value !== undefined));
}

/** sessionName cleans and cuts host-side, so this only finds the opening line. */
function firstLine(text: string): string | undefined {
  return text.split('\n')[0]?.trim() || undefined;
}

/** The 26s Codex reproduction outlived this local clock: spawn_health_2026_10_21.md S1. */
export function prunePending(): boolean {
  const result = chats.prunePending(Date.now(), 25_000);
  for (const attemptId of result.reconcile)
    vscode.postMessage({ type: 'startup', attemptId, action: 'status' });
  if (result.updatedDraft) repaintDraft();
  return result.changed;
}

/**
 * Keep filtering local: every card is already in state, so no host round trip
 * is needed. Reload shows everything for a view of what is running now.
 */
export let filter: Filter = 'all';
export function setFilter(next: Filter): void {
  filter = next;
}

/**
 * Snapshot the matching pids at the click: repainting the match would remove
 * a card as it changes state, including a done card the reader just opened.
 * Remove only ended sessions. Changed cards stay, new matches do not join;
 * click again to refresh the set while the tally keeps counting the live board.
 */
export let picked: Set<number> | null = null;
export function setPicked(next: Set<number> | null): void {
  picked = next;
}

/**
 * What the tally can narrow to. `command` is not a status and deliberately
 * reads as one: it cuts across the others, so the counts no longer add up
 * to the total — which is the honest shape, a session can be busy *and*
 * running something. The `Tally` buckets do add up: `failed`, `done` and
 * `stalled` come out of `idle` rather than sitting beside it.
 */
export type Filter = Tally | 'command' | 'all';

const STATUS_LABELS: Record<Tally, string> = {
  busy: 'Busy',
  waiting: 'Waiting',
  failed: 'Failed',
  stalled: 'Stalled',
  done: 'Done',
  idle: 'Idle',
  unknown: 'Unknown'
};

const TALLIED = Object.keys(STATUS_LABELS) as Tally[];

export const shown = (g: GroupView): CardView[] => {
  // Read into a const first: `picked` is a module-level `let`, so the narrowing
  // the check above buys does not survive into the callback.
  const set = picked;
  return set ? g.sessions.filter((s) => set.has(s.pid)) : g.sessions;
};

export const matches = (s: CardView, want: Filter): boolean =>
  want === 'all' || (want === 'command' ? !!s.hasCommand : reading(s).tally === want);

/** Keyed navigation keeps a press attached to its destination across pushes. */
export function renderNav(): void {
  syncBoardView();
  renderSessionsHead();
  if (heldOpen(nav)) return;

  const fromBrand = usageBrand;
  const outgoing = snapshotUsageFace(nav);

  const actions = el('div');
  actions.id = 'nav-actions';

  // Both faces are always drawn — a reading still being taken waits in its own
  // slot and fills in, whichever of the two lands first — and keyed for what a
  // repaint must not disturb.
  const machine = machineGauge();
  machine.dataset.key = 'machine';
  const memory = memoryGauge();
  memory.dataset.key = 'machine-mem';
  // Named, because the step that takes the dials away has to take their rule
  // with them — a separator with nothing on one side of it separates nothing.
  const machineRule = el('span', 'vr machv');
  machineRule.dataset.key = 'machine-vr';
  actions.append(machine, memory, machineRule);

  // planUsage owns the shape-specific keys; see its note before changing them.
  const usage = planUsage();
  const usageRule = el('span', 'vr usagev');
  usageRule.dataset.key = 'usage-vr';
  actions.append(usage, usageRule);

  const gear = settings.control();
  gear.dataset.key = 'settings';
  actions.append(gear);

  const views = el('div', 'board-views');
  views.dataset.key = 'board-views';
  for (const view of ['sessions', 'tickets'] as const) {
    const button = el(
      'button',
      'board-view' + (ui.boardView === view ? ' on' : '')
    ) as HTMLButtonElement;
    button.id = 'board-' + view;
    button.dataset.act = view;
    button.dataset.key = 'view:' + view;
    button.setAttribute('aria-pressed', String(ui.boardView === view));
    button.disabled = editing();
    button.append(el('span', 'nm', view === 'sessions' ? 'Sessions' : 'Tickets'));
    if (view === 'sessions') {
      const badge = el(
        'span',
        'tb',
        ui.ready
          ? String(ui.state.groups.reduce((count, group) => count + group.sessions.length, 0))
          : ''
      );
      if (!ui.ready) {
        badge.setAttribute('aria-label', 'Loading sessions');
        badge.append(el('span', 'bone'));
      }
      button.append(badge);
    }
    if (view === 'tickets' && ui.state.ticketSource?.linked) {
      const n = ui.state.tickets?.length;
      const badge = el(
        'span',
        ui.state.ticketSource.stale ? 'tb warn' : 'tb',
        n === undefined ? (ui.state.ticketSource.stale ? '-' : '') : String(n)
      );
      if (n === undefined && !ui.state.ticketSource.stale) badge.append(el('span', 'bone'));
      button.append(badge);
    }
    views.append(button);
  }
  morph(nav, [views, actions], keepUsageFlip);
  flipUsageChip(nav, fromBrand, usageBrand, outgoing);
}

/** Change only the board destination; the chat keeps its owner and DOM. */
export function switchBoardView(view: 'sessions' | 'tickets'): void {
  if (editing() || ui.boardView === view) return;
  closeMenu();
  setBoardView(view);
  repaintBoard();
}

let ticketsShown = false;

/** Editor coverage counts as hidden for the host's existing refresh hint. */
export function syncBoardView(): void {
  const inEditor = editing();
  const tickets = ui.boardView === 'tickets' && !inEditor;
  const sessions = ui.boardView === 'sessions' && !inEditor;
  cards.hidden = !sessions;
  sessionsHead.hidden = !sessions;
  ticketsHead.hidden = !tickets;
  ticketsList.hidden = !tickets;
  if (ticketsShown === tickets) return;
  closeMenu();
  ticketsShown = tickets;
  vscode.postMessage({ type: 'ticketsOpen', open: tickets });
  if (tickets) renderTickets();
}

let sessionStatus: Picker | undefined;

function renderSessionsHead(): void {
  if (sessionsHead.hidden) return;
  if (!sessionStatus) {
    sessionStatus = statusControl();
    sessionsHead.append(sessionStatus);
  }
  sessionStatus.refresh();
  const n = ui.state.groups.flatMap((g) => g.sessions).filter((s) => matches(s, filter)).length;
  const trigger = sessionStatus.querySelector<HTMLElement>('.fpill');
  if (trigger) {
    trigger.toggleAttribute('disabled', !ui.ready);
    trigger.setAttribute('aria-busy', String(!ui.ready));
    const total = trigger.querySelector('.tot');
    if (total) total.textContent = ui.ready ? String(n) : '…';
    trigger.setAttribute(
      'aria-label',
      ui.ready ? `Filter sessions by status: ${filter}, ${n} sessions` : 'Loading sessions…'
    );
  }
}

function captureFilter(next: Filter): void {
  setFilter(next);
  setPicked(
    next === 'all'
      ? null
      : new Set(
          ui.state.groups.flatMap((g) =>
            g.sessions.filter((s) => matches(s, next)).map((s) => s.pid)
          )
        )
  );
  repaintBoard();
  document.getElementById('status-filter')?.focus();
}

function statusControl(): Picker {
  const control = picker({
    label: 'All sessions',
    get options() {
      const sessions = ui.state.groups.flatMap((g) => g.sessions);
      return [
        { id: 'all', label: 'All sessions', sub: String(sessions.length) },
        ...([...TALLIED, 'command'] as const).flatMap((status) => {
          const n = sessions.filter((s) => matches(s, status)).length;
          return n || filter === status
            ? [
                {
                  id: status,
                  label: status === 'command' ? 'Command' : STATUS_LABELS[status],
                  dot: status,
                  sub: status === 'command' ? `${n} · overlaps any status` : String(n)
                }
              ]
            : [];
        })
      ];
    },
    get value() {
      return filter === 'all' ? [] : [filter];
    },
    select: 'one',
    search: false,
    tip: 'Filter sessions by status; Command can overlap any status',
    get footer() {
      return filter === 'all'
        ? undefined
        : { label: 'Refresh matches', onClick: () => captureFilter(filter) };
    },
    onChange: ({ value }) => captureFilter((value[0] as Filter | undefined) ?? 'all')
  });
  control.id = 'nav-tally';
  const trigger = control.querySelector<HTMLElement>('.fpill');
  if (trigger) {
    trigger.id = 'status-filter';
    trigger.insertBefore(el('span', 'tot'), trigger.querySelector('.caret'));
  }
  const menu = control.querySelector<HTMLElement>('.fmenu');
  if (menu) {
    menu.id = 'status-menu';
    menu.setAttribute('aria-label', 'Filter sessions by status');
  }
  return control;
}

/** Preserve only the state written by a session-card arrangement gesture. */
export const carryDrag = (from: HTMLElement, to: HTMLElement): boolean => {
  // A card holding an open menu is left entirely alone, which is the nav bar's
  // rule (`heldOpen(nav)` above) narrowed to one card. The board repaints every
  // second, and rebuilding a card mid-pick detaches the trigger the menu hangs
  // off — snapping it shut and leaving `kit.ts`'s handle pointing at orphans.
  // Scoped to `.card` on purpose: a group, a grid and `#cards` all contain that
  // menu too, and freezing any of them would hold eleven other cards still for
  // a menu open on one.
  if (from.classList.contains('card') && heldOpen(from)) return false;
  if (!document.body.classList.contains('dragging-card')) return true;
  // Position and a class, every bit of it written by `showBar` and none of it
  // by a paint: updating from the staged copy would park the bar back at the
  // grid's top-left in the middle of the gesture that is aiming it.
  if (from.classList.contains('ins')) return false;
  if (from.classList.contains('lifted')) to.classList.add('lifted');
  if (from.dataset.inert !== undefined) to.dataset.inert = '';
  return true;
};
