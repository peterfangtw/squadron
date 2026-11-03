import { stampWindows } from '../limits';
import * as os from 'node:os';
import { claudeBinary } from '../bin';
import { childTransport, type SessionTransport } from '../session';
import { withTemporarySession } from '../temporary_session';
import { controlRequest, readFrame } from './frames';
import { PROTOCOL_ARGS, PROTOCOL_ENV } from './session';
import type { RateLimits } from '../model';
import { readUsage } from './usage';

/** One control-only account read; no conversation or model turn is sent. */
export async function readClaudeUsage(
  override?: string,
  options: import('../temporary_session').TemporaryRead = {}
): Promise<RateLimits | undefined> {
  const binary = await claudeBinary(override);
  if (!binary.ok || options.signal?.aborted) return undefined;
  await options.starting?.();
  return askUsage(
    childTransport({
      bin: binary.program,
      cwd: os.tmpdir(),
      args: [
        ...PROTOCOL_ARGS,
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--settings',
        '{"disableAllHooks":true}'
      ],
      env: PROTOCOL_ENV
    }),
    options
  );
}

export async function askUsage(
  transport: SessionTransport,
  options: import('../temporary_session').TemporaryRead = {}
): Promise<RateLimits | undefined> {
  return withTemporarySession(
    transport,
    () =>
      new Promise((resolve) => {
        const finish = (reading: RateLimits | undefined): void => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          resolve(reading);
        };
        const abort = (): void => finish(undefined);
        const timer = setTimeout(() => finish(undefined), 10_000);
        transport.onLine((value) => {
          const frame = readFrame(value);
          if (frame?.type === 'control_response' && frame.requestId === 'squadron-usage') {
            const reading = frame.ok ? readUsage(frame.payload) : undefined;
            finish(reading ? stampWindows(reading, Date.now()) : undefined);
          }
        });
        transport.onExit(() => finish(undefined));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) {
          finish(undefined);
          return;
        }
        try {
          transport.write(controlRequest('squadron-usage', 'get_usage'));
        } catch {
          finish(undefined);
        }
      }),
    options
  );
}
