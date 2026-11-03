import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as checkpoints from './checkpoints.mjs';
import * as observation from './observation.mjs';
import * as perf from 'node:perf_hooks';
import * as artifacts from './windows-helper-artifacts.mjs';

const git = (root, args, options = {}) =>
  cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
const common = (root) => path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
const store = (root) => path.join(common(root), 'squadron-candidates');

export function inspect(root, id) {
  if (!/^[\da-f-]{36}$/.test(id ?? '')) throw new Error('resume needs a candidate ID');
  return new checkpoints.Candidate(path.join(store(root), id));
}

export function deployBundles(root, tag, destination) {
  const directory = store(root);
  if (!fs.existsSync(directory)) return undefined;
  const tree = git(root, ['rev-parse', `${tag}^{tree}`]);
  const commit = git(root, ['rev-parse', `${tag}^{commit}`]);
  const tagObject = git(root, ['rev-parse', `refs/tags/${tag}`]);
  for (const id of fs.readdirSync(directory).filter((id) => /^[\da-f-]{36}$/.test(id))) {
    const dir = path.join(directory, id);
    if (checkpoints.read(path.join(dir, 'candidate.json'))?.tag !== tag) continue;
    let c;
    let outcome = 'failed';
    try {
      c = new checkpoints.Candidate(dir);
      if (!destination && c.busy()) throw new Error('candidate is busy');
      if (destination) c.take();
      const m = c.manifest;
      if (
        m.expired ||
        Date.now() - m.created >= checkpoints.CANDIDATE_MAX_AGE_MS ||
        m.tag !== tag ||
        m.origin !== common(root) ||
        m.tree !== tree ||
        m.releaseCommit !== commit ||
        m.tagObject !== tagObject ||
        m.buildHost?.node !== process.version ||
        m.buildHost?.platform !== process.platform ||
        m.buildHost?.arch !== process.arch
      )
        throw new Error('candidate identity, build host or retention does not match');
      for (const [label, stage] of [
        ['check', 'check'],
        ['smoke', 'test:smoke'],
        ['smoke-remote', 'test:smoke:one']
      ]) {
        if (!c.receipt('gate:' + label, { scope: 'all', stage }))
          throw new Error('candidate has incomplete release gates');
      }
      if (!c.outputsMatch()) throw new Error('candidate outputs are missing or changed');
      for (const helper of artifacts.HELPERS)
        if (fs.existsSync(path.join(c.workspace, helper.source, 'toolchain.json')))
          artifacts.verifyBuild(helper, c.workspace);
      if (destination) {
        const source = path.join(c.workspace, 'dist');
        const expected = checkpoints.treeDigest(source);
        fs.cpSync(source, destination, { recursive: true });
        if (checkpoints.treeDigest(destination) !== expected || !c.outputsMatch())
          throw new Error('candidate outputs changed while copying');
      }
      outcome = 'passed';
      return id;
    } catch (error) {
      if (destination) fs.rmSync(destination, { recursive: true, force: true });
      console.error(`deploy: candidate ${id} unavailable: ${error.message}; using archive build`);
    } finally {
      if (c?.token) {
        c.event({ kind: 'deploy', outcome, tag });
        c.release(outcome);
      }
    }
  }
  return undefined;
}

export async function prepare(root, metadata) {
  const runs = path.join(common(root), 'squadron-runs');
  checkpoints.pruneCandidates(store(root), runs);
  const c = checkpoints.Candidate.create(store(root), {
    ...metadata,
    runs,
    origin: common(root),
    environment: checkpoints.environment(root)
  }).take();
  try {
    await c.run('source archive', 'sh', [
      '-c',
      'git -C "$1" archive "$2" | tar -x -C "$3"',
      '_',
      root,
      metadata.parent,
      c.workspace
    ]);
    fs.writeFileSync(path.join(c.workspace, 'package.json'), metadata.updated);
    const index = path.join(c.dir, 'source.index');
    const opts = { env: { ...process.env, GIT_INDEX_FILE: index } };
    git(root, ['read-tree', metadata.parent], opts);
    const blob = git(root, ['hash-object', '-w', '--stdin'], { input: metadata.updated });
    git(root, ['update-index', '--cacheinfo', `100644,${blob},package.json`], opts);
    c.manifest.tree = git(root, ['write-tree'], opts);
    c.manifest.source = checkpoints.treeDigest(c.workspace, checkpoints.SOURCE_EXCLUDES);
    c.save();
    return c;
  } catch (error) {
    c.release('failed');
    throw error;
  }
}

function sourceUnchanged(c) {
  if (
    !c.manifest.source ||
    checkpoints.treeDigest(c.workspace, checkpoints.SOURCE_EXCLUDES) !== c.manifest.source
  )
    throw new Error('candidate source changed; start a new candidate');
}

/** The recorded Git tree is the tested source. A rewritten id must not be tagged. */
function assertTreeIdentity(root, c) {
  const fail = () => {
    throw new Error('candidate tree identity changed');
  };
  let listed;
  try {
    listed = git(root, ['ls-tree', '-r', '-z', c.manifest.tree]);
  } catch {
    fail();
  }
  const expected = new Map();
  for (const record of listed.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) fail();
    const [mode, type, hash] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (type !== 'blob' || !hash || !mode) fail();
    expected.set(file, hash);
  }
  const actual = new Map();
  const walk = (at, relative) => {
    for (const entry of fs.readdirSync(at).sort()) {
      const rel = relative ? `${relative}/${entry}` : entry;
      if (checkpoints.SOURCE_EXCLUDES.includes(rel)) continue;
      const full = path.join(at, entry);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) actual.set(rel, full);
      else fail();
    }
  };
  walk(c.workspace, '');
  if (actual.size !== expected.size) fail();
  for (const [file, hash] of expected) {
    const full = actual.get(file);
    if (!full || git(root, ['hash-object', full]) !== hash) fail();
  }
}

function dependencies(c) {
  const dir = path.join(c.workspace, 'node_modules');
  return fs.existsSync(dir) ? checkpoints.treeDigest(dir) : 'none';
}

export async function execute(root, c, { noPush = false } = {}) {
  noPush ||= c.manifest.noPush === true;
  if (!c.token) c.take();
  const began = c.attemptBegan;
  let outcome = 'failed';
  console.log(`release: candidate ${c.manifest.id}`);
  try {
    if (
      c.manifest.origin !== common(root) ||
      c.manifest.environment !== checkpoints.environment(root)
    )
      throw new Error('candidate environment/toolchain mismatch; start a new candidate');
    sourceUnchanged(c);
    assertTreeIdentity(root, c);
    if (c.manifest.integration) recoverIntegration(root, c);
    if (c.manifest.outputs && !c.outputsMatch()) c.rebuild();
    const inputs = { environment: c.manifest.environment, installation: dependencies(c) };
    if (!c.reuse('deps', inputs)) {
      c.rebuild();
      console.log('release: dependencies');
      const start = perf.performance.now();
      await c.run('dependencies', 'npm', ['ci', '--silent']);
      sourceUnchanged(c);
      c.checkpoint(
        'deps',
        { environment: c.manifest.environment, installation: dependencies(c) },
        perf.performance.now() - start
      );
    }
    const helperEnvironment = Object.assign(
      {},
      ...artifacts.HELPERS.filter((helper) =>
        fs.existsSync(path.join(c.workspace, helper.source, 'toolchain.json'))
      ).map((helper) => artifacts.buildEnvironment(helper, root))
    );
    for (const [label, stage, args] of [
      ['check', 'check', ['run', 'check']],
      ['smoke', 'test:smoke', ['run', 'test:smoke']],
      [
        'smoke-remote',
        'test:smoke:one',
        ['run', 'test:smoke:one', '--', 'out/test/smoke/remote_panel.smoke.js']
      ]
    ]) {
      const inputs = { scope: 'all', stage };
      if (c.reuse('gate:' + label, inputs)) {
        observation.event('release:stage', { label, outcome: 'reused' });
        console.log(`release: reused ${label}`);
        continue;
      }
      observation.event('release:stage', { label, outcome: 'executed' });
      console.log('release: ' + label);
      const start = perf.performance.now();
      await c.run(label, 'npm', args, {
        ...helperEnvironment,
        ...c.context(stage),
        SQUADRON_RUNS_DIR: c.runs,
        SQUADRON_TIMINGS_FILE: path.join(common(root), 'squadron-timings.jsonl'),
        ...(stage === 'check' ? { SQUADRON_TEST_ALL: '1' } : {})
      });
      if (c.workBusy()) throw new Error('candidate child processes have not confirmed shutdown');
      sourceUnchanged(c);
      c.manifest = checkpoints.read(path.join(c.dir, 'candidate.json'));
      if (c.manifest.outputs && !c.outputsMatch()) {
        c.rebuild();
        throw new Error('candidate outputs changed during verification; rebuild required');
      }
      c.checkpoint('gate:' + label, inputs, perf.performance.now() - start);
    }
    sourceUnchanged(c);
    for (const helper of artifacts.HELPERS)
      if (fs.existsSync(path.join(c.workspace, helper.source, 'toolchain.json')))
        artifacts.verifyBuild(helper, c.workspace);
    const result = await finalize(root, c);
    outcome = 'passed';
    c.event({
      kind: 'delivery',
      outcome,
      ms: perf.performance.now() - began,
      latencyMs: Date.now() - c.manifest.created,
      commit: result.commit,
      integrated: result.integrated
    });
    if (!result.integrated) {
      console.log(
        `release: ${c.manifest.tag} finalized on ${result.commit.slice(0, 7)}; checkout preserved`
      );
      console.log(
        `release: integrate explicitly with git merge ${c.manifest.tag}; then push the intended branch and tag`
      );
      return;
    }
    console.log(`release: ${c.manifest.tag} on ${result.commit.slice(0, 7)}`);
    if (noPush) {
      console.log('release: --no-push, so nothing was pushed');
      return;
    }
    for (const [label, ref] of [
      ['the branch', `${result.commit}:${c.manifest.branch}`],
      ['the tag', c.manifest.tag]
    ]) {
      try {
        git(root, ['push', '--quiet', '--no-verify', 'origin', ref]);
      } catch {
        throw new Error(
          `pushing ${label} was refused. ${c.manifest.tag} is cut locally and nothing was undone.\n       git push --no-verify origin ${result.commit}:${c.manifest.branch} && git push --no-verify origin ${c.manifest.tag}\n       Do not re-run a new release; retry those pushes or resume this candidate.`
        );
      }
    }
    console.log(`release: pushed ${c.manifest.branch} and ${c.manifest.tag}`);
    console.log(
      `release: install it with npm run deploy -- ${c.manifest.tag}; merge ${c.manifest.branch} into main to publish`
    );
  } catch (error) {
    outcome = error.interrupted ? 'interrupted' : 'failed';
    c.event({
      kind: 'delivery',
      outcome,
      ms: perf.performance.now() - began,
      error: error.message
    });
    throw new Error(
      `${error.message}\n  resume: npm run release -- --resume ${c.manifest.id}\n  evidence root: ${c.runs}`
    );
  } finally {
    c.release(outcome);
  }
}

function ref(root, name) {
  try {
    return git(root, ['rev-parse', '--verify', name]);
  } catch {
    return undefined;
  }
}

/** A journal bridges the ref transaction and the checked-out index rename. */
function recoverIntegration(root, c) {
  const j = c.manifest.integration;
  if (!j) return;
  if (git(root, ['symbolic-ref', 'HEAD']) !== `refs/heads/${c.manifest.branch}`)
    throw new Error('checkout switched during finalization; inspect retained integration journal');
  const head = git(root, ['rev-parse', 'HEAD']);
  const index = git(root, ['rev-parse', '--git-path', 'index']);
  const realIndex = path.resolve(root, index);
  const packageFile = path.join(root, 'package.json');
  const current = fs.readFileSync(packageFile, 'utf8');
  if (!j.claimed) {
    for (const lock of [realIndex + '.lock']) {
      if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === j.token) fs.rmSync(lock);
    }
    delete c.manifest.integration;
    c.save();
    return;
  }
  if (head === c.manifest.releaseCommit) {
    if (current !== c.manifest.updated)
      throw new Error('package.json changed after ref finalization; inspect integration journal');
    if (
      fs.existsSync(realIndex + '.lock') &&
      checkpoints.digest(fs.readFileSync(realIndex)) !== j.newIndex
    ) {
      if (
        checkpoints.digest(fs.readFileSync(realIndex)) !== j.oldIndex ||
        fs.readFileSync(realIndex + '.lock', 'utf8') !== j.token ||
        checkpoints.digest(fs.readFileSync(j.prepared)) !== j.newIndex
      )
        throw new Error('index changed during finalization recovery');
      fs.renameSync(j.prepared, realIndex);
      fs.rmSync(realIndex + '.lock');
    } else if (checkpoints.digest(fs.readFileSync(realIndex)) !== j.newIndex)
      throw new Error('finalized checkout index differs from integration journal');
    if (fs.existsSync(realIndex + '.lock')) {
      if (fs.readFileSync(realIndex + '.lock', 'utf8') !== j.token)
        throw new Error('index claim differs from integration journal');
      fs.rmSync(realIndex + '.lock');
    }
  } else if (head === c.manifest.parent) {
    if (current === c.manifest.updated) fs.writeFileSync(packageFile, c.manifest.manifestRaw);
    else if (current !== c.manifest.manifestRaw)
      throw new Error('package.json changed before finalization recovery');
    if (fs.existsSync(realIndex + '.lock')) {
      if (fs.readFileSync(realIndex + '.lock', 'utf8') !== j.token)
        throw new Error('index lock is not this candidate’s');
      fs.rmSync(realIndex + '.lock');
    }
  } else throw new Error('HEAD changed during finalization; inspect retained integration journal');
  delete c.manifest.integration;
  c.save();
}

export async function finalize(root, c) {
  c.manifest = checkpoints.read(path.join(c.dir, 'candidate.json'));
  const m = c.manifest;
  for (const [label, stage] of [
    ['check', 'check'],
    ['smoke', 'test:smoke'],
    ['smoke-remote', 'test:smoke:one']
  ]) {
    if (!c.receipt('gate:' + label, { scope: 'all', stage }))
      throw new Error('incomplete release gates');
  }
  assertTreeIdentity(root, c);
  if (!m.releaseCommit) {
    m.releaseCommit = git(root, [
      'commit-tree',
      m.tree,
      '-p',
      m.parent,
      '-m',
      `chore: version ${m.publicVersion}`
    ]);
    const ident = git(root, ['var', 'GIT_COMMITTER_IDENT']);
    m.tagObject = git(root, ['mktag'], {
      input: `object ${m.releaseCommit}\ntype commit\ntag ${m.tag}\ntagger ${ident}\n\n${m.notes}\n\nGate: check+smoke ${m.tree}\n`
    });
    c.save();
  }
  const integration = await import('./integration.mjs');
  integration.recordRelease(root, c);
  const existing = ref(root, 'refs/tags/' + m.tag);
  if (existing && existing !== m.tagObject)
    throw new Error(`${m.tag} already exists for a different candidate`);
  const recovery = `refs/squadron/candidates/${m.id}`;
  const existingRecovery = ref(root, recovery);
  if (existingRecovery && existingRecovery !== m.releaseCommit)
    throw new Error('candidate recovery ref mismatch');
  if (existing)
    return {
      commit: m.releaseCommit,
      integrated: git(root, ['rev-parse', 'HEAD']) === m.releaseCommit
    };
  const index = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']));
  const packageFile = path.join(root, 'package.json');
  let integrate = false;
  let heldIndex = false;
  const token = c.token;
  const prepared = path.join(c.dir, 'integration.index');
  try {
    try {
      fs.copyFileSync(index, prepared);
      const oldIndex = checkpoints.digest(fs.readFileSync(prepared));
      const env = { ...process.env, GIT_INDEX_FILE: prepared };
      const blob = git(root, ['rev-parse', `${m.tree}:package.json`]);
      git(root, ['update-index', '--cacheinfo', `100644,${blob},package.json`], { env });
      m.integration = {
        token,
        oldIndex,
        newIndex: checkpoints.digest(fs.readFileSync(prepared)),
        prepared
      };
      c.save();
      fs.writeFileSync(index + '.lock', token, { flag: 'wx' });
      heldIndex = true;
      integrate =
        git(root, ['symbolic-ref', 'HEAD']) === `refs/heads/${m.branch}` &&
        git(root, ['rev-parse', 'HEAD']) === m.parent &&
        fs.readFileSync(packageFile, 'utf8') === m.manifestRaw &&
        git(root, ['show', ':package.json']) === m.manifestRaw.trim() &&
        git(root, ['ls-files', '-s', 'package.json']).startsWith('100644 ') &&
        checkpoints.digest(fs.readFileSync(index)) === oldIndex;
      if (integrate) {
        m.integration.claimed = true;
        c.save();
      } else {
        delete m.integration;
        c.save();
      }
    } catch (error) {
      if (m.integration?.claimed) throw error;
      delete m.integration;
      c.save();
      integrate = false;
    }
    const commands = [
      'start',
      ...(existingRecovery
        ? [`verify ${recovery} ${m.releaseCommit}`]
        : [`create ${recovery} ${m.releaseCommit}`]),
      `create refs/tags/${m.tag} ${m.tagObject}`,
      ...(integrate ? [`update refs/heads/${m.branch} ${m.releaseCommit} ${m.parent}`] : []),
      'prepare',
      ''
    ];
    await transaction(root, commands, c, () => {
      if (!integrate) return;
      if (
        git(root, ['symbolic-ref', 'HEAD']) !== `refs/heads/${m.branch}` ||
        git(root, ['rev-parse', 'HEAD']) !== m.parent ||
        fs.readFileSync(packageFile, 'utf8') !== m.manifestRaw ||
        checkpoints.digest(fs.readFileSync(index)) !== m.integration.oldIndex
      )
        throw new Error('checkout changed before prepared finalization');
      fs.writeFileSync(packageFile, m.updated);
    });
    if (integrate) {
      fs.renameSync(prepared, index);
      fs.rmSync(index + '.lock');
    }
    delete m.integration;
    c.save();
    return { commit: m.releaseCommit, integrated: integrate };
  } catch (error) {
    if (m.integration) recoverIntegration(root, c);
    throw error;
  } finally {
    if (heldIndex && fs.existsSync(index + '.lock') && !m.integration) fs.rmSync(index + '.lock');
  }
}

async function transaction(root, commands, candidate, prepared) {
  const child = cp.spawn('git', ['update-ref', '--stdin'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (candidate.manifest.integration) {
    candidate.manifest.integration.transaction = checkpoints.processIdentity(child.pid);
    candidate.save();
  }
  let output = '';
  let errors = '';
  let failure;
  let sent = false;
  child.stderr.setEncoding('utf8').on('data', (text) => {
    errors += text;
  });
  child.stdout.setEncoding('utf8').on('data', (text) => {
    output += text;
    if (!sent && output.includes('prepare: ok')) {
      sent = true;
      try {
        prepared();
        child.stdin.end('commit\n');
      } catch (error) {
        failure = error;
        child.stdin.end('abort\n');
      }
    }
  });
  child.stdin.on('error', (error) => {
    failure ??= error;
  });
  child.stdin.write(commands.join('\n'));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (failure) throw failure;
  if (code || !output.includes('commit: ok'))
    throw new Error(`release ref transaction failed: ${errors.trim()}`);
}
