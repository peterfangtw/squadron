/**
 * The registered waits, resolved: read them, run the rule, deliver the one
 * message, delete the record.
 *
 * Owns the reads and delivery; core/reconcile.ts owns scheduling. Every rule
 * it applies lives in `core/coordination/wait.ts`, where it can be tested.
 * This file is delivery and wiring, as `src/AGENTS.md` asks of everything under
 * `host/`, the same split core/awake.ts and host/keepawake.ts already use.
 *
 * **This is not the panel's business.** It lives in `activate()` beside the
 * keep-awake keeper, and for the same reason: a fan-out converging while nobody
 * is looking at the board is exactly when a requester needs telling. A wait
 * that only resolved with a panel open would be a feature that works when
 * somebody is watching it.
 *
 * **Two subscriptions, and both are required.** `onOwnedChange` is the common
 * case — a member this window drives emits a frame, and the announcement fires
 * off that frame, before the disk. `onSessionState` is the exception — a member
 * in another window, heard through its publish. `host/watch.ts` deliberately
 * drops this window's own pids from the second, so subscribing only to it would
 * silently never resolve a same-window fan-out, which is the one that actually
 * happens (`pickWindow` resolves by cwd, so a fan-out lands on one host).
 *
 * **The requester's own turn ending is the first trigger, free.** It goes
 * busy→idle when the registering turn ends, which is a frame, which fires
 * `onOwnedChange` — so a wait over members that are already finished resolves
 * one change-coalescing window later rather than hanging until some unrelated session
 * speaks.
 */
import { scanProcesses } from '../core/scan';
import * as vscode from 'vscode';
import * as reconcile from '../core/reconcile';
import { waitBoard, type WaitBoard } from '../core/coordination/wait_board';
import type { SessionHandle } from '../core/adapter';
import * as admit from '../core/coordination/admit';
import {
  WaitResolution,
  dropWait,
  WAKE_RETRY_MS,
  passDeadline,
  heldUntil,
  readWaits,
  resolveWaits,
  writeWait
} from '../core/coordination/wait';
import { ParkedReport, dropReport, orphaned, readReports } from '../core/coordination/reports';
import { readWorkflowWaitStates } from '../core/workflows/wait';
import { ownedSession, ownedSessions, ownedTarget } from './sessions';

/**
 * Coalesce both triggers from the first event, without postponing on later events.
 *
 * `onOwnedChange` fires per frame, so a streaming turn would otherwise drive a
 * pass every few milliseconds — and a pass that finds a wait pending builds the
 * whole board, which spawns a `ps`. Five of those a second is not a cost this
 * feature is allowed to add.
 *
 * Fifteen seconds, not the 1000 ms `LIVE_MS` floor it used to sit on: a fan-out
 * streams the whole time it runs, so the floor was the rate, a board build a
 * second for minutes. A convergence is a minutes-long event, and a requester
 * woken up to fifteen seconds late loses nothing it can act on.
 */
const CHANGE_DEBOUNCE_MS = 15_000;

export class WaitResolver implements vscode.Disposable {
  private disposed = false;
  /** Wait id → when a wake whose send failed may be tried again. */
  private readonly retryAt = new Map<string, number>();
  readonly registration: reconcile.CheckRegistration;
  private readonly admission: admit.AdmissionPort = {
    owned: ownedSession,
    target: ownedTarget,
    windowId: vscode.env.sessionId,
    // A wake is the window's own message, not an agent's: no switch gates it.
    orchestrators: () => true
  };

  constructor(
    runtime: reconcile.Reconciler,
    private readonly log: (line: string) => void = () => {}
  ) {
    this.registration = runtime.register('wait pass', CHANGE_DEBOUNCE_MS, () => this.once());
  }

  /**
   * One pass: read the waits, keep the ones this window can answer, run the
   * predicate against the board, deliver, delete.
   *
   * **The waits are read first, and that ordering is the cost decision.** A
   * machine with none pending — which is nearly all of them, nearly all the
   * time — pays one `readdir` of an empty directory per change-coalescing window and
   * touches nothing else. The board below is two reads and is only ever built
   * for a wait that exists.
   *
   * **Ownership picks the resolver.** Every window runs this; exactly one owns
   * any given requester, and it is the one holding the pipe a resolution would
   * go out on. So who acts falls out of who owns, rather than out of a
   * `windowId` written at registration. Reload closes the old owned pipes,
   * so there is no surviving requester for an activation scan to recover.
   */
  private async once(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const waits = await readWaits();
    // Read beside the waits rather than after the early return below, and that
    // ordering is the whole of "release, never strand": a report whose wait has
    // been deleted or refused is exactly the case where `mine` is empty, so
    // reading these only when a wait survives would leave the reports that most
    // need rescuing behind the return that skips them.
    const reports = await readReports();
    if (this.disposed) {
      return;
    }
    // Nothing of ours pending means no standing deadline to keep.
    // **Only this window's waits are counted**, even for the clock: another
    // window owns its own requesters and schedules its own deadline; a wait nobody
    // owns is swept by age rather than waited on.
    const mine = waits.filter((wait) => ownedSession(wait.requesterPid));
    // Before the early return, for the same reason they were read early.
    await this.rescue(reports, waits);
    if (this.disposed) {
      return;
    }
    if (mine.length === 0) {
      this.registration.schedule(undefined);
      return;
    }

    const { members: board, processes, running, retired, records } = await this.board();
    const workflowStates = await readWorkflowWaitStates(mine, board, Date.now());
    const resolved = resolveWaits({
      waits: mine,
      board,
      workflowStates,
      processes,
      running,
      retired,
      records,
      reports,
      now: Date.now()
    });
    const gone = new Set(resolved.flatMap((one) => one.waits.map((wait) => wait.id)));
    for (const id of this.retryAt.keys()) {
      if (!waits.some((wait) => wait.id === id)) this.retryAt.delete(id);
    }
    for (const resolution of resolved) {
      if (this.disposed) {
        return;
      }
      // A failed send waits out its delay even when a change brings the pass
      // back sooner.
      const until = heldUntil(resolution.waits, this.retryAt, Date.now());
      if (until !== undefined) {
        for (const wait of resolution.waits) {
          gone.delete(wait.id);
          this.retryAt.set(wait.id, until);
        }
        continue;
      }
      const outcome = await this.deliver(resolution);
      for (const wait of resolution.waits) {
        if (outcome.kind === 'undelivered') {
          gone.delete(wait.id);
          this.retryAt.set(wait.id, Date.now() + WAKE_RETRY_MS);
        } else {
          this.retryAt.delete(wait.id);
        }
      }
    }
    // Schedule from what remains: the earliest expiry, workflow recheck or
    // retry sets this registration's next deadline.
    const pending = mine.filter((wait) => !gone.has(wait.id));
    this.registration.schedule(
      passDeadline({
        pending,
        retryAt: this.retryAt,
        checkAt: (id) => workflowStates.get(id)?.checkAt,
        now: Date.now()
      })
    );
  }

  /**
   * The board, exactly as every other consumer builds it.
   *
   * **`foldTwins` and not a fold of our own**, and two rules in this feature
   * depend on that rather than on tidiness:
   *
   * - **`hasCommand` comes off the process table**, not off any frame:
   *   `core/live.ts` writes `false` for every session it builds. `withTwin`
   *   carries the twin's, and `waitBoard` adds the table's for every member,
   *   so one with no twin is still read. Read from `ownedSessions()` and `readPublished()` alone,
   *   the predicate's "idle is not enough" term is always true, and PRD §5.4's
   *   central rule is inert in the one place it was written for.
   * - **A published record is only ever read beside a live twin.**
   *   `core/published.ts` states it: a record with no twin is from a window
   *   that is gone. Unfolded, a crashed window's last `idle` publish reads as a
   *   member that finished, which is S2 inverted — the wait would say
   *   "reported" about a session that stopped existing.
   *
   * This is what `CHANGE_DEBOUNCE_MS` is set for: it costs a process scan, so
   * it is built only once a wait is actually pending, and at most once per
   * change-coalescing window.
   *
   * **`ended` is answered here because only this window can.** An owned session
   * whose child has gone keeps its card — `host/sessions.ts` forgets one only
   * when a reader stops or dismisses it — and the exit is on the handle rather
   * than on the card the fold builds, so it is passed rather than derived. The
   * `exited` flag `host/session_io.ts` hands `toThread` is the same fact taking
   * the same route. Answered for every member rather than only the dead ones,
   * because `WaitMember.ended` is required: dropping this map is a compile
   * error rather than the hang it used to be.
   */
  private async board(): Promise<WaitBoard> {
    // One table for discovery and for its confidence: a failed or incomplete
    // read drops twins, and so does a record that could not be read. The wait
    // must know which, and `waitBoard` says.
    return waitBoard(
      ownedSessions(vscode.env.sessionId),
      await scanProcesses(),
      (pid) => ownedSession(pid)?.state.exit !== undefined
    );
  }

  /**
   * One message to one requester, and then the records are gone.
   *
   * Admission is `core/coordination/admit.ts`'s: the guards (no `force`; a
   * refusal is written onto the wait), the record, and the chain this settles
   * inside, so no verb send lands between a wake and the reports it releases.
   * `WAIT_TTL_MS` is derived to keep expiry inside the stale bound; what is
   * left is a requester too cold or too full to be told, a real failure
   * written onto the wait rather than hidden.
   */
  private deliver(resolution: WaitResolution): Promise<admit.WakeOutcome> {
    return admit.admit(
      { kind: 'wait', resolution, settle: (outcome) => this.settle(resolution, outcome) },
      this.admission,
      this.log
    );
  }

  private async settle(resolution: WaitResolution, outcome: admit.WakeOutcome): Promise<void> {
    const pid = resolution.requesterPid;
    if (outcome.kind === 'refused') {
      await this.markFailed(resolution, outcome.reason, outcome.handle);
      return;
    }
    if (outcome.kind === 'undelivered') {
      this.log(`wait for ${pid} not delivered, retrying: ${outcome.reason}`);
      return;
    }
    const carried = resolution.members.flatMap((member) => member.reports ?? []).length;
    this.log(
      `wait resolved for ${pid}: ${resolution.members.map((m) => `${m.pid} ${m.state}`).join(', ')}` +
        (carried === 0 ? '' : `, carrying ${carried} report${carried === 1 ? '' : 's'}`)
    );
    // **Released before the records go**, so a `dropWait` cannot orphan the very
    // reports this resolution failed to carry. One a refusal stopped stays on
    // disk and is `rescue`'s once its wait is gone.
    await admit.release(
      resolution.unattached,
      outcome.handle,
      `${pid}: too long for the convergence`,
      this.log
    );
    // **Only what the message actually carried.** A report the text did not
    // render is somebody's undelivered words, and deleting it here because its
    // wait happened to resolve is the silent loss this whole feature is shaped
    // to avoid — so what did not ride was released just above and the rest is
    // removed by id.
    await Promise.all(resolution.attached.map((report) => dropReport(report.id)));
    await Promise.all(resolution.waits.map((wait) => dropWait(wait.id)));
  }

  /** Marked rather than deleted, so the one party that cannot be told still
   *  leaves something a reader can see. `WaitRecord.failed` has the argument. */
  private async markFailed(
    resolution: WaitResolution,
    reason: string,
    handle: SessionHandle | undefined
  ): Promise<void> {
    this.log(`wait for ${resolution.requesterPid} not delivered: ${reason}`);
    // **Before the mark, and this ordering is the whole of S4.** A `failed`
    // record is never evaluated again — `WaitRecord.failed` says so — so a
    // report still parked behind one after this line would never move again.
    // The parent then pays the N wakes it pays today, which is the outcome this
    // feature exists to improve on and is still far better than silence.
    const held = [...resolution.attached, ...resolution.unattached];
    if (handle?.messages) {
      await admit.release(held, handle, `${resolution.requesterPid}: ${reason}`, this.log);
    } else if (held.length > 0) {
      // The one branch that can neither attach nor release: there is no pipe
      // here to put anything on, and there never will be for this session.
      // Said out loud and removed, rather than retried once a second for a day
      // — a structural impossibility does not become possible on the next pass.
      this.log(
        `wait for ${resolution.requesterPid}: ${held.length} report(s) lost — no pipe to release them on`
      );
      await Promise.all(held.map((report) => dropReport(report.id)));
    }
    const failed = { reason, at: Date.now() };
    const wrote = await Promise.all(resolution.waits.map((wait) => writeWait({ ...wait, failed })));
    // The mark is what stops the next pass making this same refusal again, so a
    // write that did not land is the loop above claiming not to exist. Said out
    // loud rather than assumed: `writeAtomicJson` answers `false` instead of
    // throwing, so without this the failure has no witness at all.
    if (wrote.some((ok) => !ok)) {
      this.log(
        `wait for ${resolution.requesterPid} could not be marked; it will be evaluated again`
      );
    }
  }

  /**
   * Reports whose wait is gone or refused, put back on the ordinary path.
   *
   * The gap this closes is narrow and real: a wait deleted between a park and
   * the pass that would have carried it, and a record marked `failed` by a
   * window that has since reloaded. Nothing else would ever look at those files
   * again, and `pruneReports` would remove them at a day with no witness.
   *
   * **A report whose requester this window does not own is left alone**, and
   * that is not the same as abandoning it: another window may own that session
   * and will run this same pass. Where *no* window owns it — a reload takes
   * every owned child with it — nothing here can tell the two apart, so the age
   * sweep ends it, exactly as `pruneWaits` ends the wait record beside it. That
   * is a real loss of words that would have been in the parent's transcript
   * under today's behaviour, and it is the price of the hold.
   */
  private async rescue(
    reports: readonly ParkedReport[],
    waits: readonly Parameters<typeof orphaned>[0]['waits'][number][]
  ): Promise<void> {
    if (reports.length === 0) {
      return;
    }
    const { release } = orphaned({
      waits,
      reports,
      owned: (pid) => Boolean(ownedSession(pid))
    });
    const byRequester = new Map<number, ParkedReport[]>();
    for (const report of release) {
      byRequester.set(report.requesterPid, [
        ...(byRequester.get(report.requesterPid) ?? []),
        report
      ]);
    }
    for (const [pid, held] of byRequester) {
      const handle = ownedSession(pid);
      if (!handle?.messages) {
        continue;
      }
      await admit.release(held, handle, `${pid}: its wait ended without carrying it`, this.log);
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.disposed = true;
  }
}
