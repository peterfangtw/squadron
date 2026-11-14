import * as crypto from 'node:crypto';
import * as control from '../control';
import * as platform from '../platform';
import * as scan from '../scan';
import * as claim from '../coordination/owner_claim';
import * as incoming from '../incoming';
import type * as bridge from '../bridge/model';
import * as lifetime from '../session_lifetime';
import * as routines from './routines';
import type * as types from './types';

export function durableOwner(
  scope: types.Scope,
  runId: string,
  writer: types.Member
): {
  durableObservation: lifetime.DurableObservation;
  gone(): Promise<void>;
} {
  const tenure = crypto.randomUUID();
  let generation = 0;
  let root: types.Member | undefined;
  const apply = async (action: routines.Action): Promise<types.Attempt> => {
    const result = await routines.applyRoutineAction(scope, action, Date.now());
    if (result.kind !== 'ok' || !result.attempt)
      throw new Error(result.kind === 'ok' ? 'Missing routine attempt.' : result.reason);
    return result.attempt;
  };
  return {
    durableObservation: {
      begin: async () => {
        const attempt = await apply({
          kind: 'beginObservation',
          operationId: crypto.randomUUID(),
          runId,
          writer,
          tenure
        });
        if (!attempt.observation) throw new Error('Missing observation acknowledgment.');
        generation = attempt.observation.generation;
        return generation;
      },
      commit: async (observed, members, table, coverage, captured) => {
        root = captured ?? root;
        if (!table.startSource && members.length)
          throw new Error('Native process clock is unavailable.');
        await apply({
          kind: 'rememberMembers',
          operationId: crypto.randomUUID(),
          runId,
          writer,
          tenure,
          generation: observed,
          members: members.map((member) => ({ ...member, startSource: writer.startSource })),
          table,
          coverage
        });
      },
      unprovable: async () => {
        await apply({
          kind: 'recordUnprovable',
          operationId: crypto.randomUUID(),
          runId,
          writer,
          reason:
            'The session exited before its process identity was captured, so its cleanup cannot be proved.'
        });
      }
    },
    gone: async () => {
      if (root) await recordCapturedChild(scope, runId, writer, root);
      await apply({
        kind: 'confirmCleanup',
        operationId: crypto.randomUUID(),
        runId,
        writer,
        tenure,
        generation
      });
    }
  };
}

/**
 * A root the initial capture established but whose `recordChild` never landed
 * (a refused write, or a start abandoned between capture and record). Absence
 * is judged against the recorded child, so record it from the launch writer and
 * let the next observation decide; this release attempt does not.
 */
async function recordCapturedChild(
  scope: types.Scope,
  runId: string,
  writer: types.Member,
  root: types.Member
): Promise<void> {
  const snapshot = await routines.readRoutineSnapshot(scope);
  const attempt = snapshot.kind === 'ok' ? snapshot.snapshot.repository.attempts[runId] : undefined;
  if (!attempt || attempt.child || attempt.phase !== 'spawning') return;
  if (!routines.sameMember(routines.hostMember(attempt.owner), writer))
    throw new Error('Only the launch writer can record its captured child.');
  const result = await routines.applyRoutineAction(
    scope,
    {
      kind: 'recordChild',
      operationId: crypto.randomUUID(),
      runId,
      owner: attempt.owner,
      child: root
    },
    Date.now()
  );
  if (result.kind !== 'ok') throw new Error(result.reason);
  throw new Error('Recorded the captured child; cleanup needs a new observation.');
}

/** How long recovery waits for complete native evidence or a durable write. */
const RETRY_MS = 30_000;

type Recovery = {
  tenure: string;
  writer: types.Member;
  stage: 'stop' | 'descendants' | 'root' | 'confirm';
  stoppedAt?: number;
  at: number;
  members: types.Member[];
};

/** Orphan recovery keeps one writer through every grace stage; the host supplies deadlines. */
export class RoutineRecovery {
  private disposed = false;
  private readonly runners = new Map<string, Recovery>();

  dispose(): void {
    this.disposed = true;
    this.runners.clear();
  }

  async reconcile(
    scope: types.Scope,
    now: number,
    currentOwner?: bridge.HostIdentity
  ): Promise<number | undefined> {
    const snapshot = await routines.readRoutineSnapshot(scope);
    if (this.disposed || snapshot.kind !== 'ok') return undefined;
    const foreign = Object.values(snapshot.snapshot.repository.attempts).filter(
      (attempt) => !currentOwner || !incoming.sameHost(attempt.owner, currentOwner)
    );
    // An attempt with no recorded child has no retained identity to clean up;
    // only a reservation that never spawned can still settle, by owner death.
    const reserved = foreign.filter((attempt) => attempt.phase === 'reserved');
    const candidates = foreign.filter(
      (attempt) => !attempt.cleanupConfirmed && attempt.child !== undefined
    );
    const live = new Set(candidates.map((attempt) => attempt.runId));
    for (const runId of this.runners.keys()) if (!live.has(runId)) this.runners.delete(runId);
    let deadline: number | undefined;
    const waiting = (at: number): void => {
      deadline = Math.min(deadline ?? Infinity, at);
    };
    const due = [...reserved, ...candidates].filter((attempt) => {
      const runner = this.runners.get(attempt.runId);
      if (runner && runner.at > now) waiting(runner.at);
      return !runner || runner.at <= now;
    });
    if (!due.length) return deadline;
    // The cached table only selects; every write below is judged on a fresh one.
    const cached = await scan.scanProcesses();
    if (this.disposed) return undefined;
    if (!cached.complete || !cached.startSource) return now + RETRY_MS;
    const orphaned = due.filter(
      (attempt) =>
        this.runners.has(attempt.runId) ||
        claim.judge(cached, routines.hostMember(attempt.owner)) === 'gone'
    );
    if (!orphaned.length) return deadline;
    const table = await scan.scanProcesses(true);
    if (this.disposed) return undefined;
    if (!table.complete || !table.startSource) return now + RETRY_MS;
    const startedAt = table.starts.get(process.pid);
    if (startedAt === undefined) return now + RETRY_MS;
    const writer = { pid: process.pid, startedAt, startSource: table.startSource };
    for (const attempt of orphaned) {
      if (this.disposed) return undefined;
      if (claim.judge(table, routines.hostMember(attempt.owner)) !== 'gone') continue;
      if (attempt.phase === 'reserved') {
        await routines.applyRoutineAction(
          scope,
          {
            kind: 'recordStopped',
            operationId: crypto.randomUUID(),
            runId: attempt.runId,
            owner: attempt.owner,
            noChild: true,
            reason: 'The window closed before spawning.'
          },
          now
        );
        continue;
      }
      let runner = this.runners.get(attempt.runId);
      const observation = attempt.observation;
      if (!runner) {
        if (
          observation?.pending ||
          (observation && claim.judge(table, observation.writer) !== 'gone')
        )
          continue;
        runner = {
          tenure: crypto.randomUUID(),
          writer,
          stage: 'stop',
          at: now,
          members: attempt.members
        };
        this.runners.set(attempt.runId, runner);
      }
      const next = await this.step(scope, attempt, runner, now, table);
      if (next !== undefined) waiting(next);
    }
    return deadline;
  }

  private async step(
    scope: types.Scope,
    attempt: types.Attempt,
    runner: Recovery,
    now: number,
    initial: scan.ProcessTable
  ): Promise<number | undefined> {
    const action = {
      operationId: crypto.randomUUID(),
      runId: attempt.runId,
      writer: runner.writer,
      tenure: runner.tenure
    };
    const begun = await routines.applyRoutineAction(
      scope,
      { ...action, kind: 'beginObservation', table: initial },
      now
    );
    if (this.disposed || begun.kind !== 'ok' || !begun.attempt?.observation) return undefined;
    const generation = begun.attempt.observation.generation;
    const table = await scan.scanProcesses(true);
    if (this.disposed) return undefined;
    const members = new Map(
      runner.members.map((member) => [
        `${member.startSource}/${member.pid}/${member.startedAt}`,
        member
      ])
    );
    if (table.complete && table.startSource) {
      for (const member of [...members.values()]) {
        if (claim.judge(table, member) !== 'live') continue;
        for (const child of control.snapshotTree(member.pid, table))
          members.set(`${table.startSource}/${child.pid}/${child.startedAt}`, {
            ...child,
            startSource: table.startSource
          });
      }
    }
    runner.members = [...members.values()];
    const committed = await routines.applyRoutineAction(
      scope,
      {
        ...action,
        operationId: crypto.randomUUID(),
        kind: 'rememberMembers',
        generation,
        members: runner.members,
        table,
        coverage: table.complete ? 'observed' : 'limited'
      },
      now
    );
    if (this.disposed) return undefined;
    if (committed.kind !== 'ok' || !committed.attempt) return (runner.at = now + RETRY_MS);
    if (committed.attempt.observation?.absent) {
      const confirmed = await routines.applyRoutineAction(
        scope,
        { ...action, operationId: crypto.randomUUID(), kind: 'confirmCleanup', generation },
        now
      );
      if (confirmed.kind !== 'ok') return (runner.at = now + RETRY_MS);
      this.runners.delete(attempt.runId);
      return undefined;
    }
    if (!table.complete) return (runner.at = now + RETRY_MS);
    // Revalidate the durable tenure immediately before any table-based signal.
    const current = await routines.readRoutineSnapshot(scope);
    const held =
      current.kind === 'ok'
        ? current.snapshot.repository.attempts[attempt.runId]?.observation
        : undefined;
    if (
      this.disposed ||
      !held ||
      held.pending ||
      held.generation !== generation ||
      held.tenure !== runner.tenure
    )
      return undefined;
    const ordered = control.orderLifetimeMembers(
      attempt.child?.pid,
      runner.members.filter((member) => claim.judge(table, member) === 'live'),
      table
    );
    for (const member of ordered) {
      const root = member.pid === attempt.child?.pid;
      if (runner.stage === 'descendants' && root) continue;
      if (runner.stage === 'root' && !root) continue;
      if (this.disposed) return undefined;
      platform.processes.signal(
        [member],
        runner.stage === 'stop' ? 'stop' : 'kill',
        table,
        root ? { alone: true } : undefined
      );
    }
    if (runner.stage === 'stop') {
      runner.stoppedAt = now;
      runner.stage = 'descendants';
      runner.at = now + control.REAP_GRACE_MS;
    } else if (runner.stage === 'descendants') {
      runner.stage = 'root';
      runner.at = (runner.stoppedAt ?? now) + lifetime.CLI_REAP_GRACE_MS;
    } else {
      runner.stage = 'confirm';
      runner.at = now + 1_000;
    }
    return runner.at;
  }
}
