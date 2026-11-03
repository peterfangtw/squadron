/**
 * The host's last step on the way out, kept `vscode`-free so its order and its
 * bounds are tested (`host/extension.ts` `deactivate`).
 *
 * Every participant is named, and the whole is bounded by one budget:
 *
 * - A rejection cuts nothing short. Each participant that reads process
 *   evidence (`reader`: owned shutdown confirms its trees gone off the table)
 *   is waited for until it settles or `settleMs` has passed since shutdown
 *   began; only then is `release` asked, which for the host is its
 *   process-reader lease. Expiry is the only other way to the release.
 * - The release gets `releaseMs` of its own.
 * - Every other participant gets what is left of `settleMs`.
 *
 * Then everything is reported together, in input order and then the release:
 * each rejection, each participant still unsettled by name, a release that
 * failed or did not finish, and each reader child that did not close. Every
 * timer is cleared before this returns; nothing it started is waited on after.
 */

export type Participant = {
  name: string;
  done: Promise<unknown>;
  /** It reads the process table, so the reader is kept until it settles. */
  reader?: boolean;
  /** What inside it is still unsettled, named in its expiry report. */
  pending?: () => readonly string[];
};

export type Consumer = { name: string; done: Promise<unknown> };

/**
 * One participant for consumers known only once their owner starts: owned
 * shutdown's lifetime reconciliations, which read the process table for as
 * long as they run, past `closeAll`'s short host-facing bound. It settles once
 * `start` was given its consumers and every one has settled; one failing
 * does not stop the wait for the rest, and all failures reject it together.
 * Until then `pending` names those still running.
 */
export function drain(name: string): {
  participant: Participant;
  start(consumers: readonly Consumer[]): void;
} {
  const open = new Set<string>();
  let started = false;
  let begin: (consumers: readonly Consumer[]) => void = () => {};
  const done = new Promise<readonly Consumer[]>((resolve) => (begin = resolve)).then(
    async (consumers) => {
      const settled = await Promise.allSettled(
        consumers.map((consumer) => {
          open.add(consumer.name);
          return consumer.done.finally(() => open.delete(consumer.name));
        })
      );
      const failures = settled.flatMap((one) =>
        one.status === 'rejected' ? [one.reason as unknown] : []
      );
      if (failures.length > 0) throw new AggregateError(failures, `${name} failed`);
    }
  );
  return {
    participant: {
      name,
      done,
      reader: true,
      pending: () => (started ? [...open] : ['not started'])
    },
    start(consumers) {
      if (started) return;
      started = true;
      begin(consumers);
    }
  };
}

/** `promise`, or nothing once `ms` has passed: a bound, not a cancellation. */
export async function within(
  promise: Promise<unknown>,
  ms: number,
  timers: Timers = realTimers
): Promise<void> {
  let handle: unknown;
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => (handle = timers.set(resolve, ms)))
    ]);
  } finally {
    timers.clear(handle);
  }
}

export type Budget = {
  /** How long the report read gets before owned shutdown starts anyway. */
  notesMs: number;
  /** From shutdown's start, for every participant to settle. */
  settleMs: number;
  /** For the release itself. */
  releaseMs: number;
};

/**
 * `closeAll` bounds itself at 1.5 s after the report read; `settleMs` leaves it
 * that whole bound after `notesMs`, and is also how long the reader is kept
 * for lifetime cleanups still reading after it (`drain`). The total stays
 * under 5 s.
 */
/** `closeAll`'s own host-facing bound on its writes and cleanups. */
export const CLOSE_ALL_MS = 1_500;

export const SHUTDOWN_BUDGET: Budget = { notesMs: 500, settleMs: 2_500, releaseMs: 1_500 };

export type Timers = {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

/**
 * `next` once `first` settles, or once `ms` has passed without it: owned
 * shutdown starts even if the report read before it stalls.
 */
export function startAfter(
  first: Promise<unknown>,
  ms: number,
  next: () => Promise<unknown>,
  timers: Timers = realTimers
): Promise<unknown> {
  return new Promise<void>((go) => {
    const handle = timers.set(go, ms);
    const settled = () => {
      timers.clear(handle);
      go();
    };
    first.then(settled, settled);
  }).then(next);
}

type Outcome =
  { state: 'pending' } | { state: 'fulfilled' } | { state: 'rejected'; reason: unknown };

export async function settleThenRelease(
  participants: readonly Participant[],
  release: () => Promise<{ unresolved: readonly number[] } | undefined>,
  budget: Budget = SHUTDOWN_BUDGET,
  timers: Timers = realTimers
): Promise<void> {
  const handles: unknown[] = [];
  const after = (ms: number) =>
    new Promise<'expired'>((resolve) => handles.push(timers.set(() => resolve('expired'), ms)));
  const outcomes: Outcome[] = participants.map(() => ({ state: 'pending' }));
  const settled = participants.map((participant, at) =>
    participant.done.then(
      () => void (outcomes[at] = { state: 'fulfilled' }),
      (reason: unknown) => void (outcomes[at] = { state: 'rejected', reason })
    )
  );
  const expiry = after(budget.settleMs);
  const errors: unknown[] = [];
  try {
    await Promise.race([Promise.all(settled.filter((_, at) => participants[at]?.reader)), expiry]);
    const releasing = Promise.resolve()
      .then(release)
      .then(
        (disposal) => ({ disposal }),
        (error: unknown) => ({ error })
      );
    const released = await Promise.race([releasing, after(budget.releaseMs)]);
    await Promise.race([Promise.all(settled), expiry]);
    participants.forEach((participant, at) => {
      const outcome = outcomes[at];
      if (outcome?.state === 'rejected') errors.push(outcome.reason);
      else if (outcome?.state === 'pending') {
        const inner = participant.pending?.() ?? [];
        errors.push(
          new Error(
            `${participant.name} did not settle within ${budget.settleMs} ms` +
              (inner.length > 0 ? `: ${inner.join(', ')}` : '')
          )
        );
      }
    });
    if (released === 'expired')
      errors.push(new Error(`process reader release did not finish within ${budget.releaseMs} ms`));
    else if ('error' in released) errors.push(released.error);
    else if (released.disposal && released.disposal.unresolved.length > 0)
      errors.push(
        new Error(`process reader ${released.disposal.unresolved.join(', ')} did not close`)
      );
  } finally {
    for (const handle of handles) timers.clear(handle);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'shutdown did not finish cleanly');
}
