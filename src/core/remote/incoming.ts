import { performance } from 'perf_hooks';
import * as codec from '../incoming';
import * as cache from './incoming_cache';
import type { Bridge, SessionVerbs } from '../bridge/bridge';
import type { AccessProjection } from '../bridge/access';
import type { Messenger } from '../bridge/port';
import type {
  FetchFileIdentity,
  FetchFileReply,
  IncomingAccess,
  IncomingAdmission,
  IncomingEvidence,
  IncomingEvidenceQuery,
  IncomingFile,
  IncomingRefusal
} from '../bridge/model';

const BUDGET_MS = 45_000;
type Checked = { view: AccessProjection; admission: IncomingAdmission; file: IncomingFile };
type Authorized = Checked & { capability: IncomingAccess };
type Operation = {
  identity: FetchFileIdentity;
  generation: number;
  abort: AbortController;
  reason?: IncomingRefusal;
  wake: () => void;
  waitingForEvidence: boolean;
  deadline: number;
  settled: Promise<void>;
  settle(): void;
};

/** Holder-scoped fetch policy, composed by RemoteSwitch. */
export class IncomingFiles {
  private readonly requests = new Set<Operation>();
  private readonly evidence = new Map<string, Promise<IncomingEvidence | undefined>>();
  private readonly capabilities = new Map<string, Promise<IncomingAccess | undefined>>();
  private readonly bytes = new cache.IncomingCache();
  private disposed = false;

  constructor(
    private readonly options: {
      bridge: Bridge;
      verbs: SessionVerbs;
      messenger: Messenger;
      onEvidenceChanged: (listener: () => void) => () => void;
      currentHolder?: () => Promise<boolean>;
    }
  ) {}

  async fetch(request: {
    requestId: string;
    identity: FetchFileIdentity;
    signal?: AbortSignal;
  }): Promise<FetchFileReply> {
    const base = { version: 1 as const, requestId: request.requestId, identity: request.identity };
    const refuse = (code: IncomingRefusal): FetchFileReply => ({ ...base, kind: 'refused', code });
    const identity = codec.readFetchFileIdentity(request.identity);
    if (!identity || !codec.incomingUuid(request.requestId)) return refuse('unsupported-version');
    const first = this.check(identity);
    if (typeof first === 'string') return refuse(first);
    if (
      this.requests.size >= 40 ||
      [...this.requests].filter((one) =>
        codec.sameReceiver(one.identity.receiver, identity.receiver)
      ).length >= 10
    )
      return refuse('capacity');
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const operation: Operation = {
      identity,
      generation: first.view.generation,
      abort: new AbortController(),
      wake: () => {},
      waitingForEvidence: true,
      deadline: performance.now() + BUDGET_MS,
      settled,
      settle
    };
    this.requests.add(operation);
    let revision = 0;
    let wake: (() => void) | undefined;
    operation.wake = () => {
      revision++;
      wake?.();
      wake = undefined;
    };
    const invalidate = () => {
      const current = this.check(identity, operation.generation);
      if (typeof current === 'string') this.abort(operation, current);
      operation.wake();
    };
    const unsubscribe = this.options.bridge.onIncomingChanged(invalidate);
    const unwatch = this.options.onEvidenceChanged(operation.wake);
    const uncache = this.bytes.onChanged(operation.wake);
    const cancelled = () => this.abort(operation, 'closed');
    request.signal?.addEventListener('abort', cancelled, { once: true });
    if (request.signal?.aborted) cancelled();
    const timer = setTimeout(() => this.abort(operation, 'timeout'), BUDGET_MS);
    let reservation: cache.Reservation | undefined;
    let work: Promise<cache.CachedFile> | undefined;
    let published = false;
    try {
      invalidate();
      for (;;) {
        this.alive(operation);
        const observed = revision;
        const authorized = await this.bounded(this.authorize(operation), operation);
        this.alive(operation);
        if (!authorized) {
          operation.waitingForEvidence = true;
          if (revision === observed)
            await this.bounded(
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              operation
            );
          continue;
        }
        operation.waitingForEvidence = false;
        const provider = this.options.messenger.incomingFiles;
        if (!provider) throw new cache.CacheRefusal('unsupported-capability');
        // Source verification is provider-owned; opaque source text is never a URL here.
        if (
          !(await this.bounded(provider.verify(authorized.file, operation.abort.signal), operation))
        )
          throw new cache.CacheRefusal('wrong-install');
        this.current(operation);
        const hit = await this.bounded(
          this.bytes.find(
            authorized.capability,
            authorized.admission,
            authorized.file,
            identity.receiver
          ),
          operation
        );
        if (hit) {
          if (!(await this.bounded(this.authorize(operation), operation)))
            throw new cache.CacheRefusal('evidence-unavailable');
          const renewed = await this.bounded(
            this.bytes.renew(
              authorized.capability,
              hit,
              operation.abort.signal,
              () => typeof this.check(identity, operation.generation) !== 'string'
            ),
            operation
          );
          this.current(operation);
          return {
            ...base,
            kind: 'fetched',
            ...renewed,
            cacheKey: authorized.file.cacheKey,
            localRoot: authorized.capability.localRoot
          };
        }
        const reserved = await this.bounded(
          this.bytes
            .reserve(
              authorized.capability,
              authorized.admission,
              authorized.file,
              identity.receiver
            )
            .then((value) => {
              // A local reserve may finish after abort; retain it for the finally cleanup.
              reservation = value;
              if (value && operation.abort.signal.aborted) void this.bytes.release(value);
              return value;
            }),
          operation
        );
        if (!reserved) {
          if (revision === observed)
            await this.bounded(
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              operation
            );
          continue;
        }
        this.current(operation);
        work = this.download(operation, authorized, reserved);
        const content = await this.bounded(work, operation);
        published = true;
        if (!(await this.bounded(this.authorize(operation), operation)))
          throw new cache.CacheRefusal('evidence-unavailable');
        await this.bounded(this.bytes.validate(authorized.capability, content), operation);
        this.current(operation);
        return {
          ...base,
          kind: 'fetched',
          ...content,
          cacheKey: authorized.file.cacheKey,
          localRoot: authorized.capability.localRoot
        };
      }
    } catch (error) {
      if (operation.reason === 'timeout' && operation.waitingForEvidence)
        return { ...base, kind: 'pending', retryable: true };
      const reason = operation.reason ?? this.refusal(error);
      this.abort(operation, reason);
      return refuse(reason);
    } finally {
      clearTimeout(timer);
      unsubscribe();
      unwatch();
      uncache();
      request.signal?.removeEventListener('abort', cancelled);
      wake = undefined;
      operation.abort.abort();
      if (reservation) {
        await this.bytes.release(reservation);
        if (published && operation.reason) await this.bytes.discard(reservation);
      }
      // Providers may ignore abort. They cannot publish, and late chunks close/remove their own partial.
      if (work)
        void work
          .finally(async () => {
            if (reservation) {
              await this.bytes.release(reservation);
              if (operation.reason) await this.bytes.discard(reservation);
            }
          })
          .catch(() => {});
      this.requests.delete(operation);
      if (!this.requests.size) {
        this.evidence.clear();
        this.capabilities.clear();
      }
      operation.settle();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.evidence.clear();
    this.capabilities.clear();
    for (const operation of this.requests) this.abort(operation, 'remote-off');
    await Promise.all([...this.requests].map((operation) => operation.settled));
    await this.bytes.drain();
  }

  async sweep(capability: IncomingAccess): Promise<void> {
    if (!this.disposed && (await this.holderCurrent())) await this.bytes.sweep(capability);
  }

  private async holderCurrent(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.options.currentHolder && !(await this.options.currentHolder())) {
      void this.dispose();
      return false;
    }
    return !this.disposed;
  }

  private check(identity: FetchFileIdentity, generation?: number): Checked | IncomingRefusal {
    if (this.disposed) return 'remote-off';
    const holder = this.options.bridge.incomingHolder();
    if (
      !holder ||
      !codec.sameHost(holder.host, identity.holder.host) ||
      holder.generation !== identity.holder.generation
    )
      return 'remote-off';
    const view = this.options.bridge.accessSnapshot(identity.conversation, identity.correlation);
    if (!view) return 'unknown-message';
    if (view.denial) return view.denial;
    if (generation !== undefined && view.generation !== generation) return 'remote-off';
    if ('denied' in view.admission) return 'admission-denied';
    const admission = view.admission;
    const file = admission.files.find((file) => file.id === identity.fileId);
    if (!file) return 'unknown-file';
    if (view.access.state === 'closed') return view.access.reason ?? 'closed';
    if (view.access.receiver && !codec.sameReceiver(view.access.receiver, identity.receiver))
      return 'wrong-receiver';
    const attempt = view.access.attempt;
    if (
      attempt &&
      (!codec.sameHost(attempt.host, identity.receiver.host) ||
        attempt.cwd !== identity.receiver.cwd ||
        (attempt.target.brand && attempt.target.brand !== identity.receiver.brand))
    )
      return 'wrong-receiver';
    const provider = this.options.messenger.incomingFiles;
    if (!provider || provider.version !== 1 || !this.options.verbs.incomingEvidence)
      return 'unsupported-capability';
    if (
      admission.messengerId !== this.options.messenger.id ||
      admission.installId !== provider.installId
    )
      return 'wrong-install';
    if (file.size !== undefined && file.size > codec.INCOMING_FILE_MAX_BYTES) return 'too-large';
    return { view, admission, file };
  }

  private async authorize(operation: Operation): Promise<Authorized | undefined> {
    if (!(await this.holderCurrent())) throw new cache.CacheRefusal('remote-off');
    const identity = operation.identity;
    const checked = this.current(operation);
    const { view, admission } = checked;
    const attempt = view.access.attempt;
    const receiver = view.access.receiver;
    const query: IncomingEvidenceQuery | undefined = attempt
      ? { kind: 'attempt', attempt }
      : receiver
        ? {
            kind: 'delivery',
            delivery: {
              version: 1,
              receiver,
              correlation: identity.correlation,
              admissionDigest: admission.digest
            }
          }
        : undefined;
    if (!query || view.access.execution === 'not-started') return undefined;
    const proof = await this.proof(query, identity.receiver.host);
    if (!(await this.holderCurrent())) throw new cache.CacheRefusal('remote-off');
    this.current(operation);
    if (!proof) return undefined;
    if (
      !codec.sameReceiver(proof.receiver, identity.receiver) ||
      proof.currentSessionId !== identity.currentSessionId
    )
      throw new cache.CacheRefusal('wrong-receiver');
    const result = await this.options.bridge.resolveIncomingReceiver(
      {
        conversation: identity.conversation,
        correlation: identity.correlation,
        generation: view.generation,
        revision: view.access.revision,
        digest: admission.digest,
        attemptId: attempt?.attemptId
      },
      proof
    );
    const current = this.current(operation);
    if (result === 'storage-unavailable') throw new cache.CacheRefusal(result);
    if (result === 'pending' || result === 'conflict' || current.view.access.state !== 'active')
      return undefined;
    const capability = await this.capability(identity.receiver.host);
    this.current(operation);
    if (!capability) throw new cache.CacheRefusal('unsupported-capability');
    return { ...current, capability };
  }

  private capability(
    host: FetchFileIdentity['receiver']['host']
  ): Promise<IncomingAccess | undefined> {
    const key = JSON.stringify(host);
    const existing = this.capabilities.get(key);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(async () => {
        const models = await this.options.verbs.models?.(host.windowId);
        const capability = codec.readIncomingAccess(models?.incomingAccess);
        return capability && codec.sameHost(capability.host, host) ? capability : undefined;
      })
      .catch(() => undefined);
    this.capabilities.set(key, pending);
    void pending.finally(() => {
      if (this.capabilities.get(key) === pending) this.capabilities.delete(key);
    });
    return pending;
  }

  private proof(
    query: IncomingEvidenceQuery,
    host: FetchFileIdentity['receiver']['host']
  ): Promise<IncomingEvidence | undefined> {
    const key = JSON.stringify([host, query]);
    const existing = this.evidence.get(key);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() => this.options.verbs.incomingEvidence?.(host, query))
      .catch(() => undefined);
    this.evidence.set(key, pending);
    void pending.finally(() => {
      if (this.evidence.get(key) === pending) this.evidence.delete(key);
    });
    return pending;
  }

  private async download(
    operation: Operation,
    authorized: Authorized,
    reservation: cache.Reservation
  ): Promise<cache.CachedFile> {
    const provider = this.options.messenger.incomingFiles;
    if (!provider) throw new cache.CacheRefusal('unsupported-capability');
    try {
      const metadata = await provider.metadata(authorized.file, operation.abort.signal);
      this.current(operation);
      if (
        metadata.size !== undefined &&
        (!Number.isSafeInteger(metadata.size) ||
          metadata.size < 0 ||
          metadata.size > codec.INCOMING_FILE_MAX_BYTES)
      )
        throw new cache.CacheRefusal('too-large');
      const stream = await provider.download(authorized.file, {
        signal: operation.abort.signal,
        maxBytes: codec.INCOMING_FILE_MAX_BYTES
      });
      this.current(operation);
      const content = await this.bytes.materialize(reservation, stream, operation.abort.signal);
      if (!(await this.authorize(operation))) throw new cache.CacheRefusal('evidence-unavailable');
      this.current(operation);
      if (!(await provider.verify(authorized.file, operation.abort.signal)))
        throw new cache.CacheRefusal('wrong-install');
      this.current(operation);
      return await this.bytes.publish(
        reservation,
        content,
        {
          ...(codec.incomingString(metadata.name, 512) ? { name: metadata.name } : {}),
          ...(codec.incomingString(metadata.mime, 128) ? { mime: metadata.mime } : {})
        },
        operation.abort.signal,
        () => typeof this.check(operation.identity, operation.generation) !== 'string'
      );
    } finally {
      if (operation.abort.signal.aborted) await this.bytes.release(reservation);
    }
  }

  private current(operation: Operation): Checked {
    this.alive(operation);
    const checked = this.check(operation.identity, operation.generation);
    if (typeof checked === 'string') throw new cache.CacheRefusal(checked);
    return checked;
  }
  private alive(operation: Operation): void {
    if (performance.now() >= operation.deadline) this.abort(operation, 'timeout');
    if (operation.abort.signal.aborted) throw new cache.CacheRefusal(operation.reason ?? 'closed');
  }
  private abort(operation: Operation, reason: IncomingRefusal): void {
    operation.reason ??= reason;
    operation.abort.abort();
    operation.wake();
  }
  private async bounded<T>(promise: Promise<T>, operation: Operation): Promise<T> {
    void promise.catch(() => {});
    this.alive(operation);
    let reject: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, fail) => {
      reject = () => fail(new cache.CacheRefusal(operation.reason ?? 'closed'));
    });
    const signal = operation.abort.signal;
    const onAbort = () => reject?.();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([promise, interrupted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  private refusal(error: unknown): IncomingRefusal {
    if (error instanceof cache.CacheRefusal) return error.code;
    try {
      const code = this.options.messenger.incomingFiles?.refusal(error);
      // A provider must return a code, never a URL, token or its raw exception text.
      if (typeof code === 'string' && /^provider-[a-z0-9][a-z0-9-]{0,54}$/.test(code)) return code;
    } catch {
      /* Provider errors cannot escape the neutral boundary. */
    }
    return 'storage-unavailable';
  }
}
