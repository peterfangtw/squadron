import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import * as platform from '../../core/platform';
import * as ownership from './ownership';
import * as devHost from './dev_host';
import * as capture from './capture';
import * as registry from './scenarios';
import * as checkpoints from '../../../scripts/checkpoints.mjs';
import * as observation from '../../../scripts/observation.mjs';
import * as results from '../../../scripts/test-results.mjs';
import { testPlatform } from '../helpers';

export const SHUTDOWN_MS = 10_000;

export function scenarioArgs(args: string[]): string[] {
  const files = args.filter((arg) => !arg.startsWith('-'));
  if (files.length !== 1 || !files[0]?.endsWith('.js') || /[*?[\]{}]/.test(files[0])) {
    throw new Error('smoke requires exactly one compiled scenario file or e2e.js; no globs');
  }
  for (const flag of args.filter((arg) => arg.startsWith('-'))) {
    if (
      !/^--test-(name-pattern|skip-pattern|timeout|reporter|reporter-destination)=.+$/.test(flag) &&
      flag !== '--test-only'
    ) {
      throw new Error(`unsupported smoke test flag: ${flag}; use --test-name-pattern=value syntax`);
    }
  }
  return ['--test', ...args.filter((arg) => arg.startsWith('-')), ...files];
}

export async function writeLauncher(paths: ownership.RunPaths): Promise<string> {
  if (testPlatform() === 'win32') {
    const file = path.join(paths.root, 'launch.cmd');
    await fs.writeFile(file, launcherCmd(process.execPath, path.join(__dirname, 'launcher.js')));
    return file;
  }
  const file = path.join(paths.root, 'launch.sh');
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(
    file,
    `#!/bin/sh\n${quote(process.execPath)} ${quote(path.join(__dirname, 'launcher.js'))} || exit $?\nexec "$SQUADRON_SMOKE_IDE" "$@"\n`,
    { mode: 0o700 }
  );
  return file;
}

/**
 * What Playwright starts on win32, where it runs `executablePath` through
 * `cmd.exe /d /s /c` with every word double-quoted (1.61.1). That cmd.exe is
 * the launch root: the helper registers it, then the IDE is its second child.
 * A batch waits for the GUI program it starts, so the root lives as long as
 * the IDE does. `%` is doubled for batch parsing; a `"` cannot be quoted.
 */
export function launcherCmd(node: string, helper: string): string {
  const quote = (value: string): string => {
    if (value.includes('"') || /[\r\n]/.test(value))
      throw new Error(`cannot quote for cmd.exe: ${value}`);
    return `"${value.replaceAll('%', '%%')}"`;
  };
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `${quote(node)} ${quote(helper)}`,
    // Any nonzero status: a crashed helper's NTSTATUS is negative, and
    // `if errorlevel 1` would start the IDE unregistered.
    'if %errorlevel% neq 0 exit /b %errorlevel%',
    '"%SQUADRON_SMOKE_IDE%" %*',
    'exit /b %errorlevel%',
    ''
  ].join('\r\n');
}

export async function runSmoke(args: string[]): Promise<number> {
  // Every read this run makes answers from one reusable reader on win32
  // (50 ms against 440 ms one-shot, 2026-10-27), idling out by itself between
  // them; released after the last, as the extension host releases its own.
  const lease = platform.processes.own();
  let code = 1;
  try {
    code = await supervise(args);
  } finally {
    const { unresolved } = await lease.dispose();
    if (unresolved.length) {
      console.error(`smoke supervisor: process reader unresolved: ${unresolved.join(',')}`);
      code ||= 1;
    }
  }
  return code;
}

async function supervise(args: string[]): Promise<number> {
  observation.event('scope:start', { owner: 'smoke' });
  let argv = scenarioArgs(args);
  const verification = checkpoints.context();
  const entry = path.resolve(args.find((arg) => !arg.startsWith('-')) ?? '');
  const barrel = path.basename(entry) === 'e2e.js';
  const files = barrel
    ? registry.scenarios.map((name) => path.join(path.dirname(entry), name + '.js'))
    : [entry];
  const inputs = {
    files: files.map((file) => path.basename(file)),
    flags: args.filter((arg) => arg.startsWith('-'))
  };
  const remaining = files.filter(
    (file) => !verification?.reuse('smoke:' + path.basename(file), inputs)
  );
  const observedScope = {
    owner: 'smoke',
    requested: files.map((file) => path.relative(process.cwd(), file)),
    selected: files.map((file) => path.relative(process.cwd(), file)),
    executed: remaining.map((file) => path.relative(process.cwd(), file)),
    reused: files
      .filter((file) => !remaining.includes(file))
      .map((file) => path.relative(process.cwd(), file)),
    flags: inputs.flags
  };
  observation.event('scope:selection', observedScope);
  if (process.env['SQUADRON_RUN'])
    observation.write(path.join(process.env['SQUADRON_RUN'], 'smoke-scope.json'), observedScope);
  if (!remaining.length) return 0;
  // The selection is the registry's, checked before this attempt owns a host.
  if (barrel) registry.scenarioSelection(remaining.map((file) => path.basename(file, '.js')));
  await Promise.all([entry, ...remaining].map((file) => fs.access(file)));
  const runFolder = process.env['SQUADRON_RUN'] ?? path.dirname(entry);
  const events = path.join(runFolder, 'smoke-events.jsonl');
  const registrationPath = path.join(runFolder, 'smoke-registration.json');
  if (verification) {
    argv = [
      '--test',
      ...args.filter((arg) => arg.startsWith('-')),
      ...(!args.some((arg) => arg.startsWith('--test-reporter='))
        ? ['--test-reporter=spec', '--test-reporter-destination=stdout']
        : []),
      '--test-reporter=' + url.pathToFileURL(path.resolve('scripts/checkpoint-reporter.mjs')).href,
      '--test-reporter-destination=' + events,
      entry
    ];
  }
  const smokeRoot = process.env['SQUADRON_SMOKE_ROOT'];
  if (smokeRoot === undefined) await devHost.closePreviousHosts(await devHost.worktrees());
  // A later attempt in the same run folder must not inherit this attempt's sections.
  if (verification) {
    await fs.rm(events, { force: true });
    await fs.rm(registrationPath, { force: true });
  }
  const supervisor = await ownership.createSupervisor(smokeRoot);
  let launcher: string;
  try {
    launcher = await writeLauncher(supervisor.paths);
  } catch (error) {
    await supervisor.shutdown();
    throw error;
  }
  let workerTree: ownership.LaunchOwnership | undefined;
  let stopped: NodeJS.Signals | undefined;
  let forced = false;
  let lost = false;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let shutdown: Promise<void> | undefined;
  let cleanupSpan: observation.Span | undefined;
  const diagnostics: string[] = [];
  const evidenceErrors: string[] = [];
  let rootDisposed = false;
  const child = childProcess.spawn(process.execPath, argv, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(
        Object.entries(checkpoints.cleanEnv(process.env)).filter(
          ([key]) => key !== 'NODE_TEST_CONTEXT'
        )
      ),
      ...(verification && barrel
        ? {
            SQUADRON_SMOKE_ENTRIES: JSON.stringify(
              remaining.map((file) => path.basename(file, '.js'))
            )
          }
        : {}),
      SQUADRON_SMOKE_SOCKET: supervisor.paths.socket,
      SQUADRON_SMOKE_TOKEN: supervisor.token,
      SQUADRON_SMOKE_LAUNCHER: launcher,
      ...(verification ? { SQUADRON_SMOKE_REGISTRATION: registrationPath } : {})
    }
  });
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  let notifyShutdown: () => void;
  const shutdownStarted = new Promise<void>((resolve) => {
    notifyShutdown = resolve;
  });
  const exited = new Promise<number>((resolve) => {
    child.once('error', (error) => {
      diagnostics.push(String(error));
      resolve(127);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(shutdownTimer);
      resolve(code ?? 128 + (signal ? os.constants.signals[signal] : 0));
    });
  });
  const rememberRunner = async (): Promise<void> => {
    const rows = await ownership.readProcesses();
    const root = rows.get(child.pid ?? 0);
    if (!workerTree && root) {
      workerTree = ownership.ownLaunch('node-test', root);
      workerTree.groups = false;
    }
    if (workerTree) {
      if (supervisor.worker) workerTree.members.set(supervisor.worker.pid, supervisor.worker);
      ownership.observeLaunch(workerTree, rows);
    }
  };
  const beginShutdown = (): void => {
    if (shutdown) return;
    cleanupSpan = observation.start('smoke:supervisor-cleanup');
    if (workerTree && supervisor.worker)
      workerTree.members.set(supervisor.worker.pid, supervisor.worker);
    notifyShutdown();
    shutdown = supervisor.shutdown().catch((error: unknown) => {
      diagnostics.push(String(error));
    });
    if (child.exitCode === null && child.signalCode === null) {
      shutdownTimer = setTimeout(() => {
        forced = true;
        void (async () => {
          try {
            await rememberRunner();
            if (workerTree) await ownership.cleanupLaunch(workerTree);
          } catch (error) {
            diagnostics.push(String(error));
          }
        })();
      }, SHUTDOWN_MS);
    }
  };
  supervisor.onLoss = () => {
    lost = true;
    beginShutdown();
  };
  let remembering: Promise<void> | undefined;
  supervisor.onRelease = () => {
    remembering = rememberRunner().catch((e: unknown) => {
      diagnostics.push(String(e));
    });
    beginShutdown();
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  // A console's Ctrl-C, Ctrl-Break or close reaches every process attached to
  // it on win32, the test runner included, and `kill` there is
  // TerminateProcess: `delivered` leaves it to stop, under the shutdown
  // deadline. SIGBREAK unhandled would end this supervisor before its reap.
  if (testPlatform() === 'win32') signals.push('SIGBREAK');
  const onSignal = (signal: NodeJS.Signals, delivered = false): void => {
    stopped ??= signal;
    supervisor.closing = true;
    void (async () => {
      try {
        await rememberRunner();
      } catch (error) {
        diagnostics.push(String(error));
      }
      if (!delivered) child.kill(signal);
      beginShutdown();
    })();
  };
  const outputError = (): void => onSignal('SIGHUP');
  process.stdout.on('error', outputError);
  process.stderr.on('error', outputError);
  const handlers = signals.map((signal) => {
    const handler = (): void => onSignal(signal, testPlatform() === 'win32');
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    await rememberRunner()
      .catch(() => rememberRunner())
      .catch((error: unknown) => {
        diagnostics.push(String(error));
        beginShutdown();
      });
    const code = await Promise.race([
      exited,
      shutdownStarted.then(() =>
        ownership.bounded(exited, SHUTDOWN_MS + ownership.CLEANUP_MS + 3000, 'test runner shutdown')
      )
    ]).catch((error: unknown) => {
      diagnostics.push(String(error));
      return 1;
    });
    beginShutdown();
    await shutdown;
    await remembering;
    if (workerTree) {
      try {
        await ownership.cleanupLaunch(workerTree);
      } catch (error) {
        diagnostics.push(String(error));
      }
    }
    const failed = code !== 0 || lost || forced || diagnostics.length > 0;
    const folder = path.join(process.env['SQUADRON_RUN'] ?? supervisor.paths.root, 'cleanup');
    if (failed && process.env['SQUADRON_RUN']) {
      try {
        await Promise.all(
          [
            capture.copy(
              supervisor.paths.home,
              path.join(folder, 'host', 'home'),
              ownership.CLEANUP_MS,
              true
            ),
            (async () => {
              const logs = path.join(supervisor.paths.profile, 'data', 'logs');
              try {
                await fs.access(logs);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
              }
              await capture.copy(
                logs,
                path.join(folder, 'host', 'profile', 'data', 'logs'),
                ownership.CLEANUP_MS,
                true
              );
            })()
          ].map((work) =>
            work.catch((error: unknown) => {
              evidenceErrors.push(String(error));
            })
          )
        );
      } catch (error) {
        evidenceErrors.push(String(error));
      }
    }
    if (!diagnostics.length && !evidenceErrors.length && (!failed || process.env['SQUADRON_RUN'])) {
      try {
        await ownership.bounded(
          fs.rm(supervisor.paths.root, { recursive: true, force: true }),
          3000,
          'run disposal'
        );
        rootDisposed = true;
      } catch (error) {
        diagnostics.push(String(error));
      }
    }
    if (failed || diagnostics.length) {
      console.error(`  evidence: ${folder}`);
      try {
        await ownership.bounded(
          (async () => {
            await fs.mkdir(folder, { recursive: true });
            await fs.writeFile(
              path.join(folder, 'supervisor.json'),
              JSON.stringify(
                {
                  paths: supervisor.paths,
                  retainedRoot: rootDisposed ? undefined : supervisor.paths.root,
                  evidence: process.env['SQUADRON_RUN']
                    ? {
                        home: path.join(folder, 'host', 'home'),
                        hostLogs: path.join(folder, 'host', 'profile', 'data', 'logs')
                      }
                    : undefined,
                  forced,
                  lost,
                  diagnostics,
                  evidenceErrors,
                  launches: [...supervisor.launches.values()].map(
                    (launch) =>
                      launch && {
                        id: launch.id,
                        root: launch.root,
                        closed: launch.closed,
                        members: [...launch.members.values()],
                        suspects: [...launch.suspects.values()]
                      }
                  )
                },
                null,
                2
              )
            );
          })(),
          3000,
          'supervisor evidence'
        );
      } catch (error) {
        evidenceErrors.push(String(error));
      }
      if (evidenceErrors.length) console.error(`smoke evidence: ${evidenceErrors.join('; ')}`);
      if (diagnostics.length || forced)
        console.error(
          `smoke supervisor: ${diagnostics.join('; ') || 'test runner exceeded shutdown deadline'}`
        );
    }
    cleanupSpan?.end(
      !lost && !forced && !diagnostics.length && !evidenceErrors.length && rootDisposed
        ? 'passed'
        : 'failed'
    );
    observation.flush();
    if (verification) {
      const confirmed =
        !lost &&
        !forced &&
        !stopped &&
        !diagnostics.length &&
        !evidenceErrors.length &&
        rootDisposed;
      let registration: { file: string; name: string }[] | null = null;
      if (verification) {
        try {
          const parsed = JSON.parse(await fs.readFile(registrationPath, 'utf8')) as unknown;
          registration = Array.isArray(parsed) ? (parsed as { file: string; name: string }[]) : [];
        } catch {
          // A missing record keeps direct-file attribution. Smoke sections live on boot.js,
          // so they stay unpromoted until this file exists.
          registration = null;
        }
      }
      for (const result of results.fileResults(
        events,
        remaining,
        barrel ? entry : null,
        registration
      )) {
        const key = 'smoke:' + path.basename(result.file);
        if (confirmed && result.outcome === 'passed')
          verification.checkpoint(key, inputs, result.ms);
        else
          verification.event({
            kind: 'checkpoint',
            key,
            outcome: result.outcome,
            ms: result.ms,
            ...(result.reason ? { reason: result.reason } : {}),
            cleanup: confirmed ? 'confirmed' : 'unconfirmed',
            ...(confirmed ? {} : { cleanupReason: 'supervisor cleanup unconfirmed' })
          });
      }
    }
    return stopped
      ? 128 + os.constants.signals[stopped]
      : code || (lost || forced || diagnostics.length ? 1 : 0);
  } finally {
    clearTimeout(shutdownTimer);
    process.stdout.removeListener('error', outputError);
    process.stderr.removeListener('error', outputError);
    child.stdout.destroy();
    child.stderr.destroy();
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  }
}

if (require.main === module) {
  // timed can disappear independently; EPIPE must not abort ownership cleanup.
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  runSmoke(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    }
  );
}
