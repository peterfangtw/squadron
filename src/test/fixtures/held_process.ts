import * as cp from 'node:child_process';
import * as path from 'node:path';

export async function heldProcess(): Promise<{
  child: cp.ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}> {
  const child = cp.spawn(process.execPath, [path.join(__dirname, 'held_process.js'), 'child']);
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve());
    child.once('error', reject);
  });
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error('host placeholder did not become ready')),
          4000
        );
      }),
      new Promise<void>((resolve) => child.stdout.once('data', () => resolve())),
      closed.then(() => {
        throw new Error('host placeholder exited before ready');
      })
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
  return {
    child,
    async stop() {
      child.stdin.end('release\n');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

if (process.argv[2] === 'child') {
  setTimeout(() => process.exit(124), 120_000);
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    if (input === 'release\n') process.exit(0);
  });
  process.stdin.on('end', () => process.exit(0));
  console.log('ready');
}
