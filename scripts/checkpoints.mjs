import * as fs from 'node:fs';
import * as path from 'node:path';

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import * as perf from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const SOURCE_EXCLUDES = [
  'out',
  'dist',
  'node_modules',
  'tsconfig.tsbuildinfo',
  'src/webview/tsconfig.tsbuildinfo'
];
const SCHEMA = 2;
export const CANDIDATE_MAX_AGE_MS = 7 * 86400_000;
const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT);
const CONTEXT = 'SQUADRON_VERIFY_CONTEXT';
export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const PACKAGE_NAMES = ['runner.mjs', 'verification_processes.mjs'];

function packageOf(directory, candidate = false) {
  const entries = PACKAGE_NAMES.map((name) => {
    const file = path.join(
      directory,
      !candidate && name === 'runner.mjs' ? 'checkpoints.mjs' : name
    );
    if (!fs.lstatSync(file).isFile())
      throw new Error('candidate runner snapshot package needs regular files');
    return [name, digest(fs.readFileSync(file))];
  });
  return { version: 1, entries, digest: digest(JSON.stringify(entries)) };
}

function validatePackage(directory, manifest = read(path.join(directory, 'candidate.json'))) {
  try {
    if (!fs.lstatSync(path.join(directory, 'candidate.json')).isFile())
      throw new Error('manifest needs a regular file');
    const actual = packageOf(directory, true);
    if (manifest?.schema !== SCHEMA || JSON.stringify(manifest.package) !== JSON.stringify(actual))
      throw new Error('unsupported or changed package');
    return actual;
  } catch (error) {
    throw new Error(`candidate runner snapshot package invalid: ${error.message}`);
  }
}

const PACKAGE =
  path.basename(SCRIPT) === 'runner.mjs'
    ? validatePackage(path.dirname(SCRIPT))
    : packageOf(path.dirname(SCRIPT));
// Synchronous loading keeps the existing CommonJS tooling consumers usable.
// Candidate sibling bytes are checked above before this module can execute.
const processes = createRequire(import.meta.url)('./verification_processes.mjs');
export const gateRoot = (env = process.env) => processes.gateRoot(env);

export function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(value) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    retryFileOperation(() => fs.renameSync(temp, file));
  } catch (error) {
    try {
      retryFileOperation(() => fs.rmSync(temp, { force: true }));
    } catch (cleanup) {
      console.error(`checkpoints: could not remove ${temp}: ${cleanup.message}`);
    }
    throw error;
  }
}

// win32 replacement can return EPERM while a reader holds the target open.
// Observed 2026-10-28: N1-D2 probes in TASK_inprogress_windows_tooling.md.
export function retryFileOperation(action) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EBUSY'].includes(error.code) ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

export function append(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

export function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith('SQUADRON_VERIFY_') &&
        key !== 'SQUADRON_TIMINGS_FILE' &&
        key !== 'SQUADRON_SMOKE_ENTRIES'
    )
  );
}

/** Resolve package-manager JavaScript without interpolating argv into cmd.exe. */
export function program(command, args, env = process.env) {
  if (command === 'node') return { command: process.execPath, args };
  if (/^(npm|npx)(\.cmd)?$/i.test(command)) {
    const name = command.toLowerCase().startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js';
    const observed = env.npm_execpath;
    const candidates = [
      ...(observed ? [path.join(path.dirname(observed), name)] : []),
      ...[path.dirname(process.execPath), ...(env.PATH ?? env.Path ?? '').split(path.delimiter)]
        .filter(Boolean)
        .flatMap((dir) => [
          path.join(dir, 'node_modules', 'npm', 'bin', name),
          path.resolve(dir, '../lib/node_modules/npm/bin', name)
        ])
    ];
    const entry = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!entry)
      throw new Error(`cannot locate ${name}; run through npm or install the Node toolchain`);
    return { command: process.execPath, args: [entry, ...args] };
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command))
    throw new Error('batch commands require a separately verified shell invocation');
  return { command, args };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function live(owner) {
  if (owner?.version !== 1 || !processes.validIdentity(owner)) return true;
  if (owner.pid === process.pid) return processes.sameIdentity(owner, processIdentity(process.pid));
  const table = processes.snapshot();
  return !table.complete || processes.sameIdentity(owner, processes.identity(owner.pid, table));
}

function validMetadataOwner(owner, root) {
  return (
    owner?.version === 1 &&
    owner.root === path.resolve(root) &&
    typeof owner.token === 'string' &&
    /^[\da-f-]{36}$/.test(owner.token) &&
    Number.isSafeInteger(owner.generation) &&
    owner.generation >= 0 &&
    processes.validIdentity(owner)
  );
}

export function locked(root, action) {
  const native = processIdentity(process.pid);
  if (!processes.validIdentity(native))
    throw new Error('verification metadata ownership is unknown');
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, '.verification-lock');
  const token = crypto.randomUUID();
  const deadline = Date.now() + 2000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = read(path.join(lock, 'owner.json'));
      if (owner?.pid === process.pid || Date.now() >= deadline)
        throw new Error('verification records are busy or ownership is unknown');
      if (!validMetadataOwner(owner, root) || live(owner)) {
        Atomics.wait(pause, 0, 0, 10);
        continue;
      }
      const reaper = lock + '.reap';
      try {
        fs.mkdirSync(reaper);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        Atomics.wait(pause, 0, 0, 10);
        continue;
      }
      try {
        if (JSON.stringify(read(path.join(lock, 'owner.json'))) !== JSON.stringify(owner)) continue;
        fs.rmSync(lock, { recursive: true });
      } finally {
        fs.rmdirSync(reaper);
      }
    }
  }
  const lockOwner = {
    ...native,
    root: path.resolve(root),
    token,
    generation: 0
  };
  atomic(path.join(lock, 'owner.json'), lockOwner);
  const release = () => {
    if (JSON.stringify(read(path.join(lock, 'owner.json'))) === JSON.stringify(lockOwner))
      fs.rmSync(lock, { recursive: true, force: true });
  };
  let result;
  try {
    result = action();
  } catch (error) {
    release();
    throw error;
  }
  if (result instanceof Promise) return result.finally(release);
  release();
  return result;
}

/** Includes paths, link targets and executable bits, not timestamps. */
export function treeDigest(root, exclude = []) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  function walk(at, relative) {
    const stat = fs.lstatSync(at);
    hash.update(relative + '\0' + (stat.mode & 0o777) + '\0');
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(at);
      const relativeTarget = path.relative(fs.realpathSync(root), target);
      if (relativeTarget.startsWith('..' + path.sep) || path.isAbsolute(relativeTarget))
        throw new Error(`candidate link escapes its root: ${relative}`);
      hash.update('link\0' + fs.readlinkSync(at));
      return;
    }
    if (stat.isDirectory()) {
      hash.update('dir\0');
      for (const entry of fs.readdirSync(at).sort()) {
        const rel = relative ? relative + '/' + entry : entry;
        if (!exclude.includes(rel)) walk(path.join(at, entry), rel);
      }
    } else if (stat.isFile()) {
      hash.update('file\0');
      const fd = fs.openSync(at, 'r');
      try {
        let n;
        while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
          hash.update(buffer.subarray(0, n));
      } finally {
        fs.closeSync(fd);
      }
    } else throw new Error(`unsupported candidate file: ${relative}`);
  }
  walk(root, '');
  return hash.digest('hex');
}

export function environment(root) {
  const keys = Object.entries(cleanEnv(process.env)).filter(
    ([key]) =>
      !/^(GIT_|npm_|SQUADRON_(RUN|GATE))/.test(key) &&
      !['PWD', 'OLDPWD', 'SHLVL', '_', 'NODE_TEST_CONTEXT'].includes(key)
  );
  const host =
    process.env.SQUADRON_IDE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const product = path.resolve(host, '../../Resources/app/package.json');
  return digest(
    JSON.stringify({
      node: process.version,
      exec: process.execPath,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      umask: process.umask(),
      cores: os.availableParallelism(),
      npmVersion: (() => {
        const npm = program('npm', ['--version']);
        return cp
          .execFileSync(npm.command, npm.args, {
            encoding: 'utf8',
            env: cleanEnv(process.env)
          })
          .trim();
      })(),
      npm: process.env.npm_config_user_agent ?? null,
      configuration: keys.sort(([a], [b]) => a.localeCompare(b)),
      host,
      hostVersion: read(product)?.version ?? null,
      lock: digest(fs.readFileSync(path.join(root, 'package-lock.json'))),
      runner: PACKAGE.digest,
      release: fs.existsSync(path.join(path.dirname(SCRIPT), 'release_candidate.mjs'))
        ? digest(fs.readFileSync(path.join(path.dirname(SCRIPT), 'release_candidate.mjs')))
        : null,
      reporter: digest(fs.readFileSync(path.join(path.dirname(SCRIPT), 'checkpoint-reporter.mjs')))
    })
  );
}

export class Candidate {
  constructor(dir) {
    this.dir = fs.realpathSync(dir);
    this.manifest = read(path.join(dir, 'candidate.json'));
    if (
      this.manifest?.schema !== SCHEMA ||
      this.manifest.id !== path.basename(this.dir) ||
      !/^[\da-f-]{36}$/.test(this.manifest.id) ||
      !Number.isSafeInteger(this.manifest.generation) ||
      this.manifest.generation < 0 ||
      typeof this.manifest.runs !== 'string' ||
      !path.isAbsolute(this.manifest.runs) ||
      !Number.isFinite(this.manifest.created)
    )
      throw new Error('missing or unsupported candidate manifest');
    validatePackage(this.dir, this.manifest);
    this.workspace = path.join(this.dir, 'source');
    this.runs = this.manifest.runs;
    this.token = null;
  }
  static create(store, metadata) {
    const id = crypto.randomUUID();
    const dir = path.join(store, id);
    fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runner.mjs'), SCRIPT_SOURCE, { flag: 'wx', mode: 0o600 });
    fs.copyFileSync(
      path.join(path.dirname(SCRIPT), 'verification_processes.mjs'),
      path.join(dir, 'verification_processes.mjs'),
      fs.constants.COPYFILE_EXCL
    );
    const packaged = packageOf(dir, true);
    if (packaged.digest !== PACKAGE.digest)
      throw new Error('source runner snapshot package changed');
    atomic(path.join(dir, 'candidate.json'), {
      ...metadata,
      schema: SCHEMA,
      id,
      package: packaged,
      generation: 0,
      created: Date.now()
    });
    return new Candidate(dir);
  }
  save() {
    atomic(path.join(this.dir, 'candidate.json'), this.manifest);
  }
  busy() {
    const owner = read(path.join(this.dir, 'owner.json'));
    if (owner && !validReference(owner)) return true;
    return (owner && live(owner)) || this.workBusy();
  }
  workBusy() {
    return workBusy(
      this.workspace,
      this.dir,
      read(path.join(this.dir, 'candidate.json'))?.integration?.transaction
    );
  }
  take() {
    const gate = gateRoot();
    const native = processes.identity(process.pid);
    if (!processes.validIdentity(native)) throw new Error('candidate ownership is unknown');
    const evidence = ownershipRevision(this.dir);
    const busy = this.busy();
    return locked(this.runs, () => {
      if (evidence !== ownershipRevision(this.dir))
        throw new Error('candidate ownership changed; retry');
      this.manifest = read(path.join(this.dir, 'candidate.json'));
      if (this.manifest?.schema !== SCHEMA) throw new Error('unsupported candidate manifest');
      validatePackage(this.dir, this.manifest);
      if (this.manifest.expired)
        throw new Error('candidate artifacts have expired; start a new candidate');
      if (this.manifest.pruning)
        throw new Error('candidate artifact cleanup is pending; retry pruning before reuse');
      if (busy)
        throw new Error(
          'candidate or its child processes are still running, or ownership is unknown'
        );
      this.token = crypto.randomUUID();
      this.attempt = crypto.randomUUID();
      this.attemptBegan = perf.performance.now();
      this.ownerGeneration = this.manifest.generation;
      this.ownerGate = gate;
      atomic(path.join(this.dir, 'owner.json'), {
        version: 1,
        ...native,
        gate,
        token: this.token,
        generation: this.manifest.generation
      });
      this.event({ kind: 'attempt', outcome: 'started' });
      return this;
    });
  }
  release(outcome) {
    this.event({ kind: 'attempt', outcome, ms: perf.performance.now() - this.attemptBegan });
    const evidence = ownershipRevision(this.dir);
    const busy = this.workBusy();
    locked(this.runs, () => {
      if (busy || evidence !== ownershipRevision(this.dir)) return;
      const owner = read(path.join(this.dir, 'owner.json'));
      if (
        owner?.token !== this.token ||
        owner.generation !== this.ownerGeneration ||
        owner.gate !== this.ownerGate
      )
        return;
      fs.rmSync(path.join(this.dir, 'owner.json'));
      fs.rmSync(path.join(this.runs, '.verification-pins', this.manifest.id + '.json'), {
        force: true
      });
    });
  }
  event(value) {
    append(path.join(this.dir, 'history.jsonl'), {
      schema: SCHEMA,
      candidate: this.manifest.id,
      attempt: this.attempt,
      at: new Date().toISOString(),
      ...value
    });
  }
  context(stage) {
    const gate = gateRoot();
    const file = path.join(this.dir, `context-${this.attempt}-${stage.replaceAll(':', '-')}.json`);
    atomic(file, {
      schema: SCHEMA,
      dir: this.dir,
      workspace: fs.realpathSync(this.workspace),
      token: this.token,
      ownerGeneration: this.ownerGeneration,
      attempt: this.attempt,
      stage,
      gate
    });
    return { [CONTEXT]: file, SQUADRON_GATE_DIR: gate };
  }
  checkpoint(key, inputs, ms) {
    const receipt = {
      schema: SCHEMA,
      candidate: this.manifest.id,
      key,
      inputs: digest(JSON.stringify(inputs)),
      packageDigest: PACKAGE.digest,
      generation: this.generation(key),
      attempt: this.attempt,
      ms,
      at: new Date().toISOString(),
      outcome: 'passed'
    };
    atomic(path.join(this.dir, 'receipts', digest(key) + '.json'), receipt);
    this.event({ kind: 'checkpoint', key, outcome: 'passed', ms });
    return receipt;
  }
  generation(key) {
    return /^(deps|check:format|check:lint)$/.test(key)
      ? 0
      : read(path.join(this.dir, 'candidate.json')).generation;
  }
  receipt(key, inputs) {
    validatePackage(this.dir);
    const r = read(path.join(this.dir, 'receipts', digest(key) + '.json'));
    if (
      r?.schema !== SCHEMA ||
      r.candidate !== this.manifest.id ||
      r.key !== key ||
      r.inputs !== digest(JSON.stringify(inputs)) ||
      r.packageDigest !== PACKAGE.digest ||
      r.generation !== this.generation(key) ||
      !Number.isFinite(r.ms) ||
      r.ms < 0 ||
      r.outcome !== 'passed' ||
      typeof r.attempt !== 'string' ||
      !/^[\da-f-]{36}$/.test(r.attempt)
    )
      return undefined;
    return r;
  }
  reuse(key, inputs) {
    const r = this.receipt(key, inputs);
    if (!r) return undefined;
    this.event({
      kind: 'checkpoint',
      key,
      outcome: 'reused',
      originalAttempt: r.attempt,
      originalMs: r.ms
    });
    return r;
  }
  rebuild() {
    this.manifest = read(path.join(this.dir, 'candidate.json'));
    this.manifest.generation++;
    delete this.manifest.outputs;
    this.save();
    for (const name of ['out', 'dist', 'tsconfig.tsbuildinfo', 'src/webview/tsconfig.tsbuildinfo'])
      fs.rmSync(path.join(this.workspace, name), { recursive: true, force: true });
  }
  outputDigest() {
    return digest(
      treeDigest(path.join(this.workspace, 'out')) + treeDigest(path.join(this.workspace, 'dist'))
    );
  }
  outputsMatch() {
    try {
      return this.outputDigest() === read(path.join(this.dir, 'candidate.json'))?.outputs;
    } catch {
      return false;
    }
  }
  built() {
    this.manifest = read(path.join(this.dir, 'candidate.json'));
    this.manifest.outputs = this.outputDigest();
    this.manifest.buildHost = {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    };
    this.save();
  }
  pin(run) {
    locked(this.runs, () => {
      const file = path.join(this.runs, '.verification-pins', this.manifest.id + '.json');
      const pins = read(file) ?? [];
      if (!pins.includes(run)) atomic(file, [...pins, run]);
    });
  }
  async run(label, command, args, env = {}) {
    const began = perf.performance.now();
    const runner = path.join(this.dir, 'runner.mjs');
    validatePackage(this.dir);
    const file = path.join(this.dir, `job-${crypto.randomUUID()}.json`);
    this.event({ kind: 'dispatch', key: label, outcome: 'started', job: file });
    const { code, signal } = await runOwned({
      runner,
      file,
      command,
      args,
      cwd: this.workspace,
      env: { ...cleanEnv(process.env), ...env },
      authority: {
        file: path.join(this.dir, 'owner.json'),
        token: this.token,
        generation: this.ownerGeneration
      },
      onReserved: (job) =>
        locked(this.runs, () => {
          const at = path.join(this.dir, 'owner.json');
          const owner = read(at);
          if (
            owner?.token !== this.token ||
            owner.generation !== this.ownerGeneration ||
            owner.gate !== this.ownerGate
          )
            throw new Error('candidate launch ownership changed');
          atomic(at, { ...owner, jobs: [...(owner.jobs ?? []), job] });
        })
    });
    this.event({
      kind: 'dispatch',
      key: label,
      outcome: signal ? 'interrupted' : code ? 'failed' : 'passed',
      ms: perf.performance.now() - began,
      exit: code
    });
    if (signal || code) {
      const error = new Error(`${label} ${signal ? 'interrupted' : 'failed'} (exit ${code})`);
      error.interrupted = !!signal;
      throw error;
    }
  }
}

function ownershipRevision(directory) {
  return digest(
    JSON.stringify(
      fs
        .readdirSync(directory)
        .filter(
          (name) => name === 'owner.json' || name === 'candidate.json' || name.startsWith('job-')
        )
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')])
    )
  );
}

export function workBusy(workspace, directory, finalizer) {
  if (finalizer && live(finalizer)) return true;
  const gate = gateRoot();
  const held = (at, gateDirectory = gate) => {
    if (typeof at !== 'string') return false;
    const holder = read(path.join(gateDirectory, 'holder'));
    return (
      holder?.worktree === at &&
      (live(holder) || (process.platform !== 'win32' && holder.pgid && alive(-holder.pgid)))
    );
  };
  if (held(workspace)) return true;
  const owner = read(path.join(directory, 'owner.json'));
  if (
    owner?.jobs !== undefined &&
    (!Array.isArray(owner.jobs) ||
      owner.jobs.some(
        (job) =>
          !validReference(job) ||
          typeof job.file !== 'string' ||
          !path.isAbsolute(job.file) ||
          !sameJob(read(job.file), job)
      ))
  )
    return true;
  for (const file of fs.readdirSync(directory).filter((f) => /^job-[^.]+\.json$/.test(f))) {
    const job = read(path.join(directory, file));
    if (job?.version === 1) {
      const state = read(path.join(directory, file + '.state.json'));
      const closed = read(path.join(directory, file + '.closed.json'));
      if (
        !sameJob(state, job) ||
        !['finished', 'interrupted'].includes(state.phase) ||
        !Array.isArray(state.members) ||
        !state.members.every(processes.validIdentity) ||
        !sameJob(closed, job) ||
        closed.state !== digest(JSON.stringify(state))
      )
        return true;
      continue;
    }
    return true;
  }
  return false;
}

export async function runOwned({
  runner,
  file,
  command,
  args,
  cwd,
  env = cleanEnv(process.env),
  shell = false,
  detached = process.platform !== 'win32',
  stdio = 'inherit',
  authority,
  consoleSignals = false,
  onReserved,
  onSpawn,
  onBound
}) {
  const workspace = fs.realpathSync(cwd);
  const gate = gateRoot(env);
  const owner = processIdentity(process.pid);
  const value = {
    version: 1,
    token: crypto.randomUUID(),
    generation: 0,
    command,
    args,
    cwd: workspace,
    gate,
    owner,
    authority,
    shell,
    consoleSignals
  };
  fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  onReserved?.({ file, ...reference(value) });
  if (!processes.validIdentity(owner))
    throw new Error('launch ownership is unknown: native evidence unavailable');
  const child = cp.spawn(process.execPath, [runner, '--job', file], {
    cwd: workspace,
    detached,
    stdio: typeof stdio === 'string' ? [stdio, stdio, stdio, 'ipc'] : [...stdio, 'ipc'],
    env: { ...env, SQUADRON_GATE_DIR: gate, SQUADRON_VERIFY_JOB: file }
  });
  onSpawn?.(child);
  let bound;
  let handshakeError;
  const timer = setTimeout(() => {
    handshakeError = new Error('verification publication deadline expired');
    if (child.connected) child.disconnect();
  }, 15000);
  child.on('message', (message) => {
    if (message?.phase !== 'ready' || bound || handshakeError) return;
    try {
      const ready = read(file + '.ready.json');
      const fresh = processes.snapshot();
      if (
        !exactJob(file, value) ||
        !authorityCurrent(value) ||
        !sameJob(ready, value) ||
        !processes.sameIdentity(ready.wrapper, processes.identity(child.pid, fresh))
      )
        throw new Error('verification publication identity or authority changed');
      bound = {
        ...reference(value),
        wrapper: ready.wrapper,
        members: processes.adopt(fresh, [ready.wrapper])
      };
      if (!bound.members) throw new Error('verification publication evidence is incomplete');
      groups.set(child.pid, ready.wrapper);
      fs.writeFileSync(file + '.bound.json', JSON.stringify(bound), { flag: 'wx', mode: 0o600 });
      onBound?.({ file, ...bound });
      if (!exactJob(file, value) || !authorityCurrent(value))
        throw new Error('verification launch authority changed');
      child.send({ phase: 'ack', ...reference(value) });
      clearTimeout(timer);
    } catch (error) {
      handshakeError = error;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
    }
  });
  let signal;
  let deadline;
  // An outer job must let a nested timed runner finish its own two-second reap.
  const grace = consoleSignals ? 2000 : 5000;
  const groups = new Map();
  const trackTimedGroup = () => {
    const holder = read(path.join(gate, 'holder'));
    if (
      holder?.gate === gate &&
      holder.parentJob?.file === file &&
      sameJob(holder.parentJob, value) &&
      processes.validIdentity(holder.job?.wrapper)
    )
      groups.set(holder.job.wrapper.pid, holder.job.wrapper);
  };
  const stop = (s, includeTimed = false) => {
    if (!child.pid) return;
    if (includeTimed) trackTimedGroup();
    const fresh = retainObservation(file, value, bound);
    if (!fresh.authorized) return;
    if (process.platform === 'win32') {
      if (!bound || !processes.sameIdentity(bound.wrapper, processes.identity(child.pid, fresh)))
        return;
      try {
        cp.execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } catch {
        /* already ended */
      }
      return;
    }
    for (const [pid, member] of includeTimed ? groups : [[child.pid, bound?.wrapper]]) {
      if (!processes.sameIdentity(member, processes.identity(pid, fresh))) continue;
      if (!fresh.witnessed?.some((known) => processes.sameIdentity(known, member))) continue;
      try {
        if (consoleSignals && !includeTimed && s !== 'SIGINT') child.kill(s);
        else process.kill(-pid, s);
      } catch {
        /* already ended */
      }
    }
    // A group leader can exit before escalation; retained descendants still have identities.
    if (includeTimed) {
      for (const member of [...(fresh.witnessed ?? [])].reverse()) processes.end(member, s);
    }
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => {
    const fn = () => {
      signal = s;
      trackTimedGroup();
      if (consoleSignals && process.platform === 'win32') {
        retainObservation(file, value, bound);
        return;
      }
      stop(s);
      deadline ??= setTimeout(() => stop('SIGKILL', true), grace);
    };
    process.on(s, fn);
    return [s, fn];
  });
  try {
    let code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (c, s) => resolve(c ?? 128 + (os.constants.signals[s] ?? 0)));
      child.once('close', (c, s) => resolve(c ?? 128 + (os.constants.signals[s] ?? 0)));
    });
    if (process.platform !== 'win32' && child.pid) {
      trackTimedGroup();
      const gone = async (ms) => {
        const end = perf.performance.now() + ms;
        for (;;) {
          const fresh = retainObservation(file, value, bound);
          if (
            fresh.complete &&
            fresh.witnessed.every(
              (member) => !processes.sameIdentity(member, processes.identity(member.pid, fresh))
            )
          )
            return true;
          if (perf.performance.now() >= end) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      if (!(await gone(signal ? grace + 100 : 100))) {
        code ||= 1;
        stop('SIGTERM', true);
        if (!(await gone(1000))) {
          stop('SIGKILL', true);
          if (!(await gone(1000))) throw new Error('verification process group is still alive');
        }
      }
    }
    const state = read(file + '.state.json');
    const fresh = processes.snapshot();
    const retained = retainedMembers(file, value, state);
    const members = retained && processes.adopt(fresh, retained);
    // The wrapper has exited and can no longer issue work. Its terminal
    // phase and a complete confirmation read are both required to close authority.
    const closed =
      !handshakeError &&
      bound &&
      exactJob(file, value) &&
      sameJob(state, value) &&
      ['finished', 'interrupted'].includes(state.phase) &&
      members &&
      members.every(
        (member) => !processes.sameIdentity(member, processes.identity(member.pid, fresh))
      );
    if (members) atomic(file + '.confirmed.json', { ...reference(value), members });
    if (closed)
      atomic(file + '.closed.json', { ...reference(value), state: digest(JSON.stringify(state)) });
    else code ||= 1;
    if (handshakeError) throw handshakeError;
    return { code, signal };
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
    for (const [s, fn] of handlers) process.removeListener(s, fn);
  }
}

export function reference(value) {
  return { version: 1, gate: value.gate, token: value.token, generation: value.generation };
}

function retainedMembers(file, value, state) {
  if (!sameJob(state, value) || !Array.isArray(state.members)) return undefined;
  const members = [...state.members];
  const prefix = path.basename(file) + '.cancel-';
  for (const name of fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(prefix))) {
    const observed = read(path.join(path.dirname(file), name));
    if (!sameJob(observed, value) || !Array.isArray(observed.members)) return undefined;
    members.push(...observed.members);
  }
  return members.every(processes.validIdentity)
    ? [
        ...new Map(
          members.map((member) => [
            JSON.stringify([member.pid, member.source, member.started]),
            member
          ])
        ).values()
      ]
    : undefined;
}

export function sameJob(record, value) {
  return (
    validReference(record) &&
    validReference(value) &&
    record.gate === value.gate &&
    record.token === value.token &&
    record.generation === value.generation
  );
}

export function validReference(value) {
  return (
    value?.version === 1 &&
    typeof value.gate === 'string' &&
    path.isAbsolute(value.gate) &&
    typeof value.token === 'string' &&
    /^[\da-f-]{36}$/.test(value.token) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0
  );
}

function exactJob(file, value) {
  return JSON.stringify(read(file)) === JSON.stringify(value);
}

function authorityCurrent(value) {
  const authority = value.authority;
  if (!authority) return true;
  const current = read(authority.file);
  return (
    sameJob(current, { ...authority, version: 1, gate: value.gate }) &&
    processes.validIdentity(current)
  );
}

function retainObservation(file, value, bound) {
  const state = read(file + '.state.json');
  const fresh = processes.snapshot();
  const retained = retainedMembers(file, value, state) ?? (!state ? bound?.members : undefined);
  const members = retained && processes.adopt(fresh, retained);
  atomic(file + `.cancel-${process.pid}.json`, {
    ...reference(value),
    members: members ?? null
  });
  if (!members || !exactJob(file, value)) return { complete: false, rows: [] };
  return { ...fresh, witnessed: members, authorized: authorityCurrent(value) };
}

export function context(stage = process.env.npm_lifecycle_event) {
  const value = read(process.env[CONTEXT]);
  if (
    !value ||
    value.schema !== SCHEMA ||
    value.stage !== stage ||
    value.workspace !== fs.realpathSync(process.cwd())
  )
    return undefined;
  const candidate = new Candidate(value.dir);
  if (value.gate !== gateRoot()) throw new Error('candidate context gate root mismatch');
  if (PACKAGE.digest !== candidate.manifest.package.digest)
    throw new Error('candidate runner version mismatch');
  const owner = read(path.join(candidate.dir, 'owner.json'));
  const table = processes.snapshot();
  if (
    owner?.token !== value.token ||
    owner.gate !== value.gate ||
    owner.generation !== value.ownerGeneration ||
    owner.version !== 1 ||
    !table.complete ||
    !processes.sameIdentity(owner, processes.identity(owner.pid, table))
  )
    throw new Error('candidate context has no live owner');
  candidate.token = value.token;
  candidate.ownerGeneration = value.ownerGeneration;
  candidate.ownerGate = value.gate;
  candidate.attempt = value.attempt;
  return candidate;
}

export function pruneRuns(root, remove) {
  return locked(root, () => {
    const dir = path.join(root, '.verification-pins');
    const pins = new Set(
      fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((f) => read(path.join(dir, f)) ?? []) : []
    );
    remove(pins);
  });
}

export function pruneCandidates(store, runs, now = Date.now()) {
  if (!fs.existsSync(store)) return;
  const candidates = fs
    .readdirSync(store)
    .filter((f) => /^[\da-f-]{36}$/.test(f))
    .flatMap((f) => {
      try {
        return [new Candidate(path.join(store, f))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.manifest.created - a.manifest.created);
  const evidence = candidates.map((c) => ({
    c,
    revision: ownershipRevision(c.dir),
    busy: c.busy()
  }));
  locked(runs, () => {
    let inactive = 0;
    for (const { c, revision, busy } of evidence) {
      if (busy || revision !== ownershipRevision(c.dir) || c.manifest.expired) continue;
      if (++inactive <= 2 && now - c.manifest.created < CANDIDATE_MAX_AGE_MS && !c.manifest.pruning)
        continue;
      c.manifest.pruning = true;
      c.save();
      try {
        fs.rmSync(c.workspace, { recursive: true, force: true });
        fs.rmSync(path.join(runs, '.verification-pins', c.manifest.id + '.json'), { force: true });
      } catch (error) {
        c.event({
          kind: 'artifacts',
          outcome: 'cleanup-failed',
          error: error.message,
          code: error.code
        });
        throw error;
      }
      c.manifest.expired = true;
      delete c.manifest.pruning;
      c.save();
      c.event({ kind: 'artifacts', outcome: 'expired' });
    }
  });
}

async function job(file) {
  const value = read(file);
  if (
    value?.version !== 1 ||
    !value.cwd ||
    !Array.isArray(value.args) ||
    !processes.validIdentity(value.owner) ||
    value.gate !== gateRoot() ||
    !process.connected ||
    typeof value.token !== 'string' ||
    value.generation !== 0
  )
    throw new Error('invalid verification job or missing publication channel');
  const table = processes.snapshot();
  const wrapper = processes.identity(process.pid, table);
  if (
    !processes.validIdentity(wrapper) ||
    !processes.sameIdentity(value.owner, processes.identity(process.ppid, table))
  )
    throw new Error('verification parent identity is unknown');
  const ready = { ...reference(value), wrapper };
  atomic(file + '.ready.json', ready);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error('verification acknowledgment deadline expired')),
      15000
    );
    const message = (ack) => {
      if (ack?.phase !== 'ack' || !sameJob(ack, value)) return;
      const bound = read(file + '.bound.json');
      if (
        !exactJob(file, value) ||
        !authorityCurrent(value) ||
        !sameJob(bound, value) ||
        !processes.sameIdentity(bound.wrapper, wrapper)
      )
        finish(new Error('verification acknowledgment authority changed'));
      else finish();
    };
    const disconnected = () =>
      finish(new Error('verification owner disconnected before acknowledgment'));
    function finish(error) {
      clearTimeout(timeout);
      process.removeListener('message', message);
      process.removeListener('disconnect', disconnected);
      if (error) reject(error);
      else resolve();
    }
    process.on('message', message);
    process.once('disconnect', disconnected);
    process.send({ phase: 'ready', ...reference(value) });
  });
  let members = read(file + '.bound.json').members;
  if (!Array.isArray(members) || !members.every(processes.validIdentity))
    throw new Error('verification bound membership is unknown');
  const save = (phase, table = processes.snapshot()) => {
    if (!exactJob(file, value)) throw new Error('verification reservation changed');
    members = processes.adopt(table, members);
    if (!members) throw new Error('verification membership evidence is incomplete');
    atomic(file + '.state.json', { ...reference(value), wrapper, phase, members });
    return table;
  };
  save('launching', table);
  if (!process.connected || !exactJob(file, value) || !authorityCurrent(value))
    throw new Error('verification launch authority changed');
  const invocation = program(value.command, value.args);
  const child = cp.spawn(invocation.command, invocation.args, {
    cwd: value.cwd,
    env: process.env,
    stdio: 'inherit',
    shell: value.shell
  });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (c, s) => resolve(c ?? 128 + (os.constants.signals[s] ?? 0)));
  });
  const launched = processes.snapshot();
  const commandIdentity = processes.identity(child.pid, launched);
  save('running', launched);
  let interrupted = false;
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => {
    const fn = () => {
      interrupted = true;
      let fresh;
      try {
        fresh = save('interrupted');
      } catch {
        /* unknown launch stays retained */
      }
      if (value.consoleSignals && (process.platform === 'win32' || s === 'SIGINT')) return;
      if (!fresh || !processes.sameIdentity(commandIdentity, processes.identity(child.pid, fresh)))
        return;
      try {
        child.kill(s);
      } catch {
        /* already exited */
      }
    };
    process.on(s, fn);
    return [s, fn];
  });
  try {
    process.exitCode = await result;
    save(interrupted ? 'interrupted' : 'finished');
    if (interrupted) process.exitCode ||= 1;
  } finally {
    for (const [s, fn] of handlers) process.removeListener(s, fn);
    if (process.connected) process.disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href &&
  process.argv[2] === '--job'
) {
  job(process.argv[3]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

let selfIdentity;
export function processIdentity(pid) {
  if (pid === process.pid && selfIdentity) return selfIdentity;
  const value = processes.identity(pid);
  const result = value
    ? { version: 1, ...value }
    : { version: 1, pid, source: 'unknown', started: null };
  if (pid === process.pid && processes.validIdentity(result)) selfIdentity = result;
  return result;
}
