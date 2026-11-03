import * as os from 'node:os';

// Model-free transport oracle. A Node process is not a native CLI identity.
const [mode, ...args] = process.argv.slice(2);
const requested = Number(process.env.FIXTURE_TIMEOUT_MS ?? 5000);
if (!Number.isFinite(requested) || requested <= 0 || requested > 5000)
  throw new Error('fixture timeout must be between 1 and 5000 ms');
const deadline = setTimeout(() => {
  console.error('fixture input deadline expired');
  process.exit(124);
}, requested);
const chunks: Buffer[] = [];
if (mode === 'hold') console.log('ready');
process.stdin.on('data', (chunk: Buffer) => {
  chunks.push(chunk);
  if (mode === 'hold' && Buffer.concat(chunks).toString() === 'release\n') finish();
});
process.stdin.on('end', () => { if (mode !== 'hold') finish(); });

let finished = false;
function finish(): void {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  console.log(JSON.stringify({
    args,
    stdin: Buffer.concat(chunks).toString('base64'),
    cwd: process.cwd(),
    home: os.homedir(),
    tmp: os.tmpdir(),
    env: Object.fromEntries(['HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'FIXTURE_VALUE']
      .map((key) => [key, process.env[key]]))
  }));
  process.exitCode = Number(process.env.FIXTURE_EXIT ?? 0);
  process.stdin.destroy();
}
