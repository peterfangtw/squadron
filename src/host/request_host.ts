import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { brandForStart, offeredModels, refusal } from '../core/adapter';
import { BRANDS } from '../core/brands';
import type { Started } from '../core/bridge/bridge';
import * as words from '../core/bridge/words';
import { windowTokens } from '../core/catalog';
import { readActions, serializeSends, writeAction } from '../core/coordination/actions';
import { checkVerbAnswer, openQuestion } from '../core/coordination/answer';
import { lineageAlive, readLineage } from '../core/coordination/lineage';
import {
  ParkedReport,
  dropReport,
  parkFor,
  readReports,
  releaseAuthor,
  writeReport
} from '../core/coordination/reports';
import { MALFORMED, Reply, Request } from '../core/coordination/requests';
import * as origin from '../core/coordination/origin';
import * as route from '../core/coordination/route';
import { checkVerbSend, wrapMessage } from '../core/coordination/send';
import type { RemoteFilesStart } from '../core/coordination/serve_owned';
import {
  RemoteStart,
  ServePort,
  isClassifiedOwned,
  serveClassifiedOwned,
  serveOwned
} from '../core/coordination/serve_owned';
import { checkVerbSpawn, resolveSpawnIdentity } from '../core/coordination/spawn';
import { readWaits } from '../core/coordination/wait';
import * as incoming from '../core/incoming';
import type { LaunchTarget } from '../core/model';
import { sameSessionStart } from '../core/model';
import * as listings from '../core/model_listing';
import { defaultPick, modelEfforts } from '../core/model_names';
import * as ownedIncoming from '../core/owned_incoming';
import { incomingHolderNow, readHolder } from '../core/remote/holder';
import { serveAttach, type AttachPort } from '../core/remote/serve_attach';
import { serveFetchFile } from '../core/remote/serve_fetch';
import { scanProcesses } from '../core/scan';
import { ReadWorkflow, armWorkflow, cannotRunHere } from '../core/workflows/workflows';
import { OverviewPanel } from './panel';
import type { RemoteHost } from './remote';
import {
  deliverIncoming,
  endSession,
  isEnding,
  ownedHostIdentity,
  ownedIncomingEvidence,
  ownedSession,
  ownedTarget,
  parentIdentity,
  setWarm,
  startOwned,
  stateName
} from './sessions';

type AcceptedReply = Reply & { afterAdmission?: () => Promise<void> };

export type RequestHost = {
  serve: (request: Request) => Promise<Reply>;
  startRemote: (start: RemoteStart) => Promise<Started>;
  remoteModels: () => Promise<listings.RemoteModels>;
  startFiles: (start: RemoteFilesStart) => Promise<Reply>;
  noteHeldReports: () => Promise<void>;
};

export function createRequestHost({
  getRemote,
  getAttaching,
  log
}: {
  getRemote: () => RemoteHost | undefined;
  getAttaching: () => AttachPort | undefined;
  log: (line: string) => void;
}): RequestHost {
  /**
   * This window's handles and starts, as `serveOwned` takes them. A start from
   * Remote is a person's, like `+`: the default pick, or the stated brand on its
   * account default, and no `requestId`, so no lineage.
   */
  const incomingStarts = new ownedIncoming.IncomingLaunches();
  const ownedPort: ServePort = {
    incomingStarts,
    owned: ownedSession,
    end: endSession,
    ending: isEnding,
    start: startRemote,
    incomingAccess: ownedHostIdentity,
    evidence: ownedIncomingEvidence,
    deliverIncoming,
    startFiles: launchRemoteFiles,
    currentIncomingHolder: () => getRemote()?.incomingHolder(),
    incomingHolder: () => incomingHolderNow(vscode.env.sessionId, getRemote()?.incomingHolder()),
    holder: async () => readHolder(await scanProcesses())
  };

  return { serve, startRemote, remoteModels, startFiles, noteHeldReports };

  /** checkVerbSpawn owns the decision. Supply its setting and machine readings here. */
  async function checkSpawn(prompt: string, cwd: string): Promise<Reply | undefined> {
    let cwdIsDirectory: boolean | undefined;
    try {
      cwdIsDirectory = (await fs.stat(cwd)).isDirectory();
    } catch {
      cwdIsDirectory = undefined;
    }

    // Read machine-wide lineage: a memory-only cap is evaded by another window or reload.
    const entries = [...(await readLineage()).entries()];
    let spawns: { spawnedAt: number; alive: boolean }[] = [];
    if (entries.length > 0) {
      const { starts } = await scanProcesses();
      spawns = entries.map(([pid, entry]) => ({
        spawnedAt: entry.spawnedAt,
        alive: lineageAlive(pid, entry, starts.get(pid))
      }));
    }

    const decided = checkVerbSpawn({
      enabled: vscode.workspace
        .getConfiguration('squadron')
        .get<boolean>('orchestrators.enabled', false),
      prompt,
      cwdIsDirectory,
      cwd,
      spawns,
      now: Date.now()
    });
    return decided.ok ? undefined : { ok: false, reason: decided.reason };
  }

  /**
   * Whether this report was held against an open wait instead of delivered.
   *
   * The window half of `PRD_shipped_wait_report_attachment.md`. A fan-out with a
   * wait open costs its parent N+1 wakes — measured 2026-08-26, four wakes for
   * two children — because the children still report and the convergence is an
   * *extra* message on top. Held here, the same words arrive on the convergence
   * and the parent is woken once.
   *
   * **Nothing is refused and nothing is dropped.** A5: the "redundant" report in
   * that run carried a correction to the parent's own brief, so a window may not
   * judge which report is worth keeping. Every path below either holds the
   * message or sends it.
   *
   * **The cap releases rather than truncating.** At `REPORTS_PER_MEMBER` the
   * member's held reports go out in the order they were accepted, and this one
   * follows them — so a report that hits the cap can never overtake the ones it
   * might be correcting.
   *
   * Degradation is always "send it normally": an unreadable store, a park that
   * would not write, a sender that cannot be placed. `false` is the answer for
   * every one of them, and it is today's behaviour exactly.
   */
  async function holdForWait(
    request: Extract<Request, { kind: 'send' }>,
    decided: { text: string; payload: string; from: string },
    messages: NonNullable<ReturnType<typeof ownedSession>>['messages']
  ): Promise<boolean> {
    if (!messages) {
      return false;
    }
    // `decided.from` and not `request.from`: `checkVerbSend` has just settled who
    // the sender is, and its rule is that the wrapper's own author wins over the
    // field beside it when the two disagree. Checking one and storing the other
    // would let a hand-written request pass as A and park under B's name — the
    // wrong-author failure the wrapper exists to prevent, reached sideways.
    const fromPid = trustedSender(request.fromPid, decided.from);
    if (fromPid === undefined) {
      return false;
    }
    try {
      const [held, waits] = await Promise.all([readReports(), readWaits()]);
      const verdict = parkFor({
        waits,
        reports: held,
        toPid: request.pid,
        fromPid,
        now: Date.now()
      });
      if (verdict === undefined) {
        return false;
      }
      if (verdict.kind === 'release') {
        await flush(verdict.reports, messages);
        log(
          `wait ${verdict.wait.id}: ${fromPid} reached its cap; released ${verdict.reports.length}`
        );
        return false;
      }
      const wrote = await writeReport({
        schema: 1,
        id: randomUUID(),
        waitId: verdict.wait.id,
        requesterPid: request.pid,
        senderPid: fromPid,
        senderSessionId: decided.from,
        payload: decided.payload,
        at: Date.now()
      });
      if (!wrote) {
        // **Degrading must not reorder.** This send is about to go out now, so
        // anything this member already has parked has to go out ahead of it —
        // otherwise a full disk turns the fourth report into the first one the
        // parent reads, which is exactly the inversion the cap rule and
        // `compose`'s stop-at-first-misfit both exist to prevent, arrived at from
        // the disk-failure side.
        //
        // Caught here rather than below: a throw out of the flush would otherwise
        // land in the outer `catch`, whose whole excuse for not reordering is
        // that it cannot know what is parked — and on this path it does know.
        // Partway through is the best available answer, since what it managed to
        // send is already ahead of this message and what it did not still rides
        // the convergence.
        try {
          await flush(
            held.filter((one) => one.waitId === verdict.wait.id && one.senderPid === fromPid),
            messages
          );
        } catch (err) {
          log(
            `could not flush held reports for ${request.pid}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return wrote;
    } catch (err) {
      // A store this window cannot read is a feature that does not apply, not a
      // send that fails. The message goes out the way it always did.
      //
      // Nothing is flushed here, and nothing can be: the only throws that reach
      // this line come from reading the store, so this window does not know what
      // is parked and has nothing to put ahead of the send. (A throw out of a
      // flush is caught where it happens, above, precisely because *there* the
      // answer is known.) The same failure stops the resolver reading them too,
      // so they are released by `rescue` once the store recovers, or swept at a
      // day if it does not.
      log(
        `could not hold a report for ${request.pid}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * Held reports put on this session's pipe now, oldest first, and forgotten.
   *
   * Both callers are degradations — the member hit its cap, or the store would
   * not take another one — and both have the same obligation: whatever is already
   * parked goes out **ahead** of the send that triggered them. Order is the whole
   * point. A correction read before the thing it corrects is worse than either of
   * them arriving alone.
   *
   * Wrapped from the raw payload under each report's own author, which is why the
   * store keeps it raw: a stored *wrapped* text embedded in a convergence would
   * have been refused by `checkSend`'s own forgery guard.
   */
  async function flush(
    reports: readonly ParkedReport[],
    messages: NonNullable<NonNullable<ReturnType<typeof ownedSession>>['messages']>
  ): Promise<void> {
    for (const report of [...reports].sort((a, b) => a.at - b.at)) {
      await messages.send(
        wrapMessage(report.payload, releaseAuthor(report)),
        [],
        report.payload,
        false
      );
      await dropReport(report.id);
    }
  }

  /**
   * Check a sender this window drives against its in-memory sessionId, avoiding
   * a process scan on the send path. The shim already resolves the board's pid.
   * A cross-window sender is trusted like from: forging fromPid can only hold
   * the message, not bypass guards or deliver it somewhere otherwise refused.
   */
  function trustedSender(
    fromPid: number | undefined,
    from: string | undefined
  ): number | undefined {
    if (fromPid === undefined) {
      return undefined;
    }
    const claimed = ownedSession(fromPid);
    if (claimed && claimed.state.sessionId !== from) {
      return undefined;
    }
    return fromPid;
  }

  async function serve(request: Request): Promise<Reply> {
    const classified = origin.classifyRequest(request);
    if (!classified) return { ok: false, reason: MALFORMED };
    if (classified.policy === 'agent-answer' || classified.policy === 'agent-send') {
      const request = classified.request;
      const accepted = await serializeSends(() => serveRequest(classified));
      await accepted.afterAdmission?.();
      const { afterAdmission, ...reply } = accepted;
      const owned = ownedSession(request.pid);
      const messageFacts =
        owned && sameSessionStart(owned.state.startedAt, request.startedAt)
          ? owned.state.messageFacts
          : undefined;
      return { ...reply, ...(messageFacts === undefined ? {} : { messageFacts }) };
    }
    const reply = await serveRequest(classified);
    return classified.request.kind === 'open'
      ? {
          ...reply,
          startupVersion: 1,
          attemptId: classified.request.id,
          ...(!reply.ok && !reply.unsure ? { notStarted: true } : {})
        }
      : reply;
  }

  /** A start from Remote, here or served for the holder, with the brand it
   *  resolved to: no stated brand and no default pick is Claude, as `+`. */
  async function startRemote(start: RemoteStart): Promise<Started> {
    const models =
      start.selection === undefined ? { brands: [], models: [] } : (await remoteModels()).models;
    const resolved = listings.remoteTarget(start, models, remoteDefault);
    if (!resolved.ok) return resolved;
    const target = resolved.target;
    if (
      start.selection !== undefined &&
      !vscode.workspace.workspaceFolders?.some(
        (folder) => path.resolve(folder.uri.fsPath) === path.resolve(start.cwd)
      )
    ) {
      return {
        ok: false,
        reason: 'That folder is no longer open in this window.',
        notStarted: true,
        selectionInvalid: true
      };
    }
    try {
      return await startOwned({
        cwd: start.cwd,
        prompt: start.prompt,
        ...(start.correlation === undefined ? {} : { correlation: start.correlation }),
        name: start.name,
        ...(target === undefined ? {} : { target })
      });
    } catch (error) {
      return { ok: false, reason: String(error), unsure: true };
    }
  }

  async function launchRemoteFiles(start: RemoteFilesStart): Promise<Reply> {
    const models = await remoteModels();
    const selected: RemoteStart = {
      ...start.attempt.target,
      cwd: start.attempt.cwd,
      selection: start.attempt.selection
    };
    const resolved = listings.remoteTarget(selected, models.models, remoteDefault);
    if (!resolved.ok) return resolved;
    const target = resolved.target;
    const folders = await Promise.all(
      (vscode.workspace.workspaceFolders ?? []).map((folder) =>
        fs.realpath(folder.uri.fsPath).catch(() => undefined)
      )
    );
    if (!folders.includes(start.attempt.cwd))
      return {
        ok: false,
        reason: 'That folder is no longer open in this window.',
        notStarted: true,
        selectionInvalid: true
      };
    const admitted = async (): Promise<boolean> => {
      const capability = await ownedHostIdentity();
      const holder = await ownedPort.incomingHolder?.();
      return (
        !!capability &&
        incoming.sameHost(capability.host, start.expectedHost) &&
        capability.localRoot === start.localRoot &&
        !!holder?.incoming &&
        incoming.sameHost(holder.incoming.host, start.attempt.holder.host) &&
        holder.incoming.generation === start.attempt.holder.generation
      );
    };
    if (!(await admitted()))
      return { ok: false, reason: 'Incoming destination or holder changed.', notStarted: true };
    try {
      return await startOwned({
        cwd: start.attempt.cwd,
        target,
        incoming: { files: start, admitted }
      });
    } catch (error) {
      return { ok: false, reason: String(error), unsure: true };
    }
  }

  async function remoteModels(): Promise<listings.RemoteModels> {
    const models = await OverviewPanel.modelListing();
    const config = vscode.workspace.getConfiguration('squadron');
    return {
      models,
      incomingAccess: await ownedHostIdentity(),
      remoteSelection: {
        defaultTarget: listings.listingDefault(
          models,
          config.get<string>('model', '').trim(),
          windowTokens(config.get<unknown>('contextWindow'))
        )
      }
    };
  }

  /**
   * The panel's default pick, read here because a phone job may arrive with no
   * panel open (R5). The open panel's offered rows when it has them; otherwise
   * every brand's catalog, which places the setting's brand all the same.
   */
  function remoteDefault(): LaunchTarget | undefined {
    const config = vscode.workspace.getConfiguration('squadron');
    const listed = OverviewPanel.listedModels();
    const models = listed.length > 0 ? listed : offeredModels(BRANDS.map((brand) => ({ brand })));
    return defaultPick(
      models,
      config.get<string>('model', '').trim(),
      windowTokens(config.get<unknown>('contextWindow')),
      modelEfforts(config.get<unknown>('efforts'))
    );
  }

  async function serveRequest(classified: origin.ClassifiedRequest): Promise<AcceptedReply> {
    // Before any pid lookup: the holder almost never drives the session an
    // attachment names, and that lookup would answer "does not drive" for it.
    if (classified.policy === 'fetch') {
      return serveFetchFile(classified.request, getRemote());
    }
    if (classified.policy === 'attach') {
      const attaching = getAttaching();
      return attaching
        ? serveAttach(classified.request, attaching)
        : { ok: false, reason: words.OFF_HERE };
    }
    if (isClassifiedOwned(classified)) {
      return serveClassifiedOwned(classified, ownedPort);
    }
    const { request } = classified;
    if (request.kind === 'models') {
      return { ok: true, ...(await remoteModels()) };
    }
    if (request.kind === 'open') {
      // A bare open is the panel's own button and stays ungated. A prompt-carrying
      // one is an agent starting work by itself, which is the thing behind the
      // flag — and the thing whose cwd and text nobody has looked at.
      if (classified.policy === 'agent-spawn') {
        const request = classified.request;
        const refusal = await checkSpawn(request.prompt, request.cwd);
        if (refusal) {
          log(`spawn refused: ${request.cwd} — ${refusal.reason ?? ''}`);
          return refusal;
        }
        const asked = brandForStart(request.brand);
        if (!asked.ok) return { ...asked, cause: 'pick' };
        const identity = resolveSpawnIdentity(
          {
            brand: asked.brand,
            model: request.model,
            window: request.window,
            effort: request.effort
          },
          parentIdentity(request.parentSessionId),
          OverviewPanel.listedModels()
        );
        if (!identity.ok) {
          log(`spawn refused: ${request.cwd} — ${identity.reason}`);
          return { ok: false, reason: identity.reason, cause: 'pick' };
        }
        // Arm before the child exists so a refusal costs no session, and after
        // the identity, whose brand decides which skill folders count.
        // Treat an empty flag as absent, as resolveOrigin does for --parent-session-id "".
        let workflow: ReadWorkflow | undefined;
        if (request.workflowId) {
          const armed = await armWorkflow(request.workflowId, request.cwd, identity.brand);
          if ('refused' in armed) {
            log(`spawn refused: ${request.cwd} — ${armed.refused}`);
            return { ok: false, reason: armed.refused };
          }
          workflow = armed.workflow;
        }
        log(
          `spawn: ${request.cwd}${request.parentSessionId ? ` (from ${request.parentSessionId})` : ''}`
        );
        // Record even without a parent: omitting parentSessionId must not evade
        // the cap. startOwned keys the record by the child's pid.
        // Always pass model (empty = account default) so the gear cannot rebrand it.
        return await startOwned({
          cwd: request.cwd,
          prompt: request.prompt,
          ...(request.correlation === undefined ? {} : { correlation: request.correlation }),
          name: request.name,
          parentSessionId: request.parentSessionId,
          originSessionId: request.originSessionId,
          from: request.from,
          requestId: request.id,
          ticketRef: request.ticketRef,
          workflow,
          // Forward every target field: accepting it on the wire must not drop it at launch.
          target: {
            brand: identity.brand,
            model: identity.model ?? '',
            ...(identity.window === undefined ? {} : { window: identity.window }),
            ...(identity.effort === undefined ? {} : { effort: identity.effort })
          }
        });
      }
      // A bare open, or the same thing carrying on a conversation that already
      // exists. Ungated either way: `resume` names a transcript this machine
      // already holds, so there is no prose here that nobody has looked at.
      //
      // A workflow reaching here is refused rather than dropped: the field is on
      // the whole `open` body, and a run needs a turn to ride — the briefing has
      // to arrive in the message that gives the session its work.
      if (request.workflowId) {
        return {
          ok: false,
          reason: cannotRunHere(request.workflowId, [
            'a start with no prompt has no turn to run it on'
          ])
        };
      }
      // The pick the requester stated, forwarded rather than dropped. It used to
      // fall through to `squadron.model` at this end — a machine-wide setting
      // both processes read, so both agreed by accident. No start path reads it
      // any more (`TASK_done_draft_new_session.md` Step 8), so a request that
      // stated a pick and was dropped here would run on the account default.
      //
      // `squadron-spawn` is the poster that states one. Since row 71 it is the
      // only poster in this repo — the panel's cross-window resume was the other
      // — and it is why `resume` and `effort` arrive unset in practice without
      // being unreachable (`core/coordination/requests.ts` says why they stay).
      //
      // An older requester sends neither `brand` nor `model`; `startOwned` folds
      // that the same way as `''` — the account default, which is what every
      // start did before any of this.
      const asked = brandForStart(request.brand);
      if (!asked.ok) return { ...asked, cause: 'pick' };
      return await startOwned({
        cwd: request.cwd,
        resume: request.resume,
        name: request.name,
        // Absence keeps startOwned's account default; future named brands were refused above.
        target: {
          ...(asked.brand === undefined ? {} : { brand: asked.brand }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.window === undefined ? {} : { window: request.window }),
          ...(request.effort === undefined ? {} : { effort: request.effort })
        }
      });
    }

    // A session this window drives over a pipe, for the kinds that read a setting
    // or the actions store. Every other pid-carrying kind, and any this build
    // does not know, is `serveOwned`'s.
    const owned = ownedSession(request.pid);
    if (owned) {
      if (!sameSessionStart(owned.state.startedAt, request.startedAt)) {
        return { ok: false, reason: 'That session is no longer there.' };
      }
      if (request.kind === 'send') {
        if (!owned.messages) {
          return { ok: false, reason: refusal('messages') };
        }
        // The window's own reading of the target, not the shim's: a shim that
        // read a stale published record must not get a cold wake past this.
        const target = ownedTarget(request.pid);
        if (!target) {
          return { ok: false, reason: 'That session is no longer there.' };
        }
        const decided = checkVerbSend({
          enabled: vscode.workspace
            .getConfiguration('squadron')
            .get<boolean>('orchestrators.enabled', false),
          from: request.from,
          windowId: vscode.env.sessionId,
          target,
          text: request.text,
          now: Date.now(),
          actions: await readActions(),
          force: request.force
        });
        if (!decided.ok) {
          return { ok: false, reason: decided.reason };
        }
        if (ownedSession(request.pid) !== owned) {
          return { ok: false, reason: 'That session is no longer there.' };
        }
        // Park after guards and before delivery, retaining the actions record.
        // Interrupt bypasses parking because breaking in is not filing a report.
        // Test the boolean itself: parked !== undefined would swallow false
        // without delivering or storing the message.
        const parked =
          request.interrupt !== true && (await holdForWait(request, decided, owned.messages));
        if (parked) {
          // Parking is acceptance and counts against the same window burst cap
          // as delivery. Await the record for the ordering reason on writeAction below.
          await writeAction({
            schema: 1,
            kind: 'send',
            windowId: vscode.env.sessionId,
            from: decided.from,
            toPid: request.pid,
            toSessionId: owned.state.sessionId,
            at: Date.now(),
            requestId: request.id
          });
          return { ok: true, queued: owned.state.queued.length, heldForWait: request.pid };
        }
        if (ownedSession(request.pid) !== owned) {
          return { ok: false, reason: 'That session is no longer there.' };
        }
        // `describe` is the payload, so what names the session is the message
        // rather than the tag around it: `firstPrompt` feeds the CLI's titler,
        // and a title is persisted into the transcript for every window and every
        // `/resume` to read. It is also what the held outbox row and the
        // in-flight bubble draw before the transcript catches up.
        const routed = route.routeTo({ owned });
        if (route.isRefused(routed) || !routed.messages) {
          return { ok: false, reason: refusal('messages') };
        }
        const sent = await routed.messages.send(
          decided.text,
          [],
          decided.payload,
          request.interrupt === true,
          undefined,
          request.correlation
        );
        if (!sent.ok) return sent;
        // Awaited, and before the interrupt: the send above is the accept, and a
        // record written after something that can reject or hang is a record the
        // counters do not have when the next request of the same tick reads them.
        await writeAction({
          schema: 1,
          kind: 'send',
          windowId: vscode.env.sessionId,
          from: decided.from,
          toPid: request.pid,
          toSessionId: owned.state.sessionId,
          at: Date.now(),
          requestId: request.id
        });
        // Ahead, then `sendNow`: the latch is what makes the interrupt and the
        // delivery one act. Interrupt-then-`send` is the race `sendNow` exists to
        // close — the interrupt's own idle edge drains whatever was already held,
        // and the payload lands a turn later.
        //
        // Swallowed on purpose. The message is enqueued either way; the interrupt
        // only decides *when* it is read. A rejection travelling out of here would
        // be written as `{ ok: false }`, and an agent told "refused" retries —
        // which is a second copy of a message already at the head of the outbox.
        const accepted: AcceptedReply = sent;
        const messages = owned.messages;
        if (request.interrupt) {
          accepted.afterAdmission = async () => {
            if (ownedSession(request.pid) === owned) await messages.sendNow().catch(() => {});
            // Capture can still hold an outgoing row after send-now returns.
            if (sent.queued !== 0) accepted.queued = owned.state.queued.length;
          };
        }
        return accepted;
      } else if (request.kind === 'answer') {
        if (!owned.messages) {
          return { ok: false, reason: refusal('messages') };
        }
        const target = ownedTarget(request.pid);
        if (!target) {
          return { ok: false, reason: 'That session is no longer there.' };
        }
        const decided = checkVerbAnswer({
          enabled: vscode.workspace
            .getConfiguration('squadron')
            .get<boolean>('orchestrators.enabled', false),
          from: request.from,
          windowId: vscode.env.sessionId,
          target,
          text: request.text,
          now: Date.now(),
          actions: await readActions(),
          force: request.force,
          pending: owned.state.pending,
          askId: request.askId
        });
        if (!decided.ok) {
          return { ok: false, reason: decided.reason };
        }
        // Again after the await, and again before the interrupt: the person may
        // answer on the dialog while this window awaits, and an interrupt then
        // cuts the turn their answer started. Closed by the second check, the
        // answer stays an ordinary held message the idle edge delivers.
        // **Accepted:** an interrupt that rejects leaves the prose held too, and
        // it drains after the person answers, saying a dialog was closed that
        // was not — the failure `send --interrupt` swallows the same way.
        const stillOpen = (): boolean =>
          ownedSession(request.pid) === owned &&
          openQuestion(owned.state.pending, request.askId).ok;
        if (!stillOpen()) {
          return { ok: false, reason: 'That question is no longer open.' };
        }
        // `send --interrupt`'s path, in its order and for its reasons: ahead,
        // the record, then `sendNow`, whose rejection is swallowed as send's is.
        await owned.messages.send(
          decided.text,
          [],
          decided.payload,
          true,
          undefined,
          request.correlation
        );
        await writeAction({
          schema: 1,
          kind: 'answer',
          windowId: vscode.env.sessionId,
          from: decided.from,
          toPid: request.pid,
          toSessionId: owned.state.sessionId,
          askId: request.askId,
          at: Date.now(),
          requestId: request.id
        });
        const messages = owned.messages;
        return {
          ok: true,
          afterAdmission: async () => {
            if (stillOpen()) await messages.sendNow().catch(() => {});
          }
        };
      }
      if (request.kind === 'warm') {
        // setWarm refuses a handle without the warm capability itself.
        return await setWarm(request.pid, request.on);
      }
      // No capability gate: stateName writes our name before asking a CLI
      // that supports it, so this window can rename every brand. It refuses blanks.
      return await stateName(request.pid, request.title);
    }
    // A stale poll or a departed window's record can route here without a pipe.
    // This window cannot drive a session it does not hold.
    return { ok: false, reason: 'This window does not drive that session.' };
  }

  /**
   * A log line for the reports this window is about to abandon, and nothing more.
   *
   * **Releasing them here was tried and does not work**, and the reason is
   * measured rather than argued. `messages.send` does not write to the pipe: it
   * enqueues and calls `tryDrain`, which defers the write behind
   * `TurnCheckpoints.open` — a `git add -A` and `write-tree`, 43 ms warm and
   * 566 ms cold — and the deferred half returns immediately if the session has
   * since closed. `closeAll` sets that flag synchronously, so a send from here
   * enqueues into a session that is killed before the write ever happens.
   * `sendNow` is no escape: it ends in the same `tryDrain`.
   *
   * Awaiting the capture instead would put a `git write-tree` per owned session
   * inside `deactivate`, which the host time-boxes — and would still only help if
   * the CLI persisted the turn in the milliseconds before its pipe closed, which
   * nothing here has measured. The trade is bad in both directions.
   *
   * So a reload loses these, exactly as a crash does. What this buys is the
   * witness: the count is on the record rather than the files simply ageing out
   * of `reports/` a day later with nothing anywhere saying they existed. Dropping
   * them here would be worse than leaving them — it would delete words that were
   * never delivered, and leave nothing to find.
   */
  async function noteHeldReports(): Promise<void> {
    try {
      const mine = (await readReports()).filter((report) => ownedSession(report.requesterPid));
      if (mine.length > 0) {
        log(
          `leaving ${mine.length} held report(s) undelivered: this window is going and ` +
            'their requesters go with it'
        );
      }
    } catch {
      // A window on its way out has nobody to report to.
    }
  }
  function startFiles(start: RemoteFilesStart): Promise<Reply> {
    return serveOwned(
      {
        ...start,
        kind: 'remoteStartFilesV1',
        origin: 'remote',
        windowId: vscode.env.sessionId,
        id: randomUUID(),
        createdAt: Date.now()
      },
      ownedPort
    );
  }
}
