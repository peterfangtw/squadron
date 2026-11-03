import * as fs from 'node:fs';
import * as path from 'node:path';

export function preloadEnv(dir: string, source: string): NodeJS.ProcessEnv {
  const file = path.join(dir, 'fixture-preload.cjs');
  fs.writeFileSync(file, source + '\nrequire("node:module").syncBuiltinESMExports();\n');
  return { NODE_OPTIONS: `--require=${JSON.stringify(file)}` };
}

export function commandEnv(dir: string, command: string, script: string): NodeJS.ProcessEnv {
  return preloadEnv(
    dir,
    `
const cp = require('node:child_process');
const run = cp.execFileSync;
cp.execFileSync = function(file, args, options) {
  return file === ${JSON.stringify(command)}
    ? run(process.execPath, [${JSON.stringify(script)}, ...args], { ...options, timeout: options?.timeout ?? 5000 })
    : run(file, args, options);
};
`
  );
}

export function pauseSource(ready: string, release: string): string {
  return `
const disk = require('node:fs');
function pause() {
  disk.writeFileSync(${JSON.stringify(ready)}, 'ready');
  const deadline = Date.now() + 5000;
  while (!disk.existsSync(${JSON.stringify(release)})) {
    if (Date.now() > deadline) throw Error('fixture release deadline expired');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
`;
}
