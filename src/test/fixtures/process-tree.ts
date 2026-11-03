import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

const [role = '', directory = '', survival = ''] = process.argv.slice(2);
fs.writeFileSync(path.join(directory, `${role}.pid`), String(process.pid));

if (role === 'root') {
  // `detach` (the caller's choice, on win32): a non-detached child is in this
  // Node's job there and ends with it, while Claude's tool shell was in no job
  // and outlived its CLI (processes Step 1).
  const child = childProcess.spawn(process.execPath, [__filename, 'tool', directory], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    detached: survival === 'detach',
    windowsHide: true
  });
  child.once('message', () => console.log(JSON.stringify({ ready: true })));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  if (role === 'tool') {
    const child = childProcess.spawn(process.execPath, [__filename, 'leaf', directory], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    child.once('message', () => process.send?.({ ready: true }));
  } else {
    process.send?.({ ready: true });
  }
}
