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

export function historyState(
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
