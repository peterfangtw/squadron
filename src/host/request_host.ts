import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { brandForStart, offeredModels } from '../core/adapter';
import { BRANDS } from '../core/brands';
import type { Started } from '../core/bridge/bridge';
import * as words from '../core/bridge/words';
import { windowTokens } from '../core/catalog';
import * as admit from '../core/coordination/admit';
import { lineageAlive, readLineage } from '../core/coordination/lineage';
import { readReports } from '../core/coordination/reports';
import { launchTargetOf } from '../core/coordination/request_codec';
import { MALFORMED, Reply, Request } from '../core/coordination/requests';
import * as origin from '../core/coordination/origin';
import type { RemoteFilesStart } from '../core/coordination/serve_owned';
import {
  RemoteStart,
  ServePort,
  isClassifiedOwned,
  serveClassifiedOwned,
  serveOwned
} from '../core/coordination/serve_owned';
import { checkVerbSpawn, resolveSpawnIdentity } from '../core/coordination/spawn';
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
import { startReply } from '../core/start_outcome';
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
  const admission: admit.AdmissionPort = {
    owned: ownedSession,
    target: ownedTarget,
    windowId: vscode.env.sessionId,
    orchestrators: () =>
      vscode.workspace.getConfiguration('squadron').get<boolean>('orchestrators.enabled', false)
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

  async function serve(request: Request): Promise<Reply> {
    const classified = origin.classifyRequest(request);
    if (!classified) return { ok: false, reason: MALFORMED };
    if (classified.policy === 'agent-send') {
      return admit.admit({ kind: 'send', request: classified.request }, admission, log);
    }
    if (classified.policy === 'agent-answer') {
      return admit.admit({ kind: 'answer', request: classified.request }, admission, log);
    }
    const reply = await serveRequest(classified);
    return classified.request.kind === 'open'
      ? { ...startReply(reply), attemptId: classified.request.id }
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
        outcome: 'stopped',
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
      return { ok: false, reason: String(error), outcome: 'unknown' };
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
        outcome: 'stopped',
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
      return { ok: false, reason: 'Incoming destination or holder changed.', outcome: 'stopped' };
    try {
      return await startOwned({
        cwd: start.attempt.cwd,
        target,
        incoming: { files: start, admitted }
      });
    } catch (error) {
      return { ok: false, reason: String(error), outcome: 'unknown' };
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

  async function serveRequest(
    classified: Exclude<origin.ClassifiedRequest, { policy: 'agent-send' | 'agent-answer' }>
  ): Promise<Reply> {
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
        const picked = openTarget(request);
        if (!picked.ok) return { ...picked, cause: 'pick' };
        const identity = resolveSpawnIdentity(
          picked.target,
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
      const picked = openTarget(request);
      if (!picked.ok) return { ...picked, cause: 'pick' };
      return await startOwned({
        cwd: request.cwd,
        resume: request.resume,
        name: request.name,
        target: picked.target
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

/** The flat fields of an open request, as the target a start runs on. */
function openTarget(request: {
  brand?: string;
  model?: string;
  window?: number;
  effort?: string;
}): { ok: true; target: LaunchTarget } | { ok: false; reason: string } {
  const asked = brandForStart(request.brand);
  if (!asked.ok) return asked;
  const target = launchTargetOf({
    brand: asked.brand,
    model: request.model,
    window: request.window,
    effort: request.effort
  });
  return target ? { ok: true, target } : { ok: false, reason: MALFORMED };
}
