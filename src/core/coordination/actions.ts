/**
 * What one session did to another.
 *
 * A spawn and a send are the same kind of fact — a note that one session acted
 * on another, kept as long as something has to count it — so they share a type
 * discriminated on `kind`. They do not share a directory: `lineage/` is keyed by
 * the child's pid because that filename is the only column a reader gets
 * without opening a file, and `readLineage` runs twice on the panel's 3s poll
 * (3-6ms over 235 files, measured 2026-08-19). Send rows are UUID-named and
 * counted by the whole directory, and do not belong in front of that read.
 * `PRD_shipped_cross_session_verbs.md` §5.10 has the argument.
 *
 * Neither store carries a body. The text of a message lives in the target CLI's
 * own transcript, which we read and never prune, so an expired record here
 * cannot lose a message.
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import { readJsonDir, writeAtomicJson } from '../files';
import { ACTIONS_DIR } from '../paths';
import { SEND_BURST_MS } from './guards';

/**
 * One spawn, in `lineage/` — see `lineage.ts` for what each field survives and
 * why the store is keyed the way it is.
 *
 * `kind` is optional because every entry written before this type existed has
 * none, and those are all spawns. New writes state it.
 */
export type SpawnAction = {
  schema: 1;
  kind?: 'spawn';
  parentSessionId?: string;
  /** The fan-out this spawn belongs to: the parent's own origin, or the parent
   *  itself when the parent is the one opening it. Optional, for the same
   *  reason `parentSessionId` is and for entries older builds wrote. */
  originSessionId?: string;
  spawnedAt: number;
  cwd: string;
  requestId: string;
  /** The ticket this work came from, when the spawn was a hand-off. */
  ticketRef?: string;
};

/**
 * One accepted cross-session message, in `actions/`. What `checkSend` counts:
 * `windowId` scopes the burst counter to the receiving IDE window.
 *
 * `requestId` is what a send that never hears back names, so the file it wrote
 * is findable from the sender's error.
 */
export type SendAction = {
  schema: 1;
  kind: 'send';
  /** Receiving IDE window. Absent on records from older builds. */
  windowId?: string;
  from: string;
  toPid: number;
  toSessionId?: string;
  at: number;
  requestId: string;
};

/**
 * One wait resolving, in `actions/` beside the sends it is counted with.
 *
 * **`from` is a window, not a session**, and that is the whole reason this is a
 * kind of its own rather than a `send`. No session composed a resolution — a
 * callback in the extension host did — so the accounting identity is the
 * window's `env.sessionId`, the same string it already names itself by in
 * `claimRequests`, `keepawake` and `publish`. A reader of this directory can
 * then tell a peer's message from a convergence rather than seeing a session id
 * that names no session.
 *
 * It shares the receiving window's burst allowance with sends and answers.
 */
export type WaitAction = {
  schema: 1;
  kind: 'wait';
  windowId?: string;
  from: string;
  toPid: number;
  toSessionId?: string;
  at: number;
};

/**
 * One session answering another's open question, in `actions/` beside the
 * sends. Its own kind rather than a `send`, because this directory records what
 * one session did to another — and counted with them, because an answer is put
 * on the target's pipe like a message. `askId` is the request it answered.
 */
export type AnswerAction = {
  schema: 1;
  kind: 'answer';
  windowId?: string;
  from: string;
  toPid: number;
  toSessionId?: string;
  askId: string;
  at: number;
  requestId: string;
};

export type ActionRecord = SpawnAction | SendAction | WaitAction | AnswerAction;

/**
 * What the guards count: a send, an answer, or a wait resolution, filed for
 * the receiving window. A send parked for a wait counts before it reaches the
 * pipe. A wait's `from` is that window, not a session. The burst counter
 * reads `windowId` and `at`.
 */
export type CountedAction = SendAction | WaitAction | AnswerAction;

// Keep accepted sends countable when an action file cannot be written or read.
const recentActions = new Map<string, CountedAction>();

/**
 * Files one action. Best effort, and the caller is told: a machine that cannot
 * write this still accepts the send, the answer, or the resolution, and a
 * refusal is never the record's doing.
 *
 * `${randomUUID()}.json` because two sends in one millisecond must not collide
 * — the counters read the whole directory, so a shared name would count two as
 * one, which is the guard failing open.
 *
 * Admission and recording are serialized inside each window.
 *
 * Sends, answers and wait resolutions are filed here. A `stop` variant would
 * widen this parameter, not the store.
 */
export async function writeAction(action: CountedAction): Promise<boolean> {
  const name = `${randomUUID()}.json`;
  recentActions.set(name, action);
  return writeAtomicJson(path.join(ACTIONS_DIR, name), action);
}

/**
 * Every counted action filed on this machine. Unreadable, half-written and foreign files
 * are skipped rather than thrown over — one bad file must not cost a caller
 * every other row, and refusing a send over it would be the wrong direction.
 *
 * `kind` is checked rather than assumed: a later variant sharing this directory
 * must not read as one of these. `at` likewise — a row with no usable time
 * cannot sit inside or outside any window, so nothing can count it.
 *
 * Every counted kind comes back together: sends, answers and wait resolutions.
 * The guards bound those, not every arrival and not what wrote them. A
 * resolution left out here would be a guard failing open on the one path that
 * can wake a session nobody addressed.
 */
export async function readActions(): Promise<CountedAction[]> {
  const filed = await readJsonDir(ACTIONS_DIR, (raw, name) => {
    const row = raw as CountedAction | undefined;
    return row &&
      (row.kind === 'send' || row.kind === 'wait' || row.kind === 'answer') &&
      typeof row.at === 'number'
      ? { name, row }
      : undefined;
  });
  const rows = new Map(filed.map(({ name, row }) => [name, row]));
  const now = Date.now();
  for (const [name, row] of recentActions) {
    if (now - row.at >= SEND_BURST_MS) recentActions.delete(name);
    else rows.set(name, row);
  }
  return [...rows.values()];
}

// Checking outside this chain lets concurrent requests all spend the same slot.
let pendingSends: Promise<void> = Promise.resolve();
export function serializeSends<T>(step: () => Promise<T>): Promise<T> {
  const result = pendingSends.then(step, step);
  pendingSends = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
