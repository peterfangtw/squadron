import { constants, type Stats, type BigIntStats } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Success } from '../unsupported';
import { refusal, type Checked, type Effects, type PrivateFiles, type Refusal } from './index';

/** POSIX owner and mode bits, and the inode on its device. Other POSIX hosts
 *  take this same path, unverified, as before the seam. */
export function privateFiles(effects: Effects): PrivateFiles {
  async function dir(): Promise<Success<string> | Refusal> {
    const uid = effects.uid();
    if (uid === undefined) return refusal('refused', 'no user id to name the managed directory');
    return ok(path.join(await fs.realpath(effects.tmpdir()), `squadron-incoming-${uid}`));
  }

  /** A missing uid is never a match: a path is this user's only by its own uid. */
  function owned(stat: Stats | BigIntStats): boolean {
    const uid = effects.uid();
    return uid !== undefined && stat.uid === (typeof stat.uid === 'bigint' ? BigInt(uid) : uid);
  }

  function managedFile(stat: BigIntStats): boolean {
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1n &&
      owned(stat) &&
      (stat.mode & 0o077n) === 0n
    );
  }

  async function check(
    file: string,
    purpose: 'managed-dir' | 'managed-file'
  ): Promise<Success<Checked> | Refusal> {
    const stat = await fs.lstat(file, { bigint: true });
    const passes =
      purpose === 'managed-file'
        ? managedFile(stat)
        : stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          owned(stat) &&
          (stat.mode & 0o077n) === 0n &&
          (await fs.realpath(file)) === file;
    if (!passes) return refusal('refused', `${file} is not a private ${purpose}`);
    return ok({ size: Number(stat.size), identity: identity(stat) });
  }

  return {
    dispose: () => Promise.resolve(),
    dir,

    async ensure() {
      const where = await dir();
      if (where.status !== 'ok') return where;
      await fs.mkdir(where.value, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if ((await fs.lstat(where.value)).isSymbolicLink())
        return refusal('refused', `${where.value} is a link`);
      const real = await fs.realpath(where.value);
      const stat = await fs.stat(real);
      if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o077) !== 0)
        return refusal('refused', `${real} is not a private directory of this user's`);
      return ok(real);
    },

    check,

    async read(file, _purpose, max) {
      const before = await fs.lstat(file, { bigint: true });
      if (!managedFile(before)) return refusal('refused', `${file} is not a private managed-file`);
      if (before.size > max) return refusal('too-large', `${file} is over ${max} bytes`);
      if ((await fs.realpath(file)) !== file)
        return refusal('refused', `${file} is not its own real path`);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
          return refusal('moved', `${file} changed before it was opened`);
        const bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) return refusal('incomplete', `${file} ended early`);
          offset += read.bytesRead;
        }
        const after = await fs.lstat(file, { bigint: true });
        const final = await handle.stat({ bigint: true });
        if (
          !managedFile(after) ||
          after.ino !== opened.ino ||
          after.dev !== opened.dev ||
          final.size !== opened.size ||
          final.mtimeNs !== opened.mtimeNs
        )
          return refusal('changed', `${file} changed while it was read`);
        return ok(bytes);
      } finally {
        await handle.close();
      }
    },

    async create(file, _purpose, signal) {
      signal?.throwIfAborted();
      const handle = await fs.open(
        file,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      return ok({
        write: (chunk) => handle.writeFile(chunk),
        sync: () => handle.sync(),
        async bound(at) {
          const stat = await handle.stat({ bigint: true });
          const current = await check(at, 'managed-file');
          if (current.status !== 'ok') return current;
          if (current.value.identity !== identity(stat))
            return refusal('moved', `${at} is not the file being written`);
          return ok(Number(stat.size));
        },
        close: () => handle.close()
      });
    },

    async open(file) {
      // `O_NOFOLLOW` refuses a link swapped in at the path since the caller's
      // check. `O_NONBLOCK` because a FIFO swapped in blocks a plain open until
      // a writer comes, holding a filesystem worker of the host's for as long;
      // a regular file's reads ignore it.
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
      } catch {
        return refusal('unreadable', `${file} could not be opened`);
      }
      let kept = false;
      try {
        // bigint: an inode past 2^53 compares exactly.
        const info = await handle.stat({ bigint: true });
        if (!info.isFile()) return refusal('not-regular', `${file} is not a regular file`);
        // The temp directory is a root and every user's: a file another user
        // left readable there is not this one's to send.
        const uid = effects.uid();
        if (uid === undefined || info.uid !== BigInt(uid))
          return refusal('foreign', `${file} belongs to another user`);
        kept = true;
        return ok({
          size: Number(info.size),
          async bound(at) {
            const now = await fs.lstat(at, { bigint: true }).catch(() => undefined);
            return now?.dev === info.dev && now.ino === info.ino;
          },
          async read(buffer, offset, length, position) {
            return (await handle.read(buffer, offset, length, position)).bytesRead;
          },
          close: () => handle.close()
        });
      } finally {
        if (!kept) await handle.close();
      }
    }
  };
}

function identity(stat: BigIntStats): Checked['identity'] {
  return `posix-file-id-v1:${stat.dev}:${stat.ino}`;
}

function ok<T>(value: T): Success<T> {
  return { supported: true, status: 'ok', value };
}
