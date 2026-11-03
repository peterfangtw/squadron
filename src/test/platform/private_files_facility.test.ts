import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { after, before, describe, it } from 'node:test';
import * as roots from '../../../scripts/fixture-roots.cjs';
import * as build from '../../../scripts/private-files-helper.mjs';
import * as facility from '../../core/platform/private_files/facility';
import * as backend from '../../core/platform/private_files/win32';
import * as helpers from '../helpers';

const windowsSkip = helpers.testPlatform() !== 'win32' && 'posix: native Windows helper acceptance';
const ROOT = helpers.repoRoot();
let home: string, fixture: string, artifact: facility.Artifact;
const owners: facility.Facility[] = [];
const privateAcl = 'D:P(A;;FA;;;USER)';
function frame(bytes: Buffer): Buffer {
  const result = Buffer.alloc(bytes.length + 5);
  result.writeUInt32LE(bytes.length + 1);
  result[4] = 1;
  bytes.copy(result, 5);
  return result;
}
const env = (): NodeJS.ProcessEnv => ({ ...process.env, ...roots.environment(home) });
const makeOwner = (): facility.Facility => {
  const owner = new facility.Facility(artifact);
  owners.push(owner);
  return owner;
};
const request = (
  file: string,
  operation: facility.Request['operation'] = 'check',
  purpose: facility.Request['purpose'] = 'managed'
): facility.Request => ({
  operation,
  purpose,
  path: file,
  maximum: 1048576,
  expires: Date.now() + 15000
});
async function acl(file: string, sddl: string, directory = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    cp.execFile(
      fixture,
      [directory ? 'directory' : 'file', file, sddl],
      {
        env: env(),
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      },
      (error) => (error ? reject(new Error(error.message)) : resolve())
    );
  });
}
async function file(name: string): Promise<string> {
  const full = path.join(home, name);
  await fs.writeFile(full, 'original');
  await acl(full, privateAcl);
  return full;
}

describe(
  'packaged private-files native prerequisites',
  { skip: windowsSkip, timeout: 60000 },
  () => {
    before(() => {
      home = roots.create('squadron-private-native-');
      const manifest = build.prepare(ROOT) as { sha256: string };
      artifact = {
        executable: path.join(ROOT, 'dist/helpers/private-files-v1.exe'),
        sha256: manifest.sha256
      };
      fixture = path.join(home, 'fixture.exe');
      const toolchain =
        process.env.SQUADRON_PRIVATE_FILES_TOOLCHAIN ??
        path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319');
      cp.execFileSync(
        path.join(toolchain, 'csc.exe'),
        [
          '/nologo',
          '/target:exe',
          '/platform:anycpu',
          '/main:PrivateFilesFixture',
          `/out:${fixture}`,
          path.join(ROOT, 'src/test/fixtures/private_files_native.cs'),
          path.join(ROOT, 'src/core/platform/private_files/helper/Program.cs')
        ],
        { env: env(), windowsHide: true, timeout: 30000 }
      );
    });
    after(async () => {
      await Promise.all(owners.map((owner) => owner.dispose()));
      // Restore fixture-only DACLs before deleting deliberately inaccessible entries.
      for (const entry of await fs.readdir(home)) {
        const full = path.join(home, entry);
        const info = await fs.lstat(full);
        if (!info.isSymbolicLink() && info.isFile() && entry !== 'fixture.exe')
          await acl(full, privateAcl);
      }
      roots.remove(home);
    });

    it('owns private creation, full identity, bounded binary IO and attachment semantics', async () => {
      const owner = makeOwner(),
        target = path.join(home, 'created');
      const writer = await owner.start(request(target, 'create'));
      assert.equal(writer.size, 0);
      assert.match(writer.identity, /^win32-file-id-v1:[0-9a-f]{16}:[0-9a-f]{32}$/);
      const bytes = crypto.randomBytes(65536);
      await writer.command('write', 0, bytes);
      await writer.command('sync');
      assert.equal(await writer.command('bound'), true);
      await writer.close();
      assert.deepEqual(await fs.readFile(target), bytes);
      const reader = await owner.start(request(target, 'open', 'attachment'));
      assert.equal(reader.identity, writer.identity);
      assert.deepEqual(await reader.command('read', 0, bytes.length), bytes);
      await assert.rejects(reader.command('read', 2, bytes.length), /invalid read/);
      await reader.close();
      const hardlink = path.join(home, 'hardlink');
      await fs.link(target, hardlink);
      await assert.rejects(owner.start(request(target)), /metadata/);
      await acl(target, 'D:P(A;;FA;;;USER)(A;;FR;;;WD)');
      const broad = await owner.start(request(hardlink, 'open', 'attachment'));
      assert.equal(broad.identity, writer.identity);
      await broad.close();
      await assert.rejects(owner.start(request(target)), /metadata/);
      await fs.unlink(hardlink);
      await assert.rejects(owner.start(request(target)), /trustee/);
      await acl(target, privateAcl);
    });

    it('keeps a writer alive across a six-second download stall', async () => {
      const files = backend.privateFiles({
        artifact: () => Promise.resolve(artifact),
        tmpdir: () => home
      });
      try {
        const target = path.join(home, 'stalled-download');
        const created = await files.create(target, 'managed-file');
        assert.ok(created.supported && created.status === 'ok');
        try {
          await created.value.write(Buffer.from('before'));
          await new Promise((resolve) => setTimeout(resolve, 6000));
          await created.value.write(Buffer.from('after'));
          await created.value.sync();
          const bound = await created.value.bound(target);
          assert.ok(bound.supported && bound.status === 'ok');
          assert.equal(bound.value, 11);
        } finally {
          await created.value.close();
        }
        assert.equal(await fs.readFile(target, 'utf8'), 'beforeafter');
      } finally {
        await files.dispose();
      }
    });

    it('adapts every private-files operation with native identity, partial EOF, refusals and owner disposal', async () => {
      const files = backend.privateFiles({
        artifact: () => Promise.resolve(artifact),
        tmpdir: () => home
      });
      try {
        const located = await files.dir();
        assert.ok(located.supported && located.status === 'ok');
        assert.match(path.basename(located.value), /^squadron-incoming-S-1-[0-9-]+$/);
        assert.equal(fsSync.existsSync(located.value), false);
        const ensured = await files.ensure();
        assert.deepEqual(ensured, located);
        const checked = await files.check(located.value, 'managed-dir');
        assert.ok(checked.supported && checked.status === 'ok');
        const name = path.join(located.value, 'adapter-bytes');
        const refused = await files.create(`${name}:stream`, 'managed-file');
        assert.ok(refused.supported && refused.status === 'failed');
        assert.equal(refused.fault, 'refused');
        assert.equal(fsSync.existsSync(name), false);
        const created = await files.create(name, 'managed-file');
        assert.ok(created.supported && created.status === 'ok');
        const bytes = crypto.randomBytes(65537);
        await created.value.write(bytes);
        await created.value.sync();
        assert.deepEqual(await created.value.bound(name), {
          supported: true,
          status: 'ok',
          value: bytes.length
        });
        await created.value.close();
        const read = await files.read(name, 'managed-file', bytes.length);
        assert.ok(read.supported && read.status === 'ok');
        assert.deepEqual(read.value, bytes);
        const oversize = await files.read(name, 'managed-file', bytes.length - 1);
        assert.ok(oversize.supported && oversize.status === 'failed');
        assert.equal(oversize.fault, 'too-large');
        await assert.rejects(
          files.read(path.join(located.value, 'absent'), 'managed-file', 1),
          /native io: (2|3)/
        );
        const named = path.join(located.value, 'hardlinked');
        await fs.link(name, named);
        const denied = await files.check(name, 'managed-file');
        assert.ok(denied.supported && denied.status === 'failed');
        const attachment = await files.open(named, 'attachment');
        assert.ok(attachment.supported && attachment.status === 'ok');
        const target = Buffer.alloc(bytes.length + 1);
        assert.equal(await attachment.value.read(target, 0, target.length, 0), 65536);
        assert.equal(await attachment.value.read(target, 65536, 2, 65536), 1);
        assert.equal(await attachment.value.read(target, bytes.length, 1, bytes.length), 0);
        assert.deepEqual(target.subarray(0, bytes.length), bytes);
        await attachment.value.close();
        const held = await files.create(path.join(located.value, 'cancelled'), 'managed-file');
        assert.ok(held.supported && held.status === 'ok');
        await files.dispose();
        await assert.rejects(held.value.write(Buffer.from('late')), /cancel|abort|unavailable/i);
        await held.value.close();
      } finally {
        await files.dispose();
      }
    });

    it('validates existing directories without adopting broad access and creates protected descendants', async () => {
      const owner = makeOwner(),
        directory = path.join(home, 'managed-root');
      await fs.mkdir(directory);
      await acl(directory, 'D:P(A;OICI;FA;;;USER)(A;OICI;FA;;;WD)', true);
      await assert.rejects(owner.start(request(directory, 'ensure', 'directory')), /trustee/);
      await acl(directory, 'D:P(A;OICI;FA;;;USER)', true);
      const original = await owner.start(request(directory, 'ensure', 'directory'));
      const again = await owner.start(request(directory, 'check', 'directory'));
      assert.equal(original.identity, again.identity);
      const inherited = path.join(directory, 'inherited');
      await fs.writeFile(inherited, 'inherited');
      await owner.start(request(inherited));
      await acl(directory, 'D:P(A;OICI;FA;;;USER)(A;OICIIO;FR;;;WD)', true);
      await assert.rejects(owner.start(request(directory, 'check', 'directory')), /trustee/);
      await acl(directory, 'D:P(A;OICI;FA;;;USER)', true);
      const child = path.join(directory, 'private');
      await owner.start(request(child, 'ensure', 'directory'));
      const writer = await owner.start(request(path.join(child, 'bytes'), 'create'));
      await writer.command('write', 0, Buffer.from('private'));
      await writer.close();
      await assert.rejects(
        owner.start(request(path.join(child, 'bytes'), 'create')),
        /io: (80|183)/
      );
    });

    it('refuses broad, null, empty, callback and object ACLs independently of current-user ownership', async () => {
      const owner = makeOwner();
      const cases = [
        ['everyone', 'D:P(A;;FA;;;USER)(A;;FR;;;WD)', 'trustee'],
        ['users', 'D:P(A;;FA;;;USER)(A;;FR;;;BU)', 'trustee'],
        ['authenticated', 'D:P(A;;FA;;;USER)(A;;FR;;;AU)', 'trustee'],
        ['deny-does-not-rescue', 'D:P(D;;0x00000002;;;WD)(A;;FA;;;USER)(A;;FR;;;WD)', 'deny-ace'],
        ['null', 'D:NO_ACCESS_CONTROL', 'dacl'],
        ['empty', 'D:P', 'io: 5'],
        ['callback', 'D:P(A;;FA;;;USER)(XA;;FR;;;WD;(@User.A == 1))', 'ace-kind'],
        ['object', 'D:P(A;;FA;;;USER)(OA;;FR;00000000-0000-0000-0000-000000000001;;WD)', 'ace-kind']
      ];
      for (const [name, sddl, reason] of cases) {
        const target = await file(name!);
        try {
          await acl(target, sddl!);
          await assert.rejects(owner.start(request(target)), new RegExp(reason!), name);
        } finally {
          await acl(target, privateAcl);
        }
      }
      const trusted = await file('trusted');
      await acl(trusted, 'D:P(A;;FA;;;USER)(A;;FA;;;SY)(A;;FA;;;BA)');
      await owner.start(request(trusted));
      const systemDirectory = await fs.realpath(process.env.SystemRoot!);
      await assert.rejects(
        owner.start(request(systemDirectory, 'check', 'directory')),
        /native refused: owner/
      );
    });

    it('refuses device, remote, stream and alias spellings before touching those names', async () => {
      const owner = makeOwner(),
        target = await file('namespace');
      for (const value of [
        'NUL',
        '\\\\server\\share\\x',
        '\\\\?\\C:\\x',
        '\\\\.\\pipe\\x',
        'C:x',
        '\\x',
        target + ':stream',
        path.join(home, 'NUL.txt'),
        target + '.',
        target + ' ',
        target + '\u0085',
        path.join(home, 'COM\u00b9.txt'),
        home + '\\..\\escape',
        home + '\\\\double'
      ]) {
        await assert.rejects(
          owner.start(request(value)),
          /native refused: (absolute-drive-path|namespace|device|component)/,
          value
        );
      }
      assert.equal((await fs.readFile(target)).toString(), 'original');
    });

    it('refuses a remapped drive after proving the alias names a different object', async () => {
      await file('drive-original');
      const result = cp.execFileSync(fixture, ['drive', home], {
        env: env(),
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8'
      });
      assert.deepEqual(JSON.parse(result), {
        originalOpened: true,
        aliasNowNamesWrongObject: true,
        refused: true
      });
    });

    it('refuses mismatched final-name case without opening or creating the wrong object', async () => {
      const target = await file('MixedCase');
      const owner = makeOwner();
      await owner.start(request(target));
      await assert.rejects(owner.start(request(path.join(home, 'mixedcase'))), /final-path/);
      assert.equal(await fs.readFile(target, 'utf8'), 'original');
    });

    it('refuses an independently witnessed foreign-owner regular file', async () => {
      const target = await fs.realpath(
        path.join(process.env.SystemRoot!, 'System32/drivers/etc/hosts')
      );
      assert.equal((await fs.lstat(target)).isFile(), true);
      const identity = JSON.parse(
        cp.execFileSync(fixture, ['owner', target], {
          env: env(),
          windowsHide: true,
          timeout: 5000,
          encoding: 'utf8'
        })
      ) as { caller: string; owner: string };
      assert.notEqual(identity.owner, identity.caller);
      await assert.rejects(
        makeOwner().start(request(target, 'open', 'attachment')),
        /native refused: owner/
      );
    });

    it('binds relative opens through held ancestors despite pre-existing writable handles', async () => {
      const owner = makeOwner(),
        parent = path.join(home, 'ancestor');
      await fs.mkdir(parent);
      const target = path.join(parent, 'bytes');
      const writer = await owner.start(request(target, 'create'));
      await assert.rejects(fs.rename(parent, parent + '-moved'), /EPERM|EACCES|EBUSY/);
      await writer.close();
      const linked = path.join(home, 'junction');
      await fs.symlink(parent, linked, 'junction');
      try {
        await assert.rejects(owner.start(request(path.join(linked, 'bytes'))), /kind|io: 1921/);
      } finally {
        await fs.unlink(linked);
      }
      const lock = cp.spawn(fixture, ['lock', parent], { env: env(), windowsHide: true });
      try {
        await new Promise<void>((resolve, reject) => {
          lock.stdout.once('data', () => resolve());
          lock.once('error', reject);
        });
        await owner.start(request(target));
      } finally {
        lock.stdin.end('\n');
        await new Promise<void>((resolve) => lock.once('close', () => resolve()));
      }
      await owner.start(request(target));
      const mutation = cp.spawnSync(fixture, ['relative', home], {
        env: env(),
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8'
      });
      assert.equal(mutation.status, 0, mutation.stderr + mutation.stdout);
      assert.deepEqual(JSON.parse(mutation.stdout), {
        refused: 1921,
        redirected: false,
        restored: true
      });
    });

    it('detects replacement and held descriptor mutations without returning successful bytes', async () => {
      const owner = makeOwner(),
        target = await file('moving');
      const reader = await owner.start(request(target, 'open', 'attachment'));
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(target, target + '-old');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
          if (attempt === 9) {
            await reader.close();
            await fs.rename(target, target + '-old');
            assert.fail(
              'retained directory-list ancestors block publication (EBUSY across ten attempts); the same rename succeeds after confirmed helper close'
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await file('moving');
      assert.equal(await reader.command('bound'), false);
      await assert.rejects(reader.command('read', 0, 8), /binding|final-path/);
      await reader.close();
      const changed = await owner.start(request(target, 'open', 'attachment'));
      await fs.appendFile(target, 'growth');
      await assert.rejects(changed.command('read', 0, 8), /binding/);
      await changed.close();
    });

    it('refuses same-length overwrite while an existing writer remains open', async () => {
      const owner = makeOwner();
      for (const sync of [false, true]) {
        const target = await file(`held-overwrite-${sync}`);
        const writer = await fs.open(target, 'r+');
        let reader: facility.Session | undefined;
        try {
          reader = await owner.start(request(target, 'read'));
          await writer.write(Buffer.from('modified'), 0, 8, 0);
          if (sync) await writer.sync();
          await assert.rejects(reader.command('read', 0, 8), /binding/);
        } finally {
          await reader?.close();
          await writer.close();
        }
      }
    });

    it('binds published rename and link names to the held writer and refuses replacements', async () => {
      const owner = makeOwner(),
        source = path.join(home, 'publish-source');
      const writer = await owner.start(request(source, 'create'));
      await writer.command('write', 0, Buffer.from('published'));
      await writer.command('sync');
      const directory = path.join(home, 'publication-directory');
      await fs.mkdir(directory);
      const renamed = path.join(directory, 'published-name');
      await fs.rename(source, renamed);
      assert.equal(await writer.bound(renamed), true);
      assert.equal(await writer.bound(source), false);
      const linked = path.join(home, 'linked-name');
      await fs.link(renamed, linked);
      assert.equal(await writer.bound(linked), false);
      await fs.unlink(renamed);
      assert.equal(await writer.bound(linked), true);
      await fs.rename(linked, linked + '-held');
      await fs.writeFile(linked, 'replacement');
      await acl(linked, privateAcl);
      assert.equal(await writer.bound(linked), false);
      await writer.close();
      assert.equal((await fs.readFile(linked + '-held')).toString(), 'published');
      const attachment = await owner.start(request(linked + '-held', 'open', 'attachment'));
      await fs.link(linked + '-held', linked + '-alias');
      assert.equal(await attachment.bound(linked + '-alias'), true);
      await attachment.close();
    });

    it('completes whole managed reads and rejects incomplete or changed final validation', async () => {
      const owner = makeOwner(),
        target = await file('whole-read');
      const bytes = crypto.randomBytes(65536 + 19);
      await fs.writeFile(target, bytes);
      assert.deepEqual(await (await owner.start(request(target, 'read'))).readAll(), bytes);
      const incomplete = await owner.start(request(target, 'read'));
      await incomplete.command('read', 0, 65536);
      await assert.rejects(incomplete.command('complete'), /incomplete/);
      await incomplete.close();
      const final = await owner.start(request(target, 'read'));
      await final.command('read', 0, 65536);
      await final.command('read', 65536, 19);
      await fs.rename(target, target + '-replaced');
      await fs.writeFile(target, bytes);
      await acl(target, privateAcl);
      await assert.rejects(final.command('complete'), /binding|final-path/);
      await final.close();
      for (const mutateAfter of [0, 65536]) {
        const changed = await owner.start(request(target, 'read'));
        const writer = await fs.open(target, 'r+');
        const command = changed.command.bind(changed);
        let delivered = 0;
        changed.command = async (...args) => {
          const result = await command(...args);
          if (args[0] === 'read') {
            delivered++;
            if (args[1] === mutateAfter)
              await writer.write(Buffer.alloc(19, mutateAfter === 0 ? 3 : 4), 0, 19, 65536);
          }
          return result;
        };
        try {
          await assert.rejects(changed.readAll(), /binding/);
          assert.equal(delivered, mutateAfter === 0 ? 1 : 2);
        } finally {
          await changed.close();
          await writer.close();
        }
      }
      const empty = await file('empty-read');
      await fs.truncate(empty, 0);
      assert.deepEqual(
        await (await owner.start(request(empty, 'read'))).readAll(),
        Buffer.alloc(0)
      );
      const controller = new AbortController();
      const cancelled = await owner.start({ ...request(empty, 'read'), signal: controller.signal });
      const close = cancelled.close.bind(cancelled);
      cancelled.close = async () => {
        await close();
        controller.abort();
      };
      await assert.rejects(cancelled.readAll(), /cancel|abort/i);
    });

    it('cancels an oplock-pending native open before release without a late session', async () => {
      const target = await file('pending-open');
      for (const cancel of [false, true]) {
        const owner = makeOwner();
        const lock = cp.spawn(fixture, ['oplock', target], { env: env(), windowsHide: true });
        const closed = new Promise<number | null>((resolve) => lock.once('close', resolve));
        const lines = readline.createInterface({ input: lock.stdout });
        const next = lines[Symbol.asyncIterator]();
        const timer = setTimeout(() => lock.kill(), 7000);
        lock.stdin.on('error', () => {});
        try {
          assert.equal((await next.next()).value, 'ready');
          const controller = new AbortController();
          const pending = owner.start({
            ...request(target, 'open', 'attachment'),
            signal: controller.signal
          });
          let settled = false;
          void pending.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            }
          );
          assert.equal((await next.next()).value, 'break');
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(settled, false);
          if (cancel) {
            controller.abort();
            await assert.rejects(pending, /cancel|abort/i);
            await owner.dispose();
          }
          lock.stdin.end('\n');
          assert.equal(await closed, 0);
          if (!cancel) await (await pending).close();
        } finally {
          clearTimeout(timer);
          lock.stdin.end('\n');
          if (lock.exitCode === null) lock.kill();
          await closed;
          lines.close();
          await owner.dispose();
        }
      }
      const fresh = await makeOwner().start(request(target, 'open', 'attachment'));
      assert.deepEqual(await fresh.command('read', 0, 8), Buffer.from('original'));
      await fresh.close();
    });

    it('authorizes managed reads before data open and refuses size, ACL and content changes', async () => {
      const owner = makeOwner(),
        target = await file('managed-read');
      await assert.rejects(owner.start({ ...request(target, 'read'), maximum: 7 }), /size-limit/);
      const read = await owner.start(request(target, 'read'));
      assert.deepEqual(await read.command('read', 0, 8), Buffer.from('original'));
      await fs.truncate(target, 4);
      await assert.rejects(read.command('read', 0, 8), /binding/);
      await read.close();
      await fs.writeFile(target, 'original');
      const changed = await owner.start(request(target, 'read'));
      await acl(target, 'D:P(A;;FA;;;USER)(A;;FR;;;WD)');
      try {
        await assert.rejects(changed.command('read', 0, 8), /trustee/);
      } finally {
        await changed.close();
        await acl(target, privateAcl);
      }
    });

    it('bounds admission and cancels queued work and disposal before late creation', async () => {
      const owner = makeOwner();
      const a = await owner.start(request(path.join(home, 'slot-a'), 'create'));
      const b = await owner.start(request(path.join(home, 'slot-b'), 'create'));
      const controller = new AbortController();
      const queued = owner.start({
        ...request(path.join(home, 'never-created'), 'create'),
        signal: controller.signal
      });
      controller.abort();
      await assert.rejects(queued, /cancel|abort/i);
      const waiting = owner.start(request(path.join(home, 'disposed-create'), 'create'));
      const refused = assert.rejects(waiting, /cancel|abort/i);
      await owner.dispose();
      await refused;
      await a.close();
      await b.close();
      assert.equal(fsSync.existsSync(path.join(home, 'never-created')), false);
      assert.equal(fsSync.existsSync(path.join(home, 'disposed-create')), false);
      await assert.rejects(
        owner.start(request(path.join(home, 'after-dispose'), 'create')),
        /disposed|abort/i
      );
    });

    it('retains admission after unconfirmed exit and recovers only on the delayed close witness', async (context) => {
      const spawn = cp.spawn;
      const processes: cp.ChildProcess[] = [];
      context.mock.method(cp, 'spawn', ((...args: Parameters<typeof cp.spawn>) => {
        const child = spawn(...args);
        if (Array.isArray(args[1]) && args[1].length === 0) processes.push(child);
        return child;
      }) as typeof cp.spawn);
      const owner = makeOwner();
      const first = await owner.start(request(path.join(home, 'uncertain-a'), 'create'));
      const second = await owner.start(request(path.join(home, 'uncertain-b'), 'create'));
      const process = processes[0]!;
      const emit = process.emit.bind(process);
      let confirm = (): void => {};
      process.emit = (event: string | symbol, ...args: unknown[]): boolean => {
        if (event === 'close') {
          confirm = () => {
            emit(event, ...args);
          };
          return true;
        }
        return emit(event, ...args);
      };
      const heartbeat = setInterval(() => {
        void second.bound(path.join(home, 'uncertain-b')).catch(() => {});
      }, 1000);
      try {
        await assert.rejects(first.close(), /exit unconfirmed/);
        const target = path.join(home, 'after-uncertain');
        const waiting = owner.start(request(target, 'create'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(processes.length, 2);
        assert.equal(fsSync.existsSync(target), false);
        confirm();
        const recovered = await waiting;
        await recovered.close();
        assert.equal(fsSync.existsSync(target), true);
      } finally {
        clearInterval(heartbeat);
        confirm();
        await second.close();
        await owner.dispose();
      }
    });

    it('refuses an entire bounded admission queue and cancels a child starting after disposal', async () => {
      const owner = makeOwner();
      const a = await owner.start(request(path.join(home, 'queue-a'), 'create'));
      const b = await owner.start(request(path.join(home, 'queue-b'), 'create'));
      const pending = Array.from({ length: 32 }, (_, i) =>
        assert.rejects(
          owner.start(request(path.join(home, `queued-${i}`), 'create')),
          /cancel|abort/i
        )
      );
      await assert.rejects(
        owner.start(request(path.join(home, 'overflow'), 'create')),
        /admission full/
      );
      await owner.dispose();
      await Promise.all(pending);
      await a.close();
      await b.close();
      for (let i = 0; i < 32; i++)
        assert.equal(fsSync.existsSync(path.join(home, `queued-${i}`)), false);
      const lateOwner = makeOwner();
      const late = assert.rejects(
        lateOwner.start(request(path.join(home, 'late-create'), 'create')),
        /disposed|cancel|abort/i
      );
      await lateOwner.dispose();
      await late;
      assert.equal(fsSync.existsSync(path.join(home, 'late-create')), false);
    });

    it('enforces startup framing, exact owner birth, EOF, absolute expiry and real owner death', async () => {
      const birth = (pid: number): string => {
        const result = cp.spawnSync(artifact.executable, ['identity', String(pid)], {
          env: env(),
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 16384
        });
        assert.equal(result.status, 0, result.stderr.toString());
        const fields = result.stdout.subarray(5).toString('utf8').split('\n');
        assert.equal(fields[1], 'identity');
        return fields[3]!;
      };
      const initial = (
        target: string,
        ownerPid = process.pid,
        ownerBirth = birth(ownerPid),
        expiry = Date.now() + 4000,
        version = '1'
      ): Buffer =>
        frame(
          Buffer.from(
            [
              version,
              'a'.repeat(32),
              ownerPid,
              ownerBirth,
              expiry,
              'create',
              'managed',
              65536,
              target
            ].join('\n')
          )
        );
      const run = async (
        input: Buffer,
        onReady?: (child: cp.ChildProcessWithoutNullStreams, output: Buffer) => void | Promise<void>
      ): Promise<{ code: number | null; output: string }> => {
        const child = cp.spawn(artifact.executable, [], { env: env(), windowsHide: true });
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once('close', resolve);
          child.once('error', reject);
        });
        const output: Buffer[] = [];
        child.stdin.on('error', () => {});
        let ready: Promise<void> | undefined;
        child.stdout.on('data', (bytes: Buffer) => {
          output.push(bytes);
          if (!ready && Buffer.concat(output).includes(Buffer.from('\nready\n')))
            ready = Promise.resolve(onReady?.(child, Buffer.concat(output)));
          void ready?.catch(() => {});
        });
        child.stdin.write(input);
        const timer = setTimeout(() => child.kill(), 6000);
        try {
          const code = await closed;
          await ready;
          return { code, output: Buffer.concat(output).toString('utf8') };
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill();
            await closed;
          }
        }
      };
      const versionTarget = path.join(home, 'wrong-protocol');
      const wrong = await run(
        initial(versionTarget, process.pid, birth(process.pid), Date.now() + 4000, '2')
      );
      assert.equal(wrong.code, 31);
      assert.match(wrong.output, /refused\nprotocol/);
      assert.equal(fsSync.existsSync(versionTarget), false);
      const wrongBirth = path.join(home, 'wrong-birth');
      const mismatched = await run(
        initial(wrongBirth, process.pid, (BigInt(birth(process.pid)) + 1n).toString())
      );
      assert.equal(mismatched.code, 31);
      assert.match(mismatched.output, /owner-birth/);
      assert.equal(fsSync.existsSync(wrongBirth), false);
      for (const size of [0, 98306]) {
        const header = Buffer.alloc(5);
        header.writeUInt32LE(size);
        header[4] = 1;
        assert.equal((await run(header)).code, 40);
      }
      const eof = path.join(home, 'eof');
      assert.equal(
        (
          await run(initial(eof), (child) => {
            child.stdin.end();
          })
        ).code,
        40
      );
      assert.equal((await fs.stat(eof)).size, 0);
      const expiry = path.join(home, 'expired');
      assert.equal(
        (await run(initial(expiry, process.pid, birth(process.pid), Date.now() + 600))).code,
        42
      );
      assert.equal((await fs.stat(expiry)).size, 0);
      const backpressure = await file('backpressure');
      await fs.writeFile(backpressure, Buffer.alloc(65536, 7));
      const blocked = initial(backpressure, process.pid, birth(process.pid), Date.now() + 1600)
        .subarray(5)
        .toString('utf8')
        .split('\n');
      blocked[5] = 'open';
      blocked[6] = 'attachment';
      const blockedResult = await run(
        frame(Buffer.from(blocked.join('\n'))),
        async (child, output) => {
          // Pause only after reading readiness, then demand more than the pipe can retain.
          child.stdout.pause();
          const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
          const token = output.subarray(5).toString('utf8').split('\n')[3];
          assert.ok(token);
          try {
            for (let sequence = 1; sequence <= 16; sequence++)
              child.stdin.write(
                frame(
                  Buffer.from(['1', 'a'.repeat(32), sequence, token, 'read', 0, 65536].join('\n'))
                )
              );
            assert.equal(await exit, 42);
          } finally {
            child.stdout.resume();
          }
        }
      );
      assert.equal(blockedResult.code, 42);
      const caller = cp.spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
        env: env(),
        windowsHide: true
      });
      const callerClosed = new Promise<void>((resolve) => caller.once('close', () => resolve()));
      try {
        const callerPid = caller.pid;
        assert.ok(callerPid);
        const death = await run(
          initial(path.join(home, 'owner-death'), callerPid, birth(callerPid)),
          async () => {
            caller.kill();
            await callerClosed;
          }
        );
        assert.equal(death.code, 41);
      } finally {
        if (caller.exitCode === null) caller.kill();
        await callerClosed;
      }
    });

    it('refuses altered or missing executable bytes before spawning or creating a target', async () => {
      const target = path.join(home, 'digest-target');
      const cold = backend.privateFiles({
        artifact: () => Promise.reject(new Error('locator unavailable')),
        tmpdir: () => home
      });
      await assert.rejects(cold.create(target, 'managed-file'), /locator unavailable/);
      await cold.dispose();
      assert.equal(fsSync.existsSync(target), false);
      const bad = new facility.Facility({ ...artifact, sha256: '0'.repeat(64) });
      try {
        await assert.rejects(bad.start(request(target, 'create')), /manifest mismatch/);
      } finally {
        await bad.dispose();
      }
      assert.equal(fsSync.existsSync(target), false);
      const tamperedExe = path.join(home, 'tampered.exe');
      await fs.copyFile(artifact.executable, tamperedExe);
      const manifestFile = artifact.executable.replace(/\.exe$/, '.json');
      const manifestPath = path.join(home, 'tampered.json');
      await fs.copyFile(manifestFile, manifestPath);
      const bytes = await fs.readFile(tamperedExe);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await fs.writeFile(tamperedExe, bytes);
      const altered = new facility.Facility({ ...artifact, executable: tamperedExe });
      try {
        await assert.rejects(altered.start(request(target, 'create')), /digest mismatch/);
      } finally {
        await altered.dispose();
      }
      const metadata = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { protocol: number };
      metadata.protocol = 2;
      await fs.writeFile(manifestPath, JSON.stringify(metadata));
      const incompatible = new facility.Facility({ ...artifact, executable: tamperedExe });
      try {
        await assert.rejects(incompatible.start(request(target, 'create')), /manifest mismatch/);
      } finally {
        await incompatible.dispose();
      }
      assert.equal(fsSync.existsSync(target), false);
      const missing = new facility.Facility({
        ...artifact,
        executable: path.join(home, 'missing.exe')
      });
      try {
        await assert.rejects(missing.start(request(target, 'create')), /ENOENT/);
      } finally {
        await missing.dispose();
      }
    });
  }
);
