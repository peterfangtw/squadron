/** Short-lived Codex app-server connections used outside an owned session. */
import * as os from 'os';
import { codexBinary } from '../bin';
import { childTransport, type SessionTransport } from '../session';
import { ownTemporarySession } from '../temporary_session';
import type { TemporaryRead } from '../temporary_session';
import { CodexClient } from './client';

const CLIENT_INFO = { name: 'squadron', title: 'Squadron', version: '0' } as const;

export type CodexConnection = {
  client: CodexRpc;
  onExit(listener: () => void): void;
  close(): void;
  settled?(): Promise<void>;
};
export type CodexRpc = Pick<CodexClient, 'request' | 'notify' | 'onNotification'>;
export type CodexOpened = { ok: true; connection: CodexConnection } | { ok: false; reason: string };
export type CodexConnector = () => Promise<CodexOpened>;
export type CodexPathConnector = (override?: string) => Promise<CodexOpened>;

export async function initializeCodex(client: CodexClient, signal?: AbortSignal): Promise<void> {
  await client.request(
    'initialize',
    {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    },
    undefined,
    signal
  );
  client.notify('initialized');
}

export async function connectCodex(
  override?: string,
  requestMs = 4_000,
  options: TemporaryRead = {}
): ReturnType<CodexConnector> {
  const binary = await codexBinary(override);
  if (!binary.ok) return binary;
  if (options.signal?.aborted) return { ok: false, reason: 'Account read cancelled.' };
  await options.starting?.();
  if (options.signal?.aborted) return { ok: false, reason: 'Account read cancelled.' };
  return openCodex(
    childTransport({
      bin: binary.program,
      args: ['app-server', '--listen', 'stdio://'],
      cwd: os.homedir()
    }),
    requestMs,
    options
  );
}

export async function openCodex(
  transport: SessionTransport,
  requestMs = 4_000,
  options: TemporaryRead = {}
): Promise<CodexOpened> {
  const lifetime = ownTemporarySession(transport, options);
  const client = new CodexClient(transport, requestMs);
  const abort = (): void => lifetime.closePipes();
  options.signal?.addEventListener('abort', abort, { once: true });
  const settled = async (): Promise<void> => {
    options.signal?.removeEventListener('abort', abort);
    if ((await lifetime.close()) !== 'gone') await lifetime.terminated;
  };
  try {
    await lifetime.capture();
    await initializeCodex(client, options.signal);
    return {
      ok: true,
      connection: {
        client,
        onExit: (listener) => transport.onExit(() => listener()),
        close: () => {
          lifetime.closePipes();
          void settled();
        },
        settled
      }
    };
  } catch (error) {
    await settled();
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Codex app-server did not initialize'
    };
  }
}
