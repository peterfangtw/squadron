import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { linkDir, repoRoot } from '../helpers';
import { AFFECTED_SCRIPTS } from './affected_scripts';

/**
 * `scripts/affected.mjs`, run as the process it is, in a throwaway repository whose
 * `src/` is a few files shaped like this one's. `node_modules` is linked in for
 * esbuild. `GIT_*` is stripped for `release.test.ts`'s reason,
 * `SQUADRON_TEST_ALL` because release's own check sets it, and `SQUADRON_RUN*`
 * so a nested run cannot write into the outer run's folder.
 */

const REPO = repoRoot();

const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('SQUADRON_VERIFY_') &&
      key !== 'SQUADRON_TIMINGS_FILE' &&
      !key.startsWith('GIT_') &&
      !key.startsWith('npm_') &&
      key !== 'SQUADRON_TEST_ALL' &&
      !key.startsWith('SQUADRON_RUN') &&
      key !== 'NODE_TEST_CONTEXT'
  )
);

const FILES: Record<string, string> = {
  'package.json': '{ "name": "fixture" }\n',
  'src/core/leaf.ts': 'export const leaf = 1;\n',
  'src/core/other.ts': 'export const other = 2;\n',
  'src/core/paint.ts': 'export const paint = 3;\n',
  'src/webview/main.ts': "import { paint } from '../core/paint';\nexport const drawn = paint;\n",
  'src/ui/document.ts': 'export const doc = 4;\n',
  'src/test/leaf.test.ts': "import { leaf } from '../core/leaf';\nexport const t = leaf;\n",
  'src/test/other.test.ts':
    "// reads nothing, though this cites `docs/x.md`\nimport { other } from '../core/other';\nexport const t = other;\n",
  'src/test/ui.test.ts': "import { doc } from '../ui/document';\nexport const t = doc;\n",
  'src/test/reader.test.ts':
    "import * as path from 'node:path';\nexport const t = path.join(__dirname, 'x');\n",
  'src/test/disk.ts':
    "import * as path from 'node:path';\nexport const at = path.resolve('dist/x.js');\n",
  'src/test/via_helper.test.ts': "import { at } from './disk';\nexport const t = at;\n",
  'src/core/shaken.ts':
    "import { deep } from './deep';\nexport const kept = 6;\nexport function unused() {\n  return deep;\n}\n",
  'src/core/deep.ts': 'export const deep = 7;\n',
  'src/test/shaken.test.ts': "import { kept } from '../core/shaken';\nexport const t = kept;\n",
  'src/test/notes.test.ts':
    "import * as fs from 'node:fs';\nexport const t = fs.readFileSync('CHANGELOG.md', 'utf8');\n",
  'src/test/segment.test.ts':
    "import * as path from 'node:path';\nexport const t = path.join('docs', 'notes');\n"
};

const ALL = [
  'leaf.test.ts',
  'notes.test.ts',
  'other.test.ts',
  'reader.test.ts',
  'segment.test.ts',
  'shaken.test.ts',
  'ui.test.ts',
  'via_helper.test.ts'
].map((name) => `src/test/${name}`);
const ALWAYS = [
  'src/test/notes.test.ts',
  'src/test/reader.test.ts',
  'src/test/segment.test.ts',
  'src/test/via_helper.test.ts'
];

const made: string[] = [];
after(() => Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function repo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-affected-')));
  made.push(dir);
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  for (const name of AFFECTED_SCRIPTS)
    await fs.copyFile(path.join(REPO, 'scripts', name), path.join(dir, 'scripts', name));
  await linkDir(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  for (const [file, text] of Object.entries(FILES)) await write(dir, file, text);
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\nout\n');
  git(dir, 'init', '--quiet', '--initial-branch=work', '.');
  git(dir, 'add', '.');
  commit(dir);
  git(dir, 'update-ref', 'refs/remotes/origin/staging', 'HEAD');
  return dir;
}

/** Every fixture test as compiled output, each one the same script. */
async function compiledAll(dir: string, text: string) {
  for (const test of ALL) {
    await write(dir, test.replace(/^src\/test\//, 'out/test/').replace(/\.ts$/, '.js'), text);
  }
}

async function write(dir: string, file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), text);
}

function git(dir: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: dir, env: CLEAN, encoding: 'utf8' });
}

function commit(dir: string) {
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--quiet', '-am', 'x');
}

function affected(dir: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, ['scripts/affected.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: CLEAN
  });
  return { ...ran, listed: ran.stdout.split('\n').filter(Boolean) };
}

describe('scripts/affected.mjs', () => {
  it('compares directly with an explicit base even after origin/staging advances', async () => {
    const dir = await repo();
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    await write(dir, 'src/core/leaf.ts', 'export const leaf = 10;\n');
    commit(dir);
    git(dir, 'update-ref', 'refs/remotes/origin/staging', 'HEAD');
    const ran = affected(dir, '--list', '--base', base);
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(ran.listed, ['src/test/leaf.test.ts', ...ALWAYS].sort());
    assert.match(ran.stderr, new RegExp(`vs ${base}`));
  });

  it('rejects a missing or invalid explicit base, including with --all', async () => {
    const dir = await repo();
    for (const args of [['--base'], ['--base', 'missing'], ['--all', '--base', 'missing']]) {
      const ran = affected(dir, '--list', ...args);
      assert.notEqual(ran.status, 0);
      assert.match(ran.stderr, /base/);
    }
  });

  it('picks the tests a changed file reaches, plus every test that reads files', async () => {
    const dir = await repo();
    await write(dir, 'src/core/leaf.ts', 'export const leaf = 10;\n');
    const ran = affected(dir, '--list');
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(ran.listed, ['src/test/leaf.test.ts', ...ALWAYS].sort());
    assert.match(ran.stderr, /^affected: 5\/8 tests vs origin\/staging/);
  });

  it('reaches a test through a module that loads the webview bundle by path', async () => {
    const dir = await repo();
    await write(dir, 'src/core/paint.ts', 'export const paint = 30;\n');
    assert.deepEqual(affected(dir, '--list').listed, [...ALWAYS, 'src/test/ui.test.ts'].sort());
  });

  // Bundling drops `deep.ts` as unused, but `tsc`'s output still requires it.
  it('follows an import that tree-shaking drops from the bundle', async () => {
    const dir = await repo();
    await write(dir, 'src/core/deep.ts', 'export const deep = 70;\n');
    assert.deepEqual(affected(dir, '--list').listed, [...ALWAYS, 'src/test/shaken.test.ts'].sort());
  });

  it('counts commits since the merge base, and untracked files', async () => {
    const dir = await repo();
    await write(dir, 'src/core/other.ts', 'export const other = 20;\n');
    commit(dir);
    await write(dir, 'src/core/fresh.ts', 'export const fresh = 5;\n');
    await write(
      dir,
      'src/test/fresh.test.ts',
      "import { fresh } from '../core/fresh';\nexport const t = fresh;\n"
    );
    assert.deepEqual(
      affected(dir, '--list').listed,
      ['src/test/fresh.test.ts', 'src/test/other.test.ts', ...ALWAYS].sort()
    );
  });

  it('runs only the readers when nothing a graph holds changed', async () => {
    const dir = await repo();
    await write(dir, 'docs/notes.md', 'x\n');
    assert.deepEqual(affected(dir, '--list').listed, ALWAYS);
  });

  it('runs everything when a build input changed, with no origin/staging, or when asked', async () => {
    const dir = await repo();
    assert.deepEqual(affected(dir, '--list', '--all').listed, ALL);
    const asked = spawnSync(process.execPath, ['scripts/affected.mjs', '--list'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...CLEAN, SQUADRON_TEST_ALL: '1' }
    });
    assert.equal(asked.stdout.split('\n').filter(Boolean).length, ALL.length);
    assert.match(asked.stderr, /^affected: all 8 tests \(asked for all\)/);
    await write(dir, 'scripts/esbuild.mjs', '// build input\n');
    const build = affected(dir, '--list');
    assert.deepEqual(build.listed, ALL);
    assert.match(build.stderr, /\(scripts\/esbuild\.mjs changed\)/);
    await fs.rm(path.join(dir, 'scripts/esbuild.mjs'));
    await write(dir, 'package.json', '{ "name": "fixture", "version": "1" }\n');
    const config = affected(dir, '--list');
    assert.deepEqual(config.listed, ALL);
    assert.match(config.stderr, /^affected: all 8 tests \(package\.json changed\)/);
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/staging');
    assert.match(affected(dir, '--list').stderr, /\(no origin\/staging to compare with\)/);
  });

  it('runs every test when the graph cannot be built', async () => {
    const dir = await repo();
    await write(
      dir,
      'src/test/leaf.test.ts',
      "import { gone } from '../core/gone';\nexport const t = gone;\n"
    );
    const ran = affected(dir, '--list');
    assert.deepEqual(ran.listed, ALL);
    assert.match(ran.stderr, /\(no import graph: /);
  });

  it('hands node --test the compiled files and its flags, and passes its exit code through', async () => {
    const dir = await repo();
    await write(dir, 'src/core/leaf.ts', 'export const leaf = 10;\n');
    const red = "require('node:test').test('red', () => { throw new Error('red'); });\n";
    const green = "require('node:test').test('green', () => {});\n";
    await write(dir, 'out/test/leaf.test.js', red);
    for (const name of ['reader', 'via_helper', 'notes', 'segment', 'other', 'ui', 'shaken']) {
      await write(dir, `out/test/${name}.test.js`, green);
    }
    const ran = affected(dir, '--test-reporter=spec');
    assert.equal(ran.status, 1);
    assert.match(ran.stdout, /✖ red/);
    assert.match(ran.stdout, /✔ green/);
    assert.match(ran.stdout, /ℹ tests 5/);
  });

  it('finds a test in a folder, and runs it from the same folder under out/', async () => {
    const dir = await repo();
    await write(dir, 'src/core/leaf.ts', 'export const leaf = 10;\n');
    await write(
      dir,
      'src/test/deep/nested.test.ts',
      "import { leaf } from '../../core/leaf';\nexport const t = leaf;\n"
    );
    assert.deepEqual(
      affected(dir, '--list').listed,
      ['src/test/deep/nested.test.ts', 'src/test/leaf.test.ts', ...ALWAYS].sort()
    );
    await compiledAll(dir, "require('node:test').test('green', () => {});\n");
    await write(
      dir,
      'out/test/deep/nested.test.js',
      "require('node:test').test('nested', () => {});\n"
    );
    const ran = affected(dir, '--test-reporter=spec');
    assert.equal(ran.status, 0, ran.stdout);
    assert.match(ran.stdout, /✔ nested/);
  });

  it('runs the tests in a home of their own, and removes it after', async () => {
    const dir = await repo();
    await write(dir, 'src/core/leaf.ts', 'export const leaf = 10;\n');
    const probe = [
      "const os = require('node:os');",
      "const path = require('node:path');",
      "require('node:test').test('home', () => {",
      `  const rel = path.relative(${JSON.stringify(os.tmpdir())}, os.homedir());`,
      "  if (!rel || rel.startsWith('..') || process.env.USERPROFILE !== os.homedir()) {",
      "    throw new Error('home ' + os.homedir());",
      '  }',
      "  if (os.tmpdir() !== path.join(os.homedir(), 'tmp') ||",
      "      ['TMP','TEMP','TMPDIR'].some(key => process.env[key] !== os.tmpdir())) throw new Error('temp escaped');",
      "  console.log('home=' + os.homedir());",
      '});',
      ''
    ].join('\n');
    await compiledAll(dir, probe);
    const ran = affected(dir, '--test-reporter=spec');
    assert.equal(ran.status, 0, ran.stdout);
    const home = /home=(.+)/.exec(ran.stdout)?.[1]?.trim();
    assert.ok(home && home !== os.homedir());
    await assert.rejects(fs.stat(home));
  });

  it('writes the full spec into the run folder scripts/timed.mjs gave it', async () => {
    const dir = await repo();
    await write(dir, 'src/core/leaf.ts', 'export const leaf = 10;\n');
    const green = "require('node:test').test('green', () => {});\n";
    await compiledAll(dir, green);
    const run = path.join(dir, 'run');
    await fs.mkdir(run);
    const ran = spawnSync(process.execPath, ['scripts/affected.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...CLEAN, SQUADRON_RUN: run }
    });
    assert.equal(ran.status, 0, ran.stdout);
    assert.match(await fs.readFile(path.join(run, 'test.spec.log'), 'utf8'), /✔ green/);
  });

  it('runs nothing and passes when nothing changed', async () => {
    const dir = await repo();
    const ran = affected(dir);
    assert.equal(ran.status, 0);
    assert.match(ran.stderr, /^affected: 0\/8 tests/);
  });

  it('keeps the temp-home sandbox off the always-run scan and the repo helper on it', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import { pathToFileURL } from 'node:url';",
          `const script = pathToFileURL(${JSON.stringify(`${REPO}/scripts/affected.mjs`)}).href;`,
          'const { dependencies } = await import(script);',
          "const graphs = await dependencies(['src/test/home.ts', 'src/test/helpers.ts']);",
          'const out = {};',
          'for (const [name, graph] of graphs) out[name] = graph;',
          'console.log(JSON.stringify(out));'
        ].join('\n')
      ],
      { cwd: REPO, env: CLEAN, encoding: 'utf8' }
    );
    assert.equal(child.status, 0, child.stderr);
    const graphs = JSON.parse(child.stdout) as {
      [file: string]: { readsFiles: boolean; files: string[] } | undefined;
    };
    const home = graphs['src/test/home.ts'];
    const helpers = graphs['src/test/helpers.ts'];
    assert.ok(home);
    assert.ok(helpers);
    assert.equal(home.readsFiles, false);
    assert.equal(helpers.readsFiles, true);
    assert.ok(!home.files.includes('src/test/helpers.ts'));
    assert.ok(home.files.includes('scripts/fixture-roots.cjs'));
    assert.ok(helpers.files.includes('src/test/home.ts'));
  });
});
