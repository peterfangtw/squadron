import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, testPlatform } from '../helpers';
import * as platform from '../../core/platform';
import * as darwin from '../../core/platform/files/darwin';
import * as win32 from '../../core/platform/files/win32';
import type { Budget, Kind } from '../../core/platform/files';

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
    assert.equal(await files.writeAtomicText(file, 'first\n', 'state'), true);
    assert.equal(await files.writeAtomicText(file, 'second\n', 'state'), true);
    assert.equal(await fs.readFile(file, 'utf8'), 'second\n');
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['page.md']);
  });

  // A file where the parent directory must be. `chmod` cannot make a directory
  // unwritable on win32, and this failure is the same one `writeAtomicJson`
  // already reports by returning false.
  it('resolves false when the parent path is not a directory', async () => {
    const blocked = path.join(home, 'blocked');
    await fs.writeFile(blocked, 'not a directory');
    assert.equal(
      await files.writeAtomicText(path.join(blocked, 'page.md'), 'nope', 'state'),
      false
    );
    assert.equal(await fs.readFile(blocked, 'utf8'), 'not a directory');
  });
});

const legacyBudgets: Budget[] = [
  { kind: 'owned', legacyRetry: 'execution-admission' },
  { kind: 'owned', legacyRetry: 'checkpoint-index' },
  { kind: 'state', legacyRetry: 'claude-settings' },
  { kind: 'owned', legacyRetry: 'grok-mcp-credentials' },
  { kind: 'owned', legacyRetry: 'grok-auth-credentials' }
];

// These moved cases retain their baseline names; the operation now lives in the capability.
describe('replaceFile', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`replaces the old file after a transient Windows ${code} lock`, async () => {
      const source = path.join(home, `replacement-${code}.tmp`);
      const destination = path.join(home, `replacement-${code}.json`);
      await fs.writeFile(source, 'complete new body');
      await fs.writeFile(destination, 'old body');
      let attempts = 0;
      const waits: number[] = [];
      const backend = win32.files({
        stat: () => Promise.reject(new Error('target metadata unavailable')),
        open: () => {
          throw new Error('unexpected directory open');
        },
        rename: async (from, to) => {
          if (++attempts === 1) {
            assert.equal(await fs.readFile(destination, 'utf8'), 'old body');
            throw Object.assign(new Error('file held by indexer'), { code });
          }
          await fs.rename(from, to);
        },
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        }
      });
      await backend.replace(source, destination, { kind: 'state', legacyRetry: 'claude-settings' });
      assert.equal(attempts, 2);
      assert.deepEqual(waits, [250]);
      assert.equal(await fs.readFile(destination, 'utf8'), 'complete new body');
      await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    });
  }

  for (const [os, code] of [
    ['linux', 'EPERM'],
    ['win32', 'ENOENT']
  ] as const) {
    it(`preserves ${os} ${code} failures without retrying`, async () => {
      const failure = Object.assign(new Error('cannot replace'), { code });
      let attempts = 0;
      let waits = 0;
      const effects = {
        stat: () => Promise.reject(new Error('target metadata unavailable')),
        open: () => {
          throw new Error('unexpected directory open');
        },
        rename: () => {
          attempts++;
          return Promise.reject(failure);
        },
        sleep: () => {
          waits++;
          return Promise.resolve();
        }
      };
      const backend = os === 'win32' ? win32.files(effects) : darwin.files(effects);
      await assert.rejects(
        backend.replace('source', 'destination', {
          kind: 'owned',
          legacyRetry: 'checkpoint-index'
        }),
        (error) => error === failure
      );
      assert.equal(attempts, 1);
      assert.equal(waits, 0);
    });
  }

  it('gives up on a persistent Windows lock and preserves both files', async () => {
    const source = path.join(home, 'persistent.tmp');
    const destination = path.join(home, 'persistent.json');
    await fs.writeFile(source, 'new body');
    await fs.writeFile(destination, 'old body');
    const failure = Object.assign(new Error('still locked'), { code: 'EBUSY' });
    for (const budget of legacyBudgets) {
      let attempts = 0;
      const waits: number[] = [];
      const backend = win32.files({
        stat: () => Promise.reject(new Error('target metadata unavailable')),
        open: () => {
          throw new Error('unexpected directory open');
        },
        rename: () => {
          attempts++;
          return Promise.reject(failure);
        },
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        }
      });
      await assert.rejects(
        backend.replace(source, destination, budget),
        (error) => error === failure
      );
      assert.equal(attempts, 40, budget.legacyRetry);
      assert.deepEqual(waits, Array<number>(39).fill(250), budget.legacyRetry);
      assert.equal(await fs.readFile(source, 'utf8'), 'new body');
      assert.equal(await fs.readFile(destination, 'utf8'), 'old body');
    }
  });
});

describe('replacement budgets', () => {
  for (const [os, factory] of [
    ['darwin', darwin.files],
    ['win32', win32.files]
  ] as const) {
    for (const kind of ['beat', 'state', 'owned'] as const) {
      it(`keeps ${os} ${kind} writes without target evidence to one attempt and no wait`, async () => {
        for (const code of ['EPERM', 'EBUSY', 'EACCES', 'ENOENT']) {
          const failure = Object.assign(new Error('cannot replace'), { code });
          let attempts = 0;
          let waits = 0;
          const backend = factory({
            stat: () => Promise.reject(new Error('target metadata unavailable')),
            open: () => {
              throw new Error('unexpected directory open');
            },
            rename: () => {
              attempts++;
              return Promise.reject(failure);
            },
            sleep: () => {
              waits++;
              return Promise.resolve();
            }
          });
          await assert.rejects(
            backend.replace('source', 'destination', { kind }),
            (error) => error === failure
          );
          assert.equal(attempts, 1);
          assert.equal(waits, 0);
        }
      });
    }
  }

  it('keeps every legacy Darwin replacement to one attempt and no wait', async () => {
    for (const budget of legacyBudgets) {
      const failure = Object.assign(new Error('cannot replace'), { code: 'EPERM' });
      let attempts = 0;
      let waits = 0;
      const backend = darwin.files({
        stat: () => Promise.reject(new Error('target metadata unavailable')),
        open: () => {
          throw new Error('unexpected directory open');
        },
        rename: () => {
          attempts++;
          return Promise.reject(failure);
        },
        sleep: () => {
          waits++;
          return Promise.resolve();
        }
      });
      await assert.rejects(
        backend.replace('source', 'destination', budget),
        (error) => error === failure
      );
      assert.equal(attempts, 1);
      assert.equal(waits, 0);
    }
  });

  it('passes each atomic writer kind and cleans up a replacement without target evidence', async (context) => {
    for (const kind of ['beat', 'state', 'owned'] as const satisfies readonly Kind[]) {
      for (const writer of ['writeAtomicJson', 'writeAtomicText'] as const) {
        const file = path.join(home, `${writer}-${kind}.json`);
        await fs.writeFile(file, 'previous body');
        let attempts = 0;
        let waits = 0;
        const backend = win32.files({
          stat: () => Promise.reject(new Error('target metadata unavailable')),
          open: () => {
            throw new Error('unexpected directory open');
          },
          rename: () => {
            attempts++;
            return Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' }));
          },
          sleep: () => {
            waits++;
            return Promise.resolve();
          }
        });
        const replace = context.mock.method(
          platform.files,
          'replace',
          async (source: string, destination: string, budget: Budget) => {
            assert.deepEqual(budget, { kind });
            await backend.replace(source, destination, budget);
          }
        );
        assert.equal(await files[writer](file, 'new body', kind), false);
        assert.equal(replace.mock.callCount(), 1);
        assert.equal(attempts, 1);
        assert.equal(waits, 0);
        assert.equal(await fs.readFile(file, 'utf8'), 'previous body');
        assert.deepEqual(
          (await fs.readdir(home)).filter((name) => name.startsWith(path.basename(file))),
          [path.basename(file)]
        );
        replace.mock.restore();
      }
    }
  });
});

describe('lock contention', () => {
  const backend = {
    stat: () => Promise.reject(new Error('unexpected stat')),
    open: () => Promise.reject(new Error('unexpected open')),
    rename: () => Promise.reject(new Error('unexpected replace')),
    sleep: () => Promise.reject(new Error('unexpected wait'))
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
            stat: () => Promise.reject(new Error('target metadata unavailable')),
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
            },
            sleep: () => {
              throw new Error('unexpected wait');
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
        stat: () => Promise.reject(new Error('target metadata unavailable')),
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
        },
        sleep: () => {
          throw new Error('unexpected wait');
        }
      });
      await assert.rejects(backend.syncDirectory('directory'), (error) => error === failure);
      assert.equal(closes, 1);
    });
  }
});

const stateStat = { dev: 1, ino: 2, size: 8, mtimeMs: 10, ctimeMs: 11, mode: 0o100600 };

describe('Windows state replacement', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`retries transient state ${code} with complete bytes and bounded waits`, async () => {
      const source = path.join(home, `state-${code}.tmp`);
      const destination = path.join(home, `state-${code}.json`);
      await fs.writeFile(source, 'complete new body');
      await fs.writeFile(destination, 'old body');
      let attempts = 0;
      const calls: string[] = [];
      const backend = win32.files({
        open: () => {
          throw new Error('unexpected directory sync');
        },
        stat: (file) => {
          assert.equal(file, destination);
          calls.push('stat');
          return fs.stat(file);
        },
        rename: async (from, to) => {
          calls.push('rename');
          if (++attempts < 3) {
            assert.equal(await fs.readFile(destination, 'utf8'), 'old body');
            throw Object.assign(new Error('read handle'), { code });
          }
          await fs.rename(from, to);
        },
        sleep: (ms) => {
          assert.equal(ms, 100);
          calls.push('sleep');
          return Promise.resolve();
        }
      });
      await backend.replace(source, destination, { kind: 'state' });
      assert.equal(attempts, 3);
      assert.deepEqual(calls, [
        'stat',
        'rename',
        'sleep',
        'stat',
        'rename',
        'sleep',
        'stat',
        'rename'
      ]);
      assert.equal(await fs.readFile(destination, 'utf8'), 'complete new body');
      await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    });
  }

  for (const scenario of [
    'persistent',
    'readonly',
    'changed',
    'disappeared',
    'appeared',
    'unreadable',
    'lost metadata',
    'non-lock',
    'later non-lock'
  ] as const) {
    it(`bounds ${scenario} state failure without replacing another version`, async () => {
      const first = Object.assign(new Error('initial rename'), {
        code: scenario === 'non-lock' ? 'EXDEV' : 'EPERM'
      });
      const later = Object.assign(new Error('later rename'), { code: 'ENOENT' });
      let stats = 0;
      let attempts = 0;
      const waits: number[] = [];
      const backend = win32.files({
        open: () => {
          throw new Error('unexpected directory sync');
        },
        stat: () => {
          stats++;
          if (scenario === 'unreadable' || (scenario === 'lost metadata' && stats > 1))
            return Promise.reject(Object.assign(new Error('stat denied'), { code: 'EACCES' }));
          if ((scenario === 'appeared' && stats === 1) || (scenario === 'disappeared' && stats > 1))
            return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
          return Promise.resolve({
            ...stateStat,
            mode: scenario === 'readonly' ? 0o100400 : stateStat.mode,
            ino: scenario === 'changed' && stats > 1 ? 3 : stateStat.ino
          });
        },
        rename: () => {
          attempts++;
          return Promise.reject(scenario === 'later non-lock' && attempts > 1 ? later : first);
        },
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        }
      });
      await assert.rejects(
        backend.replace('source', 'destination', { kind: 'state' }),
        (error) => error === (scenario === 'later non-lock' ? later : first)
      );
      assert.equal(
        attempts,
        scenario === 'persistent' ? 21 : scenario === 'later non-lock' ? 2 : 1
      );
      assert.deepEqual(
        waits,
        Array<number>(
          scenario === 'persistent'
            ? 20
            : ['readonly', 'unreadable', 'non-lock'].includes(scenario)
              ? 0
              : 1
        ).fill(100)
      );
    });
  }

  it('replaces after an existing read handle closes, preserving the complete record', async () => {
    const source = path.join(home, 'held-read.tmp');
    const destination = path.join(home, 'held-read.json');
    await fs.writeFile(source, 'complete new body');
    await fs.writeFile(destination, 'old body');
    const handle = await fs.open(destination, 'r');
    let closed = false;
    let attempts = 0;
    const waits: number[] = [];
    const backend = win32.files({
      open: () => {
        throw new Error('unexpected directory sync');
      },
      stat: (file) => fs.stat(file),
      rename: async (from, to) => {
        attempts++;
        await fs.rename(from, to);
      },
      sleep: async (ms) => {
        waits.push(ms);
        assert.equal(await fs.readFile(destination, 'utf8'), 'old body');
        await handle.close();
        closed = true;
      }
    });
    try {
      await backend.replace(source, destination, { kind: 'state' });
      assert.equal(await fs.readFile(destination, 'utf8'), 'complete new body');
      assert.equal(attempts, testPlatform() === 'win32' ? 2 : 1);
      assert.deepEqual(waits, testPlatform() === 'win32' ? [100] : []);
    } finally {
      if (!closed) await handle.close();
    }
  });
});

describe('state replacement boundaries', () => {
  it('keeps target metadata and new waits off POSIX, beat, owned and legacy replacements', async () => {
    for (const [factory, budgets] of [
      [darwin.files, [{ kind: 'state' }, { kind: 'owned' }, { kind: 'beat' }, ...legacyBudgets]],
      [win32.files, [{ kind: 'owned' }, { kind: 'beat' }, ...legacyBudgets]]
    ] as const) {
      for (const budget of budgets) {
        const calls: string[] = [];
        const backend = factory({
          open: () => {
            throw new Error('unexpected directory sync');
          },
          stat: () => {
            calls.push('stat');
            return Promise.resolve(stateStat);
          },
          rename: () => {
            calls.push('rename');
            return Promise.resolve();
          },
          sleep: () => {
            calls.push('sleep');
            return Promise.resolve();
          }
        });
        assert.deepEqual(calls, []);
        await backend.replace('source', 'destination', budget);
        assert.deepEqual(calls, ['rename']);
      }
    }
  });

  it('allows a successful first state replacement when target metadata is unavailable', async () => {
    const calls: string[] = [];
    const backend = win32.files({
      open: () => {
        throw new Error('unexpected directory sync');
      },
      stat: () => {
        calls.push('stat');
        return Promise.reject(new Error('metadata unavailable'));
      },
      rename: () => {
        calls.push('rename');
        return Promise.resolve();
      },
      sleep: () => {
        throw new Error('unexpected wait');
      }
    });
    await backend.replace('source', 'destination', { kind: 'state' });
    assert.deepEqual(calls, ['stat', 'rename']);
  });

  for (const changed of [false, true]) {
    it(`preserves source and ${changed ? 'a newer destination' : 'old destination'} after state denial`, async () => {
      const source = path.join(home, `denied-state-${changed}.tmp`);
      const destination = path.join(home, `denied-state-${changed}.json`);
      await fs.writeFile(source, 'complete new body');
      await fs.writeFile(destination, 'old body');
      const failure = Object.assign(new Error('read handle'), { code: 'EPERM' });
      let attempts = 0;
      let waits = 0;
      const backend = win32.files({
        open: () => {
          throw new Error('unexpected directory sync');
        },
        stat: (file) => fs.stat(file),
        rename: () => {
          attempts++;
          return Promise.reject(failure);
        },
        sleep: async (ms) => {
          assert.equal(ms, 100);
          waits++;
          if (changed) await fs.writeFile(destination, 'another writer won');
        }
      });
      await assert.rejects(
        backend.replace(source, destination, { kind: 'state' }),
        (error) => error === failure
      );
      assert.equal(attempts, changed ? 1 : 21);
      assert.equal(waits, changed ? 1 : 20);
      assert.equal(await fs.readFile(source, 'utf8'), 'complete new body');
      assert.equal(
        await fs.readFile(destination, 'utf8'),
        changed ? 'another writer won' : 'old body'
      );
    });
  }
});
