import * as childProcess from 'node:child_process';
import * as readline from 'node:readline';
import * as ownership from './ownership';
import * as runner from './runner';
import { testPlatform } from '../helpers';

async function peer(): Promise<void> {
  const connection = await ownership.connectWorker();
  const id = await connection.allocate();
  const launcher = await runner.writeLauncher(connection.paths);
  const args = ['-e', "console.log('ready');setInterval(()=>{},1000)"];
  const options: childProcess.SpawnOptions = {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, SQUADRON_SMOKE_IDE: process.execPath, SQUADRON_SMOKE_LAUNCH: id }
  };
  // As Playwright starts an executable on each OS: its own group on POSIX;
  // on win32 every word double-quoted through cmd.exe (1.61.1).
  const host =
    testPlatform() === 'win32'
      ? childProcess.spawn([launcher, ...args].map((word) => `"${word}"`).join(' '), [], {
          ...options,
          shell: true
        })
      : childProcess.spawn(launcher, args, { ...options, detached: true });
  if (!host.stdout) throw new Error('host has no stdout');
  const stdout = host.stdout;
  await new Promise<void>((resolve, reject) => {
    host.once('error', reject);
    host.once('exit', () => reject(new Error('host exited before readiness')));
    stdout.once('data', () => resolve());
  });
  console.log(JSON.stringify({ id, pid: host.pid }));
  const commands = readline.createInterface({ input: process.stdin });
  for await (const command of commands) {
    try {
      if (command === 'prepare') await connection.prepare(id);
      else if (command === 'finish') await connection.finish(id);
      else if (command === 'stale') await connection.finish('old-launch');
      else if (command === 'retired') {
        const retired = await connection.allocate();
        await connection.prepare(retired);
        await connection.finish(retired);
        await connection.prepare(retired);
        await ownership.request(connection.paths.socket, {
          type: 'register',
          token: process.env['SQUADRON_SMOKE_TOKEN'] ?? '',
          launch: retired,
          pid: host.pid ?? 0,
          helper: process.pid
        });
      } else if (command === 'duplicate') {
        await ownership.request(connection.paths.socket, {
          type: 'register',
          token: process.env['SQUADRON_SMOKE_TOKEN'] ?? '',
          launch: id,
          pid: host.pid ?? 0,
          helper: process.pid
        });
      } else if (command === 'release') {
        await connection.release();
        commands.close();
        console.log(JSON.stringify({ ok: true }));
        return;
      }
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error) }));
    }
  }
}

if (require.main === module)
  peer().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
