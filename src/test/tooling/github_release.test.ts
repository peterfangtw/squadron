import * as assert from 'node:assert/strict';
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as test from 'node:test';
import { commandEnv } from '../fixtures/preload';
import { repoRoot } from '../helpers';

type Backend = {
  published: string[];
  attempts: { args: string[]; notes: string }[];
  failTag?: string;
  failApi?: boolean;
};

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-github-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const origin = path.join(dir, 'origin.git');
  const stateFile = path.join(dir, 'github.json');
  const backend = path.join(dir, 'gh.cjs');
  fs.writeFileSync(backend, BACKEND);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    ...commandEnv(dir, 'gh', backend),
    RELEASE_FIXTURE: stateFile
  };
  const save = (state: Backend): void => fs.writeFileSync(stateFile, JSON.stringify(state));
  const read = (): Backend => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Backend;
  save({ published: [], attempts: [] });
  fs.mkdirSync(source);
  const git = (...args: string[]): string =>
    child.execFileSync('git', args, { cwd: source, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Developer');
  git('config', 'user.email', 'developer@example.com');
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.copyFileSync(
    path.join(repoRoot(), 'scripts/github_release.mjs'),
    path.join(source, 'scripts/github_release.mjs')
  );
  const version = (value: string): void =>
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: value }));
  version('0.5.40');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  git('init', '--quiet', '--bare', origin);
  git('remote', 'add', 'origin', origin);
  git('push', '--quiet', 'origin', 'main');
  const run = (...args: string[]) =>
    child.spawnSync(process.execPath, ['scripts/github_release.mjs', ...args], {
      cwd: source,
      env,
      encoding: 'utf8'
    });
  const plan = (): unknown => {
    const result = run('--plan');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as unknown;
  };
  const tag = (name: string, value: string, notes: string): void => {
    version(value);
    git('add', 'package.json');
    git('commit', '--quiet', '--allow-empty', '-m', name);
    git(
      'tag',
      '-a',
      name,
      '-m',
      `${notes}\n\nGate: check+smoke ${git('rev-parse', 'HEAD^{tree}')}`
    );
  };
  return { source, git, version, run, plan, tag, save, read };
}

const BACKEND = `
const fs = require('node:fs');
const file = process.env.RELEASE_FIXTURE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'api') {
  if (state.failApi) process.exit(1);
  process.stdout.write(state.published.join('\\n'));
} else if (args[0] === 'release' && args[1] === 'create') {
  state.attempts.push({args, notes: fs.readFileSync(0, 'utf8')});
  if (args[2] !== state.failTag) state.published.push(args[2]);
  fs.writeFileSync(file, JSON.stringify(state));
  if (args[2] === state.failTag) process.exit(1);
  process.stdout.write('https://example.com/releases/' + args[2]);
} else {
  throw new Error('unexpected GitHub command: ' + args.join(' '));
}
`;

test.it(
  'uses tagged versions and notes, excludes unproved and staging tags until promotion',
  (t) => {
    const { git, version, run, plan, save } = fixture(t);
    assert.match(run('--plan').stdout, /no proved stable release/);
    const proof = `Gate: check+smoke ${git('rev-parse', 'HEAD^{tree}')}`;
    git('tag', '-a', 'v2026.44.1', '-m', `Older notes\n\n${proof}`);
    git('tag', '-a', 'v2026.44.2', '-m', `Current notes\n\nTwo paragraphs.\n\n${proof}`);
    git('tag', 'v2026.44.3');
    git('tag', '-a', 'v2026.44.4', '-m', 'No verification');
    git('tag', '-a', 'v2026.44.5', '-m', `Bad proof\n\nGate: check+smoke ${'0'.repeat(40)}`);
    git('tag', '-a', 'v2026.44.6', '-m', `Duplicate proof\n\n${proof}\n${proof}`);
    git('checkout', '--quiet', '-b', 'staging');
    version('0.5.41');
    git('add', 'package.json');
    git('commit', '--quiet', '-m', 'staging only');
    git(
      'tag',
      '-a',
      'v2026.44.7',
      '-m',
      `Staging notes\n\nGate: check+smoke ${git('rev-parse', 'HEAD^{tree}')}`
    );
    git('push', '--quiet', 'origin', 'staging', '--tags');
    version('9.9.9');
    assert.deepEqual(plan(), [
      { tag: 'v2026.44.2', title: 'v0.5.40', notes: 'Current notes\n\nTwo paragraphs.' }
    ]);
    save({ published: ['v2026.44.2'], attempts: [] });
    git('push', '--quiet', 'origin', 'HEAD:main');
    assert.deepEqual(plan(), [{ tag: 'v2026.44.7', title: 'v0.5.41', notes: 'Staging notes' }]);
    version('invalid');
    git('add', 'package.json');
    git('commit', '--quiet', '-m', 'invalid version');
    git(
      'tag',
      '-a',
      'v2026.44.8',
      '-m',
      `Notes\n\nGate: check+smoke ${git('rev-parse', 'HEAD^{tree}')}`
    );
    git('push', '--quiet', 'origin', 'HEAD:main', '--tags');
    const invalid = run('--plan');
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /no numeric extension version/);
  }
);

test.it(
  'publishes all newly promoted versions oldest first and resumes after partial failure',
  (t) => {
    const { git, tag, run, read, save } = fixture(t);
    tag('v2026.44.8', '0.5.39', 'Historical notes');
    tag('v2026.44.9', '0.5.40', 'Baseline notes');
    git('push', '--quiet', 'origin', 'main', '--tags');
    const bootstrap = run();
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    assert.deepEqual(read().published, ['v2026.44.9']);
    git('checkout', '--quiet', '-b', 'staging');
    tag('v2026.44.10', '0.5.41', 'First promoted notes');
    tag('v2026.44.11', '0.5.42', 'Second promoted notes');
    const promoted = git('rev-parse', 'HEAD');
    tag('v2026.44.12', '0.5.43', 'Still staging');
    git('push', '--quiet', 'origin', 'staging', '--tags');
    const stagingOnly = run();
    assert.equal(stagingOnly.status, 0, stagingOnly.stderr);
    assert.equal(read().attempts.length, 1);
    git('push', '--quiet', 'origin', `${promoted}:main`);
    save({ ...read(), failApi: true });
    assert.equal(run().status, 1);
    assert.equal(read().attempts.length, 1);
    save({ ...read(), failApi: false, failTag: 'v2026.44.11' });
    assert.equal(run().status, 1);
    assert.deepEqual(read().published, ['v2026.44.9', 'v2026.44.10']);
    save({ ...read(), failTag: undefined });
    const resumed = run();
    assert.equal(resumed.status, 0, resumed.stderr);
    const attempts = read().attempts;
    assert.deepEqual(
      attempts.map((attempt) => attempt.args[2]),
      ['v2026.44.9', 'v2026.44.10', 'v2026.44.11', 'v2026.44.11']
    );
    assert.deepEqual(attempts[1], {
      args: [
        'release',
        'create',
        'v2026.44.10',
        '--verify-tag',
        '--latest=false',
        '--title',
        'v0.5.41',
        '--notes-file',
        '-'
      ],
      notes: 'First promoted notes'
    });
    assert.deepEqual(attempts[3], {
      args: [
        'release',
        'create',
        'v2026.44.11',
        '--verify-tag',
        '--latest',
        '--title',
        'v0.5.42',
        '--notes-file',
        '-'
      ],
      notes: 'Second promoted notes'
    });
    assert.deepEqual(read().published, ['v2026.44.9', 'v2026.44.10', 'v2026.44.11']);
    const repeated = run();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(read().attempts.length, attempts.length);
  }
);
