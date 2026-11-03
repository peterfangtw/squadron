import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { SessionHandle } from '../../core/adapter';
import type { IncomingHost, OwnedIncoming } from '../../core/owned_incoming';
import type { BrandId } from '../../core/model';
import type { RemoteFilesStart } from '../../core/coordination/serve_owned';
import type { IncomingHolder, LaunchAttempt } from '../../core/bridge/model';
import { outRoot } from '../helpers';
import * as executables from '../../core/platform/executables';

/** Real fake-CLI pipes; all evidence is minted by the production activation/entry owners. */
export async function child(host: IncomingHost, brand: BrandId, cwd: string, resume?: string) {
  const adapters = await import('../../core/adapter');
  const transportModule = await import('../../core/session');
  const published = await import('../../core/published');
  const live = await import('../../core/live');
  const routes = await import('../../core/coordination/route');
  const cli = adapters.adapter(brand);
  assert.ok(cli);
  const binary = path.join(
    outRoot(),
    'test',
    'fixtures',
    brand === 'claude' ? 'fake-cli.js' : brand === 'grok' ? 'fake-acp.js' : 'fake-codex.js'
  );
  const sessionId = resume ?? crypto.randomUUID();
  const launch = cli.launch({
    bin: executables.named(binary, process.execPath),
    cwd,
    sessionId,
    resume,
    skipPermissions: false
  });
  const transport = transportModule.childTransport({
    bin: launch.bin,
    args: launch.args,
    env: launch.env,
    cwd,
    terminateOnClose: true
  });
  let current = true;
  let connected: SessionHandle | undefined;
  try {
    const startedAt = Date.now();
    const handle = cli.connect(transport, {
      cwd,
      startedAt,
      sessionId,
      resume,
      skipPermissions: false
    });
    connected = handle;
    assert.equal((await handle.opening).ok, true);
    const owner = await host.capture(transport, handle, brand, () => current);
    assert.ok(owner);
    const pid = transport.pid;
    assert.ok(pid);
    const publish = () =>
      published.publishLive(
        {
          ...owner.snapshot(),
          schema: 1,
          session: live.toSession(
            handle.state,
            { pid, startedAt, brand, updatedAt: Date.now() },
            owner.receiverIdentity.host.windowId
          ),
          pending: handle.state.pending,
          queued: handle.state.queued.map(({ id, text, queuedAt }) => ({ id, text, queuedAt })),
          messageFacts: handle.state.messageFacts,
          exit: handle.state.exit
        },
        true
      );
    const route = routes.routeTo({ owned: handle });
    assert.ok(!routes.isRefused(route) && route.messages);
    return {
      owner,
      handle,
      transport,
      publish,
      pid,
      startedAt,
      route,
      remove() {
        current = false;
        transport.close();
        handle.close();
      },
      async close() {
        current = false;
        transport.close();
        handle.close();
        await transport.exited;
        await handle.flush?.();
        await published.removePublished(pid);
      }
    };
  } catch (error) {
    current = false;
    transport.close();
    connected?.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    throw error;
  }
}

export function attempt(
  owner: OwnedIncoming,
  holder: IncomingHolder,
  changes: Partial<LaunchAttempt> = {}
): LaunchAttempt {
  return {
    version: 1,
    attemptId: crypto.randomUUID(),
    conversation: 'conversation',
    messageId: 'original',
    correlation: 'correlation',
    admissionDigest: 'a'.repeat(64),
    host: owner.receiverIdentity.host,
    cwd: owner.receiverIdentity.cwd,
    target: { brand: owner.receiverIdentity.brand },
    selection: 'default',
    holder,
    createdAt: Date.now(),
    ...changes
  };
}

export function files(
  attempt: LaunchAttempt,
  localRoot: string,
  prompt = 'inspect it'
): RemoteFilesStart {
  return { version: 1, expectedHost: attempt.host, attempt, localRoot, prompt };
}

export async function until(
  handle: SessionHandle,
  predicate: (handle: SessionHandle) => boolean
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate(handle) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    predicate(handle),
    `native fixture did not reach expected state: ${JSON.stringify(handle.state)}`
  );
}
