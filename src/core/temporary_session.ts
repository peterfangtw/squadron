import type { SessionTransport } from './session';
import { SessionLifetime } from './session_lifetime';
import type { TreeMember } from './control';

export type TemporaryRead = {
  signal?: AbortSignal;
  starting?(): Promise<void>;
  remember?(this: void, members: readonly TreeMember[]): Promise<void>;
};

/** Temporary requests retain native ownership even after their protocol has answered. */
export async function withTemporarySession<T>(
  transport: SessionTransport,
  read: (transport: SessionTransport) => Promise<T>,
  options: TemporaryRead = {}
): Promise<T> {
  const lifetime = ownTemporarySession(transport, options);
  const abort = (): void => lifetime.closePipes();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    await lifetime.capture();
    options.signal?.throwIfAborted();
    return await read(transport);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if ((await lifetime.close()) !== 'gone') await lifetime.terminated;
  }
}

export function ownTemporarySession(
  transport: SessionTransport,
  options: TemporaryRead = {}
): SessionLifetime {
  return new SessionLifetime(transport, {
    remember: (members) => {
      // An unreadable process scan does not mean the child never existed.
      const observed =
        transport.pid === undefined || members.some((member) => member.pid === transport.pid)
          ? members
          : [...members, { pid: transport.pid, startedAt: 0 }];
      return options.remember?.(observed) ?? Promise.resolve();
    }
  });
}
