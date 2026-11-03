import { q } from './dom';
import type { Anchor } from '../ui/chat_state';
import { chatBody, chats, promptBar, thread, ui } from './state';
import { record } from './perf';
import { ELIDED } from './chat_turns';

export function reset(): void {
  painted = undefined;
  seat = false;
}

/** Clear trailing space after the replacement nodes are in the document. */
export function clearRoom(): void {
  setRoom(0);
}

let displayedHistory = false;

export function beforePaint(t: ThreadView): boolean {
  if (displayedHistory !== !!t.fullHistory) {
    displayedHistory = !!t.fullHistory;
    painted = undefined;
    cursor = -1;
    clearRoom();
  }
  // Whether the session has said anything since the last paint, for `finishPaint`.
  //
  // Three terms, and each is load-bearing. **This session's own last reading**:
  // on an arrival `spoken` describes whichever session was on screen before,
  // and comparing two conversations answers nothing — a shorter one there reads
  // as turns having landed in this one. `place` below stands a returning reader
  // where they left off and `repin` runs after it, so that misreading would
  // land as an override of the restore.
  //
  // **A session that is working.** A card reads idle for seconds while the
  // panel's record is still catching up with the send before it — the reply's
  // body lands after the status has flipped back — and following that moved a
  // parked reader 422px on a card saying IDLE, which is the complaint this
  // whole fix is about. Nothing a settling record does is the session speaking
  // *now*, and a reader is only ever moved for what is happening now.
  //
  // **More than it had said**, not merely different: a turn the panel
  // reconciles away shortens the conversation, and that is nothing to follow.
  const heard = saying(t);
  const grew =
    painted === t.pid &&
    !displayedHistory &&
    t.status === 'busy' &&
    (heard.n > spoken.n || (heard.n === spoken.n && heard.size > spoken.size));
  spoken = heard;
  return grew;
}

export function afterPaint(pid: number, hasTurns: boolean, moved: boolean): void {
  if (moved) fitRoom();
  // Restore on arrival only, so polls do not move the reader. Wait for turns:
  // a notice or cold cache would spend the arrival before the real thread lands.
  if (hasTurns && painted !== pid) {
    painted = pid;
    seat = true;
    // Another session's thread, so the prompt the arrows were on is not in it.
    cursor = -1;
    if (displayedHistory) {
      thread.scrollTop = 0;
      pinned = false;
      seat = false;
    } else place();
  }
}

/** After the composer and question controls have reached their painted state. */
export function finishPaint(grew: boolean): void {
  repin(grew);
  renderPromptBar();
}

/**
 * The prompts this thread is showing, oldest first. Every kind of user turn
 * counts — one the CLI has taken, one still being echoed, one queued behind the
 * current turn — because all three are things the reader asked for.
 *
 * A message another session sent is the one user turn that is not: it wears
 * `.peer` and is stepped over, or the arrows would walk a reader through
 * prompts they never wrote.
 *
 * Read on every scroll and never held: `paint` leaves the unchanged head of the
 * thread standing and rebuilds the tail, so a node kept across a repaint can be
 * one that was removed.
 */
function prompts(): HTMLElement[] {
  return [...thread.querySelectorAll<HTMLElement>('.turn.user:not(.peer)')];
}

/**
 * Which prompt the turns on screen belong to: the last one whose top has reached
 * the top of the thread. `-1` when none has, which is the bar's cue to stay away
 * — there is nothing to remind anyone of while their prompt is right there.
 *
 * The comparison includes a prompt sitting exactly at the fold, because that is
 * where a step leaves one and where `place` puts a returning reader back —
 * `remember` writes the anchor down at zero delta precisely when an arrow put
 * them there. Under `<` the bar would name the prompt before it on arrival.
 * The step itself no longer depends on this: `cursor` carries the arrows now.
 *
 * `offsetTop` is the offset within the thread, which `#thread`'s own
 * `position: relative` is there to guarantee.
 */
function governing(ps: HTMLElement[]): number {
  let i = -1;
  for (let k = 0; k < ps.length; k++) {
    if ((ps[k]?.offsetTop ?? 0) <= thread.scrollTop) i = k;
  }
  // The end of the conversation is a second fold. A reader resting there has
  // reached every prompt, whatever is standing at the top of the view — the
  // newest exchange is in front of them, and naming an older one would put the
  // bar in amber over a prompt the reader can see. This is where a followed
  // session sits, so it is the reading the bar gives most of the time.
  //
  // Only once some prompt has scrolled off: a thread short enough to need no
  // scrolling is at its end from the moment it is drawn, and the bar's whole
  // rule is to stay away while the reader's prompt is still in front of them.
  if (i >= 0 && atEnd()) return ps.length - 1;
  return i;
}

/**
 * Which prompt the arrows are standing on. `-1` means the thread still says it
 * — `governing` above — and that is what this returns to at the first sign of
 * the reader scrolling for themselves.
 *
 * It has to exist because `scrollTop` cannot say. `governing` reads the end of
 * the conversation as the newest prompt however the thread is standing, so
 * every step into the last screenful reads back as that one index — and
 * deriving the bar from the position alone saturated there: `dn` re-derived the
 * index it had just moved off, which is one step down the thread and then a
 * live button that did nothing, with the count naming a prompt the reader had
 * already scrolled past.
 *
 * `room` fixed the scrolling half of that — the step lands on the prompt now
 * rather than short of it — and not this half. The reading is a judgement about
 * where the reader is, not a measurement it could take.
 */
let cursor = -1;

/**
 * Where our own last step left the thread, read back rather than kept: the
 * browser clamps, at the head of a thread and at the end of the room under it.
 * The scroll handler compares against this to tell our scrolling from the
 * reader's — the same test `placed` makes for the seat.
 */
let aimed = -1;

/**
 * The prompt the bar is about. The clamp bounds the index into the list, so a
 * thread that came back shorter names a prompt that is on screen rather than
 * nothing — it does not pin identity, and one case does slip through: the
 * record keeps the last `MAX_TURNS` authored turns (`core/record.ts`), so turns
 * rolling off the head shift every index down while the count holds, and the
 * bar names the neighbour. Rare, an index off by however many rolled, and the
 * reader's next scroll re-derives it. A fold is not that case — fold rows are
 * machinery and never a user turn, so toggling one moves no index here.
 */
function standing(ps: HTMLElement[]): number {
  return cursor >= 0 && cursor < ps.length ? cursor : governing(ps);
}

function promptVisible(node: HTMLElement | undefined): boolean {
  return (
    !!node &&
    node.offsetTop < thread.scrollTop + thread.clientHeight &&
    node.offsetTop + node.offsetHeight > thread.scrollTop
  );
}

function step(top: number): void {
  thread.scrollTop = top;
  aimed = thread.scrollTop;
  renderPromptBar();
}

function jumpTo(node: HTMLElement): void {
  step(node.offsetTop);
}

const cut = (): boolean => !!thread.firstElementChild?.classList.contains('elided');

/**
 * The bar, derived from where the thread is scrolled to and nothing else. It
 * holds no state of its own, so a repaint cannot leave it describing a turn that
 * is no longer there, and scrolling by hand moves it exactly as its arrows do.
 */
export function renderPromptBar(): void {
  record('promptBar');
  const ps = prompts();
  // At the top of a truncated thread there is no older prompt to name, but
  // there is something to say: where the rest of the conversation went. Leaving
  // the arrow dead with no explanation reads as a broken button.
  const head = cut() && thread.scrollTop <= 0;
  const i = head ? -1 : standing(ps);
  promptBar.hidden = !head && i < 0;
  if (promptBar.hidden) return;

  const at = head ? undefined : ps[i];
  promptBar.classList.toggle('head', head);
  promptBar.classList.toggle('past', !head && i < ps.length - 1);
  q(promptBar, '.tag').textContent = head ? 'start' : 'you';
  q(promptBar, '.txt').textContent = head
    ? ELIDED
    : (at?.querySelector('.body')?.textContent ?? '');
  // A count of one counts nothing; the bar is pure recall in that case.
  q(promptBar, '.count').textContent = head || ps.length < 2 ? '' : `${i + 1}/${ps.length}`;
  (q(promptBar, '.up') as HTMLButtonElement).disabled =
    head || (i === 0 && promptVisible(at) && !cut());
  // Down runs out only at the newest prompt with the thread already at its end:
  // until then there is either another prompt or the rest of this one's replies.
  (q(promptBar, '.dn') as HTMLButtonElement).disabled = !head && i === ps.length - 1 && atEnd();
}

/**
 * Trailing space under the last turn, in pixels, so that every prompt can be
 * lifted to the top of the thread. Written to `--room` for `css/chat.ts` to
 * spend as padding, and kept here because the arithmetic below has to take it
 * back off again.
 *
 * A prompt is addressable by scroll only while its `offsetTop` is inside
 * `scrollHeight - clientHeight`, and the newest ones are not: nothing follows
 * them but their own replies. So the thread had one edge where it needs two —
 * the end of the conversation, which is where a reader rests, and the limit of
 * the scroll range, which has to reach past it far enough for the last prompt
 * to make the fold. `endTop` is the first; `scrollHeight` is now only ever the
 * second.
 */
let room = 0;

/**
 * Measure the room and hand it to the stylesheet. Sized for the *last* prompt,
 * which is enough for all of them: the room puts `maxScroll` at its `offsetTop`,
 * and every other prompt's is smaller.
 *
 * On a paint, because that is the only thing that moves an offset. Not on a
 * scroll — nothing there changes what this reads, and writing a style from the
 * scroll handler would move the geometry under a scroll in progress.
 */
function fitRoom(): void {
  // The two states where the thread's own measurements are not to be believed,
  // and the same two `grip` and `remember` already refuse to read: offsets are
  // guesses under `resizing`, and a hidden tab lays nothing out at all.
  if (dragging || chatBody.hidden) return;
  const ps = prompts();
  const last = ps[ps.length - 1];
  let want = 0;
  // Nothing measured for a thread with no prompt in it — the reads below force
  // a layout, and a notice has nothing to make room for.
  if (last) {
    const natural = thread.scrollHeight - room;
    // A thread that fits needs none either: nothing has scrolled off it, the
    // bar stays away, and room would invent a scroll for a reader with no fold.
    // Rounded, so that sub-pixel drift in a reflowed thread does not rewrite
    // the property every paint for a room nobody could see the difference in.
    if (natural > thread.clientHeight) {
      want = Math.max(0, Math.round(last.offsetTop + thread.clientHeight - natural));
    }
  }
  setRoom(want);
  // Carry a follower with the end they were resting on, when that end moves
  // under them. The record catching up with itself is what moves it: an empty
  // assistant shell goes away, the content shrinks, and the room above grows by
  // exactly as much to keep the last prompt liftable — so `scrollHeight` never
  // moves, the browser never clamps, and the reader is left standing that far
  // into the blank. `repin` will not take them back, and should not have to:
  // a paint that measured its own room has not heard the session say anything.
  // Measured in the host 2026-09-03 — a follower left 42px in, and 279.5px
  // before the scenario aimed where a follower rests.
  //
  // Only a reader still standing exactly where they were put. One pixel of
  // their own is a choice, and the room exists so that a choice can be kept —
  // which is why this reads `rested` and not a position.
  if (
    !displayedHistory &&
    pinned &&
    cursor < 0 &&
    rested >= 0 &&
    Math.abs(thread.scrollTop - rested) <= 1
  ) {
    const end = endTop();
    if (Math.abs(thread.scrollTop - end) > 1) {
      thread.scrollTop = end;
      rested = thread.scrollTop;
    }
  }
}

/** The one writer of the property. Guarded, so a paint that measures the same
 *  room again writes no style and invalidates no layout. */
function setRoom(px: number): void {
  if (px === room) return;
  room = px;
  thread.style.setProperty('--room', `${room}px`);
}

/** Where the thread rests: its last turn on the floor of the view. Not
 *  `scrollHeight`, which is the end of the room under it. */
const endTop = (): number => thread.scrollHeight - room - thread.clientHeight;

/** How far the thread is from where it rests, in pixels. Negative for a reader
 *  standing in the room, who is past the end rather than short of it. */
const fromBottom = (): number => endTop() - thread.scrollTop;

/** Whether the thread has no further to go. The 4px is for the fractional
 *  scroll positions a device-pixel ratio leaves behind, not for a margin. */
const atEnd = (): boolean => fromBottom() < 4;

/** Whether the reader is standing in the room rather than resting on the end of
 *  the conversation. Never where a session opens — `place` puts a reader here
 *  only to give back a place they chose, so every way of arriving is one they
 *  asked for. Same 4px as `atEnd`, for the same reason. */
const inRoom = (): boolean => fromBottom() < -4;

/**
 * Measure exchanges, not rendered rows: folds, outbox messages, the signed-out
 * CTA and fetched images change rows without the session speaking. An outbox
 * or CTA after a streaming reply also hides growth from a tail-row comparison.
 * Two numbers distinguish growth from reconciled turns shortening the thread.
 */
let spoken = { n: 0, size: 0 };

function saying(t: ThreadView): typeof spoken {
  const last = t.exchanges.at(-1);
  return {
    n: t.exchanges.length,
    size: last && 'text' in last ? last.text.length + last.blocks.length : 0
  };
}

/**
 * Whether the reader is standing at the end of the thread. Kept across paints
 * rather than measured at the top of one, because the composer settles its
 * height after `renderThread` returns — see the observer at the foot of this
 * file.
 *
 * Decided afresh by `place` on every arrival, so it describes the session on
 * screen. It used to describe whichever session was last scrolled: reading one
 * to its top left the next session opened standing at its top too, and the one
 * after that wherever the second was left.
 */
let pinned = true;

/** Where the last `repin` left the reader, or `-1` for one who has scrolled
 *  since. Only `fitRoom` reads it. */
let rested = -1;

/**
 * Follow growth reported by beforePaint. A box changing size only re-places
 * the reader and must not count as the session speaking.
 */
const repin = (grew = false): void => {
  if (displayedHistory) return;
  // An arrow parks on a prompt: following would undo the choice on the next
  // poll. Manual scrolling clears cursor; down to the end does not park.
  // A reader in the room follows only growth. Position cannot distinguish
  // choosing a prompt from flicking to the bottom to follow. Repeated paints
  // must preserve that choice, while the next turn brings a follower to the tail.
  if (pinned && cursor < 0 && (grew || !inRoom())) {
    thread.scrollTop = endTop();
    // Where a follower was put, for `fitRoom` to tell one who has not moved
    // since from one who chose the blank. Read back rather than assumed: the
    // browser clamps this write, and a value it refused is not a rest.
    rested = thread.scrollTop;
  }
};

/**
 * Whether the divider is being dragged, for the length of the drag. Set by
 * `main.ts`, which owns the pointer.
 *
 * A width change reaches the thread through the ResizeObserver at the foot of
 * this file: `repin` writes `scrollTop`, and the passive listener that fires off
 * that write reads the whole thread back — `prompts()` is a `querySelectorAll`
 * over every turn, and `governing` and `atFold` then walk their `offsetTop`.
 * Once per frame, over the 400 authored turns `MAX_TURNS` allows.
 *
 * Measured over a 5s drag on a 400-prompt thread, headless Chromium: 300 trips
 * through here costing 605ms of script, down to one costing 18ms. A three-turn
 * thread never arrives at all — it does not overflow, so the repin writes no
 * scroll — which is why a fresh conversation costs nothing and the complaint
 * grows with the conversation.
 *
 * Neither reading can move under a width change alone — the reader is where
 * they were, and the prompt governing them is the same prompt — so both wait
 * for the mouse to come up, and run once.
 *
 * The layout half of the same drag is `#thread.resizing` (`css/chat.ts`), where
 * it is measured. It is why `grip` below exists: while that class is on, the
 * thread's own measurements are guesses.
 */
let dragging = false;

/**
 * The turn the drag holds still, and how far below its top the fold sits.
 *
 * Under `resizing` a turn that has never been on screen stands at a guessed
 * height, so every offset in the thread is wrong by however much of it is above
 * the reader. The turn the reader is looking at is not: it is rendered, by
 * definition, so holding them against it survives the guessing.
 *
 * Nothing to hold for a reader already at the end, where `repin` is exact
 * without one — what is guessed is all above the last turn, so the end of the
 * guessed thread and the end of the real one are the same pixel.
 *
 * Chromium's own scroll anchoring is this feature, and does not do it here: a
 * width change on the scroller itself suppresses it, which is every frame of
 * this drag. Measured — the turn held 294px under the fold came back 32334px
 * out of place with these three lines stubbed.
 */
let grip: { el: HTMLElement; delta: number } | undefined;

const grab = (): void => {
  // The same test `repin` makes, and it has to be: what needs no grip is a
  // reader `repin` puts back exactly. Nobody in the room is that — the drag
  // moves no turn, so `repin` declines them whether an arrow parked them there
  // or their own scroll did, and the re-wrap moves the very offset they stand
  // on.
  const held = pinned && cursor < 0 && !inRoom();
  const kid = held ? undefined : (thread.children[atFold()] as HTMLElement | undefined);
  grip = kid ? { el: kid, delta: thread.scrollTop - kid.offsetTop } : undefined;
};

/** Put them back where `grab` found them. A push mid-drag rebuilds the tail out
 *  from under the turn being held, so a lost grip is taken again rather than
 *  dropped — that cannot undo the repaint, but it stops the rest of the drag
 *  running unheld. */
const hold = (): void => {
  if (!grip?.el.isConnected) grab();
  if (!grip) return repin();
  thread.scrollTop = grip.el.offsetTop + grip.delta;
};

/** Told to the thread by `main.ts` at both ends of a divider drag. The end of
 *  one takes the readings the drag skipped. */
export function dockDrag(on: boolean): void {
  dragging = on;
  if (on) grab();
  thread.classList.toggle('resizing', on);
  // The end of the drag only: `fitRoom` refuses to read a thread mid-drag, and
  // `dragging` is what it asks — cleared at the top of this function, not by
  // the class on the line above. Before `hold`, which aims at `endTop` for a
  // reader who was at the end: a width change re-wraps every turn, so the
  // shortfall the room covers is not the one it covered at the width the drag
  // began at.
  fitRoom();
  // Both edges move the thread under the reader — turns collapsing to their
  // guessed height, then standing back up — so both put them back. At the end
  // that write lands against the real layout, which is what makes the readings
  // below it the same ones an ungated drag would have taken.
  hold();
  if (!on) {
    grip = undefined;
    // Taken here rather than left to the scroll `hold` may or may not have
    // fired: a drag that ends at the width it began at writes no new scrollTop,
    // and a reader left silently unpinned is a thread that stops following.
    pinned = fromBottom() < 40;
    remember();
    renderPromptBar();
  }
}

/** The session the thread is painted for, so an arrival can be told from the
 *  3 s repaint of a session already up. */
let painted: number | undefined;

/** An arrival whose place has not yet been taken against a settled composer.
 *  Consumed by the first resize after it — see the observer at the foot. */
let seat = false;

/** Where `place` last left the thread. What a scroll is measured against to
 *  tell the reader moving from the panel having moved them. */
let placed = -1;

/**
 * The child at the fold: the last one whose top has reached it. An index into
 * `thread.children`, which `paint` keeps aligned with `ui.threadKeys` — that
 * alignment is the whole of how a position survives a repaint.
 *
 * `governing` walks the prompts, for the bar that names one. This walks every
 * child, because the reader stopped where they stopped and that is usually
 * somewhere in the middle of a reply.
 *
 * And it falls back to the first child rather than to `governing`'s `-1`.
 * `#thread` is padded, so at the very top nothing has reached the fold: the bar
 * reads that as no prompt to name, but a reader at the top of a thread is
 * looking at its first child from `PAD` pixels above it, which is what the
 * negative delta records. Read as `-1` the place was thrown away instead of
 * written down, and jsdom's own ruler could not pose it — only the smoke.
 */
function atFold(): number {
  let i = 0;
  for (let k = 0; k < thread.childElementCount; k++) {
    const kid = thread.children[k] as HTMLElement | undefined;
    if ((kid?.offsetTop ?? 0) <= thread.scrollTop) i = k;
  }
  return i;
}

/** How many turns above the fold are written down beside it. Three, because the
 *  turn a reader stopped at is often one that cannot survive their leaving —
 *  see `anchors` in `state.ts`, which says which ones and why. */
const MARKS = 3;

/**
 * Write down where this session's reader is standing, for `place` to restore
 * when they come back.
 *
 * Against `painted` — the session whose turns are *on screen* — and never
 * against `ui.selected`, which by then can be the session being switched *to*.
 * `select` picks before it empties the thread, and emptying a thread the reader
 * had scrolled down collapses it: the browser clamps `scrollTop` to 0 and fires
 * a real scroll for the clamp, which arrives here with the new session picked
 * and no turns left to name. Read as the new session's own scrolling, that
 * threw away the place of the session about to be opened — so leaving any
 * session below its top wiped the place of the one being opened, which is the
 * whole feature, defeated on the one path everybody takes. jsdom neither
 * clamps nor fires, which is why nothing here saw it.
 */
function remember(): void {
  const pid = painted;
  // Not while the backlog is up. A hidden tab lays nothing out, so every
  // `offsetTop` reads 0, the fold appears to be past the last turn, and the
  // reader is written down at the end of a thread they are not even looking at.
  if (!pid || chatBody.hidden || displayedHistory) return;
  const top = thread.scrollTop;
  const marks: Anchor[] = [];
  for (let i = atFold(); i >= 0 && marks.length < MARKS; i--) {
    const kid = thread.children[i] as HTMLElement | undefined;
    const key = ui.threadKeys[i];
    if (kid && key !== undefined) marks.push({ key, index: i, delta: top - kid.offsetTop });
  }
  chats.saveAnchors(pid, marks);
}

/**
 * Which child carries this turn now. The nearest occurrence to where it stood,
 * because a key names a turn's *content* and two turns that say the same thing
 * share one — `paint` compares them by position and never has to care, but a
 * reader anchored on the second `Done.` must not be put back at the first.
 */
function nearest(mark: Anchor): number {
  let found = -1;
  for (let i = 0; i < ui.threadKeys.length; i++) {
    if (ui.threadKeys[i] !== mark.key) continue;
    if (found < 0 || Math.abs(i - mark.index) < Math.abs(found - mark.index)) found = i;
  }
  return found;
}

function settle(top: number): void {
  thread.scrollTop = top;
  // Read back rather than kept: the browser clamps, so this is where the thread
  // *is*, which is what tells a later scroll whether the reader has moved.
  placed = thread.scrollTop;
  // Restoring the same position preserves the prompt cursor; moving clears it.
  if (Math.abs(thread.scrollTop - aimed) > 1) cursor = -1;
  pinned = fromBottom() < 40;
  renderPromptBar();
}

/**
 * Stand the thread where this session's reader left it, and settle `pinned` on
 * what that turns out to be. The only mover on the arrival path — `repin` is
 * for a session already up.
 */
function place(): void {
  if (displayedHistory) return;
  for (const mark of painted ? chats.anchorsFor(painted) : []) {
    const i = nearest(mark);
    const kid = i < 0 ? undefined : (thread.children[i] as HTMLElement | undefined);
    if (!kid) continue;
    settle(kid.offsetTop + mark.delta);
    return;
  }
  // Nothing written down, or not one of those turns is still here. The end is
  // where a thread with nothing to restore opens — the end of the conversation,
  // not of the room under it.
  settle(endTop());
}

q(promptBar, '.up').onclick = () => {
  // Measured here as well as on a paint, because the two things that move an
  // offset without one are a fold opening and an image arriving at its own
  // height, and either leaves the room short of what the step about to be taken
  // needs. One reading per press, against the layout the reader is looking at.
  fitRoom();
  const ps = prompts();
  const i = standing(ps);
  const current = ps[i];
  if (current && !promptVisible(current)) {
    cursor = i;
    jumpTo(current);
    return;
  }
  const older = ps[i - 1];
  if (older) {
    cursor = i - 1;
    jumpTo(older);
  }
  // Nothing older read, but something to say about why: the notice at the head
  // of the thread, which the bar then becomes.
  else if (i === 0 && cut()) {
    // The notice is not a prompt, so there is none for the bar to stand on.
    cursor = -1;
    step(0);
  }
};
q(promptBar, '.dn').onclick = () => {
  fitRoom();
  const ps = prompts();
  const i = standing(ps);
  const newer = ps[i + 1];
  // Past the newest prompt there is no next one, only the end of its replies.
  if (newer) {
    cursor = i + 1;
    jumpTo(newer);
  } else {
    // The end is not a place to be parked at: `governing` reads the end of the
    // conversation as the newest prompt anyway, so the bar says the same thing
    // with no cursor — and with one, the thread would stop following the moment
    // a reader pressed down to catch up with it.
    cursor = -1;
    step(endTop());
  }
};
// Passive: this only reads the scroll position, and a listener that cannot
// cancel is one the compositor never has to wait for. `repin` scrolls through
// here too, which is how a pin confirms itself rather than having to assert it.
thread.addEventListener(
  'scroll',
  () => {
    // A drag frame, and not one of the four readings below is about the reader:
    // the two that walk the thread have nothing to find, and the two flags would
    // be set off `hold`'s own write against guessed heights — a mid-thread
    // reader whose collapsed thread now ends 40px below them reads as pinned,
    // and stays that way after the drag. `dockDrag` takes all four at the end,
    // against the real layout.
    if (dragging) return;
    pinned = fromBottom() < 40;
    // The reader has moved off where the arrival stood them, so the late
    // re-place below has nothing left to correct and must not undo them.
    if (Math.abs(thread.scrollTop - placed) > 1) seat = false;
    // The reader is moving the thread themselves, so the thread says which
    // prompt again. Our own steps come through here too — that is what `aimed`
    // is for, and it holds where the last one landed rather than where it was
    // sent, because a step into the tail lands short of its target.
    if (Math.abs(thread.scrollTop - aimed) > 1) cursor = -1;
    remember();
    renderPromptBar();
  },
  { passive: true }
);

// The composer's height is not settled when renderThread returns — field-sizing
// regrows #input a frame after its value or its placeholder changes, a dialog
// raises #qlaunch, the read-only swap lands — and every one of those pixels
// comes out of #thread, which is what is left over from it. So the pin at the
// end of the paint aimed at a bottom the composer then grew over, and the thread
// sat short of its end until the next poll repainted and pinned again: the beat
// of history arriving a second after you select a session, and the delay behind
// the box as it grows under your typing.
//
// Resizing this box is that settling, observed rather than guessed at. Guarded
// because jsdom has no ResizeObserver, the same guard `main.ts` puts around the
// column measure.
//
// An arrival aims at the same moving bottom, and misses it the same way, so it
// takes its place again here — once, against the settled box. `select` writes
// the composer's value and its placeholder, so the resize this consumes is one
// every switch causes.
//
// The border box and not the content box, which is what padding-bottom takes
// from: `fitRoom` writes the room there, so an observer on the content box
// would fire on every room change and spend the one-shot `seat` on it — the
// arrival would stop re-placing against the settled composer, which is this
// observer's whole reason. The border box holds still under a padding change,
// and moves for every height change worth consuming.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    // The view's own height has changed, so the shortfall the room covers has.
    fitRoom();
    // An arrival keeps its priority over a drag frame: the seat is one resize
    // only — the composer settling — and a drag that swallowed it would leave
    // the session standing where the grip left it rather than where its reader
    // did. `repin` reads a thread whose off-screen turns are standing at a
    // guess; `hold` reads one turn that is not.
    if (!seat) return dragging ? hold() : repin();
    seat = false;
    place();
  }).observe(thread, { box: 'border-box' });
}
