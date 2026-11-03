#!/usr/bin/env node
/**
 * Runs a script's steps in order and appends how long each took to one log
 * shared by every worktree of this repository:
 * `$(git rev-parse --git-common-dir)/squadron-timings.jsonl`.
 *
 * Usage, from a `package.json` script:
 *   node scripts/timed.mjs compile='npm run compile' test='node --test out/test/*.test.js'
 *
 * Each `name=command` is one step, run through the shell and stopped at the
 * first failure. Anything after the last step is what `npm run x -- …`
 * appended, and is handed to the last step: `test:smoke:one -- <file>`.
 *
 * The log is a measurement, never a gate. Outside a git checkout — `release`
 * runs `check` and smoke in a `git archive` extract — the steps still run and
 * no timings line is written; output still goes to a temporary run folder.
 *
 * From the first step named `compile` to the last, a run holds the gate: one
 * slot per user on this machine, shared by every clone, worktree and release
 * archive, in `~/.squadron/tooling/gate` under the account's real home, which a
 * moved `HOME` or `TMPDIR` cannot redirect (`SQUADRON_GATE_DIR` overrides it).
 * Each test step forks a worker per core, so two at once overload the machine,
 * and a compile in one checkout rewrites the `out/` another's tests are reading.
 * A run that finds the slot taken waits in line, first come first served, and
 * gives up with exit 75 after 45 minutes (`SQUADRON_GATE_TIMEOUT_MS`). Steps
 * before `compile` — format, lint — run outside it. A run whose steps passed
 * but that could not release the slot exits 74 and names the holder to remove.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as checkpoints from './checkpoints.mjs';
import * as processes from './verification_processes.mjs';
import * as perf from 'node:perf_hooks';
import * as observation from './observation.mjs';

const STEP = /^([a-z][\w:-]*)=(.*)$/s;

const args = process.argv.slice(2);
const boundary = args.indexOf('--');
const last = boundary === -1 ? args.findLastIndex((arg) => STEP.test(arg)) : boundary - 1;
const extra = args.slice(boundary === -1 ? last + 1 : boundary + 1);
const steps = args.slice(0, last + 1).map((arg, at) => {
  const [, name = '', command = ''] = STEP.exec(arg) ?? [];
  if (command.startsWith('[')) {
    const words = JSON.parse(command);
    if (
      !Array.isArray(words) ||
      words.length === 0 ||
      words.some((word) => typeof word !== 'string')
    )
      throw new Error('a structured step needs a nonempty argv array');
    return { name, command: at === last ? [...words, ...extra] : words };
  }
  return { name, command: at === last ? [command, ...extra.map(shellWord)].join(' ') : command };
});
// Resolve before admission: a missing tool must not leave a protected holder.
const invocations = steps.map((step) =>
  Array.isArray(step.command)
    ? checkpoints.program(step.command[0], step.command.slice(1))
    : { command: step.command, args: [] }
);

const repo = checkout();
const verification = checkpoints.context();
const start = Date.now();
const monoStart = perf.performance.now();
const script = process.env.npm_lifecycle_event ?? 'run';
// Observed on macOS: ps reports this title, including the actual npm entry point.
process.title = `node scripts/timed.mjs ${script}`;
const root = path.resolve(
  process.env.SQUADRON_RUNS_DIR ??
    repo?.runs ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-runs-'))
);
if (process.env.SQUADRON_RUNS_DIR) process.env.SQUADRON_RUNS_DIR = root;
const created = fs.mkdirSync(root, { recursive: true });
const marker = path.join(root, '.squadron-runs');
if (created) fs.writeFileSync(marker, 'timed.mjs\n');
const run = path.join(
  root,
  `${new Date(start).toISOString().replaceAll(':', '-')}-${script.replace(/[^\w-]/g, '-')}-${process.pid}`
);
fs.mkdirSync(run);
verification?.pin(run);
const observationFile = observation.configure(run);
const runIdentity = observation.identity(process.cwd(), verification?.manifest.source ?? null);
observation.event('run', { folder: run, ...runIdentity });
try {
  if (!process.env.SQUADRON_RUNS_DIR || fs.existsSync(marker)) observation.prune(root);
} catch (error) {
  console.error(`timed: could not prune ${root}: ${error.message}`);
}
const alongsideStart = alongside();
let redLog = '';
const loadStart = os.loadavg()[0];
const ran = [];
let exit = 0;
let running;
let stopped;
let gateDir;
let gateError;
try {
  gateDir = checkpoints.gateRoot();
} catch (error) {
  gateError = error;
}
const gateFrom = steps.findIndex((step) => step.name === 'compile');
// 'held', 'nested' (an ancestor holds it) or 'open' (no gate to be had).
let gate;
let gaveUp = false;
let waitedMs = 0;
let wake;
let self;
// A signal ends the run, not the log: it is passed to the step in flight, and
// the line is still written. Ctrl-C reaches the step too, being sent to the
// whole foreground group; a timeout's SIGTERM may reach only this process.
// win32's Ctrl-Break is SIGBREAK, whose default ends every process on the
// console at once, so it takes Ctrl-C's path: nothing is forwarded there.
for (const signal of [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  ...(process.platform === 'win32' ? ['SIGBREAK'] : [])
]) {
  process.on(signal, () => {
    stopped = signal;
    wake?.();
    if (running && gate !== 'held' && gate !== 'nested') stop(running, signal);
  });
}
// Ctrl-Z reaches the terminal's group, which a held step has left: suspend it
// with this process, and resume it with this process, or it runs on unread.
// SIGSTOP, because `detached` is `setsid`: the step's group is orphaned, and
// the kernel discards SIGTSTP sent to one.
process.on('SIGTSTP', () => {
  if (running && gate === 'held') signalGroup(running, 'SIGSTOP');
  process.kill(process.pid, 'SIGSTOP');
});
process.on('SIGCONT', () => {
  if (running && gate === 'held') signalGroup(running, 'SIGCONT');
});
for (const [at, step] of steps.entries()) {
  if (at === gateFrom) {
    const asked = perf.performance.now();
    const queue = observation.start('queue:internal');
    const entered = await enterGate();
    queue.end(entered === 'stopped' ? 'cancelled' : entered === 'timeout' ? 'failed' : 'passed', {
      admission: entered
    });
    waitedMs = perf.performance.now() - asked;
    if (entered === 'timeout' || entered === 'unavailable') {
      gaveUp = true;
      exit = 75;
      break;
    }
    if (entered === 'stopped') break;
    gate = entered;
  }
  const key = step.name === 'compile' ? 'compile' : `${script}:${step.name}`;
  const inputs = { command: step.command };
  const previous =
    verification && (step.name !== 'compile' || verification.outputsMatch())
      ? verification.reuse(key, inputs)
      : undefined;
  if (previous) {
    ran.push({
      name: step.name,
      ms: 0,
      exit: 0,
      outcome: 'reused',
      originalAttempt: previous.attempt,
      originalMs: previous.ms
    });
    observation.event('step:' + step.name, {
      outcome: 'reused',
      originalAttempt: previous.attempt,
      originalMs: previous.ms
    });
    console.error(`timed: reused ${step.name} from ${previous.attempt}`);
    continue;
  }
  if (verification && step.name === 'compile') verification.rebuild();
  record({ name: step.name, outcome: 'started' });
  const held = gate === 'held';
  const began = perf.performance.now();
  const phase = observation.start('step:' + step.name);
  const file = path.join(run, `${step.name}.log`);
  const output = fs.createWriteStream(file);
  output.on('error', (error) => console.error(`timed: could not write ${file}: ${error.message}`));
  const invocation = invocations[at];
  const options = {
    shell: !Array.isArray(step.command),
    // Its own process group, so the slot can outlive this process for as long
    // as the step's npm, tsc and test workers do. A group off the terminal must
    // not read it, or SIGTTIN stops it. Not on win32: there it is a console
    // rather than a group, and `kill(-pid)` answers ESRCH, so Ctrl-C could not
    // reach the step.
    detached: held && process.platform !== 'win32',
    stdio: [held ? 'ignore' : 'inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SQUADRON_RUN: run,
      ...(process.stdout.isTTY && { FORCE_COLOR: '1' }),
      ...(held && {
        SQUADRON_GATE_HOLDER: String(process.pid),
        SQUADRON_GATE_DIR: gateDir,
        SQUADRON_GATE_TOKEN: me().token,
        SQUADRON_GATE_GENERATION: String(me().generation)
      })
    }
  };
  let completion;
  const connectOutput = (child) => {
    running = child;
    for (const [source, terminal] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      source.setEncoding('utf8');
      source.on('data', (chunk) => {
        terminal.write(chunk);
        output.write(chunk);
      });
    }
  };
  if (held || gate === 'nested') {
    const holder = readRecord(path.join(gateDir, 'holder'));
    completion = checkpoints
      .runOwned({
        runner: path.resolve(import.meta.dirname, 'checkpoints.mjs'),
        file: path.join(run, `job-${crypto.randomUUID()}.json`),
        command: invocation.command,
        args: invocation.args,
        cwd: process.cwd(),
        env: options.env,
        shell: options.shell,
        detached: options.detached,
        stdio: options.stdio,
        consoleSignals: true,
        authority: {
          file: path.join(gateDir, 'holder'),
          token: holder?.token,
          generation: holder?.generation
        },
        onReserved: held ? holdGate : undefined,
        onSpawn: connectOutput,
        onBound: held ? holdGate : undefined
      })
      .then(
        (result) => result.code,
        (error) => {
          console.error(`timed: could not start ${step.name}: ${error.message}`);
          return 127;
        }
      );
  } else {
    connectOutput(spawn(invocation.command, invocation.args, options));
    completion = new Promise((resolve) => {
      running.on('error', (error) => {
        console.error(`timed: could not start ${step.name}: ${error.message}`);
        resolve(127);
      });
      running.on('close', (code, signal) => resolve(code ?? 128 + os.constants.signals[signal]));
    });
  }
  exit = await completion;
  await new Promise((resolve) => {
    if (output.destroyed) resolve();
    else {
      output.once('error', resolve);
      output.end(resolve);
    }
  });
  try {
    fs.writeFileSync(file, stripVTControlCharacters(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    console.error(`timed: could not finish ${file}: ${error.message}`);
  }
  running = undefined;
  const elapsed = perf.performance.now() - began;
  const outcome = stopped ? 'interrupted' : exit ? 'failed' : 'passed';
  phase.end(stopped ? 'cancelled' : exit ? 'failed' : 'passed', { exit });
  ran.push({ name: step.name, ms: elapsed, exit, outcome });
  record({ name: step.name, ms: elapsed, exit, outcome });
  if (verification) {
    if (!exit && !stopped) {
      if (step.name === 'compile') verification.built();
      verification.checkpoint(key, inputs, elapsed);
    } else verification.event({ kind: 'checkpoint', key, ms: elapsed, outcome });
  }
  if (exit !== 0 || stopped) {
    redLog = file;
    break;
  }
}
// The signal, not the step's own answer to it: `node --test` catches SIGINT and
// SIGTERM and exits 1, which would log an interrupted run as a red one.
if (stopped) exit = 128 + os.constants.signals[stopped];
const release = gate === 'held' ? leaveGate() : undefined;
// A slot left held stalls every later run, so a run that kept it is not green;
// a step's own failure keeps its code. 74, not 75: this run did its work.
if (release?.outcome === 'failed') {
  console.error(
    `timed: the gate slot was not released: ${release.holder} still names this run (pid ${process.pid}): ${release.error}`
  );
  console.error(
    process.platform === 'win32'
      ? '  No later run is admitted while it stays. Once no process this run started is left, remove that file by hand.'
      : '  Later runs take it over once this process has exited; if one does not, remove that file by hand.'
  );
  observation.event('gate:release', release);
  if (!exit) exit = 74;
}

let red = '';
try {
  if (redLog) red = fs.readFileSync(redLog, 'utf8');
} catch {
  /* log unavailable */
}
const failed = failureNames(red);
if (exit !== 0) {
  const what = gaveUp
    ? 'gate'
    : exit === 74 && release?.outcome === 'failed'
      ? 'gate release'
      : (ran.at(-1)?.name ?? 'run');
  console.error(`\ntimed: ${what} failed (exit ${exit})`);
  console.error(`  run: ${run}`);
  if (redLog) console.error(`  log: ${redLog}`);
  for (const folder of new Set(
    [...red.matchAll(/^\s*evidence: (.+)$/gm)].map((match) => match[1].trim().replace(/ \{$/, ''))
  )) {
    console.error(`  evidence: ${folder}`);
  }
} else console.error(`timed: run: ${run}`);
const alongsideEnd = alongside();
if (repo || process.env.SQUADRON_TIMINGS_FILE) {
  const line = {
    at: new Date(start).toISOString(),
    script: process.env.npm_lifecycle_event ?? null,
    branch: repo?.branch ?? verification?.manifest.branch ?? null,
    sha: repo?.sha ?? verification?.manifest.parent ?? null,
    worktree: repo?.worktree ?? process.cwd(),
    ...(verification && { candidate: verification.manifest.id, attempt: verification.attempt }),
    ms: perf.performance.now() - monoStart,
    exit,
    steps: ran,
    plannedSteps: steps.map(({ name }) => name),
    notRun: steps
      .filter((step) => !ran.some((done) => done.name === step.name))
      .map(({ name }) => name),
    run,
    failed,
    alongside: { start: alongsideStart, end: alongsideEnd },
    // 1-minute load average on either side of the run, and what it is out of.
    load: [loadStart, os.loadavg()[0]].map((n) => Math.round(n * 100) / 100),
    cores: os.availableParallelism(),
    ...(gateFrom >= 0 && { waitedMs }),
    ...(process.env.SQUADRON_SMOKE_SLOW && { smokeSlow: process.env.SQUADRON_SMOKE_SLOW })
  };
  try {
    fs.appendFileSync(process.env.SQUADRON_TIMINGS_FILE ?? repo.log, `${JSON.stringify(line)}\n`);
  } catch (error) {
    console.error(
      `timed: could not write ${process.env.SQUADRON_TIMINGS_FILE ?? repo?.log}: ${error.message}`
    );
  }
}
const finalIdentity = observation.identity(process.cwd(), verification?.manifest.source ?? null);
const runSummary = {
  schema: 1,
  kind: 'timed',
  observationFile,
  identity: runIdentity,
  sourceStable:
    Boolean(runIdentity.source && finalIdentity.source) &&
    JSON.stringify(runIdentity.source) === JSON.stringify(finalIdentity.source),
  command: steps,
  steps: ran,
  queueMs: waitedMs,
  gate: gate ?? 'none',
  ...(release?.outcome === 'failed' && { gateRelease: release }),
  ms: perf.performance.now() - monoStart,
  exit,
  outcome: stopped ? 'cancelled' : exit ? 'failed' : 'passed',
  scope:
    checkpoints.read(path.join(run, 'selection.json')) ??
    checkpoints.read(path.join(run, 'smoke-scope.json')) ??
    null,
  parent: process.env.SQUADRON_RUN_OBSERVATION_PARENT ?? null
};
observation.write(path.join(run, 'runtime.json'), runSummary);
observation.event('run:complete', { folder: run, ...runSummary });
observation.flush();
process.exitCode = exit;

/** This checkout's branch, HEAD and log path; undefined outside a git checkout. */
function checkout() {
  try {
    const [common = '', worktree = '', sha = '', branch = ''] = execFileSync(
      'git',
      ['rev-parse', '--git-common-dir', '--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .trim()
      .split('\n');
    return {
      // `HEAD` on a detached HEAD, which `sha` still pins.
      branch: branch === 'HEAD' ? null : branch,
      sha,
      // git spells it `C:/…` on win32; every other path here is native.
      worktree: path.resolve(worktree),
      log: path.join(path.resolve(common), 'squadron-timings.jsonl'),
      runs: path.join(path.resolve(common), 'squadron-runs')
    };
  } catch {
    return undefined;
  }
}

/** Only node's final failure block: earlier spec rows include failed parents. */
function failureNames(log) {
  const block = log.split(/(?:✖ failing tests:|Failed tests:)/).at(1) ?? '';
  return [...block.matchAll(/^\s*✖ (.+) \(\d+(?:\.\d+)?ms\)$/gm)]
    .map((match) => match[1])
    .slice(0, 20);
}

/** Other runners still alive at this edge, with their working directory. */
function alongside() {
  try {
    const runners = execFileSync('ps', ['-Ao', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    })
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(?:\S*node)\s+\S*timed\.mjs\s+(.*)$/.exec(line);
        if (!match || Number(match[1]) === process.pid) return [];
        const command = match[2].trim();
        return [
          {
            pid: Number(match[1]),
            script: command.includes('format=')
              ? 'check'
              : command.includes('smoke=')
                ? 'test:smoke'
                : command.includes('test=')
                  ? 'test'
                  : command
          }
        ];
      });
    const cwds = runners.length > 0 ? nodeCwds() : new Map();
    return runners.map((runner) => ({ ...runner, worktree: cwds.get(runner.pid) ?? null }));
  } catch {
    return [];
  }
}

/**
 * Every node process's working directory by pid, from one `lsof`: one per
 * runner made each edge cost up to a second a runner under load. By command
 * name, not `-p`: lsof 4.91 given a `-p` list with one exited pid prints
 * nothing for the rest.
 */
function nodeCwds() {
  const { stdout } = spawnSync('lsof', ['-c', '/^node/', '-a', '-d', 'cwd', '-Fpn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1000
  });
  const cwds = new Map();
  let pid;
  for (const row of (stdout ?? '').split('\n')) {
    if (row.startsWith('p')) pid = Number(row.slice(1));
    else if (row.startsWith('n') && pid !== undefined) cwds.set(pid, row.slice(1));
  }
  return cwds;
}

/**
 * A held step is off the terminal's process group, so Ctrl-C no longer reaches
 * it there: SIGINT goes to its group, as the terminal would have sent it. Any
 * other signal goes to the step alone, as before — smoke's runner shuts its
 * own children down in order, and a group signal would race it.
 */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * win32 delivers only a console's Ctrl-C or close here, and to every process
 * on that console, the step included; `kill` there is TerminateProcess, which
 * would end smoke's supervisor before it reaps its IDE. The step stops itself.
 */
function stop(child, signal) {
  if (process.platform === 'win32') return;
  try {
    if (gate === 'held' && signal === 'SIGINT') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

/**
 * Waits for the slot. Tickets (`<epoch ms>-<pid>`) set the order; the one
 * `holder` file is what admits a run, and it is only read-then-written under
 * `withLock`. Order alone is not exclusion: a run that took its timestamp and
 * paused before writing its ticket can find itself oldest after a later run has
 * started, and a dead holder seen outside the lock may be a live one by the
 * time it is replaced.
 */
async function enterGate() {
  const asked = Date.now();
  let ticket;
  let watcher;
  try {
    if (gateError) throw gateError;
    me();
    const holder = path.join(gateDir, 'holder');
    fs.mkdirSync(gateDir, { recursive: true });
    const outer = Number(process.env.SQUADRON_GATE_HOLDER);
    const current = readRecord(holder);
    if (
      outer &&
      current?.pid === outer &&
      current.version === 1 &&
      processes.validIdentity(current) &&
      typeof current.token === 'string' &&
      current.token.length > 0 &&
      Number.isSafeInteger(current.generation) &&
      current.generation >= 0 &&
      current.token === process.env.SQUADRON_GATE_TOKEN &&
      String(current.generation) === process.env.SQUADRON_GATE_GENERATION &&
      current.gate === gateDir &&
      live(current) &&
      (process.platform !== 'win32' || alive(outer))
    )
      return 'nested';
    const name = `${String(Date.now()).padStart(15, '0')}-${process.pid}`;
    ticket = path.join(gateDir, name);
    writeAtomic(ticket, me());
    const deadline = Date.now() + (Number(process.env.SQUADRON_GATE_TIMEOUT_MS) || 45 * 60_000);
    try {
      // Only for the holder or a ticket: a waiter woken by the lock and scratch
      // files its own claim makes would claim again at once, without napping,
      // and keep the lock busy for the run trying to leave. An unnamed event
      // could be either, so it waits for the two-second nap.
      watcher = fs.watch(gateDir, (_, name) => {
        if (name && (String(name) === 'holder' || /^\d{15}-\d+$/.test(String(name)))) wake?.();
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      /* the re-check below still finds every change */
    }
    let reported;
    while (!stopped) {
      const ahead = ticketsAhead(name);
      const now = ahead.length === 0 ? claim(holder) : readRecord(holder);
      if (now === true) {
        if (reported) console.error(`timed: gate open after ${since(Date.now() - asked)}`);
        return 'held';
      }
      if (now && live(now)) ahead.unshift(now);
      if (ahead.length === 0) continue;
      if (Date.now() >= deadline) {
        console.error(
          `timed: gave up waiting for the gate after ${since(Date.now() - asked)}, behind ${describe(ahead[0])}`
        );
        return 'timeout';
      }
      const key = `${ahead.length} ${ahead[0].pid}`;
      if (key !== reported) {
        observation.event('queue:internal:blocker', { holder: ahead[0], ahead: ahead.length });
        reported = key;
        console.error(`timed: waiting for the gate: ${ahead.length} ahead — ${describe(ahead[0])}`);
      }
      await nap(Math.min(2000, deadline - Date.now()));
    }
    return 'stopped';
  } catch (error) {
    console.error(`timed: gate unavailable (${error.message}); refusing protected work`);
    return 'unavailable';
  } finally {
    wake = undefined;
    watcher?.close();
    if (ticket) fs.rmSync(ticket, { force: true });
  }
}

/** Live tickets older than `name`, oldest first; dead ones are removed. */
function ticketsAhead(name) {
  return fs
    .readdirSync(gateDir)
    .filter((entry) => /^\d{15}-\d+$/.test(entry) && entry < name)
    .sort()
    .flatMap((entry) => {
      const file = path.join(gateDir, entry);
      const record = readRecord(file) ?? { pid: Number(entry.split('-')[1]) };
      if (live(record)) return [record];
      fs.rmSync(file, { force: true });
      return [];
    });
}

/** Takes the slot unless a live run holds it: true, or that run's record. */
function claim(holder) {
  const observed = readRecord(holder);
  const busy = observed && live(observed);
  return withLock(() => {
    const now = readRecord(holder);
    if (JSON.stringify(now) !== JSON.stringify(observed)) return { ...now, protected: true };
    if (process.platform === 'win32' && fs.existsSync(holder)) {
      if (!now || !Number.isSafeInteger(now.pid) || now.pid <= 0)
        throw new Error('gate holder ownership is unknown');
      return { ...now, protected: true };
    }
    if (busy) return now;
    writeAtomic(holder, { ...me(), ...(process.platform === 'win32' && { protected: true }) });
    return true;
  });
}

function withLock(action) {
  const lock = path.join(gateDir, '.lock');
  const token = crypto.randomUUID();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      // win32 refuses to make a directory another run has just removed until
      // its last handle closes, with EPERM: still taken, not a fault. A leave
      // that threw there kept a protected holder no later run may remove.
      const pending = process.platform === 'win32' && error.code === 'EPERM';
      if (error.code !== 'EEXIST' && !pending) throw error;
      if (Date.now() >= deadline)
        throw new Error(`gate lock ownership could not be established (${error.code})`);
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  const lockOwner = JSON.stringify({ ...me(), token, generation: 0 });
  fs.writeFileSync(path.join(lock, 'owner'), lockOwner);
  try {
    return action();
  } finally {
    try {
      if (fs.readFileSync(path.join(lock, 'owner'), 'utf8') === lockOwner) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    } catch {
      /* not ours to remove, or already gone */
    }
  }
}

/** Names the step's process group in `holder`, so the slot lasts as long as it does. */
function holdGate(job) {
  return withLock(() => {
    const holder = path.join(gateDir, 'holder');
    const current = readRecord(holder);
    if (!ownsHolder(current)) throw new Error('gate launch authority changed');
    writeAtomic(holder, {
      ...current,
      job,
      ...(job.wrapper && {
        pgid: process.platform === 'win32' ? undefined : job.wrapper.pid,
        groupStarted: job.wrapper.started,
        workerPid: job.wrapper.pid
      })
    });
  });
}

/**
 * A step signalled alone can die and leave its children running; while its
 * group lives the holder stays, naming it, and the next run waits it out.
 */
function leaveGate() {
  const holder = path.join(gateDir, 'holder');
  try {
    const observed = readRecord(holder);
    if (observed?.job && checkpoints.workBusy(undefined, run))
      return { outcome: 'retained', holder };
    return withLock(() => {
      let text;
      try {
        text = checkpoints.retryFileOperation(() => fs.readFileSync(holder, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return { outcome: 'released', holder };
        throw error;
      }
      // Unreadable is not someone else's: that would keep ours without a word.
      const record = JSON.parse(text);
      if (!ownsHolder(record)) return { outcome: 'retained', holder };
      if (JSON.stringify(record) !== JSON.stringify(observed))
        return { outcome: 'retained', holder };
      if (process.platform !== 'win32' && record.pgid && alive(-record.pgid)) {
        console.error(`timed: the step's processes are still running; the gate stays theirs`);
        return { outcome: 'retained', holder };
      }
      checkpoints.retryFileOperation(() => fs.rmSync(holder, { force: true }));
      return { outcome: 'released', holder };
    });
  } catch (error) {
    console.error(`timed: could not leave the gate: ${error.message}`);
    return { outcome: 'failed', holder, error: error.message };
  }
}

function ownsHolder(record) {
  return checkpoints.sameJob(record, me());
}

function me() {
  const native = self ? undefined : checkpoints.processIdentity(process.pid);
  if (!self && !processes.validIdentity(native)) throw new Error('gate native identity is unknown');
  self ??= {
    ...native,
    script,
    worktree: repo?.worktree ?? process.cwd(),
    at: start,
    gate: gateDir,
    token: crypto.randomUUID(),
    generation: 0
  };
  if (process.env.SQUADRON_VERIFY_JOB && !self.parentJob) {
    const file = process.env.SQUADRON_VERIFY_JOB;
    const value = readRecord(file);
    if (value?.version === 1 && value.gate === gateDir)
      self.parentJob = {
        file,
        ...checkpoints.reference(value)
      };
  }
  return self;
}

/**
 * The runner, by pid and start time so a reused pid does not count, or its
 * step's group. A start time `ps` could not give is unknown, not different.
 */
function live(record) {
  if (
    !checkpoints.validReference(record) ||
    record.gate !== gateDir ||
    !processes.validIdentity(record)
  )
    return true;
  if (
    record.job &&
    (!fs.existsSync(record.job.file) ||
      checkpoints.workBusy(undefined, path.dirname(record.job.file)))
  )
    return true;
  // Until Windows descendant witnesses land, a lost coordinator cannot prove
  // its workers exited. Normal completion removes its own holder explicitly.
  if (process.platform === 'win32' && record.protected) return true;
  if (record.version === 1) {
    if (!processes.validIdentity(record)) return true;
    const table = processes.snapshot();
    return !table.complete || processes.sameIdentity(record, processes.identity(record.pid, table));
  }
  return true;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeAtomic(file, record) {
  const scratch = path.join(gateDir, `.write-${process.pid}`);
  try {
    fs.writeFileSync(scratch, JSON.stringify(record));
    checkpoints.retryFileOperation(() => fs.renameSync(scratch, file));
  } catch (error) {
    // A write that failed part way leaves the scratch file too.
    try {
      checkpoints.retryFileOperation(() => fs.rmSync(scratch, { force: true }));
    } catch (cleanup) {
      console.error(`timed: could not remove ${scratch}: ${cleanup.message}`);
    }
    throw error;
  }
}

function nap(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    }
    wake = done;
  });
}

function describe(record) {
  const running = record.at ? `, running ${since(Date.now() - record.at)}` : '';
  return `${record.script ?? 'a run'} (pid ${record.pid}${record.worktree ? `, ${record.worktree}` : ''}${running})`;
}

function since(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * One argument for the shell `spawn(…, { shell: true })` runs: sh on POSIX,
 * cmd.exe on win32. cmd groups on `"` alone and reads a backslash before the
 * closing quote as escaping it; `%VAR%` stays live inside the quotes, and an
 * embedded `"` flips cmd's own quoting, so what `npm run x --` appends there
 * should be flags and paths, not text with quotes in it.
 */
function shellWord(arg) {
  if (process.platform !== 'win32') return `'${arg.replaceAll("'", `'\\''`)}'`;
  if (/["%\r\n!&|<>^]/.test(arg))
    throw new Error('forward arbitrary argv with a structured step, not shell text');
  return `"${arg.replaceAll('"', '\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function record(value) {
  try {
    checkpoints.append(path.join(run, 'events.jsonl'), { at: new Date().toISOString(), ...value });
  } catch (error) {
    console.error(`timed: could not record event: ${error.message}`);
  }
}
