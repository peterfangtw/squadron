import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import * as rule from '../../../scripts/eslint-skip-reason.cjs';
import { repoRoot, withoutForceColor } from '../helpers';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ROOT = repoRoot();

describe('skip-reason lint rule', () => {
  new RuleTester().run('skip-reason', rule, {
    valid: [
      "it('x', { skip: process.platform === 'win32' && 'win32: no lsof — W3.6' }, () => {});",
      "it('x', { todo: process.platform !== 'win32' && 'posix: a backslash is a filename character' }, () => {});",
      "it('x', { skip: process.platform === 'linux' && 'win32, linux: needs pmset' }, () => {});",
      "it('x', { skip: false, timeout: 10 }, () => {});",
      "it('x', { skip: modeBitsSkip }, () => {});",
      "it('x', (t) => { t.skip('env: running as root'); });",
      "it('x', async (context) => { if (a) { context.skip('capability: this port keeps no backlog'); } });",
      "const lsofTodo = process.platform === 'win32' && 'win32: no lsof — W7.3';",
      'const commandTodo = processTableTodo && `${processTableTodo}/W3.2b`;',
      "const linksSkip = fileLinks ? false : 'win32: a file symlink needs Developer Mode';",
      'stream.skip(3); const noise = { skip: true };',
      'rows.forEach((row) => row.skip());',
      'const shouldSkip = files.length === 0;',
      "test.describe('x', { skip: process.platform === 'win32' && 'win32: no lsof' }, () => {});",
      "boot.step('x', (t) => { t.skip('env: an earlier step failed'); });"
    ],
    invalid: [
      ["it('x', { skip: process.platform === 'win32' }, () => {});", 'bare'],
      ["describe('x', { skip: true }, () => {});", 'bare'],
      ["it('x', { skip: process.platform !== 'win32' && 'off win32' }, () => {});", 'unscoped'],
      ["it('x', { todo: 'windows: not yet' }, () => {});", 'unscoped'],
      ["it('x', (t) => { t.skip('running as root'); });", 'unscoped'],
      ["it('x', (t) => { t.skip(); });", 'bare'],
      ["it('x', { skip: `no ${tool}` }, () => {});", 'unscoped'],
      ["const vsixSkip = process.platform === 'win32' && 'publish needs unzip';", 'unscoped'],
      ["it.skip('x', () => {});", 'method'],
      ["test.describe.skip('x', () => {});", 'method'],
      ["test.describe('x', { skip: 'oops' }, () => {});", 'unscoped'],
      ["describe.only('x', { skip: true }, () => {});", 'bare'],
      ["boot.step('x', (t) => { t.skip('oops'); });", 'unscoped']
    ].map(([code, messageId]) => ({ code: code!, errors: [{ messageId: messageId! }] }))
  });
});

describe('skip reporter', () => {
  it('counts skips and todos by scope after the dots, a skipped suite included', async () => {
    const out = await report(
      `const { describe, it } = require('node:test');
      it('a', { skip: 'posix: a' }, () => {});
      it('b', { skip: 'win32: b' }, () => {});
      it('c', (t) => { t.skip('win32: c'); });
      it('d', { skip: true }, () => {});
      it('e', { todo: 'win32: e' }, () => { throw new Error('not yet'); });
      it('f', () => { throw new Error('red'); });
      describe('g', { skip: 'win32: g' }, () => { it('g1', () => {}); it('g2', () => {}); });
      describe('h', { skip: 'linux: h' }, () => { it('h1', () => {}); });`
    );
    // Last, after dot's failure list rather than inside it.
    assert.match(out, /Failed tests:[\s\S]*✖ f /);
    assert.ok(
      out.endsWith(
        '\nℹ skipped by scope: linux 1 suite, posix 1, unscoped 1, win32 2 (+1 suite)\n' +
          'ℹ todo by scope: win32 1\n'
      ),
      out
    );
  });

  it('says nothing more than dot when nothing was skipped', async () => {
    assert.doesNotMatch(await report("require('node:test').it('a', () => {});"), /by scope/);
  });
});

/** What the reporter prints for one test file, run by `node --test` as `affected.mjs` runs it. */
async function report(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-skips-'));
  try {
    const file = path.join(dir, 'fixture.test.cjs');
    await fs.writeFile(file, source);
    const env = withoutForceColor();
    delete env.NODE_TEST_CONTEXT;
    const ran = cp.spawnSync(
      process.execPath,
      [
        '--test',
        `--test-reporter=${pathToFileURL(path.join(ROOT, 'scripts/skip-reporter.mjs')).href}`,
        '--test-reporter-destination=stdout',
        file
      ],
      { env, encoding: 'utf8' }
    );
    assert.equal(ran.stderr, '');
    return ran.stdout;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
