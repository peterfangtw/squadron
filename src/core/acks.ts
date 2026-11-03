import * as fs from 'fs/promises';
import * as path from 'path';
import { writtenAt } from './files';
import type { Session } from './model';
import { ACKS_DIR } from './paths';

/**
 * When the reader last opened a session.
 *
 * `done` is a message to a person, and until this it had no way of knowing it
 * was delivered: derived fresh from the step list every poll, a session that
 * finished on Tuesday still said `done` on Friday. Opening the card is the
 * delivery, and `readCompletion` retires the word once this says it happened.
 *
 * **The file's mtime is the whole record.** The mark is one timestamp and the
 * filesystem already keeps one per file, so the file is empty and nothing here
 * parses anything: a mark that cannot be malformed is a mark that cannot be
 * read wrongly, and the comparison it exists for is against another mtime
 * (`Checklist.newestAt`) rather than against anything we wrote down.
 *
 * One file per session rather than a shared map, for `arrange.ts`'s reason:
 * temp-then-rename makes a write atomic, not a read-modify-write safe, and two
 * windows opening two cards in the same tick would cost one of them its mark.
 * The session id is a UUID, so it is its own file name.
 *
 * Machine-global, like the list it dates: a card says the same thing on every
 * board, so a `done` retired on one window's board is retired on all of them.
 *
 * Best effort throughout. A machine that cannot write this keeps the `done` it
 * shows today, which is the behaviour this replaces rather than a broken one.
 */

/**
 * Where a session's mark is. Exported because the mark **is** the file's mtime:
 * there is no reading side to write here, only a `writtenAt` on this path, and a
 * `readAck` wrapping one would be a function whose whole body is its own name.
 */
export function ackFile(sessionId: string): string {
  return path.join(ACKS_DIR, sessionId);
}

/**
 * Records that the reader has opened this session — now, or at `at` when the
 * act came before its session had an id. A dated write never moves a later
 * mark back.
 */
export async function writeAck(sessionId: string, at?: number): Promise<void> {
  try {
    const file = ackFile(sessionId);
    if (at !== undefined && ((await writtenAt(file)) ?? -Infinity) >= at) return;
    await fs.mkdir(ACKS_DIR, { recursive: true });
    // Truncating an existing file updates its mtime, which is the record.
    await fs.writeFile(file, '');
    if (at !== undefined) await fs.utimes(file, at / 1000, at / 1000);
  } catch {
    // A board that cannot remember what was read still draws every card.
  }
}

/** How long a held mark waits for its session's id (duration). */
export const HOLD_MS = 60_000;

/**
 * Opens that named a pid before the host could key a mark for it, kept until
 * the session's id arrives.
 *
 * A draft's first send posts `select` for its new pid, then `send`. The host
 * resolves the select against its last poll, which a session started a moment
 * ago is not on yet, and a Codex or Grok session has no id until its handshake.
 * Dropped, the reader's look at their own new session went unrecorded, so its
 * first turn read `idle` or `done` by whichever won — observed 2026-10-07 as
 * `panel.smoke.ts` reading each, one run apiece. The mark is dated to the act
 * rather than to the poll that resolves it, so a turn ending in between is
 * still unseen.
 */
export class HeldAcks {
  private readonly held = new Map<number, number>();

  hold(pid: number, at: number): void {
    this.held.set(pid, at);
  }

  async settle(sessions: readonly Session[], now: number): Promise<void> {
    await Promise.all(
      [...this.held].map(async ([pid, at]) => {
        const sessionId = sessions.find((session) => session.pid === pid)?.sessionId;
        if (!sessionId) {
          if (now - at > HOLD_MS) this.held.delete(pid);
          return;
        }
        // Before the await, so a refresh overlapping this one cannot write it twice.
        this.held.delete(pid);
        await writeAck(sessionId, at);
      })
    );
  }
}

/**
 * Dates each session against its mark, so a card can say whether what it
 * finished has been seen (`ui/views.ts`).
 *
 * Idle and waiting sessions carry delivery or attention readings; other
 * statuses have no reading that consumes the mark.
 *
 * Mutates, because the records the panel builds are rebuilt every poll and
 * nothing that outlives the pass is touched — the same contract `finishedRuns`
 * writes under.
 */
export async function markSeen(sessions: readonly Session[]): Promise<void> {
  await Promise.all(
    sessions
      // No id, no mark to key by: an owned session before the CLI names it,
      // which has replied to nobody and so has nothing unseen either way.
      .filter(
        (session) =>
          session.sessionId && (session.status === 'idle' || session.status === 'waiting')
      )
      .map(async (session) => {
        Object.assign(session, { lastSeenAt: await writtenAt(ackFile(session.sessionId)) });
      })
  );
}
