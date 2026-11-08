/**
 * Active-chat orchestration, draft transitions and the session header.
 * Turn construction is in `chat_turns.ts`. Geometry and navigation are in
 * `chat_scroll.ts`. Chat owner transitions are in `dock.ts`.
 */

import { $, el, q, swapStamp } from './dom';
import { isMidTurn, sameSessionStart } from '../core/model';
import { chats, clearThreadKeys, input, thread, ui, vscode } from './state';
import { CACHE_NOTE, since } from './board';
import { renderQuestion } from './question';
import { lockBox, renderMention, renderSend, setBox } from './composer';
import { record } from './perf';
import * as reading from '../ui/reading';

import * as turns from './chat_turns';
import * as scroll from './chat_scroll';

export { sessionLabel, takeImage } from './chat_turns';
export { dockDrag } from './chat_scroll';

/**
 * Whether the tab is describing a session. Empty, loading, and start come from
 * the selection and the draft. `renderThread` returns before painting when the
 * thread is not the active session, and `renderActive` is what calls it.
 */
const syncEmpty = (): void => {
  const chat = $('chat');
  chat.classList.toggle('loading', !ui.ready);
  chat.setAttribute('aria-busy', String(!ui.ready));
  chat.classList.toggle('empty', !ui.selected);
  // `start` restores the composer (`ui/css/chat.ts`). Hide it during a start:
  // a second prompt would have nothing to carry it.
  chat.classList.toggle('start', !ui.selected && ui.draft !== null && !ui.draft.sending);
  // `starting` holds the disabled box while the session starts
  // (`docs/mockups/chat-first-send.html`).
  chat.classList.toggle('starting', !ui.selected && ui.draft?.sending === true);
};

export function notice(text: string): void {
  standIn(el('div', 'empty', text));
}

/**
 * Keep the first prompt in its seat until the thread arrives, so a draft
 * reveal and subsequent pushes do not alternate between the prompt and a notice.
 */
export function standBy(pid: number): void {
  if (startupHolding()) return;
  const mine = chats.session(pid);
  // Between reveal and send, the bound record still holds the prompt.
  // A refused prompt is not on its way.
  const held = mine && mine.refusal === undefined ? chats.heldFor(mine.identity) : undefined;
  const words = mine?.pending[0]?.delivered ?? held?.delivered;
  // The session a draft became keeps the head its start drew.
  if (fresh !== pid) restHead();
  if (words === undefined) notice('Loading…');
  else standIn(turns.pendingTurn(words), fresh === pid);
}

/**
 * Keep an identical node for the session a draft became: a quick start
 * can land before the flight ends, and replacement would cut the motion.
 */
function standIn(node: HTMLElement, keep = false): void {
  const same =
    keep && thread.childElementCount === 1 && thread.firstElementChild?.isEqualNode(node);
  if (!same) ground();
  clearThreadKeys();
  // Reset arrival state even for a reopened session. Its previous arrival
  // and seat no longer apply.
  scroll.reset();
  syncEmpty();
  if (!same) thread.replaceChildren(node);
  // Nothing to make room for. Left standing, the room the last thread needed
  // is up to a viewport of padding under a single line — a scrollbar over
  // blank, and an `endTop` below zero.
  scroll.clearRoom();
  scroll.renderPromptBar();
}

/**
 * The chat tab with no session in it, drawn as a state of the whole tab rather
 * than as a line in the thread. What hides is the stylesheet's — see the rule
 * in `ui/css/chat.ts`, which carries why nothing here is cleared by hand.
 */
export function renderEmptyChat(): void {
  ground();
  restHead();
  const vacant = leaveThread();
  vacant.append(
    el('h3', null, ui.ready ? 'No session selected' : 'Loading sessions…'),
    el(
      'p',
      null,
      !ui.ready
        ? 'Your sessions and workspace will appear here.'
        : ui.state.defaultCwd === undefined
          ? 'Open a folder to start a new session, or choose an existing session.'
          : 'Choose a session or press New to start a task.'
    )
  );
  thread.replaceChildren(vacant);
  scroll.clearRoom();
  if (!ui.ready) {
    lockBox(true, 'Loading session…');
    renderSend();
  }
}

function startingHead(where: string): void {
  clearStartupWait();
  startupShownAt = performance.now();
  const head = $('chat-head');
  head.className = 'starting';
  closeRename();
  const name = q(head, 'span.name');
  name.removeAttribute('role');
  delete name.dataset.tip;
  name.textContent = '';
  $('chat-startup').hidden = false;
  q($('chat-startup'), '.start-note').replaceChildren(
    el('div', 'spinner'),
    el('span', null, `Starting in ${where}…`)
  );
  q(head, '.pill').textContent = '';
  q(head, '.since').textContent = '';
}

/** A head the start drew, put down for a session that is not the one it
 *  became; the session's own thread paints the rest. */
function restHead(): void {
  clearStartupWait();
  const head = $('chat-head');
  if (!head.classList.contains('starting')) return;
  head.classList.remove('starting');
  $('chat-startup').hidden = true;
  q($('chat-startup'), '.start-note').replaceChildren();
}

/**
 * Everything both empty states do before they draw anything, and the reason it
 * is shared rather than repeated: `painted` and the thread keys are what tell
 * an arrival from a repaint, and a state that left them on the last session
 * would have the next push for that session read as "already here" and skip its
 * own arrival. The block is returned so the caller only fills it.
 */
function leaveThread(): HTMLElement {
  thread.removeAttribute('aria-busy');
  fresh = undefined;
  clearThreadKeys();
  scroll.reset();
  syncEmpty();
  return el('div', 'vacant');
}

/**
 * The press that starts a draft, as motion: every element moves once, toward
 * where it will live (docs/mockups/chat-first-send.html, "A · one path"). The
 * prompt flies from the box to its seat, and the block it replaces fades up and
 * away.
 *
 * `slide`'s shape (kit.ts): measure, repaint, invert, animate. Where nothing
 * `moves()` — jsdom, reduced motion — the press is the cut, and the suite stays
 * synchronous.
 */
type Lift = {
  box: DOMRect;
  vacant: HTMLElement;
  vacantAt: DOMRect;
};

/** Whether this panel animates at all: jsdom has no `animate`, and a reader
 *  who asked for less motion gets the cut. */
function moves(): boolean {
  return (
    typeof Element.prototype.animate === 'function' &&
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

function takeOff(): Lift | undefined {
  const vacant = thread.querySelector<HTMLElement>(':scope > .vacant');
  if (!moves() || !vacant) return undefined;
  return {
    box: input.getBoundingClientRect(),
    vacant,
    vacantAt: vacant.getBoundingClientRect()
  };
}

function fly(from: Lift, seat: HTMLElement): void {
  const to = seat.getBoundingClientRect();
  aloft(
    seat.animate(
      [
        {
          transform: `translate(${from.box.left - to.left}px, ${from.box.top - to.top}px)`,
          opacity: 0.6
        },
        { transform: 'none', opacity: 1 }
      ],
      { duration: 360, easing: 'cubic-bezier(.2, .8, .2, 1)' }
    )
  );
  const { vacant, vacantAt } = from;
  vacant.classList.add('aloft');
  Object.assign(vacant.style, {
    left: `${vacantAt.left}px`,
    top: `${vacantAt.top}px`,
    width: `${vacantAt.width}px`,
    height: `${vacantAt.height}px`
  });
  document.body.append(vacant);
  aloft(
    vacant.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(-6px)' }
      ],
      { duration: 160, fill: 'forwards' }
    ),
    vacant
  );
}

function extendHead(head: HTMLElement): void {
  if (!moves()) return;
  const style = getComputedStyle(head);
  const easing = 'cubic-bezier(.2, .8, .2, 1)';
  aloft(
    head.animate(
      [
        {
          height: '0px',
          paddingTop: '0px',
          paddingBottom: '0px',
          borderBottomWidth: '0px',
          overflow: 'hidden'
        },
        {
          height: style.height,
          paddingTop: style.paddingTop,
          paddingBottom: style.paddingBottom,
          borderBottomWidth: style.borderBottomWidth,
          overflow: 'hidden'
        }
      ],
      { duration: 320, easing }
    )
  );
  for (const child of head.querySelectorAll<HTMLElement>(':scope > *')) {
    if (child.hidden) continue;
    aloft(
      child.animate(
        [
          { opacity: 0, transform: 'translateY(-8px)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 240, easing }
      )
    );
  }
}

/**
 * Cancel flights when leaving a draft, so its block cannot float over
 * the next surface.
 */
const flights = new Set<Animation>();

function aloft(flight: Animation, node?: HTMLElement): void {
  flights.add(flight);
  const land = (): void => {
    flights.delete(flight);
    node?.remove();
  };
  flight.onfinish = land;
  flight.oncancel = land;
}

function ground(): void {
  for (const flight of [...flights]) flight.cancel();
}

/**
 * The session a draft became, until its first reply is drawn. Working dots
 * do not spend this arrival.
 */
let fresh: number | undefined;
let startupShownAt = 0;
let startupWait: { pid: number; startedAt: number; timer: number } | undefined;

export function startupHolding(): boolean {
  const active = chats.active();
  return (
    startupWait !== undefined &&
    active?.kind === 'session' &&
    active.pid === startupWait.pid &&
    sameSessionStart(active.startedAt, startupWait.startedAt)
  );
}

export function landed(pid?: number): void {
  clearStartupWait();
  fresh = pid;
  if (pid === undefined) return;
  const active = chats.active();
  const remaining = moves() ? Math.max(0, 400 - (performance.now() - startupShownAt)) : 0;
  if (
    remaining === 0 ||
    active?.kind !== 'session' ||
    active.pid !== pid ||
    $('chat-startup').hidden
  ) {
    $('chat-startup').hidden = true;
    return;
  }
  // The process is ready; these startup actions no longer apply during the visual hold.
  for (const button of $('chat-startup').querySelectorAll<HTMLButtonElement>('button'))
    button.disabled = true;
  const timer = window.setTimeout(() => {
    if (startupWait?.timer !== timer) return;
    const current = startupHolding();
    startupWait = undefined;
    if (!current) return;
    // Hide before composer reflows can re-center the feedback.
    $('chat-startup').hidden = true;
    lockBox(false, 'Message this session…');
    setBox();
    renderMention();
    renderActive();
  }, remaining);
  startupWait = { pid, startedAt: active.startedAt, timer };
}

function clearStartupWait(): void {
  if (startupWait !== undefined) window.clearTimeout(startupWait.timer);
  startupWait = undefined;
}

function rises(turn: HTMLElement, pid: number): void {
  if (fresh !== pid) return;
  turn.classList.add('rise');
  fresh = undefined;
}

/**
 * The draft: a New with a surface and no process behind it.
 *
 * Paint only — what is in the box is `ui.draft.doc`, which the composer writes
 * on every keystroke, and this never decides it. `showDraft` in `dock.ts` is
 * the way *in*, the way `select` is for a session.
 *
 * Two states, and the difference is one class the stylesheet already reads. At
 * rest the composer is back and centred, and the block over it names the folder
 * the session will run in — the one fact a reader cannot change from here,
 * since the slot that was pressed is what decided it. While the start is in
 * flight it is drawn as the session it is becoming: `starting`, below.
 */
function renderDraft(): void {
  const draft = chats.activeDraft();
  if (!draft) {
    // A timeout or refusal can arrive after a card selection. Do not replace
    // that session's thread with the vacant state.
    if (ui.selected === null) renderEmptyChat();
    return;
  }
  // Read the previous paint's classes before `leaveThread` rewrites them.
  const chat = $('chat');
  const pressed = draft.sending && chat.classList.contains('start');
  const underway = draft.sending && chat.classList.contains('starting');
  const from = pressed ? takeOff() : undefined;
  // Keep flights during a push mid-start, or the motion would stop.
  if (!underway) ground();
  const vacant = leaveThread();
  const where = ui.state.groups.find((g) => g.cwd === draft.cwd)?.label ?? draft.cwd;
  if (draft.sending) {
    // Draw once per start: another push would restart the spinner and
    // replace the seat mid-flight.
    if (!underway) {
      const held = chats.heldFor({ kind: 'draft', cwd: draft.cwd });
      const seat = turns.pendingTurn(held?.delivered ?? '');
      thread.replaceChildren(seat);
      startingHead(where);
      if (from) fly(from, seat);
    }
    const note = q($('chat-startup'), '.start-note');
    note.replaceChildren(
      el('div', 'spinner'),
      el('span', null, draft.startupNote ?? `Starting in ${where}…`)
    );
    const actions = el('div', 'startup-actions');
    for (const [action, label] of [
      ['status', 'Check status'],
      ['cancel', draft.cancelling ? 'Cancelling…' : 'Cancel start']
    ] as const) {
      const button = el('button', null, label);
      button.dataset.startup = action;
      button.toggleAttribute('disabled', action === 'cancel' && draft.cancelling === true);
      button.onclick = () => {
        if (action === 'cancel') {
          chats.noteStartup(draft.id, 'Cancelling start. Your message is held.', true);
          renderDraft();
        }
        vscode.postMessage({ type: 'startup', attemptId: draft.id, action });
      };
      actions.append(button);
    }
    note.append(actions);
  } else {
    restHead();
    vacant.append(
      el('h3', null, 'New session in ' + where),
      el('p', null, 'Describe the task and it starts on your first message.')
    );
    // The only place a reader learns a start did not happen: the host's own
    // warning is a notification, and those are muted here.
    if (draft.reason) vacant.append(el('p', 'why', draft.reason));
    const identity = { kind: 'draft' as const, cwd: draft.cwd };
    const held = chats.heldFor(identity);
    if (held) vacant.append(turns.heldTurn(held, identity));
    thread.replaceChildren(vacant);
  }
  scroll.clearRoom();
  lockBox(draft.sending, 'Describe a task…');
  setBox();
  renderMention();
  $('blocked').textContent = '';
}

export function renderActive(view?: ThreadView): void {
  if (startupHolding()) return;
  const active = chats.active();
  if (!active) {
    renderEmptyChat();
    return;
  }
  if (active.kind === 'draft') {
    renderDraft();
    return;
  }
  const next = view ?? chats.thread();
  if (!next || next.pid !== active.pid || !sameSessionStart(next.startedAt, active.startedAt)) {
    standBy(active.pid);
    return;
  }
  renderThread(next);
}

/**
 * The head's stamp, on the board's 1 s beat rather than the 3 s push.
 *
 * `renderThread` runs only when a state push lands, so the dock's "Ns ago"
 * used to step in threes and sit up to that far behind the card for the same
 * session — two stamps of one instant, disagreeing on screen. Only the stamp
 * is redrawn: everything else in the head changes when the push says it did,
 * and the thread below it is the expensive part.
 */
export function tickHead(): void {
  const t = chats.thread();
  if (!t || ui.selected === null) return;
  // See `swapStamp` in `dom.ts` for stamp deduplication.
  swapStamp(q($('chat-head'), '.since'), since(t));
}

/**
 * Interrupt is live while a turn is open (`isMidTurn`) and the CLI has opened
 * it (`turnPending`). The head button and Escape share this, so an offscreen
 * button has no live key.
 *
 * `waiting` still needs `owned`. `canControl` stays true when control is
 * invalid on a session this window does not drive (`toCard`), and that
 * session has no pipe an interrupt can retract.
 */
export function endable(t: ThreadView | undefined): boolean {
  if (!t || !t.canControl || !isMidTurn(t.status) || t.turnPending) return false;
  return t.status !== 'waiting' || t.owned === true;
}

export function renderThread(t: ThreadView | undefined): void {
  record('renderThread');
  const active = chats.active();
  if (
    !t ||
    active?.kind !== 'session' ||
    t.pid !== active.pid ||
    !sameSessionStart(t.startedAt, active.startedAt)
  ) {
    return;
  }
  syncEmpty();

  if (fresh !== t.pid) fresh = undefined;
  const head = $('chat-head');
  const { word, tally } = reading.reading(t);
  const starting = head.classList.contains('starting');
  restHead();
  head.className = t.status + (tally === t.status ? '' : ' ' + tally);
  // `.name` also matches the rename box. Select the span.
  const name = q(head, 'span.name');
  // Close a rename addressed to a different session, or Enter would
  // rename the wrong card.
  if (
    renaming() &&
    (renameBox.dataset.pid !== String(t.pid) ||
      !sameSessionStart(Number(renameBox.dataset.startedAt), t.startedAt))
  ) {
    closeRename();
  }
  // Not written while it is being typed into. The poll runs every 3s and the
  // name it would write is the *old* one — the new one is not on disk until the
  // reader presses Enter — so a repaint mid-edit undoes the typing.
  if (!renaming()) {
    name.textContent = t.name;
  }
  // Mark the name itself so the affordance and handler agree.
  // A background session is drawn and not driven.
  if (t.owned) {
    name.setAttribute('role', 'button');
    name.dataset.tip = 'Rename this session';
  } else {
    name.removeAttribute('role');
    delete name.dataset.tip;
  }
  q(head, '.pill').textContent = word;
  q(head, '.since').replaceWith(since(t));
  $('chat-needs').textContent = t.needs ?? '';
  $('chat-stop').style.display = t.canControl ? '' : 'none';
  $('chat-interrupt').style.display = endable(t) ? '' : 'none';

  const rows = turns.renderTurns(t, rises);
  if (t.historyAvailable || t.fullHistory)
    rows.unshift({
      key: `history-nav|${!!t.fullHistory}`,
      make: () => {
        const nav = el('nav', 'history-nav');
        nav.setAttribute('aria-label', 'Conversation history');
        const control = el(
          'button',
          null,
          t.fullHistory ? 'Back to recent chat' : 'Browse full chat history'
        ) as HTMLButtonElement;
        control.type = 'button';
        control.dataset.history = t.fullHistory ? 'recent' : 'browse';
        control.onclick = () => {
          const request = chats.historyRequest(!t.fullHistory);
          if (request) vscode.postMessage(request);
        };
        nav.append(control);
        return nav;
      }
    });
  thread.setAttribute('aria-busy', String(t.historyState === 'loading'));
  if (t.historyState) {
    const state = t.historyState;
    rows.unshift({
      key: `history|${state}`,
      make: () => {
        const note = el('div', 'history-note');
        note.setAttribute('role', 'status');
        if (state === 'loading') note.append(el('span', 'spinner'));
        note.append(
          el(
            'span',
            null,
            state === 'loading'
              ? 'Loading conversation…'
              : 'Conversation history could not be loaded.'
          )
        );
        return note;
      }
    });
  }
  const grew = scroll.beforePaint(t);
  const moved = rows.length ? turns.paint(rows) : false;
  if (!rows.length) notice('No conversation found for this session.');
  scroll.afterPaint(t.pid, rows.length > 0, moved);
  lockBox(!t.canSend, t.canSend ? 'Message this session…' : 'Sending is unavailable');
  // A readable ask has its own control and its own way into it, so the reason
  // is redundant. A cold-cache warning outlives the 3s repaint that would
  // otherwise wipe it a blink after the Enter that raised it — the confirmation
  // it asks for is the reader's, on their own clock. A refused send leads: it
  // is the newest thing the reader did, and the only one carrying a sentence of
  // its own rather than a constant — but not once the session has *ended*, where
  // `blockedReason` is the current account of the world and the refusal is a
  // sentence about a send that no longer has a session to go to; the box is
  // disabled, so no retry could clear it either.
  //
  // `ended` rather than `!canSend`, which was the first cut and took the rule
  // too far: an unreachable session is unsendable from the moment it is drawn,
  // so its own reason was already on this line before the click — the one case
  // where yielding leaves a refused Interrupt with nothing at all to show for
  // it. That silence is what `abd05438` removed and `notices.smoke.ts` guards.
  const owned = chats.session(t.pid);
  $('blocked').textContent =
    owned?.refusal && (t.canSend || !t.ended)
      ? owned.refusal
      : t.canSend || t.pending?.length
        ? owned?.recache
          ? CACHE_NOTE
          : ''
        : (t.blockedReason ?? '');
  renderSend();
  renderQuestion(t);

  // Workflow slot (#wattach) is painted by renderMention — main/dock call it on
  // every board/thread push and selection so live vs attach stays exclusive. That used
  // to be the only way to keep chat and composer from importing each other;
  // `renderSend` above is that import, so the cycle is here now and the call
  // site is a habit rather than a rule. It holds because both directions export
  // hoisted function declarations and neither module calls across at load time
  // — which is the thing to check before moving anything else across. Drawer
  // rail rides the same thread.workflow and is painted from renderMention
  // (after the live chip exists).

  // Finish after changes to composer height. `chat_scroll.ts` observes
  // anything that arrives later.
  scroll.finishPaint(grew);
  if (starting) extendHead(head);
}

/**
 * Renaming a session from the dock's head: the name is a button, and pressing
 * it swaps in the box it becomes.
 *
 * The swap is what keeps the poll out of it — `renderThread` writes the span it
 * can see and never the box — and it is also the whole of the state. There is
 * no `ui.renaming` flag to fall out of step: whether a rename is open is
 * whether the box is on screen.
 *
 * Nothing is painted on commit, and the reason is no longer that the answer is
 * slow. The host states the name itself — `stateName` writes `core/names.ts`,
 * republishes the live half and refreshes, all before `renameSession` returns —
 * so the fold has the new name by the message that lands here next, and no CLI
 * is waited on for it. What painting locally would buy is nothing; what it would
 * cost is a second place the name rungs are ranked, disagreeing with
 * `ui/views.ts` the first time a store write or another window's statement wins.
 */
const renameBox = $('chat-rename') as HTMLInputElement;

function renaming(): boolean {
  return !renameBox.hidden;
}

export function closeRename(): void {
  renameBox.hidden = true;
  q($('chat-head'), 'span.name').hidden = false;
}

export function openRename(): void {
  const name = q($('chat-head'), 'span.name');
  const owner = chats.active();
  if (name.getAttribute('role') !== 'button' || renaming() || owner?.kind !== 'session') {
    return;
  }
  renameBox.value = name.textContent ?? '';
  renameBox.dataset.pid = String(owner.pid);
  renameBox.dataset.startedAt = String(owner.startedAt);
  name.hidden = true;
  renameBox.hidden = false;
  renameBox.focus();
  renameBox.select();
}

q($('chat-head'), 'span.name').onclick = openRename;

/**
 * The name field and composer `/rename <title>` share this entry.
 * The field closes before calling.
 */
export function submitRename(pid: number, startedAt: number, title: string): void {
  const want = title.replace(/\s+/g, ' ').trim();
  const owner = chats.active();
  if (
    !want ||
    owner?.kind !== 'session' ||
    owner.pid !== pid ||
    !sameSessionStart(owner.startedAt, startedAt) ||
    want === q($('chat-head'), 'span.name').textContent
  ) {
    return;
  }
  vscode.postMessage({ type: 'rename', pid, startedAt, title: want });
}

renameBox.onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const title = renameBox.value;
    const pid = Number(renameBox.dataset.pid);
    const startedAt = Number(renameBox.dataset.startedAt);
    closeRename();
    submitRename(pid, startedAt, title);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeRename();
  }
};

// A click elsewhere abandons the rename: the reader reached for
// something else, and a rename takes one keystroke to redo.
renameBox.onblur = closeRename;

$('chat-interrupt').onclick = () => {
  const active = chats.active();
  if (active?.kind === 'session')
    vscode.postMessage({ type: 'interrupt', pid: active.pid, startedAt: active.startedAt });
};
$('chat-stop').onclick = () => {
  const active = chats.active();
  if (active?.kind === 'session')
    vscode.postMessage({ type: 'close', pid: active.pid, startedAt: active.startedAt });
};
$('chat-link').onclick = () => {
  if (ui.selected) vscode.postMessage({ type: 'copyRef', pid: ui.selected });
};
