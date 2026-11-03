import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { commandEnv } from '../fixtures/preload';
import { repoRoot, testPlatform } from '../helpers';
import * as fixture from './private_files_fixture';

/**
 * `scripts/publish.mjs`, driven as the process it is — same shape as `release.test.ts`,
 * and for the same reason: the script imports nothing from `out/`, so the
 * contract under test is exit codes, stdout, and what it refuses.
 *
 * Nothing here reaches a gallery. Upload cases replace `npx` with a local stub;
 * other cases stop at `--plan` or a preflight refusal. Tokens are obvious junk
 * where a case needs them present, since being set is all the script reads
 * before it hands them over.
 */

const REPO = repoRoot();

/** The environment minus git's own variables, and minus any real tokens. */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'VSCE_PAT' && key !== 'OVSX_PAT'
  )
);

const TOKENS = { VSCE_PAT: 'not-a-token', OVSX_PAT: 'not-a-token' };

/** On a case that needs a cached VSIX, which `cached()` zips. */
const vsixSkip: false | string =
  testPlatform() === 'win32' &&
  'win32: publish reads the VSIX with unzip and uploads via npx — W8.3';

/** A repository with the script, a manifest, and one commit to tag. */
async function repo(version = '2026.31.9'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-publish-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: CLEAN });
  git('init', '--quiet', '--initial-branch=work', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  for (const script of [
    'publish.mjs',
    'zip.mjs',
    'packaged-bundles.mjs',
    'windows-helper-artifacts.mjs'
  ])
    await fs.copyFile(path.join(REPO, 'scripts', script), path.join(dir, 'scripts', script));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    `{\n  "name": "squadron",\n  "publisher": "acme",\n  "version": "${version}"\n}\n`
  );
  await fs.writeFile(
    path.join(dir, 'CHANGELOG.md'),
    `# Changelog\n\n## ${version}\n\n- Something worth releasing.\n`
  );
  await fs.writeFile(path.join(dir, 'f'), 'one\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'feat: something worth releasing');
  return dir;
}

type Ran = { code: number; out: string; err: string };

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Ran {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, 'scripts/publish.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...CLEAN, PUBLISH_REF: 'work', ...env },
      stdio: 'pipe'
    });
    return { code: 0, out, err: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: failure.stdout ?? '', err: failure.stderr ?? '' };
  }
}

/** What `--plan` prints, which is the only stdout this script has. */
type Plan = {
  tag: string;
  version: string;
  vsix: string;
  id: string;
  ref: string;
  galleries: { id: string; label: string; token: string; ready: boolean }[];
};

const planned = (ran: Ran): Plan => JSON.parse(ran.out) as Plan;

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: CLEAN }).trim();

const tagAt = (dir: string, tag: string) =>
  git(
    dir,
    'tag',
    '-a',
    tag,
    '-m',
    `notes for ${tag}\n\nGate: check+smoke ${git(dir, 'rev-parse', 'HEAD^{tree}')}`
  );

/**
 * A VSIX in `dist-releases/`, which is what a tagged deploy leaves behind.
 *
 * A real zip with a real `extension/package.json`, because the script reads the
 * manifest out of it rather than trusting the file name — the whole point of
 * that check is that the two can disagree.
 *
 */
async function cached(
  dir: string,
  version: string,
  manifest: Record<string, unknown> = {},
  release = version
): Promise<string> {
  const staged = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-vsix-'));
  await fs.mkdir(path.join(staged, 'extension'));
  await fs.writeFile(
    path.join(staged, 'extension', 'package.json'),
    JSON.stringify({ name: 'squadron', publisher: 'acme', version, ...manifest })
  );
  await fs.copyFile(path.join(dir, 'CHANGELOG.md'), path.join(staged, 'extension', 'changelog.md'));
  const cache = path.join(dir, 'dist-releases');
  await fs.mkdir(cache, { recursive: true });
  const vsix = path.join(cache, `squadron-${release}.vsix`);
  execFileSync('zip', ['-q', '-r', vsix, 'extension'], { cwd: staged, env: CLEAN });
  await fs.rm(staged, { recursive: true, force: true });
  return vsix;
}

describe('publish: what it refuses before any gallery', () => {
  it('verifies unsigned 4.8.1 helper payloads regardless of manifest file lists', async (t) => {
    const dir = await repo();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    git(dir, 'config', 'core.autocrlf', 'false');
    tagAt(dir, 'v2026.31.9');
    const extension = path.join(dir, 'extension');
    await fs.mkdir(extension);
    await fs.copyFile(path.join(dir, 'CHANGELOG.md'), path.join(extension, 'CHANGELOG.md'));
    await fs.mkdir(path.join(dir, 'dist-releases'));
    const vsix = path.join(dir, 'dist-releases/squadron-2026.31.9.vsix');
    const archive = (): void => {
      git(dir, 'add', 'extension');
      git(dir, 'archive', '--format=zip', '--output', vsix, git(dir, 'write-tree'), 'extension');
    };
    for (const helper of ['private-files', 'console-login'] as const) {
      fixture.source(REPO, extension, helper);
      fixture.artifact(extension, undefined, helper);
      const manifest = path.join(extension, 'dist/helpers', helper + '-v1.json');
      const original = await fs.readFile(manifest, 'utf8');
      for (const files of [undefined, ['dist/**'], ['dist/helpers/' + helper + '-v1.exe']]) {
        await fs.writeFile(
          path.join(extension, 'package.json'),
          JSON.stringify({ name: 'squadron', publisher: 'acme', version: '2026.31.9', files })
        );
        archive();
        const valid = run(dir, ['v2026.31.9', '--plan']);
        assert.equal(valid.code, 0, valid.err);
        await fs.writeFile(manifest, JSON.stringify({ ...JSON.parse(original), framework: '4.8' }));
        archive();
        const outdated = run(dir, ['v2026.31.9', '--plan']);
        assert.equal(outdated.code, 1, outdated.out);
        assert.match(outdated.err, /source, toolchain or protocol mismatch/);
        await fs.writeFile(manifest, original);
        await assert.rejects(fs.stat(path.join(dir, '.git/squadron-publish.jsonl')), {
          code: 'ENOENT'
        });
      }
    }
  });

  it(
    'checks the tagged changelog even when the checkout and VSIX have newer notes',
    { skip: vsixSkip },
    async () => {
      const dir = await repo('0.3.6');
      await fs.writeFile(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## 0.3.5\n\n- Older notes.\n'
      );
      git(dir, 'commit', '--quiet', '-am', 'chore: omit release notes');
      tagAt(dir, 'v2026.40.14');
      await fs.writeFile(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## 0.3.6\n\n- Late notes.\n'
      );
      git(dir, 'commit', '--quiet', '-am', 'docs: add notes after tagging');
      await cached(dir, '0.3.6', {}, '2026.40.14');
      const ran = run(dir, ['v2026.40.14'], TOKENS);
      assert.equal(ran.code, 1);
      assert.match(ran.err, /v2026\.40\.14 has no nonempty `## 0\.3\.6` entry/);
      assert.ok(!ran.out.includes('->'));
      await assert.rejects(fs.stat(path.join(dir, '.git/squadron-publish.jsonl')), {
        code: 'ENOENT'
      });
    }
  );

  it('refuses a VSIX without the tagged changelog', { skip: vsixSkip }, async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    const vsix = await cached(dir, '2026.31.9');
    execFileSync('zip', ['-q', '-d', vsix, 'extension/changelog.md'], { env: CLEAN });
    const ran = run(dir, ['v2026.31.9', '--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no readable extension\/CHANGELOG\.md/);
  });

  it('refuses a VSIX whose changelog differs from the tested tag', { skip: vsixSkip }, async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await fs.appendFile(path.join(dir, 'CHANGELOG.md'), '- Different packaged notes.\n');
    await cached(dir, '2026.31.9');
    const ran = run(dir, ['v2026.31.9', '--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /contains a different CHANGELOG\.md from v2026\.31\.9/);
  });

  it('refuses an unproved tag even with a cached VSIX', { skip: vsixSkip }, async () => {
    const dir = await repo();
    git(dir, 'tag', '-a', 'v2026.31.9', '-m', 'old release');
    await cached(dir, '2026.31.9');
    const ran = run(dir, ['v2026.31.9', '--plan']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no matching check and smoke result/);
  });

  it(
    'refuses without a tag — there is no newest-tag default here',
    { skip: vsixSkip },
    async () => {
      const dir = await repo();
      tagAt(dir, 'v2026.31.9');
      await cached(dir, '2026.31.9');
      const ran = run(dir, [], TOKENS);
      assert.equal(ran.code, 1);
      assert.match(ran.err, /name the tag to publish/);
    }
  );

  it('refuses a tag that is not vYYYY.WW.N', async () => {
    const dir = await repo();
    const ran = run(dir, ['nightly'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /not a release tag/);
  });

  it('refuses a tag that does not exist', async () => {
    const dir = await repo();
    const ran = run(dir, ['v2026.31.9'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no such tag/);
  });

  it('refuses a lightweight tag, which carries no notes', async () => {
    const dir = await repo();
    git(dir, 'tag', 'v2026.31.9');
    const ran = run(dir, ['v2026.31.9'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /lightweight/);
  });

  /**
   * The one place a branch decides anything. `scripts/deploy.mjs` installs this same
   * tag happily — that is a staging build, and the whole point of one. What
   * makes it stable is the merge, and nothing else in the process asks.
   */
  it('refuses a tag that is not stable yet', { skip: vsixSkip }, async () => {
    const dir = await repo();
    git(dir, 'checkout', '--quiet', '-b', 'staging');
    execFileSync('sh', ['-c', 'echo two >> f'], { cwd: dir, env: CLEAN });
    git(dir, 'commit', '--quiet', '-am', 'feat: on a branch that is not main yet');
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    const ran = run(dir, ['v2026.31.9'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /not stable yet/);
    assert.match(ran.err, /Merge the branch carrying it into main/);
  });

  it('refuses a tag this machine never deployed', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    const ran = run(dir, ['v2026.31.9'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no squadron-2026\.31\.9\.vsix in dist-releases/);
    assert.match(ran.err, /npm run deploy -- v2026\.31\.9/);
  });

  it('refuses a VSIX whose manifest disagrees with its file name', { skip: vsixSkip }, async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9', { version: '2026.30.1' });
    const ran = run(dir, ['v2026.31.9'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /contains version 2026\.30\.1/);
  });

  it('refuses a VSIX belonging to another extension', { skip: vsixSkip }, async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9', { publisher: 'someone-else' });
    const ran = run(dir, ['v2026.31.9'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /someone-else\.squadron/);
  });

  it('refuses a VSIX packaged as private', { skip: vsixSkip }, async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9', { private: true });
    const ran = run(dir, ['v2026.31.9'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /"private": true/);
  });

  it('rejects the retired --unsmoked flag', { skip: vsixSkip }, async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    const ran = run(dir, ['v2026.31.9', '--unsmoked']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /--unsmoked is no longer used/);
  });

  it('refuses when a token is missing, naming the one it wants', { skip: vsixSkip }, async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    const ran = run(dir, ['v2026.31.9'], { OVSX_PAT: 'not-a-token' });
    assert.equal(ran.code, 1);
    assert.match(ran.err, /no VSCE_PAT/);
  });

  it('refuses an --only nobody knows', async () => {
    const dir = await repo();
    const ran = run(dir, ['v2026.31.9', '--only', 'npm'], TOKENS);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /--only takes ovsx or vsce/);
  });
});

describe('publish: the plan', { skip: vsixSkip }, () => {
  it(
    'plans a promoted POSIX staging package without Windows helpers',
    { skip: vsixSkip },
    async (t) => {
      const dir = await repo();
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const manifest = path.join(dir, 'package.json');
      await fs.writeFile(
        manifest,
        JSON.stringify({
          ...JSON.parse(await fs.readFile(manifest, 'utf8')),
          squadronBuild: 'posix-staging'
        })
      );
      git(dir, 'commit', '--quiet', '-am', 'build: omit Windows helpers');
      tagAt(dir, 'v2026.31.9');
      await cached(dir, '2026.31.9', { squadronBuild: 'posix-staging' });
      const ran = run(dir, ['v2026.31.9', '--plan']);
      assert.equal(ran.code, 0, ran.err);
      assert.equal(planned(ran).version, '2026.31.9');
      await assert.rejects(fs.stat(path.join(dir, '.git/squadron-publish.jsonl')), {
        code: 'ENOENT'
      });
    }
  );

  it('uses the tagged public version from the same cached VSIX', async () => {
    const dir = await repo('0.2.0');
    tagAt(dir, 'v2026.40.2');
    await cached(dir, '0.2.0', {}, '2026.40.2');
    const plan = planned(run(dir, ['v2026.40.2', '--plan']));
    assert.equal(plan.version, '0.2.0');
    assert.match(plan.vsix, /squadron-2026\.40\.2\.vsix$/);
  });

  it('reports the bytes, the id and which tokens are ready', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    const plan = planned(run(dir, ['v2026.31.9', '--plan'], { OVSX_PAT: 'x' }));
    assert.equal(plan.version, '2026.31.9');
    assert.equal(plan.id, 'acme.squadron');
    // By name and directory, not by absolute path: on macOS the script resolves
    // its root through `/private/var` and the test's tmpdir does not.
    assert.match(plan.vsix, /dist-releases\/squadron-2026\.31\.9\.vsix$/);
    assert.deepEqual(
      plan.galleries.map((gallery) => [gallery.id, gallery.ready]),
      [
        ['ovsx', true],
        ['vsce', false]
      ]
    );
  });

  it('plans one gallery under --only, in either argument order', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    for (const args of [
      ['v2026.31.9', '--only', 'ovsx'],
      ['--only', 'ovsx', 'v2026.31.9']
    ]) {
      assert.deepEqual(
        planned(run(dir, [...args, '--plan'], TOKENS)).galleries.map((gallery) => gallery.id),
        ['ovsx']
      );
    }
  });

  /**
   * `PUBLISH_REF` replaces the whole stable channel from the environment, which
   * makes it the one way this gate is passed by accident. A plan that did not
   * name the ref could not tell you it had moved — every case in this file sets
   * it, and until it was reported none of them said so.
   */
  it('names the ref that decided the tag was stable', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    assert.equal(planned(run(dir, ['v2026.31.9', '--plan'])).ref, 'work');
  });

  it('reads a token the environment lacks from .publish.env', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    await fs.writeFile(path.join(dir, '.publish.env'), 'VSCE_PAT=from-file\n');
    const plan = planned(run(dir, ['v2026.31.9', '--plan'], { OVSX_PAT: 'x' }));
    assert.deepEqual(
      plan.galleries.map((gallery) => [gallery.id, gallery.ready]),
      [
        ['ovsx', true],
        ['vsce', true]
      ]
    );
  });

  it('plans without either token, since a plan publishes nothing', async () => {
    const dir = await repo();
    tagAt(dir, 'v2026.31.9');
    await cached(dir, '2026.31.9');
    const ran = run(dir, ['v2026.31.9', '--plan']);
    assert.equal(ran.code, 0, ran.err);
    await assert.rejects(fs.stat(path.join(dir, '.git/squadron-publish.jsonl')), {
      code: 'ENOENT'
    });
    assert.equal(
      planned(ran).galleries.every((gallery) => !gallery.ready),
      true
    );
  });
});

describe('publish: the persistent log', { skip: vsixSkip }, () => {
  it('appends gallery outcomes, preserving partial success and excluding tokens', async (t) => {
    const dir = await repo();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    tagAt(dir, 'v2026.31.9');
    const vsix = await cached(dir, '2026.31.9');
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, 'npx.cjs'),
      `process.exit(process.env.FAIL_VSCE === '1' && process.argv.includes('@vscode/vsce') ? 7 : 0);\n`,
      { mode: 0o755 }
    );
    const env = { ...TOKENS, ...commandEnv(dir, 'npx', path.join(bin, 'npx.cjs')) };
    const logFile = path.join(dir, '.git/squadron-publish.jsonl');
    const before = git(dir, 'status', '--porcelain');
    const first = run(dir, ['v2026.31.9'], env);
    assert.equal(first.code, 0, first.err);
    assert.equal(git(dir, 'status', '--porcelain'), before);
    const firstLog = await fs.readFile(logFile, 'utf8');
    const linked = path.join(dir, 'linked');
    git(dir, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD');
    await fs.mkdir(path.join(linked, 'dist-releases'));
    await fs.copyFile(vsix, path.join(linked, 'dist-releases', path.basename(vsix)));
    const linkedBefore = git(linked, 'status', '--porcelain');
    const second = run(linked, ['v2026.31.9'], { ...env, FAIL_VSCE: '1' });
    assert.equal(second.code, 1);
    assert.equal(git(linked, 'status', '--porcelain'), linkedBefore);
    assert.match(second.err, /Open VSX already has it/);
    const log = await fs.readFile(logFile, 'utf8');
    assert.ok(log.startsWith(firstLog));
    assert.ok(!log.includes(TOKENS.VSCE_PAT));
    const rows = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      rows.map((row) => [row.gallery, row.status]),
      [
        ['ovsx', 'started'],
        ['ovsx', 'published'],
        ['vsce', 'started'],
        ['vsce', 'published'],
        ['ovsx', 'started'],
        ['ovsx', 'published'],
        ['vsce', 'started'],
        ['vsce', 'failed']
      ]
    );
    const hash = crypto
      .createHash('sha256')
      .update(await fs.readFile(vsix))
      .digest('hex');
    for (const row of rows) {
      assert.equal(row.tag, 'v2026.31.9');
      assert.equal(row.version, '2026.31.9');
      assert.equal(row.commit, git(dir, 'rev-parse', 'HEAD'));
      assert.equal(row.id, 'acme.squadron');
      assert.equal(row.ref, 'work');
      assert.equal(row.vsixSha256, hash);
      assert.ok(typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)));
    }
    assert.equal(new Set(rows.slice(0, 4).map((row) => row.run)).size, 1);
    assert.equal(new Set(rows.slice(4).map((row) => row.run)).size, 1);
    assert.notEqual(rows[0]?.run, rows[4]?.run);
    await fs.rm(logFile);
    await fs.mkdir(logFile);
    const refused = run(dir, ['v2026.31.9'], env);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /cannot record Open VSX started/);
    assert.ok(!refused.out.includes('->'), 'uploads must not start without a writable log');
  });
});
