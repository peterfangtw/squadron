import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as darwin from '../../core/platform/private_files/darwin';
import * as win32 from '../../core/platform/private_files/win32';
import type { Effects, Fault, PrivateFiles } from '../../core/platform/private_files';
import { testPlatform, tempHome, disposeHome } from '../helpers';

/**
 * Real files in a sandbox, so owner, mode, link and inode answers are the
 * kernel's. Only the uid is ever faked, to stand for another user.
 */

const posixSkip: false | string =
  testPlatform() === 'win32' &&
  'win32: POSIX owner, mode and inode rules are the darwin backend contract; win32 refuses — W6.6';

let sandbox: string;
let uid: number;
let home: string;

before(async () => {
  home = await tempHome();
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'private-files-')));
  uid = process.getuid?.() ?? -1;
});
after(() => disposeHome(home));

function backend(over: Partial<Effects> = {}): PrivateFiles {
  return darwin.privateFiles({ uid: () => uid, tmpdir: () => sandbox, ...over });
}

async function fresh(name: string): Promise<string> {
  const dir = path.join(sandbox, name);
  await fs.mkdir(dir, { mode: 0o700 });
  return dir;
}

async function privateFile(dir: string, name: string, body = 'bytes'): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, body, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

function fault(answer: { supported: boolean; status?: string; fault?: Fault }): Fault | undefined {
  assert.equal(answer.supported, true);
  assert.equal(answer.status, 'failed');
  return answer.fault;
}

describe('private files: the managed directory', { skip: posixSkip }, () => {
  it('names the directory for this user under the real temp directory, creating nothing', async () => {
    const where = await backend().dir();
    assert.ok(where.supported && where.status === 'ok');
    assert.equal(where.value, path.join(sandbox, `squadron-incoming-${uid}`));
    await assert.rejects(fs.lstat(where.value), { code: 'ENOENT' });
  });

  it('creates it 0700 and answers its real path; keeps an existing private one', async () => {
    const files = backend({ tmpdir: () => sandbox });
    const first = await files.ensure();
    assert.ok(first.supported && first.status === 'ok');
    assert.equal((await fs.stat(first.value)).mode & 0o777, 0o700);
    const again = await files.ensure();
    assert.deepEqual(again, first);
    await fs.rm(first.value, { recursive: true });
  });

  it('refuses one that is a link, open to others, or another user’s', async () => {
    const parent = await fresh('ensure-refusals');
    const files = backend({ tmpdir: () => parent });
    const where = path.join(parent, `squadron-incoming-${uid}`);
    await fs.mkdir(path.join(parent, 'elsewhere'), { mode: 0o700 });
    await fs.symlink(path.join(parent, 'elsewhere'), where);
    assert.equal(fault(await files.ensure()), 'refused');
    await fs.rm(where);
    await fs.mkdir(where, { mode: 0o700 });
    await fs.chmod(where, 0o750);
    assert.equal(fault(await files.ensure()), 'refused');
    await fs.chmod(where, 0o700);
    assert.equal(
      fault(await backend({ tmpdir: () => parent, uid: () => uid + 1 }).ensure()),
      'refused'
    );
  });

  it('never treats a missing uid as this user, at any entry point', async () => {
    const dir = await fresh('no-uid');
    const file = await privateFile(dir, 'file');
    const files = backend({ uid: () => undefined, tmpdir: () => dir });
    assert.equal(fault(await files.dir()), 'refused');
    assert.equal(fault(await files.ensure()), 'refused');
    assert.equal(fault(await files.check(dir, 'managed-dir')), 'refused');
    assert.equal(fault(await files.check(file, 'managed-file')), 'refused');
    assert.equal(fault(await files.read(file, 'managed-file', 100)), 'refused');
    assert.equal(fault(await files.open(file, 'attachment')), 'foreign');
  });

  it('holds a directory to its own rule: private, this user’s, real, never a file', async () => {
    const dir = await fresh('managed-dir');
    const files = backend();
    const checked = await files.check(dir, 'managed-dir');
    assert.ok(checked.supported && checked.status === 'ok');
    const stat = await fs.lstat(dir, { bigint: true });
    assert.equal(checked.value.identity, `posix-file-id-v1:${stat.dev}:${stat.ino}`);
    const file = await privateFile(dir, 'not-a-dir');
    assert.equal(fault(await files.check(file, 'managed-dir')), 'refused');
    const link = path.join(sandbox, 'managed-dir-link');
    await fs.symlink(dir, link);
    assert.equal(fault(await files.check(link, 'managed-dir')), 'refused');
    const below = await fresh('managed-dir-parent');
    await fs.mkdir(path.join(below, 'real'), { mode: 0o700 });
    await fs.symlink(below, path.join(sandbox, 'managed-dir-parent-link'));
    const unreal = path.join(sandbox, 'managed-dir-parent-link', 'real');
    assert.equal(fault(await files.check(unreal, 'managed-dir')), 'refused');
    await fs.chmod(dir, 0o701);
    assert.equal(fault(await files.check(dir, 'managed-dir')), 'refused');
    await fs.chmod(dir, 0o700);
    assert.equal(fault(await backend({ uid: () => uid + 1 }).check(dir, 'managed-dir')), 'refused');
    await assert.rejects(files.check(path.join(sandbox, 'absent'), 'managed-dir'), {
      code: 'ENOENT'
    });
  });
});

describe('private files: managed files', { skip: posixSkip }, () => {
  it('passes a private file of this user’s with one name, and nothing else', async () => {
    const dir = await fresh('managed-file');
    const file = await privateFile(dir, 'ok', 'twelve bytes');
    const files = backend();
    const checked = await files.check(file, 'managed-file');
    assert.ok(checked.supported && checked.status === 'ok');
    assert.equal(checked.value.size, 12);
    await fs.chmod(file, 0o640);
    assert.equal(fault(await files.check(file, 'managed-file')), 'refused');
    await fs.chmod(file, 0o600);
    await fs.link(file, path.join(dir, 'second-name'));
    assert.equal(fault(await files.check(file, 'managed-file')), 'refused');
    await fs.rm(path.join(dir, 'second-name'));
    const link = path.join(dir, 'link');
    await fs.symlink(file, link);
    assert.equal(fault(await files.check(link, 'managed-file')), 'refused');
    assert.equal(fault(await files.check(dir, 'managed-file')), 'refused');
    assert.equal(
      fault(await backend({ uid: () => uid + 1 }).check(file, 'managed-file')),
      'refused'
    );
    await assert.rejects(files.check(path.join(dir, 'absent'), 'managed-file'), {
      code: 'ENOENT'
    });
  });

  it('reads the whole file through a checked descriptor, refusing the same rules', async () => {
    const dir = await fresh('managed-read');
    const file = await privateFile(dir, 'ok', 'whole bytes');
    const files = backend();
    const read = await files.read(file, 'managed-file', 100);
    assert.ok(read.supported && read.status === 'ok');
    assert.equal(read.value.toString(), 'whole bytes');
    assert.equal(fault(await files.read(file, 'managed-file', 10)), 'too-large');
    await fs.chmod(file, 0o644);
    assert.equal(fault(await files.read(file, 'managed-file', 100)), 'refused');
    await fs.chmod(file, 0o600);
    await fs.link(file, path.join(dir, 'second-name'));
    assert.equal(fault(await files.read(file, 'managed-file', 100)), 'refused');
    await fs.rm(path.join(dir, 'second-name'));
    await fs.symlink(dir, path.join(sandbox, 'managed-read-link'));
    const unreal = path.join(sandbox, 'managed-read-link', 'ok');
    assert.equal(fault(await files.read(unreal, 'managed-file', 100)), 'refused');
    await assert.rejects(files.read(path.join(dir, 'absent'), 'managed-file', 100), {
      code: 'ENOENT'
    });
  });

  it('retains sub-millisecond change detection with lossless stat identities', async (context) => {
    const dir = await fresh('managed-read-precision');
    const file = await privateFile(dir, 'bytes', 'unchanged length');
    await fs.utimes(file, 1, 1.0001);
    const before = await fs.stat(file, { bigint: true });
    const open = fs.open;
    context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      let initial = true;
      context.mock.method(handle, 'stat', (async (...options: Parameters<typeof handle.stat>) => {
        if (!initial) await fs.utimes(file, 1, 1.0002);
        initial = false;
        return stat(...options);
      }) as typeof handle.stat);
      return handle;
    });
    assert.equal(fault(await backend().read(file, 'managed-file', 100)), 'changed');
    const after = await fs.stat(file, { bigint: true });
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.notEqual(after.mtimeNs, before.mtimeNs);
  });

  it('creates exclusively and privately, never through a link, and binds the path to its inode', async () => {
    const dir = await fresh('managed-create');
    const files = backend();
    const partial = path.join(dir, 'partial');
    const created = await files.create(partial, 'managed-file');
    assert.ok(created.supported && created.status === 'ok');
    const handle = created.value;
    try {
      await handle.write(Buffer.from('written'));
      await handle.sync();
      assert.equal((await fs.lstat(partial)).mode & 0o777, 0o600);
      assert.deepEqual(await handle.bound(partial), {
        supported: true,
        status: 'ok',
        value: 7
      });
      await fs.rename(partial, path.join(dir, 'moved'));
      await privateFile(dir, 'partial', 'someone else');
      assert.equal(fault(await handle.bound(partial)), 'moved');
      await fs.rm(partial);
      await assert.rejects(handle.bound(partial), { code: 'ENOENT' });
    } finally {
      await handle.close();
    }
    await assert.rejects(files.create(path.join(dir, 'moved'), 'managed-file'), {
      code: 'EEXIST'
    });
    await fs.symlink(path.join(dir, 'target'), path.join(dir, 'dangling'));
    await assert.rejects(files.create(path.join(dir, 'dangling'), 'managed-file'));
    await assert.rejects(fs.lstat(path.join(dir, 'target')), { code: 'ENOENT' });
  });
});

describe('private files: attachments', { skip: posixSkip }, () => {
  it('opens an ordinary readable file of this user’s, whatever its mode or link count', async () => {
    const dir = await fresh('attachment');
    const file = path.join(dir, 'report.txt');
    await fs.writeFile(file, 'ordinary');
    await fs.chmod(file, 0o644);
    await fs.link(file, path.join(dir, 'second-name'));
    const opened = await backend().open(file, 'attachment');
    assert.ok(opened.supported && opened.status === 'ok');
    try {
      assert.equal(opened.value.size, 8);
      const buffer = Buffer.alloc(9);
      assert.equal(await opened.value.read(buffer, 0, 9, 0), 8);
      assert.equal(buffer.subarray(0, 8).toString(), 'ordinary');
    } finally {
      await opened.value.close();
    }
    const managed = await backend().check(file, 'managed-file');
    assert.equal(fault(managed), 'refused', 'the managed rule is the stricter, separate policy');
  });

  it('refuses another user’s file, a link, a directory and an absent path', async () => {
    const dir = await fresh('attachment-refusals');
    const file = path.join(dir, 'theirs.txt');
    await fs.writeFile(file, 'theirs');
    assert.equal(fault(await backend({ uid: () => uid + 1 }).open(file, 'attachment')), 'foreign');
    await fs.symlink(file, path.join(dir, 'link'));
    assert.equal(fault(await backend().open(path.join(dir, 'link'), 'attachment')), 'unreadable');
    assert.equal(fault(await backend().open(dir, 'attachment')), 'not-regular');
    assert.equal(fault(await backend().open(path.join(dir, 'absent'), 'attachment')), 'unreadable');
  });

  it('binds the descriptor to whichever path names its inode now', async () => {
    const dir = await fresh('attachment-bind');
    const file = path.join(dir, 'plot.png');
    await fs.writeFile(file, 'png');
    const opened = await backend().open(file, 'attachment');
    assert.ok(opened.supported && opened.status === 'ok');
    try {
      assert.equal(await opened.value.bound(file), true);
      await fs.link(file, path.join(dir, 'other-name'));
      assert.equal(await opened.value.bound(path.join(dir, 'other-name')), true);
      await fs.rm(file);
      await fs.writeFile(file, 'replaced');
      assert.equal(await opened.value.bound(file), false);
      await fs.rm(file);
      assert.equal(await opened.value.bound(file), false);
    } finally {
      await opened.value.close();
    }
  });
});

describe('private files on win32', () => {
  it('refuses every entry point with W6.6, before anything is opened or created', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'private-files-w-')));
    const file = path.join(dir, 'file');
    await fs.writeFile(file, 'bytes');
    const files = win32.privateFiles();
    const created = path.join(dir, 'created');
    const answers = await Promise.all([
      files.dir(),
      files.ensure(),
      files.check(dir, 'managed-dir'),
      files.check(file, 'managed-file'),
      files.read(file, 'managed-file', 100),
      files.create(created, 'managed-file'),
      files.open(file, 'attachment')
    ]);
    for (const answer of answers) {
      assert.equal(answer.supported, false);
      assert.match(answer.supported ? '' : answer.reason, /win32: .*W6\.6/);
    }
    assert.deepEqual((await fs.readdir(dir)).sort(), ['file']);
  });
});
