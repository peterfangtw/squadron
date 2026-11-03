#!/usr/bin/env node
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as observation from './observation.mjs';

const SELF = fileURLToPath(import.meta.url);
const ns = () => process.hrtime.bigint().toString();

async function execute(command, args, env, grouped = false, ready = () => {}, relay = true) {
  const child = cp.spawn(command, args, { env, stdio: 'inherit', detached: grouped });
  let stopped;
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
    const handler = () => {
      stopped ??= signal;
      if (!relay) return;
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  const completion = new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`observe: ${error.message}`);
      resolve({ exit: 127, signal: null });
    });
    child.once('close', (code, signal) =>
      resolve({
        exit: stopped
          ? 128 + os.constants.signals[stopped]
          : (code ?? 128 + (os.constants.signals[signal] ?? 0)),
        signal: stopped ?? signal ?? null
      })
    );
  });
  ready();
  const result = await completion;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--admitted') {
    const recipe = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    observation.write(path.join(recipe.dir, 'admission.json'), {
      requestedNs: recipe.requestedNs,
      admittedNs: ns(),
      pid: process.pid,
      heavy: recipe.heavy
    });
    observation.configure(recipe.dir);
    const body = observation.start('command:body');
    const result = await execute(
      recipe.command[0],
      recipe.command.slice(1),
      {
        ...process.env,
        ...(recipe.heavy ? { SQUADRON_RUN_OBSERVATION_HEAVY: '1' } : {})
      },
      false,
      () => {},
      !recipe.grouped
    );
    body.end(result.signal ? 'cancelled' : result.exit ? 'failed' : 'passed', result);
    observation.flush();
    process.exitCode = result.exit;
    return;
  }
  const separator = args.indexOf('--');
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (
    separator < 0 ||
    !command.length ||
    options.some(
      (arg) =>
        !['--heavy', '--resources', '--off'].includes(arg) && !/^--cache=(cold|warm)$/.test(arg)
    ) ||
    (options.includes('--off') && options.includes('--resources'))
  ) {
    throw new Error(
      'usage: node scripts/observe.mjs [--heavy] [--resources|--off] --cache=cold|warm -- command [args]'
    );
  }
  const heavy = options.includes('--heavy');
  if (heavy && process.env.SQUADRON_RUN_OBSERVATION_HEAVY)
    throw new Error(
      'nested --heavy would wait for itself; invoke the inner command without --heavy'
    );
  if (process.env.SQUADRON_RUN_OBSERVATION_WRAPPER || process.env.SQUADRON_RUN)
    throw new Error(
      'nested observation wrappers are unsupported; measure the complete command once'
    );
  if (heavy && process.platform === 'win32')
    throw new Error('heavy locking is not available on win32');
  process.env.SQUADRON_RUN_OBSERVATION_MODE = options.includes('--off')
    ? 'off'
    : options.includes('--resources')
      ? 'resources'
      : 'spans';
  process.env.SQUADRON_RUN_OBSERVATION_CACHE =
    options.find((arg) => arg.startsWith('--cache='))?.slice(8) ?? 'unknown';
  const beganNs = ns();
  const dir = observation.createRun('observe');
  observation.configure(dir);
  const identity = observation.identity();
  const requestedNs = ns();
  const recipe = path.join(dir, 'command.json');
  if (
    !observation.write(recipe, {
      command,
      requestedNs,
      dir,
      heavy,
      grouped: process.platform !== 'win32'
    })
  )
    throw new Error('could not prepare command dispatch');
  const preload =
    '--import=' + pathToFileURL(path.join(path.dirname(SELF), 'observation.mjs')).href;
  const env = {
    ...process.env,
    SQUADRON_RUN_OBSERVATION_DIR: dir,
    SQUADRON_RUN_OBSERVATION_PARENT: dir,
    SQUADRON_RUN_OBSERVATION_WRAPPER: String(process.pid),
    ...(options.includes('--resources')
      ? {
          NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ')
        }
      : {})
  };
  const ready = () => console.error(`observe: run: ${dir}`);
  const lock =
    process.env.SQUADRON_RUN_OBSERVATION_LOCK ?? path.join(os.homedir(), '.squadron', 'heavy.lock');
  if (heavy) fs.mkdirSync(path.dirname(lock), { recursive: true });
  const dispatch = [SELF, '--admitted', recipe];
  const result = heavy
    ? await execute(
        process.platform === 'darwin' ? 'lockf' : 'flock',
        process.platform === 'darwin'
          ? ['-k', '-t', '2700', lock, process.execPath, ...dispatch]
          : ['-w', '2700', lock, process.execPath, ...dispatch],
        env,
        true,
        ready
      )
    : await execute(process.execPath, dispatch, env, process.platform !== 'win32', ready);
  const dispatchEndedNs = ns();
  let admission = null;
  try {
    admission = JSON.parse(fs.readFileSync(path.join(dir, 'admission.json'), 'utf8'));
  } catch {
    /* Never admitted. */
  }
  const end = observation.identity();
  const finishedNs = ns();
  observation.write(path.join(dir, 'runtime.json'), {
    schema: 1,
    kind: 'command',
    identity,
    command,
    heavy,
    admission,
    sourceStable:
      Boolean(identity.source && end.source) &&
      JSON.stringify(identity.source) === JSON.stringify(end.source),
    ms: Number(BigInt(finishedNs) - BigInt(beganNs)) / 1e6,
    setupMs: Number(BigInt(requestedNs) - BigInt(beganNs)) / 1e6,
    cleanupMs: Number(BigInt(finishedNs) - BigInt(dispatchEndedNs)) / 1e6,
    queueMs: admission ? Number(BigInt(admission.admittedNs) - BigInt(requestedNs)) / 1e6 : null,
    ...result,
    outcome: result.signal ? 'cancelled' : result.exit === 0 ? 'passed' : 'failed',
    unadmitted: !admission,
    timeout:
      !admission && !result.signal && result.exit === (process.platform === 'darwin' ? 75 : 1)
  });
  process.exitCode = result.exit;
}

await main().catch((error) => {
  console.error(`observe: ${error.message}`);
  process.exitCode = 1;
});
