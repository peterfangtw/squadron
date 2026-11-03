import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrandId } from '../core/model';
import type { ExecutionRuntime } from '../core/execution';

export async function executionRepo(
  name: string,
  brand: BrandId
): Promise<{ cwd: string; runtime: ExecutionRuntime }> {
  const cwd = await gitRepo(name);
  const adapters = await import('../core/adapter');
  const execution = await import('../core/execution');
  const prepared = await execution.prepareExecution(
    adapters.adapter(brand)?.execution,
    path.resolve('dist/execution.js'),
    true
  );
  return { cwd, runtime: prepared.runtime };
}

/** A repository under `HOME` with one empty commit: a tree a turn checkpoint
 *  can be taken of. */
export async function gitRepo(name: string): Promise<string> {
  const cwd = path.join(await fs.realpath(os.homedir()), name);
  await fs.mkdir(cwd);
  const run = promisify(execFile);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  await run('git', ['init', '-b', 'main'], { cwd, env });
  await run(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base'
    ],
    { cwd, env }
  );
  return cwd;
}
