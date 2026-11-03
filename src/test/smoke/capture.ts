import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';

/** fs.cp has no cancellation: a timed-out copy can read HOME after reset. */
export function copy(
  source: string,
  target: string,
  ms: number,
  skipSockets = false
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, source, target, String(skipSockets)], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let failure: Error | undefined;
    let detail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      detail = (detail + chunk.toString()).slice(0, 4096);
    });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGKILL');
    }, ms);
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !expired) resolve();
      else
        reject(
          failure ??
            new Error(expired ? `copy exceeded ${ms} ms` : `copy exited ${String(code)}: ${detail}`)
        );
    });
  });
}

async function main(): Promise<void> {
  const [source, target, skipSockets] = process.argv.slice(2);
  if (!source || !target) throw new Error('copy requires source and target');
  await fs.cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    ...(skipSockets === 'true'
      ? { filter: async (file: string) => !(await fs.lstat(file)).isSocket() }
      : {})
  });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
