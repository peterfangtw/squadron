import * as platform from '../platform';
import type { Checked, Created, Identity } from '../platform/private_files';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as incoming from '../incoming';
import type {
  IncomingAccess,
  IncomingAdmission,
  IncomingFile,
  IncomingRefusal,
  ReceiverIdentity
} from '../bridge/model';

const FILE_BYTES = incoming.INCOMING_FILE_MAX_BYTES;
const RECEIVER_BYTES = 100 * 1024 * 1024;
const MACHINE_BYTES = 500 * 1024 * 1024;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'sqincoming-v1-';
const READER_SUFFIXES = ['', '.png', '.jpg', '.gif', '.webp', '.pdf'] as const;
const BYTES_END = /\.bytes(?:\.(?:png|jpg|gif|webp|pdf))?$/;
const MANAGED_NAME =
  /^(sqincoming-v1-[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f-]{36})\.(reserve|partial|bytes(?:\.(?:png|jpg|gif|webp|pdf))?|json|manifest)$/;
const MAX_ENTRIES = 4096;
const MANIFEST_BYTES = 4096;
const queues = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
const active = new Set<string>();
const materializing = new Set<Promise<unknown>>();

export class CacheRefusal extends Error {
  constructor(readonly code: IncomingRefusal) {
    super(code);
  }
}
export type CachedFile = {
  path: string;
  bytes: number;
  expiresAt: number;
  name?: string;
  mime?: string;
};
type Manifest = CachedFile & { version: 1; key: string; receiver: string; hash: string };
export type Reservation = {
  root: string;
  base: string;
  receiver: string;
  key: string;
  partial: string;
  reservation: string;
  rootIdentity: Identity;
};

/** Local bytes only. Every returned entry still requires the fetch owner's authorization. */
export class IncomingCache {
  async drain(): Promise<void> {
    await Promise.allSettled([...materializing, ...queues.values()]);
    await Promise.allSettled([...queues.values()]);
  }

  /** Called only by the exclusive holder, after prior local writes drain at takeover. */
  async sweep(capability: IncomingAccess): Promise<void> {
    const root = await checkedRoot(capability);
    await serial(root, async () => {
      const snapshot = await rootSnapshot(root);
      const names = await inventory(root);
      const groups = new Map<string, string[]>();
      for (const name of names) {
        const base = MANAGED_NAME.exec(name)?.[1];
        if (!base) throw new CacheRefusal('storage-unavailable');
        const group = groups.get(base) ?? [];
        group.push(name);
        groups.set(base, group);
      }
      for (const [base, group] of groups) {
        if (active.has(base)) continue;
        const manifestName = `${base}.json`;
        let keepPath: string | undefined;
        if (names.includes(manifestName)) {
          const manifest = await readManifest(root, manifestName);
          if (manifest.expiresAt > Date.now()) keepPath = manifest.path;
        }
        for (const name of group) {
          if (keepPath && (name === `${base}.json` || path.join(root, name) === keepPath)) continue;
          const file = path.join(root, name);
          await sameRoot(snapshot);
          await safeStat(file);
          await fs.unlink(file);
        }
      }
      changed();
    });
  }
  onChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async find(
    capability: IncomingAccess,
    admission: IncomingAdmission,
    file: IncomingFile,
    receiver: ReceiverIdentity
  ): Promise<CachedFile | undefined> {
    const root = await checkedRoot(capability);
    const key = cacheId(admission, file, receiver);
    return serial(root, async () => {
      const names = await inventory(root);
      for (const name of names.filter((name) => name.endsWith('.json'))) {
        const manifest = await readManifest(root, name);
        if (manifest.key !== key) continue;
        const bytesPath = manifest.path;
        if (manifest.expiresAt <= Date.now()) {
          await removePair(root, name);
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = await readSafe(bytesPath, FILE_BYTES);
        } catch (error) {
          if (missing(error)) {
            await fs.unlink(path.join(root, name));
            continue;
          }
          throw error;
        }
        if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.hash)
          throw new CacheRefusal('invalid-path');
        return {
          path: bytesPath,
          bytes: manifest.bytes,
          expiresAt: manifest.expiresAt,
          ...(manifest.name ? { name: manifest.name } : {}),
          ...(manifest.mime ? { mime: manifest.mime } : {})
        };
      }
      return undefined;
    });
  }

  async validate(capability: IncomingAccess, entry: CachedFile): Promise<void> {
    const root = await checkedRoot(capability);
    if (path.dirname(entry.path) !== root) throw new CacheRefusal('invalid-path');
    const manifest = await readManifest(root, manifestName(entry.path));
    const bytes = await readSafe(entry.path, FILE_BYTES);
    if (
      manifest.expiresAt <= Date.now() ||
      entry.bytes !== bytes.length ||
      manifest.bytes !== bytes.length ||
      digest(bytes) !== manifest.hash
    )
      throw new CacheRefusal('invalid-path');
    await checkedRoot(capability);
  }

  async renew(
    capability: IncomingAccess,
    entry: CachedFile,
    signal: AbortSignal,
    allowed: () => boolean
  ): Promise<CachedFile> {
    const root = await checkedRoot(capability);
    return serial(root, async () => {
      const snapshot = await rootSnapshot(root);
      await this.validate(capability, entry);
      const name = manifestName(entry.path);
      const manifest = await readManifest(root, name);
      const expiresAt = Date.now() + EXPIRY_MS;
      const body = JSON.stringify({ ...manifest, expiresAt });
      if (Buffer.byteLength(body) > MANIFEST_BYTES) throw new CacheRefusal('storage-unavailable');
      const temporary = path.join(
        root,
        `${PREFIX}${manifest.receiver}-${manifest.key}-${crypto.randomUUID()}.manifest`
      );
      let created = false;
      let landed = false;
      try {
        await sameRoot(snapshot);
        if (signal.aborted || !allowed()) throw new CacheRefusal('closed');
        const handle = await createPrivate(temporary, signal);
        created = true;
        try {
          await handle.write(Buffer.from(body));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await sameRoot(snapshot);
        if (signal.aborted || !allowed()) throw new CacheRefusal('closed');
        await platform.files.replace(temporary, path.join(root, name), { kind: 'owned' });
        created = false;
        landed = true;
        await sameRoot(snapshot);
        if (signal.aborted || !allowed()) throw new CacheRefusal('closed');
        return { ...entry, expiresAt };
      } catch (error) {
        if (landed) {
          // The accounting queue still excludes a later hit; failed renewal cannot extend byte lifetime.
          try {
            await sameRoot(snapshot);
            const rollback = await createPrivate(temporary);
            created = true;
            try {
              await rollback.write(Buffer.from(JSON.stringify(manifest)));
              await rollback.sync();
            } finally {
              await rollback.close();
            }
            await sameRoot(snapshot);
            await platform.files.replace(temporary, path.join(root, name), { kind: 'owned' });
            created = false;
          } catch {
            await sameRoot(snapshot)
              .then(() => removePair(root, name))
              .catch(() => {});
          }
        }
        throw error;
      } finally {
        if (created)
          await sameRoot(snapshot)
            .then(() => fs.unlink(temporary))
            .catch(() => {});
      }
    });
  }

  async reserve(
    capability: IncomingAccess,
    admission: IncomingAdmission,
    file: IncomingFile,
    receiver: ReceiverIdentity
  ): Promise<Reservation | undefined> {
    const root = await checkedRoot(capability);
    const receiverId = digest(JSON.stringify(receiver));
    return serial(root, async () => {
      const snapshot = await rootSnapshot(root);
      const names = await inventory(root);
      const reservations = new Map<string, string>();
      let total = 0,
        own = 0,
        running = 0,
        ownRunning = 0;
      for (const name of names.filter((name) => name.endsWith('.reserve'))) {
        const raw: unknown = JSON.parse(
          (await readSafe(path.join(root, name), MANIFEST_BYTES)).toString('utf8')
        );
        if (
          !isRecord(raw) ||
          raw.version !== 1 ||
          !incoming.incomingDigest(raw.receiver) ||
          raw.bytes !== FILE_BYTES ||
          !name.startsWith(`${PREFIX}${raw.receiver}-`)
        )
          throw new CacheRefusal('storage-unavailable');
        reservations.set(name.replace(/\.reserve$/, ''), raw.receiver);
        total += FILE_BYTES;
        running++;
        if (raw.receiver === receiverId) {
          own += FILE_BYTES;
          ownRunning++;
        }
        let present = 0;
        const base = name.replace(/\.reserve$/, '');
        for (const content of names.filter(
          (entry) => entry === `${base}.partial` || managedBytesBase(entry) === base
        )) {
          const stat = await safeStat(path.join(root, content)).catch((error: unknown) => {
            if (missing(error)) return undefined;
            throw error;
          });
          present += stat?.size ?? 0;
        }
        const excess = Math.max(0, present - FILE_BYTES);
        total += excess;
        if (raw.receiver === receiverId) own += excess;
      }
      for (const name of names.filter((name) => name.endsWith('.json'))) {
        const manifest = await readManifest(root, name);
        if (manifest.expiresAt <= Date.now()) {
          await removePair(root, name);
          continue;
        }
        const stat = await safeStat(manifest.path).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (!stat) {
          await fs.unlink(path.join(root, name));
          continue;
        }
        total += stat.size;
        if (manifest.receiver === receiverId) own += stat.size;
      }
      // Orphan bytes and partials remain charged; cleanup after takeover belongs to the holder lifecycle.
      for (const name of names.filter(
        (name) => name.endsWith('.partial') || managedBytesBase(name) !== undefined
      )) {
        const base = managedBytesBase(name) ?? name.replace(/\.partial$/, '');
        if (reservations.has(base) || names.includes(`${base}.json`)) continue;
        const stat = await safeStat(path.join(root, name));
        total += stat.size;
        if (base.startsWith(`${PREFIX}${receiverId}-`)) own += stat.size;
      }
      if (total + FILE_BYTES > MACHINE_BYTES || own + FILE_BYTES > RECEIVER_BYTES)
        throw new CacheRefusal('capacity');
      if (names.length + 5 > MAX_ENTRIES) throw new CacheRefusal('capacity');
      if (running >= 4 || ownRunning >= 2) return undefined;
      const base = `${PREFIX}${receiverId}-${cacheId(admission, file, receiver)}-${crypto.randomUUID()}`;
      const reservation = path.join(root, `${base}.reserve`);
      const handle = await createPrivate(reservation);
      try {
        await handle.write(
          Buffer.from(JSON.stringify({ version: 1, receiver: receiverId, bytes: FILE_BYTES }))
        );
        await handle.sync();
      } catch (error) {
        await fs.unlink(reservation).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      await sameRoot(snapshot);
      active.add(base);
      return {
        root,
        base,
        receiver: receiverId,
        key: cacheId(admission, file, receiver),
        partial: path.join(root, `${base}.partial`),
        reservation,
        rootIdentity: snapshot.rootIdentity
      };
    });
  }

  materialize(
    reservation: Reservation,
    stream: AsyncIterable<Uint8Array>,
    signal: AbortSignal
  ): Promise<{ bytes: number; hash: string }> {
    const work = this.materializeLocal(reservation, stream, signal);
    materializing.add(work);
    void work.finally(() => materializing.delete(work)).catch(() => {});
    return work;
  }

  private async materializeLocal(
    reservation: Reservation,
    stream: AsyncIterable<Uint8Array>,
    signal: AbortSignal
  ): Promise<{ bytes: number; hash: string }> {
    await sameRoot(reservation);
    let handle: Created | undefined;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await nextChunk(iterator, signal);
        if (signal.aborted) throw new CacheRefusal('closed');
        if (
          !next.done &&
          (!(next.value instanceof Uint8Array) || bytes + next.value.byteLength > FILE_BYTES)
        )
          throw new CacheRefusal('too-large');
        if (!handle) {
          await sameRoot(reservation);
          handle = await createPrivate(reservation.partial, signal);
        }
        if (next.done) break;
        const chunk = next.value;
        bytes += chunk.byteLength;
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (signal.aborted) throw new CacheRefusal('closed');
      if (!handle) throw new CacheRefusal('invalid-path');
      await handle.sync();
      const bound = await handle.bound(reservation.partial);
      if (bound.status !== 'ok' || bound.value !== bytes) throw new CacheRefusal('invalid-path');
      return { bytes, hash: hash.digest('hex') };
    } finally {
      await handle?.close();
      if (iterator.return)
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => {});
    }
  }

  async publish(
    reservation: Reservation,
    content: { bytes: number; hash: string },
    metadata: { name?: string; mime?: string },
    signal: AbortSignal,
    allowed: () => boolean
  ): Promise<CachedFile> {
    return serial(reservation.root, async () => {
      await sameRoot(reservation);
      const bytes = await readSafe(reservation.partial, FILE_BYTES);
      if (bytes.length !== content.bytes || digest(bytes) !== content.hash)
        throw new CacheRefusal('invalid-path');
      if (signal.aborted || !allowed()) throw new CacheRefusal('closed');
      const bytesPath = path.join(
        reservation.root,
        `${reservation.base}.bytes${readerSuffix(bytes)}`
      );
      const manifest: Manifest = {
        version: 1,
        key: reservation.key,
        receiver: reservation.receiver,
        path: bytesPath,
        ...content,
        ...metadata,
        expiresAt: Date.now() + EXPIRY_MS
      };
      const manifestBody = JSON.stringify(manifest);
      if (Buffer.byteLength(manifestBody) > MANIFEST_BYTES)
        throw new CacheRefusal('storage-unavailable');
      await sameRoot(reservation);
      const manifestPath = path.join(reservation.root, `${reservation.base}.json`);
      // UUID names are create-only. Link publishes the complete inode without overwriting a neighbor.
      const manifestPartial = path.join(reservation.root, `${reservation.base}.manifest`);
      try {
        await fs.link(reservation.partial, bytesPath);
        await fs.unlink(reservation.partial);
        const handle = await createPrivate(manifestPartial, signal);
        try {
          await handle.write(Buffer.from(manifestBody));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.link(manifestPartial, manifestPath);
        await fs.unlink(manifestPartial);
        await sameRoot(reservation);
        if (signal.aborted || !allowed()) throw new CacheRefusal('closed');
        await fs.unlink(reservation.reservation);
        changed();
        return {
          path: bytesPath,
          bytes: content.bytes,
          expiresAt: manifest.expiresAt,
          ...metadata
        };
      } catch (error) {
        await fs.unlink(bytesPath).catch(() => {});
        await fs.unlink(manifestPath).catch(() => {});
        throw error;
      }
    });
  }

  async release(reservation: Reservation): Promise<void> {
    await serial(reservation.root, async () => {
      await sameRoot(reservation);
      await fs.unlink(reservation.partial).catch(() => {});
      await fs.unlink(reservation.reservation).catch(() => {});
      await fs.unlink(path.join(reservation.root, `${reservation.base}.manifest`)).catch(() => {});
      changed();
    }).catch(() => {});
    active.delete(reservation.base);
  }

  async discard(reservation: Reservation): Promise<void> {
    await serial(reservation.root, async () => {
      await sameRoot(reservation);
      await removePair(reservation.root, `${reservation.base}.json`);
      changed();
    }).catch(() => {});
  }
}

async function createPrivate(file: string, signal?: AbortSignal) {
  const created = await platform.privateFiles.create(file, 'managed-file', signal);
  if (!created.supported || created.status !== 'ok') throw new CacheRefusal('invalid-path');
  return created.value;
}

async function checkedRoot(capability: IncomingAccess): Promise<string> {
  const expected = await platform.privateFiles.dir();
  if (!expected.supported || expected.status !== 'ok' || capability.localRoot !== expected.value)
    throw new CacheRefusal('invalid-path');
  await managed(expected.value, 'managed-dir');
  return expected.value;
}
async function rootSnapshot(root: string): Promise<Pick<Reservation, 'root' | 'rootIdentity'>> {
  const checked = await managed(root, 'managed-dir');
  return { root, rootIdentity: checked.identity };
}
async function sameRoot(reservation: Pick<Reservation, 'root' | 'rootIdentity'>): Promise<void> {
  const now = await rootSnapshot(reservation.root);
  if (now.rootIdentity !== reservation.rootIdentity) throw new CacheRefusal('invalid-path');
}
function safeStat(file: string): Promise<Checked> {
  return managed(file, 'managed-file');
}
async function managed(file: string, purpose: 'managed-dir' | 'managed-file'): Promise<Checked> {
  const checked = await platform.privateFiles.check(file, purpose);
  if (!checked.supported || checked.status !== 'ok') throw new CacheRefusal('invalid-path');
  return checked.value;
}
async function readSafe(file: string, max: number): Promise<Buffer> {
  const read = await platform.privateFiles.read(file, 'managed-file', max);
  if (read.supported && read.status === 'ok') return read.value;
  throw new CacheRefusal(
    read.supported && read.fault === 'too-large' ? 'storage-unavailable' : 'invalid-path'
  );
}
async function inventory(root: string): Promise<string[]> {
  const names: string[] = [];
  const directory = await fs.opendir(root);
  for await (const entry of directory) {
    if (!entry.name.startsWith(PREFIX)) continue;
    if (!MANAGED_NAME.test(entry.name)) throw new CacheRefusal('storage-unavailable');
    names.push(entry.name);
    if (names.length > MAX_ENTRIES) throw new CacheRefusal('capacity');
  }
  return names;
}
async function readManifest(root: string, name: string): Promise<Manifest> {
  const raw: unknown = JSON.parse(
    (await readSafe(path.join(root, name), MANIFEST_BYTES)).toString('utf8')
  );
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    !incoming.incomingDigest(raw.key) ||
    !incoming.incomingDigest(raw.receiver) ||
    !incoming.incomingDigest(raw.hash) ||
    !Number.isSafeInteger(raw.bytes) ||
    typeof raw.bytes !== 'number' ||
    raw.bytes < 0 ||
    raw.bytes > FILE_BYTES ||
    typeof raw.expiresAt !== 'number' ||
    !Number.isSafeInteger(raw.expiresAt) ||
    raw.expiresAt <= 0 ||
    typeof raw.path !== 'string' ||
    path.dirname(raw.path) !== root ||
    managedBytesBase(path.basename(raw.path)) !== name.replace(/\.json$/, '') ||
    !name.startsWith(`${PREFIX}${raw.receiver}-${raw.key}-`) ||
    (raw.name !== undefined && !incoming.incomingString(raw.name, 512)) ||
    (raw.mime !== undefined && !incoming.incomingString(raw.mime, 128))
  )
    throw new CacheRefusal('storage-unavailable');
  return raw as Manifest;
}
async function removePair(root: string, name: string): Promise<void> {
  const base = name.replace(/\.json$/, '');
  for (const suffix of READER_SUFFIXES)
    await fs.unlink(path.join(root, `${base}.bytes${suffix}`)).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  await fs.unlink(path.join(root, name)).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
}

export function managedBytesBase(name: string): string | undefined {
  return BYTES_END.test(name) ? MANAGED_NAME.exec(name)?.[1] : undefined;
}

function manifestName(file: string): string {
  const base = managedBytesBase(path.basename(file));
  if (!base) throw new CacheRefusal('invalid-path');
  return `${base}.json`;
}

function readerSuffix(bytes: Buffer): string {
  // Claude Read dispatches by extension: the same PNG at .bytes returned text (2026-10-14).
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  const head = bytes.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return '.gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return '.webp';
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? '.pdf' : '';
}
export function cacheId(
  admission: IncomingAdmission,
  file: IncomingFile,
  receiver: ReceiverIdentity
): string {
  return digest(
    JSON.stringify([
      admission.messengerId,
      admission.installId,
      file.id,
      file.cacheKey,
      file.source,
      receiver
    ])
  );
}
function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function changed(): void {
  for (const listener of listeners) listener();
}
function serial<T>(root: string, step: () => Promise<T>): Promise<T> {
  // Concurrent fetches can both pass an awaited inventory before either reserves. Serialize only local accounting.
  const previous = queues.get(root) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(step);
  queues.set(root, result);
  void result
    .finally(() => {
      if (queues.get(root) === result) queues.delete(root);
    })
    .catch(() => {});
  return result;
}

async function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) throw new CacheRefusal('closed');
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new CacheRefusal('closed'));
  });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([iterator.next(), interrupted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
