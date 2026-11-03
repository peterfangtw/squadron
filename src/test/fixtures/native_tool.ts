import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { testPlatform } from '../home';

/** A real shell child under each fake native CLI; not an observation of provider tool exports. */
export function nativeTool(text: string, env: NodeJS.ProcessEnv): Promise<void> | undefined {
  const prefix = 'squadron-native-tool ';
  if (!text.startsWith(prefix)) return undefined;
  const input = JSON.parse(text.slice(prefix.length)) as {
    command: string; result: string; env?: NodeJS.ProcessEnv;
  };
  const windows = testPlatform() === 'win32';
  const shell = windows
    ? path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    : '/bin/sh';
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${input.command}\nexit $LASTEXITCODE`]
    : ['-c', input.command];
  return new Promise<void>((resolve, reject) => {
    cp.execFile(shell, args, {
      env: { ...process.env, ...env, ...input.env }, maxBuffer: 128 * 1024,
      windowsHide: true, timeout: 70000
    }, (error, stdout, stderr) => {
      void fs.writeFile(input.result, JSON.stringify({
        code: error ? (typeof error.code === 'number' ? error.code : 5) : 0, stdout, stderr
      })).then(resolve, reject);
    });
  });
}
