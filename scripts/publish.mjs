// Publish a release to the extension galleries. The bytes come from a VSIX this
// machine already built and installed from a tested release tag.
//
//   npm run publish -- v2026.32.17            -> Open VSX, then the Marketplace
//   npm run publish -- v2026.32.17 --plan     -> print what it would do, publish nothing
//   npm run publish -- v2026.32.17 --only ovsx   -> one gallery
//
// This is a third act, deliberately separate from the two that already exist.
// `release.mjs` cuts a tag and `deploy.mjs` installs one, and both are cheap
// precisely because nothing they do is public: a tag can be cut to try
// something, and a bad install is fixed by installing the tag before it. A
// gallery is neither. A published version cannot be re-published — the number
// is spent even if the build is unpublished afterwards — and users on
// auto-update take it within hours. So publishing names its tag, every time,
// and nothing about `npm run release` reaches a gallery on its own.
//
// The gate is `dist-releases/`, which only a *tagged* deploy writes to, and
// only once the install and hash have passed. Release ran `check` and real-IDE
// smoke on the tagged source before the tag was cut; deploy bundled and
// installed that source, then verified the bytes on disk.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as zip from './zip.mjs';
import * as bundles from './packaged-bundles.mjs';

const ROOT = join(import.meta.dirname, '..');

const die = (message) => {
  console.error(`publish: ${message}`);
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

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const { name, publisher } = manifest;

const CACHE = join(ROOT, 'dist-releases');

// What a stable release must be an ancestor of, and the only place in this
// repo where a branch decides anything. `release.mjs` tags whatever branch you
// are on and `deploy.mjs` installs any tag it can reach, so the whole notion of
// a stable channel is this one line: a tag becomes publishable when the branch
// carrying it is merged into `main`, and not before.
//
// Overridable so the tests can build a repository with no remote, and so a fork
// can point it somewhere else. Do not export it.
const RELEASE_REF = process.env.PUBLISH_REF ?? 'origin/main';

// The galleries, in the order they are published to. Open VSX first because it
// is the one the host this is built against actually reads — a Marketplace
// failure should not hold up the users who are on a fork. `token` is read at
// call time so `--plan` can report presence without the value.
//
// A command line is not a secret channel: `ps` reads it, the `npx` shim
// inherits it, and a shell trace records it. So a token belongs in the
// environment `execFileSync` already hands down, and reaches `command` only
// where the tool gives us no other way.
const GALLERIES = [
  {
    id: 'ovsx',
    label: 'Open VSX',
    token: 'OVSX_PAT',
    // `ovsx` publishes a packaged VSIX positionally. The namespace must exist
    // first — `npx ovsx create-namespace <publisher>`, once per account.
    //
    // This is the one `--pat` left, and it stays until someone reads the
    // installed package. `ovsx`'s own README says an `OVSX_PAT` in the
    // environment is taken instead, but its source disagrees: `publish.ts`
    // defers to `getPAT`, and `cli/src/pat.ts` falls back to a **cached token
    // store** and then to an **interactive prompt**, with no `process.env` read
    // on that path. Dropping the flag on the README's word risks a publish that
    // hangs on a prompt, or one that quietly spends another account's cached
    // token. Verify, then delete — do not assume symmetry with `vsce`.
    command: (vsix, token) => ['npx', '--yes', 'ovsx', 'publish', vsix, '--pat', token]
  },
  {
    id: 'vsce',
    label: 'VS Code Marketplace',
    token: 'VSCE_PAT',
    // No `--pat`. `vsce` declares the option as
    // `.option('-p, --pat <token>', '… (defaults to VSCE_PAT environment
    // variable)', process.env['VSCE_PAT'])` — verified in the installed package
    // — so the token this process already holds is the default, and passing it
    // again would only copy it into argv.
    command: (vsix) => ['npx', '--yes', '@vscode/vsce', 'publish', '--packagePath', vsix]
  }
];

const args = process.argv.slice(2);
const plan = args.includes('--plan');
if (args.includes('--unsmoked'))
  die('--unsmoked is no longer used; release runs smoke before tagging');
const only = args[args.indexOf('--only') + 1];
if (args.includes('--only') && !GALLERIES.some((gallery) => gallery.id === only))
  die(`--only takes ${GALLERIES.map((gallery) => gallery.id).join(' or ')}`);
const targets = args.includes('--only')
  ? GALLERIES.filter((gallery) => gallery.id === only)
  : GALLERIES;

// --- 1. which tag ----------------------------------------------------------

// No default. `deploy.mjs` can pick the newest tag for you because installing
// the wrong one costs an install; publishing the wrong one costs a version
// number nobody can reuse.
const tag = args.find((arg, at) => !arg.startsWith('-') && args[at - 1] !== '--only');
if (!tag) die('name the tag to publish, e.g. `npm run publish -- v2026.32.17`');

const VERSION_TAG = /^v\d+\.\d+\.\d+$/;
if (!VERSION_TAG.test(tag)) die(`${tag} is not a release tag (expected vYYYY.WW.N)`);

// A tag pushed from another machine is not in this object database yet, and a
// stale `origin/main` reads as "never merged". Soft: the cached refs are still
// a real answer offline, and the checks below are what decide.
//
// It refreshes whatever `RELEASE_REF` names rather than `main`, or an
// overridden ref would decide ancestry against something this run never
// fetched — which is the staleness the paragraph above says it is here to
// prevent, pointed at the one case that needs it most.
const [REMOTE, ...REST] = RELEASE_REF.split('/');
const REMOTE_BRANCH = REST.join('/');
git(
  REMOTE_BRANCH
    ? ['fetch', '--quiet', '--tags', REMOTE, REMOTE_BRANCH]
    : ['fetch', '--quiet', '--tags'],
  true
);

if (!git(['rev-parse', '--verify', '--quiet', tag], true)) die(`no such tag: ${tag}`);

if (git(['cat-file', '-t', tag], true) !== 'tag')
  die(`${tag} is a lightweight tag and carries no notes — releases are annotated`);

const tagObject = git(['cat-file', 'tag', tag]);
const gate = tagObject.match(/^Gate: check\+smoke ([0-9a-f]{40,64})$/gm) ?? [];
const tree = git(['rev-parse', `${tag}^{tree}`]);
if (gate.length !== 1 || gate[0] !== `Gate: check+smoke ${tree}`)
  die(`${tag} has no matching check and smoke result — cut it with \`npm run release\``);

if (!git(['rev-parse', '--verify', '--quiet', RELEASE_REF], true))
  die(`no ${RELEASE_REF} — fetch it, or set PUBLISH_REF`);

try {
  git(['merge-base', '--is-ancestor', `${tag}^{commit}`, RELEASE_REF]);
} catch {
  die(
    `${tag} is not an ancestor of ${RELEASE_REF} — it is not stable yet.\n` +
      `       Merge the branch carrying it into main, then publish the same tag.`
  );
}

const release = tag.slice(1);
let version;
try {
  version = JSON.parse(git(['show', `${tag}:package.json`])).version;
} catch {
  die(`${tag} has no readable package.json`);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`${tag} has no numeric extension version`);

const changelog = git(['show', `${tag}:CHANGELOG.md`], true) ?? '';
const entry = changelog
  .split(/^##[ \t]+/m)
  .find((section) => section.split(/\r?\n/)[0].trim() === version);
if (!entry?.split(/\r?\n/).slice(1).join('\n').trim())
  die(
    `${tag} has no nonempty \`## ${version}\` entry in CHANGELOG.md — cut a new release with notes`
  );

// --- 2. which bytes --------------------------------------------------------

const vsix = join(CACHE, `${name}-${release}.vsix`);
if (!existsSync(vsix))
  die(
    `no ${name}-${release}.vsix in dist-releases/ — run \`npm run deploy -- ${tag}\` first.\n` +
      `       A gallery gets bytes this machine built from the tested tag and installed.`
  );

/**
 * The manifest inside the VSIX, read from the package it actually is.
 *
 * The name of a file is not evidence of what is in it — `dist-releases/` is a
 * plain directory, and a hand-copied or renamed VSIX would otherwise publish
 * one build under another's number, which is the one mistake here with no undo.
 *
 * Read the member without extraction; malformed archives, missing members and
 * invalid JSON all refuse the package.
 */
function packagedManifest(file) {
  try {
    return JSON.parse(zip.entry(file, 'extension/package.json').toString('utf8'));
  } catch {
    die(`${file} has no readable extension/package.json — it is not a VSIX`);
  }
}

const packaged = packagedManifest(vsix);
const members = zip.names(vsix);
// Microsoft's publishing requirements do not require Authenticode signatures on
// bundled helper EXEs (checked 2026-10-31):
// https://code.visualstudio.com/api/working-with-extensions/publishing-extension
if (
  members.some((name) =>
    /^extension\/dist\/helpers\/(private-files|console-login)-v1\.(exe|json)$/i.test(name)
  )
) {
  try {
    bundles.verify(vsix);
  } catch (error) {
    die(`Windows helper verification failed: ${error.message}`);
  }
}
if (packaged.version !== version)
  die(`${vsix} contains version ${packaged.version}, not ${version}`);
if (packaged.publisher !== publisher || packaged.name !== name)
  die(`${vsix} is ${packaged.publisher}.${packaged.name}, not ${publisher}.${name}`);
if (packaged.private)
  die(`${vsix} was packaged with "private": true — no gallery accepts a private extension`);

let packagedChangelog;
try {
  const member = members.find((name) => name.toLowerCase() === 'extension/changelog.md');
  if (!member) throw new Error('missing changelog');
  packagedChangelog = zip.entry(vsix, member).toString('utf8').trim();
} catch {
  die(`${vsix} has no readable extension/CHANGELOG.md`);
}
if (packagedChangelog !== changelog)
  die(`${vsix} contains a different CHANGELOG.md from ${tag} — rebuild it from the tag`);

// --- 3. the tokens ---------------------------------------------------------

// The gitignored file the tokens are kept in. `loadEnvFile` leaves a variable
// the environment already set alone, so an exported token still wins.
const TOKEN_FILE = join(ROOT, '.publish.env');
if (existsSync(TOKEN_FILE)) process.loadEnvFile(TOKEN_FILE);

const missing = targets.filter((gallery) => !process.env[gallery.token]);

if (plan) {
  console.log(
    JSON.stringify({
      tag,
      version,
      vsix,
      id: `${publisher}.${name}`,
      // Which ref decided this tag was stable. `PUBLISH_REF` replaces the whole
      // stable channel from the environment and says nothing when it does, so
      // a plan that did not name it could not tell you the gate had moved.
      ref: RELEASE_REF,
      galleries: targets.map((gallery) => ({
        id: gallery.id,
        label: gallery.label,
        token: gallery.token,
        // The value never leaves this process. Whether it is set is the only
        // thing worth printing, and the only thing a plan can check.
        ready: Boolean(process.env[gallery.token])
      }))
    })
  );
  process.exit(0);
}

if (missing.length > 0)
  die(
    `no ${missing.map((gallery) => gallery.token).join(' and no ')} in the environment or .publish.env.\n` +
      `       See docs/workflows/release.md § Publishing for where each comes from.`
  );

// --- 4. publish ------------------------------------------------------------

// Said out loud, and after `--plan` has exited so it cannot land in that JSON:
// the ref is what decided this tag may go public, and it is overridable.
console.log(`publish: ${tag} is an ancestor of ${RELEASE_REF} — stable`);

// One gallery at a time, and loudly ordered: a failure on the second is not a
// failure of the whole thing, because the first is already public and cannot be
// taken back. Saying so is the difference between a retry and a spent version.
const logDirectory = resolve(ROOT, git(['rev-parse', '--git-common-dir']));
const logFile = join(logDirectory, 'squadron-publish.jsonl');
const record = {
  run: randomUUID(),
  tag,
  version,
  commit: git(['rev-parse', `${tag}^{commit}`]),
  id: `${publisher}.${name}`,
  ref: RELEASE_REF,
  vsixSha256: createHash('sha256').update(readFileSync(vsix)).digest('hex')
};

const done = [];
for (const gallery of targets) {
  recordGallery(gallery, 'started');
  console.log(`publish: ${tag} -> ${gallery.label}`);
  const [command, ...rest] = gallery.command(vsix, process.env[gallery.token]);
  try {
    execFileSync(command, rest, { cwd: ROOT, stdio: 'inherit' });
  } catch {
    recordGallery(gallery, 'failed');
    const already = done.length > 0 ? ` — ${done.join(' and ')} already has it` : '';
    die(`${gallery.label} rejected ${tag}${already} (see its output above)`);
  }
  recordGallery(gallery, 'published');
  done.push(gallery.label);
}

console.log(`publish: ${publisher}.${name} ${version} is on ${done.join(' and ')}`);

function recordGallery(gallery, status) {
  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({ at: new Date().toISOString(), ...record, gallery: gallery.id, status })}\n`
    );
  } catch {
    die(`cannot record ${gallery.label} ${status} in ${logFile} — see the publish output above`);
  }
}
