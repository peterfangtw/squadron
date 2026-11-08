import type { SessionHandle } from './adapter';
import type { Thread } from './thread';

/** Resume-only adapter readiness. Recovery supplies a non-rejecting result;
 *  release the latch before the adapter reconciles frames and drains. */
export function recoveryGate(
  resuming: boolean,
  recovered: Promise<boolean>,
  released: () => void
): () => boolean {
  let pending = resuming;
  if (resuming) {
    void recovered.then(() => {
      pending = false;
      released();
    });
  }
  return () => pending;
}

/** An owned session's `SessionHandle.thread`: its memory, read live, and the
 *  resume's history state, which the dock shows until recovery settles. */
export function threadPort(
  memory: Thread,
  resuming: boolean,
  recovered: Promise<boolean>
): SessionHandle['thread'] {
  const state = historyState(resuming, recovered);
  return {
    get historyState() {
      return state();
    },
    generation: () => memory.current.generation,
    snapshot: () => memory.snapshot(),
    recovered,
    onChange: (listener) => memory.onChange(listener)
  };
}

function historyState(
  resuming: boolean,
  recovered: Promise<boolean>
): () => 'loading' | 'failed' | undefined {
  let state: 'loading' | 'failed' | undefined = resuming ? 'loading' : undefined;
  if (resuming)
    void recovered.then((ok) => {
      state = ok ? undefined : 'failed';
    });
  return () => state;
}
