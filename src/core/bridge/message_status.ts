import type { ReactionStatus } from './model';
import type { Messenger } from './port';
import type { ConversationRecord, MessageRecord } from './store';

export const REACTION_CALL_MS = 30_000;
export const REACTION_RETRY_MS = 1_000;

type Entry = {
  record: ConversationRecord;
  message: MessageRecord;
  pending?: Promise<void>;
  controller?: AbortController;
  revision: number;
  calls: number;
};

export class MessageReactions {
  private readonly entries = new Map<string, Entry>();
  private stopped = false;

  constructor(
    private readonly options: {
      messenger: Messenger;
      clock: () => number;
      save: (record: ConversationRecord) => Promise<boolean>;
      changed: () => void;
      log: (line: string) => void;
    }
  ) {}

  remember(record: ConversationRecord, message: MessageRecord): void {
    if (!this.options.messenger.reactions) message.reactionRetired = true;
    if (message.reactionRetired) return;
    this.entries.set(message.correlation, { record, message, revision: 0, calls: 0 });
  }

  forget(correlation: string): void {
    const entry = this.entries.get(correlation);
    if (entry?.pending || entry?.calls) return;
    this.entries.delete(correlation);
  }

  desire(message: MessageRecord, status: ReactionStatus): void {
    if (message.desired !== status) {
      message.desired = status;
      delete message.retryAt;
      message.failures = 0;
    }
    const entry = this.entries.get(message.correlation);
    if (entry) this.launch(entry);
  }

  tick(now: number, reconnect = false): void {
    for (const entry of this.entries.values()) {
      if (reconnect) delete entry.message.retryAt;
      if ((entry.message.retryAt ?? now) <= now) this.launch(entry);
    }
  }

  nextDeadline(): number | undefined {
    const due = [...this.entries.values()].flatMap(({ message, pending }) =>
      !pending &&
      (message.applied !== message.desired || message.uncertainEffect) &&
      message.retryAt !== undefined
        ? [message.retryAt]
        : []
    );
    return due.length ? Math.min(...due) : undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.entries.values()) entry.controller?.abort();
    await Promise.all([...this.entries.values()].flatMap((e) => (e.pending ? [e.pending] : [])));
  }

  private launch(entry: Entry): void {
    const capability = this.options.messenger.reactions;
    if (
      !capability ||
      entry.message.reactionRetired ||
      this.stopped ||
      entry.pending ||
      (entry.message.retryAt ?? this.options.clock()) > this.options.clock() ||
      (entry.message.applied === entry.message.desired && !entry.message.uncertainEffect)
    )
      return;
    const status = entry.message.desired;
    const revision = entry.revision;
    const controller = new AbortController();
    entry.controller = controller;
    const timer = setTimeout(() => controller.abort(), REACTION_CALL_MS);
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('Reaction update cancelled.')),
        { once: true }
      );
    });
    // An adapter that ignores abort still cannot occupy the slot past the call's deadline.
    let call: Promise<void>;
    entry.calls++;
    try {
      call = capability.set(entry.message.ref, status, controller.signal);
    } catch (error) {
      call = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const late = (): void => {
      entry.calls--;
      if (this.stopped || !controller.signal.aborted) return;
      entry.revision++;
      delete entry.message.applied;
      entry.message.retryAt = this.options.clock() + REACTION_RETRY_MS;
      void this.options.save(entry.record).then(() => this.options.changed());
    };
    void call.then(late, late);
    entry.pending = Promise.race([call, cancelled])
      .then(
        async () => {
          if (this.stopped) return;
          if (entry.revision === revision) {
            entry.message.applied = status;
            if (entry.calls === 0) delete entry.message.uncertainEffect;
          }
          entry.message.failures = 0;
          delete entry.message.retryAt;
          await this.options.save(entry.record);
        },
        async (error: unknown) => {
          if (this.stopped) return;
          delete entry.message.applied;
          if (controller.signal.aborted) entry.message.uncertainEffect = true;
          entry.message.failures = (entry.message.failures ?? 0) + 1;
          if (entry.message.desired === status)
            entry.message.retryAt =
              this.options.clock() +
              Math.min(30_000, REACTION_RETRY_MS * 2 ** Math.min(entry.message.failures - 1, 5));
          else delete entry.message.retryAt;
          await this.options.save(entry.record);
          this.options.log(
            `Remote: a message status was not applied: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      )
      .finally(() => {
        clearTimeout(timer);
        delete entry.controller;
        delete entry.pending;
        if (
          (entry.message.reactionRetired || !entry.record.messages?.includes(entry.message)) &&
          entry.calls === 0
        )
          this.entries.delete(entry.message.correlation);
        if (this.stopped) return;
        this.options.changed();
        if (entry.message.desired !== status || entry.revision !== revision) this.launch(entry);
      });
  }
}
