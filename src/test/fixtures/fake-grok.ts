/**
 * A `grok` that costs nothing for smoke: login / logout / models, and
 * everything else forwarded to `fake-acp` so an owned Grok card still boards.
 *
 * Do not add these subcommands to `fake-cli.ts` — that fixture is Claude.
 *
 * Login stderr is the 2026-08-16 1.0.4 device-code shape
 * (`docs/reference/cli_state/grok/auth.md`). There is no code to
 * accept: a test flips `~/.grok/fake-login-complete` and this child writes
 * `auth.json` then exits 0.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = process.env.HOME || os.homedir();
const authFile = path.join(home, '.grok', 'auth.json');
const doneFile = path.join(home, '.grok', 'fake-login-complete');

function signedIn(): boolean {
  try {
    return fs.statSync(authFile).isFile() && fs.statSync(authFile).size > 0;
  } catch {
    return false;
  }
}

function writeIn(): void {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      'https://auth.x.ai::smoke': { email: 'grok-smoke@example.invalid', key: 'x' }
    })
  );
}

function writeOut(): void {
  try {
    fs.unlinkSync(authFile);
  } catch {
    /* already out */
  }
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const device = argv.includes('--device-auth') || argv.includes('--device-code');

if (cmd === 'login' && (device || argv.length === 1)) {
  process.stderr.write(
    'To sign in, open this URL in your browser:\n\n' +
      '  https://accounts.x.ai/oauth2/device?user_code=CGB6-Y7VF\n\n' +
      'Confirm this code in your browser:\n\n' +
      '  CGB6-Y7VF\n\n' +
      'Waiting for authorization...\n'
  );
  const tick = setInterval(() => {
    if (!fs.existsSync(doneFile)) return;
    clearInterval(tick);
    try {
      fs.unlinkSync(doneFile);
    } catch {
      /* gone */
    }
    writeIn();
    process.exit(0);
  }, 150);
  process.on('SIGTERM', () => process.exit(1));
  process.stdin.on('end', () => process.exit(1));
} else if (cmd === 'logout') {
  writeOut();
  process.exit(0);
} else if (cmd === 'models') {
  process.stdout.write(
    signedIn() ? 'You are logged in with grok.com.\n' : 'You are not authenticated.\n'
  );
  process.stdout.write('\nDefault model: grok-4.6\n');
  process.exit(0);
} else {
  const acp = path.join(__dirname, 'fake-acp.js');
  const child = spawn(process.execPath, [acp, ...argv], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
