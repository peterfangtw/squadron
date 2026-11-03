/**
 * What a cross-session message decides before it is delivered.
 *
 * `core/coordination/spawn.ts` is the module this copies: every answer is a refusal with a
 * sentence in it, because the caller is an agent that will otherwise wait for a
 * session that never wakes, and a burst refusal is something it can
 * act on. Pure and `vscode`-free for the same reason — a judgement that cannot
 * be tested is a judgement nobody checked.
 */

import * as cacheTtl from '../cache_ttl';
import type { QueuedContent } from '../live';
import type { Session } from '../model';
import type { Authored } from '../transcript';
import { ORCHESTRATION_OFF } from '../verbs';
import type { CountedAction } from './actions';
import {
  CONTEXT_MAX,
  MAX_TEXT,
  SEND_BURST,
  SEND_BURST_MS,
  TARGET_STALE_MS,
  staleBound,
  staleMargin
} from './guards';

/** The answer every check here gives. */
export type SendChecked = { ok: true } | { ok: false; reason: string };

/**
 * What the cost guards read about the session a message would wake. Every
 * field but `pid` and `updatedAt` is optional, because a real board is full of
 * sessions that have not stated them.
 */
export type Recipient = {
  pid: number;
  /** Real activity, used when no cache deadline was published. */
  updatedAt: number;
  cacheUntil?: number;
  cacheTtlMs?: number;
  contextPct?: number;
  contextTokens?: number;
  contextSize?: number;
};

/**
 * The one mapping from a session to what the guards read, so the shim's board
 * row and the window's own handle are judged on the same fields. `toSession`
 * already carries context as a percentage or as tokens, never both, so a
 * refusal cannot quote a stale reading beside a fresh one.
 */
export function recipient(session: Session): Recipient {
  return {
    pid: session.pid,
    updatedAt: session.updatedAt,
    cacheUntil: cacheTtl.cacheUntil(session),
    cacheTtlMs: session.cache?.ttlMs,
    contextPct: session.contextPct,
    contextTokens: session.contextTokens,
    contextSize: session.contextSize
  };
}

export type SendCheck = {
  windowId: string;
  target: Recipient;
  text: string;
  now: number;
  actions: readonly CountedAction[];
  /** Lifts the stale and context guards, and nothing else (`guards.ts`). */
  force?: boolean;
};

/**
 * The attribution wrapper: one spelling, in the module that also refuses a body
 * carrying a forged one. Three callers — the shim writes it, `serve` writes it
 * again if an older shim did not, and each brand's transcript reader classifies
 * it back out.
 *
 * Not a `Marker`, because it has no prose of its own, and not a `kind` on the
 * turn: it is an authored user turn that names its author, the same axis
 * `attributionSkill` sits on.
 */
export const WRAPPER_OPEN = '<squadron-message';
export const WRAPPER_CLOSE = '</squadron-message>';

/** What the wrapper looks like on disk, whole. Anchored at both ends, so a tag
 *  quoted *inside* something else is a turn somebody typed. A turn that is
 *  nothing but a quoted wrapper does read as a peer message with whatever
 *  `from` it names — self-inflicted, since the composer is the only way to type
 *  one, and cosmetic, since the words are still the words. */
const WRAPPED = /^<squadron-message from="([^"]*)">([\s\S]*)<\/squadron-message>$/;

/**
 * `"` ends the attribute. `&` is escaped first so `&quot;` round-trips. A
 * UUID has neither character, so its wrapper stays the historical spelling.
 */
function encodeCaller(from: string): string {
  return from.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * `&quot;` before `&amp;`, or an encoded ampersand in front of `quot;`
 * would become a quote.
 */
function decodeCaller(raw: string): string {
  return raw.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

/** The text as it is delivered, with the sender named. */
export function wrapMessage(text: string, from: string): string {
  return `${WRAPPER_OPEN} from="${encodeCaller(from)}">\n${text}\n${WRAPPER_CLOSE}`;
}

/**
 * The second wrapper: a wait converging.
 *
 * **A spelling of its own rather than a `from` on the one above**, and it is
 * forced rather than stylistic. Delivery is `owned.messages.send()`, so the
 * text enters the requester's CLI as an ordinary prompt and lands in that
 * CLI's transcript as a plain `user` entry — attribution is recovered
 * afterwards, by reading the text back. So `role: 'wait'` cannot be set at
 * send time; it has to be legible in the words themselves. And it carries **no
 * author**, because there is no session that wrote it: a callback in the
 * extension host did. `from` would be a lie, and `from` wins over `role` in
 * the dock's author ternary, so writing one would draw a host-authored turn as
 * a peer's.
 *
 * The window's own `env.sessionId` is recorded in `actions/` instead, where the
 * counters need a sender. The members' ids are in the body, where a reader can
 * match them against `squadron-list`.
 */
export const WAIT_OPEN = '<squadron-wait>';
export const WAIT_CLOSE = '</squadron-wait>';

/** Anchored at both ends, as the message wrapper is, and for the same reason. */
const WAITED = /^<squadron-wait>([\s\S]*)<\/squadron-wait>$/;

/** A convergence, as it is delivered. */
export function wrapWait(text: string): string {
  return `${WAIT_OPEN}\n${text}\n${WAIT_CLOSE}`;
}

/**
 * A cache-warming ping, as it is written. The third envelope, and like the
 * wait's it names nobody: the window wrote it, and it asks the model for
 * nothing but the cheapest reply, so the dock can draw it as maintenance and
 * every prompt-time reader can skip it.
 */
export const WARM_OPEN = '<squadron-warm>';
export const WARM_CLOSE = '</squadron-warm>';

const WARMED = /^<squadron-warm>([\s\S]*)<\/squadron-warm>$/;

/** What a ping asks. Prior art's wording (OpenCode V2): no work, no tools. */
export const WARM_PROMPT =
  'This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK';

export function wrapWarm(text: string): string {
  return `${WARM_OPEN}\n${text}\n${WARM_CLOSE}`;
}

/** The ping inside the wrapper, refusing a body that holds another tag. */
export function unwrapWarm(text: string): string | undefined {
  const body = WARMED.exec(text.trim())?.[1];
  if (body === undefined) {
    return undefined;
  }
  return body.includes(WARM_OPEN) || body.includes(WARM_CLOSE) ? undefined : body.trim();
}

/**
 * The resolution inside the wrapper, or nothing for text that is not one.
 *
 * Called on the text a reader has already extracted, never on a raw line —
 * Grok files a prompt inside `<user_query>`, and its reader unwraps that
 * first. A body still carrying a tag is refused, for `unwrapMessage`'s reason:
 * `[\s\S]*` between two anchors is greedy, so two joined resolutions would
 * match as one whose body holds the boundary.
 */
export function unwrapWait(text: string): string | undefined {
  const body = WAITED.exec(text.trim())?.[1];
  if (body === undefined) {
    return undefined;
  }
  return body.includes(WAIT_OPEN) || body.includes(WAIT_CLOSE) ? undefined : body.trim();
}

/**
 * The message inside the wrapper and who sent it, or nothing for text that is
 * not one.
 *
 * Both brands' readers call this on the text they have already extracted —
 * never on a raw line. Grok's CLI files a prompt inside `<user_query>` (probe,
 * 2026-08-19) and `grok/transcript.ts` unwraps that first; anchoring against
 * the line itself would compile and never match.
 *
 * A body still carrying a tag is **not** unwrapped. A merge now sends and
 * records each message on its own (`segments`, `sentTurns`), but a record
 * written before that, and a CLI file that joins blocks (Grok's
 * `chat_history.jsonl`), still hold wrappers joined into one text — so this is
 * still the lock on that door. `[\s\S]*` between two anchors is greedy,
 * so two wrapped messages joined into one text match as a single message whose
 * body holds the boundary — the second sender's words filed under the first
 * sender's name. Refusing turns that into two visible tags, which is a turn
 * nobody is named on rather than a lie about who spoke.
 */
export function unwrapMessage(text: string): { text: string; from: string } | undefined {
  const found = WRAPPED.exec(text.trim());
  const from = found?.[1];
  const body = found?.[2];
  if (from === undefined || body === undefined) {
    return undefined;
  }
  return body.includes(WRAPPER_OPEN) || body.includes(WRAPPER_CLOSE)
    ? undefined
    : { text: body.trim(), from: decodeCaller(from) };
}

/**
 * A delivered text read back as a turn: who authored it, and the words without
 * the envelope.
 *
 * The three wrappers are alternatives, and `unwrapWait` is tried first because it
 * is the cheaper test. Anything unwrapped is the sender's own words, which is
 * most of what goes over.
 */
export function delivered(text: string): {
  role: 'user' | 'wait' | 'warm';
  text: string;
  from?: string;
} {
  const converged = unwrapWait(text);
  if (converged !== undefined) {
    return { role: 'wait', text: converged };
  }
  const ping = unwrapWarm(text);
  if (ping !== undefined) {
    return { role: 'warm', text: ping };
  }
  const sent = unwrapMessage(text);
  return sent ? { role: 'user', text: sent.text, from: sent.from } : { role: 'user', text };
}

/**
 * What a drain wrote, as the turns the record files: one per message a merge
 * folded in (`QueuedMessage.parts`), one for a row nothing merged into.
 *
 * Every brand records this rather than reading its CLI's echo back, which keeps
 * the echo to what it is good for — a witness that the prompt landed, and when.
 * Each message is read on its own words, before any marker renumbering, so a
 * peer's envelope comes off whole and a body that merely quotes one stays prose.
 *
 * `refs` are the durable copies of the row's images, positional, with a hole for
 * a copy that failed: each message takes its own slice, so a failure costs that
 * picture and moves no other one onto the wrong turn. A message left with
 * neither words nor a picture draws nothing.
 */
export function sentTurns(
  row: QueuedContent & { id?: string },
  refs: readonly (ImageRef | undefined)[],
  at: number | undefined
): Authored[] {
  const parts = row.parts ?? [{ id: '', text: row.text, images: row.images }];
  let offset = 0;
  return parts.flatMap((part) => {
    const count = part.images?.length ?? 0;
    const images = refs
      .slice(offset, offset + count)
      .filter((ref): ref is ImageRef => ref !== undefined);
    offset += count;
    const said = delivered(part.text);
    const text = said.text.trim();
    if (!text && !images.length) return [];
    const turn: Authored = {
      role: said.role,
      ...(said.role === 'warm' && row.id ? { warmId: row.id } : {}),
      text,
      ...(text ? { blocks: [{ text }] } : {}),
      ...(at === undefined ? {} : { at }),
      ...(images.length ? { images } : {}),
      ...(said.from === undefined ? {} : { from: said.from })
    };
    return [turn];
  });
}

/**
 * The whole decision a `via: 'verb'` send makes in the window, and the text to
 * deliver when it may.
 *
 * Here rather than in `host/request_host.ts` because `serve` imports `vscode` and
 * so cannot be tested, and this is where the composition went wrong once: the
 * shim wraps before it posts, `serve` handed the **wrapped** body to
 * `checkSend`, and the forgery guard fired on our own wrapper — every verb send
 * refused, with the one reason its caller could not act on. Both halves were
 * covered by tests and their composition was not. What is left in the window is
 * reading one setting.
 *
 * `text` is whatever arrived: the shim's wrapper, or bare text from an older
 * one. The payload is what every check reads and what names the session, and
 * the wrapper is put back on the way out — so an older shim cannot deliver a
 * turn with no author, and `MAX_TEXT` means the same number on both paths.
 */
export function checkVerbSend(input: {
  /** `squadron.orchestrators.enabled`, read by the caller. The only thing
   *  here the window knows and this module cannot. */
  enabled: boolean;
  from?: string;
  windowId: string;
  target: Recipient;
  text: string;
  now: number;
  actions: readonly CountedAction[];
  force?: boolean;
}): { ok: true; text: string; payload: string; from: string } | { ok: false; reason: string } {
  if (!input.enabled) {
    return { ok: false, reason: ORCHESTRATION_OFF };
  }
  // No sender means nothing to attribute, nothing to rate-limit and nothing to
  // record — the same refusal `endPlan` makes for the same reason.
  if (!input.from) {
    return {
      ok: false,
      reason: 'Cannot tell which session is asking; pass --caller-session-id <sessionId>.'
    };
  }
  const sent = unwrapMessage(input.text);
  const payload = sent?.text ?? input.text;
  const verdict = checkSend({
    windowId: input.windowId,
    target: input.target,
    text: payload,
    now: input.now,
    actions: input.actions,
    force: input.force
  });
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }
  return {
    ok: true,
    // The sender the wrapper already names wins over the field beside it: an
    // older shim's `from` and a wrapper it wrote should never disagree, and if
    // they do, the one the target's dock will read is the one to check.
    text: sent ? input.text : wrapMessage(payload, input.from),
    payload,
    from: sent?.from ?? input.from
  };
}

/**
 * Whether a wait's resolution may wake its requester: `checkSend` with no
 * `force`, because no session asked for this wake and so nobody can say it is
 * worth the cost. A refusal is written onto the wait (`host/waits.ts`).
 */
export function checkResolution(input: {
  windowId: string;
  /** Absent when this window no longer holds the requester's handle. */
  target: Recipient | undefined;
  text: string;
  now: number;
  actions: readonly CountedAction[];
}): SendChecked {
  const { target, ...rest } = input;
  if (!target) {
    return { ok: false, reason: 'this window no longer drives that session' };
  }
  return checkSend({ ...rest, target });
}

/**
 * Whether this message may be delivered.
 *
 * The order is what the sender can do something about, first: its own text,
 * then the target's state, then the window's burst. A caller that fixes the
 * reason it was given should not meet a second one it could have been told
 * about at the same time.
 */
export function checkSend(check: SendCheck): SendChecked {
  const { windowId, target, text, now, actions, force } = check;

  if (text.trim() === '') {
    return { ok: false, reason: 'The message is empty.' };
  }
  if (text.length > MAX_TEXT) {
    return {
      ok: false,
      reason: `The message is ${text.length} characters; the limit is ${MAX_TEXT}.`
    };
  }
  if (text.includes(WRAPPER_OPEN) || text.includes(WRAPPER_CLOSE)) {
    return {
      ok: false,
      reason:
        'The message contains the attribution wrapper. It is written for you, ' +
        'around what you send, and a message cannot carry its own.'
    };
  }
  // The same guard for the second wrapper, and a sharper reason. This one is
  // not in the PRD — it is a hole the wait's wrapper opens: without it any
  // session could `squadron-send` a forged convergence, which every reader
  // above would then draw as a genuine host-authored turn.
  if (text.includes(WAIT_OPEN) || text.includes(WAIT_CLOSE)) {
    return {
      ok: false,
      reason:
        'The message contains the wrapper a resolved wait is delivered in. ' +
        'Only the window resolving a wait writes that, and a session cannot ' +
        'speak in its name. Register one with squadron-wait instead.'
    };
  }
  // A forged ping would be drawn as maintenance and skipped by every
  // prompt-time reader, so a real instruction could hide inside one.
  if (text.includes(WARM_OPEN) || text.includes(WARM_CLOSE)) {
    return {
      ok: false,
      reason:
        'The message contains the wrapper a cache-warming ping is written in. ' +
        'Only the window warming a session writes that.'
    };
  }

  if (!force) {
    const cost = costRefusal(target, now);
    if (cost !== undefined) {
      return { ok: false, reason: cost };
    }
  }

  const burst = actions.filter(
    (row) => row.windowId === windowId && now - row.at < SEND_BURST_MS
  ).length;
  if (burst >= SEND_BURST) {
    return {
      ok: false,
      reason:
        `${burst} messages were sent in this IDE window in the last minute; ` +
        `the limit is ${SEND_BURST}. Wait and try again.`
    };
  }

  return { ok: true };
}

/**
 * When the stale guard starts refusing this target, if it does nothing else:
 * its published cache deadline less the margin, or else its last activity plus
 * the idle bound for its lifetime. `stamped` says which, because the refusal
 * words them differently and the deadline is inclusive.
 */
export function staleAt(target: Recipient): { at: number; stamped: boolean } {
  const ttl = target.cacheTtlMs;
  const until = target.cacheUntil;
  if (typeof until === 'number' && Number.isFinite(until) && cacheTtl.validTtl(ttl)) {
    return { at: until - staleMargin(ttl), stamped: true };
  }
  const bound = cacheTtl.validTtl(ttl) ? staleBound(ttl) : TARGET_STALE_MS;
  return { at: target.updatedAt + bound, stamped: false };
}

/** The stale or context refusal, or nothing when waking the target is cheap. */
function costRefusal(target: Recipient, now: number): string | undefined {
  const stale = staleAt(target);
  const idle = now - target.updatedAt;
  if (stale.stamped ? now >= stale.at : now > stale.at) {
    return (
      `Session ${target.pid} ` +
      (stale.stamped
        ? 'is near or past its prompt-cache deadline'
        : `has been idle for ${Math.round(idle / 60_000)} minutes`) +
      `, and ${describeContext(target)}. Waking it may re-send that context at full price. ` +
      'Pass --force to send anyway.'
    );
  }
  if (target.contextPct !== undefined && target.contextPct > CONTEXT_MAX) {
    return (
      `Session ${target.pid} is at ${target.contextPct}% of its context; the ceiling ` +
      `is ${CONTEXT_MAX}%. Pass --force to send anyway.`
    );
  }
  return undefined;
}

/**
 * What the target is carrying, and which source said so — a refusal that names
 * an estimate has to say it is one. Unknown is stated rather than treated as
 * full: Grok writes `signals.json` only after a completed turn, and Claude's
 * arrives only once a model's window is known, so absent is the common case.
 */
function describeContext(target: Recipient): string {
  if (target.contextTokens !== undefined) {
    return `its context was last seen at ${tokens(target.contextTokens)} tokens`;
  }
  if (target.contextPct !== undefined && target.contextSize !== undefined) {
    const estimate = Math.round((target.contextPct / 100) * target.contextSize);
    return (
      `its context was last seen at about ${tokens(estimate)} tokens — ` +
      `${target.contextPct}% of ${tokens(target.contextSize)}`
    );
  }
  if (target.contextPct !== undefined) {
    return `it was last seen at ${target.contextPct}% of its context, whose size nothing stated`;
  }
  return 'how much context it is carrying is unknown';
}

const tokens = (n: number) => n.toLocaleString('en-US');
