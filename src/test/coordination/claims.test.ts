import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { linkDir, resetDir, tempHome, testPlatform, writeJson } from '../helpers';
import { withFoldedKeys } from '../folded_keys';
import type { WindowClaim } from '../../core/model';

type Claims = typeof import('../../core/coordination/claims');

let claims: Claims;
let dir: string;

before(async () => {
  await tempHome();
  claims = await import('../../core/coordination/claims');
  dir = claims.WINDOWS_DIR;
});

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

function claim(over: Partial<WindowClaim> = {}): WindowClaim {
  return {
    id: 'w1',
    label: 'agentsview',
    app: 'VS Code',
    shellPids: [],
    updatedAt: Date.now(),
    ...over
  };
}

/** Whatever a window wrote, live or not — the narrowing is the thing under test. */
async function write(name: string, value: unknown): Promise<string> {
  const file = path.join(dir, `${name}.json`);
  await writeJson(file, value);
  return file;
}

describe('readClaims', () => {
  // Every case here asserts over the whole directory, and the reader removes
  // what it rejects — so each starts from a machine with no windows on it.
  beforeEach(() => resetDir(dir));

  it('says nothing about a machine that has published no window', async () => {
    assert.deepEqual(await claims.readClaims(), []);
  });

  it('offers a fresh claim', async () => {
    const file = await write('fresh', claim({ id: 'fresh' }));

    const found = await claims.readClaims();

    assert.deepEqual(
      found.map((c) => c.id),
      ['fresh']
    );
    assert.equal(await exists(file), true);
  });

  it('removes a claim the window that wrote it never came back to', async () => {
    const file = await write('stale', claim({ id: 'stale', updatedAt: Date.now() - 10 * 60_000 }));

    assert.deepEqual(await claims.readClaims(), []);
    assert.equal(await exists(file), false);
  });

  // The one that made a malformed file immortal: `Date.now() - undefined` is
  // `NaN`, every comparison against it is false, so the claim was neither swept
  // nor rejected — and nothing else sweeps this directory.
  it('rejects and removes a claim with no timestamp', async () => {
    const file = await write('undated', { id: 'undated', label: 'x', app: 'y', shellPids: [] });

    assert.deepEqual(await claims.readClaims(), []);
    assert.equal(await exists(file), false);
  });

  it('rejects and removes a file that is not a window at all', async () => {
    const files = [
      await write('array', [1, 2, 3]),
      await write('scalar', 'window'),
      await write('nameless', { label: 'x', app: 'y', shellPids: [], updatedAt: Date.now() }),
      await write('pidless', { id: 'p', label: 'x', app: 'y', updatedAt: Date.now() })
    ];

    assert.deepEqual(await claims.readClaims(), []);
    for (const file of files) {
      assert.equal(await exists(file), false, `expected ${path.basename(file)} gone`);
    }
  });

  /**
   * The shape `WindowClaimant.publish` writes: no shell pids, ever. It is only
   * worth writing if it reads back as a live window that can be handed work.
   */
  it('reads a claim with no shell pids as a live window', async () => {
    await write('seeded', {
      id: 'seeded',
      label: 'agentsview',
      app: 'VS Code',
      folder: '/work/app',
      shellPids: [],
      brands: ['claude', 'grok'],
      updatedAt: Date.now()
    });

    const [found] = await claims.readClaims();
    assert.ok(found, 'an empty-pid claim is a live window, not a malformed file');
    assert.equal(found.folder, '/work/app');
    // `brands` is still parsed and still on the claim; nothing reads it here
    // since row 71 took the routed start away, and it stays for an older
    // window that does.
    assert.deepEqual(found.brands, ['claude', 'grok']);
  });

  // `isClaim` never looks at `orchestration`: a stricter check would delete a
  // live window's claim file, and a missing or odd field reads as off at the
  // gate (`cli/gate.ts`), not here.
  it('keeps a claim live whatever its orchestration field holds', async () => {
    await write('on', claim({ id: 'on', orchestration: true }));
    await write('off', claim({ id: 'off', orchestration: false }));
    await write('absent', claim({ id: 'absent' }));
    await write('odd', { ...claim({ id: 'odd' }), orchestration: 'yes' });

    const found = await claims.readClaims();

    assert.deepEqual(found.map((c) => c.id).sort(), ['absent', 'odd', 'off', 'on']);
    assert.equal(found.find((c) => c.id === 'on')?.orchestration, true);
    assert.equal(found.find((c) => c.id === 'off')?.orchestration, false);
    assert.equal(found.find((c) => c.id === 'absent')?.orchestration, undefined);
  });

  it('reads past a half-written file to the claims either side of it', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'half.json'), '{"id":"half","upda');
    await write('whole', claim({ id: 'whole' }));

    const found = await claims.readClaims();

    assert.deepEqual(
      found.map((c) => c.id),
      ['whole']
    );
  });
});

describe('windowForCwd', () => {
  /** A `checkoutRoots` that knows only these folders, so no repository is needed. */
  const roots =
    (pairs: Record<string, string>) =>
    (folders: Iterable<string>): Promise<Map<string, string>> =>
      Promise.resolve(
        new Map([...folders].flatMap((f) => (pairs[f] === undefined ? [] : [[f, pairs[f]]])))
      );
  const at = (id: string, folder: string | undefined, updatedAt: number) =>
    claim({ id, folder, updatedAt });

  // D26: a fresh session for a cwd no window holds is refused, not sent to
  // whichever window answered last.
  it('names no window for an unrelated cwd without the fallback', async () => {
    const live = [at('a', '/a', 1), at('b', '/b', 2)];

    assert.equal(
      await claims.windowForCwd(live, '/elsewhere', roots({}), { fallback: false }),
      undefined
    );
    assert.equal(
      (await claims.windowForCwd(live, '/elsewhere', roots({}), { fallback: true }))?.id,
      'b'
    );
  });

  it('still finds a linked worktree’s window by its repository', async () => {
    const live = [at('other', '/other', 2), at('repo', '/repo', 1)];

    const found = await claims.windowForCwd(
      live,
      '/wt/feature',
      roots({ '/wt/feature': '/repo', '/repo': '/repo', '/other': '/other' }),
      { fallback: false }
    );

    assert.equal(found?.id, 'repo');
  });

  // R9d: a folder that is no repository still holds what is under it.
  it('holds a subfolder of a window’s folder that is in no repository', async () => {
    const live = [at('notes', '/notes', 1), at('newer', '/b', 2)];

    const found = await claims.windowForCwd(live, '/notes/drafts', roots({}), {
      fallback: false
    });

    assert.equal(found?.id, 'notes');
  });

  it('prefers the window on the folder itself to one on a folder above it', async () => {
    const live = [at('parent', '/repo', 2), at('exact', '/repo/packages/app', 1)];

    const found = await claims.windowForCwd(live, '/repo/packages/app', roots({}), {
      fallback: false
    });

    assert.equal(found?.id, 'exact');
  });

  it('holds a cwd its process resolved, under a window opened on a symlink to it', async () => {
    // A CLI states the cwd its own process resolved; the window keeps the
    // spelling it was opened with. Compared as spelled, D23's fresh session
    // for that root was refused "not open in any IDE window".
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'claims-'));
    const real = path.join(await fs.realpath(base), 'site');
    await fs.mkdir(path.join(real, 'src'), { recursive: true });
    const alias = path.join(base, 'alias');
    await linkDir(real, alias);

    const onAlias = [at('alias', alias, 1)];
    const found = await claims.windowForCwd(onAlias, path.join(real, 'src'), roots({}), {
      fallback: false
    });
    assert.equal(found?.id, 'alias');

    const onReal = [at('real', real, 1)];
    const back = await claims.windowForCwd(onReal, path.join(alias, 'src'), roots({}), {
      fallback: false
    });
    assert.equal(back?.id, 'real');
    await fs.rm(base, { recursive: true, force: true });
  });

  it('holds anything under a window open on the filesystem root', async () => {
    const live = [at('root', '/', 1)];

    const found = await claims.windowForCwd(live, '/tmp/work', roots({}), { fallback: false });

    assert.equal(found?.id, 'root');
    assert.equal(claims.folderContains('/', '/'), true);
  });

  it('holds a cwd, and finds its repository, spelled otherwise than the window’s', () =>
    withFoldedKeys(async () => {
      const held = await claims.windowForCwd(
        [at('notes', '/Notes', 1), at('newer', '/b', 2)],
        '/notes/drafts',
        roots({}),
        { fallback: false }
      );
      assert.equal(held?.id, 'notes');

      const repo = await claims.windowForCwd(
        [at('other', '/other', 2), at('repo', '/code/a', 1)],
        '/wt/feature',
        roots({ '/wt/feature': '/Code/Repo', '/code/a': '/code/repo', '/other': '/other' }),
        { fallback: false }
      );
      assert.equal(repo?.id, 'repo');
    }));

  it('does not take a sibling sharing a prefix for a containing folder', async () => {
    const live = [at('two', '/repo-two', 1)];

    assert.equal(
      await claims.windowForCwd(live, '/repo', roots({}), { fallback: false }),
      undefined
    );
  });
  it('holds nothing a `..` climbs out to, or a case-distinct sibling', async () => {
    const live = [at('admin', '/apps/admin', 1), at('Foo', '/x/Foo', 2)];

    for (const cwd of ['/apps/admin/../../tmp/evil', '/apps/admin/../admin-two', '/x/foo/child']) {
      assert.equal(
        await claims.windowForCwd(live, cwd, roots({}), { fallback: false }),
        undefined,
        cwd
      );
    }
    const trailing = await claims.windowForCwd(
      [at('admin', '/apps/admin/', 1), at('newer', '/b', 2)],
      '/apps/admin/src',
      roots({}),
      { fallback: true }
    );
    assert.equal(trailing?.id, 'admin');
  });

  // Each `roots` answers only the exact strings it is handed, so the repo tier
  // reads it by the claim's and the cwd's own spelling, and compares the
  // answers by key.
  it('reads the resolver by the spellings it was handed', async () => {
    const asked: string[] = [];
    const resolve = (folders: Iterable<string>) => {
      asked.push(...folders);
      return roots({ '/wt/feature/': '/repo', '/code/./a': '/repo' })(folders);
    };
    const found = await claims.windowForCwd(
      [at('newer', '/other', 2), at('repo', '/code/./a', 1)],
      '/wt/feature/',
      resolve,
      { fallback: false }
    );
    assert.equal(found?.id, 'repo');
    assert.deepEqual(asked.sort(), ['/code/./a', '/other', '/wt/feature/']);
  });
});

/**
 * The native spellings one Windows directory reaches us in (paths task,
 * Notes): VS Code's `fsPath` lowers the drive letter, git answers with `/`, and
 * a CLI states the upper-drive cwd its process resolved. None of these folders
 * exist, so each is compared as `path.resolve` spells it. The UNC ones name a
 * missing share on `localhost`: `realpath` refuses it in milliseconds, where an
 * unknown server waited 2.7 s on name resolution (2026-10-26).
 */
describe(
  'windowForCwd on win32 spellings',
  {
    skip: testPlatform() !== 'win32' && 'posix: drive and UNC spellings are win32 paths'
  },
  () => {
    const roots =
      (pairs: Record<string, string>) =>
      (folders: Iterable<string>): Promise<Map<string, string>> =>
        Promise.resolve(
          new Map([...folders].flatMap((f) => (pairs[f] === undefined ? [] : [[f, pairs[f]]])))
        );
    const at = (id: string, folder: string, updatedAt: number) => claim({ id, folder, updatedAt });
    const newer = at('newer', 'C:\\Users\\me\\elsewhere', 9);
    const pick = (folder: string, cwd: string, fallback = true) =>
      claims
        .windowForCwd([at('held', folder, 1), newer], cwd, roots({}), { fallback })
        .then((found) => found?.id);

    it('holds a CLI cwd under a window whose drive letter or separators differ', async () => {
      for (const [folder, cwd] of [
        ['c:\\Users\\me\\apps\\admin', 'C:\\Users\\me\\apps\\admin\\src'],
        ['C:\\Users\\me\\apps\\admin', 'c:\\Users\\me\\apps\\admin'],
        ['c:/Users/me/apps/admin/', 'C:\\Users\\me\\apps\\admin\\src'],
        ['C:\\Users\\me\\apps\\admin', 'c:/Users/me/apps/admin/src'],
        ['c:\\', 'C:\\Users\\me\\apps'],
        ['\\\\localhost\\sq-share\\apps', '//localhost/sq-share/apps/admin']
      ] as const) {
        assert.equal(await pick(folder, cwd), 'held', `${folder} holds ${cwd}`);
      }
    });

    it('sends a cwd no window holds to the newest, never to a near miss', async () => {
      for (const [folder, cwd] of [
        ['c:\\Users\\me\\apps\\admin', 'C:\\Users\\me\\apps\\admin-two'],
        ['c:\\Users\\me\\apps\\admin', 'C:\\Users\\me\\apps\\admin\\..\\..\\evil'],
        ['c:\\Users\\me\\apps\\admin', 'D:\\Users\\me\\apps\\admin'],
        ['\\\\localhost\\sq-share\\apps', '\\\\localhost\\sq-share2\\apps\\admin'],
        ['\\\\localhost\\sq-share\\apps', '\\\\LOCALHOST\\sq-share\\apps\\admin'],
        // A case-sensitive directory can hold both.
        ['C:\\Users\\me\\x\\Foo', 'C:\\Users\\me\\x\\foo\\child']
      ] as const) {
        assert.equal(await pick(folder, cwd), 'newer', `${folder} does not hold ${cwd}`);
        assert.equal(await pick(folder, cwd, false), undefined, `${folder} without fallback`);
      }
    });

    it('prefers the deeper folder whatever either is spelled', async () => {
      const found = await claims.windowForCwd(
        [at('deep', 'c:/Users/me/apps/admin', 1), at('parent', 'C:\\Users\\me\\apps', 2), newer],
        'C:\\Users\\me\\apps\\admin\\src',
        roots({}),
        { fallback: true }
      );
      assert.equal(found?.id, 'deep');
    });

    it('finds a worktree’s window by the repository git spells with `/`', async () => {
      const cwd = 'C:\\Users\\me\\wt\\feature';
      const folder = 'c:\\Users\\me\\apps';
      const found = await claims.windowForCwd(
        [at('repo', folder, 1), newer],
        cwd,
        roots({
          [cwd]: 'C:/Users/me/apps',
          [folder]: 'c:\\Users\\me\\apps',
          [newer.folder ?? '']: 'C:/Users/me/elsewhere'
        }),
        { fallback: true }
      );
      assert.equal(found?.id, 'repo');

      const unrelated = await claims.windowForCwd(
        [at('repo', folder, 1), newer],
        cwd,
        roots({ [cwd]: 'C:/Users/me/apps-two', [folder]: 'c:\\Users\\me\\apps' }),
        { fallback: false }
      );
      assert.equal(unrelated, undefined);
    });
  }
);
