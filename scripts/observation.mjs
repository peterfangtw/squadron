import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as checkpoints from './checkpoints.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const KEY = Symbol.for('squadron.runtimeObservation.v1');
const now = () => Number(process.hrtime.bigint()) / 1e6;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const noop = { id: null, end() {} };

export function mode() {
  return process.env.SQUADRON_RUN_OBSERVATION_MODE ?? 'spans';
}

export function configure(directory) {
  process.env.SQUADRON_RUN_OBSERVATION_DIR = path.resolve(
    process.env.SQUADRON_RUN_OBSERVATION_DIR ?? directory
  );
  return state()?.file ?? null;
}

function state() {
  if (mode() === 'off') return undefined;
  if (globalThis[KEY]) return globalThis[KEY];
  const dir = process.env.SQUADRON_RUN_OBSERVATION_DIR ?? process.env.SQUADRON_RUN;
  if (!dir) return undefined;
  process.env.SQUADRON_RUN_OBSERVATION_DIR = path.resolve(dir);
  const value = {
    id: crypto.randomUUID(),
    began: now(),
    queue: [],
    active: new Map(),
    context: new AsyncLocalStorage(),
    sequence: 0,
    invalid: false,
    warned: false,
    ended: false
  };
  value.file = path.join(path.resolve(dir), `observation-${process.pid}-${value.id}.jsonl`);
  globalThis[KEY] = value;
  push(value, {
    type: 'process-start',
    pid: process.pid,
    ppid: process.ppid,
    originNs: process.hrtime.bigint().toString(),
    at: new Date().toISOString(),
    mode: mode(),
    executable: process.execPath,
    entry: process.argv[1] ?? null,
    resourceCoverage: mode() === 'resources' ? 'registered Node processes only' : 'disabled'
  });
  flush();
  process.once('exit', (exit) => {
    value.ended = true;
    for (const span of value.active.values()) span.end('incomplete');
    const usage = mode() === 'resources' ? process.resourceUsage() : undefined;
    push(value, {
      type: 'process-end',
      exit,
      ms: now() - value.began,
      complete: !value.invalid,
      ...(usage && {
        resources: {
          scope: 'process',
          peakRssKiB: usage.maxRSS,
          userCpuMicros: usage.userCPUTime,
          systemCpuMicros: usage.systemCPUTime
        }
      })
    });
    flush();
  });
  return value;
}

function push(value, record) {
  value.queue.push({ schema: 1, process: value.id, ...record });
  if (value.queue.length >= 128) flush();
}

export function flush() {
  const value = globalThis[KEY];
  if (!value?.queue.length) return;
  const rows = value.queue.splice(0);
  try {
    fs.mkdirSync(path.dirname(value.file), { recursive: true });
    fs.appendFileSync(value.file, rows.map((row) => JSON.stringify(row) + '\n').join(''));
  } catch (error) {
    value.invalid = true;
    if (!value.warned) {
      value.warned = true;
      console.error(`observation: incomplete evidence (${error.message})`);
    }
  }
}

export function event(name, details = {}) {
  const value = state();
  if (value) push(value, { type: 'event', name, startMs: now() - value.began, details });
}

export function start(name, details = {}) {
  const value = state();
  if (!value || value.ended) return noop;
  if (value.active.size >= 1024) {
    value.invalid = true;
    event('overflow', { limit: 1024 });
    return noop;
  }
  const id = `${value.id}:${++value.sequence}`;
  const began = now();
  const parent = details.parent ?? value.context.getStore() ?? null;
  let ended = false;
  const span = {
    id,
    end(outcome, extra = {}) {
      if (ended) return;
      ended = true;
      value.active.delete(id);
      if (outcome === 'incomplete') value.invalid = true;
      push(value, {
        type: 'span',
        id,
        name,
        parent,
        startMs: began - value.began,
        ms: now() - began,
        outcome,
        details: { ...details, ...extra }
      });
    }
  };
  value.active.set(id, span);
  return span;
}

export function failActive() {
  const value = globalThis[KEY];
  if (value) for (const span of value.active.values()) span.end('failed');
}

export function measure(name, work, details = {}) {
  const span = start(name, details);
  try {
    const value = state();
    const result = value ? value.context.run(span.id, work) : work();
    if (result && typeof result.then === 'function')
      return result.then(
        (value) => {
          span.end('passed');
          return value;
        },
        (error) => {
          span.end('failed');
          throw error;
        }
      );
    span.end('passed');
    return result;
  } catch (error) {
    span.end('failed');
    throw error;
  }
}

export function write(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    return true;
  } catch (error) {
    console.error(`observation: could not write ${file} (${error.message})`);
    return false;
  }
}

let cachedNpmVersion;
function npmVersion() {
  if (cachedNpmVersion !== undefined) return cachedNpmVersion;
  try {
    const npm = checkpoints.program('npm', ['--version']);
    cachedNpmVersion =
      cp
        .execFileSync(npm.command, npm.args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10000
        })
        .trim() || null;
  } catch {
    cachedNpmVersion = null;
  }
  return cachedNpmVersion;
}

export function identity(root = process.cwd(), archive = null) {
  let source = null;
  if (archive) {
    try {
      source = {
        kind: 'archive',
        expected: archive,
        tree: checkpoints.treeDigest(root, checkpoints.SOURCE_EXCLUDES)
      };
    } catch {
      /* Unknown archive bytes cannot establish stability. */
    }
  } else {
    try {
      const git = (args) =>
        cp.execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 32 * 1024 * 1024
        });
      const sha = git(['rev-parse', 'HEAD']).trim();
      const diff = git(['diff', '--binary', 'HEAD']);
      const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
        .sort();
      const digest = crypto.createHash('sha256').update(diff);
      for (const name of untracked) {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        digest.update(JSON.stringify([name, stat.mode])).update('\0');
        digest.update(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file));
      }
      source = {
        kind: 'checkout',
        sha,
        dirty: Boolean(diff || untracked.length),
        content: digest.digest('hex')
      };
    } catch {
      /* Missing source identity makes automatic comparison unavailable. */
    }
  }
  let lock = null;
  try {
    lock = hash(fs.readFileSync(path.join(root, 'package-lock.json')));
  } catch {
    /* Unknown toolchain. */
  }
  return {
    source,
    environment: {
      node: process.version,
      npmVersion: npmVersion(),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? null,
      cores: os.availableParallelism(),
      memoryBytes: os.totalmem(),
      lock,
      nodeOptions: process.env.NODE_OPTIONS ?? '',
      smokeSlow: process.env.SQUADRON_SMOKE_SLOW ?? null,
      ide: process.env.SQUADRON_IDE ?? null
    },
    mode: mode(),
    load: os.loadavg(),
    cache: process.env.SQUADRON_RUN_OBSERVATION_CACHE ?? 'unknown'
  };
}

if (mode() === 'resources') state();

export function prune(root) {
  // The holder's job records are what prove its run over; without them the
  // gate cannot tell a dead run from a live one, and keeps the slot forever.
  const holder = checkpoints.read(path.join(checkpoints.gateRoot(), 'holder'));
  const held = typeof holder?.job?.file === 'string' ? path.dirname(holder.job.file) : undefined;
  checkpoints.pruneRuns(root, (pins) => {
    const folders = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T[\w.-]+-\d+$/.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        touched: fs.statSync(path.join(root, entry.name)).mtimeMs
      }))
      .sort((a, b) => b.touched - a.touched || b.name.localeCompare(a.name))
      .map(({ name }) => name);
    for (const folder of folders.slice(20)) {
      if (pins.has(path.join(root, folder)) || path.join(root, folder) === held) continue;
      const pid = Number(folder.split('-').at(-1));
      try {
        process.kill(pid, 0);
        continue;
      } catch {
        /* finished run */
      }
      fs.rmSync(path.join(root, folder), { recursive: true, force: true });
    }
  });
}

export function createRun(label) {
  let root = process.env.SQUADRON_RUNS_DIR;
  if (!root) {
    try {
      root = path.join(
        cp
          .execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          })
          .trim(),
        'squadron-runs'
      );
    } catch {
      root = path.join(os.tmpdir(), 'squadron-observations');
    }
  }
  root = path.resolve(root);
  if (process.env.SQUADRON_RUNS_DIR) process.env.SQUADRON_RUNS_DIR = root;
  const dir = path.join(
    root,
    `${new Date().toISOString().replaceAll(':', '-')}-${label}-${process.pid}`
  );
  try {
    const created = fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, '.squadron-runs');
    if (created) fs.writeFileSync(marker, 'observation.mjs\n');
    fs.mkdirSync(dir);
    if (!process.env.SQUADRON_RUNS_DIR || fs.existsSync(marker)) prune(root);
  } catch (error) {
    console.error(`observation: retention unavailable (${error.message})`);
  }
  return dir;
}
