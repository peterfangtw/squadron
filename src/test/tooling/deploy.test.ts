import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../helpers';

/**
 * `scripts/deploy.mjs` driven as the process it is — the same shape as
 * `release.test.ts` and `publish.test.ts`, and for the same reason: the script
 * imports nothing from `out/`. The cache sweep is `release.test.ts`'s.
 */

const REPO = repoRoot();

/** The environment minus git's own variables — see `src/test/AGENTS.md`. */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && !key.startsWith('SQUADRON_RUN')
  )
);

/**
 * The channel a tagged deploy labels its install with. `--plan` prints the
 * answer and stops before any build; the fetch soft-fails with no remote, so
 * `origin/main` is whatever the fixture pins it to.
 */
describe('deploy: the staging label', () => {
  async function tagged(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-deploy-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: CLEAN });
    git('init', '--quiet', '--initial-branch=staging', '.');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    for (const file of [
      'deploy.mjs',
      'zip.mjs',
      'release_candidate.mjs',
      'private-files-helper.mjs',
      'windows-helper-artifacts.mjs',
      'console-login-helper.mjs',
      'packaged-bundles.mjs',
      'checkpoints.mjs',
      'verification_processes.mjs',
      'observation.mjs'
    ])
      await fs.copyFile(path.join(REPO, 'scripts', file), path.join(dir, 'scripts', file));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      `{\n  "name": "squadron",\n  "publisher": "acme",\n  "version": "0.2.0"\n}\n`
    );
    git('add', '.');
    git('commit', '--quiet', '-m', 'on main');
    git(
      'tag',
      '-a',
      'v2026.40.1',
      '-m',
      `stable\n\nGate: check+smoke ${git('rev-parse', 'HEAD^{tree}').trim()}`
    );
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('commit', '--quiet', '--allow-empty', '-m', 'staging only');
    git(
      'tag',
      '-a',
      'v2026.40.2',
      '-m',
      `staging\n\nGate: check+smoke ${git('rev-parse', 'HEAD^{tree}').trim()}`
    );
    return dir;
  }

  const plan = (dir: string, tag: string): { staging: boolean } =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(dir, 'scripts/deploy.mjs'), tag, '--plan'], {
        cwd: dir,
        encoding: 'utf8',
        env: CLEAN
      })
    ) as { staging: boolean };

  it('labels a tag on origin/main stable and one past it staging', async () => {
    const dir = await tagged();
    const stable = plan(dir, 'v2026.40.1');
    const staging = plan(dir, 'v2026.40.2');
    assert.equal(stable.staging, false);
    assert.equal(staging.staging, true);
  });
});
