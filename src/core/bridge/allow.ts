/**
 * Who may drive Squadron from a messenger, and dropping what arrives twice.
 *
 * The allowlist is the bridge's one security check (D9). It runs first, before
 * dedupe, the store or any reply, so an event from anyone else has no side
 * effect at all — not even a refusal the stranger could read.
 */

import type { Sender, SenderId } from './model';
import type { AccountRule, CredentialField, Credentials } from './port';

/**
 * A hand-edited setting can hold anything. Trimmed, blanks and non-strings
 * dropped, and the first of a repeat kept: order matters, since the first id
 * is home and receives every conversation the bridge opens.
 */
export function normalizeAllowlist(raw: unknown): SenderId[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is string => typeof id === 'string').map((id) => id.trim());
  return [...new Set(ids.filter(Boolean))];
}

/** An exact match on the opaque id, with no case folding: the adapter's id is
 *  the identity, and folding it could admit someone it does not name. */
export function allowed(sender: Sender, list: readonly SenderId[]): boolean {
  return list.includes(sender.id);
}

/** Why a stored account is not admitted: the messenger can never use it, or
 *  it needs the space and none is set. */
export type AccountProblem = { kind: 'refused'; reason: string } | { kind: 'space' };

export type ResolvedAccounts = {
  /** The sender ids admitted, in the list's order, each once: the first is
   *  home, so an account the messenger cannot post to never is. */
  ids: SenderId[];
  /** Every stored account that is not admitted, and why. */
  unusable: { account: string; problem: AccountProblem }[];
};

/**
 * The allowlist setting as the bridge admits it: each account through the
 * messenger's rule, with the space setting, which a rule that refuses it
 * reads as unset. A hand-edited setting can hold anything, and what the rule
 * cannot use is reported, not dropped silently.
 */
export function resolveAccounts(
  rule: AccountRule,
  accounts: readonly string[],
  space: string | undefined
): ResolvedAccounts {
  const usable = space !== undefined && rule.refuseSpace(space) === undefined ? space : undefined;
  const ids: SenderId[] = [];
  const unusable: ResolvedAccounts['unusable'] = [];
  for (const account of accounts) {
    const reason = rule.refuse(account);
    const id = reason === undefined ? rule.sender(account, usable) : undefined;
    if (reason !== undefined) unusable.push({ account, problem: { kind: 'refused', reason } });
    else if (id === undefined) unusable.push({ account, problem: { kind: 'space' } });
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unusable };
}

/**
 * An edit of the allowlist, as it may be written: an account already stored
 * always stays, so a removal is never refused, and an account the edit adds
 * that the rule refuses is left out with its reason. The rest of the edit
 * still lands, so an add queued behind a refused one is not lost.
 */
export function admitAccounts(
  rule: AccountRule,
  stored: readonly string[],
  next: readonly string[]
): { write: string[]; refused: { account: string; reason: string }[] } {
  const write: string[] = [];
  const refused: { account: string; reason: string }[] = [];
  for (const account of normalizeAllowlist(next)) {
    const reason = stored.includes(account) ? undefined : rule.refuse(account);
    if (reason === undefined) write.push(account);
    else refused.push({ account, reason });
  }
  return { write, refused };
}

/** Whether an account waits on the space: then the space is the fix. */
export function waitsOnSpace(unusable: readonly { problem: AccountProblem }[]): boolean {
  return unusable.some(({ problem }) => problem.kind === 'space');
}

export type TurnOn = { ok: true } | { ok: false; reason: string };

/** Whether Remote can turn on: every credential the messenger asks for, and
 *  someone allowed. An empty allowlist admits nobody, so it refuses here.
 *  `space` is given when an account waits on it, which is then the thing to
 *  fix: a check fills one unset, and none replaces one set and refused. */
export function canTurnOn(input: {
  fields: readonly CredentialField[];
  credentials: Credentials;
  allowlist: readonly SenderId[];
  space?: { label: string; set: boolean };
}): TurnOn {
  const missing = input.fields.find((field) => !input.credentials[field.key]?.trim());
  if (missing) return { ok: false, reason: `Remote needs the ${missing.label} first.` };
  if (input.allowlist.length === 0) {
    return {
      ok: false,
      reason:
        input.space === undefined
          ? 'Remote needs an allowed account first.'
          : input.space.set
            ? `Remote needs a ${input.space.label} it can use.`
            : `Remote needs the ${input.space.label} first. Check fills it in.`
    };
  }
  return { ok: true };
}

/**
 * How long a delivery id is remembered (a duration): `route`'s `LATE_MS` plus
 * the longest redelivery delay a messenger has, so a copy that is still young
 * enough to act is always known as a repeat. Ten minutes for the delay is
 * provisional, over the longest retry schedule a registered messenger
 * documents, until it is measured (`TASK_done_messenger_hardening.md`,
 * Step 1).
 */
export const DEDUPE_MS = 25 * 60_000;

/** At most this many ids are held, so a flood cannot grow the memory. */
const DEDUPE_MAX = 500;

/** The delivery ids seen recently. The engine keeps them on disk beside its
 *  watermark (`store.ts`), so a catch-up after a reload knows what acted. */
export class Deduper {
  /** Id to when it was first seen, in insertion order: the oldest first. */
  private readonly seen: Map<string, number>;

  constructor(seen: Iterable<readonly [string, number]> = []) {
    this.seen = new Map(seen);
  }

  /** Every id remembered, oldest first, with when it was first seen. */
  entries(): [string, number][] {
    return [...this.seen];
  }

  /** True the first time an id arrives inside the window, false for a repeat. */
  admit(id: string, now: number): boolean {
    for (const [old, at] of this.seen) {
      if (now - at <= DEDUPE_MS) break;
      this.seen.delete(old);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    if (this.seen.size > DEDUPE_MAX) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }
}
