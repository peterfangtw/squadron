import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import * as platform from '../../core/platform';
import * as executables from '../../core/platform/executables';

/** Real argv/stdio child; executable classification has its own native tests. */
export async function nodeCli(
  t: TestContext,
  source: string
): Promise<{
  bin: string;
  seen: string;
  ready(): Promise<void>;
  output(): Promise<void>;
  release(): Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-node-cli-'));
  const bin = path.join(dir, 'cli.cjs');
  const seen = path.join(dir, 'seen');
  const ready = path.join(dir, 'ready');
  const release = path.join(dir, 'release');
  await fs.writeFile(
    bin,
    `
const fs = require('node:fs');
const seen = ${JSON.stringify(seen)}, ready = ${JSON.stringify(ready)}, release = ${JSON.stringify(release)};
setTimeout(() => process.exit(124), 5000);
function hold(next) {
  fs.writeFileSync(ready, 'ready');
  const poll = setInterval(() => {
    if (fs.existsSync(release)) { clearInterval(poll); next?.(); }
  }, 10);
}
${source}
`
  );
  const find = platform.executables.find.bind(platform.executables);
  t.mock.method(
    platform.executables,
    'find',
    (candidates: executables.Candidates, env: NodeJS.ProcessEnv) =>
      candidates.setting === bin
        ? Promise.resolve({
            kind: 'found' as const,
            program: executables.named(bin, process.execPath),
            path: bin,
            source: 'setting' as const
          })
        : find(candidates, env)
  );
  let outputSeen: (() => void) | undefined;
  const output = new Promise<void>((resolve) => {
    outputSeen = resolve;
  });
  const spawn = platform.executables.spawn.bind(platform.executables);
  const children: { child: import('node:child_process').ChildProcess; closed: Promise<void> }[] =
    [];
  t.mock.method(platform.executables, 'spawn', (...args: Parameters<typeof spawn>) => {
    const result = spawn(...args);
    if (result.status === 'ok') {
      const child = result.value;
      child.stdout?.once('data', () => outputSeen?.());
      child.stderr?.once('data', () => outputSeen?.());
      children.push({
        child,
        closed: new Promise<void>((resolve) => child.once('close', () => resolve()))
      });
    }
    return result;
  });
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    bin,
    seen,
    async output() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          output,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Node CLI produced no fragment')), 4000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async ready() {
      const deadline = Date.now() + 4000;
      while (!(await fs.stat(ready).catch(() => undefined))) {
        if (Date.now() > deadline) throw new Error('Node CLI did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    release: () => fs.writeFile(release, 'release')
  };
}
