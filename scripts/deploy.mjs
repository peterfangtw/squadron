// Install a release. The bytes come from a tag, never from this checkout.
//
//   npm run deploy               -> newest release tag reachable from HEAD
//   npm run deploy -- v2026.31.9 -> that exact one. This is the rollback
//   npm run deploy -- --plan     -> print what it would install, build nothing
//
// A deploy used to be whatever was in the tree, gated by a branch-name test that
// a dirty `main` passed, and afterwards nothing said what had been installed.
// Now the tag pins a commit, `git archive` extracts that commit into a tmpdir,
// and packaging happens there — this checkout is never read, so concurrent
// sessions can keep working in it and a rollback does not need the tree to be in
// any particular state.
//
// `release.mjs` ran `check` and real-IDE smoke on the archived source before it
// cut the tag. Deploy reuses matching candidate bundles or builds that source,
// then installs and verifies the installed bytes. A VSIX cache hit skips packaging too.
//
// Built VSIX files are kept in `dist-releases/`, newest five. A rollback to one
// still there is an install rather than a build, which matters because the
// moment you want a rollback is also the moment `npm ci` off an old lockfile is
// most likely to fail.
//
// The verify step exists because every failure mode here is silent: an install
// can report success while shipping nothing, so the installed bytes are hashed
// against the VSIX that was just installed.
//
// A build that is not on `main` installs as "Squadron (STG)": see `stagingCopy`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import * as candidates from './release_candidate.mjs';
import * as observation from './observation.mjs';
import * as perf from 'node:perf_hooks';
import * as zip from './zip.mjs';
import * as artifacts from './windows-helper-artifacts.mjs';
import * as packagedBundles from './packaged-bundles.mjs';

// vsce rewrites the README's relative image paths against `repository`, and the
// source repo is private, so Open VSX and the Marketplace got a 404 for every
// image. The images are mirrored into this public repo instead; a new README
// image goes there too. `package.json` names no repository at all — it linked
// the gallery pages to that same 404 — and vsce stops to ask without the flag.
const PACKAGE =
  'npx --yes @vscode/vsce package --out release.vsix --no-dependencies --allow-missing-repository' +
  ' --baseImagesUrl https://raw.githubusercontent.com/peterfangtw/squadron-media/main';

const ROOT = join(import.meta.dirname, '..');

// The hosts this knows how to install into. A CLI and the directory it installs
// to are one entry rather than two lists, because they have to agree: the verify
// below finds the installed copy by searching these directories, so a list that
// spans hosts would hash a *different* editor's copy of the same version and
// report success for an install this never made.
const HOSTS = [
  {
    cli: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    extensions: [join(homedir(), '.vscode', 'extensions')]
  },
  {
    cli: '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
    extensions: [join(homedir(), '.vscode-insiders', 'extensions')]
  },
  {
    cli: '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide',
    // Two of these exist on this machine: `~/.antigravity` is a stale leftover
    // and `~/.antigravity-ide` is what the current host reads. Which one is live
    // is a property of the installed host, not of this repo, so look in both
    // rather than assume — looking in the wrong one reads as "never installed".
    extensions: [
      join(homedir(), '.antigravity-ide', 'extensions'),
      join(homedir(), '.antigravity', 'extensions')
    ]
  }
];

/**
 * Which hosts get the VSIX.
 *
 * Default: every known host whose CLI is on disk. Picking only the first one
 * present is how a machine with both VS Code and Antigravity ended up current
 * in one and stale in the other — the verify hashed the host it wrote and said
 * success, while the user was looking at the other.
 *
 * `SQUADRON_IDE_CLI` (or the legacy `ANTIGRAVITY_CLI`) pins a single host —
 * for a second profile, a fork, or a deliberate one-host install. An overridden
 * CLI this table does not know needs `SQUADRON_IDE_EXTENSIONS` too, since the
 * verify has to be told where that host puts the bytes.
 *
 * @returns {{ cli: string, extensions: string[] }[]}
 */
function resolveTargets() {
  const cliOverride = process.env.SQUADRON_IDE_CLI ?? process.env.ANTIGRAVITY_CLI;
  const extensionsOverride =
    process.env.SQUADRON_IDE_EXTENSIONS ?? process.env.ANTIGRAVITY_EXTENSIONS;

  if (cliOverride) {
    const known = HOSTS.find((host) => host.cli === cliOverride);
    const extensions = extensionsOverride ? [extensionsOverride] : (known?.extensions ?? []);
    return [{ cli: cliOverride, extensions }];
  }

  // Extensions alone cannot name a host when several are present; pin a CLI.
  if (extensionsOverride) {
    const first = HOSTS.find((host) => existsSync(host.cli));
    if (!first) return [];
    return [{ cli: first.cli, extensions: [extensionsOverride] }];
  }

  return HOSTS.filter((host) => existsSync(host.cli)).map((host) => ({
    cli: host.cli,
    extensions: host.extensions
  }));
}

const TARGETS = resolveTargets();

/** How many built VSIX files to keep. Rollback reaches back about a week. */
const KEEP = 5;

const CACHE = join(ROOT, 'dist-releases');

const die = (message) => {
  observation.event('deploy:failure', { message });
  observation.failActive();
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const git = (args, soft = false) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    if (soft) return undefined;
    throw error;
  }
};

/** Every file under `dir`, relative to it, so two trees can be compared by name. */
const walk = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [relative(base, full)];
  });

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const { name, publisher } = manifest;

const args = process.argv.slice(2);
const plan = args.includes('--plan');
if (args.includes('--local') || args.includes('--skip-smoke'))
  die('deploy only installs tagged releases; use `npm run release` first');
const asked = args.find((arg) => !arg.startsWith('-'));
/**
 * Drop all but the newest `KEEP` built VSIX files.
 *
 * The sort is numeric per component: a string sort puts `.9` after `.10`, which
 * would sweep away the newest build first. Also reachable as `--sweep` alone,
 * which is how it is tested and how the directory is reclaimed by hand.
 *
 * `spare` is the file this run just installed, and it is never swept whatever
 * it sorts as. Promoting an old tag — deploy it, merge it, publish it —
 * rebuilds bytes whose version is below five newer ones, so sweeping on version
 * alone deleted the build a second after making it and left
 * `npm run publish -- <that tag>` saying "run `npm run deploy` first" for a tag
 * that had just been deployed.
 *
 */
function sweep(spare) {
  if (!existsSync(CACHE)) return [];
  const parts = (file) =>
    file
      .slice(name.length + 1, -'.vsix'.length)
      .split('.')
      .map(Number);
  const all = readdirSync(CACHE)
    .filter((file) => file.startsWith(`${name}-`) && file.endsWith('.vsix'))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      }
      return 0;
    });
  const dropped = all.slice(KEEP).filter((file) => file !== spare);
  for (const stale of dropped) {
    rmSync(join(CACHE, stale), { force: true });
  }
  return all.filter((file) => !dropped.includes(file));
}

if (args.includes('--sweep')) {
  console.log(sweep().join('\n'));
  process.exit(0);
}

// --- 1. which tag ----------------------------------------------------------

const VERSION_TAG = /^v\d+\.\d+\.\d+$/;

const annotated = (tag) => git(['cat-file', '-t', tag], true) === 'tag';

// A tag cut on another machine is not in this object database at all, and stale
// means silently installing an older one. Soft, because the tags already here
// are still a real answer: offline, a rollback to a tag in `dist-releases/`
// should install.
git(['fetch', '--quiet', '--tags', 'origin'], true);

/**
 * The newest release tag reachable from `HEAD`.
 *
 * From HEAD, and not from `origin/main`, because **this installs onto this
 * machine and nothing else**. Which branch a tag sits on decides whether it is
 * stable, and that question belongs to `publish.mjs`, which is the one command
 * with a public consequence. Deploy's whole job is to let you run a build
 * before it is anyone else's — a staging tag is the normal case here, not the
 * exception, and until 2026-08-07 it was refused outright.
 *
 * Not `git describe --tags --abbrev=0`: that answers with the *nearest* tag of
 * any kind, so a lightweight tag cut for something else wins over the release
 * behind it. And `-v:refname` rather than `-refname`, which sorts `.9` above
 * `.10`. Both observed in a scratch repository; see the task file.
 */
function newestTag() {
  const tags = git(['tag', '-l', '--merged', 'HEAD', '--sort=-v:refname'], true);
  for (const tag of (tags ?? '').split('\n').filter(Boolean)) {
    if (VERSION_TAG.test(tag) && annotated(tag)) return tag;
  }
  return undefined;
}

const tag = asked ?? newestTag();
if (!tag) die('no release tag reachable from HEAD — cut one with `npm run release`');

if (!git(['rev-parse', '--verify', '--quiet', tag], true)) die(`no such tag: ${tag}`);

// An annotated tag carries its own notes, which is what makes every release
// self-describing. Refusing a lightweight one is what forces them to exist.
if (!annotated(tag))
  die(`${tag} is a lightweight tag and carries no notes — releases are annotated`);

if (!VERSION_TAG.test(tag)) die(`${tag} is not a release tag (expected vYYYY.WW.N)`);

const tagObject = git(['cat-file', 'tag', tag]);
const gate = tagObject.match(/^Gate: check\+smoke ([0-9a-f]{40,64})$/gm) ?? [];
const tree = git(['rev-parse', `${tag}^{tree}`]);
if (gate.length !== 1 || gate[0] !== `Gate: check+smoke ${tree}`)
  die(`${tag} has no matching check and smoke result — cut it with \`npm run release\``);

const release = tag.slice(1);
let taggedManifest;
try {
  taggedManifest = JSON.parse(git(['show', `${tag}:package.json`]));
} catch {
  die(`${tag} has no readable package.json`);
}
const version = taggedManifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`${tag} has no numeric extension version`);
const cached = join(CACHE, `${name}-${release}.vsix`);

// The same question `publish.mjs` asks, asked here only to label the install —
// it refuses nothing. The fetch above refreshed `origin/main` along with the
// tags; offline, a stale ref is only ever older, so it errs towards "staging".
const staging = git(['merge-base', '--is-ancestor', tag, 'origin/main'], true) === undefined;

if (plan) {
  console.log(
    JSON.stringify({
      tag,
      version,
      source: existsSync(cached)
        ? 'cache'
        : candidates.deployBundles(ROOT, tag)
          ? 'candidate'
          : 'build',
      vsix: cached,
      staging,
      // Which hosts would get it, so the multi-host answer is checkable without
      // installing anything.
      hosts: TARGETS
    })
  );
  process.exit(0);
}

const observationDir = process.env.SQUADRON_RUN_OBSERVATION_DIR ?? observation.createRun('deploy');
const observationFile = observation.configure(observationDir);
const deployment = {
  tag,
  tree: git(['rev-parse', `${tag}^{tree}`]),
  tagObject: git(['rev-parse', tag]),
  staging,
  hosts: TARGETS
};
observation.event('deploy:identity', deployment);
const deployBegan = perf.performance.now();
let deploySource = 'cache';
process.once('exit', (exit) => {
  observation.write(join(observationDir, 'deploy-runtime.json'), {
    schema: 1,
    kind: 'deploy',
    identity: deployment,
    source: deploySource,
    observationFile,
    ms: perf.performance.now() - deployBegan,
    exit,
    outcome: exit === 0 ? 'passed' : 'failed'
  });
});

// --- 2. the VSIX: cached, or built from the tag ----------------------------

/** Extract the tagged tree into a tmpdir for packaging. */
function archiveTag() {
  const dir = mkdtempSync(join(tmpdir(), 'squadron-deploy-'));
  // `git archive` writes the tagged tree without touching a ref, a file or
  // HEAD — which is the whole reason this shape works. Concurrent sessions
  // share this checkout, so a worktree or a checkout here is out.
  execFileSync('sh', ['-c', 'git archive "$1" | tar -x -C "$2"', '_', tag, dir], {
    cwd: ROOT,
    stdio: 'pipe'
  });
  const archived = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  if (archived !== version) die(`${tag} contains version ${archived}, expected ${version}`);
  return dir;
}

// What actually gets installed: the cache entry on a hit, the freshly built
// file in the tmpdir otherwise. They are the same bytes either way — the
// difference is that a fresh build is not copied into `dist-releases/` until
// the install and the hash below have passed.
let source = cached;

let scratch;
try {
  if (!existsSync(cached)) {
    scratch = observation.measure('deploy:archive', archiveTag);

    const helperEnvironment = Object.assign(
      {},
      ...artifacts.HELPERS.map((helper) => artifacts.buildEnvironment(helper, ROOT))
    );
    const run = (command) =>
      execFileSync('sh', ['-c', command], {
        cwd: scratch,
        stdio: 'inherit',
        env: { ...process.env, ...helperEnvironment }
      });
    const began = perf.performance.now();
    const preparation = observation.start('deploy:preparation');
    const candidate = candidates.deployBundles(ROOT, tag, join(scratch, 'dist'));
    deploySource = candidate ? 'candidate' : 'build';
    if (candidate) {
      console.log(`deploy: reused tested bundles from candidate ${candidate}`);
      if (taggedManifest.scripts?.['vscode:prepublish']) run('npm ci --silent');
    } else {
      console.log(`deploy: building ${tag} from a clean archive`);
      run('npm ci --silent');
      run(
        existsSync(join(scratch, 'scripts/esbuild.mjs'))
          ? 'node scripts/esbuild.mjs'
          : 'node esbuild.mjs'
      );
    }
    const tested = packagedBundles.hashes(join(scratch, 'dist'));
    console.log(
      `deploy: bundles (${candidate ? 'candidate' : 'build'}) ${(perf.performance.now() - began).toFixed(0)}ms`
    );
    preparation.end('passed', { source: deploySource, candidate });
    const packaging = perf.performance.now();
    const packageCommand =
      PACKAGE +
      (taggedManifest.squadronBuild === 'posix-staging' ? ' --allow-unused-files-pattern' : '');
    observation.measure('deploy:package', () => run(packageCommand));
    console.log(`deploy: packaging ${(perf.performance.now() - packaging).toFixed(0)}ms`);

    const built = join(scratch, 'release.vsix');
    if (!existsSync(built)) die('the build produced no release.vsix');
    observation.measure('deploy:package-hash', () => packagedBundles.verify(built, tested));
    source = built;
  } else {
    console.log(`deploy: ${tag} is already built — installing from dist-releases/`);
    observation.measure('deploy:package-hash', () => packagedBundles.verify(cached));
  }

  observation.event('deploy:source', { source: deploySource });
  install(source, version, staging);

  // Only now. `dist-releases/` is the whole of what `publish.mjs` will offer a
  // gallery, so an entry here has to mean the install and the hash passed —
  // every `die()` inside `installInto` is a build that must not become
  // publishable bytes. Copying before the install is what let a host rejection,
  // a wrong-directory install or a hash mismatch leave one behind.
  if (source !== cached) {
    mkdirSync(CACHE, { recursive: true });
    copyFileSync(source, cached);
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

// --- 3. keep the cache small ------------------------------------------------

sweep(`${name}-${release}.vsix`);

/**
 * Install a VSIX into one host and prove the bytes on disk are the ones in it.
 *
 * The comparison is against the VSIX rather than against this checkout's
 * `dist/`, which is the tree the deploy no longer trusts — and a cached
 * rollback has no `dist/` here to compare with at all.
 *
 * Each host is verified against *its own* extension directories only: hashing
 * another editor's copy of the same version is how a wrong-host install used
 * to pass.
 */
function installInto(vsix, built, target) {
  const { cli, extensions } = target;
  if (!existsSync(cli)) die(`no IDE CLI at ${cli} (set SQUADRON_IDE_CLI)`);
  if (extensions.length === 0)
    die(`nothing knows where ${cli} installs — set SQUADRON_IDE_EXTENSIONS`);

  console.log(`deploy: installing ${name}-${built}.vsix into ${cli}`);
  try {
    // `--force` makes an install of an already present version replace its
    // bytes, which a rollback or repeat deploy must do.
    observation.measure(
      'deploy:install',
      () => runHostCli(cli, ['--install-extension', vsix, '--force']),
      { target: cli }
    );
  } catch {
    die(`the host rejected the install at ${cli} (see its output above)`);
  }

  const verification = observation.start('deploy:installed-hash', { target: cli });
  const installedName = `${publisher}.${name}-${built}`;
  const installed = extensions
    .map((dir) => join(dir, installedName))
    .find((dir) => existsSync(dir));
  if (!installed)
    die(
      `install reported success but ${installedName} is in none of:\n       ${extensions.join('\n       ')}`
    );

  const unpacked = mkdtempSync(join(tmpdir(), 'squadron-verify-'));
  try {
    zip.extract(vsix, 'extension/dist/', unpacked);
    const shipped = join(unpacked, 'extension', 'dist');
    if (!existsSync(shipped)) die(`${vsix} contains no dist/ — it was packaged wrong`);

    const installedDist = join(installed, 'dist');
    if (!existsSync(installedDist)) die(`${installed} has no dist/`);

    const files = walk(shipped);
    const mismatched = files.filter(
      (file) =>
        !existsSync(join(installedDist, file)) ||
        sha(join(shipped, file)) !== sha(join(installedDist, file))
    );
    if (mismatched.length > 0)
      die(
        `installed bytes are not this build — the install silently did nothing:\n       ${mismatched.join('\n       ')}\n` +
          `       installed at ${installed}`
      );

    // `dist/` is the same in a staging and a stable install of one tag, so the
    // hash above cannot tell them apart — this is what proves the label landed.
    const label = (manifest) => JSON.parse(manifest).displayName;
    const packaged = label(zip.entry(vsix, 'extension/package.json'));
    const onDisk = label(readFileSync(join(installed, 'package.json')));
    if (onDisk !== packaged) die(`installed as "${onDisk}", not "${packaged}" — at ${installed}`);

    verification.end('passed', { files: files.length });
    console.log(`deploy: verified ${files.length} files as "${onDisk}" at ${installed}`);
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

/** Install the VSIX into every resolved host and verify each copy. */
function install(vsix, built, staging) {
  if (TARGETS.length === 0)
    die(
      `no IDE found — set SQUADRON_IDE_CLI. Looked for:\n       ${HOSTS.map((host) => host.cli).join('\n       ')}`
    );

  const installed = staging ? stagingCopy(vsix) : vsix;
  if (staging) console.log('deploy: not on main — installing as (STG)');
  for (const target of TARGETS) installInto(installed, built, target);
  if (installed !== vsix) rmSync(dirname(installed), { recursive: true, force: true });

  console.log(
    TARGETS.length === 1
      ? 'deploy: reload the IDE window (Developer: Reload Window) to run it'
      : `deploy: reload each IDE window (${TARGETS.length} hosts) to run it`
  );
}

/**
 * A copy of `vsix` whose manifest `displayName` ends in "(STG)".
 *
 * A copy, because a staging tag is promoted by merging it into `main`, and
 * `publish.mjs` then sends the bytes in `dist-releases/` unchanged — a mark
 * packaged in would reach the galleries. Only `extension/package.json` is
 * rewritten, and the panel's tab takes its title from its `displayName`. The
 * Extensions list does not: VS Code shows the gallery's name once the ID is on
 * Open VSX or the Marketplace (`extensionsWorkbenchService.ts`, `displayName`).
 */
function stagingCopy(vsix) {
  const dir = mkdtempSync(join(tmpdir(), 'squadron-stg-'));
  const copy = join(dir, basename(vsix));
  copyFileSync(vsix, copy);
  const stamped = JSON.parse(zip.entry(copy, 'extension/package.json').toString('utf8'));
  stamped.displayName = `${stamped.displayName} (STG)`;
  zip.replace(copy, 'extension/package.json', Buffer.from(`${JSON.stringify(stamped, null, 2)}\n`));
  return copy;
}

/**
 * Run a host's CLI. On win32 that CLI is a `.cmd` (VS Code's `bin/code.cmd`),
 * which Node refuses to spawn without a shell since its CVE-2024-27980 fix, so
 * it goes through cmd.exe with each argument quoted and checked.
 */
function runHostCli(cli, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(cli))
    return execFileSync(cli, args, { stdio: 'inherit' });
  const line = [cli, ...args].map(cmdWord).join(' ');
  return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    stdio: 'inherit',
    windowsVerbatimArguments: true
  });
}

// cmd.exe expands `%VAR%` and `!VAR!` inside quotes and reads `"` as a quote
// toggle; every argument here is a path, so one carrying those is refused.
function cmdWord(arg) {
  if (/["%!\r\n]/.test(arg)) die(`cannot pass ${arg} through cmd.exe`);
  return `"${arg}"`;
}
