import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import * as tseslint from 'typescript-eslint';
import { rules } from '../../../scripts/eslint-portability.cjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester();
// TypeScript-only import forms; the scope manager records them differently.
const tsTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const invalid = (messageId: string) => (code: string) => ({ code, errors: [{ messageId }] });

describe('os-read lint rule', () => {
  tester.run('os-read', rules['os-read'], {
    valid: [
      "import * as os from 'node:os'; os.homedir(); os.tmpdir(); const { EOL } = os;",
      "import { homedir } from 'os'; import { platform } from './helpers';",
      "const os = { platform: 'x', type: 'y' }; void os.platform; void os.type;",
      'function pick(os) { return os.platform; }',
      "const process = { platform: 'x' }; void process.platform;",
      'void process.arch; void process.env.HOME; void event.type; void node.platform;',
      'testPlatform();'
    ],
    invalid: [
      "import * as os from 'node:os'; os.platform();",
      "import * as nos from 'os'; nos.type();",
      "import os from 'node:os'; os['platform']();",
      "const os = require('os'); os.platform();",
      "const os = await import('node:os'); os.platform();",
      "require('node:os').type();",
      "import { platform } from 'node:os';",
      "import { platform as p } from 'process';",
      "import { type as kind } from 'os';",
      'const { platform } = process;',
      "import * as os from 'os'; const { type: kind } = os;",
      "import process from 'node:process'; void process.platform;",
      "void process['platform'];"
    ].map(invalid('read'))
  });
  tsTester.run('os-read', rules['os-read'], {
    valid: [
      "import type { platform } from 'os'; import { type platform as p } from 'process';",
      "import fs = require('fs'); fs.existsSync('a');"
    ],
    invalid: ["import os = require('node:os'); os.platform();"].map(invalid('read'))
  });
});

describe('home-write lint rule', () => {
  tester.run('home-write', rules['home-write'], {
    valid: [
      'const home = process.env.HOME; const { USERPROFILE } = process.env;',
      'if (process.env.HOME === home) void 0;',
      "spawn('x', [], { env: { ...process.env, ...homeEnv(home) } });",
      'Object.assign(process.env, homeEnv(home)); Object.assign(process.env, previous);',
      'delete process.env.HOME;',
      'process.env.TMPDIR = temporary;',
      "const fixture = { home: '/Users/x', Home: 1 };"
    ],
    invalid: [
      "spawn('x', [], { env: { ...process.env, HOME: home } });",
      "const env = { 'USERPROFILE': home };",
      "const env = { ['HOME']: home };",
      'Object.assign(process.env, { HOME });',
      'process.env.HOME = home;',
      "process.env['USERPROFILE'] = home;",
      'env.HOME = home;'
    ].map(invalid('write'))
  });
});

describe('temp-root lint rule', () => {
  const fs = "import * as fs from 'node:fs';";
  tester.run('temp-root', rules['temp-root'], {
    valid: [
      `${fs} import * as os from 'os'; import * as path from 'path'; fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));`,
      `${fs} import * as path from 'path'; fs.mkdtempSync(prefix); fs.mkdtempSync(path.join(home, 'x-'));`,
      "fake.mkdtemp('/tmp/x-'); const fs = makeFs(); fs.mkdtemp('/tmp/x-');",
      "post({ kind: 'open', cwd: '/tmp/x' });"
    ],
    invalid: [
      "import * as fs from 'node:fs/promises'; await fs.mkdtemp('/tmp/sq-');",
      `${fs} fs.mkdtempSync(\`/tmp/\${name}-\`);`,
      `${fs} fs.mkdtempSync('C:\\\\tmp\\\\x-');`,
      `${fs} fs['mkdtempSync']('\\\\tmp\\\\x-');`,
      `${fs} fs.promises.mkdtemp('/var/tmp/x-');`,
      "import { promises } from 'fs'; promises.mkdtemp('/tmp/x-');",
      "import { mkdtemp } from 'node:fs/promises'; await mkdtemp('/tmp/x-');",
      "const { mkdtempSync } = require('fs'); mkdtempSync('/tmp/x-');",
      "const fs = require('fs'); fs.mkdtempSync('/tmp/' + name);",
      `${fs} import * as path from 'node:path'; fs.mkdtempSync(path.join('/tmp', 'x-'));`,
      `${fs} import { join } from 'path'; fs.mkdtempSync(join('/tmp', 'x-'));`,
      "const { promises: fsp } = require('fs'); fsp.mkdtemp('/tmp/x-');"
    ].map(invalid('root'))
  });
});
