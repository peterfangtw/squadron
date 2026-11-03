import { unsupported } from '../unsupported';
import type { Success } from '../unsupported';
import { refusal, ReadRefusal, type Fault, type PrivateFiles } from './index';
import * as facility from './facility';
import * as fs from 'node:fs/promises';

export interface Effects {
  artifact(): Promise<facility.Artifact>;
  tmpdir(): string;
}

/** Each scope owns its helper children; an absent artifact route remains inert. */
export function privateFiles(effects?: Effects): PrivateFiles {
  const refuse = (operation: string) =>
    Promise.resolve(
      unsupported(`privateFiles.${operation}`, 'win32', 'no owner or file-identity check — W6.6')
    );
  if (!effects || process.arch !== 'x64')
    return {
      dispose: () => Promise.resolve(),
      dir: () => refuse('dir'),
      ensure: () => refuse('ensure'),
      check: () => refuse('check'),
      read: () => refuse('read'),
      create: () => refuse('create'),
      open: () => refuse('open')
    };
  let disposed = false;
  let pending: Promise<facility.Facility> | undefined;
  const owner = (): Promise<facility.Facility> => {
    if (disposed) return Promise.reject(new Error('private-files owner disposed'));
    return (pending ??= effects.artifact().then(async (artifact) => {
      const value = new facility.Facility(artifact);
      if (disposed) {
        await value.dispose();
        throw new Error('private-files owner disposed');
      }
      return value;
    }));
  };
  const dir = async () =>
    mapped(async () => {
      const scope = await owner();
      const root = await fs.realpath(effects.tmpdir());
      return scope.directory(root);
    });
  const start = async (
    file: string,
    operation: facility.Request['operation'],
    purpose: facility.Request['purpose'],
    maximum = Number.MAX_SAFE_INTEGER,
    signal?: AbortSignal
  ) =>
    (await owner()).start({
      path: file,
      operation,
      purpose,
      maximum,
      expires: new Date().getTime() + 120000,
      ...(signal ? { signal } : {})
    });
  return {
    async dispose() {
      disposed = true;
      const scope = await pending?.catch(() => undefined);
      await scope?.dispose();
    },
    dir,
    async ensure() {
      const located = await dir();
      if (located.status !== 'ok') return located;
      return mapped(async () => {
        await start(located.value, 'ensure', 'directory');
        return located.value;
      });
    },
    check: (file, purpose) =>
      mapped(async () => {
        const session = await start(
          file,
          'check',
          purpose === 'managed-dir' ? 'directory' : 'managed'
        );
        return { size: session.size, identity: session.identity };
      }),
    read: (file, _purpose, max) =>
      mapped(async () => {
        const session = await start(file, 'read', 'managed', max);
        return session.readAll();
      }),
    create: (file, _purpose, signal) =>
      mapped(async () => {
        const session = await start(file, 'create', 'managed', Number.MAX_SAFE_INTEGER, signal);
        return {
          async write(chunk: Uint8Array): Promise<void> {
            if (chunk.byteLength === 0) await session.command('write', 0, Buffer.alloc(0));
            for (let at = 0; at < chunk.byteLength; at += 65536)
              await session.command('write', 0, Buffer.from(chunk.subarray(at, at + 65536)));
          },
          async sync(): Promise<void> {
            await session.command('sync');
          },
          async bound(at: string) {
            return mapped(async () => {
              const size = await session.boundSize(at);
              if (size === undefined) throw new facility.NativeFailure('refused', 'binding');
              return size;
            });
          },
          close: () => session.close()
        };
      }),
    open: (file) =>
      mapped(async () => {
        const session = await start(file, 'open', 'attachment');
        return {
          size: session.size,
          bound: (at: string) => session.bound(at),
          async read(
            buffer: Buffer,
            offset: number,
            length: number,
            position: number
          ): Promise<number> {
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(length) ||
              length < 0 ||
              offset + length > buffer.length
            )
              throw new RangeError('private-files invalid buffer range');
            const count = Math.min(length, 65536, Math.max(0, session.size + 1 - position));
            let bytes: Buffer;
            try {
              bytes = (await session.command('read', position, count)) as Buffer;
            } catch (error) {
              if (
                error instanceof facility.NativeFailure &&
                error.kind === 'refused' &&
                error.reason === 'binding'
              )
                throw new ReadRefusal('changed', error.message);
              throw error;
            }
            bytes.copy(buffer, offset);
            return bytes.length;
          },
          close: () => session.close()
        };
      }, 'unreadable')
  };
}

async function mapped<T>(
  work: () => Promise<T>,
  ioFault?: Fault
): Promise<Success<T> | ReturnType<typeof refusal>> {
  try {
    return { supported: true, status: 'ok', value: await work() };
  } catch (error) {
    if (!(error instanceof facility.NativeFailure)) throw error;
    if (error.kind === 'io') {
      if (ioFault) return refusal(ioFault, error.message);
      throw error;
    }
    const faults: Readonly<Record<string, Fault>> = {
      'size-limit': 'too-large',
      owner: 'foreign',
      kind: 'not-regular',
      'changed-before-open': 'moved',
      binding: 'changed',
      'early-eof': 'incomplete'
    };
    return refusal(faults[error.reason] ?? 'refused', error.message);
  }
}
