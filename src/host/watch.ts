/**
 * "Some session state changed on disk" — said once, for whoever is listening.
 *
 * Three roots watched, two rates, and the sort between them; nothing here knows
 * what a subscriber does with the news. A watcher is not a painting concern,
 * and `src/AGENTS.md` asks `panel.ts` to be delivery and wiring.
 *
 * **The watchers exist exactly while someone is subscribed.** First listener
 * starts them, last one gone stops them — the panel used to own their lifetime
 * and this keeps the same bargain without naming the panel.
 */
import * as vscode from 'vscode';
import { SESSIONS_DIR, STATE_DIR } from '../core/paths';
import { livePid } from '../core/published';
import { ownedSession } from './sessions';

/**
 * How long the file watchers hold an event before announcing it.
 *
 * Two rates because the watched dirs are two different things. `SESSIONS_DIR`
 * and the state files are a session opening, a status flipping, a claim moving
 * — infrequent, and worth seeing quickly. `LIVE_DIR` is another window's owned
 * session publishing its stream, every `PUBLISH_MS`, for as long as it writes:
 * a card's live text, which the reader is watching change and cannot read at
 * that rate anyway.
 *
 * Measured before the split: one debounce over both, at 150 ms, ran `refresh`
 * at 214/min against a 3 s poll and burned ~8% of a core, most of it `discover`
 * answering foreign publishes.
 *
 * **The `live/` channel is the waits' now** (row 71). The panel subscribes to
 * this watcher for `watch` and returns early on `live`: its board is the
 * sessions this window started, and it folds no records at all, so another
 * window's publish is nothing for it to repaint. `host/waits.ts` is the reader
 * that still needs it — a wait can name any pid, and a record is how it learns
 * that member's state without owning it. The measurement above is why the two
 * rates exist and stands whoever is listening.
 *
 * **Both are rate limits, not resetting debounces**, and `LIVE_MS` is why: a
 * timer that resets on every event never fires while events arrive faster than
 * the delay, and `PUBLISH_MS` is 500 ms against this 1000. The first event
 * schedules, later ones in the window ride it, and the announcement describes
 * the state at the end of it.
 */
const WATCH_MS = 500;
const LIVE_MS = 1000;

/**
 * Which of the two a change came in on. The panel passes `watch` straight to
 * `refresh` as its `RefreshVia`, which is why it is spelled that way, and drops
 * `live` on the floor; a subscriber that is not the panel reads them as what
 * they are — state a reader is waiting on, and another window's stream.
 */
export type StateChange = 'watch' | 'live';

/** Tokens rather than the callbacks themselves: `size` decides whether the OS
 *  watchers exist, and a `Set` of functions would count two subscribers passing
 *  one reference as one — so the second to leave would stop the watchers under
 *  the first, permanently, since nothing would arrive to start them again. */
const listeners = new Set<{ fn: (change: StateChange) => void }>();
let watchers: vscode.Disposable[] = [];
let watchTimer: NodeJS.Timeout | undefined;
let liveTimer: NodeJS.Timeout | undefined;

/**
 * Hear about a file another process wrote, so an opened session or a status
 * flip shows up without waiting for the caller's own poll. Returns the
 * unsubscribe, as `onOwnedChange` does.
 */
export function onSessionState(fn: (change: StateChange) => void): () => void {
  const token = { fn };
  listeners.add(token);
  if (listeners.size === 1) {
    start();
  }
  return () => {
    // A second unsubscribe is not a second departure, and must not stop the
    // watchers a still-live subscriber is on.
    if (!listeners.delete(token)) {
      return;
    }
    if (listeners.size === 0) {
      stop();
    }
  };
}

function announce(change: StateChange): void {
  for (const { fn } of listeners) {
    fn(change);
  }
}

/**
 * Two roots: sessions/ keyed by pid, STATE_DIR for stores. A burst of writes (a
 * turn appends many) rides one announcement.
 *
 * Not `DUMP_DIR`: nothing reads it (`core/paths.ts`), and a busy writer
 * rewrites its file every 10–15s.
 *
 * Three destinations, not one, and the sort between them is the point:
 * `WATCH_MS` for state a reader is waiting on, `LIVE_MS` for another window's
 * stream, and nothing at all for this window's own publishes.
 */
function start(): void {
  const nudge = () => {
    watchTimer ??= setTimeout(() => {
      watchTimer = undefined;
      announce('watch');
    }, WATCH_MS);
  };
  const nudgeLive = () => {
    liveTimer ??= setTimeout(() => {
      liveTimer = undefined;
      announce('live');
    }, LIVE_MS);
  };
  // `**/*.json` cannot exclude a subdirectory, so `live/` is sorted here
  // instead: one watcher, two rates, and one source dropped outright.
  const sort = (uri: vscode.Uri) => {
    const pid = livePid(uri.fsPath);
    if (pid === undefined) {
      nudge();
      return;
    }
    // **Our own publish, arriving back as a file event, is never announced.**
    // `schedulePublish` and `announce` fire on the same change (`sessions.ts`,
    // in the `session.onChange` handler), so a subscriber that wants this
    // window's own sessions wants `onOwnedChange` — off the frame, before the
    // disk — which is what `panel.ts` does. Reading the disk to be told what
    // this process wrote there is the duplicate; another window's record is the
    // whole reason the watcher is here.
    if (ownedSession(pid)) {
      return;
    }
    nudgeLive();
  };
  for (const dir of [SESSIONS_DIR, STATE_DIR]) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '**/*.json')
    );
    watchers.push(
      watcher,
      watcher.onDidCreate(sort),
      watcher.onDidChange(sort),
      watcher.onDidDelete(sort)
    );
  }
}

function stop(): void {
  clearTimeout(watchTimer);
  clearTimeout(liveTimer);
  watchTimer = undefined;
  liveTimer = undefined;
  for (const watcher of watchers) {
    watcher.dispose();
  }
  watchers = [];
}
