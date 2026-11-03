/**
 * Every PowerShell one Windows backend started, and the one admission to
 * start another, for as long as that backend lives (`win32.ts` `processes`).
 * One-shot runs and every reusable reader share it, so a lease that ends, a
 * reader that is replaced, or a one-shot still running when a lease begins
 * never escapes the bound.
 *
 * The bound: at most one child at a time, backend-wide. A start reserves the
 * slot atomically (`admit` resolves a `Slot` only when nothing is reserved,
 * running or ending), so two starts cannot both pass, and a leased read that
 * needs a child waits for an active one-shot to close: that is the handoff
 * from one-shot to owned. A reader reusing its own running child asks for
 * nothing, so it never waits on itself. Once a child's ending begins it still
 * holds the slot; a child open past its ender's deadline is unresolved and
 * refuses every start, with its pid, until its `close` arrives. Its handle stays
 * here and every unresolved pid is reported, whichever read started it.
 *
 * Waiting is bounded before it begins: past `MAX_WAITING` an admission is
 * refused as busy at once. A waiter whose reader is disposed leaves the queue.
 */

/** Admissions waiting at once. `scan` shares one read per burst, so more is a fault. */
export const MAX_WAITING = 16;

export type Tracked = {
  /** Ending began. `settled` is true on close, false at the ender's deadline. */
  ending(settled: Promise<boolean>): void;
  /** Its `close` arrived: the slot is free. */
  closed(): void;
};

/** The reserved right to start one child. */
export type Slot = {
  /** The child that took the slot, held until it closes. */
  started(child: { readonly pid?: number }): Tracked;
  /** Nothing started (a spawn that threw): the slot is free again. */
  release(): void;
};

export type Children = {
  /**
   * The slot once no child holds it, or why not: one did not close, too many
   * are waiting, or `signal` was aborted while this waited.
   */
  admit(signal?: AbortSignal): Promise<Slot | string>;
  /** Every child whose ending deadline passed before its close, by pid. */
  unresolved(): number[];
};

type Entry = {
  child?: { readonly pid?: number };
  state: 'reserved' | 'running' | 'ending' | 'unresolved';
};

export function children(): Children {
  const entries = new Set<Entry>();
  let waiting = 0;
  let wake: Array<() => void> = [];
  const changed = () => {
    const woken = wake;
    wake = [];
    for (const resume of woken) resume();
  };
  const stuck = () => [...entries].find((entry) => entry.state === 'unresolved');
  const refusal = (entry: Entry) =>
    `process reader ${entry.child?.pid ?? 0} did not close; starting no other until it does`;

  return {
    async admit(signal) {
      const first = stuck();
      if (first) return refusal(first);
      if (entries.size > 0 && waiting >= MAX_WAITING) return 'process reader busy';
      waiting += 1;
      try {
        for (;;) {
          const blocked = stuck();
          if (blocked) return refusal(blocked);
          if (signal?.aborted) return 'process reader disposed';
          if (entries.size === 0) return reserve();
          await new Promise<void>((resume) => {
            const abort = () => resume();
            wake.push(() => {
              signal?.removeEventListener('abort', abort);
              resume();
            });
            signal?.addEventListener('abort', abort, { once: true });
          });
        }
      } finally {
        waiting -= 1;
      }
    },
    unresolved: () =>
      [...entries]
        .filter((entry) => entry.state === 'unresolved')
        .map((entry) => entry.child?.pid ?? 0)
  };

  function reserve(): Slot {
    const entry: Entry = { state: 'reserved' };
    entries.add(entry);
    const free = () => {
      if (entries.delete(entry)) changed();
    };
    return {
      started(child) {
        entry.child = child;
        entry.state = 'running';
        return {
          ending(settled) {
            if (!entries.has(entry) || entry.state !== 'running') return;
            entry.state = 'ending';
            void settled.then((closed) => {
              if (closed) free();
              else if (entries.has(entry)) {
                entry.state = 'unresolved';
                changed();
              }
            });
          },
          closed: free
        };
      },
      release() {
        if (entry.state === 'reserved') free();
      }
    };
  }
}
