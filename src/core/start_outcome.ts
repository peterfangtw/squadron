/**
 * What a session start came to, in one word, and the sentence a reader is told.
 *
 * The one fold of a start's settlement. A failed start states its word
 * (`stopped` or `unknown`); the host decides here and the panel paints what it
 * is sent, and an `open` request-file reply carries the same word. A leaf with
 * no imports, so the webview's protocol can name `StartWord`.
 */

export type StartWord = 'started' | 'stopped' | 'unknown';

/** What a failed start may say: stopped is proved, unknown may have started. */
export type FailedWord = Exclude<StartWord, 'started'>;

export type StartNotice<W extends StartWord = StartWord> = { outcome: W; notice: string };

type Failure = { ok: false; reason?: string; outcome: FailedWord };
type Settlement = { ok: true } | Failure;

const STARTED = 'Session started.';
const STOPPED = 'That session did not start.';
const UNKNOWN = 'The start could not be confirmed. Check its status before trying again.';
const WAITING = 'Starting session…';

/** A settled start; absent is a start this window holds no outcome for. */
export function startOutcome(result: { ok: true }): StartNotice<'started'>;
export function startOutcome(result: Failure): StartNotice<FailedWord>;
export function startOutcome(result: Settlement | undefined): StartNotice;
export function startOutcome(result: Settlement | undefined): StartNotice {
  if (result?.ok) return { outcome: 'started', notice: STARTED };
  if (!result || result.outcome === 'unknown')
    return { outcome: 'unknown', notice: result?.reason ?? UNKNOWN };
  return { outcome: 'stopped', notice: result.reason ?? STOPPED };
}

/** A start asked about mid-flight: `waiting` until it settles, never final. */
export function startupState(
  pending: boolean,
  result: Settlement | undefined
): { state: StartWord | 'waiting'; notice: string } {
  if (pending) return { state: 'waiting', notice: WAITING };
  const { outcome, notice } = startOutcome(result);
  return { state: outcome, notice };
}

/**
 * A window's reply to an `open` request file, with its word. A refusal that
 * states none was made before any attempt (a guard, a bad pick) and started
 * nothing.
 */
export function startReply<R extends { ok: boolean; outcome?: StartWord }>(
  reply: R
): R & { outcome: StartWord } {
  return { ...reply, outcome: reply.ok ? 'started' : (reply.outcome ?? 'stopped') };
}

/** A start reply read back. One with no word (its handler threw) is unknown. */
export function outcomeOfReply(reply: { ok?: boolean; outcome?: StartWord }): StartWord {
  if (reply.ok) return 'started';
  return reply.outcome ?? 'unknown';
}

export function isStartWord(value: unknown): value is StartWord {
  return value === 'started' || value === 'stopped' || value === 'unknown';
}
