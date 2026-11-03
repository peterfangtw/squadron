import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as checkpoints from './checkpoints.mjs';

export const git = (root, args, env = process.env) =>
  cp
    .execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    .trim();

export function store(root, env) {
  return path.join(
    fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'], env))),
    'squadron-integrations'
  );
}

function matches(root, proof, commit, env) {
  try {
    if (
      proof?.schema !== 1 ||
      proof.repository !== store(root, env) ||
      proof.commit !== commit ||
      proof.outcome !== 'passed' ||
      !/^[a-f\d]{40,64}$/.test(commit) ||
      !['merge', 'release'].includes(proof.kind) ||
      git(root, ['rev-parse', `${commit}^{tree}`], env) !== proof.tree
    )
      return false;
    const parents = git(root, ['show', '-s', '--format=%P', commit], env).split(' ');
    return proof.kind === 'merge'
      ? Number.isSafeInteger(proof.pr) &&
          proof.pr > 0 &&
          parents.length === 2 &&
          parents[0] === proof.base &&
          parents[1] === proof.head
      : parents.length === 1 && parents[0] === proof.base;
  } catch {
    return false;
  }
}

export function record(root, proof, env) {
  const value = { ...proof, schema: 1, repository: store(root, env), outcome: 'passed' };
  if (!matches(root, value, value.commit, env))
    throw new Error('verification does not match Git result');
  checkpoints.atomic(path.join(store(root, env), 'proofs', value.commit + '.json'), value);
}

export function recordRelease(root, candidate) {
  const m = candidate.manifest;
  for (const [label, stage] of [
    ['check', 'check'],
    ['smoke', 'test:smoke'],
    ['smoke-remote', 'test:smoke:one']
  ]) {
    if (!candidate.receipt('gate:' + label, { scope: 'all', stage }))
      throw new Error('incomplete release gates');
  }
  record(root, {
    kind: 'release',
    candidate: m.id,
    commit: m.releaseCommit,
    base: m.parent,
    tree: m.tree
  });
}

function verified(root, old, next, releaseOnly = false) {
  const proof = checkpoints.read(path.join(store(root), 'proofs', next + '.json'));
  if (proof?.base !== old || !matches(root, proof, next)) return false;
  if (proof.kind === 'merge') return !releaseOnly;
  try {
    if (!/^[a-f\d-]{36}$/.test(proof.candidate ?? '')) return false;
    const c = new checkpoints.Candidate(
      path.join(path.dirname(store(root)), 'squadron-candidates', proof.candidate)
    );
    return (
      fs.realpathSync(c.manifest.origin) === path.dirname(store(root)) &&
      c.manifest.releaseCommit === next &&
      c.manifest.parent === old &&
      c.manifest.tree === proof.tree &&
      [
        ['check', 'check'],
        ['smoke', 'test:smoke'],
        ['smoke-remote', 'test:smoke:one']
      ].every(([label, stage]) => c.receipt('gate:' + label, { scope: 'all', stage }))
    );
  } catch {
    return false;
  }
}

function caughtUp(root, old, next) {
  try {
    if (!/^0+$/.test(old)) git(root, ['merge-base', '--is-ancestor', old, next]);
    git(root, ['merge-base', '--is-ancestor', next, 'refs/remotes/origin/staging']);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [mode, old, next] = process.argv.slice(2);
  try {
    if (
      !['ref', 'push'].includes(mode) ||
      !/^[a-f\d]{40,64}$/.test(old ?? '') ||
      !/^[a-f\d]{40,64}$/.test(next ?? '') ||
      !(
        (mode === 'ref' && caughtUp(process.cwd(), old, next)) ||
        verified(process.cwd(), old, next, mode === 'push')
      )
    )
      throw new Error('staging requires verified integration; use npm run integrate -- <PR>');
  } catch (error) {
    console.error(`integration: ${error.message}`);
    process.exitCode = 1;
  }
}
