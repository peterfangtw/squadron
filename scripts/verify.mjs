import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compile = ['compile', ['npm', 'run', 'compile']];
const affected = ['test', ['node', 'scripts/affected.mjs']];
const smoke = ['node', 'out/test/smoke/runner.js'];
const modes = {
  test: [compile, affected],
  check: [
    ['format', ['npm', 'run', 'format:check']],
    ['lint', ['npm', 'run', 'lint']],
    compile,
    affected
  ],
  'dev:host': [compile],
  'test:smoke': [compile, ['smoke', [...smoke, 'out/test/smoke/e2e.js']]],
  'test:smoke:one': [compile, ['smoke', smoke]],
  'test:smoke:cleanup': [compile, ['smoke', ['node', '--test', 'out/test/smoke/cleanup.smoke.js']]]
};
const [requested, ...extra] = process.argv.slice(2);
const mode = requested === 'test:smoke:slow' ? 'test:smoke' : requested;
const steps = modes[mode];
if (!steps) throw new Error(`unknown verification command: ${requested}`);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./timed.mjs', import.meta.url)),
    ...steps.map(([name, argv]) => `${name}=${JSON.stringify(argv)}`),
    '--',
    ...extra
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, ...(requested === 'test:smoke:slow' && { SQUADRON_SMOKE_SLOW: '250' }) }
  }
);
// win32: the console's Ctrl-C, Ctrl-Break or close reached timed too, and
// `kill` would be TerminateProcess, ending it before it records the run and
// leaves the gate. SIGBREAK unhandled would end this process at once.
for (const signal of [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  ...(process.platform === 'win32' ? ['SIGBREAK'] : [])
])
  process.on(signal, () => {
    if (process.platform !== 'win32') child.kill(signal);
  });
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
