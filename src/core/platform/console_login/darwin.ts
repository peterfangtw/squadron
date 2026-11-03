import { invoke, spawned } from '../executables/internal';
import type { Effects, ConsoleLogin } from './index';
import { Operation } from './operation';

/**
 * Claude CLI 2.1.226, measured 2026-08-11 (TASK_done_mcp_auth.md).
 * **The `script` wrapper is load-bearing and so is `stdio: 'ignore'`.** The CLI
 * refuses a piped stdin outright — it prints the URL, retracts
 * `Waiting for authorization…` and exits without ever binding its callback
 * listener — so a plain child like `startClaudeLogin`'s cannot work here. Under
 * a pty it binds and waits. Two ways to get one were rejected: `node-pty` is a
 * native module, and a real IDE terminal is a surface the reader would have to
 * be sent to. `script` is a stdlib binary and costs neither.
 *
 * `stdio: ['ignore', …]` rather than `'pipe'` because `script` calls
 * `tcgetattr` on its own stdin, and Node's `'pipe'` is a socketpair on macOS:
 *
 *     script: tcgetattr/ioctl: Operation not supported on socket
 *
 * `ignore` gives it `/dev/null`, a character device, which it accepts. Do not
 * "tidy" this to `pipe` — nothing is written to this child's stdin anyway,
 * because the browser redirect goes to the CLI's own listener rather than back
 * through us.
 */
export function consoleLogin(effects: Effects): ConsoleLogin {
  let live: Operation | undefined;
  let disposal: ReturnType<ConsoleLogin['dispose']> | undefined;
  return {
    support: { supported: true },
    run(program, args, options) {
      if (disposal || live)
        return { supported: true, status: 'failed', reason: 'Console login is busy or disposed.' };
      return spawned(() =>
        invoke(program, args, (file, argv) => {
          const child = effects.spawn('script', ['-q', '/dev/null', file, ...argv], {
            cwd: options.cwd,
            stdio: ['ignore', 'pipe', 'pipe']
          });
          const operation = new Operation(
            () => {
              live = undefined;
            },
            () => {
              child.kill('SIGTERM');
            }
          );
          live = operation;
          operation.child = child;
          child.stdout?.on('data', (bytes: Buffer) => operation.output('stdout', bytes));
          child.stderr?.on('data', (bytes: Buffer) => operation.output('stderr', bytes));
          child.on('error', (error) => operation.fail(error.message));
          child.on('close', (code) =>
            operation.finish(
              code === null
                ? { kind: 'cancelled', reason: 'Login stopped.' }
                : { kind: 'exited', code }
            )
          );
          operation.markReady();
          return operation;
        })
      );
    },
    dispose() {
      return (disposal ??= live?.dispose() ?? Promise.resolve({ unresolved: [] }));
    }
  };
}
