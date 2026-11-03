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
import { readActions, serializeSends, writeAction } from '../core/coordination/actions';
import { checkResolution, wrapMessage, wrapWait } from '../core/coordination/send';
import {
  WaitReport,
  WaitResolution,
  dropWait,
  nextDeadline,
  readWaits,
  resolveWaits,
  writeWait
} from '../core/coordination/wait';
import {
  ParkedReport,
  dropReport,
  orphaned,
  readReports,
  releaseAuthor
} from '../core/coordination/reports';
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
  readonly registration: reconcile.CheckRegistration;

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
    for (const resolution of resolved) {
      if (this.disposed) {
        return;
      }
      await this.deliver(resolution);
    }
    // Schedule from what remains: the earliest expiry or workflow recheck
    // sets this registration's next deadline.
    const pending = mine.filter((wait) => !gone.has(wait.id));
    const deadlines = [
      nextDeadline(pending, Date.now()),
      ...pending.map((wait) => workflowStates.get(wait.id)?.checkAt)
    ].filter((at): at is number => at !== undefined);
    this.registration.schedule(deadlines.length === 0 ? undefined : Math.min(...deadlines));
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
   * **A resolution obeys the send guards with no carve-out**, `force` aside:
   * the stale and context guards on the requester, and the window's burst
   * shared with verb sends. `WAIT_TTL_MS` is derived to keep expiry inside the
   * stale bound; what is left is a requester too cold or too full to be told,
   * a real failure written onto the wait rather than hidden.
   *
   * `from` is the **window's** `env.sessionId`, not any session's: nothing
   * composed this but this extension host. `core/coordination/actions.ts` has why that is
   * its own record kind.
   */
  private async deliver(resolution: WaitResolution): Promise<void> {
    return serializeSends(() => this.deliverNow(resolution));
  }

  private async deliverNow(resolution: WaitResolution): Promise<void> {
    const pid = resolution.requesterPid;
    const owned = ownedSession(pid);
    // A session with no `messages` capability is a refusal like any other, not
    // a silent return: §5.7's whole requirement is that a wait which could not
    // be delivered is visible rather than quiet.
    const carried = resolution.members.flatMap((member) => member.reports ?? []).length;
    const messages = owned?.messages;
    if (!messages) {
      await this.markFailed(resolution, 'that session cannot be sent to from here');
      return;
    }
    const refusal = await this.refused(resolution);
    if (refusal !== undefined) {
      await this.markFailed(resolution, refusal);
      return;
    }

    // `resolution.text` is the payload, so what names the turn is the message
    // rather than the tag around it — the same reason `serve` passes one.
    await messages.send(wrapWait(resolution.text), [], resolution.text, false);
    // Awaited, and after the send that is the accept: a record written later
    // than the next pass reads is a record the counters do not have.
    await writeAction({
      schema: 1,
      kind: 'wait',
      windowId: vscode.env.sessionId,
      from: vscode.env.sessionId,
      toPid: pid,
      toSessionId: owned.state.sessionId,
      at: Date.now()
    });
    this.log(
      `wait resolved for ${pid}: ${resolution.members.map((m) => `${m.pid} ${m.state}`).join(', ')}` +
        (carried === 0 ? '' : `, carrying ${carried} report${carried === 1 ? '' : 's'}`)
    );
    // **Released before the records go**, so a `dropWait` cannot orphan the very
    // reports this resolution failed to carry.
    await this.release(resolution.unattached, pid, messages, 'too long for the convergence');
    // **Only what the message actually carried.** A report the text did not
    // render is somebody's undelivered words, and deleting it here because its
    // wait happened to resolve is the silent loss this whole feature is shaped
    // to avoid — so what did not ride was released just above and the rest is
    // removed by id.
    await Promise.all(resolution.attached.map((report) => dropReport(report.id)));
    await Promise.all(resolution.waits.map((wait) => dropWait(wait.id)));
  }

  private async refused(resolution: WaitResolution): Promise<string | undefined> {
    const verdict = checkResolution({
      windowId: vscode.env.sessionId,
      target: ownedTarget(resolution.requesterPid),
      text: resolution.text,
      now: Date.now(),
      actions: await readActions()
    });
    return verdict.ok ? undefined : verdict.reason;
  }

  /** Marked rather than deleted, so the one party that cannot be told still
   *  leaves something a reader can see. `WaitRecord.failed` has the argument. */
  private async markFailed(resolution: WaitResolution, reason: string): Promise<void> {
    this.log(`wait for ${resolution.requesterPid} not delivered: ${reason}`);
    // **Before the mark, and this ordering is the whole of S4.** A `failed`
    // record is never evaluated again — `WaitRecord.failed` says so — so a
    // report still parked behind one after this line would never move again.
    // The parent then pays the N wakes it pays today, which is the outcome this
    // feature exists to improve on and is still far better than silence.
    const messages = ownedSession(resolution.requesterPid)?.messages;
    const held = [...resolution.attached, ...resolution.unattached];
    if (messages) {
      await this.release(held, resolution.requesterPid, messages, reason);
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
   * Held reports put on the pipe as ordinary messages, because no convergence
   * can carry them.
   *
   * **The guards are deliberately not re-run.** The stale and context refusals
   * are facts about the *requester*, so having just been refused for one, every
   * one of these would be refused for the same reason, and
   * `PRD_shipped_wait_report_attachment.md` S4's promise that they arrive as N
   * wakes could never be kept.
   *
   * What makes it legitimate rather than a hole: **the guards decide admission,
   * and admission already happened.** Each of these passed `checkVerbSend` at
   * send time and has an `actions/` record witnessing it — under today's
   * behaviour the words would already be on this session's pipe. Releasing
   * completes a delivery that was accepted; it does not make a new one. It is
   * bounded by `REPORTS_PER_MEMBER` times the members, and it is the only such
   * path in the feature.
   *
   * Wrapped here under each report's own sender, from the raw payload the store
   * keeps — which is why the store keeps it raw. A stored *wrapped* text
   * embedded in a convergence would have been refused by `checkSend`'s own
   * forgery guard.
   */
  private async release(
    reports: readonly WaitReport[],
    toPid: number,
    messages: NonNullable<ReturnType<typeof ownedSession>>['messages'],
    why: string
  ): Promise<void> {
    if (reports.length === 0 || !messages) {
      return;
    }
    // Oldest first, always. A correction read before the thing it corrects is
    // worse than either of them arriving alone.
    for (const report of [...reports].sort((a, b) => a.at - b.at)) {
      await messages.send(
        wrapMessage(report.payload, releaseAuthor(report)),
        [],
        report.payload,
        false
      );
      await dropReport(report.id);
    }
    this.log(`released ${reports.length} held report(s) to ${toPid}: ${why}`);
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
      const messages = ownedSession(pid)?.messages;
      if (!messages) {
        continue;
      }
      await this.release(held, pid, messages, 'its wait ended without carrying it');
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.disposed = true;
  }
}
