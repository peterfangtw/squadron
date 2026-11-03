import type { Session } from './model';

type Identity = Pick<Session, 'pid' | 'startedAt'>;
type Ending = { card: Session; failure?: string };

/** Retained cards belong to native shutdown, never to a board refresh's clock. */
export class EndingSessions {
  private readonly records = new Map<number, Ending>();

  retain(card: Session): void {
    this.records.set(card.pid, { card: { ...card } });
  }

  pending(target: Identity): boolean {
    const record = this.find(target);
    return record !== undefined && record.failure === undefined;
  }

  has(target: Identity): boolean {
    return this.find(target) !== undefined;
  }

  retry(target: Identity): boolean {
    const record = this.find(target);
    if (!record || record.failure === undefined) return false;
    delete record.failure;
    return true;
  }

  fail(target: Identity, reason = 'The operating system could not end the session.'): boolean {
    const record = this.find(target);
    if (!record || record.failure === reason) return false;
    record.failure = reason;
    return true;
  }

  remove(target: Identity): boolean {
    return this.find(target) !== undefined && this.records.delete(target.pid);
  }

  /** Native admission of a new occupant proves the previous process is gone. */
  retireReplaced(target: Identity): boolean {
    const record = this.records.get(target.pid);
    return (
      record !== undefined &&
      record.card.startedAt !== target.startedAt &&
      this.records.delete(target.pid)
    );
  }

  snapshot(): Session[] {
    return [...this.records.values()].map(({ card, failure }) => ({
      ...card,
      closing: failure === undefined ? true : undefined,
      endStuck: failure === undefined ? undefined : true,
      endFailure: failure
    }));
  }

  clear(): void {
    this.records.clear();
  }

  private find(target: Identity): Ending | undefined {
    const record = this.records.get(target.pid);
    return record?.card.startedAt === target.startedAt ? record : undefined;
  }
}
