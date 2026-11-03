import * as assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot, testPlatform } from '../helpers';

/**
 * `scripts/release.mjs` and `scripts/deploy.mjs`, driven as the processes they are.
 *
 * Both scripts deliberately import nothing from `out/`: a deploy that needed
 * this checkout to compile would be useless for the rollback it exists to
 * serve. So there are no functions to import here, and the contract under test
 * is the real one — exit codes, stdout, and what git holds afterwards.
 *
 * Each case gets a throwaway repository with the script copied into it, since
 * both resolve their root from `import.meta.dirname`. No real IDE is launched
 * or installed into. Release gates are tiny fixtures; deploy's packaging and
 * install tools write temporary archives and extension directories only.
 */

const REPO = repoRoot();

/**
 * The environment minus git's own variables, and minus the host overrides.
 *
 * The gate runs from the pre-commit hook, and git exports `GIT_DIR` and
 * `GIT_INDEX_FILE` into a hook pointing at the repository being committed. They
 * beat `cwd`, so without this every `git` below operates on *this* checkout
 * instead of its temp one — observed as `error: invalid object ... for 'f'`
 * while cutting a real release, the tests having written their fixture into the
 * index of the commit that was running them.
 *
 * `SQUADRON_IDE_*` / `ANTIGRAVITY_*` go for the same reason one step removed:
 * they are exported on a machine that targets a second host, and a case that
 * sets one of them would be measuring the developer's shell instead.
 */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('SQUADRON_VERIFY_') &&
      key !== 'SQUADRON_TIMINGS_FILE' &&
      !key.startsWith('SQUADRON_RUN') &&
      !key.startsWith('GIT_') &&
      !key.startsWith('SQUADRON_IDE_') &&
      !key.startsWith('ANTIGRAVITY_')
  )
);

/** A repository with fake gates, a lockfile, and one commit to tag. */
async function repo(version = '2026.30.4', changelogVersion = '2026.31.10'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-release-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: CLEAN });
  git('init', '--quiet', '--initial-branch=work', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // Never opened: every case either passes --notes or expects a refusal.
  git('config', 'core.editor', 'true');
  await fs.mkdir(path.join(dir, 'scripts'));
  for (const script of [
    'scripts/release.mjs',
    'scripts/deploy.mjs',
    'scripts/zip.mjs',
    'scripts/checkpoints.mjs',
    'scripts/verification_processes.mjs',
    'scripts/checkpoint-reporter.mjs',
    'scripts/observation.mjs',
    'scripts/release_candidate.mjs',
    'scripts/private-files-helper.mjs',
    'scripts/windows-helper-artifacts.mjs',
    'scripts/console-login-helper.mjs',
    'scripts/packaged-bundles.mjs',
    'scripts/integration.mjs'
  ]) {
    await fs.copyFile(path.join(REPO, script), path.join(dir, script));
  }
  await fs.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'squadron',
        publisher: 'acme',
        version,
        scripts: {
          check: 'node fixture-gate.cjs check',
          'test:smoke': 'node fixture-gate.cjs smoke',
          'test:smoke:one': 'node fixture-gate.cjs remote'
        }
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(
    path.join(dir, 'fixture-gate.cjs'),
    `
const fs = require('node:fs');
const mode = process.argv[2];
if (mode.endsWith('-log')) console.log(process.cwd());
if (mode === 'check' && process.env.RELEASE_FAIL_IF_FILE && fs.existsSync(process.env.RELEASE_FAIL_IF_FILE)) process.exit(1);
if (mode.startsWith('check') && process.env.RELEASE_FAIL_CHECK) process.exit(mode === 'check' ? 1 : Number(process.env.RELEASE_FAIL_CHECK));
if (mode.startsWith('smoke') && process.env.RELEASE_FAIL_SMOKE) process.exit(mode === 'smoke' ? 1 : Number(process.env.RELEASE_FAIL_SMOKE));
if (mode === 'remote' && (process.env.RELEASE_FAIL_SMOKE_REMOTE || process.argv[3] !== 'out/test/smoke/remote_panel.smoke.js')) process.exit(1);
`
  );
  await fs.writeFile(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'squadron',
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'squadron', version } }
    })
  );
  await fs.writeFile(
    path.join(dir, 'CHANGELOG.md'),
    `# Changelog\n\n## ${changelogVersion}\n\n- Something worth releasing.\n`
  );
  // Tracked from the start, so a later `commit -am` has something to carry.
  await fs.writeFile(path.join(dir, 'f'), 'one\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'feat: something worth releasing');
  return dir;
}

type Ran = { code: number; out: string; err: string };

/** Run a script in its repository. Never throws — the exit code is the answer. */
function run(dir: string, script: string, args: string[], env: NodeJS.ProcessEnv = {}): Ran {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, script), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...CLEAN, SQUADRON_GATE_DIR: path.join(dir, 'fixture-gate'), ...env },
      stdio: 'pipe'
    });
    return { code: 0, out, err: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: failure.stdout ?? '', err: failure.stderr ?? '' };
  }
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: CLEAN }).trim();

/** An annotated release tag carrying the local gate result for HEAD. */
const tagAt = (dir: string, tag: string, message = `notes for ${tag}`) =>
  git(
    dir,
    'tag',
    '-a',
    tag,
    '-m',
    `${message}\n\nGate: check+smoke ${git(dir, 'rev-parse', 'HEAD^{tree}')}`
  );

/** A commit after the tag, so there is something to release. */
let counter = 0;
function commit(dir: string, subject = 'fix: something since the tag'): void {
  fsSync.appendFileSync(path.join(dir, 'f'), `${(counter += 1)}\n`);
  git(dir, 'commit', '--quiet', '-am', subject);
}

const notesFile = async (dir: string, text: string): Promise<string> => {
  const file = path.join(dir, 'NOTES');
  await fs.writeFile(file, text);
  return file;
};

/** On a case that reaches the release's gates, which run npm. */
const npmSkip: false | string =
  testPlatform() === 'win32' &&
  'win32: release candidate archives use sh/tar; deploy invokes shell tools — W8.3';

describe('release: the version it would cut', () => {
  it(
    'marks an explicitly requested POSIX staging release and requires the option again',
    { skip: npmSkip },
    async (t) => {
      const dir = await repo('0.5.43', '0.5.44');
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      git(dir, 'branch', '-m', 'staging');
      tagAt(dir, 'v2026.44.12');
      const notes = await notesFile(dir, 'local staging release\n');
      const ran = run(dir, 'scripts/release.mjs', [
        '--without-windows-helper',
        '--notes',
        notes,
        '--no-push'
      ]);
      assert.equal(ran.code, 0, ran.err);
      const manifest = JSON.parse(
        await fs.readFile(path.join(dir, 'package.json'), 'utf8')
      ) as Record<string, unknown>;
      assert.equal(manifest.squadronBuild, 'posix-staging');
      await fs.appendFile(path.join(dir, 'CHANGELOG.md'), '\n## 0.5.45\n\n- Next release.\n');
      git(dir, 'commit', '--quiet', '-am', 'docs: next release');
      const next = run(dir, 'scripts/release.mjs', ['--notes', notes, '--no-push']);
      assert.equal(next.code, 0, next.err);
      const nextManifest = JSON.parse(
        await fs.readFile(path.join(dir, 'package.json'), 'utf8')
      ) as Record<string, unknown>;
      assert.equal(nextManifest.squadronBuild, undefined);
      git(dir, 'branch', '-m', 'main');
      const refused = run(dir, 'scripts/release.mjs', ['--dry', '--without-windows-helper']);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /only on staging/);
    }
  );

  it(
    'keeps the calendar tag while choosing a public extension version',
    { skip: npmSkip },
    async () => {
      const dir = await repo('2026.40.1', '0.2.0');
      tagAt(dir, 'v2026.40.1');
      commit(dir);
      const notes = await notesFile(dir, 'first public release\n');
      const ran = run(
        dir,
        'scripts/release.mjs',
        ['--version', '0.2.0', '--notes', notes, '--no-push'],
        {
          RELEASE_NOW: '2026-09-28'
        }
      );
      assert.equal(ran.code, 0, ran.err);
      assert.equal(git(dir, 'cat-file', '-t', 'v2026.40.2'), 'tag');
      assert.match(
        await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
        /"version": "0\.2\.0"/
      );

      commit(dir);
      const next = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-09-28' });
      assert.equal(next.code, 0, next.err);
      assert.match(next.out, /extension version: 0\.2\.1/);
    }
  );

  it('counts from package.json before the first tag exists', async () => {
    const dir = await repo('2026.31.9');
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.out.split('\n')[0], '2026.31.10');
  });

  it('counts from the newest tag, not from package.json', async () => {
    const dir = await repo('2026.31.2');
    tagAt(dir, 'v2026.31.40');
    commit(dir);
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.out.split('\n')[0], '2026.31.41');
  });

  it('restarts the counter in a new ISO week', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.30.4');
    commit(dir);
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.out.split('\n')[0], '2026.31.1');
  });

  it('orders 10 above 9 when picking the tag to count from', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    tagAt(dir, 'v2026.31.10');
    commit(dir);
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.out.split('\n')[0], '2026.31.11');
  });

  it('drafts the commits since the last tag into the notes', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.1');
    commit(dir, 'fix: the thing that was broken');
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.match(ran.out, /fix: the thing that was broken/);
  });

  it('writes nothing on a dry run', async () => {
    const dir = await repo('2026.31.9');
    run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.match(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), /2026\.31\.9/);
    assert.equal(git(dir, 'tag', '-l'), '');
  });
});

describe('release: what it refuses', () => {
  it(
    'authorizes its exact staging version update through the real ref guard',
    { skip: npmSkip },
    async () => {
      const dir = await repo('2026.31.9');
      git(dir, 'branch', '-m', 'staging');
      await fs.mkdir(path.join(dir, '.githooks'));
      const hook = path.join(dir, '.githooks', 'reference-transaction');
      await fs.copyFile(path.join(REPO, '.githooks', 'reference-transaction'), hook);
      await fs.chmod(hook, 0o755);
      git(dir, 'add', '.githooks');
      commit(dir);
      git(dir, 'config', 'core.hooksPath', '.githooks');
      const before = git(dir, 'rev-parse', 'HEAD');
      const ran = run(
        dir,
        'scripts/release.mjs',
        ['--notes', await notesFile(dir, 'verified staging release\n'), '--no-push'],
        { RELEASE_NOW: '2026-07-29' }
      );
      assert.equal(ran.code, 0, ran.err);
      const released = git(dir, 'rev-parse', 'staging');
      assert.notEqual(released, before);
      assert.equal(git(dir, 'rev-parse', `${released}^`), before);
      assert.equal(released, git(dir, 'rev-parse', 'v2026.31.10^{commit}'));
      assert.equal(run(dir, 'scripts/integration.mjs', ['push', before, released]).code, 0);
      assert.notEqual(run(dir, 'scripts/integration.mjs', ['push', released, released]).code, 0);
      const stray = git(
        dir,
        'commit-tree',
        git(dir, 'rev-parse', 'HEAD^{tree}'),
        '-p',
        'HEAD',
        '-m',
        'stray'
      );
      const refused = spawnSync('git', ['update-ref', 'refs/heads/staging', stray], {
        cwd: dir,
        env: CLEAN,
        encoding: 'utf8'
      });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /verified integration/);
      assert.equal(git(dir, 'rev-parse', 'staging'), released);
    }
  );

  for (const [name, changelog] of [
    ['missing file', null],
    ['wrong version', '# Changelog\n\n## 0.3.6\n\n- Previous release.\n'],
    ['empty entry', '# Changelog\n\n## 0.3.7\n\n## 0.3.6\n\n- Previous release.\n']
  ] as const) {
    it(`refuses a changelog with ${name} before running gates`, async () => {
      const dir = await repo('0.3.6', '0.3.7');
      tagAt(dir, 'v2026.40.14');
      if (changelog === null) git(dir, 'rm', 'CHANGELOG.md');
      else await fs.writeFile(path.join(dir, 'CHANGELOG.md'), changelog);
      commit(dir);
      const before = git(dir, 'rev-parse', 'HEAD');
      const ran = run(
        dir,
        'scripts/release.mjs',
        ['--notes', await notesFile(dir, 'next release\n'), '--no-push'],
        { RELEASE_NOW: '2026-10-04' }
      );
      assert.equal(ran.code, 1);
      assert.match(ran.err, /commit a nonempty `## 0\.3\.7` entry/);
      assert.ok(!ran.out.includes('release: dependencies'));
      assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
      assert.equal(git(dir, 'tag', '-l'), 'v2026.40.14');
      assert.equal(
        JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).version,
        '0.3.6'
      );
    });
  }

  it('refuses changelog edits that would be left out of the source archive', async () => {
    const dir = await repo('2026.31.9');
    await fs.appendFile(path.join(dir, 'CHANGELOG.md'), '- Uncommitted notes.\n');
    git(dir, 'add', 'CHANGELOG.md');
    const ran = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'next release\n'), '--no-push'],
      { RELEASE_NOW: '2026-07-29' }
    );
    assert.equal(ran.code, 1);
    assert.match(ran.err, /commit CHANGELOG\.md changes/);
    assert.ok(!ran.out.includes('release: dependencies'));
    assert.equal(git(dir, 'tag', '-l'), '');
  });

  it('refuses to reuse or lower an established public version', async () => {
    const dir = await repo('0.2.0');
    tagAt(dir, 'v2026.40.1');
    commit(dir);
    const ran = run(dir, 'scripts/release.mjs', ['--dry', '--version', '0.1.9'], {
      RELEASE_NOW: '2026-09-28'
    });
    assert.equal(ran.code, 1);
    assert.match(ran.err, /must advance past 0\.2\.0/);
  });

  it('refuses empty notes, and leaves no tag or commit behind', async () => {
    const dir = await repo();
    const before = git(dir, 'rev-parse', 'HEAD');
    const ran = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, '# only a comment\n')],
      {
        RELEASE_NOW: '2026-07-29'
      }
    );
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no notes/);
    assert.equal(git(dir, 'tag', '-l'), '');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
  });

  it('refuses when nothing has landed since the last release', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.1');
    // The draft is empty, so the notes are empty, so there is nothing to say
    // about a release that contains nothing. Refusing here is what stops a tag
    // being cut over the previous one's own commit.
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no notes/);
  });

  it('refuses a detached HEAD, which names no branch to push', async () => {
    const dir = await repo();
    git(dir, 'checkout', '--quiet', '--detach');
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.code, 1);
    assert.match(ran.err, /detached HEAD/);
  });

  it('refuses a version whose tag is already there', async () => {
    const dir = await repo('2026.31.9');
    tagAt(dir, 'v2026.31.10');
    // The tag exists but is not reachable from HEAD, so the count still lands
    // on it — which is exactly the collision worth refusing.
    git(dir, 'tag', '-d', 'v2026.31.10');
    git(dir, 'tag', 'v2026.31.10', 'HEAD');
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.code, 1);
    assert.match(ran.err, /already exists/);
  });
});

describe('release: what it writes', { skip: npmSkip }, () => {
  it('commits the version and annotates the tag with the notes', async () => {
    const dir = await repo('2026.31.9');
    const ran = run(
      dir,
      'scripts/release.mjs',
      [
        '--notes',
        await notesFile(dir, 'read-only terminals, and the arranged board\n'),
        '--no-push'
      ],
      { RELEASE_NOW: '2026-07-29' }
    );
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /release: check[\s\S]*release: smoke\n[\s\S]*release: smoke-remote/);
    assert.match(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), /"2026\.31\.10"/);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: version 2026.31.10');
    assert.equal(git(dir, 'cat-file', '-t', 'v2026.31.10'), 'tag');
    assert.match(
      git(dir, 'for-each-ref', '--format=%(contents)', 'refs/tags/v2026.31.10'),
      /read-only terminals/
    );
    assert.match(
      git(dir, 'cat-file', 'tag', 'v2026.31.10'),
      new RegExp(`^Gate: check\\+smoke ${git(dir, 'rev-parse', 'v2026.31.10^{tree}')}$`, 'm')
    );
  });

  it('commits package.json alone, leaving another session’s work staged', async () => {
    const dir = await repo('2026.31.9');
    await fs.writeFile(path.join(dir, 'someone-elses.ts'), 'export const busy = true;\n');
    git(dir, 'add', 'someone-elses.ts');
    const ran = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'a release\n'), '--no-push'],
      {
        RELEASE_NOW: '2026-07-29',
        RELEASE_FAIL_IF_FILE: 'someone-elses.ts'
      }
    );
    assert.equal(ran.code, 0, ran.err);
    assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim(), 'package.json');
    assert.match(git(dir, 'diff', '--cached', '--name-only'), /someone-elses\.ts/);
  });

  for (const gate of ['check', 'smoke'] as const) {
    it(`keeps a red ${gate} candidate and its evidence for explicit resume`, async () => {
      const dir = await repo('2026.31.9');
      await fs.copyFile(path.join(REPO, 'scripts/timed.mjs'), path.join(dir, 'scripts/timed.mjs'));
      const file = path.join(dir, 'package.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as {
        scripts: Record<string, string>;
      };
      manifest.scripts['check'] = 'node scripts/timed.mjs check="node fixture-gate.cjs check-log"';
      manifest.scripts['test:smoke'] =
        'node scripts/timed.mjs smoke="node fixture-gate.cjs smoke-log"';
      await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
      git(dir, 'add', 'scripts/timed.mjs', 'package.json');
      git(dir, 'commit', '--quiet', '-m', 'test: candidate evidence');
      const ran = run(
        dir,
        'scripts/release.mjs',
        ['--notes', await notesFile(dir, 'candidate\n'), '--no-push'],
        {
          RELEASE_NOW: '2026-07-29',
          [gate === 'check' ? 'RELEASE_FAIL_CHECK' : 'RELEASE_FAIL_SMOKE']: '1'
        }
      );
      assert.equal(ran.code, 1);
      const root = path.join(dir, '.git', 'squadron-runs');
      assert.ok(ran.err.includes(root), ran.err);
      const folders = await fs.readdir(root, { withFileTypes: true });
      const folder = folders.find(
        (entry) =>
          entry.isDirectory() && entry.name.includes(gate === 'check' ? '-check-' : '-test-smoke-')
      );
      assert.ok(folder);
      const extract = (
        await fs.readFile(path.join(root, folder.name, `${gate}.log`), 'utf8')
      ).trim();
      assert.match(extract, /squadron-candidates/);
      assert.equal(
        (await fs.stat(extract)).isDirectory(),
        true,
        'failed candidate is retained for resume'
      );
      assert.equal(git(dir, 'tag', '-l'), '');
    });
  }

  for (const [gate, variable] of [
    ['check', 'RELEASE_FAIL_CHECK'],
    ['smoke', 'RELEASE_FAIL_SMOKE'],
    ['smoke-remote', 'RELEASE_FAIL_SMOKE_REMOTE']
  ] as const) {
    it(`leaves no version commit or tag when ${gate} fails`, async () => {
      const dir = await repo('2026.31.9');
      const ran = run(
        dir,
        'scripts/release.mjs',
        ['--notes', await notesFile(dir, 'a release\n'), '--no-push'],
        { RELEASE_NOW: '2026-07-29', [variable]: '1' }
      );
      assert.equal(ran.code, 1);
      assert.match(ran.err, new RegExp(`${gate} failed`));
      assert.match(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), /"2026\.31\.9"/);
      assert.equal(git(dir, 'log', '-1', '--format=%s'), 'feat: something worth releasing');
      assert.equal(git(dir, 'tag', '-l'), '');
    });
  }
});

/**
 * What a release pushes, which since 2026-08-07 is the branch and the tag and
 * nothing else.
 *
 * It used to push `HEAD:main` as well, so cutting a tag *was* a merge — and the
 * merge nobody had made is what the linked-worktree refusal, the main-branch
 * refusal and `scripts/deploy.mjs`'s ancestor test were all guarding. `keep-awake` cut
 * v2026.32.14 from its worktree on 2026-08-05, main fast-forwarded past
 * `staging`, and the installed extension shipped a feature no integration
 * branch had seen. Splitting the two acts is what removed all three guards, so
 * this is the case that has to hold them up.
 */
describe('release: what it pushes', () => {
  /** A bare remote with the branch and `main` on it, wired up as `origin`. */
  async function remote(dir: string): Promise<string> {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-remote-'));
    execFileSync('git', ['init', '--quiet', '--bare', '.'], { cwd: bare, env: CLEAN });
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '--quiet', 'origin', 'work');
    git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
    return bare;
  }

  const remoteRef = (bare: string, ref: string) =>
    execFileSync('git', ['rev-parse', ref], { cwd: bare, encoding: 'utf8', env: CLEAN }).trim();

  it('pushes the branch and the tag, and leaves main where it was', { skip: npmSkip }, async () => {
    const dir = await repo('2026.31.9');
    const bare = await remote(dir);
    const mainWas = remoteRef(bare, 'main');

    const ran = run(dir, 'scripts/release.mjs', ['--notes', await notesFile(dir, 'a release\n')], {
      RELEASE_NOW: '2026-07-29'
    });
    assert.equal(ran.code, 0, ran.err);

    assert.equal(remoteRef(bare, 'main'), mainWas, 'main moved — a release is not a merge');
    assert.equal(remoteRef(bare, 'work'), git(dir, 'rev-parse', 'HEAD'));
    assert.equal(remoteRef(bare, 'v2026.31.10^{commit}'), git(dir, 'rev-parse', 'HEAD'));
    // And it says so, because the merge is now the reader's next step.
    assert.match(ran.out, /merge work into main/);
  });

  /**
   * A push is the one step here that can half-succeed, and the pre-push hook
   * makes it likely rather than theoretical: it runs the whole `check` against
   * a checkout several sessions are writing into, so it goes red on somebody
   * else's saved file. Unguarded, that threw a raw `execFileSync` stack — and a
   * throw on the *second* push left the version commit on `origin` with no tag
   * behind it, which the next `npm run release` then refuses as already
   * existing. The message has to carry the way out, because by then the reader
   * has a local tag, a pushed commit and no idea which.
   */
  it('says what to do by hand when a push is refused', { skip: npmSkip }, async () => {
    const dir = await repo('2026.31.9');
    git(dir, 'remote', 'add', 'origin', path.join(dir, 'no-such-remote'));

    const ran = run(dir, 'scripts/release.mjs', ['--notes', await notesFile(dir, 'a release\n')], {
      RELEASE_NOW: '2026-07-29'
    });
    assert.equal(ran.code, 1);
    assert.match(ran.err, /pushing the branch was refused/);
    assert.match(
      ran.err,
      /git push --no-verify origin [0-9a-f]{40}:work && git push --no-verify origin v2026\.31\.10/
    );
    assert.match(ran.err, /Do not re-run/);
    // Nothing was undone, which is what the message promises.
    assert.equal(git(dir, 'cat-file', '-t', 'v2026.31.10'), 'tag');
  });

  it('releases from main itself, which is the stable line', async () => {
    const dir = await repo('2026.31.9');
    git(dir, 'branch', '-m', 'main');
    const ran = run(dir, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.out.split('\n')[0], '2026.31.10');
  });

  it('releases from a linked worktree, which is now nobody’s business', async () => {
    const dir = await repo('2026.31.9');
    const wt = path.join(dir, 'wt');
    git(dir, 'worktree', 'add', '--quiet', '-b', 'side', wt);
    await fs.copyFile(path.join(REPO, 'scripts/release.mjs'), path.join(wt, 'scripts/release.mjs'));
    const ran = run(wt, 'scripts/release.mjs', ['--dry'], { RELEASE_NOW: '2026-07-29' });
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.out.split('\n')[0], '2026.31.10');
  });
});

describe('deploy: which tag it would install', () => {
  it('uses the tagged manifest version and keeps the calendar cache key', async () => {
    const dir = await repo('0.2.0');
    tagAt(dir, 'v2026.40.2');
    const plan = JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan']).out) as {
      version: string;
      vsix: string;
    };
    assert.equal(plan.version, '0.2.0');
    assert.match(plan.vsix, /squadron-2026\.40\.2\.vsix$/);
  });

  it('picks the newest release tag, version-sorted', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    commit(dir, 'fix: later');
    tagAt(dir, 'v2026.31.10');
    const ran = run(dir, 'scripts/deploy.mjs', ['--plan']);
    assert.equal(ran.code, 0, ran.err);
    assert.equal(JSON.parse(ran.out).tag, 'v2026.31.10');
  });

  it('skips the lightweight tag that `git describe` would have picked', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    commit(dir, 'chore: after the release');
    git(dir, 'tag', 'v2026.31.99');
    assert.equal(git(dir, 'describe', '--tags', '--abbrev=0'), 'v2026.31.99');
    const ran = run(dir, 'scripts/deploy.mjs', ['--plan']);
    assert.equal(JSON.parse(ran.out).tag, 'v2026.31.9');
  });

  it('reports the tagged package version and where the VSIX would come from', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    const cold = JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan']).out);
    assert.deepEqual([cold.version, cold.source], ['2026.30.4', 'build']);

    await fs.mkdir(path.join(dir, 'dist-releases'));
    await fs.writeFile(path.join(dir, 'dist-releases', 'squadron-2026.31.9.vsix'), 'zip');
    const warm = JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan']).out);
    assert.equal(warm.source, 'cache');
  });
});

describe('deploy: tested candidate bundles', { skip: npmSkip }, () => {
  async function released(prepublish = false): Promise<{ dir: string; candidate: string }> {
    const dir = await repo('2026.31.9');
    await fs.copyFile(path.join(REPO, 'scripts/timed.mjs'), path.join(dir, 'scripts/timed.mjs'));
    await fs.writeFile(
      path.join(dir, 'scripts/emit.mjs'),
      `import * as fs from 'node:fs';
      fs.mkdirSync('out',{recursive:true});fs.mkdirSync('dist',{recursive:true});
      fs.writeFileSync('out/test.js','compiled test');
      fs.writeFileSync('dist/extension.js',process.argv[2] ?? 'rebuilt');`
    );
    await fs.writeFile(path.join(dir, 'scripts/esbuild.mjs'), "import './emit.mjs';\n");
    const file = path.join(dir, 'package.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest.displayName = 'Squadron';
    manifest.scripts.check = 'node scripts/timed.mjs compile="node scripts/emit.mjs tested"';
    if (prepublish) manifest.scripts['vscode:prepublish'] = 'node -e "require(\'build-tool\')"';
    await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '--quiet', '-m', 'test: build candidate outputs');
    const ran = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'candidate bundles\n'), '--no-push'],
      { RELEASE_NOW: '2026-07-29', SQUADRON_GATE_DIR: path.join(dir, 'fixture-gate') }
    );
    assert.equal(ran.code, 0, ran.err);
    const store = path.join(dir, '.git/squadron-candidates');
    const ids = (await fs.readdir(store)).filter((id) => /^[\da-f-]{36}$/.test(id));
    assert.equal(ids.length, 1);
    return { dir, candidate: path.join(store, ids[0]!) };
  }

  async function tools(dir: string): Promise<NodeJS.ProcessEnv> {
    const bin = path.join(dir, 'tools');
    await fs.mkdir(bin);
    const prelude = `#!/usr/bin/env node
      const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
      fs.appendFileSync(process.env.DEPLOY_EVENTS,path.basename(process.argv[1])+'\\n');\n`;
    for (const [name, code] of Object.entries({
      npm: `fs.mkdirSync('node_modules/build-tool',{recursive:true});
        fs.writeFileSync('node_modules/build-tool/index.js','module.exports = {};');`,
      npx: `const manifest=JSON.parse(fs.readFileSync('package.json'));
        if(manifest.scripts?.['vscode:prepublish'])
          cp.execFileSync(process.execPath,['-e',"require('build-tool')"],{stdio:'pipe'});
        fs.mkdirSync('package/extension',{recursive:true});
        fs.cpSync('dist','package/extension/dist',{recursive:true});
        fs.copyFileSync('package.json','package/extension/package.json');
        const change=process.env.DEPLOY_PACKAGE_CHANGE;
        if(change==='replace')fs.writeFileSync('package/extension/dist/extension.js','packager changed');
        if(change==='add')fs.writeFileSync('package/extension/dist/extra.js','packager added');
        if(change==='remove')fs.rmSync('package/extension/dist/extension.js');
        cp.execFileSync('zip',['-qr',path.resolve('release.vsix'),'extension'],{cwd:'package'});`,
      ide: `const vsix=process.argv[3],dir=process.env.SQUADRON_IDE_EXTENSIONS;
        fs.mkdirSync(dir,{recursive:true});cp.execFileSync('unzip',['-qo',vsix,'-d',dir]);
        const m=JSON.parse(fs.readFileSync(path.join(dir,'extension/package.json')));
        const installed=path.join(dir,m.publisher+'.'+m.name+'-'+m.version);
        fs.rmSync(installed,{recursive:true,force:true});fs.renameSync(path.join(dir,'extension'),installed);
        if(process.env.DEPLOY_BAD_INSTALL)fs.writeFileSync(path.join(installed,'dist/extension.js'),'wrong');`
    })) {
      await fs.writeFile(path.join(bin, name), prelude + code, { mode: 0o755 });
    }
    return {
      PATH: bin + path.delimiter + (CLEAN.PATH ?? ''),
      SQUADRON_IDE_CLI: path.join(bin, 'ide'),
      SQUADRON_IDE_EXTENSIONS: path.join(dir, 'extensions'),
      DEPLOY_EVENTS: path.join(dir, 'deploy-events')
    };
  }

  it('prepares packaging dependencies when reusing a candidate with a prepublish hook', async (t) => {
    const { dir } = await released(true);
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = await tools(dir);
    const ran = run(dir, 'scripts/deploy.mjs', [], env);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /reused tested bundles/);
    assert.equal(
      await fs.readFile(
        path.join(dir, 'extensions/acme.squadron-2026.31.10/dist/extension.js'),
        'utf8'
      ),
      'tested'
    );
  });

  it('packages tested bytes, preserves staging promotion and admits only verified installs to cache', async (t) => {
    const { dir } = await released();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = await tools(dir);
    const plan = run(dir, 'scripts/deploy.mjs', ['--plan'], env);
    assert.equal(plan.code, 0, plan.err);
    assert.equal(JSON.parse(plan.out).source, 'candidate');
    await fs.mkdir(path.join(dir, 'dist'));
    await fs.writeFile(path.join(dir, 'dist/extension.js'), 'dirty checkout');
    const cached = path.join(dir, 'dist-releases/squadron-2026.31.10.vsix');
    for (const change of ['replace', 'add', 'remove']) {
      await fs.writeFile(env.DEPLOY_EVENTS!, '');
      const altered = run(dir, 'scripts/deploy.mjs', [], { ...env, DEPLOY_PACKAGE_CHANGE: change });
      assert.equal(altered.code, 1, change);
      assert.match(altered.err, /packaged bundles do not match the tested candidate/);
      assert.equal(await fs.readFile(env.DEPLOY_EVENTS!, 'utf8'), 'npx\n');
      await assert.rejects(fs.stat(cached), { code: 'ENOENT' });
    }
    await fs.writeFile(env.DEPLOY_EVENTS!, '');
    const rejected = run(dir, 'scripts/deploy.mjs', [], { ...env, DEPLOY_BAD_INSTALL: '1' });
    assert.equal(rejected.code, 1);
    assert.match(rejected.err, /installed bytes are not this build/);
    await assert.rejects(fs.stat(cached), { code: 'ENOENT' });
    const installed = path.join(dir, 'extensions/acme.squadron-2026.31.10');
    const ran = run(dir, 'scripts/deploy.mjs', [], env);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /reused tested bundles/);
    const runs = path.join(dir, '.git/squadron-runs');
    const deployed = (await fs.readdir(runs)).filter((name) => name.includes('-deploy-'));
    assert.ok(deployed.length > 0);
    const report = JSON.parse(
      await fs.readFile(path.join(runs, deployed.at(-1)!, 'deploy-runtime.json'), 'utf8')
    );
    assert.equal(report.source, 'candidate');
    assert.equal(report.outcome, 'passed');
    const events = (await fs.readFile(String(report.observationFile), 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as Record<string, any>);
    for (const name of [
      'deploy:archive',
      'deploy:preparation',
      'deploy:package',
      'deploy:install',
      'deploy:installed-hash'
    ])
      assert.ok(
        events.some((row) => row.type === 'span' && row.name === name && row.outcome === 'passed'),
        name
      );

    assert.match(ran.out, /bundles \(candidate\) \d+ms/);
    assert.match(ran.out, /packaging \d+ms/);
    assert.equal(await fs.readFile(path.join(installed, 'dist/extension.js'), 'utf8'), 'tested');
    assert.equal(
      JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8')).displayName,
      'Squadron (STG)'
    );
    assert.equal(
      execFileSync('unzip', ['-p', cached, 'extension/dist/extension.js'], { encoding: 'utf8' }),
      'tested'
    );
    assert.equal(
      JSON.parse(
        execFileSync('unzip', ['-p', cached, 'extension/package.json'], { encoding: 'utf8' })
      ).displayName,
      'Squadron'
    );
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const promoted = run(dir, 'scripts/deploy.mjs', [], env);
    assert.equal(promoted.code, 0, promoted.err);
    assert.match(promoted.out, /installing from dist-releases/);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8')).displayName,
      'Squadron'
    );
    assert.equal(JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan'], env).out).source, 'cache');
    assert.equal(await fs.readFile(env.DEPLOY_EVENTS!, 'utf8'), 'npx\nide\nnpx\nide\nide\n');
  });

  it('rejects invalid candidates and rebuilds the tag without admitting their bytes', async (t) => {
    const { dir, candidate } = await released();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = await tools(dir);
    const manifestFile = path.join(candidate, 'candidate.json');
    const original = await fs.readFile(manifestFile, 'utf8');
    const variants = [
      { tree: '0'.repeat(40) },
      { releaseCommit: '0'.repeat(40) },
      { tagObject: '0'.repeat(40) },
      { origin: dir },
      { expired: true },
      { created: Date.now() - 8 * 86400_000 },
      { buildHost: null },
      { buildHost: { node: 'v0', platform: testPlatform(), arch: process.arch } },
      { buildHost: { node: process.version, platform: 'other', arch: process.arch } },
      { buildHost: { node: process.version, platform: testPlatform(), arch: 'other' } },
      { generation: 999 }
    ];
    for (const variant of variants) {
      await fs.writeFile(manifestFile, JSON.stringify({ ...JSON.parse(original), ...variant }));
      const result = run(dir, 'scripts/deploy.mjs', ['--plan'], env);
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).source, 'build', JSON.stringify(variant));
    }
    await fs.writeFile(manifestFile, original);
    const receipts = path.join(candidate, 'receipts');
    for (const file of await fs.readdir(receipts)) {
      const full = path.join(receipts, file);
      const bytes = await fs.readFile(full);
      const receipt = JSON.parse(bytes.toString()) as { key: string };
      if (!receipt.key.startsWith('gate:')) continue;
      await fs.rm(full);
      assert.equal(JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan'], env).out).source, 'build');
      await fs.writeFile(full, bytes);
    }
    const owner = path.join(candidate, 'owner.json');
    await fs.writeFile(owner, JSON.stringify({ pid: process.pid }));
    assert.equal(JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan'], env).out).source, 'build');
    const contended = run(dir, 'scripts/deploy.mjs', [], env);
    assert.equal(contended.code, 0, contended.err);
    assert.match(contended.out, /building .* from a clean archive/);
    assert.deepEqual(JSON.parse(await fs.readFile(owner, 'utf8')), { pid: process.pid });
    await fs.rm(path.join(dir, 'dist-releases'), { recursive: true });
    await fs.writeFile(env.DEPLOY_EVENTS!, '');
    await fs.rm(owner);
    const bundle = path.join(candidate, 'source/dist/extension.js');
    const bytes = await fs.readFile(bundle);
    await fs.rm(bundle);
    assert.equal(JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan'], env).out).source, 'build');
    await fs.writeFile(bundle, bytes);
    assert.equal(
      JSON.parse(run(dir, 'scripts/deploy.mjs', ['--plan'], env).out).source,
      'candidate'
    );
    await fs.writeFile(bundle, 'tampered');
    const fallback = run(dir, 'scripts/deploy.mjs', [], env);
    assert.equal(fallback.code, 0, fallback.err);
    assert.match(fallback.out, /building .* from a clean archive/);
    assert.match(fallback.out, /bundles \(build\) \d+ms/);
    assert.equal(await fs.readFile(env.DEPLOY_EVENTS!, 'utf8'), 'npm\nnpx\nide\n');
    assert.equal(
      await fs.readFile(
        path.join(dir, 'extensions/acme.squadron-2026.31.10/dist/extension.js'),
        'utf8'
      ),
      'rebuilt'
    );
  });

  it('holds ownership through copying and rejects source or destination changes during the copy', async (t) => {
    const { dir, candidate } = await released();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = await tools(dir);
    const preload = path.join(dir, 'copy-control.cjs');
    const bundle = await fs.realpath(path.join(candidate, 'source/dist/extension.js'));
    const probe = `import * as fs from 'node:fs';
      import * as store from ${JSON.stringify(path.join(dir, 'scripts/checkpoints.mjs'))};
      const c=new store.Candidate(${JSON.stringify(candidate)});
      try { c.take();process.exit(2); } catch(error) {
        if(!/still running/.test(error.message))throw error;
      }
      store.pruneCandidates(${JSON.stringify(path.dirname(candidate))},c.runs,Date.now()+8*86400000);
      if(!fs.existsSync(c.workspace))throw Error('pruned during deploy copy');`;
    await fs.writeFile(
      preload,
      `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
      const original=fs.cpSync;
      fs.cpSync=function(source,destination,...options){
        if(source!==${JSON.stringify(path.dirname(bundle))})return original.call(this,source,destination,...options);
        const checked=cp.spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(probe)}],{
          env:{...process.env,NODE_OPTIONS:''},encoding:'utf8'});
        if(checked.status!==0)throw Error('copy has no protected owner: '+checked.stderr);
        fs.appendFileSync(process.env.DEPLOY_EVENTS,'copy-owned\\n');
        const result=original.call(this,source,destination,...options);
        if(process.env.DEPLOY_COPY_CHANGE!=='none')fs.writeFileSync(path.join(
          process.env.DEPLOY_COPY_CHANGE==='source'?source:destination,'extension.js'),'changed while copying');
        return result;
      };`
    );
    for (const change of ['none', 'source', 'destination']) {
      await fs.writeFile(bundle, 'tested');
      await fs.rm(path.join(dir, 'dist-releases'), { recursive: true, force: true });
      await fs.writeFile(env.DEPLOY_EVENTS!, '');
      const ran = run(dir, 'scripts/deploy.mjs', [], {
        ...env,
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
        DEPLOY_COPY_CHANGE: change
      });
      assert.equal(ran.code, 0, ran.err);
      assert.match(await fs.readFile(env.DEPLOY_EVENTS!, 'utf8'), /^copy-owned\n/);
      if (change === 'none') assert.match(ran.out, /reused tested bundles/);
      else assert.match(ran.out, /building .* from a clean archive/);
      assert.equal(
        await fs.readFile(
          path.join(dir, 'extensions/acme.squadron-2026.31.10/dist/extension.js'),
          'utf8'
        ),
        change === 'none' ? 'tested' : 'rebuilt'
      );
    }
  });
});

describe('deploy: tagged releases only', () => {
  for (const flag of ['--local', '--skip-smoke']) {
    it(`refuses ${flag}`, async () => {
      const dir = await repo();
      const ran = run(dir, 'scripts/deploy.mjs', [flag, '--plan']);
      assert.equal(ran.code, 1);
      assert.match(ran.err, /only installs tagged releases/);
    });
  }

  it('refuses a repository with no release tag', async () => {
    const dir = await repo();
    const ran = run(dir, 'scripts/deploy.mjs', ['--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no release tag/);
  });
});

/**
 * Which IDE(s) would get the bytes.
 *
 * Default is every known host whose CLI is on disk — not the first one only.
 * Picking a single host is how a machine with both VS Code and Antigravity
 * ended up current in one and stale in the other; the verify hashed the host it
 * wrote and said success while the user looked at the other. `--plan` reports
 * the list so it can be asserted without installing anything. Overrides still
 * pin a single host.
 */
describe('deploy: which hosts it would install into', () => {
  type HostPlan = { cli: string; extensions: string[] };

  const plan = async (env: NodeJS.ProcessEnv): Promise<HostPlan[]> => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    const ran = run(dir, 'scripts/deploy.mjs', ['--plan'], env);
    assert.equal(ran.code, 0, ran.err);
    return (JSON.parse(ran.out) as { hosts: HostPlan[] }).hosts;
  };

  it('takes the host-neutral variable over the legacy one', async () => {
    const hosts = await plan({
      SQUADRON_IDE_CLI: '/somewhere/code',
      ANTIGRAVITY_CLI: '/elsewhere/antigravity-ide'
    });
    assert.deepEqual(
      hosts.map((h) => h.cli),
      ['/somewhere/code']
    );
  });

  it('still answers to the legacy variable alone', async () => {
    const hosts = await plan({ ANTIGRAVITY_CLI: '/elsewhere/antigravity-ide' });
    assert.deepEqual(
      hosts.map((h) => h.cli),
      ['/elsewhere/antigravity-ide']
    );
  });

  it('pairs a known CLI with the directory that CLI installs to', async () => {
    const code = await plan({
      SQUADRON_IDE_CLI: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
    });
    assert.equal(code.length, 1);
    assert.deepEqual(code[0]?.extensions, [path.join(os.homedir(), '.vscode', 'extensions')]);

    // The other host's directories, and not a union of both: verifying against a
    // directory this CLI never writes is how a wrong-host install passes.
    const fork = await plan({
      SQUADRON_IDE_CLI:
        '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide'
    });
    assert.equal(fork.length, 1);
    assert.deepEqual(fork[0]?.extensions, [
      path.join(os.homedir(), '.antigravity-ide', 'extensions'),
      path.join(os.homedir(), '.antigravity', 'extensions')
    ]);
  });

  it('leaves an unrecognised CLI with no directory rather than guessing one', async () => {
    const hosts = await plan({ SQUADRON_IDE_CLI: '/opt/some-fork/bin/fork' });
    assert.equal(hosts.length, 1);
    assert.deepEqual(hosts[0]?.extensions, []);
  });

  it('lets the directory be overridden with a pinned CLI', async () => {
    const hosts = await plan({
      SQUADRON_IDE_CLI: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      SQUADRON_IDE_EXTENSIONS: '/tmp/profile/extensions'
    });
    assert.equal(hosts.length, 1);
    assert.deepEqual(hosts[0]?.extensions, ['/tmp/profile/extensions']);
  });

  it('plans every present known host when no CLI is forced', async () => {
    const hosts = await plan({});
    // This machine's probe list — only assert structure and known CLIs, not
    // which subset is installed (CI and laptops disagree). Empty is valid:
    // Linux CI has none of the macOS Application paths.
    for (const host of hosts) {
      assert.ok(
        [
          '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
          '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
          '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide'
        ].includes(host.cli),
        `unexpected host ${host.cli}`
      );
      assert.ok(host.extensions.length > 0, `no extensions for ${host.cli}`);
    }
    // Multi-host claim: when two or more are present, every one is planned
    // (not only the first). Length 0 (CI) or 1 (single IDE) is fine here.
    if (hosts.length >= 2) {
      const clis = new Set(hosts.map((h) => h.cli));
      assert.equal(clis.size, hosts.length, 'duplicate host in plan');
    }
  });
});

describe('deploy: what it refuses', () => {
  it('refuses a tag without a matching gate result, even when its VSIX is cached', async () => {
    const dir = await repo();
    git(dir, 'tag', '-a', 'v2026.31.9', '-m', 'old release');
    const cache = path.join(dir, 'dist-releases');
    await fs.mkdir(cache);
    await fs.writeFile(path.join(cache, 'squadron-2026.31.9.vsix'), 'zip');
    const ran = run(dir, 'scripts/deploy.mjs', ['v2026.31.9', '--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no matching check and smoke result/);
  });

  it('refuses a gate result for another tree', async () => {
    const dir = await repo();
    git(dir, 'tag', '-a', 'v2026.31.9', '-m', `notes\n\nGate: check+smoke ${'0'.repeat(40)}`);
    const ran = run(dir, 'scripts/deploy.mjs', ['v2026.31.9', '--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no matching check and smoke result/);
  });

  it('refuses a lightweight tag asked for by name', async () => {
    const dir = await repo();
    git(dir, 'tag', 'v2026.31.9');
    const ran = run(dir, 'scripts/deploy.mjs', ['v2026.31.9', '--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /carries no notes/);
  });

  it('refuses a branch, commit hash, and non-release annotated tag', async () => {
    const dir = await repo();
    tagAt(dir, 'nightly');
    for (const ref of ['work', git(dir, 'rev-parse', 'HEAD'), 'nightly']) {
      const ran = run(dir, 'scripts/deploy.mjs', [ref, '--plan']);
      assert.equal(ran.code, 1, `${ref} was accepted`);
    }
  });

  /**
   * The counterpart of `publish: refuses a tag that is not stable yet`, and the
   * division the whole process now rests on. A tag on an unmerged branch is a
   * staging build: installing it is the normal reason it exists, and deploy
   * refused it outright until 2026-08-07. Which branch it sits on decides
   * exactly one thing — whether `scripts/publish.mjs` will take it.
   */
  it('installs a tag on a branch that was never merged', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    git(dir, 'checkout', '--quiet', '-b', 'staging');
    commit(dir, 'feat: not on work');
    tagAt(dir, 'v2026.31.10');
    const ran = run(dir, 'scripts/deploy.mjs', ['v2026.31.10', '--plan']);
    assert.equal(ran.code, 0, ran.err);
    assert.equal(JSON.parse(ran.out).tag, 'v2026.31.10');
  });

  it('refuses when there is no release tag at all', async () => {
    const dir = await repo();
    const ran = run(dir, 'scripts/deploy.mjs', ['--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /npm run release/);
  });
});

describe('deploy: the cache', () => {
  it('keeps the newest five, counting numerically rather than by string', async () => {
    const dir = await repo();
    const cache = path.join(dir, 'dist-releases');
    await fs.mkdir(cache);
    // 8 and 9 sort above 10 and 11 as strings — a string sort would keep the
    // two oldest and delete the newest. 32.2 and 30.3 are what a comparator
    // reading only the last part gets backwards.
    for (const version of ['2026.31.8', '2026.31.9', '2026.31.10', '2026.31.11', '2026.32.2']) {
      await fs.writeFile(path.join(cache, `squadron-${version}.vsix`), 'zip');
    }
    await fs.writeFile(path.join(cache, 'squadron-2026.30.3.vsix'), 'zip');
    await fs.writeFile(path.join(cache, 'notes.txt'), 'not a build');

    const ran = run(dir, 'scripts/deploy.mjs', ['--sweep']);
    assert.equal(ran.code, 0, ran.err);
    const left = (await fs.readdir(cache)).sort();
    assert.deepEqual(left, [
      'notes.txt',
      'squadron-2026.31.10.vsix',
      'squadron-2026.31.11.vsix',
      'squadron-2026.31.8.vsix',
      'squadron-2026.31.9.vsix',
      'squadron-2026.32.2.vsix'
    ]);
  });
});

async function resumableFixture(): Promise<{ dir: string; marker: string; calls: string }> {
  const dir = await repo('2026.31.9');
  const marker = path.join(os.tmpdir(), 'sq-fail-' + Date.now() + '-' + Math.random());
  const calls = path.join(dir, '.git', 'gate-calls.jsonl');
  await fs.writeFile(marker, 'fail');
  const file = path.join(dir, 'package.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as {
    scripts: Record<string, string>;
  };
  manifest.scripts['check'] = `node gate.cjs check`;
  manifest.scripts['test:smoke'] = `node gate.cjs smoke`;
  manifest.scripts['test:smoke:one'] = `node gate.cjs remote`;
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(
    path.join(dir, 'gate.cjs'),
    `const fs=require('node:fs');const stage=process.argv[2];fs.appendFileSync(process.env.CALLS,stage+'\\n');if(stage==='smoke' && fs.existsSync(process.env.FAIL_MARKER))process.exitCode=1;`
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'test: resumable gates');
  return { dir, marker, calls };
}
describe('release: explicit candidate resume', { skip: npmSkip }, () => {
  it('reuses a passed check after smoke failure and retains every attempt', async () => {
    const { dir, marker, calls } = await resumableFixture();
    const env = { RELEASE_NOW: '2026-07-29', CALLS: calls, FAIL_MARKER: marker };
    const first = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'candidate\n'), '--no-push'],
      env
    );
    assert.equal(first.code, 1);
    assert.match(first.err, /smoke failed/);
    const id = /candidate ([\da-f-]{36})/.exec(first.out)?.[1];
    assert.ok(id);
    const priorHistory = await fs.readFile(
      path.join(dir, '.git', 'squadron-candidates', id, 'history.jsonl'),
      'utf8'
    );
    for (const flags of [
      ['--inspect', id],
      ['--dry', '--resume', id]
    ]) {
      const inspected = run(dir, 'scripts/release.mjs', flags, env);
      assert.equal(inspected.code, 0, inspected.err);
    }
    assert.equal(
      await fs.readFile(path.join(dir, '.git', 'squadron-candidates', id, 'history.jsonl'), 'utf8'),
      priorHistory
    );
    await fs.rm(marker);
    const next = run(dir, 'scripts/release.mjs', ['--resume', id], env);
    assert.equal(next.code, 0, next.err);
    assert.equal(await fs.readFile(calls, 'utf8'), 'check\nsmoke\nsmoke\nremote\n');
    const history = await fs.readFile(
      path.join(dir, '.git', 'squadron-candidates', id, 'history.jsonl'),
      'utf8'
    );
    assert.match(history, /"outcome":"failed"/);
    assert.match(history, /"outcome":"reused"/);
    assert.equal(
      git(dir, 'show', ':package.json'),
      (await fs.readFile(path.join(dir, 'package.json'), 'utf8')).trim()
    );
    assert.equal(git(dir, 'diff', '--name-only'), '');
  });
  it('finalizes the original tree after HEAD advances, preserving newer and staged work', async () => {
    const { dir, marker, calls } = await resumableFixture();
    const env = { RELEASE_NOW: '2026-07-29', CALLS: calls, FAIL_MARKER: marker };
    const first = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'candidate\n'), '--no-push'],
      env
    );
    const id = /candidate ([\da-f-]{36})/.exec(first.out)?.[1];
    assert.ok(id);
    commit(dir, 'docs: concurrent work');
    const newer = git(dir, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(dir, 'staged'), 'preserve');
    git(dir, 'add', 'staged');
    await fs.rm(marker);
    const next = run(dir, 'scripts/release.mjs', ['--resume', id, '--no-push'], env);
    assert.equal(next.code, 0, next.err);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), newer);
    assert.match(git(dir, 'diff', '--cached', '--name-only'), /staged/);
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, '.git', 'squadron-candidates', id, 'candidate.json'), 'utf8')
    ) as { tree: string };
    assert.equal(git(dir, 'rev-parse', 'v2026.31.10^{tree}'), manifest.tree);
    assert.equal(await fs.readFile(calls, 'utf8'), 'check\nsmoke\nsmoke\nremote\n');
  });
  it('refuses changed execution configuration before reusing a gate', async () => {
    const { dir, marker, calls } = await resumableFixture();
    const env = {
      RELEASE_NOW: '2026-07-29',
      CALLS: calls,
      FAIL_MARKER: marker,
      CHECKPOINT_TEST_MODE: 'original'
    };
    const first = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'candidate\n'), '--no-push'],
      env
    );
    const id = /candidate ([\da-f-]{36})/.exec(first.out)?.[1];
    assert.ok(id);
    const next = run(dir, 'scripts/release.mjs', ['--resume', id], {
      ...env,
      CHECKPOINT_TEST_MODE: 'changed'
    });
    assert.equal(next.code, 1);
    assert.match(next.err, /environment\/toolchain mismatch/);
    assert.equal(await fs.readFile(calls, 'utf8'), 'check\nsmoke\n');
    assert.equal(git(dir, 'tag', '-l'), '');
    await fs.rm(marker);
  });
  it('refuses rebinding passing receipts to a different Git tree', async () => {
    const { dir, marker, calls } = await resumableFixture();
    const env = { RELEASE_NOW: '2026-07-29', CALLS: calls, FAIL_MARKER: marker };
    const first = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'candidate\n'), '--no-push'],
      env
    );
    const id = /candidate ([\da-f-]{36})/.exec(first.out)?.[1];
    assert.ok(id);
    const file = path.join(dir, '.git', 'squadron-candidates', id, 'candidate.json');
    const metadata = JSON.parse(await fs.readFile(file, 'utf8')) as {
      parent: string;
      tree: string;
    };
    metadata.tree = git(dir, 'rev-parse', metadata.parent + '^{tree}');
    await fs.writeFile(file, JSON.stringify(metadata));
    await fs.rm(marker);
    const next = run(dir, 'scripts/release.mjs', ['--resume', id, '--no-push'], env);
    assert.equal(next.code, 1);
    assert.match(next.err, /identity changed/);
    assert.equal(git(dir, 'tag', '-l'), '');
    assert.equal(await fs.readFile(calls, 'utf8'), 'check\nsmoke\n');
  });
  it('rejects changed candidate source before reusing a gate', async () => {
    const { dir, marker, calls } = await resumableFixture();
    const env = { RELEASE_NOW: '2026-07-29', CALLS: calls, FAIL_MARKER: marker };
    const first = run(
      dir,
      'scripts/release.mjs',
      ['--notes', await notesFile(dir, 'candidate\n'), '--no-push'],
      env
    );
    const id = /candidate ([\da-f-]{36})/.exec(first.out)?.[1];
    assert.ok(id);
    await fs.appendFile(
      path.join(dir, '.git', 'squadron-candidates', id, 'source', 'f'),
      'tampered'
    );
    const next = run(dir, 'scripts/release.mjs', ['--resume', id, '--no-push'], env);
    assert.equal(next.code, 1);
    assert.match(next.err, /source changed/);
    assert.equal(git(dir, 'tag', '-l'), '');
    await fs.rm(marker);
  });
});

describe('release: crash-safe checkout integration', { skip: npmSkip }, () => {
  it('recovers the index after the ref transaction commits and its parent dies', async () => {
    const dir = await repo('2026.31.9');
    const marker = path.join(dir, '.git', 'crash-once');
    await fs.writeFile(marker, 'yes');
    const hook = path.join(dir, '.git', 'hooks', 'reference-transaction');
    await fs.writeFile(
      hook,
      `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');
if(process.argv[2]==='committed'&&fs.existsSync(${JSON.stringify(marker)})){
 fs.rmSync(${JSON.stringify(marker)});
 const parent=Number(cp.execFileSync('ps',['-o','ppid=','-p',String(process.ppid)],{encoding:'utf8'}).trim());
 process.kill(parent,'SIGKILL');
}
`,
      { mode: 0o755 }
    );
    const args = [
      '--notes',
      await notesFile(dir, 'recover interrupted finalization\n'),
      '--no-push'
    ];
    const env = { RELEASE_NOW: '2026-07-29' };
    const first = run(dir, 'scripts/release.mjs', args, env);
    assert.notEqual(first.code, 0);
    const id = /candidate ([\da-f-]{36})/.exec(first.out)?.[1];
    assert.ok(id);
    const metadata = path.join(dir, '.git', 'squadron-candidates', id, 'candidate.json');
    const saved = JSON.parse(await fs.readFile(metadata, 'utf8')) as {
      integration: { transaction: { pid: number } };
    };
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(saved.integration.transaction.pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const next = run(dir, 'scripts/release.mjs', ['--resume', id, '--no-push'], env);
    assert.equal(next.code, 0, next.err);
    assert.match(next.out, /reused check/);
    assert.equal(git(dir, 'diff', '--name-only'), '');
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'v2026.31.10^{commit}'));
    assert.equal(
      await fs.stat(path.join(dir, '.git', 'index.lock')).catch(() => undefined),
      undefined
    );
  });

  for (const conflict of ['staged package', 'unstaged package', 'branch switch'] as const) {
    it(`preserves ${conflict} while finalizing the tested candidate`, async () => {
      const { dir, marker, calls } = await resumableFixture();
      const env = { RELEASE_NOW: '2026-07-29', CALLS: calls, FAIL_MARKER: marker };
      const failure = run(
        dir,
        'scripts/release.mjs',
        ['--notes', await notesFile(dir, 'candidate\n'), '--no-push'],
        env
      );
      const id = /candidate ([\da-f-]{36})/.exec(failure.out)?.[1];
      assert.ok(id);
      if (conflict === 'branch switch') git(dir, 'checkout', '--quiet', '-b', 'other');
      else {
        await fs.appendFile(path.join(dir, 'package.json'), '\n');
        if (conflict === 'staged package') git(dir, 'add', 'package.json');
      }
      const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
      const staged = git(dir, 'diff', '--cached');
      const head = git(dir, 'rev-parse', 'HEAD');
      await fs.rm(marker);
      const next = run(dir, 'scripts/release.mjs', ['--resume', id, '--no-push'], env);
      assert.equal(next.code, 0, next.err);
      assert.match(next.out, /checkout preserved/);
      assert.equal(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), before);
      assert.equal(git(dir, 'diff', '--cached'), staged);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.equal(git(dir, 'cat-file', '-t', 'v2026.31.10'), 'tag');
    });
  }
});

describe('release: competing finalizers', { skip: npmSkip }, () => {
  it(
    'lets one candidate finalize a shared tag without overwriting the checkout',
    { timeout: 60000 },
    async () => {
      const dir = await repo('2026.31.9');
      const wait = path.join(dir, '.git', 'wait');
      await fs.mkdir(wait);
      const file = path.join(dir, 'package.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as {
        scripts: Record<string, string>;
      };
      manifest.scripts['check'] = 'node gate.cjs';
      await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
      await fs.writeFile(
        path.join(dir, 'gate.cjs'),
        `const fs=require('node:fs');const path=require('node:path');const root=process.env.WAIT_DIR;fs.writeFileSync(path.join(root,'ready-'+process.pid),'');const end=Date.now()+20000;const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'go')))clearInterval(timer);else if(Date.now()>end){clearInterval(timer);process.exitCode=1;}},20);`
      );
      git(dir, 'add', '.');
      git(dir, 'commit', '--quiet', '-m', 'test: concurrent finalizers');
      const originalHead = git(dir, 'rev-parse', 'HEAD');
      const children = [];
      try {
        for (const name of ['one', 'two']) {
          const notes = path.join(dir, name + '.notes');
          await fs.writeFile(notes, name + '\n');
          const child = spawn(
            process.execPath,
            [path.join(dir, 'scripts/release.mjs'), '--notes', notes, '--no-push'],
            { cwd: dir, env: { ...CLEAN, RELEASE_NOW: '2026-07-29', WAIT_DIR: wait } }
          );
          let output = '';
          child.stdout.setEncoding('utf8').on('data', (s: string) => {
            output += s;
          });
          child.stderr.setEncoding('utf8').on('data', (s: string) => {
            output += s;
          });
          const done = new Promise<number | null>((resolve) => child.once('close', resolve));
          children.push({ child, done, output: () => output });
        }
        const end = Date.now() + 20000;
        while ((await fs.readdir(wait)).filter((n) => n.startsWith('ready-')).length < 2) {
          assert.ok(Date.now() < end, children.map((c) => c.output()).join('\n'));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await fs.writeFile(path.join(wait, 'go'), '');
        const codes = await Promise.all(children.map((c) => c.done));
        assert.deepEqual(codes.sort(), [0, 1], children.map((c) => c.output()).join('\n'));
        const finalHead = git(dir, 'rev-parse', 'HEAD');
        assert.ok(
          [originalHead, git(dir, 'rev-parse', 'v2026.31.10^{commit}')].includes(finalHead)
        );
        if (finalHead === originalHead)
          assert.ok(children.some((c) => c.output().includes('checkout preserved')));
        assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
        assert.equal(git(dir, 'diff', '--name-only'), '');
        assert.equal(
          git(dir, 'log', '--format=%s')
            .split('\n')
            .filter((s) => s === 'chore: version 2026.31.10').length,
          finalHead === originalHead ? 0 : 1
        );
      } finally {
        await fs.writeFile(path.join(wait, 'go'), '');
        for (const c of children) if (c.child.exitCode === null) c.child.kill('SIGTERM');
        await Promise.all(children.map((c) => c.done));
      }
    }
  );
});
