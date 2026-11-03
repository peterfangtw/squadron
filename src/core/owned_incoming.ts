import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as incoming from './incoming';
import * as platform from './platform';
import { isStartSource } from './platform/processes';
import * as scan from './scan';
import type { SessionHandle } from './adapter';
import { closeUnprompted, type SessionTransport } from './session';
import type { BrandId } from './model';
import type {
  HostIdentity,
  IncomingAccess,
  IncomingDelivery,
  IncomingDeliveryEvidence,
  IncomingEvidence,
  IncomingEvidenceQuery,
  LaunchAttempt,
  ReceiverIdentity,
  RemoteLaunchEvidence
} from './bridge/model';

/** One activation's observed identity. A failed initial scan cannot be upgraded later. */
export class IncomingHost {
  private readonly captured: Promise<HostIdentity | undefined>;
  constructor(windowId: string) {
    const incarnation = crypto.randomUUID();
    this.captured = scan.scanProcesses(true).then((table) => {
      const osStartedAt = table.starts.get(process.pid);
      return osStartedAt === undefined || !table.complete || !isStartSource(table.startSource)
        ? undefined
        : Object.freeze({
            version: 1,
            windowId,
            pid: process.pid,
            osStartedAt,
            startSource: table.startSource,
            incarnation
          });
    });
  }

  async capability(): Promise<IncomingAccess | undefined> {
    const host = await this.captured;
    const table = await scan.scanProcesses(true);
    if (
      !host ||
      !table.complete ||
      table.startSource !== host.startSource ||
      table.starts.get(host.pid) !== host.osStartedAt
    )
      return undefined;
    try {
      const localRoot = await platform.privateFiles.ensure();
      if (!localRoot.supported || localRoot.status !== 'ok') return undefined;
      return incoming.readIncomingAccess({ version: 1, host, localRoot: localRoot.value });
    } catch {
      return undefined;
    }
  }

  async evidence(
    owners: readonly OwnedIncoming[],
    challenge: string,
    query: IncomingEvidenceQuery,
    publish: (owner: OwnedIncoming) => Promise<boolean>
  ): Promise<IncomingEvidence | undefined> {
    const candidates = owners.filter((owner) => owner.matches(query));
    if (candidates.length !== 1) return undefined;
    const owner = candidates[0];
    return owner?.evidence(challenge, query, () => publish(owner));
  }

  async capture(
    transport: SessionTransport,
    session: SessionHandle,
    brand: BrandId,
    current: () => boolean
  ): Promise<OwnedIncoming | undefined> {
    const host = await this.captured;
    const table = await scan.scanProcesses(true);
    const pid = transport.pid;
    const osStartedAt = pid === undefined ? undefined : table.starts.get(pid);
    if (
      !host ||
      !table.complete ||
      table.startSource !== host.startSource ||
      pid === undefined ||
      osStartedAt === undefined ||
      table.starts.get(host.pid) !== host.osStartedAt ||
      table.parents.get(pid) !== host.pid ||
      !current() ||
      transport.processAlive?.() !== true ||
      session.state.exit
    )
      return undefined;
    try {
      const cwd = await fs.realpath(session.state.cwd);
      if (!current() || transport.processAlive?.() !== true || session.state.exit) return undefined;
      const receiver = incoming.readReceiverIdentity({
        version: 1,
        host,
        pid,
        osStartedAt,
        startSource: table.startSource,
        incarnation: crypto.randomUUID(),
        brand,
        cwd
      });
      return receiver ? new OwnedIncoming(receiver, transport, session, current) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Evidence belongs to the registry entry holding this native pipe, never to a session ID. */
export class OwnedIncoming {
  private launch: RemoteLaunchEvidence | undefined;
  private readonly deliveries = new Map<string, IncomingDeliveryEvidence>();
  private revision = 0;
  private publishedRevision = -1;
  private deliveryChain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly receiverIdentity: ReceiverIdentity,
    private readonly transport: SessionTransport,
    private readonly session: SessionHandle,
    private readonly current: () => boolean
  ) {
    session.onChange((state) => {
      for (const fact of state.messageFacts ?? []) {
        if (!fact.dismissed) continue;
        const receipt = this.deliveries.get(fact.correlation);
        if (receipt && !receipt.dismissed) {
          this.deliveries.set(fact.correlation, Object.freeze({ ...receipt, dismissed: true }));
          this.revision++;
        }
        if (this.launch?.attempt.correlation === fact.correlation && !this.launch.dismissed) {
          this.launch = Object.freeze({ ...this.launch, dismissed: true });
          this.revision++;
        }
      }
    });
  }

  matches(query: IncomingEvidenceQuery): boolean {
    return query.kind === 'attempt'
      ? !!this.launch && incoming.sameLaunchAttempt(this.launch.attempt, query.attempt)
      : incoming.sameReceiver(
          this.receiverIdentity,
          query.kind === 'receiver' ? query.receiver : query.delivery.receiver
        );
  }

  snapshot(): {
    receiverIdentity: ReceiverIdentity;
    remoteLaunchEvidence?: RemoteLaunchEvidence;
    incomingDeliveries: readonly IncomingDeliveryEvidence[];
  } {
    return {
      receiverIdentity: this.receiverIdentity,
      ...(this.launch ? { remoteLaunchEvidence: this.launch } : {}),
      incomingDeliveries: [...this.deliveries.values()]
    };
  }

  private held(): boolean {
    return this.current() && this.transport.processAlive?.() === true && !this.session.state.exit;
  }

  private async sameEntry(): Promise<boolean> {
    return (
      this.held() &&
      (await fs.realpath(this.session.state.cwd).catch(() => '')) === this.receiverIdentity.cwd &&
      this.held()
    );
  }

  private async publishRequired(publish: () => Promise<boolean>): Promise<boolean> {
    const revision = this.revision;
    const written = await publish();
    if (written) this.publishedRevision = Math.max(this.publishedRevision, revision);
    return written;
  }

  private async live(): Promise<boolean> {
    if (!this.held()) return false;
    const table = await ownershipTable();
    const receiver = this.receiverIdentity;
    return (
      table.complete === true &&
      table.startSource === receiver.startSource &&
      this.held() &&
      table.starts.get(receiver.pid) === receiver.osStartedAt &&
      table.starts.get(receiver.host.pid) === receiver.host.osStartedAt &&
      table.parents.get(receiver.pid) === receiver.host.pid &&
      (await fs.realpath(this.session.state.cwd).catch(() => '')) === receiver.cwd &&
      this.held()
    );
  }

  async start(
    attempt: LaunchAttempt,
    send: () => Promise<import('./coordination/route').Act>,
    publish: () => Promise<boolean>,
    admitted: () => Promise<boolean>
  ): Promise<{ ok: boolean; notStarted?: true; unsure?: true }> {
    if (this.launch) return { ok: false, unsure: true };
    if (
      !incoming.sameHost(attempt.host, this.receiverIdentity.host) ||
      attempt.cwd !== this.receiverIdentity.cwd ||
      (attempt.target.brand !== undefined &&
        attempt.target.brand !== this.receiverIdentity.brand) ||
      !(await this.live())
    ) {
      const exited = await closeUnprompted(this.transport);
      this.session.close();
      return exited ? { ok: false, notStarted: true } : { ok: false, unsure: true };
    }
    this.launch = Object.freeze({
      version: 1,
      attempt,
      receiver: this.receiverIdentity,
      marker: attempt.attemptId,
      stage: 'prepared'
    });
    this.revision++;
    if (
      !(await this.publishRequired(publish)) ||
      !(await admitted()) ||
      !(await this.sameEntry())
    ) {
      const exited = await closeUnprompted(this.transport);
      this.session.close();
      return exited ? { ok: false, notStarted: true } : { ok: false, unsure: true };
    }
    let result: import('./coordination/route').Act;
    try {
      result = await send();
    } catch {
      return { ok: false, unsure: true };
    }
    if (!result.ok) return { ok: false, unsure: true };
    this.launch = Object.freeze({
      ...this.launch,
      stage: 'accepted',
      ...(this.session.state.messageFacts?.some(
        (fact) => fact.correlation === attempt.correlation && fact.dismissed
      )
        ? { dismissed: true as const }
        : {})
    });
    if (!this.held()) return { ok: false, unsure: true };
    this.revision++;
    const written = await this.publishRequired(publish);
    return written && this.held() ? { ok: true } : { ok: false, unsure: true };
  }

  deliver(
    delivery: IncomingDelivery,
    outcome: 'send' | 'person-answer',
    send: () => Promise<import('./coordination/requests').Reply>,
    publish: () => Promise<boolean>
  ): Promise<import('./coordination/requests').Reply> {
    const next = this.deliveryChain.then(() => this.deliverOne(delivery, outcome, send, publish));
    this.deliveryChain = next.catch(() => undefined);
    return next;
  }

  private async deliverOne(
    delivery: IncomingDelivery,
    outcome: 'send' | 'person-answer',
    send: () => Promise<import('./coordination/requests').Reply>,
    publish: () => Promise<boolean>
  ): Promise<import('./coordination/requests').Reply> {
    if (!incoming.sameReceiver(delivery.receiver, this.receiverIdentity) || !(await this.live()))
      return {
        ok: false,
        reason: 'That receiving session is no longer owned.',
        incomingRefusal: 'wrong-receiver'
      };
    const prior = this.deliveries.get(delivery.correlation);
    if (prior) {
      if (prior.admissionDigest !== delivery.admissionDigest)
        return {
          ok: false,
          reason: 'Conflicting original delivery.',
          incomingRefusal: 'wrong-receiver'
        };
      return (await this.publishRequired(publish)) && this.held()
        ? { ok: true, incomingDelivery: prior }
        : { ok: false, unsure: true, reason: 'Delivery evidence could not be published.' };
    }
    const result: import('./coordination/requests').Reply = await send().catch(() => ({
      ok: false,
      unsure: true as const,
      reason: 'Delivery outcome unknown.'
    }));
    if (!result.ok) return result;
    const receipt: IncomingDeliveryEvidence = Object.freeze({
      ...delivery,
      outcome: outcome === 'person-answer' ? outcome : (result.queued ?? 0) > 0 ? 'queued' : 'send',
      acceptedAt: Date.now()
    });
    this.deliveries.set(
      delivery.correlation,
      this.session.state.messageFacts?.some(
        (fact) => fact.correlation === delivery.correlation && fact.dismissed
      )
        ? Object.freeze({ ...receipt, dismissed: true })
        : receipt
    );
    if (!this.held())
      return { ok: false, unsure: true, reason: 'The receiving session ended during delivery.' };
    this.revision++;
    if (!(await this.publishRequired(publish)) || !this.held())
      return { ok: false, unsure: true, reason: 'Delivery evidence could not be published.' };
    return { ...result, incomingDelivery: receipt };
  }

  async evidence(
    challenge: string,
    query: IncomingEvidenceQuery,
    publish: () => Promise<boolean>
  ): Promise<IncomingEvidence | undefined> {
    if (!incoming.incomingUuid(challenge) || !(await this.live())) return undefined;
    const launch =
      query.kind === 'attempt' &&
      this.launch &&
      incoming.sameLaunchAttempt(query.attempt, this.launch.attempt)
        ? this.launch
        : undefined;
    const delivery =
      query.kind === 'delivery' &&
      incoming.sameReceiver(query.delivery.receiver, this.receiverIdentity)
        ? this.deliveries.get(query.delivery.correlation)
        : undefined;
    if (
      query.kind === 'receiver'
        ? !incoming.sameReceiver(query.receiver, this.receiverIdentity)
        : query.kind === 'attempt'
          ? !launch
          : !delivery || delivery.admissionDigest !== query.delivery.admissionDigest
    )
      return undefined;
    // A lost accepted publication is retried on evidence demand, never by a launch timer.
    if (query.kind !== 'receiver' && this.publishedRevision !== this.revision)
      await this.publishRequired(publish);
    if (
      (query.kind !== 'receiver' && this.publishedRevision !== this.revision) ||
      !(await this.sameEntry()) ||
      (launch && launch !== this.launch) ||
      (delivery && delivery !== this.deliveries.get(delivery.correlation))
    )
      return undefined;
    return incoming.readIncomingEvidence({
      version: 1,
      challenge,
      host: this.receiverIdentity.host,
      query,
      receiver: this.receiverIdentity,
      currentSessionId: this.session.state.sessionId,
      ...(launch ? { launch } : {}),
      ...(delivery ? { delivery } : {})
    });
  }
}

/** Original launch reservations last for this activation; silence never releases one. */
export class IncomingLaunches {
  private readonly attempts = new Map<
    string,
    { digest: string; result: Promise<import('./coordination/requests').Reply> }
  >();
  run(
    start: import('./coordination/serve_owned').RemoteFilesStart,
    create: () => Promise<import('./coordination/requests').Reply>
  ): Promise<import('./coordination/requests').Reply> {
    const attempt = incoming.readLaunchAttempt(start.attempt);
    const host = incoming.readHostIdentity(start.expectedHost);
    if (!attempt || !host || !incoming.sameHost(attempt.host, host))
      return Promise.resolve({
        ok: false,
        reason: 'Invalid incoming launch request.',
        notStarted: true
      });
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify([attempt, host, start.localRoot, start.prompt]))
      .digest('hex');
    const prior = this.attempts.get(start.attempt.attemptId);
    if (prior)
      return prior.digest === digest
        ? prior.result
        : Promise.resolve({
            ok: false,
            reason: 'Conflicting original launch request.',
            unsure: true
          });
    const result = Promise.resolve()
      .then(create)
      .catch(() => ({
        ok: false,
        reason: 'Incoming startup outcome unknown.',
        unsure: true as const
      }));
    this.attempts.set(start.attempt.attemptId, { digest, result });
    return result;
  }
}

let inFlight: Promise<scan.ProcessTable> | undefined;
function ownershipTable(): Promise<scan.ProcessTable> {
  if (inFlight) return inFlight;
  const table = scan.scanProcesses(true);
  inFlight = table;
  void table.then(() => {
    if (inFlight === table) inFlight = undefined;
  });
  return table;
}
