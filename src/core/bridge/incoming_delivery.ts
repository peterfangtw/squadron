import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as incoming from '../incoming';
import type * as access from './access';
import type { LaunchTarget } from '../model';
import type { SessionAddr, Watched } from './model';
import { addrOf } from './route';
import { sameAddr, rootOfWatched, type SessionVerbs, type Started } from './session';
import type { ConversationRecord, MessageRecord } from './store';
import type { MessageState } from './message_state';
import * as words from './words';
import * as brands from '../brands';
import type { BrandId } from '../model';
import * as paths from '../paths';

export class IncomingDelivery {
  constructor(
    private readonly options: {
      messages: MessageState;
      verbs: SessionVerbs;
      board: () => readonly Watched[];
      stopped: () => boolean;
      clock: () => number;
    }
  ) {}

  /** Exact original-destination recovery runs outside the routing/start-reply chain. */
  async recover(conversation?: string, correlation?: string): Promise<void> {
    if (!this.options.verbs.incomingEvidence || this.options.stopped()) return;
    const pending = this.options.messages.records.flatMap((record) =>
      (record.messages ?? []).flatMap((message) => {
        if (
          (conversation && conversation !== record.id) ||
          (correlation && correlation !== message.correlation)
        )
          return [];
        const view = this.options.messages.access.snapshot(record.id, message.correlation);
        if (
          !view ||
          view.denial ||
          (view.access.state === 'active' && message.target !== undefined) ||
          view.access.execution === 'not-started' ||
          'denied' in view.admission
        )
          return [];
        const attempt = view.access.attempt;
        const receiver = view.access.receiver;
        const query: import('./model').IncomingEvidenceQuery | undefined = attempt
          ? { kind: 'attempt', attempt }
          : receiver
            ? {
                kind: 'delivery',
                delivery: {
                  version: 1,
                  receiver,
                  correlation: message.correlation,
                  admissionDigest: view.admission.digest
                }
              }
            : undefined;
        const host = attempt?.host ?? receiver?.host;
        return query && host ? [{ record, message, view, query, host }] : [];
      })
    );
    await Promise.all(
      pending.map(async ({ record, message, view, query, host }) => {
        const proof = await this.options.verbs
          .incomingEvidence?.(host, query)
          .catch(() => undefined);
        if (!proof || proof.query.kind === 'receiver') return;
        const result = await this.options.messages.access.resolve(this.expectIncoming(view), proof);
        if (result !== 'committed' && result !== 'unchanged') return;
        // Only this original still waiting to become the routing root can install it.
        if (
          query.kind === 'attempt' &&
          !message.target &&
          record.rootCorrelation === message.correlation
        ) {
          const watched = this.options
            .board()
            .find(
              (one) =>
                one.receiverIdentity && incoming.sameReceiver(one.receiverIdentity, proof.receiver)
            );
          if (!watched) return;
          message.target = addrOf(watched);
          record.root = { ...rootOfWatched(watched), remoteSpawned: true };
          record.state = 'live';
          if (record.held?.correlation === message.correlation) delete record.held;
          await this.options.messages.save(record);
        }
      })
    );
  }

  private expectIncoming(view: access.AccessProjection): access.AccessExpectation {
    return {
      conversation: view.conversation,
      correlation: view.correlation,
      generation: view.generation,
      revision: view.access.revision,
      digest: 'denied' in view.admission ? '' : view.admission.digest,
      ...(view.access.attempt ? { attemptId: view.access.attempt.attemptId } : {})
    };
  }

  async prepare(
    record: ConversationRecord,
    message: MessageRecord | undefined,
    addr: SessionAddr
  ): Promise<import('./model').IncomingDelivery | undefined | false> {
    if (!message?.incoming || 'denied' in message.incoming || !this.options.verbs.incomingEvidence)
      return undefined;
    const view = this.options.messages.access.snapshot(record.id, message.correlation);
    const candidate = this.options
      .board()
      .find(
        (one) => sameAddr(addrOf(one), addr) && one.session.windowId === addr.windowId
      )?.receiverIdentity;
    const proof =
      candidate &&
      (await this.options.verbs.incomingEvidence?.(candidate.host, {
        kind: 'receiver',
        receiver: candidate
      }));
    if (
      !view ||
      view.denial ||
      !proof ||
      !candidate ||
      !incoming.sameReceiver(candidate, proof.receiver)
    ) {
      await this.options.messages.access.close(
        record.id,
        message.correlation,
        'evidence-unavailable'
      );
      // The ordinary text path remains available when no file delivery can be promised.
      return undefined;
    }
    const result = await this.options.messages.access.intend(this.expectIncoming(view), candidate);
    if (result !== 'committed' && result !== 'unchanged') return false;
    return {
      version: 1,
      receiver: candidate,
      correlation: message.correlation,
      admissionDigest: message.incoming.digest
    };
  }

  /** `brand` is the receiving session's; absent is the launch default. */
  withIncoming(
    text: string,
    record: ConversationRecord,
    message: MessageRecord | undefined,
    brand: BrandId | undefined
  ): string {
    if (!message) return text;
    const admission = this.options.messages.access.snapshot(
      record.id,
      message.correlation
    )?.admission;
    return admission && !('denied' in admission)
      ? `${text}\n\n${words.incomingManifest(record.id, admission, paths.toolShell(brand ?? brands.DEFAULT_BRAND))}`
      : text;
  }

  async start(
    record: ConversationRecord,
    message: MessageRecord | undefined,
    input: Parameters<SessionVerbs['start']>[0]
  ): Promise<Started> {
    input = { ...input, prompt: this.withIncoming(input.prompt, record, message, input.brand) };
    if (!message?.incoming || 'denied' in message.incoming) return this.options.verbs.start(input);
    let view = this.options.messages.access.snapshot(record.id, message.correlation);
    if (
      !view ||
      view.denial ||
      !view.holder ||
      (view.access.attempt && view.access.execution !== 'not-started')
    )
      return {
        ok: false,
        reason: 'Incoming startup evidence is unavailable or already pending.',
        unsure: true
      };
    const models = await this.options.verbs.models?.(input.windowId);
    const capability = incoming.readIncomingAccess(models?.incomingAccess);
    const cwd = await fs.realpath(input.cwd).catch(() => undefined);
    if (!capability || !cwd)
      return {
        ok: false,
        reason: 'That window cannot start a session with incoming files.',
        notStarted: true
      };
    const target: LaunchTarget =
      input.selection === undefined
        ? input.brand === undefined
          ? (models?.remoteSelection?.defaultTarget ?? {})
          : { brand: input.brand }
        : { brand: input.brand, model: input.model, window: input.window, effort: input.effort };
    const attempt = incoming.readLaunchAttempt({
      version: 1,
      attemptId: crypto.randomUUID(),
      conversation: record.id,
      messageId: message.id,
      correlation: message.correlation,
      admissionDigest: message.incoming.digest,
      host: capability.host,
      cwd,
      target,
      selection: input.selection ?? 'default',
      holder: view.holder,
      createdAt: this.options.clock()
    });
    if (!attempt)
      return { ok: false, reason: 'Incoming launch selection is invalid.', notStarted: true };
    const committed = await this.options.messages.access.begin(this.expectIncoming(view), attempt);
    if (committed !== 'committed')
      return { ok: false, reason: 'Incoming launch could not be committed.', unsure: true };
    view = this.options.messages.access.snapshot(record.id, message.correlation);
    if (!view || view.denial || view.access.attempt?.attemptId !== attempt.attemptId)
      return { ok: false, reason: 'Incoming launch was withdrawn.', notStarted: true };
    const started = await this.options.verbs.start({
      ...input,
      cwd,
      ...target,
      selection: attempt.selection,
      incomingStart: {
        version: 1,
        expectedHost: capability.host,
        localRoot: capability.localRoot,
        attempt,
        prompt: input.prompt
      }
    });
    if (started.ok && started.remoteLaunchEvidence && started.sessionId) {
      const current = this.options.messages.access.snapshot(record.id, message.correlation);
      if (current)
        await this.options.messages.access.resolve(this.expectIncoming(current), {
          version: 1,
          challenge: attempt.attemptId,
          host: attempt.host,
          query: { kind: 'attempt', attempt },
          receiver: started.remoteLaunchEvidence.receiver,
          currentSessionId: started.sessionId,
          launch: started.remoteLaunchEvidence
        });
    }
    if (!started.ok && started.notStarted) {
      const current = this.options.messages.access.snapshot(record.id, message.correlation);
      if (current) await this.options.messages.access.notStarted(this.expectIncoming(current));
    }
    return started;
  }
}
