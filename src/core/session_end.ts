import type { SessionHandle } from './adapter';
import type { SignalEnd } from './control';
import type { AskFailure, AskResult } from './coordination/ask';
import type { Reply, RequestBody } from './coordination/requests';
import { sameSessionStart } from './model';
import * as published from './published';
import * as scan from './scan';
import * as sessionTarget from './session_target';

export type EndTarget = { pid: number; startedAt: number; windowId?: string };
export type EndOutcome =
  | { ok: true; kind: 'closing' | 'gone' }
  | { ok: false; kind: AskFailure; reason: string; reply?: Reply };
export type EndResult<T extends EndTarget = EndTarget> = { target: T; outcome: EndOutcome };
export type EndObservation = { kind: 'gone' | 'unknown' } | { kind: 'running'; windowId?: string };

export type EndPort = {
  local?: {
    windowId: string;
    owned(pid: number): Pick<SessionHandle, 'state'> | undefined;
    end(pid: number, startedAt: number): boolean;
    ending?(pid: number, startedAt: number): boolean;
  };
  ask(request: RequestBody): Promise<AskResult>;
  claims?(): Promise<readonly { id: string }[]>;
  observe(targets: readonly EndTarget[]): Promise<readonly EndObservation[]>;
  /** Omitted for callers whose authority ends at asking the owner. */
  signal?(targets: readonly EndTarget[]): Promise<readonly SignalEnd[]>;
};

/** Execute an authorized selection; selection and permission remain with the trigger. */
export async function endSessions<T extends EndTarget>(
  targets: readonly T[],
  port: EndPort
): Promise<EndResult<T>[]> {
  let windows: ReadonlySet<string> | undefined;
  try {
    if (port.claims) windows = new Set((await port.claims()).map(({ id }) => id));
  } catch {
    // A missing claim observation cannot prove that an addressed owner is gone.
  }
  const members = await Promise.all(
    targets.map(async (target) => {
      const attempted: EndTarget = target;
      return { target, attempted, outcome: await close(target, port, windows) };
    })
  );
  let pending = members.filter(({ outcome }) => retryable(outcome));
  if (!pending.length) return members.map(({ target, outcome }) => ({ target, outcome }));

  const observations = await observe(pending, port);
  const retries: Promise<void>[] = [];
  pending = pending.filter((member, at) => {
    const seen = observations[at];
    if (!verify(member, seen)) return false;
    const owner =
      seen?.kind === 'running' ? (seen.windowId ?? member.attempted.windowId) : undefined;
    if (owner && (owner !== member.attempted.windowId || member.outcome.kind === 'silent')) {
      member.attempted = { ...member.target, windowId: owner };
      retries.push(
        (async () => {
          // The fresh publication names the owner even if the earlier claim list did not.
          member.outcome = await close(member.attempted, port);
        })()
      );
    }
    return true;
  });
  if (retries.length) {
    await Promise.all(retries);
    pending = pending.filter(({ outcome }) => retryable(outcome));
    const fresh = await observe(pending, port);
    pending = pending.filter((member, at) => {
      const seen = fresh[at];
      if (!verify(member, seen)) return false;
      if (
        seen?.kind === 'running' &&
        seen.windowId &&
        seen.windowId !== member.attempted.windowId
      ) {
        member.outcome = failure('silent', 'its owning window changed again; close is unconfirmed');
        return false;
      }
      return true;
    });
  }

  if (port.signal && pending.length) {
    let signalled: readonly SignalEnd[] = [];
    try {
      signalled = await port.signal(pending.map(({ attempted }) => attempted));
    } catch {
      // Report every unresolved member below, including a failed batch operation.
    }
    pending.forEach((member, at) => {
      const result = signalled[at];
      member.outcome =
        result === 'ended'
          ? { ok: true, kind: 'closing' }
          : result === 'gone'
            ? { ok: true, kind: 'gone' }
            : typeof result === 'object'
              ? failure('refused', `${reason(member.outcome)}; ${result.reason}`)
              : failure('unexpected', `${reason(member.outcome)}; it could not be signalled`);
    });
  }
  return members.map(({ target, outcome }) => ({ target, outcome }));
}

/** One batched native observation, used only after an unsuccessful close. */
export async function observeEnds(targets: readonly EndTarget[]): Promise<EndObservation[]> {
  const [processes, records] = await Promise.all([
    scan.scanProcesses(true),
    Promise.all(targets.map(({ pid }) => published.readPublishedOne(pid)))
  ]);
  return targets.map((target, at) => {
    if (!processes.complete) return { kind: 'unknown' };
    if (!sameSessionStart(processes.starts.get(target.pid), target.startedAt))
      return { kind: 'gone' };
    const reading = records[at];
    if (!reading || reading.kind === 'unknown') return { kind: 'unknown' };
    const record = reading.kind === 'found' ? reading.record : undefined;
    if (!record || !sameSessionStart(record.session.startedAt, target.startedAt))
      return { kind: 'running' };
    if (record.exit !== undefined) return { kind: 'gone' };
    const control = sessionTarget.controlOf(record.session);
    if (!control.canControl) return { kind: 'unknown' };
    return control.owner.kind === 'window'
      ? { kind: 'running', windowId: control.owner.windowId }
      : { kind: 'running' };
  });
}

async function close(
  target: EndTarget,
  port: EndPort,
  windows?: ReadonlySet<string>
): Promise<EndOutcome> {
  try {
    if (
      !Number.isInteger(target.pid) ||
      target.pid <= 0 ||
      !Number.isFinite(target.startedAt) ||
      target.startedAt <= 0
    )
      return failure('refused', 'invalid session identity');
    if (!target.windowId) return failure('unwritable', 'no window claims it');
    if (port.local?.windowId === target.windowId) {
      if (port.local.ending?.(target.pid, target.startedAt)) return { ok: true, kind: 'closing' };
      const owned = port.local.owned(target.pid);
      if (!owned) return failure('unwritable', 'this window no longer drives it');
      if (owned.state.startedAt !== target.startedAt) {
        return { ok: true, kind: 'gone' };
      }
      return port.local.end(target.pid, target.startedAt)
        ? {
            ok: true,
            kind:
              port.local.ending?.(target.pid, target.startedAt) || owned.state.exit === undefined
                ? 'closing'
                : 'gone'
          }
        : failure('unexpected', 'its pipe would not close');
    }
    if (windows && !windows.has(target.windowId))
      return failure('unwritable', 'its window has closed');
    const result = await port.ask({
      kind: 'close',
      windowId: target.windowId,
      pid: target.pid,
      startedAt: target.startedAt
    });
    if (result.ok) return { ok: true, kind: 'closing' };
    if ('reply' in result) {
      switch (result.reply.closeFailure) {
        case 'gone':
          return { ok: true, kind: 'gone' };
        case 'unavailable':
          return { ...failure('unwritable', result.reason), reply: result.reply };
        case 'failed':
          return { ...failure('unexpected', result.reason), reply: result.reply };
      }
      if (result.reply.unsure) return { ...failure('silent', result.reason), reply: result.reply };
    }
    return result;
  } catch (error) {
    return failure('unexpected', error instanceof Error ? error.message : String(error));
  }
}

type Member = EndResult & { attempted: EndTarget };

async function observe(
  members: readonly Member[],
  port: EndPort
): Promise<readonly EndObservation[]> {
  if (!members.length) return [];
  try {
    return await port.observe(members.map(({ attempted }) => attempted));
  } catch {
    return [];
  }
}

function verify(member: Member, seen: EndObservation | undefined): boolean {
  if (seen?.kind === 'gone') {
    member.outcome = { ok: true, kind: 'gone' };
    return false;
  }
  if (!seen || seen.kind === 'unknown') {
    member.outcome = failure(
      member.outcome.ok ? 'silent' : member.outcome.kind,
      `${reason(member.outcome)}; its current process could not be verified`
    );
    return false;
  }
  return true;
}

function retryable(outcome: EndOutcome): boolean {
  return !outcome.ok && outcome.kind !== 'refused';
}

function failure(kind: AskFailure, reason: string): Extract<EndOutcome, { ok: false }> {
  return { ok: false, kind, reason };
}

function reason(outcome: EndOutcome): string {
  return outcome.ok ? outcome.kind : outcome.reason;
}
