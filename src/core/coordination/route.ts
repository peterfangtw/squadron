import { type SessionHandle } from '../adapter';
import type { MessageFact } from '../message_facts';
import type { Decision, ImageBlock, SendTarget } from '../model';

export const UNROUTED = 'That session is not one this window can write to.';

export type Act = (
  { ok: true; queued?: number; idle?: true } | { ok: false; reason: string; unsure?: true }
) & {
  messageFacts?: readonly MessageFact[];
  incomingDelivery?: import('../bridge/model').IncomingDeliveryEvidence;
};

/**
 * What a verb calls after `routeTo`. Same capability groups as `SessionHandle`,
 * methods always a `Promise<Act>`.
 *
 * **The `Promise` is kept now that there is only one arm.** It was adopted to
 * match a remote call's round trip, and it stands on its own reason:
 * `wrapOwned` is where a thrown send becomes a sentence the dock paints, and
 * flattening it to `void` would move seven try/catches into seven verbs. The
 * three synchronous verbs wrap in `Promise.resolve` for shape alone.
 */
export type RoutedHandle = {
  messages?: {
    readonly images: boolean;
    send(
      text: string,
      images?: readonly ImageBlock[],
      describe?: string,
      ahead?: boolean,
      target?: SendTarget,
      correlation?: string
    ): Promise<Act>;
    dismiss(id: string): Promise<Act>;
    sendNow(): Promise<Act>;
  };
  turn?: { interrupt(): Promise<Act> };
  naming?: { rename(title: string): Promise<Act> };
  /**
   * **A permission is granted by a person's click in the panel, and never by
   * another session.** A verb, shim or request file that reaches this method
   * may answer an ask (`ask: true`) and must refuse a permission prompt. If
   * one session could approve another's permission, any agent could get past
   * the prompt by spawning a peer to approve it. The user decided this on
   * 2026-10-06 for `PRD_shipped_answer_verb.md` Q1, and it holds permanently,
   * not just for v1.
   */
  asks?: { respond(requestId: string, decision: Decision): Promise<Act> };
};

export type Route = RoutedHandle | { kind: 'refused'; sentence: string };

export function isRefused(routed: Route): routed is { kind: 'refused'; sentence: string } {
  return 'kind' in routed;
}

/**
 * Which handle can act on this pid: this window's, or a refusal.
 *
 * **Local or refused, since row 71.** There was a remote arm here that posted a
 * request file to the window holding the pipe and waited for its reply, and
 * every card it served has left the board — the panel draws the sessions this
 * window started plus background ones, and a background session is discovered
 * and never owned. So a pid with no handle here is one nothing on this board
 * names, and `UNROUTED` is the whole answer.
 *
 * `ENDED` went with that arm rather than being kept. It was a pre-check against
 * a published record's `exit`, and an owned session's exit is already refused
 * by the handle's own state.
 */
export function routeTo(input: {
  owned: SessionHandle | undefined;
  /**
   * The owning window's one rename writer, closed over this pid — the store
   * write, the paint and the CLI's own door in that order (`host/sessions.ts`,
   * `stateName`). A closure rather than the entry itself, so nothing here has
   * to import `host/`.
   *
   * Optional, so a caller with nothing to say — every test of the local
   * capabilities — routes as before and gets the handle's own `naming`.
   */
  stateName?: (title: string) => Promise<Act>;
}): Route {
  return input.owned
    ? wrapOwned(input.owned, input.stateName)
    : { kind: 'refused', sentence: UNROUTED };
}

function caught(prefix: string, err: unknown): Act {
  const reason = err instanceof Error ? err.message : String(err);
  return { ok: false, reason: `${prefix}${reason}` };
}

function wrapOwned(
  handle: SessionHandle,
  stateName?: (title: string) => Promise<Act>
): RoutedHandle {
  const routed: RoutedHandle = {};
  if (handle.messages) {
    const messages = handle.messages;
    routed.messages = {
      images: messages.images,
      async send(text, images, describe, ahead, target, correlation) {
        try {
          const pending = messages.pending();
          await messages.send(text, images, describe, ahead, target, correlation);
          return {
            ok: true,
            queued: pending ? handle.state.queued.length : 0,
            ...(handle.state.messageFacts === undefined
              ? {}
              : { messageFacts: handle.state.messageFacts })
          };
        } catch (err) {
          return caught('Could not send that message: ', err);
        }
      },
      dismiss(id) {
        if (!messages.dismiss(id)) {
          return Promise.resolve({
            ok: false as const,
            reason: 'That message had already been sent.'
          });
        }
        return Promise.resolve({ ok: true, queued: handle.state.queued.length });
      },
      async sendNow() {
        try {
          await messages.sendNow();
          return { ok: true };
        } catch (err) {
          return caught('Could not send the held messages: ', err);
        }
      }
    };
  }
  if (handle.turn) {
    const turn = handle.turn;
    routed.turn = {
      async interrupt() {
        // Read `handle.state.running` at the call. A value taken when the
        // route is built misses a later start or end. A board or a file is
        // not this window's frames ("Status is live, never disk", src/AGENTS.md).
        if (!handle.state.running) return { ok: true, idle: true };
        try {
          await turn.interrupt();
          return { ok: true };
        } catch (err) {
          return caught('That session did not answer the interrupt: ', err);
        }
      }
    };
  }
  // **Every owned session takes a rename**, whatever its CLI can do about it.
  // The name is ours to state, and `SessionHandle.naming` no longer means "this
  // card can be renamed" — it means "the CLI can be told as well", which is a
  // question for `stateName` and not for this gate. Grok has no door and Codex
  // has one whose echo has been observed not to arrive; both cards rename here.
  //
  // The handle's own `naming` is the fallback for a caller that passed no
  // writer, which is only ever a test of the local capabilities.
  if (stateName) {
    routed.naming = { rename: (title) => stateName(title) };
  } else if (handle.naming) {
    const naming = handle.naming;
    routed.naming = {
      rename(title) {
        try {
          naming.rename(title);
          return Promise.resolve({ ok: true as const });
        } catch (err) {
          return Promise.resolve(caught('That session was not renamed: ', err));
        }
      }
    };
  }
  if (handle.asks) {
    const asks = handle.asks;
    routed.asks = {
      respond(requestId, decision) {
        const took = asks.respond(requestId, decision);
        return Promise.resolve(
          took
            ? { ok: true as const }
            : {
                ok: false as const,
                reason: 'That request is no longer open, or this answer is not supported.'
              }
        );
      }
    };
  }
  return routed;
}
