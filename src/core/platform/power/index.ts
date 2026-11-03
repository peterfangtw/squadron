import { unsupported, type Result, type Unsupported } from '../unsupported';

/** The machine's power, as much of it as anything here asks about. */
export type Reading = {
  /** Battery charge, 0–100. */
  pct: number;
  /** On mains. A machine on AC is never running its battery down, whatever the
   *  charge reads — a laptop at 8% and charging is not the case we release for. */
  onAC: boolean;
};

/** A started sleep-lock child, as much of it as a hold needs. */
export interface Child {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: () => void): unknown;
  kill(): unknown;
}

/**
 * The OS tools a backend runs. Production passes Node's `execFile` and
 * `spawn`; a test passes recorded output and a fake child.
 */
export interface Effects {
  /** One bounded run; stdout, or a rejection for any failure or the timeout. */
  run(file: string, args: readonly string[], options: { timeout: number }): Promise<string>;
  /** Start `file` with stdio ignored. */
  spawn(file: string, args: readonly string[]): Child;
}

/** One sleep lock this window took. */
export interface Lease {
  /** Drop it now. Its end still arrives through `onEnded`. */
  release(): void;
  /** It could not be taken. The reason names the tool. */
  onFailed(listener: (reason: string) => void): void;
  /** It is gone: the lease ran out, the host pid exited, or it was released. */
  onEnded(listener: () => void): void;
}

export interface Power {
  /** Whether `hold` can take a lock on this OS, answered with no effect, so a
   *  caller can refuse before it reads or spawns anything. */
  readonly holds: { supported: true } | Unsupported;
  /**
   * The battery, read now. `ok` with no value is a machine with no battery
   * line, or a report whose shape moved: no opinion, never a flat battery.
   * Never throws.
   */
  read(): Promise<Result<Reading | undefined>>;
  /**
   * Keep idle system sleep off for `leaseMs`, or until `hostPid` exits,
   * whichever is first — two brakes, each covering a failure the other does
   * not (`docs/reference/macos_power.md`). Never throws.
   */
  hold(leaseMs: number, hostPid: number): Lease | Unsupported;
}

/** No sleep lock and no battery reading on `os`. Inert: nothing is read or
 *  started, whatever is asked. */
export function refused(os: NodeJS.Platform, reason: string): Power {
  const holds = unsupported('power.hold', os, reason);
  const reads = unsupported('power.read', os, reason);
  return {
    holds,
    read: () => Promise.resolve(reads),
    hold: () => holds
  };
}
