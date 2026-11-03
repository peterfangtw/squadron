import * as crypto from 'node:crypto';
import type { FetchFileIdentity } from '../core/bridge/model';
import type { Messenger } from '../core/bridge/port';
import * as rig from './remote/incoming_bridge_helpers';

export async function make(cwd: string, options: Parameters<typeof rig.make>[1] = {}) {
  const t = await rig.make(cwd, options);
  const service = await import('../core/remote/incoming');
  const changed = new Set<() => void>();
  const calls: string[] = [];
  let body: Buffer = Buffer.from('actual local bytes');
  const provider: NonNullable<Messenger['incomingFiles']> = {
    version: 1,
    installId: 'install',
    verify: (file) => {
      calls.push(`verify:${file.id}`);
      return Promise.resolve(file.source === `opaque:install:${file.id.replace('file-', '')}`);
    },
    refusal: () => 'provider-unavailable',
    metadata: (file) => {
      calls.push(`metadata:${file.id}`);
      return Promise.resolve({
        name: '../../untrusted.txt',
        mime: 'text/plain',
        size: body.length
      });
    },
    download: (file) => {
      calls.push(`download:${file.id}`);
      return Promise.resolve(
        (async function* () {
          yield await Promise.resolve(body);
        })()
      );
    }
  };
  const messenger: Omit<typeof t.messenger, 'incomingFiles'> & {
    incomingFiles: Messenger['incomingFiles'];
  } = { ...t.messenger, incomingFiles: provider };
  const files = new service.IncomingFiles({
    bridge: t.bridge,
    verbs: t.verbs,
    messenger,
    onEvidenceChanged: (listener) => {
      changed.add(listener);
      return () => changed.delete(listener);
    }
  });
  return {
    ...t,
    files,
    provider,
    messenger,
    calls,
    changed,
    wake() {
      for (const listener of changed) listener();
    },
    bytes(bytes: Buffer) {
      body = bytes;
    },
    identity(view: Awaited<ReturnType<typeof t.view>>, child = t.started[0]): FetchFileIdentity {
      if (!child || 'denied' in view.admission)
        throw new Error('native receiver/admission missing');
      return {
        holder: t.holder,
        receiver: child.owner.receiverIdentity,
        currentSessionId: child.handle.state.sessionId!,
        conversation: view.conversation,
        correlation: view.correlation,
        fileId: view.admission.files[0]!.id
      };
    },
    fetch(identity: FetchFileIdentity, signal?: AbortSignal) {
      return files.fetch({ requestId: crypto.randomUUID(), identity, signal });
    },
    async close() {
      files.dispose();
      await t.close();
    }
  };
}
export async function waitForFile(
  t: Awaited<ReturnType<typeof make>>,
  extension: string
): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = (await fs.readdir(t.capability.localRoot)).find((name) =>
      name.endsWith(extension)
    );
    if (found) return path.join(t.capability.localRoot, found);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no ${extension} cache entry`);
}
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1kAAAAASUVORK5CYII=',
  'base64'
);
