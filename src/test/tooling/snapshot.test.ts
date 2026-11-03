import * as assert from 'node:assert/strict';
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as test from 'node:test';
import { needsFileSymlinks, repoRoot } from '../helpers';

const ROOT = repoRoot();
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'SNAPSHOT_TARGET'
  )
);
const FIRST = 'v2026.40.9';
const SECOND = 'v2026.40.10';

function git(dir: string, ...args: string[]): string {
  return child
    .execFileSync('git', args, { cwd: dir, env: CLEAN, encoding: 'utf8', stdio: 'pipe' })
    .trim();
}

function fixture(t: test.TestContext): { source: string; origin: string; target: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const origin = path.join(dir, 'origin.git');
  const target = path.join(dir, 'public.git');
  fs.mkdirSync(source);
  git(source, 'init', '--quiet', '--initial-branch=staging');
  git(source, 'config', 'user.name', 'private developer');
  git(source, 'config', 'user.email', 'private@example.com');
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.copyFileSync(
    path.join(ROOT, 'scripts/snapshot.mjs'),
    path.join(source, 'scripts/snapshot.mjs')
  );
  fs.copyFileSync(path.join(ROOT, '.publicignore'), path.join(source, '.publicignore'));
  fs.mkdirSync(path.join(source, 'scripts/local'));
  fs.writeFileSync(path.join(source, 'scripts/local/comments.mjs'), '// private audit\n');
  fs.writeFileSync(path.join(source, '.gitignore'), 'tracked-ignored.txt\n');
  fs.writeFileSync(path.join(source, 'tracked-ignored.txt'), 'still public\n');
  fs.writeFileSync(path.join(source, 'file.txt'), 'one\n');
  fs.writeFileSync(path.join(source, 'obsolete.txt'), 'remove in next release\n');
  fs.writeFileSync(path.join(source, 'hidden.txt'), 'excluded in next release\n');
  fs.writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('file.txt', path.join(source, 'link'));
  fs.mkdirSync(path.join(source, 'docs'));
  fs.writeFileSync(path.join(source, 'docs/private.md'), 'private notes\n');
  fs.mkdirSync(path.join(source, 'src/test/session'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'src/test/session/brand_marks.test.ts'),
    '// private doc audit\n'
  );
  git(source, 'add', '--force', '.');
  // The index, not the file mode, carries the bit where the filesystem has none.
  git(source, 'update-index', '--chmod=+x', 'run.sh');
  git(source, 'commit', '--quiet', '-m', 'feat: private development');
  tag(source, FIRST);
  git(source, 'init', '--quiet', '--bare', origin);
  git(source, 'remote', 'add', 'origin', origin);
  git(source, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main', '--tags');
  git(source, 'init', '--quiet', '--bare', target);
  return { source, origin, target };
}

function tag(source: string, name: string): void {
  git(
    source,
    'tag',
    '-a',
    name,
    '-m',
    `private notes\n\nGate: check+smoke ${git(source, 'rev-parse', 'HEAD^{tree}')}`
  );
}

function second(source: string, stable = true): void {
  fs.writeFileSync(path.join(source, 'file.txt'), 'two\n');
  fs.rmSync(path.join(source, 'obsolete.txt'));
  fs.appendFileSync(path.join(source, '.publicignore'), 'hidden.txt\n');
  git(source, 'add', '--all');
  git(source, 'commit', '--quiet', '-m', 'fix: private changes');
  tag(source, SECOND);
  git(source, 'push', '--quiet', 'origin', ...(stable ? ['HEAD:refs/heads/main'] : []), '--tags');
}

function run(
  source: string,
  target: string,
  ...args: string[]
): { code: number; out: string; err: string } {
  const result = child.spawnSync(
    process.execPath,
    [path.join(source, 'scripts/snapshot.mjs'), ...args],
    {
      cwd: source,
      env: { ...CLEAN, SNAPSHOT_TARGET: target },
      encoding: 'utf8'
    }
  );
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

test.describe('source snapshot publication', { skip: needsFileSymlinks() }, () => {
  test.it('preserves annotated release proof when checking out a tag event by commit', (t) => {
    const { source, target } = fixture(t);
    const annotation = git(source, 'rev-parse', `refs/tags/${FIRST}`);
    git(source, 'checkout', '--detach', git(source, 'rev-parse', `${FIRST}^{commit}`));
    const result = run(source, target, '--latest');
    assert.equal(result.code, 0, result.err);
    assert.equal(git(source, 'rev-parse', `refs/tags/${FIRST}`), annotation);
    assert.equal(git(source, 'cat-file', '-t', FIRST), 'tag');
    assert.equal(git(target, 'tag', '--list'), FIRST);
  });

  test.it('reports a conflicting local tag when refreshing release refs', (t) => {
    const { source, target } = fixture(t);
    git(source, 'update-ref', `refs/tags/${FIRST}`, git(source, 'rev-parse', `${FIRST}^{commit}`));
    const result = run(source, target, '--latest');
    assert.equal(result.code, 1);
    assert.match(result.err, /would clobber existing tag/);
    assert.equal(git(target, 'for-each-ref', '--format=%(refname)'), '');
  });

  test.it('copies two filtered checkpoints, including deletions, without private history', (t) => {
    const { source, target } = fixture(t);
    fs.writeFileSync(path.join(source, 'file.txt'), 'uncommitted\n');
    const before = git(source, 'status', '--porcelain');
    const first = run(source, target, FIRST);
    assert.equal(first.code, 0, first.err);
    assert.equal(git(source, 'status', '--porcelain'), before);
    assert.equal(git(target, 'show', 'main:file.txt'), 'one');
    assert.equal(git(target, 'rev-list', '--count', '--all'), '1');
    assert.doesNotMatch(
      git(target, 'ls-tree', '-r', '--name-only', 'main'),
      /docs\/|brand_marks|scripts\/local\//
    );
    assert.equal(git(target, 'show', 'main:tracked-ignored.txt'), 'still public');
    assert.match(git(target, 'ls-tree', '-r', '--name-only', 'main'), /scripts\/snapshot\.mjs/);
    assert.match(git(target, 'ls-tree', 'main', 'run.sh'), /^100755 /);
    assert.match(git(target, 'ls-tree', 'main', 'link'), /^120000 /);
    assert.equal(
      git(target, 'log', '-1', '--format=%an|%ae|%cn|%ce', 'main'),
      'peterfangtw|167056201+peterfangtw@users.noreply.github.com|peterfangtw|167056201+peterfangtw@users.noreply.github.com'
    );
    assert.equal(git(target, 'cat-file', '-t', FIRST), 'commit');
    second(source);
    const next = run(source, target, SECOND);
    assert.equal(next.code, 0, next.err);
    assert.equal(git(target, 'show', 'main:file.txt'), 'two');
    assert.doesNotMatch(
      git(target, 'ls-tree', '-r', '--name-only', 'main'),
      /obsolete\.txt|hidden\.txt|docs\//
    );
    assert.equal(git(target, 'rev-list', '--count', '--all'), '2');
    assert.equal(git(target, 'rev-parse', 'main^'), git(target, 'rev-parse', FIRST));
    const privateCommits = new Set(git(source, 'rev-list', '--all').split('\n'));
    for (const commit of git(target, 'rev-list', '--all').split('\n')) {
      assert.ok(!privateCommits.has(commit));
    }
  });

  test.it('previews without publishing and retries a tag without another commit', (t) => {
    const { source, target } = fixture(t);
    const planned = run(source, target, FIRST, '--plan');
    assert.equal(planned.code, 0, planned.err);
    assert.equal(git(target, 'for-each-ref', '--format=%(refname)'), '');
    assert.equal(run(source, target, FIRST).code, 0);
    const before = git(target, 'show-ref');
    const retry = run(source, target, FIRST);
    assert.equal(retry.code, 0, retry.err);
    assert.match(retry.out, /already published/);
    assert.equal(git(target, 'show-ref'), before);
  });

  test.it('uses only the latest main release and refuses an explicit staging-only tag', (t) => {
    const { source, target } = fixture(t);
    second(source, false);
    const refused = run(source, target, SECOND);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /not on.*main/);
    const latest = run(source, target, '--latest');
    assert.equal(latest.code, 0, latest.err);
    assert.equal(git(target, 'tag', '--list'), FIRST);
  });

  test.it('refuses tags without a matching release gate', (t) => {
    const { source, target } = fixture(t);
    git(source, 'tag', '-d', FIRST);
    git(source, 'tag', '-a', FIRST, '-m', 'unproved');
    git(source, 'push', '--quiet', '--force', 'origin', 'refs/tags/' + FIRST);
    const refused = run(source, target, FIRST);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /matching check and smoke/);
    assert.equal(git(target, 'for-each-ref', '--format=%(refname)'), '');
  });

  test.it(
    'skips newer lightweight and unproved main tags when selecting the latest proved release',
    (t) => {
      const { source, target } = fixture(t);
      git(source, 'tag', SECOND);
      git(source, 'push', '--quiet', 'origin', '--tags');
      const lightweight = run(source, target, '--latest');
      assert.equal(lightweight.code, 0, lightweight.err);
      assert.equal(git(target, 'tag', '--list'), FIRST);
      git(source, 'tag', '-d', SECOND);
      git(source, 'tag', '-a', SECOND, '-m', 'unproved');
      git(source, 'push', '--quiet', '--force', 'origin', 'refs/tags/' + SECOND);
      const before = git(target, 'show-ref');
      const unproved = run(source, target, '--latest');
      assert.equal(unproved.code, 0, unproved.err);
      assert.match(unproved.out, /already published/);
      assert.equal(git(target, 'show-ref'), before);
    }
  );

  test.it('refuses a destination that contains private development commits', (t) => {
    const { source, origin } = fixture(t);
    const before = git(origin, 'show-ref');
    const refused = run(source, origin, FIRST);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /private development history/);
    assert.equal(git(origin, 'show-ref'), before);
  });

  test.it('refuses conflicting published tags instead of changing their contents', (t) => {
    const { source, target } = fixture(t);
    assert.equal(run(source, target, FIRST).code, 0);
    fs.appendFileSync(path.join(source, '.publicignore'), 'file.txt\n');
    const before = git(target, 'show-ref');
    const refused = run(source, target, FIRST);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /different snapshot/);
    assert.equal(git(target, 'show-ref'), before);
  });

  test.it('refuses an older unpublished checkpoint instead of rewinding the public files', (t) => {
    const { source, target } = fixture(t);
    second(source);
    assert.equal(run(source, target, SECOND).code, 0);
    const before = git(target, 'show-ref');
    const refused = run(source, target, FIRST);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /older|rewind/);
    assert.equal(git(target, 'show-ref'), before);
  });
});
