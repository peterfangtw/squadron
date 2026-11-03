/**
 * Prompt-cache clock for board cards. Extracted from board.ts (H56).
 */

import { ago, el, swapStamp } from './dom';
import { cards, ui } from './state';
import { tipRows } from './tip';
import { record } from './perf';
import { prunePending } from './board_nav';
import { repaintBoard } from './board_repaint';
import * as bottomDrawer from './bottom_drawer';
import * as warmRows from '../ui/warm_rows';
import * as warmChoice from './warm_choice';

export const CACHE_NOTE =
  'The prompt cache may have expired on the server, so this turn may ' +
  'resend the whole context at full price. Press Enter again to send.';

/** The instant the card treats the prompt cache as gone. The stamped deadline
 *  wins; otherwise the lifetime runs from the last real activity. */
function cacheDeadline(
  s: Pick<CardView, 'cacheUntil' | 'cacheTtlMs' | 'updatedAt'>
): number | undefined {
  return s.cacheUntil ?? (s.cacheTtlMs === undefined ? undefined : s.updatedAt + s.cacheTtlMs);
}

export const cacheGone = (s: CardView, now = Date.now()): boolean => {
  const until = cacheDeadline(s);
  return s.status !== 'busy' && until !== undefined && now >= until;
};

/** Heat and the duration follow the last model traffic, warm pings included,
 *  so the card agrees with the pings the dock shows; the tooltip's idle-for
 *  follows real activity. */
export function since(s: CardView): HTMLElement {
  const now = Date.now();
  const idle = now - s.updatedAt;
  const sinceTraffic = now - Math.max(s.updatedAt, s.cacheFrom ?? s.updatedAt);
  const busy = s.status === 'busy';
  const { cacheFrom, cacheUntil } = s;
  const stamped = cacheFrom !== undefined && cacheUntil !== undefined;
  const lifetime = stamped ? cacheUntil - cacheFrom : s.cacheTtlMs;
  const elapsed = stamped && cacheUntil > cacheFrom ? now - cacheFrom : idle;
  const heat =
    busy || lifetime === undefined || elapsed < lifetime / 2
      ? ''
      : elapsed < (lifetime * 5) / 6
        ? ' warm'
        : ' cold';
  // "12m ago", not "12m": the bare duration read as the age it replaced, and
  // the two words cost less than the misreading. The glyph carries the same
  // news as the colour, which not every reader and not every theme gets.
  const warmLeft = warmRows.warmStamp(
    s.warm && { ...s.warm, on: warmChoice.shown(s) },
    s.status,
    now,
    cacheDeadline(s)
  );
  const node = warmLeft
    ? el('span', 'since', warmLeft)
    : el('span', 'since' + heat, ago(sinceTraffic) + ' ago' + (cacheGone(s, now) ? ' ❄︎' : ''));
  // Two readings joined by a ` · ` were a table pretending to be a sentence, so
  // this is the keyed rendering rather than the phrase one.
  //
  // Not headed `age`, which is the word the doc above disclaims: what the chip
  // states is whether continuing is cheap, and the head names the subject so the
  // keys can be the readings. The keys carry the tense for the same reason —
  // "started" is a point behind us and "idle for" is a length, and a column that
  // said `ago` on one row and not the other would read as a formatting slip.
  tipRows(node, 'this session', [
    ['started', ago(now - s.startedAt) + ' ago', ''],
    [busy ? 'in turn' : 'idle for', ago(idle), '']
  ]);
  return node;
}

/**
 * Every card's stamp, a second older. The whole of what the 1 s beat is for.
 *
 * **This exists because the beat used to call `repaintBoard()`.** Nothing on a
 * card moves on a clock except this one span — measured, the beat was 60 of the
 * 64 board paints a minute on an idle panel, rebuilding and morphing the entire
 * card tree to advance "4m ago" and its tint
 * (`docs/tasks/TASK_done_panel_repaint_cost.md`). The dock has always done
 * it this way for its own head; `tickHead` in `chat.ts` is the same three lines.
 *
 * **A narrow path beside `renderBoard`, not a narrowing of it.** The reconciler
 * stays the door every real change goes through — that is what stops a field
 * added to `card()` from rendering once on mount and never again. What is safe
 * to lift out is exactly this: one span, one clock, no state of its own, and
 * `since()` is the same function either way so the two cannot say different
 * things.
 *
 * Scoped to `#cards` on purpose. `document.ts` mounts a second `.since` in the
 * dock's head, and that one is `tickHead`'s.
 *
 * The view is looked up by the `data-pid` the card already carries rather than
 * threaded in, so a stamp whose card left the board between two beats simply
 * finds nothing and is left alone — the next push removes the node.
 */
export function tickStamps(): void {
  record('stamps');
  // The warm list's countdowns, and the count's tip, are this clock too, and
  // so is Keep-awake's lease.
  bottomDrawer.tickModes();
  // The one thing on this beat that is not a stamp, and it has to be here.
  // `PENDING_MS` is 25s and a spinner is cleared by a repaint — but a start that
  // never lands changes no state, so with the post dedupe in there may be no
  // push between the timeout and the reader giving up. The board's own floor is
  // now 15s (`UNCHANGED_MS`), which would have made a 25s promise a 40s one.
  // Costs a walk of a map that is empty except while something is starting.
  if (prunePending()) {
    repaintBoard();
    return;
  }
  const views = new Map<number, CardView>();
  for (const group of ui.state.groups) {
    for (const view of group.sessions) {
      views.set(view.pid, view);
    }
  }
  for (const stamp of cards.querySelectorAll<HTMLElement>('.since')) {
    const view = views.get(Number(stamp.closest<HTMLElement>('.card[data-pid]')?.dataset.pid));
    if (view) {
      // `swapStamp`, not `replaceWith`: past a minute this beat has the same
      // words to write 59 times out of 60, and writing them costs a node and
      // the tip anchored on the one it took away. See `dom.ts`.
      swapStamp(stamp, since(view));
    }
  }
}
