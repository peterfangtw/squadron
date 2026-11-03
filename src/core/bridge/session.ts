import type { Act } from '../coordination/route';
import * as brands from '../brands';
import { sameSessionStart, type BrandId } from '../model';
import type { SessionAddr, Watched } from './model';
import type { ConversationRoot } from './store';

/** A session started from the messenger, or why not. `brand` is what the
 *  conversation's root is recorded as; `sessionId` when already known, else
 *  the next observation fills it. */
export type Started =
  | {
      ok: true;
      pid: number;
      startedAt: number;
      brand: BrandId;
      sessionId?: string;
      remoteLaunchEvidence?: import('./model').RemoteLaunchEvidence;
    }
  | { ok: false; reason: string; notStarted?: true; selectionInvalid?: true; unsure?: true };

/** Stop's outcome: the turn was interrupted, or (`idle`) the window holding
 *  the pipe found none running — the one place "nothing to stop" is known. */
export type Stopped = { ok: true; idle?: true } | { ok: false; reason: string };

/** End's outcome. Refused, it names the members still running, where known:
 *  the rest did end. */
export type Ended = { ok: true } | { ok: false; reason: string; left?: readonly SessionAddr[] };

/**
 * What happens to a session, filled by the host: this window's handle, or a
 * request file to the session's window (D40). The engine does not know which.
 */
export interface SessionVerbs {
  send(
    addr: SessionAddr,
    text: string,
    correlation?: string,
    incomingDelivery?: import('./model').IncomingDelivery
  ): Promise<Act>;
  answer(
    addr: SessionAddr,
    askId: string,
    text: string,
    correlation?: string,
    incomingDelivery?: import('./model').IncomingDelivery
  ): Promise<Act>;
  interrupt(addr: SessionAddr): Promise<Stopped>;
  deny(addr: SessionAddr, requestId: string, reason?: string): Promise<Act>;
  /** Ends exactly `members` with `addr`: the descent End's confirm counted. */
  end(addr: SessionAddr, members: readonly SessionAddr[]): Promise<Ended>;
  start(input: {
    incomingStart?: import('../coordination/serve_owned').RemoteFilesStart;
    windowId: string;
    cwd: string;
    prompt: string;
    brand?: BrandId;
    model?: string;
    window?: number;
    effort?: string;
    selection?: import('../model_listing').SelectionSource;
    correlation?: string;
  }): Promise<Started>;
  incomingEvidence?(
    host: import('./model').HostIdentity,
    query: import('./model').IncomingEvidenceQuery
  ): Promise<import('./model').IncomingEvidence | undefined>;
  models?(windowId: string): Promise<import('../model_listing').RemoteModels>;
  /** The text a finished or failed turn ended on. */
  lastReply(addr: SessionAddr): Promise<string | undefined>;
}

export function sameAddr(a: SessionAddr, b: SessionAddr): boolean {
  return a.pid === b.pid && sameSessionStart(a.startedAt, b.startedAt);
}

export function rootOfWatched(
  w: Watched,
  fallback: BrandId = brands.sessionBrand<BrandId>(undefined)
): ConversationRoot {
  return {
    pid: w.session.pid,
    startedAt: w.session.startedAt,
    sessionId: w.session.sessionId,
    brand: w.session.brand ?? fallback,
    cwd: w.session.cwd,
    label: w.label
  };
}
