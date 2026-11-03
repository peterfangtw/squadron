import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as vm from 'node:vm';
import * as platform from '../../core/platform';
import * as darwin from '../../core/platform/paths/darwin';
import * as win32 from '../../core/platform/paths/win32';
import { tempHome, testPlatform } from '../helpers';

// Spellings Darwin and Linux keep byte for byte: a symlink and its target, NFC
// and NFD, a trailing separator, and every Windows shape as a plain string.
const spellings = [
  '/Users/me/repo',
  '/users/me/repo',
  '/tmp/x',
  '/private/tmp/x',
  '/repo/',
  'C:\\Users\\me',
  'c:\\users\\me',
  'C:/Users/me',
  'c:\\Users\\me',
  '\\\\server\\share\\dir',
  '//server/share/dir',
  'caf\u00e9',
  'cafe\u0301',
  ''
];

// What win32 keys as the input itself: relative, drive-relative, rooted, POSIX
// and device-namespace strings, and anything that only looks like a drive.
const exact = [
  '',
  '.',
  'rel\\x',
  'Rel/X',
  'c:',
  'C:foo',
  'c:foo/Bar',
  '\\foo',
  '/Users/me/repo',
  '/users/ME/Repo/',
  '//',
  '\\\\',
  '\\\\\\x/y',
  '///x/y',
  '\\\\?\\c:/a',
  '\\\\.\\c:/a',
  '//?/c:/a',
  '//./c:/a',
  '\\\\?\\UNC\\server\\share/a',
  '\\??\\c:\\a',
  'caf\u00e9',
  'cafe\u0301',
  '1:\\a',
  '\u00e9:\\a'
];

// Malformed or oversized, for totality: whatever each keys to, it is the same
// string every time, and its own key.
const malformed = [
  '\u0000',
  'c:\\a\u0000b',
  '\ud800',
  'c:/\udfff',
  ' c:\\a',
  'c:\\a ',
  '\r\n',
  'c:' + '/'.repeat(4096),
  '\\'.repeat(4096),
  'x'.repeat(65536)
];

describe('path keys', () => {
  for (const [host, keys] of [
    ['darwin', darwin.paths()],
    ['this host, off win32', testPlatform() === 'win32' ? undefined : platform.paths]
  ] as const) {
    it(`keeps every raw spelling on ${host}, and a key's key is itself`, (t) => {
      if (keys === undefined) return t.skip('win32: this host selects the folding backend');
      for (const raw of [...spellings, ...exact, ...malformed]) {
        assert.equal(keys.key(raw), raw);
        assert.equal(keys.key(keys.key(raw)), keys.key(raw));
      }
      assert.equal(new Set(spellings.map((raw) => keys.key(raw))).size, spellings.length);
    });
  }

  it('selects the folding backend on win32 and nowhere else', () => {
    const selected = testPlatform() === 'win32' ? win32.paths() : darwin.paths();
    for (const raw of [...spellings, ...exact, ...malformed]) {
      assert.equal(platform.paths.key(raw), selected.key(raw));
    }
  });
});

describe('win32 path keys', () => {
  const { key } = win32.paths();

  it('folds a local drive letter and its separators, and nothing else', () => {
    const cases: (readonly [readonly string[], string])[] = [
      [
        ['C:\\Users\\me\\Repo', 'c:\\Users\\me\\Repo', 'C:/Users/me/Repo', 'c:/Users\\me/Repo'],
        'C:\\Users\\me\\Repo'
      ],
      [['C:\\', 'c:\\', 'C:/', 'c:/'], 'C:\\'],
      [['d:\\a\\', 'D:/a/'], 'D:\\a\\'],
      [['C:\\a\\.\\b\\..\\c', 'c:/a/./b/../c'], 'C:\\a\\.\\b\\..\\c'],
      [['C:\\Repo Mixed\\Sub', 'c:/Repo Mixed/Sub'], 'C:\\Repo Mixed\\Sub']
    ];
    for (const [raws, folded] of cases) {
      for (const raw of raws) assert.equal(key(raw), folded, raw);
    }
  });

  it('folds only the separators of a UNC share', () => {
    for (const raw of ['\\\\server\\share\\Dir', '//server/share/Dir', '\\\\server/share\\Dir']) {
      assert.equal(key(raw), '\\\\server\\share\\Dir', raw);
    }
    assert.equal(key('//server/share'), '\\\\server\\share');
  });

  it('keeps distinct what a key cannot prove is one directory', () => {
    const pairs: (readonly [string, string])[] = [
      // A case-sensitive directory holds both, as two directories.
      ['C:\\x\\Foo', 'C:\\x\\foo'],
      ['C:\\Users\\me\\repo', 'c:\\users\\me\\repo'],
      ['C:\\CAF\u00c9', 'C:\\caf\u00e9'],
      ['C:\\caf\u00e9', 'C:\\cafe\u0301'],
      ['C:\\Program Files', 'C:\\PROGRA~1'],
      ['C:\\a\\', 'C:\\a'],
      ['C:\\a\\b', 'C:\\a\\\\b'],
      ['C:\\a\\b', 'C:\\a\\.\\b'],
      ['C:\\a', 'D:\\a'],
      ['C:\\a', 'C:a'],
      ['C:\\a', '\\a'],
      ['C:\\a', '\\\\?\\C:\\a'],
      ['C:\\a', '\\\\.\\C:\\a'],
      ['C:\\a', '\\\\localhost\\c$\\a'],
      ['\\\\server\\share\\dir', '\\\\SERVER\\share\\dir'],
      ['\\\\server\\share\\dir', '\\\\server\\SHARE\\dir'],
      ['\\\\server\\share\\dir', '\\\\server\\share\\DIR'],
      ['/Users/me', '\\Users\\me'],
      ['/users/me', '/Users/me']
    ];
    for (const [a, b] of pairs) assert.notEqual(key(a), key(b), `${a} | ${b}`);
  });

  it('keeps every relative, POSIX, device and drive-relative string byte for byte', () => {
    for (const raw of exact) assert.equal(key(raw), raw, JSON.stringify(raw));
  });

  it('is total, repeatable and idempotent, and works handed on as a mapper', () => {
    const corpus = [...spellings, ...exact, ...malformed, 'C:\\Users\\me', 'c:/a\\B/'];
    const once = corpus.map(key);
    assert.deepEqual(corpus.map(win32.paths().key), once);
    corpus.forEach((raw, i) => {
      assert.equal(typeof once[i], 'string');
      assert.equal(key(raw), once[i]);
    });
    assert.deepEqual(once.map(key), once);
  });

  it('leaves every raw path as spelled beside its key', () => {
    const raws = ['c:/Users/me/Repo', '//server/share/x', 'C:foo'];
    const copies = raws.map((raw) => raw.slice());
    const keys = raws.map(key);
    assert.deepEqual(raws, copies);
    assert.deepEqual(keys, ['C:\\Users\\me\\Repo', '\\\\server\\share\\x', 'C:foo']);
  });

  // Both compiled modules are read before the watch and run as fresh CommonJS
  // bodies under it, so the loader's own reads need no exemption.
  const load = createRequire(__filename);
  const file = load.resolve('../../core/platform/paths/win32');
  const source = fsSync.readFileSync(file, 'utf8');
  const sharedFile = load.resolve('../../core/platform/paths/index');
  const sharedSource = fsSync.readFileSync(sharedFile, 'utf8');

  it('reads, spawns and schedules nothing to load, build or use a key', () => {
    assert.deepEqual(effectsOf(source), []);
  });

  it('would see a backend that touched the disk as it loaded', () => {
    const touching = `${source}\nrequire('node:fs').statSync(__filename);`;
    assert.deepEqual(effectsOf(touching), ['statSync']);
  });

  it('would see the shared module touching the disk as it loaded', () => {
    const touching = `${sharedSource}\nrequire('node:fs').statSync(__filename);`;
    assert.deepEqual(effectsOf(source, touching), ['statSync']);
  });

  function effectsOf(body: string, sharedBody = sharedSource): string[] {
    const run = vm.compileFunction(
      body,
      ['exports', 'require', 'module', '__filename', '__dirname'],
      { filename: file }
    ) as (
      exports: object,
      require: (id: string) => unknown,
      module: { exports: object },
      filename: string,
      dirname: string
    ) => void;
    const shared = { exports: {} };
    const runShared = vm.compileFunction(
      sharedBody,
      ['exports', 'require', 'module', '__filename', '__dirname'],
      { filename: sharedFile }
    ) as typeof run;
    const local = (id: string): unknown => {
      if (id === './index') return shared.exports;
      if (id === 'path' || id === 'node:path') return path;
      if (id === 'node:fs') return fsSync;
      throw new Error(`unexpected paths dependency: ${id}`);
    };
    const calls: string[] = [];
    const watched = [
      [
        fsSync,
        ['statSync', 'lstatSync', 'realpathSync', 'readFileSync', 'existsSync', 'readdirSync']
      ],
      [fs, ['stat', 'lstat', 'realpath', 'readFile', 'readdir', 'access']],
      [cp, ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']],
      [globalThis, ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']]
    ] as const;
    const restore: (() => void)[] = [];
    for (const [owner, names] of watched) {
      const target = owner as unknown as Record<string, unknown>;
      for (const name of names) {
        const original = target[name] as (...args: unknown[]) => unknown;
        target[name] = (...args: unknown[]) => {
          calls.push(name);
          return original(...args);
        };
        restore.push(() => {
          target[name] = original;
        });
      }
    }
    try {
      const loaded = { exports: {} as Partial<typeof win32> };
      runShared(shared.exports, local, shared, sharedFile, path.dirname(sharedFile));
      run(loaded.exports, local, loaded, file, path.dirname(file));
      const fresh = loaded.exports.paths?.();
      assert.ok(fresh, 'the compiled backend exports paths');
      for (const raw of [...spellings, ...exact, ...malformed]) {
        fresh.key(raw);
        fresh.contains('C:\\Users\\me', raw);
        fresh.contains(raw, 'c:/Users/me/repo');
      }
    } finally {
      for (const undo of restore) undo();
    }
    return calls;
  }
});

describe('lexical containment', () => {
  const holds = (contains: (outer: string, inner: string) => boolean, pairs: string[][]) => {
    for (const [outer = '', inner = ''] of pairs) {
      assert.equal(contains(outer, inner), true, `${outer} holds ${inner}`);
    }
  };
  const refuses = (contains: (outer: string, inner: string) => boolean, pairs: string[][]) => {
    for (const [outer = '', inner = ''] of pairs) {
      assert.equal(contains(outer, inner), false, `${outer} refuses ${inner}`);
    }
  };

  describe('win32', () => {
    const { contains } = win32.paths();

    it('holds a folder and what is under it, in any drive or separator spelling', () => {
      holds(contains, [
        ['C:\\Users\\me\\apps', 'C:\\Users\\me\\apps'],
        ['c:\\Users\\me\\apps', 'C:\\Users\\me\\apps\\admin'],
        ['C:/Users/me/apps/', 'c:\\Users\\me\\apps\\admin\\src'],
        ['C:\\Users\\me\\apps\\', 'C:\\Users\\me\\apps'],
        ['C:\\Users\\me\\apps', 'C:\\Users\\me\\apps\\.\\admin\\\\src\\'],
        ['c:\\', 'C:\\'],
        ['c:/', 'C:\\Users\\me'],
        ['C:/', 'c:\\'],
        ['\\\\server\\share', '//server/share/'],
        ['//server/share/', '\\\\server\\share'],
        ['\\\\server\\share', '//server/share/apps/admin'],
        ['//server/share/apps', '\\\\server\\share\\apps\\admin']
      ]);
    });

    for (const raw of [
      '\\repo',
      '/repo',
      '/',
      '\\',
      '\\repo/child',
      '/repo\\child',
      '\\/repo',
      '/\\repo',
      '///repo/share',
      '\\\\server',
      '//server/',
      'C:repo',
      'C:',
      '1:\\repo',
      '\u00e9:\\repo'
    ]) {
      it(`refuses unqualified input ${JSON.stringify(raw)} in either position`, () => {
        refuses(contains, [
          [raw, raw],
          [raw, raw + '/child'],
          [raw + '/child', raw],
          [raw, 'C:\\repo\\child'],
          ['C:\\', raw],
          [raw, '\\\\server\\share\\child'],
          ['\\\\server\\share', raw]
        ]);
      });
    }

    it('refuses siblings, escapes and other volumes', () => {
      refuses(contains, [
        ['C:\\Users\\me\\apps\\admin', 'C:\\Users\\me\\apps\\admin-two'],
        ['C:\\Users\\me\\apps\\admin', 'C:\\Users\\me\\apps\\admin\\..\\..\\evil'],
        ['C:\\Users\\me\\apps\\admin', 'c:/Users/me/apps/admin/../admin-two/x'],
        ['C:\\Users\\me\\apps', 'C:\\Users\\me'],
        ['C:\\Users\\me\\apps', 'D:\\Users\\me\\apps'],
        ['C:\\', 'D:\\'],
        ['C:\\Users\\me', '\\\\localhost\\c$\\Users\\me'],
        ['\\\\server\\share', '\\\\server\\share2\\apps'],
        ['\\\\server\\share\\apps', '\\\\server\\share\\apps\\..\\..\\other'],
        ['\\\\server\\share', '\\\\other\\share\\apps']
      ]);
      // `..` stops at a share, as at a drive root.
      holds(contains, [
        ['\\\\server\\share', '\\\\server\\share\\..\\..\\other\\x'],
        ['C:\\', 'C:\\x\\..\\..\\..']
      ]);
    });

    // The key keeps case past the drive letter, so containment does too:
    // `path.win32.relative` would answer `child` for the first pair.
    it('keeps case-distinct siblings apart, as the key does', () => {
      refuses(contains, [
        ['C:\\x\\Foo', 'C:\\x\\foo\\child'],
        ['C:\\x\\foo', 'C:\\x\\Foo'],
        ['C:\\Users\\me\\apps', 'C:\\users\\me\\apps\\admin'],
        ['\\\\server\\share', '\\\\SERVER\\share\\apps'],
        ['\\\\server\\share', '\\\\server\\SHARE\\apps']
      ]);
      holds(contains, [['C:\\x\\Foo', 'c:/x/Foo/child']]);
    });

    it('holds nothing relative, and climbs no device path', () => {
      refuses(contains, [
        ['C:\\Users\\me', 'Users\\me'],
        ['.', '.'],
        ['', ''],
        ['C:', 'C:foo'],
        ['C:\\Users\\me', 'C:Users\\me'],
        ['\\\\?\\C:\\Users\\me', '\\\\?\\C:\\Users\\me\\..\\..\\evil'],
        ['\\\\?\\C:\\Users', '\\\\?\\C:\\Users\\me\\..\\x'],
        ['C:\\Users\\me', '\\\\?\\C:\\Users\\me\\x']
      ]);
      holds(contains, [['\\\\?\\C:\\Users', '\\\\?\\C:\\Users\\me']]);
    });
  });

  describe('darwin', () => {
    const { contains } = darwin.paths();

    it('matches legacy relative containment after resolving caller inputs', () => {
      const inputs = [
        '',
        '.',
        '..',
        'app',
        'app/child',
        '/repo',
        '/repo/',
        '//repo',
        '/repo/./child',
        '/repo/../other',
        '/repo/..hidden',
        '/repo2',
        '/Repo/child',
        '/'
      ];
      for (const outer of inputs)
        for (const inner of inputs) {
          const relative = path.posix.relative(outer, inner);
          const legacy =
            relative === '' ||
            (!relative.startsWith('../') && relative !== '..' && !path.posix.isAbsolute(relative));
          assert.equal(
            contains(path.posix.resolve(outer), path.posix.resolve(inner)),
            legacy,
            `${outer} | ${inner}`
          );
        }
    });

    it('holds by the raw bytes, and refuses siblings and escapes', () => {
      holds(contains, [
        ['/Users/me/apps', '/Users/me/apps'],
        ['/Users/me/apps/', '/Users/me/apps/admin'],
        ['/', '/tmp/work'],
        ['/', '/']
      ]);
      refuses(contains, [
        ['/repo', '/repo-two'],
        ['/repo', '/repo/../../tmp/evil'],
        ['/x/Foo', '/x/foo/child'],
        ['/tmp/x', '/private/tmp/x'],
        ['/Users/me', 'Users/me'],
        ['C:\\Users', 'C:\\Users\\me']
      ]);
    });
  });
});

describe('stores keyed by a directory', () => {
  type Modules = {
    arrange: typeof import('../../core/arrange');
    theme: typeof import('../../core/repo_theme');
    ports: typeof import('../../core/devservers/ports');
    servers: typeof import('../../core/devservers/servers');
    journal: typeof import('../../core/checkpoint_journal');
    paths: typeof import('../../core/paths');
  };
  let home: string;
  let m: Modules;

  before(async () => {
    home = await tempHome();
    m = {
      arrange: await import('../../core/arrange'),
      theme: await import('../../core/repo_theme'),
      ports: await import('../../core/devservers/ports'),
      servers: await import('../../core/devservers/servers'),
      journal: await import('../../core/checkpoint_journal'),
      paths: await import('../../core/paths')
    };
  });

  const digest = (algorithm: string, raw: string, length: number) =>
    createHash(algorithm).update(raw).digest('hex').slice(0, length);
  const field = async (file: string, name: string) =>
    (JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>)[name];

  // Forward only: a win32 file written under another spelling before keys folded
  // is not looked for.
  it('names each file by the key, and keeps the raw spelling inside it', async () => {
    const native = path.join(home, 'Some Repo');
    // On win32, the same directory with the drive VS Code's `fsPath` lowers.
    const cwd =
      testPlatform() === 'win32' ? native.charAt(0).toLowerCase() + native.slice(1) : native;
    const name = digest('sha256', native, 16);
    assert.equal(platform.paths.key(cwd), native);

    await m.arrange.writeArrangement(cwd, [{ pid: 1, startedAt: 1 }]);
    assert.equal(await field(path.join(m.paths.ARRANGE_DIR, `${name}.json`), 'cwd'), cwd);

    assert.equal(await m.theme.writeRepoTheme(cwd, 'follow'), true);
    assert.equal(await field(path.join(m.paths.THEMES_DIR, `${name}.json`), 'folder'), cwd);

    await m.ports.rememberPort(cwd, 'main', 'dev', 3000);
    assert.equal(await field(path.join(m.paths.PORTS_DIR, `${name}.json`), 'repoRoot'), cwd);

    await m.servers.writeServer({
      cwd,
      runnerId: 'dev',
      label: 'npm run dev',
      windowId: 'me',
      status: 'up',
      startedAt: 0,
      updatedAt: 0
    });
    assert.equal(await field(path.join(m.paths.SERVERS_DIR, `${name}.dev.json`), 'cwd'), cwd);

    assert.equal(
      m.journal.windowsFile(cwd),
      path.join(m.paths.CHECKPOINTS_DIR, `Some-Repo-${digest('sha1', native, 12)}.jsonl`)
    );
  });
});
