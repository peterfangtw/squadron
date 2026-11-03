#!/usr/bin/env node
/**
 * Runs the tests a change can reach, instead of every test file.
 *
 * Usage, as a `package.json` test step:
 *   node scripts/affected.mjs [--all] [--list] [--base <commit>] <node --test flags>
 *
 * Changed = what differs between the merge base with `origin/staging` and the
 * working tree, untracked files included: the tree under test is the working
 * tree, other sessions' unsaved edits and all. A test runs when:
 *
 * - a changed file is in its import graph — one esbuild pass over every test
 *   entry, writing nothing;
 * - a changed file is in the webview bundle and the test reaches a module
 *   that loads that bundle by path (`RUNTIME_EDGES`);
 * - or it reads a file at runtime by any other path (`READS_FILES`) — such a
 *   test can depend on anything, so it always runs. That is what keeps a
 *   change outside `src/` (a doc a test reads, a fixture, a root script) safe
 *   without a rule of its own.
 *
 * Everything runs with `--all`, with no `origin/staging` or no git checkout
 * (release's archive), when the graph cannot be built, or when a change
 * touches what every test is built from (`BUILD_INPUTS`). `SQUADRON_TEST_ALL=1`
 * is `--all` for a caller that cannot add to the command line, as release's
 * check is. `--list` prints the
 * choice and runs nothing. `--base` compares directly against that commit.
 * Other arguments go to `node --test`.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as checkpoints from './checkpoints.mjs';
import * as observation from './observation.mjs';
import * as results from './test-results.mjs';
import fixtureRoots from './fixture-roots.cjs';

const TESTS = 'src/test';
const OUT = 'out/test';

/** Files that load another module's compiled output by path, and the entry it is built from. */
const RUNTIME_EDGES = {
  'src/ui/document.ts': 'src/webview/main.ts',
  'src/test/harness.ts': 'src/webview/main.ts'
};

/**
 * A path a test opens itself; matched loosely, since a false match only runs
 * one test more. Import specifiers are graph edges and comments cite paths
 * without opening them, so both are cut first (`NOT_READS`). Only a comment
 * that starts its line is cut: `out/test/*.test.js` in a string must not open
 * a block that swallows code.
 */
const READS_FILES = new RegExp(
  [
    /__dirname|__filename|import\.meta|process\.cwd\(\)|path\.resolve\(/,
    // A path the repo has: `'docs/x.md'`, `path.join('docs', …)`, `'CHANGELOG.md'`.
    /['"`](?:\.\.?\/|src\/|out\/|dist\/|scripts\/|docs\/|media\/|install\/)/,
    /['"`](?:src|out|dist|scripts|docs|media|install)['"`]/,
    /['"`][\w.-]+\.(?:md|mjs|html)['"`]/
  ]
    .map((pattern) => pattern.source)
    .join('|')
);
const NOT_READS = [
  /\bfrom\s*['"][^'"]+['"]|\b(?:import|require)\(\s*['"][^'"]+['"]\s*\)|^\s*import\s*['"][^'"]+['"]/gm,
  /^\s*\/\*[\s\S]*?\*\//gm,
  /^\s*\/\/.*$/gm
];

const BUILD_INPUTS = [
  /^package(-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^scripts\/esbuild\.mjs$/
];

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  await main().catch((error) => {
    console.error(`affected: ${error.message}`);
    process.exitCode = 1;
  });

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--base');
  let base;
  if (at !== -1) {
    const value = args[at + 1];
    if (!value || args.lastIndexOf('--base') !== at) throw new Error('--base needs one commit');
    try {
      base = execFileSync(
        'git',
        ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }
      ).trim();
    } catch {
      throw new Error(`invalid comparison base: ${value}`);
    }
    args.splice(at, 2);
  }
  const all = args.includes('--all') || process.env.SQUADRON_TEST_ALL === '1';
  const list = args.includes('--list');
  const forward = args.filter((arg) => arg !== '--all' && arg !== '--list');
  const tests = testEntries();
  const choice = all ? { files: tests, reason: 'asked for all' } : await choose(tests, base);
  const header =
    choice.files.length === tests.length && choice.reason
      ? `affected: all ${tests.length} tests (${choice.reason})`
      : `affected: ${choice.files.length}/${tests.length} tests vs ${base ?? 'origin/staging'} (--all for every test)`;
  console.error(header);
  if (list) {
    for (const file of choice.files) console.log(file);
    return;
  }
  observation.event('scope:start', { owner: 'node' });
  const verification = checkpoints.context();
  const inputs = { files: choice.files, flags: forward };
  verification?.event({ kind: 'scope', stage: 'node', ...inputs });
  const remaining = choice.files.filter((file) => !verification?.reuse('node:' + file, inputs));
  const scope = {
    owner: 'node',
    requested: all ? 'all' : 'affected',
    base: base ?? null,
    files: choice.files,
    flags: forward,
    executed: remaining,
    reused: choice.files.filter((file) => !remaining.includes(file)),
    total: tests.length,
    reason: choice.reason
  };
  observation.event('scope:selection', scope);
  if (process.env.SQUADRON_RUN)
    checkpoints.atomic(path.join(process.env.SQUADRON_RUN, 'selection.json'), scope);
  if (remaining.length === 0) return;
  const outputs = remaining.map((file) =>
    path.join(OUT, path.relative(TESTS, file).replace(/\.ts$/, '.js'))
  );
  const home = fixtureRoots.create('squadron-test-home-');
  const events = path.join(process.env.SQUADRON_RUN ?? home, 'node-events.jsonl');
  const flags = [
    ...reporters(forward, process.env.SQUADRON_RUN),
    ...forward,
    ...(verification
      ? [
          `--test-reporter=${pathToFileURL(path.resolve('scripts/checkpoint-reporter.mjs')).href}`,
          `--test-reporter-destination=${events}`
        ]
      : [])
  ];
  const child = spawn(process.execPath, ['--test', ...flags, ...outputs], {
    stdio: 'inherit',
    env: sandboxEnv(checkpoints.cleanEnv(process.env), home)
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('close', (code, signal) => {
    let cleaned = false;
    try {
      fixtureRoots.remove(home);
      cleaned = true;
    } catch (error) {
      console.error(`affected: could not clean test home: ${error.message}`);
    }
    if (verification && cleaned) {
      for (const result of results.fileResults(events, outputs)) {
        const source = remaining[outputs.indexOf(result.file)];
        const key = 'node:' + source;
        if (result.outcome === 'passed') verification.checkpoint(key, inputs, result.ms);
        else verification.event({ kind: 'checkpoint', key, ...result });
      }
    }
    process.exitCode = code ?? 128 + os.constants.signals[signal];
    if (!cleaned) process.exitCode ||= 1;
  });
}

/**
 * Dots and the skips and todos by scope on the terminal, and the full spec in
 * the run's folder, when `timed.mjs` gave this run one and the caller chose no
 * reporter of its own. Here rather than in the script line, which would need
 * `$SQUADRON_RUN` — and cmd.exe, npm's shell on win32, leaves that unexpanded.
 */
export function reporters(forward, run) {
  if (!run || forward.some((arg) => arg.startsWith('--test-reporter'))) return [];
  return [
    `--test-reporter=${pathToFileURL(path.resolve('scripts/skip-reporter.mjs')).href}`,
    '--test-reporter-destination=stdout',
    '--test-reporter=spec',
    `--test-reporter-destination=${path.join(run, 'test.spec.log')}`
  ];
}

/**
 * The environment every test process runs in: a home of its own, so a test
 * that never moved its home — or moved only `HOME`, which win32's
 * `os.homedir()` does not read — cannot reach the reader's.
 */
export function sandboxEnv(env, home) {
  return { ...fixtureRoots.withoutCliRoots(env), ...fixtureRoots.environment(home) };
}

/**
 * Every test entry at any depth, as a repo-relative source path with `/`
 * separators — win32's `readdirSync` answers with its own.
 */
function testEntries() {
  return fs
    .readdirSync(TESTS, { recursive: true })
    .map((name) => name.split(path.sep).join('/'))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `${TESTS}/${name}`);
}

/** The tests to run, or all of them with the reason why. */
async function choose(tests, base) {
  const changed = changedFiles(base);
  if (!changed) return { files: tests, reason: 'no origin/staging to compare with' };
  if (changed.length === 0) return { files: [], reason: '' };
  const config = changed.find((file) => BUILD_INPUTS.some((pattern) => pattern.test(file)));
  if (config) return { files: tests, reason: `${config} changed` };
  let graphs;
  try {
    graphs = await dependencies(tests);
  } catch (error) {
    return { files: tests, reason: `no import graph: ${error.message.split('\n')[0]}` };
  }
  const files = select(graphs, changed);
  return { files, reason: files.length === tests.length ? 'every test reaches a change' : '' };
}

/**
 * Tests whose dependencies include a changed file, plus every test that reads
 * files at runtime. `graphs` maps each test to the source files it depends on.
 */
export function select(graphs, changed) {
  const touched = new Set(changed);
  return [...graphs]
    .filter(([, graph]) => graph.readsFiles || graph.files.some((file) => touched.has(file)))
    .map(([test]) => test);
}

/** Each test's source dependencies, edges included, and whether it reads files itself. */
export async function dependencies(tests) {
  const { build } = await import('esbuild');
  const edges = [...new Set(Object.values(RUNTIME_EDGES))];
  const result = await build({
    entryPoints: [...tests, ...edges],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    packages: 'external',
    external: ['vscode'],
    loader: { '.md': 'text' },
    outdir: 'affected.out',
    logLevel: 'silent'
  });
  // The import edges, not an output's `inputs`: those list only the files that
  // put bytes in the bundle, and tree-shaking drops a module whose exports go
  // unused — which `tsc`'s output still requires, and so still runs.
  const imports = result.metafile.inputs;
  const reach = (entry) => {
    const seen = new Set([entry]);
    for (const file of seen) {
      for (const edge of imports[file]?.imports ?? []) {
        if (!edge.external && edge.path in imports) seen.add(edge.path);
      }
    }
    return [...seen];
  };
  const graphs = new Map();
  for (const test of tests) {
    const own = reach(test).filter((file) => !file.startsWith('node_modules/'));
    const files = new Set(own);
    for (const file of own) {
      const entry = RUNTIME_EDGES[file];
      if (entry) for (const input of reach(entry)) files.add(input);
    }
    const readsFiles = own.some(
      (file) =>
        file.startsWith(`${TESTS}/`) && !(file in RUNTIME_EDGES) && READS_FILES.test(code(file))
    );
    graphs.set(test, { files: [...files], readsFiles });
  }
  return graphs;
}

/** Repo-relative paths changed since the merge base with `origin/staging`; undefined when there is none. */
export function changedFiles(base) {
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (base === undefined) {
    try {
      base = git('merge-base', 'HEAD', 'origin/staging').trim();
    } catch {
      return undefined;
    }
  }
  const lines = (text) => text.split('\n').filter(Boolean);
  return [
    ...new Set([
      ...lines(git('diff', '--name-only', '--no-renames', base)),
      ...lines(git('ls-files', '--others', '--exclude-standard'))
    ])
  ];
}

/** A file's text without what `NOT_READS` cuts. */
function code(file) {
  return NOT_READS.reduce(
    (text, pattern) => text.replace(pattern, ''),
    fs.readFileSync(file, 'utf8')
  );
}
