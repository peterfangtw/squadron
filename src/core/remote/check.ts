/**
 * The setup check's runner: asks the chosen messenger whether its stored
 * credentials would connect, one check at a time, and holds what it found.
 * Every effect is a port, as `switch.ts`'s are, so `host/remote.ts` runs this
 * over `SecretStorage` and a test runs it over values it holds.
 *
 * **A result belongs to the credentials it ran under.** Each start is tagged
 * with the generation current when it began; a change of credentials or of
 * messenger bumps the generation, aborts the check in flight and forgets the
 * last result, so a finish from before the change is dropped rather than
 * drawn over the new tokens.
 *
 * **A change event is checked against the credentials, not trusted as one.**
 * The store fires it in every window, this one's own paste included, and
 * whether before or after `store` resolves is not observed; a write of an
 * unchanged value may fire none at all. So each check keeps a digest of the
 * credentials it read, and an event re-reads them and invalidates only when
 * the digest differs.
 */

import { createHash } from 'crypto';
import type { Credentials, MessengerEntry, SetupCheck, SetupRow } from '../bridge/port';
import * as link from './link';
import type { CheckState } from './link';

/** Everything the runner reaches outside itself. */
export type CheckPort = {
  /** The messenger the settings choose. */
  entry(): MessengerEntry;
  /** Each stored credential of `entry`'s fields. */
  credentials(entry: MessengerEntry): Promise<Credentials>;
  /** The space setting, which an ok check that found one fills while it is
   *  empty. A set one is the reader's and is never overwritten. Absent: the
   *  runner fills nothing. */
  space?: { read(): string | undefined; fill(space: string): Promise<void> };
  clock(): number;
  /** `state()` has moved. */
  changed(): void;
};

/** The reason when the credentials themselves cannot be read. No step is to
 *  blame: the store, not the messenger, failed. */
const UNREADABLE = 'The stored credentials could not be read. Check again.';

/** The reason when a messenger's check broke its promise never to reject. */
const BROKEN = 'The check failed before it could ask. Check again.';

/** The credentials the check in flight or the held result ran under, as a
 *  digest: undefined when they could not be read. In memory only, never on
 *  `CheckState`, so it is neither drawn, posted nor logged. */
type RanUnder = { digest: Promise<string | undefined> };

export class CheckRunner {
  private current: CheckState = { kind: 'never' };
  private generation = 0;
  /** The check in flight, which a change aborts. */
  private inFlight: AbortController | undefined;
  private under: RanUnder | undefined;
  private disposed = false;

  constructor(private readonly port: CheckPort) {}

  state(): CheckState {
    return this.current;
  }

  /**
   * Checks the chosen messenger, unless a check is in flight already or the
   * messenger offers none. Resolves once the result is held, or dropped
   * because a change overtook it.
   */
  async start(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    const entry = this.port.entry();
    const ask = entry.check?.bind(entry);
    if (!ask) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.inFlight = controller;
    const read = this.read(entry);
    this.under = { digest: read.then((credentials) => credentials && digest(entry, credentials)) };
    this.set({ kind: 'checking' });
    const result = await this.ask(read, ask, controller.signal);
    if (this.disposed || generation !== this.generation || !result) return;
    this.inFlight = undefined;
    this.set({ kind: 'result', result, at: this.port.clock() });
    if (result.kind === 'ok' && result.space !== undefined) await this.fill(entry, result.space);
  }

  /** Filled only while empty, read now rather than at the start: a reader's
   *  edit during the check stands. Never with a space the messenger's own
   *  rule refuses, which would only be drawn as unusable. A failed write
   *  leaves the row unset, which says so. */
  private async fill(entry: MessengerEntry, space: string): Promise<void> {
    const port = this.port.space;
    if (!port || port.read() !== undefined) return;
    if (entry.accounts.refuseSpace(space) !== undefined) return;
    await port.fill(space).catch(() => undefined);
  }

  /** The credentials or the messenger changed: what was found no longer
   *  holds, and what is being asked is asked of the wrong tokens. */
  invalidate(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = undefined;
    this.under = undefined;
    if (this.current.kind !== 'never') this.set({ kind: 'never' });
  }

  /** A secret changed, in any window: one of the chosen messenger's fields
   *  invalidates, once a re-read shows the credentials are not the ones the
   *  check in flight or the held result ran under. */
  async secretChanged(key: string): Promise<void> {
    const entry = this.port.entry();
    if (!entry.setup.fields.some((field) => link.secretKey(entry.id, field.key) === key)) return;
    const seen = this.under;
    if (!seen) return;
    const credentials = await this.read(entry);
    const now = credentials && digest(entry, credentials);
    const then = await seen.digest;
    // A check started since the event fired read the store after the write,
    // and this read may be older than its own.
    if (this.disposed || this.under !== seen) return;
    if (now === undefined || now !== then) this.invalidate();
  }

  /** Aborts the check in flight; nothing starts or lands after. */
  dispose(): void {
    this.disposed = true;
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  /** What the messenger said, redacted against the credentials it was
   *  handed, as `link.ts` redacts the link's reasons: a second guard behind
   *  the adapter's rule of naming no token. Undefined when a change overtook
   *  the read, which asks nothing. */
  private async ask(
    read: Promise<Credentials | undefined>,
    ask: NonNullable<MessengerEntry['check']>,
    signal: AbortSignal
  ): Promise<SetupCheck | undefined> {
    const credentials = await read;
    if (signal.aborted) return undefined;
    if (!credentials) return { kind: 'unreachable', reason: UNREADABLE };
    let found: SetupCheck;
    try {
      found = await ask(credentials, signal);
    } catch {
      found = { kind: 'unreachable', reason: BROKEN };
    }
    return redacted(found, Object.values(credentials));
  }

  /** The stored credentials, or undefined when the store cannot be read. */
  private read(entry: MessengerEntry): Promise<Credentials | undefined> {
    return this.port.credentials(entry).catch(() => undefined);
  }

  private set(next: CheckState): void {
    this.current = next;
    this.port.changed();
  }
}

/** sha256 over the messenger and its credentials, each field by name. */
function digest(entry: MessengerEntry, credentials: Credentials): string {
  const fields = Object.keys(credentials)
    .sort()
    .map((key) => [key, credentials[key]]);
  return createHash('sha256')
    .update(JSON.stringify([entry.id, fields]))
    .digest('hex');
}

/** `found` with every credential value cut out of its words. The runner's
 *  guard, and what the fake's check record writes. */
export function redacted(found: SetupCheck, values: readonly string[]): SetupCheck {
  const clean = (text: string) => link.redact(text, values);
  switch (found.kind) {
    case 'ok':
      return {
        kind: 'ok',
        facts: found.facts.map(({ label, value }): SetupRow => ({
          label: clean(label),
          value: clean(value)
        })),
        ...(found.space === undefined ? {} : { space: found.space })
      };
    case 'setup':
      return { kind: 'setup', step: found.step, reason: clean(found.reason) };
    case 'unreachable':
      return { kind: 'unreachable', reason: clean(found.reason) };
  }
}
