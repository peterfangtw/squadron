/**
 * `SessionVerbs` for the Remote host (D40): a session this window drives is
 * acted on in memory, through its handle; any other goes to its own window as
 * a request file, which that window serves with the same arms
 * (`serve_owned.ts`). The engine is handed one or the other and cannot tell.
 */

import * as incoming from '../incoming';
import * as sessionEnd from '../session_end';
import { refusal, type SessionHandle } from '../adapter';
import { DEFAULT_BRAND, isBrand } from '../brands';
import type { Ended, SessionVerbs, Started, Stopped } from '../bridge/bridge';
import { randomUUID } from 'crypto';
import type { IncomingEvidenceQuery, HostIdentity } from '../bridge/model';
import type { SessionAddr, Watched } from '../bridge/model';
import * as words from '../bridge/words';
import type { SignalEnd } from '../control';
import { UNANSWERED, type AskResult } from '../coordination/ask';
import { OPEN_REPLY_MS, type Reply, type RequestBody } from '../coordination/requests';
import { isRefused, routeTo, type Act } from '../coordination/route';
import {
  GONE,
  NOT_HERE,
  serveHeld,
  type HeldRequest,
  type RemoteStart
} from '../coordination/serve_owned';
import type { QueuedMessage } from '../live';
import { isMidTurn, sameSessionStart, type WindowClaim } from '../model';
import { readRecord } from '../record';
import { lastAnswer, unanswered } from '../transcript';

export type VerbPort = {
  /** This window, which holds Remote: what every guarded request names. */
  windowId: string;
  owned(pid: number): SessionHandle | undefined;
  /** End as the panel's End does; false when nothing here holds it. */
  end(pid: number, startedAt: number): boolean;
  ending?(pid: number, startedAt: number): boolean;
  /** A person's start here (D25), with the brand it resolved to. */
  start(start: RemoteStart): Promise<Started>;
  models?(): Promise<import('../model_listing').RemoteModels>;
  ask(body: RequestBody, timeoutMs?: number): Promise<AskResult>;
  holderIdentity?: import('../bridge/model').IncomingHolder;
  holder?: import('../coordination/serve_owned').ServePort['holder'];
  incomingHolder?: import('../coordination/serve_owned').ServePort['incomingHolder'];
  startFiles?: import('../coordination/serve_owned').ServePort['startFiles'];
  evidence?: import('../coordination/serve_owned').ServePort['evidence'];
  deliverIncoming?: import('../coordination/serve_owned').ServePort['deliverIncoming'];
  /** The board the last pass built: another window's sessionId, and a name. */
  board(): readonly Watched[];
  /** The windows alive now; a member whose window is not among them has no
   *  one to answer a close. */
  claims(): Promise<readonly WindowClaim[]>;
  /** `endBySignal`, with the host's reap owner. */
  signal(targets: readonly { pid: number; startedAt: number }[]): Promise<SignalEnd[]>;
};

export function remoteVerbs(port: VerbPort): SessionVerbs {
  /** A guarded kind: the request's own arm, run here on the handle, or sent. */
  const held = (addr: SessionAddr, request: HeldRequest): Promise<Reply> =>
    reach(port, addr, {
      here: (owned) => serveHeld(request, owned, port),
      there: () => request
    });
  const remote = port.windowId;

  return {
    send(addr, text, correlation, incomingDelivery) {
      return act(port, addr, {
        here: (owned) => {
          if (incomingDelivery)
            return serveHeld(
              {
                kind: 'send',
                origin: 'remote',
                remote: port.windowId,
                ...where(addr),
                text,
                correlation,
                incomingDelivery,
                incomingHolder: port.holderIdentity
              },
              owned,
              port
            ).then(asAct);
          const messages = wrapped(owned).messages;
          return messages
            ? messages.send(text, undefined, undefined, undefined, undefined, correlation)
            : Promise.resolve(refused(refusal('messages')));
        },
        there: () => ({
          kind: 'send',
          origin: 'remote',
          remote: port.windowId,
          ...where(addr),
          ...(incomingDelivery ? { incomingDelivery, incomingHolder: port.holderIdentity } : {}),
          text,
          ...(correlation === undefined ? {} : { correlation })
        })
      });
    },
    answer(addr, askId, text, correlation, incomingDelivery) {
      return held(addr, {
        kind: 'personAnswer',
        origin: 'remote',
        ...where(addr),
        ...(incomingDelivery ? { incomingDelivery, incomingHolder: port.holderIdentity } : {}),
        askId,
        text,
        remote,
        ...(correlation === undefined ? {} : { correlation })
      }).then(asAct);
    },
    interrupt(addr) {
      return held(addr, { kind: 'interrupt', origin: 'remote', ...where(addr), remote }).then(
        asStopped
      );
    },
    deny(addr, requestId, reason) {
      return held(addr, {
        kind: 'deny',
        origin: 'remote',
        ...where(addr),
        requestId,
        ...(reason === undefined ? {} : { reason }),
        remote
      }).then(asAct);
    },
    end: (addr, members) => end(port, addr, members),
    start: (input) => start(port, input),
    async incomingEvidence(host: HostIdentity, query: IncomingEvidenceQuery) {
      const challenge = randomUUID();
      const raw =
        host.windowId === port.windowId
          ? await port.evidence?.(challenge, query)
          : await port.ask(
              {
                kind: 'incomingEvidenceV1',
                version: 1,
                windowId: host.windowId,
                expectedHost: host,
                challenge,
                query
              },
              OPEN_REPLY_MS
            );
      const evidence = incoming.readIncomingEvidence(
        raw && 'reply' in raw ? raw.reply.incomingEvidence : raw
      );
      return evidence &&
        evidence.challenge === challenge &&
        incoming.sameHost(evidence.host, host) &&
        (query.kind === 'attempt'
          ? evidence.query.kind === 'attempt' &&
            incoming.sameLaunchAttempt(evidence.query.attempt, query.attempt)
          : query.kind === 'receiver'
            ? evidence.query.kind === 'receiver' &&
              incoming.sameReceiver(evidence.receiver, query.receiver)
            : evidence.query.kind === 'delivery' &&
              incoming.sameReceiver(evidence.query.delivery.receiver, query.delivery.receiver) &&
              evidence.query.delivery.correlation === query.delivery.correlation &&
              evidence.query.delivery.admissionDigest === query.delivery.admissionDigest)
        ? evidence
        : undefined;
    },
    async models(windowId) {
      if (windowId === port.windowId) {
        const models = port.models ? await port.models() : { models: { brands: [], models: [] } };
        const { incomingAccess: raw, ...listing } = models;
        const capability = incoming.readIncomingAccess(raw);
        return {
          ...listing,
          ...(capability === undefined || capability.host.windowId !== windowId
            ? {}
            : { incomingAccess: capability })
        };
      }
      const result = await port.ask({ kind: 'models', windowId }, OPEN_REPLY_MS);
      if (!result.ok && result.kind === 'refused' && result.reason === NOT_HERE)
        return { models: { brands: [], models: [] } };
      if (!result.ok || !result.reply.models)
        throw new Error(result.ok ? 'Model discovery is unavailable.' : why(result));
      const capability = incoming.readIncomingAccess(result.reply.incomingAccess);
      return {
        models: result.reply.models,
        ...(capability === undefined || capability.host.windowId !== windowId
          ? {}
          : { incomingAccess: capability }),
        ...(result.reply.remoteSelection === undefined
          ? {}
          : { remoteSelection: result.reply.remoteSelection })
      };
    },
    /**
     * The turn that ended, never the one a drained reply has begun since: a
     * pass sees a finish by its count, and the next turn may already be
     * written by then (a coalesced finish).
     */
    async lastReply(addr) {
      const owned = mine(port, addr);
      if (owned) {
        const shot = owned.thread.snapshot();
        // The tail is the message still being written, after all history holds.
        const exchanges = [...shot.history.exchanges, ...shot.tail.map((row) => row.exchange)];
        return lastAnswer(exchanges, { inFlight: prompted(owned.state.inFlight) });
      }
      const watched = onBoard(port, addr);
      if (!watched?.session.sessionId) return undefined;
      const recorded = await readRecord(watched.session.sessionId);
      if (!recorded) return undefined;
      // The board is the last pass's and the record is read now, so either
      // can be the one that shows the next turn begun. A turn the CLI began on
      // its own, with no prompt, is not told apart from the one before it.
      const status = watched.session.status;
      const inFlight = isMidTurn(status) || unanswered(recorded.exchanges);
      return lastAnswer(recorded.exchanges, { inFlight });
    }
  };
}

/**
 * A message written to the pipe whose turn has not ended, and one the thread
 * holds as a prompt: a ping is skipped by `lastAnswer` already, and a slash
 * command is recorded as no prompt at all.
 */
function prompted(inFlight: QueuedMessage | undefined): boolean {
  return inFlight !== undefined && !inFlight.warm && !inFlight.command;
}

/** The fields every pid-carrying request has. */
function where(addr: SessionAddr) {
  return { windowId: addr.windowId, pid: addr.pid, startedAt: addr.startedAt };
}

/**
 * Here when this window holds that pid at that start, else by request — but a
 * start the board shows has moved on is refused first, so no file is written
 * for a session that is already gone.
 */
async function act(
  port: VerbPort,
  addr: SessionAddr,
  how: { here(owned: SessionHandle): Promise<Act>; there(): RequestBody }
): Promise<Act> {
  return asAct(await reach(port, addr, how));
}

/** `act`, answering the reply whole, for a verb that reads more than `ok`. */
async function reach(
  port: VerbPort,
  addr: SessionAddr,
  how: { here(owned: SessionHandle): Promise<Reply>; there(): RequestBody }
): Promise<Reply> {
  if (addr.windowId === port.windowId) {
    const owned = port.owned(addr.pid);
    if (!owned) return refused(NOT_HERE);
    if (!sameSessionStart(owned.state.startedAt, addr.startedAt)) return refused(GONE);
    return how.here(owned);
  }
  if (moved(port, addr)) return refused(GONE);
  const result = await port.ask(how.there());
  if (result.ok || result.kind === 'refused') return result.reply;
  return { ok: false, reason: why(result), ...(result.kind === 'silent' ? { unsure: true } : {}) };
}

async function start(
  port: VerbPort,
  input: Parameters<SessionVerbs['start']>[0]
): Promise<Started> {
  if (input.incomingStart) {
    const what = input.incomingStart;
    const result =
      input.windowId === port.windowId
        ? await port.startFiles?.(what)
        : await port.ask(
            { ...what, kind: 'remoteStartFilesV1', origin: 'remote', windowId: input.windowId },
            OPEN_REPLY_MS
          );
    if (!result) return { ok: false, reason: 'Incoming starts are unavailable.', notStarted: true };
    const reply: Reply = 'reply' in result ? result.reply : result;
    if (!reply.ok)
      return {
        ok: false,
        reason: reply.reason ?? 'Incoming start outcome unknown.',
        ...(reply.notStarted ? { notStarted: true } : { unsure: true }),
        ...(reply.selectionInvalid ? { selectionInvalid: true } : {})
      };
    const marker = incoming.readRemoteLaunchEvidence(reply.remoteLaunchEvidence);
    if (
      !marker ||
      marker.stage !== 'accepted' ||
      !incoming.sameLaunchAttempt(marker.attempt, what.attempt) ||
      reply.pid !== marker.receiver.pid ||
      reply.startedAt === undefined
    )
      return { ok: false, reason: 'Incoming start evidence could not be read.', unsure: true };
    return {
      ok: true,
      pid: reply.pid,
      startedAt: reply.startedAt,
      brand: marker.receiver.brand,
      remoteLaunchEvidence: marker,
      ...(incoming.incomingString(reply.sessionId) ? { sessionId: reply.sessionId } : {})
    };
  }
  const what: RemoteStart = {
    cwd: input.cwd,
    prompt: input.prompt,
    ...(input.correlation === undefined ? {} : { correlation: input.correlation }),
    ...(input.brand === undefined ? {} : { brand: input.brand }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.window === undefined ? {} : { window: input.window }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.selection === undefined ? {} : { selection: input.selection })
  };
  if (input.windowId === port.windowId) return port.start(what);
  const result = await port.ask(
    {
      kind: 'open',
      origin: 'remote',
      windowId: input.windowId,
      ...what,
      via: 'remote',
      remote: port.windowId
    },
    OPEN_REPLY_MS
  );
  if (!result.ok)
    return {
      ok: false,
      reason: why(result),
      ...(result.kind === 'silent' || (result.kind === 'refused' && result.reply.unsure === true)
        ? { unsure: true }
        : {}),
      ...(result.kind === 'refused' && result.reply?.notStarted === true
        ? { notStarted: true }
        : {}),
      ...(result.kind === 'refused' && result.reply?.selectionInvalid === true
        ? { selectionInvalid: true }
        : {})
    };
  const { pid, startedAt, brand } = result.reply;
  // A window that started something and cannot name its start is one built
  // before `Reply.startedAt`; there is no address to record for it.
  if (pid === undefined || startedAt === undefined) {
    return {
      ok: false,
      reason: 'That window started a session and did not say which.',
      unsure: true
    };
  }
  // The serving window's own resolution, so D23 restarts a dead root as the
  // brand it was. A window built before `Reply.brand` names none; then the
  // stated brand or Claude stands in until a pass reads the session's own.
  return {
    ok: true,
    pid,
    startedAt,
    brand: isBrand(brand) ? brand : (input.brand ?? DEFAULT_BRAND)
  };
}

/** Execute the selected members through the same close operation as panel and CLI. */
async function end(
  port: VerbPort,
  addr: SessionAddr,
  members: readonly SessionAddr[]
): Promise<Ended> {
  const targets = unique([addr, ...members]);
  const results = await sessionEnd.endSessions(targets, {
    local: port,
    ask: (request) => port.ask(request),
    claims: () => port.claims(),
    observe: sessionEnd.observeEnds,
    signal: (targets) => port.signal(targets)
  });
  const left = results.flatMap(({ target, outcome }) =>
    outcome.ok ? [] : [{ one: target, why: outcome.reason }]
  );
  if (!left.length) return { ok: true };
  const rootEnded = !left.some(({ one }) => one === targets[0]);
  return {
    ok: false,
    reason: words.notEnded(
      rootEnded,
      left.map(({ one, why }) => ({ name: nameOf(port, one), why }))
    ),
    left: left.map(({ one }) => one)
  };
}

function unique(addrs: readonly SessionAddr[]): SessionAddr[] {
  return addrs.filter(
    (one, i) =>
      addrs.findIndex(
        (other) => other.pid === one.pid && sameSessionStart(other.startedAt, one.startedAt)
      ) === i
  );
}

function mine(port: VerbPort, addr: SessionAddr): SessionHandle | undefined {
  if (addr.windowId !== port.windowId) return undefined;
  const owned = port.owned(addr.pid);
  return owned && sameSessionStart(owned.state.startedAt, addr.startedAt) ? owned : undefined;
}

function onBoard(port: VerbPort, addr: SessionAddr): Watched | undefined {
  return port
    .board()
    .find(
      (one) =>
        one.session.pid === addr.pid &&
        one.session.windowId === addr.windowId &&
        sameSessionStart(one.session.startedAt, addr.startedAt)
    );
}

/** The board holds this pid in that window at another start. */
function moved(port: VerbPort, addr: SessionAddr): boolean {
  return port
    .board()
    .some(
      (one) =>
        one.session.pid === addr.pid &&
        one.session.windowId === addr.windowId &&
        !sameSessionStart(one.session.startedAt, addr.startedAt)
    );
}

function nameOf(port: VerbPort, addr: SessionAddr): string {
  return onBoard(port, addr)?.label ?? `pid ${addr.pid}`;
}

/** The handle with every throw turned into a sentence. */
function wrapped(owned: SessionHandle) {
  const route = routeTo({ owned });
  return isRefused(route) ? {} : route;
}

function asAct(reply: Reply): Act {
  const evidence = {
    ...(reply.messageFacts === undefined ? {} : { messageFacts: reply.messageFacts }),
    ...(reply.incomingDelivery === undefined ? {} : { incomingDelivery: reply.incomingDelivery })
  };
  if (!reply.ok)
    return {
      ok: false,
      reason: reply.reason ?? 'Refused.',
      ...(reply.unsure === true ? { unsure: true } : {}),
      ...evidence
    };
  return { ok: true, ...(reply.queued === undefined ? {} : { queued: reply.queued }), ...evidence };
}

/** Stop's reply: interrupted, or no turn there to interrupt. */
function asStopped(reply: Reply): Stopped {
  if (!reply.ok) return refused(reply.reason ?? 'Refused.');
  return reply.idle ? { ok: true, idle: true } : { ok: true };
}

/** Silence is "outcome unknown", never a refusal; a refusal is the window's
 *  own words, passed through. */
function why(result: Exclude<AskResult, { ok: true }>): string {
  return result.kind === 'silent' ? UNANSWERED : result.reason;
}

function refused(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
