import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, testPlatform } from '../helpers';
import * as platform from '../../core/platform';
import * as darwin from '../../core/platform/files/darwin';
import * as win32 from '../../core/platform/files/win32';

type Files = typeof import('../../core/files');

let files: Files;
let home: string;

before(async () => {
  home = await tempHome();
  files = await import('../../core/files');
});

describe('writeAtomicText', () => {
  it('writes, overwrites and reads back', async () => {
    const file = path.join(home, 'notes', 'page.md');
    assert.equal(await files.writeAtomicText(file, 'first\n'), true);
    assert.equal(await files.writeAtomicText(file, 'second\n'), true);
    assert.equal(await fs.readFile(file, 'utf8'), 'second\n');
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['page.md']);
  });

  // A file where the parent directory must be. `chmod` cannot make a directory
  // unwritable on win32, and this failure is the same one `writeAtomicJson`
  // already reports by returning false.
  it('resolves false when the parent path is not a directory', async () => {
    const blocked = path.join(home, 'blocked');
    await fs.writeFile(blocked, 'not a directory');
    assert.equal(await files.writeAtomicText(path.join(blocked, 'page.md'), 'nope'), false);
    assert.equal(await fs.readFile(blocked, 'utf8'), 'not a directory');
  });
});

describe('native replacement contract', () => {
  for (const [os, factory] of [
    ['darwin', darwin.files],
    ['win32', win32.files]
  ] as const) {
    for (const code of ['EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'EXDEV', 'ENOSPC']) {
      it(`returns the first ${os} ${code} denial and preserves both files`, async () => {
        const source = path.join(home, `${os}-${code}.tmp`);
        const destination = path.join(home, `${os}-${code}.json`);
        await fs.writeFile(source, 'complete new body');
        await fs.writeFile(destination, 'complete old body');
        const failure = Object.assign(new Error('cannot replace'), { code });
        let attempts = 0;
        const backend = factory({
          open: () => {
            throw new Error('unexpected directory open');
          },
          rename: () => {
            attempts++;
            return Promise.reject(failure);
          }
        });
        assert.equal(attempts, 0, 'factory is inert');
        await assert.rejects(backend.replace(source, destination), (error) => error === failure);
        assert.equal(attempts, 1);
        assert.equal(await fs.readFile(source, 'utf8'), 'complete new body');
        assert.equal(await fs.readFile(destination, 'utf8'), 'complete old body');
      });
    }
  }
});

describe('atomic publication failure', () => {
  for (const writer of ['writeAtomicJson', 'writeAtomicText'] as const) {
    it(`reports failed ${writer} once, keeps old bytes and removes its temp`, async (context) => {
      const file = path.join(home, `${writer}.json`);
      await fs.writeFile(file, 'previous body');
      const replace = context.mock.method(
        platform.files,
        'replace',
        async (source: string, destination: string) => {
          assert.equal(destination, file);
          assert.ok((await fs.readFile(source, 'utf8')).includes('new body'));
          throw Object.assign(new Error('held target'), { code: 'EBUSY' });
        }
      );
      assert.equal(await files[writer](file, 'new body'), false);
      assert.equal(replace.mock.callCount(), 1);
      assert.equal(await fs.readFile(file, 'utf8'), 'previous body');
      assert.deepEqual(
        (await fs.readdir(home)).filter((name) => name.startsWith(path.basename(file))),
        [path.basename(file)]
      );
    });
  }
  it('refuses a stale publication before rename and removes its temp', async (context) => {
    const file = path.join(home, 'stale.json');
    await fs.writeFile(file, 'newer record');
    const replace = context.mock.method(platform.files, 'replace', () =>
      Promise.reject(new Error('must not publish'))
    );
    assert.equal(await files.writeAtomicText(file, 'old record', () => false), false);
    assert.equal(replace.mock.callCount(), 0);
    assert.equal(await fs.readFile(file, 'utf8'), 'newer record');
    assert.deepEqual(
      (await fs.readdir(home)).filter((name) => name.startsWith('stale.json')),
      ['stale.json']
    );
  });
});

describe('native filesystem replacement controls', () => {
  it('preserves bytes on a held Windows read handle and permits a new call after close', async () => {
    const source = path.join(home, 'held-read.tmp');
    const destination = path.join(home, 'held-read.json');
    await fs.writeFile(source, 'complete new body');
    await fs.writeFile(destination, 'complete old body');
    const handle = await fs.open(destination, 'r');
    try {
      if (testPlatform() === 'win32') {
        await assert.rejects(platform.files.replace(source, destination), { code: 'EPERM' });
        assert.equal(await fs.readFile(source, 'utf8'), 'complete new body');
        assert.equal(await fs.readFile(destination, 'utf8'), 'complete old body');
      } else {
        await platform.files.replace(source, destination);
        assert.equal(await handle.readFile('utf8'), 'complete old body');
      }
    } finally {
      await handle.close();
    }
    if (testPlatform() === 'win32') await platform.files.replace(source, destination);
    assert.equal(await fs.readFile(destination, 'utf8'), 'complete new body');
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  });
  it(
    'preserves a Windows read-only target and source',
    { skip: testPlatform() !== 'win32' && 'win32: read-only attribute denies native replacement' },
    async () => {
      const source = path.join(home, 'readonly.tmp');
      const destination = path.join(home, 'readonly.json');
      await fs.writeFile(source, 'complete new body');
      await fs.writeFile(destination, 'complete old body');
      await fs.chmod(destination, 0o400);
      try {
        await assert.rejects(platform.files.replace(source, destination), { code: 'EPERM' });
        assert.equal(await fs.readFile(source, 'utf8'), 'complete new body');
        assert.equal(await fs.readFile(destination, 'utf8'), 'complete old body');
      } finally {
        await fs.chmod(destination, 0o600);
      }
    }
  );
});
describe('lock contention', () => {
  const backend = {
    open: () => Promise.reject(new Error('unexpected open')),
    rename: () => Promise.reject(new Error('unexpected replace'))
  };
  const error = (code: string) => Object.assign(new Error(code), { code });

  it('reads EPERM as contention on win32 only', () => {
    assert.equal(win32.files(backend).contended(error('EPERM')), true);
    assert.equal(win32.files(backend).contended(error('ENOSPC')), false);
    assert.equal(darwin.files(backend).contended(error('EPERM')), false);
  });
});

describe('directory sync', () => {
  for (const [os, factory] of [
    ['darwin', darwin.files],
    ['win32', win32.files]
  ] as const) {
    for (const stage of ['success', 'open', 'sync', 'close'] as const) {
      for (const code of ['EPERM', 'EIO']) {
        it(`preserves ${os} directory ${stage} ordering and ${code} policy`, async () => {
          const calls: string[] = [];
          const failure = Object.assign(new Error(stage), { code });
          const backend = factory({
            open: (directory, flags) => {
              calls.push('open');
              assert.equal(directory, 'directory');
              assert.equal(flags, 'r');
              if (stage === 'open') return Promise.reject(failure);
              return Promise.resolve({
                sync: () => {
                  calls.push('sync');
                  return stage === 'sync' ? Promise.reject(failure) : Promise.resolve();
                },
                close: () => {
                  calls.push('close');
                  return stage === 'close' ? Promise.reject(failure) : Promise.resolve();
                }
              });
            },
            rename: () => {
              throw new Error('unexpected replace');
            }
          });
          assert.deepEqual(calls, [], 'factory starts no effects');
          const operation = backend.syncDirectory('directory');
          if (stage === 'success' || (os === 'win32' && stage === 'sync' && code === 'EPERM')) {
            await operation;
          } else {
            await assert.rejects(operation, (error) => error === failure);
          }
          assert.deepEqual(calls, stage === 'open' ? ['open'] : ['open', 'sync', 'close']);
        });
      }
    }

    it(`preserves ${os} close failures after a directory sync failure`, async () => {
      const failure = Object.assign(new Error('close'), { code: 'EPERM' });
      let closes = 0;
      const backend = factory({
        open: () =>
          Promise.resolve({
            sync: () => Promise.reject(Object.assign(new Error('sync'), { code: 'EPERM' })),
            close: () => {
              closes++;
              return Promise.reject(failure);
            }
          }),
        rename: () => {
          throw new Error('unexpected replace');
        }
      });
      await assert.rejects(backend.syncDirectory('directory'), (error) => error === failure);
      assert.equal(closes, 1);
    });
  }
});
