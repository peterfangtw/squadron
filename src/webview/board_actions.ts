/**
 * Delegated board handlers. Extracted from board.ts (H56).
 */

import { cards, chats, nav, setWantAsk, vscode } from './state';
import { closeMenu } from './kit';
import { select, showDraft } from './dock';
import { openPicker, retryResume, dismissResume } from './resume';
import { openRunPicker } from './runpicker';
import { blocked, findCard } from './board_card';
import { switchBoardView } from './board_nav';
import { stopListener, stopRecord } from './board_servers';
import { repaintBoard } from './board_repaint';
import { renderQuestion } from './question';
import * as warmChoice from './warm_choice';
import * as bottomDrawer from './bottom_drawer';

// ---- the board's delegated handlers -----------------------------------------

/**
 * Everything inside `#cards` says what it is and nothing closes over what to
 * do: one listener set on the container, which is the one element here a paint
 * never replaces. Two things follow from that, and both are the point.
 *
 * A click survives a paint. It fires on the nearest common ancestor of its
 * mousedown and mouseup targets, so a card rebuilt between the two used to
 * dispatch on `#cards` with nothing listening — one press in seven, lost. Now
 * `#cards` is exactly where the listener is.
 *
 * And a handler reads live state. A node outlives the `CardView` it was drawn
 * from, so a closure over that view would act on a session the card no longer
 * shows. Everything below starts from a pid or a cwd in the DOM and looks the
 * rest up.
 */

/** The pid this element is about: its own, else the card it is drawn on. */
export function pidOf(node: HTMLElement): number | undefined {
  const raw = node.dataset.pid ?? node.closest<HTMLElement>('.card')?.dataset.pid;
  const pid = Number(raw);
  // A missing or unreadable attribute means "not one of ours" — return, rather
  // than post a NaN pid at the host.
  return raw !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * The element a pointer event landed on, when it landed on one of ours.
 *
 * `Element`, not `HTMLElement`: an icon button's whole visible area is the
 * inline `<svg>` inside it, so a real press reports an `SVGPathElement` as its
 * target and an `HTMLElement` test drops it. `closest` is on `Element`, which
 * is all any caller here needs, and it walks out of the SVG into the button.
 */
export const hitOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target : null;

/** The card a pointer event is inside, if it is inside one at all. */
export const cardOf = (target: EventTarget | null): HTMLElement | null =>
  hitOf(target)?.closest<HTMLElement>('.card[data-pid]') ?? null;

/**
 * Select a session and ask for the block it is sitting on — the waiting strip's
 * chip and a press on the blocked card itself, which are the same request made
 * on two surfaces.
 *
 * Record, do not open: the ask is on the thread, which this only asks for. The
 * card here carries none, so opening now would show the outgoing session's
 * block. `renderQuestion` opens the layer on the push that brings the real one.
 *
 * **Unless the thread on screen is already this session's**, which is the press
 * a reader makes most: they are watching a session, it asks, they press its
 * card. `select` posts nothing for a re-select, so there is no push coming to
 * honour the intent with — and the one that eventually arrives is the host's
 * own, which a blocked board holds for `UNCHANGED_MS` because nothing about it
 * has changed. The requests are already here; this draws them now.
 */
export function reveal(pid: number): void {
  setWantAsk(pid);
  select(pid);
  const thread = chats.thread();
  if (thread?.pid === pid) renderQuestion(thread);
}

/** What one `data-act` element means. One line each: the act names the message. */
export function act(node: HTMLElement): void {
  const pid = pidOf(node);
  switch (node.dataset.act) {
    case 'retry-resume':
      retryResume(node.dataset.resumeId);
      return;
    case 'dismiss-resume':
      dismissResume(node.dataset.resumeId);
      return;
    case 'warm': {
      const card = pid && findCard(pid)?.card;
      if (!card) return;
      warmChoice.set(card, !warmChoice.shown(card));
      bottomDrawer.repaintMode('warm');
      repaintBoard();
      return;
    }
    case 'interrupt':
      if (pid) {
        const startedAt = chats.session(pid)?.identity.startedAt;
        if (startedAt !== undefined) vscode.postMessage({ type: 'interrupt', pid, startedAt });
      }
      return;
    case 'close':
      if (pid) {
        const startedAt = chats.session(pid)?.identity.startedAt;
        if (startedAt !== undefined) vscode.postMessage({ type: 'close', pid, startedAt });
      }
      return;
    case 'copyRef':
      if (pid) vscode.postMessage({ type: 'copyRef', pid });
      return;
    case 'select':
      if (pid) select(pid);
      return;
    case 'ask':
      if (pid) reveal(pid);
      return;
    case 'openServers': {
      const { group, tree } = node.dataset;
      if (group !== undefined) openRunPicker(group, tree);
      return;
    }
    case 'stopServer': {
      const { cwd, runner, stopKey, status } = node.dataset;
      if (cwd === undefined || runner === undefined || stopKey === undefined) return;
      stopRecord(stopKey, status ?? '', cwd, runner);
      return;
    }
    case 'killListener': {
      const { port, command, startedAt, stopKey, status } = node.dataset;
      // `listener` and not `pid`: the handler already holds the clicked card's
      // pid, and the two name different processes.
      const listener = node.dataset.pid;
      if (
        port === undefined ||
        listener === undefined ||
        startedAt === undefined ||
        stopKey === undefined
      )
        return;
      stopListener(
        stopKey,
        status ?? '',
        Number(port),
        Number(listener),
        Number(startedAt),
        command ?? ''
      );
      return;
    }
    case 'openServer': {
      const url = node.dataset.url;
      if (url) vscode.postMessage({ type: 'openServer', url });
      return;
    }
    case 'open':
      // Read before anything repaints: the draft below can move this very node,
      // and an attribute fetched after it would be another card's.
      showDraft(node.dataset.cwd);
      return;
    // The other half of the same slot. No `pending` guard: nothing is started
    // until a conversation is picked, and the picker is one sheet however many
    // times it is opened.
    case 'resume': {
      const cwd = node.dataset.cwd;
      if (cwd === undefined) return;
      openPicker(cwd);
      return;
    }
  }
}

cards.addEventListener('click', (e) => {
  // A lost dragend must not turn the release into a card selection.
  if (document.body.classList.contains('dragging-card')) return;
  const target = hitOf(e.target);
  // Acts first, cards second: a button inside a card resolves to the button, so
  // pressing End cannot also select the session — which is what the old
  // per-button `stopPropagation` bought.
  const acted = target?.closest<HTMLElement>('[data-act]');
  if (acted) {
    act(acted);
    return;
  }
  // Selecting the card would close the menu this click just opened.
  if (target?.closest('.fwrap')) return;
  const on = cardOf(target);
  const pid = on && pidOf(on);
  if (!pid) return;
  // The card already says a decision is owed, so pressing it asks for the
  // decision as well as for the session — the strip's chip, on the card the
  // chip names.
  const found = findCard(pid);
  if (found && blocked(found.card)) reveal(pid);
  else select(pid);
});

/**
 * The board scrolling shuts a menu opened from a card.
 *
 * A card's menu is `position: fixed` — the only way out of the `overflow:
 * hidden` on `.card` and `.specs` — so it is placed once from its trigger's
 * rect and does not travel with it. Scrolling would leave it parked over
 * whatever slid underneath, offering that card's model list for a different
 * card entirely.
 *
 * Closed rather than re-placed, which is the same answer the hover tip gives to
 * the same question: a surface positioned once from an anchor is stale as soon
 * as the anchor moves, and re-anchoring a menu through a scroll buys a moving
 * target to click at. Passive, because nothing here cancels the scroll.
 */
cards.addEventListener('scroll', () => closeMenu(), { passive: true });

/**
 * The nav bar's own clicks, delegated to `nav` — the element `renderNav` morphs
 * the children of and never replaces. Delegation and the morph are one fix in
 * two halves here, as they are on the board: the listener survives the paint
 * because it is on the container, and the press survives it because every
 * control the paint touches is keyed.
 *
 * The gear is the exception that needs neither: its menu is built on open and
 * `heldOpen(nav)` holds the whole bar still while it is open, so it keeps the
 * closure `opensMenu` gives it — and the morph, which never runs against an
 * open menu, keeps the node that closure is on.
 */
nav.addEventListener('click', (e) => {
  const view = hitOf(e.target)?.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (view === 'sessions' || view === 'tickets') switchBoardView(view);
});
