import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as ts from 'typescript';
import { linkDir, repoRoot } from '../helpers';

const REPO = repoRoot();
const CLEAN = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'NODE_TEST_CONTEXT'
  )
);
const made: string[] = [];
after(() => Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-metrics-')));
  made.push(dir);
  await fs.cp(path.join(REPO, 'scripts/local'), path.join(dir, 'scripts/local'), {
    recursive: true
  });
  await fs.copyFile(
    path.join(REPO, 'scripts/fixture-roots.cjs'),
    path.join(dir, 'scripts/fixture-roots.cjs')
  );
  await linkDir(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  for (const [file, text] of Object.entries(files)) await write(dir, file, text);
  return dir;
}

async function write(dir: string, file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), text);
}

function run(dir: string, script: string, ...args: string[]) {
  return spawnSync(process.execPath, [`scripts/local/${script}.mjs`, ...args], {
    cwd: dir,
    env: CLEAN,
    encoding: 'utf8'
  });
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: CLEAN, encoding: 'utf8' });
}

async function commentRepo(text: string): Promise<string> {
  const dir = await fixture({
    'base.json': '{"compilerOptions":{"jsx":"react-jsx","target":"ES2020","rootDir":"components"}}',
    'tsconfig.json': '{"extends":"./base.json","include":["components"]}',
    'components/view.tsx': text,
    '.gitignore': 'node_modules\n'
  });
  git(dir, 'init', '--quiet');
  git(dir, 'add', '.');
  git(
    dir,
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '--quiet',
    '-m',
    'base'
  );
  return dir;
}

const JSX = '/** @jsxImportSource preact */\nexport const view = <div title="hello" />;\n';

describe('local comment verification', () => {
  it('accepts prose edits in TSX and rejects runtime and type changes', async () => {
    const dir = await commentRepo(JSX + '// explanation\nexport type Size = number;\n');
    const verify = () => run(dir, 'comments', 'verify', 'components/view.tsx');
    await write(dir, 'components/view.tsx', JSX + '// shorter\nexport type Size = number;\n');
    const prose = verify();
    assert.equal(prose.status, 0, prose.stdout + prose.stderr);
    await write(dir, 'components/view.tsx', JSX + 'export type Size = string;\n');
    assert.equal(verify().status, 1);
    await write(
      dir,
      'components/view.tsx',
      JSX.replace('hello', 'goodbye') + 'export type Size = number;\n'
    );
    assert.equal(verify().status, 1);
  });

  it('rejects a JSX directive change that changes imports under the inherited project options', async () => {
    const dir = await commentRepo(JSX);
    await write(dir, 'components/view.tsx', JSX.replace('preact', 'react'));
    const ran = run(dir, 'comments', 'verify', 'components/view.tsx');
    assert.equal(ran.status, 1, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /emit DIFF/);
  });

  it('finds the referenced project owning a file and accepts an explicit project selection', async () => {
    const dir = await commentRepo(JSX);
    await fs.rename(path.join(dir, 'tsconfig.json'), path.join(dir, 'tsconfig.app.json'));
    await write(dir, 'tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}');
    await write(dir, 'components/view.tsx', JSX.replace('preact', 'react'));
    for (const args of [[], ['--project', 'tsconfig.app.json']]) {
      const ran = run(dir, 'comments', 'verify', ...args, 'components/view.tsx');
      assert.equal(ran.status, 1, ran.stdout + ran.stderr);
      assert.match(ran.stdout, /emit DIFF/);
    }
  });

  it('uses the no-config fallback but rejects a config that does not cover the file', async () => {
    const dir = await commentRepo('export const value = 1; // prose\n');
    await write(dir, 'components/view.tsx', 'export const value = 1; // shorter\n');
    await fs.rm(path.join(dir, 'tsconfig.json'));
    assert.equal(run(dir, 'comments', 'verify', 'components/view.tsx').status, 0);
    await write(dir, 'other.ts', 'export const other = 1;\n');
    for (const include of ['other.ts', 'missing']) {
      await write(dir, 'tsconfig.json', JSON.stringify({ include: [include] }));
      const missing = run(dir, 'comments', 'verify', 'components/view.tsx');
      assert.equal(missing.status, 1, missing.stdout + missing.stderr);
      assert.match(missing.stderr, /does not cover|No project covers/);
    }
  });
});

let compiledMetricFixture: Promise<string> | undefined;

async function metricRepo(): Promise<string> {
  const base = await (compiledMetricFixture ??= buildMetricFixture());
  const dir = await fixture({});
  await fs.cp(base, dir, {
    recursive: true,
    filter: (source) =>
      source !== path.join(base, 'node_modules') && source !== path.join(base, 'scripts')
  });
  return dir;
}

async function buildMetricFixture(): Promise<string> {
  const dir = await fixture({
    'base.json': '{"compilerOptions":{"target":"ES2022","module":"NodeNext","sourceMap":true}}',
    'tsconfig.json':
      '{"extends":"./base.json","compilerOptions":{"rootDir":"application","outDir":"build"},"include":["application"]}',
    'application/logic.mts':
      'export function choose(value: boolean): number {\n  if (value) return 1;\n  return 0;\n}\n',
    'application/unmeasured.mts':
      'export function absent(value: boolean): number {\n  if (value) return 2;\n  return 3;\n}\n',
    'application/checks/deep/logic.spec.mts':
      'import { test } from "node:test";\nimport { choose } from "../../logic.mjs";\ntest("both", () => { if (choose(true) !== 1 || choose(false) !== 0) throw new Error("wrong"); });\n'
  });
  emit(dir);
  await write(
    dir,
    'coverage.lcov',
    'SF:application/logic.mts\r\nDA:2,1,abc123\r\nDA:3,0,def456\r\nBRDA:2,0,0,1\r\nBRDA:2,0,1,0\r\nend_of_record\r\n'
  );
  await write(dir, 'build/stale.mjs', 'export function stale(x) { return x ? 1 : 0; }\n');
  return dir;
}

function emit(dir: string): void {
  const config = ts.readConfigFile(path.join(dir, 'tsconfig.json'), (file) =>
    ts.sys.readFile(file)
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
  assert.equal(ts.createProgram(parsed.fileNames, parsed.options).emit().emitSkipped, false);
}

describe('local CRAP report', () => {
  it('resolves inherited output layout and scores supplied coverage without running tests', async () => {
    const dir = await metricRepo();
    await write(dir, 'build/checks/deep/logic.spec.mjs', 'throw new Error("must not run");\n');
    for (const args of [[], ['--branch']]) {
      const ran = run(dir, 'crap', '--lcov', 'coverage.lcov', ...args);
      assert.equal(ran.status, 0, ran.stdout + ran.stderr);
      assert.match(ran.stdout, /\s+3\s+2\s+50%\s+application[/\\]logic\.mts:1/);
      assert.doesNotMatch(ran.stdout, /stale\.mjs|logic\.spec|absent/);
    }
    const all = run(dir, 'crap', '--lcov', 'coverage.lcov', '--all');
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /n\/a\s+2\s+n\/a\s+application[/\\]unmeasured\.mts:1/);
    const excluded = run(
      dir,
      'crap',
      '--lcov',
      'coverage.lcov',
      '--exclude',
      'application/logic.mts'
    );
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.doesNotMatch(excluded.stdout, /choose/);

    const lcov = await fs.readFile(path.join(dir, 'coverage.lcov'), 'utf8');
    await write(dir, 'coverage.lcov', lcov.replace(/^BRDA:.*\n/gm, ''));
    const fallback = run(dir, 'crap', '--lcov', 'coverage.lcov', '--branch');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /\s+3\s+2\s+50%\s+application[/\\]logic\.mts:1/);

    const otherRun = lcov.replace(
      /(DA:\d+|BRDA:\d+,\d+,\d+),([01])/g,
      (_, record: string, hit: string) => `${record},${hit === '0' ? '1' : '0'}`
    );
    await write(dir, 'coverage.lcov', lcov + otherRun);
    const merged = run(dir, 'crap', '--lcov', 'coverage.lcov', '--branch');
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stdout, /\s+2\s+2\s+100%\s+application[/\\]logic\.mts:1/);
  });

  it('collects project coverage when sandbox helpers have unavailable source maps', async () => {
    const dir = await metricRepo();
    const test = `import { execFileSync } from 'node:child_process';
      import * as fs from 'node:fs';
      import * as os from 'node:os';
      import * as path from 'node:path';
      import { choose } from '../../logic.mjs';
      const helper = path.join(os.tmpdir(), 'copied.mjs');
      fs.copyFileSync(new URL('../../logic.mjs', import.meta.url), helper);
      execFileSync(process.execPath, ['--enable-source-maps', helper]);
      if (choose(true) !== 1 || choose(false) !== 0) throw new Error('wrong');\n`;
    await write(dir, 'application/checks/deep/logic.spec.mts', test);
    await write(dir, 'build/checks/deep/logic.spec.mjs', test);
    const ran = run(dir, 'crap');
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /\s+2\s+2\s+100%\s+application[/\\]logic\.mts:1/);
  });

  it('scores the coverage of a test run that had a failing test, and says so', async () => {
    const dir = await metricRepo();
    const failing =
      'import { test } from "node:test";\ntest("late", () => { throw new Error("over budget"); });\n';
    await write(dir, 'application/broken.spec.mts', failing);
    await write(dir, 'build/broken.spec.mjs', failing);
    const ran = run(dir, 'crap');
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /over budget/);
    assert.match(ran.stdout, /tests\s+FAILED/);
    assert.match(ran.stdout, /\s+2\s+2\s+100%\s+application[/\\]logic\.mts:1/);
  });

  it('scores past eslint directives in the source', async () => {
    const dir = await metricRepo();
    const source = path.join(dir, 'application/logic.mts');
    const [first, ...rest] = (await fs.readFile(source, 'utf8')).split('\n');
    await fs.writeFile(
      source,
      [
        `${first} // eslint-disable-line complexity`,
        ...rest,
        '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
        'export const unused = 0;'
      ].join('\n')
    );
    const ran = run(dir, 'crap', '--lcov', 'coverage.lcov');
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /\s+3\s+2\s+50%\s+application[/\\]logic\.mts:1/);
  });

  it('names a class method by its own line', async () => {
    const dir = await metricRepo();
    await write(
      dir,
      'application/gate.mts',
      'export class Gate {\n  private readonly limit = 10;\n\n  check(x: number): string {\n    if (x > this.limit) return "high";\n    return "low";\n  }\n}\n'
    );
    const ran = run(dir, 'crap', '--lcov', 'coverage.lcov', '--all');
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /application[/\\]gate\.mts:4\s+Method 'check'/);
  });

  it('needs source maps to collect coverage itself', async () => {
    const dir = await metricRepo();
    await write(dir, 'base.json', '{"compilerOptions":{"target":"ES2022","module":"NodeNext"}}');
    emit(dir);
    const ran = run(dir, 'crap');
    assert.equal(ran.status, 1, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /source ?map/i);
    assert.doesNotMatch(ran.stderr, /running tests/);
  });

  it('fails clearly for invalid config and a coverage coordinate mismatch', async () => {
    const dir = await metricRepo();
    await write(dir, 'coverage.lcov', 'SF:build/logic.mjs\nDA:2,invalid\nend_of_record\n');
    const malformed = run(dir, 'crap', '--lcov', 'coverage.lcov');
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /Invalid LCOV/);
    await write(dir, 'coverage.lcov', 'SF:build/logic.mjs\nDA:2,1\nend_of_record\n');
    const mismatch = run(dir, 'crap', '--lcov', 'coverage.lcov');
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /coverage.*source|source.*coverage/i);
    await write(dir, 'tsconfig.json', '{"compilerOptions":{"target":"invalid"}}');
    const invalid = run(dir, 'crap', '--lcov', 'coverage.lcov');
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /target/i);
  });

  it('uses line records independently of malformed branch locations', async () => {
    const dir = await metricRepo();
    await write(
      dir,
      'coverage.lcov',
      'SF:application/logic.mts\nDA:2,1\nBRDA:undefined,11,0,245\nend_of_record\n'
    );
    const lines = run(dir, 'crap', '--lcov', 'coverage.lcov');
    assert.equal(lines.status, 0, lines.stdout + lines.stderr);
    assert.match(lines.stdout, /\s+2\s+2\s+100%\s+application[/\\]logic\.mts:1/);
    const branches = run(dir, 'crap', '--lcov', 'coverage.lcov', '--branch');
    assert.equal(branches.status, 1, branches.stdout + branches.stderr);
    assert.match(branches.stderr, /Invalid LCOV/);
  });

  it('rejects empty or wrong-format coverage', async () => {
    const dir = await metricRepo();
    for (const coverage of ['', '{}']) {
      await write(dir, 'coverage.lcov', coverage);
      const ran = run(dir, 'crap', '--lcov', 'coverage.lcov');
      assert.equal(ran.status, 1, ran.stdout + ran.stderr);
      assert.match(ran.stderr, /coverage.*source|source.*coverage/i);
    }
  });

  it('measures imported source files outside the include list and permits project dependencies', async () => {
    const dir = await metricRepo();
    await write(
      dir,
      'application/logic.mts',
      'import "./dependency.mjs";\nexport const value = 1;\n'
    );
    await write(
      dir,
      'application/dependency.mts',
      'export function dependency(value: boolean) {\n  return value ? 1 : 0;\n}\n'
    );
    await write(
      dir,
      'shared/tsconfig.json',
      '{"compilerOptions":{"composite":true},"files":["lib.ts"]}'
    );
    await write(dir, 'shared/lib.ts', 'export const shared = 1;\n');
    await write(
      dir,
      'tsconfig.json',
      '{"extends":"./base.json","compilerOptions":{"rootDir":"application","outDir":"build"},"include":["application/logic.mts"],"references":[{"path":"./shared"}]}'
    );
    emit(dir);
    await write(dir, 'coverage.lcov', 'SF:application/dependency.mts\nDA:2,1\nend_of_record\n');
    const ran = run(dir, 'crap', '--lcov', 'coverage.lcov');
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /\s+2\s+2\s+100%\s+application[/\\]dependency\.mts:1/);
  });

  it('collects coverage with output outside the working directory', async () => {
    const dir = await metricRepo();
    const app = path.join(dir, 'application');
    const probe = path.join(dir, 'coverage-environment.json');
    await write(
      dir,
      'application/checks/deep/logic.spec.mts',
      `import * as fs from 'node:fs'; import * as os from 'node:os';
       import { choose } from '../../logic.mjs';
       if(choose(true)!==1 || choose(false)!==0) throw Error('wrong');
       fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({home:os.homedir(),tmp:os.tmpdir(),
         env:{HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,TMP:process.env.TMP,TEMP:process.env.TEMP,TMPDIR:process.env.TMPDIR}}));`
    );
    await write(
      dir,
      'application/tsconfig.json',
      '{"extends":"../base.json","compilerOptions":{"rootDir":".","outDir":"../elsewhere"},"include":["**/*.mts"]}'
    );
    emit(app);
    const ran = spawnSync(process.execPath, [path.join(dir, 'scripts/local/crap.mjs')], {
      cwd: app,
      env: CLEAN,
      encoding: 'utf8'
    });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    const observed = JSON.parse(await fs.readFile(probe, 'utf8')) as {
      home: string;
      tmp: string;
      env: NodeJS.ProcessEnv;
    };
    assert.notEqual(observed.home, os.homedir());
    assert.equal(observed.tmp, path.join(observed.home, 'tmp'));
    for (const key of ['TMP', 'TEMP', 'TMPDIR']) assert.equal(observed.env[key], observed.tmp);
    assert.equal(observed.env.HOME, observed.home);
    assert.equal(observed.env.USERPROFILE, observed.home);
    await assert.rejects(fs.stat(observed.home));
    assert.match(ran.stdout, /\s+2\s+2\s+100%\s+logic\.mts:1/);
  });
});
