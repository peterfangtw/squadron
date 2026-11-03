import * as crypto from 'crypto';
import * as incoming from '../incoming';
import * as access from './access';
import * as status from './message_status';
import { allowed, Deduper } from './allow';
import { admit, addrOf } from './route';
import { sameAddr, rootOfWatched } from './session';
import type { MessageFact } from '../message_facts';
import type { Inbound, SenderId, SessionAddr, Watched } from './model';
import type { Messenger } from './port';
import * as holder from '../remote/holder';
import {
  conversationId,
  denyMessageIncoming,
  IncomingCollisionIndex,
  readConversationInventory,
  resolveRefs,
  retainedMessages,
  incomingNeedsRetention,
  removeConversation,
  pruneConversationTemps,
  writeConversation
} from './store';
import type { ConversationRecord, MessageRecord } from './store';

/** Conversation/message state shares one ordered writer; routing never owns that queue. */
export class MessageState {
  private inventory: ConversationRecord[] = [];
  private seen = new Deduper();

  get deduper(): Deduper {
    return this.seen;
  }
  private readonly durable = new Set<string>();
  /** Body and revision of the last successful write. Body omits those two fields. */
  private readonly lastDurable = new Map<string, { text: string; revision: number | undefined }>();
  private readonly admissions = new Map<
    string,
    {
      record: ConversationRecord;
      message: MessageRecord;
      saved: Promise<boolean>;
    }
  >();
  private readonly collisions = new IncomingCollisionIndex();
  private mutations: Promise<unknown> = Promise.resolve();
  readonly access: access.AccessLedger;
  readonly reactions: status.MessageReactions;

  constructor(
    private readonly options: {
      messenger: Messenger;
      allowlist: readonly SenderId[];
      clock: () => number;
      stopped: () => boolean;
      holder?: import('../remote/holder').Holder;
      changed: () => void;
      log: (line: string) => void;
    }
  ) {
    this.access = new access.AccessLedger({
      mutate: (step) => this.mutate(step),
      save: (record) => this.saveNow(record),
      clock: options.clock,
      changed: options.changed
    });
    this.reactions = new status.MessageReactions({
      messenger: options.messenger,
      clock: options.clock,
      save: (record) => this.save(record),
      changed: options.changed,
      log: options.log
    });
  }

  get records(): readonly ConversationRecord[] {
    return this.inventory;
  }

  keep(record: ConversationRecord): void {
    if (!this.inventory.includes(record)) this.inventory.push(record);
  }

  tracked(
    id: string
  ): { record: ConversationRecord; message: MessageRecord; saved: Promise<boolean> } | undefined {
    return this.admissions.get(id);
  }

  admittedEvents(): Inbound[] {
    return [...this.admissions.values()].flatMap(({ message }) =>
      message.delivery === 'admitted' && message.event ? [message.event] : []
    );
  }

  routed(id: string): void {
    this.durable.add(id);
  }

  restoreSeen(seen: readonly (readonly [string, number])[]): void {
    this.seen = new Deduper(seen);
    for (const [id] of seen) this.durable.add(id);
  }

  async load(recover: (record: ConversationRecord) => Promise<void>): Promise<void> {
    const { records, complete } = await readConversationInventory();
    this.access.load(records, complete, this.options.messenger.id);
    this.inventory = records.filter((record) => record.messenger === this.options.messenger.id);
    for (const record of this.inventory) {
      for (const message of record.messages ?? []) {
        this.collisions.remember(record, message);
        this.admissions.set(message.id, { record, message, saved: Promise.resolve(true) });
        this.reactions.remember(record, message);
      }
      await recover(record);
    }
  }

  /** Access closures still use the ordered writer after Bridge closes admission. */
  haltAccess(): Promise<boolean> {
    this.access.dispose();
    return this.access.retry();
  }

  async drain(): Promise<void> {
    await this.mutations;
  }

  async housekeep(
    table: Pick<import('../scan').ProcessTable, 'starts' | 'complete' | 'startSource'>
  ): Promise<void> {
    const owner = this.options.holder;
    if (this.options.stopped() || !owner) return;
    await this.access.sweep(table);
    await this.mutate(async () => {
      if (this.options.stopped()) return;
      await pruneConversationTemps(owner, this.now());
      for (const record of [...this.inventory]) {
        if (
          record.messages?.some(
            (message) =>
              incomingNeedsRetention(message, this.now()) ||
              !message.terminal ||
              message.uncertainEffect ||
              (!message.reactionRetired && message.applied !== message.desired)
          )
        )
          continue;
        if (this.now() - record.updatedAt <= 30 * 24 * 60 * 60_000) continue;
        if (!(await removeConversation(record, owner))) continue;
        this.inventory = this.inventory.filter((one) => one !== record);
        this.lastDurable.delete(record.id);
        for (const message of record.messages ?? []) {
          this.admissions.delete(message.id);
          this.collisions.forget(message);
          this.access.forget(record, message);
          this.reactions.forget(message.correlation);
        }
      }
    });
  }

  /** The deduper's ids worth keeping beside the watermark: those routed or
   *  admitted durably. The rest are let go here too. */
  keptIds(): [string, number][] {
    const seen = this.deduper
      .entries()
      .filter(([id]) => this.durable.has(id) || this.admissions.has(id));
    const retained = new Set(seen.map(([id]) => id));
    for (const id of this.durable) if (!retained.has(id)) this.durable.delete(id);
    return seen;
  }

  admit(event: Inbound): boolean {
    if (this.options.stopped()) return false;
    if (event.kind !== 'message') return true;
    if (!allowed(event.sender, this.options.allowlist) || event.text.trim() === '') return false;
    const previous = this.admissions.get(event.id);
    if (previous) {
      if (!this.sameAdmission(previous.message, event)) {
        if (!previous.message.incoming) {
          denyMessageIncoming(previous.message);
          this.access.remember(previous.record, previous.message);
        }
        void this.access.close(
          previous.record.id,
          previous.message.correlation,
          'admission-denied'
        );
      }
      return false;
    }
    if (admit(event, { allowlist: this.options.allowlist, deduper: this.deduper, now: this.now() }))
      return false;
    const record = resolveRefs(this.inventory, event.refs) ?? this.mint(event.sender.id, {});
    if (!this.inventory.includes(record)) {
      record.anchor = event.refs[0] ?? event.ref;
      record.latest = event.ref;
      record.refs = [record.anchor];
      this.inventory.push(record);
    }
    const { incoming: _incoming, ...replay } = event;
    const message: MessageRecord = {
      id: event.id,
      correlation: crypto.randomUUID(),
      ref: event.ref,
      at: this.now(),
      desired: 'received',
      delivery: 'admitted',
      event: { ...replay, sender: { ...event.sender }, refs: [...event.refs] }
    };
    if (event.incoming !== undefined) {
      const descriptors = incoming.readIncomingDescriptors(event.incoming);
      if (descriptors && !('denied' in descriptors)) {
        const original = {
          ...descriptors,
          id: message.id,
          ref: message.ref,
          correlation: message.correlation,
          eventAt: event.at,
          admittedAt: message.at,
          senderId: event.sender.id,
          messengerId: this.options.messenger.id
        };
        message.incoming = incoming.readIncomingAdmission({
          ...original,
          digest: incoming.admissionDigest(original)
        });
      } else message.incoming = Object.freeze({ version: 1, denied: 'admission-denied' });
      if (message.incoming && !('denied' in message.incoming)) {
        const refusal = this.access.admissionRefusal(record.id, message.incoming);
        if (refusal) {
          message.incoming = Object.freeze({ version: 1, denied: 'admission-denied' });
          message.access = Object.freeze({
            revision: 0,
            state: 'closed',
            reason: refusal,
            closedAt: this.now()
          });
        } else {
          message.access = Object.freeze({
            revision: 0,
            state: 'held'
          });
        }
      } else denyMessageIncoming(message);
      record.schema = 3;
    }
    (record.messages ??= []).push(message);
    this.access.remember(record, message);
    for (const row of this.collisions.remember(record, message)) {
      if (!row.message.incoming) {
        denyMessageIncoming(row.message);
        this.access.remember(row.record, row.message);
      }
      void this.access.close(row.record.id, row.message.correlation, 'admission-denied');
    }
    const saved = this.save(record).then((written) => {
      if (written) this.durable.add(event.id);
      return written;
    });
    this.admissions.set(event.id, { record, message, saved });
    this.reactions.remember(record, message);
    this.reactions.desire(message, 'received');
    return true;
  }

  private sameAdmission(
    message: MessageRecord,
    event: Extract<Inbound, { kind: 'message' }>
  ): boolean {
    const original = message.incoming;
    if (!original || 'denied' in original) return event.incoming === undefined;
    const descriptors = incoming.readIncomingDescriptors(event.incoming);
    if (!descriptors || 'denied' in descriptors) return false;
    return (
      incoming.admissionDigest({
        ...original,
        ...descriptors,
        id: event.id,
        ref: event.ref,
        eventAt: event.at,
        senderId: event.sender.id,
        messengerId: this.options.messenger.id
      }) === original.digest && descriptors.omitted === original.omitted
    );
  }

  async attempt(
    record: ConversationRecord,
    message?: MessageRecord,
    target?: SessionAddr
  ): Promise<boolean> {
    if (this.options.stopped()) return false;
    if (!message) return true;
    message.delivery = 'attempted';
    delete message.event;
    if (target) message.target = target;
    else record.rootCorrelation = message.correlation;
    return this.save(record);
  }

  async finish(record: ConversationRecord, message?: MessageRecord): Promise<void> {
    if (!message || message.terminal) return;
    message.delivery = 'settled';
    message.terminal = true;
    delete message.event;
    this.reactions.desire(message, 'received');
    await this.save(record);
  }

  async finishHeld(record: ConversationRecord): Promise<void> {
    const message = record.messages?.find((m) => m.correlation === record.held?.correlation);
    if (message) await this.access.close(record.id, message.correlation, 'closed');
    await this.finish(record, message);
  }

  reconcile(board: readonly Watched[]): void {
    if (this.options.stopped()) return;
    for (const record of this.inventory) {
      for (const message of record.messages ?? []) {
        if (
          message.access?.state !== 'closed' &&
          message.incoming &&
          !('denied' in message.incoming)
        ) {
          const admission = message.incoming;
          const receiver = message.access?.receiver;
          const receipt =
            receiver &&
            board
              .flatMap((one) => one.incomingDeliveries ?? [])
              .find(
                (receipt) =>
                  receipt.dismissed &&
                  incoming.sameReceiver(receipt.receiver, receiver) &&
                  receipt.correlation === message.correlation &&
                  receipt.admissionDigest === admission.digest
              );
          const attempt = message.access?.attempt;
          const launch =
            attempt &&
            board.find(
              (one) =>
                one.remoteLaunchEvidence?.dismissed &&
                incoming.sameLaunchAttempt(one.remoteLaunchEvidence.attempt, attempt)
            );
          if (receipt || launch) void this.access.close(record.id, message.correlation, 'closed');
        }
        if (message.terminal || message.delivery !== 'attempted') continue;
        if (message.access?.attempt && !message.target) continue;
        const candidates = board.filter((w) =>
          message.target
            ? sameAddr(addrOf(w), message.target) && addrOf(w).windowId === message.target.windowId
            : w.messageFacts?.some((f) => f.correlation === message.correlation)
        );
        const owner = candidates.length === 1 ? candidates[0] : undefined;
        if (!owner) continue;
        if (!message.target) {
          message.target = addrOf(owner);
          if (
            record.rootCorrelation === message.correlation ||
            record.held?.correlation === message.correlation
          ) {
            if (record.root?.sessionId && !record.past.includes(record.root.sessionId))
              record.past.push(record.root.sessionId);
            record.root = { ...rootOfWatched(owner), remoteSpawned: true };
            record.rootCorrelation = message.correlation;
            record.state = 'live';
            delete record.held;
          }
          void this.save(record);
        }
        if (owner.messageFacts) this.applyFacts(record, message, owner.messageFacts);
      }
    }
  }

  applyFacts(
    record: ConversationRecord,
    message: MessageRecord,
    facts: readonly MessageFact[]
  ): void {
    if (message.terminal) return;
    const fact = facts.find((f) => f.correlation === message.correlation);
    if (!fact || fact.phase === 'unknown') return;
    if (fact.phase === 'unsuccessful') {
      if (fact.dismissed === true) void this.access.close(record.id, message.correlation, 'closed');
      void this.finish(record, message);
      return;
    }
    if (fact.phase === 'done') {
      message.terminal = true;
      message.delivery = 'settled';
    }
    const desired = fact.phase;
    const ranks = { received: 0, queued: 1, processing: 2, done: 3 };
    if (ranks[desired] < ranks[message.desired]) return;
    this.reactions.desire(message, desired);
    void this.save(record);
  }

  /** A record not yet kept: `put` keeps it once its first post lands. */
  mint(
    owner: SenderId,
    over: Partial<Pick<ConversationRecord, 'state' | 'root' | 'held'>>
  ): ConversationRecord {
    const now = this.now();
    return {
      schema: 1,
      id: conversationId(),
      messenger: this.options.messenger.id,
      anchor: '',
      refs: [],
      latest: '',
      owner,
      state: 'live',
      past: [],
      notices: [],
      createdAt: now,
      updatedAt: now,
      ...over
    };
  }

  find(id: string): ConversationRecord | undefined {
    return this.inventory.find((record) => record.id === id);
  }

  save(record: ConversationRecord): Promise<boolean> {
    if (this.options.stopped()) return Promise.resolve(false);
    return this.mutate(() => this.saveNow(record));
  }

  private async saveNow(record: ConversationRecord): Promise<boolean> {
    if (!this.inventory.includes(record)) return false;
    const originalMessages = record.messages;
    const removed: MessageRecord[] = [];
    if (record.messages) {
      const requiredIncoming = new Set(
        record.messages
          .filter((message) => {
            const committed = this.access.snapshot(record.id, message.correlation);
            return (
              committed &&
              incomingNeedsRetention(
                { ...message, incoming: committed.admission, access: committed.access },
                this.now()
              )
            );
          })
          .map((message) => message.id)
      );
      const retained = retainedMessages(record.messages, this.now(), requiredIncoming);
      const keeping = new Map(retained.map((message) => [message.correlation, message]));
      record.messages = record.messages.filter((message) => {
        const next = keeping.get(message.correlation);
        if (next) {
          if (next.reactionRetired) {
            message.reactionRetired = true;
            if (message.delivery === 'settled') delete message.event;
            this.reactions.forget(message.correlation);
          }
          return true;
        }
        removed.push(message);
        return false;
      });
    }
    if (record.messages?.some((message) => message.incoming !== undefined)) record.schema = 3;
    // Queued behind a save that already wrote this record: 2 of 11 writes per
    // delivery (bridge_incoming.test.ts deliver: send, drain, idle, observe),
    // revision and updatedAt only, ~7 ms each. The other 9 change the file.
    // Retention that drops a message still differs. A lost holder still
    // fails the save; callers use that as the fence before the next effect.
    // A failed write leaves revision ahead of the last landed one, and
    // removeConversation deletes only when the two revisions match.
    const text = durableText(record);
    const prior = this.lastDurable.get(record.id);
    if (prior !== undefined && prior.text === text && prior.revision === record.revision) {
      const owner = this.options.holder;
      if (owner && !(await holder.ownsHolder(owner))) {
        record.messages = originalMessages;
        this.log(`Remote: conversation ${record.id} was not written.`);
        return false;
      }
      if (durableText(record) === text) {
        this.access.written(record, this.access.capture(record), true);
        this.dropRemoved(record, removed);
        return true;
      }
    }
    record.updatedAt = this.now();
    if (record.schema === 3) {
      const revision = (record.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) {
        record.messages = originalMessages;
        return false;
      }
      record.revision = revision;
    }
    const projection = this.access.capture(record);
    const landing = durableText(record);
    const written = await writeConversation(record, this.now(), this.options.holder).catch(
      () => false
    );
    this.access.written(record, projection, written);
    if (!written) {
      record.messages = originalMessages;
      this.log(`Remote: conversation ${record.id} was not written.`);
    } else {
      this.lastDurable.set(record.id, { text: landing, revision: record.revision });
      this.dropRemoved(record, removed);
    }
    return written;
  }

  private dropRemoved(record: ConversationRecord, removed: readonly MessageRecord[]): void {
    for (const message of removed) {
      this.admissions.delete(message.id);
      this.collisions.forget(message);
      this.access.forget(record, message);
      this.reactions.forget(message.correlation);
    }
  }

  private mutate<T>(step: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(step, step);
    this.mutations = next.catch((error: unknown) =>
      this.log(`Remote: ${error instanceof Error ? error.message : String(error)}`)
    );
    return next;
  }

  private now(): number {
    return this.options.clock();
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function durableText(record: ConversationRecord): string {
  const { revision, updatedAt, ...rest } = record;
  return JSON.stringify(rest);
}
