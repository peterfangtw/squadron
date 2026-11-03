import * as incoming from '../incoming';
import * as store from './store';
import type {
  IncomingAdmission,
  IncomingDenied,
  IncomingEvidence,
  IncomingHolder,
  IncomingRefusal,
  LaunchAttempt,
  ReceiverIdentity
} from './model';

// D23 reserves both message access and its owner's stable receipt before promising files.
export const INCOMING_METADATA_RESERVE_BYTES = 48 * 1024;
export const INCOMING_METADATA_CONVERSATION_BYTES = 16 * 1024 * 1024;
export const INCOMING_METADATA_MACHINE_BYTES = 64 * 1024 * 1024;

export type IncomingPolicy = Readonly<{
  messengerId: string;
  installId: string;
  allowedIds: readonly string[];
}>;

type CommittedAccess = Readonly<{
  conversation: string;
  correlation: string;
  admission: IncomingAdmission | IncomingDenied;
  access: store.MessageAccess;
}>;

export type AccessProjection = CommittedAccess &
  Readonly<{
    generation: number;
    holder?: IncomingHolder;
    denial?: IncomingRefusal;
  }>;

export type AccessExpectation = Readonly<{
  conversation: string;
  correlation: string;
  generation: number;
  revision: number;
  digest: string;
  attemptId?: string;
}>;

export type ReceiverResolution =
  'committed' | 'unchanged' | 'conflict' | 'closed' | 'pending' | 'storage-unavailable';

type Entry = { record: store.ConversationRecord; message: store.MessageRecord };
type Denial = { reason: IncomingRefusal; at: number };

/** Bridge-owned metadata; owner freshness is checked by the evidence collector outside its write queue. */
export class AccessLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly committed = new Map<string, CommittedAccess>();
  private readonly denials = new Map<string, Denial>();
  private readonly dirty = new Set<store.ConversationRecord>();
  private readonly listeners = new Set<() => void>();
  private members = new Set<string>();
  private readonly budget = new MetadataBudget();
  private current: IncomingPolicy | undefined;
  private holder: IncomingHolder | undefined;
  private generation = 0;
  private loaded = false;
  private halted = false;
  private inventoryComplete = false;

  constructor(
    private readonly options: {
      mutate: <T>(step: () => Promise<T>) => Promise<T>;
      save: (record: store.ConversationRecord) => Promise<boolean>;
      clock: () => number;
      changed: () => void;
    }
  ) {}

  load(records: readonly store.ConversationRecord[], complete: boolean, messengerId: string): void {
    for (const record of records) {
      for (const message of record.messages ?? []) this.budget.remember(record.id, message);
      if (record.messenger !== messengerId) continue;
      for (const message of record.messages ?? []) this.remember(record, message);
      this.commit(this.capture(record));
    }
    this.loaded = true;
    this.inventoryComplete = complete;
  }

  remember(record: store.ConversationRecord, message: store.MessageRecord): void {
    if (!message.incoming) return;
    this.budget.remember(record.id, message);
    const id = key(record.id, message.correlation);
    this.entries.set(id, { record, message });
  }

  forget(record: store.ConversationRecord, message: store.MessageRecord): void {
    const id = key(record.id, message.correlation);
    this.entries.delete(id);
    this.committed.delete(id);
    this.denials.delete(id);
    this.budget.forget(record.id, message);
  }

  capture(record: store.ConversationRecord): readonly CommittedAccess[] {
    return (record.messages ?? []).flatMap((message) =>
      message.incoming && message.access ? [this.committedRow(record, message)] : []
    );
  }

  private committedRow(
    record: store.ConversationRecord,
    message: store.MessageRecord
  ): CommittedAccess {
    const prior = this.committed.get(key(record.id, message.correlation));
    if (prior && prior.admission === message.incoming && prior.access === message.access)
      return prior;
    if (!message.incoming || !message.access) throw new Error('Incoming metadata is missing.');
    return Object.freeze({
      conversation: record.id,
      correlation: message.correlation,
      admission: message.incoming,
      access: message.access
    });
  }

  commit(rows: readonly CommittedAccess[]): void {
    for (const row of rows) {
      const id = key(row.conversation, row.correlation);
      const prior = this.committed.get(id);
      if (prior?.admission !== row.admission || prior.access !== row.access)
        this.committed.set(id, row);
    }
    this.changed();
  }

  written(record: store.ConversationRecord, rows: readonly CommittedAccess[], ok: boolean): void {
    if (ok) {
      this.commit(rows);
      this.dirty.delete(record);
    } else if (
      rows.some((row) => {
        const prior = this.committed.get(key(row.conversation, row.correlation));
        return prior?.admission !== row.admission || prior.access !== row.access;
      })
    ) {
      this.dirty.add(record);
      this.changed();
    }
  }

  incomingHolder(): IncomingHolder | undefined {
    return this.loaded && !this.halted ? this.holder : undefined;
  }

  snapshot(conversation: string, correlation: string): AccessProjection | undefined {
    const id = key(conversation, correlation);
    const row = this.committed.get(id);
    if (!row) return undefined;
    const denial = this.denial(id, row);
    return Object.freeze({
      ...row,
      generation: this.generation,
      ...(this.holder ? { holder: this.holder } : {}),
      ...(denial ? { denial } : {})
    });
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  admissionRefusal(
    conversation: string,
    admission: IncomingAdmission
  ): IncomingRefusal | undefined {
    if (!this.inventoryComplete) return 'storage-unavailable';
    return this.budget.fits(conversation, admission) ? undefined : 'capacity';
  }

  begin(expected: AccessExpectation, raw: LaunchAttempt): Promise<ReceiverResolution> {
    const attempt = incoming.readLaunchAttempt(raw);
    return this.options.mutate(async () => {
      const checked = this.check(expected);
      if (typeof checked === 'string') return checked;
      if (
        !attempt ||
        attempt.conversation !== expected.conversation ||
        attempt.messageId !== checked.message.id ||
        attempt.correlation !== expected.correlation ||
        attempt.admissionDigest !== expected.digest ||
        !this.holder ||
        !incoming.sameHost(attempt.holder.host, this.holder.host) ||
        attempt.holder.generation !== this.holder.generation ||
        checked.message.access?.receiver
      )
        return 'conflict';
      const access = checked.message.access;
      if (!access) return 'pending';
      if (access.execution === 'not-started' && access.attempt?.attemptId === attempt.attemptId)
        return 'conflict';
      if (access.retiredAttempts?.some((retired) => retired.attemptId === attempt.attemptId))
        return 'conflict';
      if (access.attempt && access.execution !== 'not-started')
        return incoming.sameLaunchAttempt(access.attempt, attempt) ? 'unchanged' : 'conflict';
      const retiredAttempts = access.attempt
        ? Object.freeze([
            ...(access.retiredAttempts ?? []),
            Object.freeze({
              attemptId: access.attempt.attemptId,
              execution: 'not-started' as const
            })
          ])
        : access.retiredAttempts;
      if (
        access.attempt &&
        !this.budget.retire(expected.conversation, expected.correlation, retiredAttempts ?? [])
      )
        return 'storage-unavailable';
      checked.message.access = Object.freeze({
        ...access,
        revision: access.revision + 1,
        state: 'starting',
        attempt,
        execution: 'unresolved',
        ...(retiredAttempts ? { retiredAttempts } : {})
      });
      return this.persist(checked, expected);
    });
  }

  notStarted(expected: AccessExpectation): Promise<ReceiverResolution> {
    return this.options.mutate(async () => {
      const checked = this.check(expected);
      if (typeof checked === 'string') return checked;
      const access = checked.message.access;
      if (!access?.attempt || access.receiver || access.execution !== 'unresolved')
        return 'conflict';
      checked.message.access = Object.freeze({
        ...access,
        revision: access.revision + 1,
        execution: 'not-started'
      });
      return this.persist(checked, expected);
    });
  }

  intend(expected: AccessExpectation, raw: ReceiverIdentity): Promise<ReceiverResolution> {
    const receiver = incoming.readReceiverIdentity(raw);
    return this.options.mutate(async () => {
      const checked = this.check(expected);
      if (typeof checked === 'string') return checked;
      const access = checked.message.access;
      if (!receiver || !access || access.attempt) return 'conflict';
      if (access.receiver)
        return incoming.sameReceiver(access.receiver, receiver) ? 'unchanged' : 'conflict';
      checked.message.access = Object.freeze({
        ...access,
        revision: access.revision + 1,
        state: 'intended',
        receiver
      });
      return this.persist(checked, expected);
    });
  }

  resolve(expected: AccessExpectation, raw: IncomingEvidence): Promise<ReceiverResolution> {
    const evidence = incoming.readIncomingEvidence(raw);
    return this.options.mutate(async () => {
      const checked = this.check(expected);
      if (typeof checked === 'string') return checked;
      const access = checked.message.access;
      if (!evidence || !access || evidence.query.kind === 'receiver') return 'conflict';
      if (evidence.query.kind === 'attempt') {
        if (
          !access.attempt ||
          access.execution === 'not-started' ||
          !incoming.sameLaunchAttempt(access.attempt, evidence.query.attempt) ||
          expected.attemptId !== access.attempt.attemptId ||
          !evidence.launch
        )
          return 'conflict';
        if (evidence.launch.stage !== 'accepted') return 'pending';
      } else if (
        access.attempt ||
        !access.receiver ||
        evidence.delivery?.correlation !== expected.correlation ||
        evidence.delivery.admissionDigest !== expected.digest
      )
        return 'conflict';
      if (access.receiver && !incoming.sameReceiver(access.receiver, evidence.receiver))
        return 'conflict';
      if (evidence.launch?.dismissed || evidence.delivery?.dismissed) {
        this.deny(key(expected.conversation, expected.correlation), 'closed');
        this.invalidate();
        await this.flushDenials();
        return 'closed';
      }
      if (access.state === 'active') return 'unchanged';
      checked.message.access = Object.freeze({
        ...access,
        revision: access.revision + 1,
        state: 'active',
        receiver: evidence.receiver,
        ...(access.attempt ? { execution: 'launched' as const } : {})
      });
      return this.persist(checked, expected);
    });
  }

  close(conversation: string, correlation: string, reason: IncomingRefusal): Promise<boolean> {
    const id = key(conversation, correlation);
    if (!this.entries.has(id) || !incoming.incomingRefusal(reason)) return Promise.resolve(false);
    this.deny(id, reason);
    this.invalidate();
    return this.options.mutate(() => this.flushDenials());
  }

  observe(raw: IncomingPolicy, holderValue: IncomingHolder): Promise<boolean> {
    const current = readPolicy(raw);
    const holder = incoming.readIncomingHolder(holderValue);
    if (!current || !holder || !this.loaded || this.halted) return Promise.resolve(false);
    this.current = current;
    this.holder = holder;
    this.members = new Set(current.allowedIds);
    for (const [id, { message }] of this.entries) {
      const admission = message.incoming;
      if (admission && !('denied' in admission) && !this.accepts(admission, current))
        this.deny(
          id,
          admission.messengerId !== current.messengerId || admission.installId !== current.installId
            ? 'wrong-install'
            : 'admission-denied'
        );
    }
    this.invalidate();
    return this.options.mutate(() => this.flushDenials());
  }

  dispose(): void {
    this.halted = true;
    this.invalidate();
  }

  sweep(
    table: Pick<import('../scan').ProcessTable, 'starts' | 'complete' | 'startSource'>
  ): Promise<void> {
    const dead = [...this.entries.values()].filter(({ message }) => {
      const access = message.access;
      if (access?.ownerEndedAt !== undefined) return false;
      const receiver = access?.receiver;
      const host = receiver?.host ?? access?.attempt?.host;
      return (
        !!host &&
        (incoming.ownerDead(host, table) || (!!receiver && incoming.ownerDead(receiver, table)))
      );
    });
    for (const { record, message } of dead)
      this.deny(key(record.id, message.correlation), 'closed');
    if (dead.length) this.changed();
    return this.options.mutate(async () => {
      for (const { message } of dead) {
        const access = message.access;
        if (access)
          message.access = Object.freeze({
            ...access,
            revision: access.revision + 1,
            state: 'closed',
            ownerEndedAt: this.options.clock(),
            ...(access.execution === 'unresolved' ? { execution: 'retired-unknown' as const } : {}),
            reason: access.reason ?? 'closed',
            closedAt: access.closedAt ?? this.options.clock()
          });
      }
      await this.flushDenials();
    });
  }

  retry(): Promise<boolean> {
    return this.options.mutate(() => this.retryNow());
  }

  needsRetry(): boolean {
    return this.dirty.size > 0 || this.denials.size > 0;
  }

  private async retryNow(): Promise<boolean> {
    let ok = await this.flushDenials();
    for (const record of this.dirty) if (!(await this.options.save(record))) ok = false;
    return ok && !this.needsRetry();
  }

  private async flushDenials(): Promise<boolean> {
    const pending = new Map(this.denials);
    const records = new Set<store.ConversationRecord>();
    for (const [id, denial] of pending) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const access = entry.message.access;
      if (access?.state !== 'closed')
        entry.message.access = Object.freeze({
          ...access,
          revision: (access?.revision ?? 0) + 1,
          state: 'closed',
          reason: denial.reason,
          closedAt: denial.at
        });
      records.add(entry.record);
    }
    let ok = true;
    for (const record of records) {
      if (!(await this.options.save(record))) {
        ok = false;
        continue;
      }
      for (const [id, denial] of pending)
        if (this.entries.get(id)?.record === record && this.denials.get(id) === denial)
          this.denials.delete(id);
    }
    return ok && this.denials.size === 0;
  }

  private async persist(entry: Entry, expected: AccessExpectation): Promise<ReceiverResolution> {
    const written = await this.options.save(entry.record);
    const view = this.snapshot(expected.conversation, expected.correlation);
    if (view?.denial && view.denial !== 'storage-unavailable') return 'closed';
    if (!written) return 'storage-unavailable';
    return view?.generation === expected.generation ? 'committed' : 'conflict';
  }

  private check(expected: AccessExpectation): Entry | ReceiverResolution {
    const id = key(expected.conversation, expected.correlation);
    const view = this.snapshot(expected.conversation, expected.correlation);
    const entry = this.entries.get(id);
    if (!view || !entry) return 'pending';
    if (view.denial)
      return view.denial === 'storage-unavailable' ? 'storage-unavailable' : 'closed';
    if (
      'denied' in view.admission ||
      view.admission.digest !== expected.digest ||
      view.generation !== expected.generation ||
      view.access.revision !== expected.revision ||
      view.access.attempt?.attemptId !== expected.attemptId
    )
      return 'conflict';
    return entry;
  }

  private denial(id: string, row: CommittedAccess): IncomingRefusal | undefined {
    const denied = this.denials.get(id);
    if (denied) return denied.reason;
    if ('denied' in row.admission) return row.access.reason ?? 'admission-denied';
    if (row.access.state === 'closed') return row.access.reason ?? 'closed';
    if (this.halted) return 'remote-off';
    if (!this.current || !this.holder) return 'unsupported-capability';
    const entry = this.entries.get(id);
    if (entry && this.dirty.has(entry.record)) return 'storage-unavailable';
    if (!this.accepts(row.admission, this.current)) return 'admission-denied';
    return undefined;
  }

  private accepts(admission: IncomingAdmission, current: IncomingPolicy): boolean {
    return (
      admission.messengerId === current.messengerId &&
      admission.installId === current.installId &&
      this.members.has(admission.senderId)
    );
  }

  private deny(id: string, reason: IncomingRefusal): void {
    if (!this.denials.has(id)) this.denials.set(id, { reason, at: this.options.clock() });
  }

  private invalidate(): void {
    this.generation++;
    this.changed();
  }

  private changed(): void {
    this.options.changed();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A subscriber cannot undo an acknowledged commit. */
      }
    }
  }
}

function key(conversation: string, correlation: string): string {
  return JSON.stringify([conversation, correlation]);
}

function readPolicy(raw: IncomingPolicy): IncomingPolicy | undefined {
  if (
    !raw ||
    !incoming.incomingString(raw.messengerId) ||
    !incoming.incomingString(raw.installId) ||
    !Array.isArray(raw.allowedIds) ||
    !raw.allowedIds.every((id: unknown) => incoming.incomingString(id)) ||
    new Set(raw.allowedIds).size !== raw.allowedIds.length
  )
    return undefined;
  return Object.freeze({
    messengerId: raw.messengerId,
    installId: raw.installId,
    allowedIds: Object.freeze([...raw.allowedIds])
  });
}

class MetadataBudget {
  private total = 0;
  private readonly conversations = new Map<string, number>();
  private readonly reservations = new Map<string, number>();
  private readonly retirementBytes = new Map<string, number>();

  fits(conversation: string, admission: IncomingAdmission): boolean {
    const cost = this.cost(admission);
    return (
      this.total + cost <= INCOMING_METADATA_MACHINE_BYTES &&
      (this.conversations.get(conversation) ?? 0) + cost <= INCOMING_METADATA_CONVERSATION_BYTES
    );
  }

  remember(conversation: string, message: store.MessageRecord): void {
    const admission = message.incoming;
    const id = key(conversation, message.correlation);
    if (!admission || 'denied' in admission || this.reservations.has(id)) return;
    const retiredBytes = message.access?.retiredAttempts
      ? Buffer.byteLength(JSON.stringify(message.access.retiredAttempts))
      : 0;
    const cost = this.cost(admission) + retiredBytes;
    this.retirementBytes.set(id, retiredBytes);
    this.reservations.set(id, cost);
    this.total += cost;
    this.conversations.set(conversation, (this.conversations.get(conversation) ?? 0) + cost);
  }

  retire(
    conversation: string,
    correlation: string,
    retired: readonly { attemptId: string }[]
  ): boolean {
    const id = key(conversation, correlation);
    const previous = this.retirementBytes.get(id) ?? 0;
    const size = Buffer.byteLength(JSON.stringify(retired));
    const extra = size - previous;
    if (extra <= 0) return true;
    if (
      this.total + extra > INCOMING_METADATA_MACHINE_BYTES ||
      (this.conversations.get(conversation) ?? 0) + extra > INCOMING_METADATA_CONVERSATION_BYTES
    )
      return false;
    this.retirementBytes.set(id, size);
    this.reservations.set(id, (this.reservations.get(id) ?? 0) + extra);
    this.total += extra;
    this.conversations.set(conversation, (this.conversations.get(conversation) ?? 0) + extra);
    return true;
  }

  forget(conversation: string, message: store.MessageRecord): void {
    const id = key(conversation, message.correlation);
    const cost = this.reservations.get(id);
    if (cost === undefined) return;
    this.reservations.delete(id);
    this.retirementBytes.delete(id);
    this.total -= cost;
    const remaining = (this.conversations.get(conversation) ?? cost) - cost;
    if (remaining === 0) this.conversations.delete(conversation);
    else this.conversations.set(conversation, remaining);
  }

  private cost(admission: IncomingAdmission): number {
    return Buffer.byteLength(JSON.stringify(admission), 'utf8') + INCOMING_METADATA_RESERVE_BYTES;
  }
}
