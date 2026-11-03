import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as checkpoints from './checkpoints.mjs';
import * as integration from './integration.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const git = (...args) => integration.git(ROOT, args, env);
const pr = Number(process.argv[2]);
const env = Object.fromEntries(
  Object.entries(checkpoints.cleanEnv(process.env)).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'GH_REPO'
  )
);

function gh(args) {
  return cp
    .execFileSync('gh', args, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    .trim();
}

async function main() {
  if (process.argv.length !== 3 || !Number.isSafeInteger(pr) || pr <= 0)
    throw new Error('usage: npm run integrate -- <PR-number>');
  const directory = integration.store(ROOT, env);
  await checkpoints.locked(directory, async () => {
    const { repo, host } = destination();
    const endpoint = `repos/${repo}/pulls/${pr}`;
    const readPR = () => JSON.parse(gh(['api', '--hostname', host, endpoint]));
    const primary = git('worktree', 'list', '--porcelain', '-z')
      .split('\0')[0]
      .slice('worktree '.length);
    const file = path.join(directory, `pr-${pr}.json`);
    let state = checkpoints.read(file);
    if (
      fs.existsSync(file) &&
      (state?.schema !== 1 ||
        state.pr !== pr ||
        typeof state.repository !== 'string' ||
        typeof state.host !== 'string' ||
        !/^[a-f\d-]{36}$/.test(state.id ?? '') ||
        ![
          'preparing',
          'checking',
          'verified',
          'merging',
          'unknown',
          'mismatch',
          'passed',
          'failed'
        ].includes(state.status))
    )
      throw new Error(`malformed integration evidence: ${file}`);
    if (checkpoints.workBusy(state?.worktree, directory))
      throw new Error('integration child processes are still running or ownership is unknown');
    const save = (status, extra = {}) => {
      state = { ...state, ...extra, status, at: new Date().toISOString() };
      checkpoints.atomic(file, state);
      checkpoints.append(path.join(directory, 'history.jsonl'), state);
    };
    const finish = (commit) => {
      git('fetch', '--quiet', '--no-tags', 'origin', 'refs/heads/staging');
      git('fetch', '--quiet', '--no-tags', 'origin', commit);
      git('merge-base', '--is-ancestor', commit, 'refs/remotes/origin/staging');
      const proof = {
        kind: 'merge',
        pr,
        host,
        slug: repo,
        base: state.base,
        head: state.head,
        tree: state.tree,
        commit
      };
      try {
        integration.record(ROOT, proof, env);
      } catch (error) {
        save('mismatch', { commit, error: error.message });
        throw new Error(
          `PR merged with a different result; inspect ${file}. Staging was not rewritten.`
        );
      }
      save('passed', { commit });
      console.log(`integrate: PR #${pr} merged and verified at ${commit}`);
      cleanBranch(state);
    };
    const cleanWorkspace = () => {
      if (
        state.worktree !== path.join(primary, '.worktrees', `integrate-${pr}-${state.id}`) ||
        !fs.existsSync(state.worktree)
      )
        return;
      try {
        git('worktree', 'remove', '--force', state.worktree);
      } catch {
        console.error(`integrate: verified merge; workspace retained at ${state.worktree}`);
      }
    };
    const current = readPR();
    if (state && ['merging', 'unknown', 'mismatch', 'passed'].includes(state.status)) {
      if (state.repository !== repo || state.host !== host)
        throw new Error(`repository changed; inspect ${file}`);
      if (current.merged && typeof current.merge_commit_sha === 'string') {
        finish(current.merge_commit_sha);
        cleanWorkspace();
        return;
      }
      throw new Error(`previous merge outcome needs inspection: ${file}. No merge was retried.`);
    }
    validatePR(current, repo);
    state = {
      schema: 1,
      id: crypto.randomUUID(),
      repository: repo,
      host,
      pr,
      base: current.base.sha,
      head: current.head.sha,
      branch: current.head.ref
    };
    state.worktree = path.join(primary, '.worktrees', `integrate-${pr}-${state.id}`);
    save('preparing');
    let added = false;
    try {
      git(
        'fetch',
        '--quiet',
        '--no-tags',
        'origin',
        'refs/heads/staging',
        `refs/heads/${current.head.ref}`
      );
      assertInputs(current, state);
      git('worktree', 'add', '--quiet', '--detach', state.worktree, state.base);
      added = true;
      integration.git(
        state.worktree,
        ['merge', '--no-ff', '--no-edit', '--no-verify', state.head],
        env
      );
      const parents = integration.git(state.worktree, ['show', '-s', '--format=%P', 'HEAD'], env);
      if (parents !== `${state.base} ${state.head}`)
        throw new Error('PR has no new commits to integrate');
      state.tree = integration.git(state.worktree, ['rev-parse', 'HEAD^{tree}'], env);
      save('checking');
      console.log(`integrate: PR #${pr}, base ${state.base}, head ${state.head}`);
      console.log(`integrate: workspace ${state.worktree}`);
      await npm(['ci', '--silent'], state.worktree);
      await npm(['run', 'check', '--', '--base', state.base], state.worktree);
      if (
        integration.git(state.worktree, ['rev-parse', 'HEAD^{tree}'], env) !== state.tree ||
        integration.git(state.worktree, ['status', '--porcelain', '--untracked-files=all'], env)
      )
        throw new Error('candidate source changed during verification');
      save('verified');
      const latest = readPR();
      validatePR(latest, repo);
      if (latest.head.ref !== current.head.ref) throw new Error('PR branch changed; verify again');
      assertInputs(latest, state);
      // The API accepts an expected head, but no expected base (GitHub REST pulls/merge).
      save('merging');
      const result = JSON.parse(
        gh([
          'api',
          '--hostname',
          host,
          '--method',
          'PUT',
          endpoint + '/merge',
          '-f',
          'merge_method=merge',
          '-f',
          `sha=${state.head}`
        ])
      );
      if (result.merged !== true || !/^[a-f\d]{40,64}$/.test(result.sha ?? ''))
        throw new Error('GitHub did not confirm a completed merge');
      finish(result.sha);
      cleanWorkspace();
      added = false;
    } catch (error) {
      if (state.status !== 'mismatch')
        save(state.status === 'merging' ? 'unknown' : 'failed', { error: error.message });
      throw new Error(
        `${error.message}\n  evidence: ${file}${added ? `\n  workspace: ${state.worktree}` : ''}`
      );
    }
  });
}

function cleanBranch(state) {
  try {
    if (typeof state.branch !== 'string' || !state.branch.startsWith('feat/'))
      throw new Error('no recorded feat/* branch; retained for manual cleanup');
    const ref = `refs/heads/${state.branch}`;
    git('check-ref-format', ref);
    if (!/^[a-f\d]{40,64}$/.test(state.head ?? ''))
      throw new Error('invalid recorded head; retained for manual cleanup');
    const origin = git('config', '--get', 'remote.origin.url');
    const remote = git('ls-remote', '--refs', origin, ref);
    if (!remote) return;
    if (remote !== `${state.head}\t${ref}`)
      throw new Error(`${state.branch} changed since verification; retained`);
    git('push', '--quiet', `--force-with-lease=${ref}:${state.head}`, origin, `:${ref}`);
    console.log(`integrate: deleted remote branch ${state.branch}`);
  } catch (error) {
    console.error(`integrate: merge verified; branch cleanup incomplete: ${error.message}`);
  }
}

function validatePR(value, repo) {
  if (
    value.state !== 'open' ||
    value.draft ||
    value.merged ||
    value.base?.ref !== 'staging' ||
    value.base.repo?.full_name !== repo ||
    value.head?.repo?.full_name !== repo ||
    !value.head.ref?.startsWith('feat/') ||
    !/^[a-f\d]{40,64}$/.test(value.base.sha ?? '') ||
    !/^[a-f\d]{40,64}$/.test(value.head.sha ?? '')
  )
    throw new Error('requires an open, non-draft, same-repository feat/* PR targeting staging');
}

function destination() {
  const origin = git('config', '--get', 'remote.origin.url');
  let url;
  try {
    url = new URL(origin.replace(/^git@([^:]+):/, 'ssh://git@$1/'));
  } catch {
    throw new Error('origin must name its GitHub API host with an HTTPS or SSH URL');
  }
  const repo = url.pathname
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  if (!['https:', 'ssh:'].includes(url.protocol) || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('origin must name its GitHub API host and owner/repository');
  return { repo, host: url.hostname };
}

function assertInputs(value, state) {
  const refs = git(
    'ls-remote',
    '--refs',
    'origin',
    'refs/heads/staging',
    `refs/heads/${value.head.ref}`
  ).split('\n');
  const remote = new Map(
    refs.map((line) => {
      const [sha, ref] = line.split('\t');
      return [ref, sha];
    })
  );
  const target = destination();
  if (
    target.repo !== state.repository ||
    target.host !== state.host ||
    value.base.sha !== state.base ||
    value.head.sha !== state.head ||
    remote.get('refs/heads/staging') !== state.base ||
    remote.get(`refs/heads/${value.head.ref}`) !== state.head
  )
    throw new Error('PR or staging changed; run integration again against the new inputs');
}

async function npm(args, cwd) {
  const directory = integration.store(ROOT, env);
  const file = path.join(directory, `job-${crypto.randomUUID()}.json`);
  const { code, signal } = await checkpoints.runOwned({
    runner: path.join(import.meta.dirname, 'checkpoints.mjs'),
    file,
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    cwd,
    env
  });
  if (checkpoints.workBusy(cwd, directory))
    throw new Error('verification children are still running; ownership retained in job evidence');
  fs.rmSync(file);
  if (signal || code !== 0)
    throw new Error(`npm ${args[0]} ${signal ? 'interrupted' : 'failed'} (${code})`);
}

await main().catch((error) => {
  console.error(`integrate: ${error.message}`);
  process.exitCode = 1;
});
