/**
 * The coffee: sleep-lock leases, kept while this machine is working.
 *
 * Owns the leases and effects; core/reconcile.ts owns scheduling; the lock
 * itself and the battery reading are `platform.power`'s. Every rule
 * it applies lives in `core/awake.ts`, where it can be tested. This file is
 * delivery and wiring, as `src/AGENTS.md` asks of everything under `host/`.
 *
 * **Nothing polls, and nothing is ever poured away.** Session changes and
 * refill deadlines ask whether to pour:
 *
 * - the registered refill deadline, set for `REFILL_MARGIN_MS` before expiry
 *   — still working, drink another; nothing working, let it wear off
 * - registration change notices, routed by `host/extension.ts` whenever an owned
 *   session changes state, starting a hold when the cup is empty or nearly so
 *
 * **A session going idle releases nothing.** An earlier build killed the child
 * the moment the last `busy` session stopped, and it was wrong twice: the cup
 * emptied and refilled on every gap between turns, and each edge cost a spawn, a
 * battery read and a record write that every window's panel repaints on. A lease is
 * ten minutes of a machine not sleeping — cheap — and letting it wear off on its
 * own is both quieter and the same guarantee, since its length bounds it.
 * Only an explicit `off` and `dispose()` put the cup down early — they kill
 * every child this window started, including one still overlapping a refill.
 *
 * With no coffee and no session activity, nothing here runs at all.
 *
 * **This is not the panel's business.** It lives in `activate()` beside the
 * window claimant because a closed panel must still keep the machine awake.
 *
 * Read `docs/reference/macos_power.md` before changing the lease: a hold ends at
 * its length or at this host's exit, whichever is first, and each covers a
 * failure the other does not.
 */
import * as vscode from 'vscode';
import * as reconcile from '../core/reconcile';
import {
  AwakeDeadlines,
  AwakeReason,
  LEASE_MS,
  REFILL_MARGIN_MS,
  clearHold,
  decide,
  leaseWanted,
  writeHold
} from '../core/awake';
import type { Session } from '../core/model';
import * as platform from '../core/platform';
import type { Lease, Reading } from '../core/platform/power';
import { isStartSource } from '../core/platform/processes';
import { runsCommand, scanProcesses } from '../core/scan';
import { sessionBrand } from '../core/brands';
import * as warm from '../core/warm';
import { ownedSessions } from './sessions';

/** The setting that governs the cup and the coffee together. */
const SETTING = 'squadron.cafe.enabled';
/** Whether Remote, in the window holding it, keeps the machine up with nothing
 *  working. Under `SETTING`: off there, this has nothing to hold. */
const REMOTE_SETTING = 'squadron.cafe.remote';
/** Whether a session with Warm on keeps the machine up with nothing working.
 *  Under `SETTING`, as Remote's is. */
const WARM_SETTING = 'squadron.cafe.warm';

/**
 * Coalesce changes from the first frame, without postponing on later frames.
 *
 * `onOwnedChange` fires per frame; a one-second window limits repeated checks
 * during streaming while starting a hold promptly. Refill deadlines and explicit
 * startup/configuration checks run independently of this delay.
 */
const CHANGE_DEBOUNCE_MS = 1_000;

export class KeepAwake implements vscode.Disposable {
  /**
   * The live lease — the coffee itself. A refill leaves the previous one in
   * `prior` until it lapses.
   *
   * **Not a child session.** "Child" is lineage everywhere else in this repo
   * (`core/coordination/lineage.ts`, who spawned whom), and nothing here is about that. There
   * is no per-session branching in this file at all: `ownedSessions()` goes to
   * `decide()` whole, and a session this window spawned counts exactly as one
   * someone started by hand.
   */
  private child: Lease | undefined;
  /** Previous leases still holding until they lapse. `off` and `dispose` kill these
   *  too, or a leftover minute of assertion survives the reader turning the
   *  café off. */
  private prior: Lease[] = [];
  private disposed = false;
  /** When the coffee currently in hand wears off. The one number a refill is
   *  conditional on: above `REFILL_MARGIN_MS` left, every trigger is a no-op. */
  private holding: number | undefined;
  /** The lease in hand was poured for Remote and/or Warm, with no session
   *  working: the one `leaseWanted` cuts rather than letting run out. */
  private optional = false;
  /** Whether there is a record of ours on disk to clear. Without it, every
   *  frame on a non-mac — or with the setting off — pays an `fs.rm`. */
  private wrote = false;
  /** The reason the last written record gives, so an unchanged one is not
   *  rewritten per frame. A record that then ages out of `HOLD_STALE_MS` is not
   *  replaced, and the cup falls back to reading `idle` — which is true, if less
   *  specific than the `battery` it stops saying. */
  private said: AwakeReason | undefined;
  /** Every write to our record, in the order it was asked for. Two
   *  `writeAtomicJson` calls to one path rename in whatever order the
   *  filesystem likes, so a `stop` overtaking a `drink` would leave disk saying
   *  idle while a lease is really held. Same fix, and the same reason, as
   *  `core/published.ts`'s own chain. */
  private writes: Promise<void> = Promise.resolve();
  /** The last verdict's reason, written down or not. */
  private last: AwakeReason | undefined;
  /** The refill and the battery's recheck, on the registration's one
   *  deadline. */
  private readonly deadlines = new AwakeDeadlines();

  readonly registration: reconcile.CheckRegistration;

  /**
   * `remoteOn` says whether this window holds Remote right now. Only the holder
   * window holds for it; whoever moves the switch asks for a check.
   */
  constructor(
    runtime: reconcile.Reconciler,
    private readonly remoteOn: () => boolean,
    private readonly log: (line: string) => void = () => {}
  ) {
    this.registration = runtime.register('keep-awake check', CHANGE_DEBOUNCE_MS, () => this.once());
  }

  /** Why the machine is or is not being held, as of the last check. Undefined
   *  before the first. */
  get reason(): AwakeReason | undefined {
    return this.last;
  }

  /** Queue one write, never letting a rejection break the chain. */
  private inOrder(step: () => Promise<void>): void {
    this.writes = this.writes.then(step, step);
  }

  /** The flag, read per call rather than watched — the rule `panel.ts` follows
   *  for every other setting, so the native checkbox and a panel toggle both
   *  land here without a subscription of their own. */
  private get enabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(SETTING, true);
  }

  /** Remote holds the machine here: this window holds Remote, and the reader
   *  has not turned the Remote hold off. */
  private get remoteHolds(): boolean {
    return this.remoteOn() && this.holdsForRemote;
  }

  /** The Remote hold's setting alone, read per call like `enabled`. Remote's
   *  view asks it, so a warning says what the reader chose rather than
   *  inferring it from a verdict a check has not caught up with. */
  get holdsForRemote(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(REMOTE_SETTING, true);
  }

  /** The pids with Warm on, or none with the Warm hold's setting off. The
   *  setting is read per call like `enabled`; the rest is one registry read —
   *  no spawn, no file. */
  private warmPids(): number[] {
    if (!vscode.workspace.getConfiguration().get<boolean>(WARM_SETTING, true)) return [];
    return warm.warmOn(ownedSessions(vscode.env.sessionId));
  }

  /**
   * One look at the machine.
   *
   * **The order here is a cost decision, and it is the whole reason `decide` is
   * called twice.** Registration change notices arrive per frame, so this runs
   * every `CHANGE_DEBOUNCE_MS` for the length of a streaming turn.
   * `platform.power.read` spawns its reader on every call and
   * caches nothing, so reading it first meant hundreds of process spawns per
   * turn to answer a question only the pour path ever asks.
   *
   * So: decide once with no power reading at all. Every arm that refuses —
   * `unsupported`, `off`, `idle`, `stale` — is answered by that call, and the
   * common case by far is a turn whose coffee is already poured, which the cheap
   * out below returns on without touching the OS. Past it, the one OS read is
   * the shared `ps` that `owned` needs, cached for a second across every reader.
   * Only once we are actually about to pour does the battery matter, and only
   * then is it read.
   */
  private async once(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.deadlines.served(Date.now());
    const enabled = this.enabled;
    // The reads that cost anything are skipped entirely when the feature is off,
    // rather than gathered and then discarded by `decide`. Support first, since
    // it is the deeper answer — the same order `decide` states. Answered with
    // no read and no spawn.
    const holds = platform.power.holds.supported;
    if (!holds) {
      this.release('unsupported');
      return;
    }
    if (!enabled) {
      this.release('off');
      return;
    }

    // **The coffee in hand is still good, whatever the sessions are doing.**
    // Checked before `decide` and before any session is read, because this is by
    // far the commonest call: change notices arrive per frame, so a streaming
    // turn arrives here once a second for minutes, and for all
    // but the last minute of a lease the answer is "nothing to do".
    //
    // It is also what makes a session going idle cost nothing at all. The set of
    // sessions being held for is deliberately not part of this test — the record
    // names who was working when it was poured, and re-pouring to keep that list
    // current would spend a spawn and a machine-wide repaint on a caption.
    // Except a lease nothing asks for any more (`leaseWanted`): that one falls
    // through to the verdict, which re-pours for a session that went busy under
    // it — the old child left on `prior`, so the assertions overlap — or cuts it.
    // Warm is read only for an optional lease: any other is wanted regardless,
    // and this runs once a second through a streaming turn.
    const optionalHolds = this.optional && (this.remoteHolds || this.warmPids().length > 0);
    const wanted = leaseWanted({ optional: this.optional }, optionalHolds);
    if (
      wanted &&
      this.child &&
      this.holding !== undefined &&
      this.holding - Date.now() > REFILL_MARGIN_MS
    ) {
      return;
    }

    // **A window holds only for its own sessions.** Counting what other windows
    // publish is the obvious design and is redundant: a window with owned
    // sessions has a live extension host by definition and is already holding
    // for them, and the setting is `scope: application`, so there is no
    // divergence to cover. It also made release *late*, since window A gets no
    // `onOwnedChange` when B's session goes idle and would release only at its
    // own refill timer. Dropping it costs coverage only during a version skew
    // mid-upgrade. The cup merges every window's record through `readHolds`
    // either way.
    //
    // Absent power is `decide`'s "no opinion", which is exactly what is wanted
    // here: it is the answer a desktop with no battery gives, so the arms that
    // do not depend on power all resolve the same as they would with a reading.
    const dry = decide({
      sessions: await owned(),
      power: undefined,
      now: Date.now(),
      enabled,
      holds,
      remote: this.remoteHolds,
      warm: this.warmPids()
    });
    if (this.disposed) {
      return;
    }
    if (!dry.drink) {
      this.registration.schedule(this.deadlines.recheck(undefined));
      this.decline(dry.reason, wanted);
      return;
    }

    // Committed to pouring, so now the battery gets a vote. Sessions are re-read
    // after the await, so one that started or stopped during the read is seen
    // as it is now — this second verdict, not the dry one, is what the record
    // is written from. A failed read is no opinion, as a desktop's is.
    const read = await platform.power.read();
    const power = read.supported && read.status === 'ok' ? read.value : undefined;
    const sessions = await owned();
    if (this.disposed) {
      return;
    }
    const verdict = decide({
      sessions,
      power,
      now: Date.now(),
      enabled,
      holds,
      remote: this.remoteHolds,
      warm: this.warmPids()
    });
    if (!verdict.drink) {
      // The refill deadline's path, with nothing in hand to refill: the next
      // look at the power while Remote or Warm waits on the machine.
      this.registration.schedule(this.deadlines.recheck(verdict.recheckAt));
      this.decline(verdict.reason, wanted);
      return;
    }
    this.drink(verdict.sessions, verdict.reason, power, verdict.remote, verdict.warmSessions);
  }

  /**
   * Pour a fresh one. The old one is left holding until it lapses.
   *
   * Releasing it was the gap: starting a lease is not holding one, and
   * `previous.kill()` dropped the only assertion before the new child had
   * taken one. Observed
   * 2026-08-23: refill at 02:46:34, `[System: No Assertions]`, idle sleep 5s
   * later. Two assertions stack for `REFILL_MARGIN_MS`; the old child is kept
   * on `prior` and exits on its own. `forget` ignores that exit because the
   * handle is already the fresh one's. `off` and `dispose()` kill `prior` too.
   */
  private drink(
    sessions: number[],
    reason: AwakeReason,
    power: Reading | undefined,
    remote: true | undefined,
    warmSessions: number[] | undefined
  ): void {
    const fresh = platform.power.hold(LEASE_MS, process.pid);
    if ('supported' in fresh) {
      // Unreachable while `once` refuses on `holds` first; nothing was started.
      this.log(`keep-awake not held: ${fresh.reason}`);
      this.release('unsupported');
      return;
    }
    this.last = reason;
    const previous = this.child;
    if (previous) {
      this.prior.push(previous);
    }
    this.child = fresh;
    // A child that cannot be spawned at all must not leave a record claiming a
    // hold nothing is holding.
    //
    // Two things this has to get right. **Identity**: a late `error` from a
    // child already replaced must not drop the handle to the live one, which
    // would leave that one running past `stop()` and `dispose()`. **Order**: the
    // clear goes through the same chain as the write below, or the `fs.rm` for a
    // missing lock tool overtakes the write it is undoing and leaves a record
    // claiming a full lease that nothing will ever clear.
    fresh.onFailed((reason) => {
      this.log(reason);
      this.forget(fresh);
    });
    // **The moment the cup is actually empty**, and the only one: the lease ran out
    // with nobody working, so the assertion is gone and the record on disk now
    // claims a hold that does not exist. Nothing else clears it — a session
    // going idle no longer does — so without this the cup would read as full
    // until `HOLD_STALE_MS` swept the file a minute after the lease.
    //
    // A replaced lease's end reaches here too. `forget` ignores that: the
    // handle is already the fresh one's, and the live coffee is its.
    fresh.onEnded(() => {
      this.prior = this.prior.filter((child) => child !== fresh);
      if (this.child === fresh) {
        this.log('keep-awake wore off');
      }
      this.forget(fresh);
    });
    const until = Date.now() + LEASE_MS;
    // The only line that says a pour happened. Without it the sole evidence is
    // the OS's assertion list, which has to be caught while the lease is held.
    // This is what makes the hand-check in the task file readable.
    this.log(
      `keep-awake ${previous ? 'refilled' : 'poured'}: pid ${sessions.join(', ')}${remote ? ' (Remote)' : ''}${warmSessions?.length ? ' (Warm)' : ''}`
    );

    this.holding = until;
    this.optional = (!!remote || !!warmSessions?.length) && sessions.length === 0;
    this.said = undefined;
    this.deadlines.recheck(undefined);
    this.registration.schedule(this.deadlines.refill(until - REFILL_MARGIN_MS));
    this.inOrder(async () => {
      await writeHold({
        windowId: vscode.env.sessionId,
        until,
        sessions,
        reason,
        ...(remote ? { remote } : {}),
        ...(warmSessions?.length ? { warmSessions } : {}),
        power,
        writtenAt: Date.now()
      });
      this.wrote = true;
    });
  }

  /**
   * Don't pour, and don't touch what is already poured.
   *
   * **This is the whole of "the session stopped working".** No kill, no timer
   * change, and for `idle` not a single byte written: the lease that is already
   * in hand keeps the machine up for its remaining minutes and then wears off by
   * itself. The cup drains as the clock says, which is honest — the machine
   * really is held for that long — and a session that goes busy again inside the
   * lease costs nothing at all.
   *
   * A future refill deadline is left unchanged: at `REFILL_MARGIN_MS` before
   * expiry it asks whether anything is working. If that deadline already fired,
   * it stays consumed; declining a refill here does not rearm it.
   *
   * **A record is written only for what the panel could not work out itself.**
   * `battery` and `stale` are those two — both mean the machine is busy and
   * being refused anyway, which is the one thing a reader most needs told — and
   * only once no coffee is in hand, because a live lease's own record says
   * something truer. `idle` writes nothing: an absent record already means that,
   * and `panel.ts` reads it so. That write is not free either, landing under
   * `STATE_DIR`, which every window's panel watches.
   */
  private lapse(reason: AwakeReason): void {
    this.last = reason;
    if (reason !== 'battery' && reason !== 'stale') {
      return;
    }
    if (this.child) {
      return;
    }
    // Nothing to say that has not already been said: the last record already
    // reads empty with this same reason, so rewriting it every frame would be
    // the write storm this file exists to avoid.
    if (this.wrote && this.said === reason) {
      return;
    }
    this.said = reason;
    this.inOrder(async () => {
      await writeHold({
        windowId: vscode.env.sessionId,
        until: 0,
        sessions: [],
        reason,
        writtenAt: Date.now()
      });
      this.wrote = true;
    });
  }

  /** No pour: a lease still wanted runs out on its own, and one that is not
   *  is cut now. Released first, so the record that follows is written with
   *  nothing in hand. */
  private decline(reason: AwakeReason, wanted: boolean): void {
    if (!wanted) this.release(reason);
    this.lapse(reason);
  }

  /**
   * Put the cup down now, whatever is left in it.
   *
   * The two reasons that are not about sessions at all: the setting turned off,
   * and an OS with no lock to have poured in the first place. Both
   * mean there should be no cup and no hold this instant, rather than at the end
   * of a lease the reader has just said they did not want.
   */
  private release(reason: AwakeReason): void {
    this.last = reason;
    this.deadlines.recheck(undefined);
    this.registration.schedule(this.deadlines.refill(undefined));
    this.holding = undefined;
    this.optional = false;
    const held = !!this.child || this.prior.length > 0;
    for (const child of this.prior) {
      child.release();
    }
    this.prior = [];
    if (this.child) {
      this.child.release();
      this.child = undefined;
    }
    if (held) {
      this.log(`keep-awake released: ${reason}`);
    }
    this.said = undefined;
    // Nothing of ours on disk means nothing to remove. Without this guard a
    // machine that is not a mac pays an `fs.rm` on every frame of every session
    // it runs, for a file it has never once written.
    if (!this.wrote) {
      return;
    }
    this.inOrder(async () => {
      await clearHold(vscode.env.sessionId);
      this.wrote = false;
    });
  }

  /**
   * This child is gone — it wore off, or it never started.
   *
   * **Identity first.** A late event from a child already replaced by a refill
   * must not drop the handle to the live one, which would leave that one running
   * past `release()` and `dispose()` and hold the machine with nothing tracking
   * it.
   *
   * The clear goes through the same chain as every write, or the `fs.rm` can
   * overtake the `writeHold` it is undoing and leave a record claiming a full
   * lease that nothing will ever clear.
   */
  private forget(child: Lease): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.holding = undefined;
    this.optional = false;
    // The refill goes with the lease; a battery recheck stays.
    this.registration.schedule(this.deadlines.refill(undefined));
    this.said = undefined;
    if (!this.wrote) {
      return;
    }
    this.inOrder(async () => {
      await clearHold(vscode.env.sessionId);
      this.wrote = false;
    });
  }

  dispose(): void {
    this.registration.dispose();
    this.disposed = true;
    this.holding = undefined;
    for (const child of this.prior) {
      child.release();
    }
    this.prior = [];
    this.child?.release();
    this.child = undefined;
    // Belt and braces: the hold on `process.pid` already releases the lock when this
    // host goes, including on every path where `dispose` is never called.
    // Through the chain, so it cannot be overtaken by a write still in flight
    // from the `drink` this dispose interrupted.
    this.inOrder(() => clearHold(vscode.env.sessionId));
  }
}

/**
 * This window's sessions, with `hasCommand` read off the process table.
 * `core/live.ts` writes `false` for every session it builds — the flag is on no
 * frame — so without this a backgrounded command never counts. One cached `ps`
 * serves both `decide` calls in `once`.
 *
 * A table that is not complete cannot say a session has no command, so its
 * sessions read as occupied: a hold kept a beat too long costs a lease
 * refill, and one dropped under a running command lets the machine sleep it.
 */
async function owned(): Promise<Session[]> {
  const table = await scanProcesses();
  const known = table.complete === true && isStartSource(table.startSource);
  return ownedSessions(vscode.env.sessionId).map((session) => ({
    ...session,
    hasCommand: known ? runsCommand(table, session.pid, sessionBrand(session.brand)) : true
  }));
}
