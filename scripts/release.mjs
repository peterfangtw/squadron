// Cut a release: a calendar tag pins the commit and its extension version.
//
//   npm run release                 -> draft notes, check, smoke, tag, push
//   npm run release -- --dry        -> print the version and the draft, write nothing
//   npm run release -- --notes f    -> take the notes from a file, no editor
//   npm run release -- --no-push    -> tag locally and stop
//   npm run release -- --version 0.2.0 -> choose the extension version
//
// This replaces `bump.mjs` and `deploy-main.sh`, which were two steps that could
// disagree — and did: on 2026-07-29 a deploy shipped two different builds both
// calling themselves 2026.31.8, because the bump question was asked with zsh
// `read -q`, which cannot read from a pipe and silently answered no. There is no
// prompt here to mis-answer. The editor on the notes is the only interaction,
// and abandoning it releases nothing.
//
// The tag is what `deploy.mjs` builds from, so a release is complete the moment
// it is pushed. Nothing downstream reads this checkout.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as candidates from './release_candidate.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const die = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

/** git, in this checkout, trimmed. `soft` returns undefined instead of throwing. */
const git = (args, soft = false) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    if (soft) return undefined;
    throw error;
  }
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const dry = flag('--dry');
const noPush = flag('--no-push');
const notesFile = value('--notes');
const withoutWindowsHelper = flag('--without-windows-helper');

if (flag('--resume') || flag('--inspect')) {
  if (flag('--resume') && (flag('--version') || flag('--notes') || withoutWindowsHelper))
    die(
      '--resume keeps the candidate version, notes and build mode; start a new release to change them'
    );
  try {
    const c = candidates.inspect(ROOT, value(flag('--inspect') ? '--inspect' : '--resume'));
    if (flag('--inspect') || dry) console.log(JSON.stringify(c.manifest, null, 2));
    else await candidates.execute(ROOT, c, { noPush });
  } catch (error) {
    die(error.message);
  }
  process.exit(0);
}

// --- 1. where we are -------------------------------------------------------

// Any branch. A release tags the branch it is cut from and pushes that branch —
// it does not move `main`, and it did until 2026-08-07, which is the whole
// reason this file used to argue about branches and worktrees.
//
// The channel is the branch the tag ends up on, and merging is what puts it
// there: a tag cut on `staging` installs with `npm run deploy` and is refused by
// `npm run publish`, and the same tag becomes publishable when `staging` merges
// into `main`. A merge happens because someone merged, rather than as a side
// effect of releasing.
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], true);
if (!branch) die('not a git checkout');
if (branch === 'HEAD') die('detached HEAD — check out the branch you mean to release');
if (withoutWindowsHelper && (branch !== 'staging' || process.platform === 'win32'))
  die('--without-windows-helper is allowed only on staging on POSIX');

// Pick up anything already pushed to this branch before the version is counted,
// so the bump lands on top of it. Offline, or with no remote, is not a failure:
// the push at the end is where a real divergence surfaces.
if (!dry) {
  git(['fetch', '--quiet', 'origin', branch], true);
  git(['merge', '--ff-only', '--quiet', `origin/${branch}`], true);
}

// --- 2. the version --------------------------------------------------------

const VERSION_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * The newest release tag reachable from `ref`, or undefined.
 *
 * Version-sorted rather than `git describe --abbrev=0`, which answers with the
 * *nearest* tag of any kind — a lightweight tag cut for something else would
 * win. And `-v:refname` rather than `-refname`, which sorts `.9` above `.10`.
 * Both observed; see the task file.
 */
function newestTag(ref) {
  const tags = git(['tag', '-l', '--merged', ref, '--sort=-v:refname'], true);
  for (const tag of (tags ?? '').split('\n').filter(Boolean)) {
    if (!VERSION_TAG.test(tag)) continue;
    if (git(['cat-file', '-t', tag], true) === 'tag') return tag;
  }
  return undefined;
}

/**
 * The next `YYYY.WW.N`: ISO year, ISO week, and a counter that restarts each
 * week — `2026.31.2` is the second release of week 31. vsce only accepts a
 * numeric major.minor.patch, which is what rules out a name prefix or a
 * zero-padded `01`; the extension id already carries the name.
 *
 * `RELEASE_NOW` (an ISO date) overrides the clock so the week roll is testable.
 */
function nextVersion(current, now) {
  // ISO-8601: the week owning this date's Thursday, which is also what decides
  // the year — the first days of January can belong to the previous ISO year.
  const thursday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);

  const [curYear, curWeek, curCount] = current.split('.');
  const same = curYear === String(year) && curWeek === String(week);
  return `${year}.${week}.${same ? Number(curCount) + 1 : 1}`;
}

const stamp = process.env.RELEASE_NOW;
const now = stamp ? new Date(stamp) : new Date();
if (Number.isNaN(now.getTime())) die(`RELEASE_NOW is not a date: ${stamp}`);

const manifestFile = join(ROOT, 'package.json');
const manifestRaw = readFileSync(manifestFile, 'utf8');
const manifestVersion = JSON.parse(manifestRaw).version;

// The tag set is the record of what shipped, so it answers first. package.json
// is the bootstrap: before the first tag there is nothing else to count from.
const previous = newestTag('HEAD');
const version = nextVersion(previous ? previous.slice(1) : manifestVersion, now);
const tag = `v${version}`;
const requestedVersion = value('--version');
if (flag('--version') && !requestedVersion) die('--version needs a numeric major.minor.patch');
const separateVersion = previous && manifestVersion !== previous.slice(1);
const publicVersion =
  requestedVersion ??
  (separateVersion
    ? manifestVersion.replace(/\d+$/, (patch) => String(Number(patch) + 1))
    : version);
if (!/^\d+\.\d+\.\d+$/.test(publicVersion))
  die(`extension version must be numeric major.minor.patch: ${publicVersion}`);
if (separateVersion) {
  const parts = publicVersion.split('.').map(Number);
  const current = manifestVersion.split('.').map(Number);
  const first = parts.findIndex((part, index) => part !== current[index]);
  if (first === -1 || parts[first] < current[first])
    die(`extension version ${publicVersion} must advance past ${manifestVersion}`);
}

if (git(['rev-parse', '--verify', '--quiet', tag], true)) die(`${tag} already exists`);

// --- 3. the notes ----------------------------------------------------------

const range = previous ? `${previous}..HEAD` : 'HEAD';
const log = git(['log', range, '--oneline', '--no-merges'], true) ?? '';

const template =
  `${tag}\n\n${log}\n\n` +
  `# The commits above are a draft — rewrite them into notes.\n` +
  `# Lines starting with # are dropped. An empty message cancels the release.\n` +
  (previous ? `# Range: ${range}\n` : `# First release: the whole history.\n`);

/** The message with comment lines and surrounding blank lines removed. */
const strip = (text) =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();

let notes;
if (notesFile) {
  notes = strip(readFileSync(notesFile, 'utf8'));
} else if (dry) {
  notes = strip(template);
} else {
  // Edited *before* anything is written, so an abandoned editor leaves the
  // checkout untouched rather than a bumped commit with no tag to pin it.
  const scratch = mkdtempSync(join(tmpdir(), 'squadron-release-'));
  const file = join(scratch, 'TAG_EDITMSG');
  writeFileSync(file, template);
  const editor = git(['var', 'GIT_EDITOR'], true) ?? 'vi';
  try {
    execFileSync('sh', ['-c', `${editor} "$1"`, '_', file], { stdio: 'inherit' });
    notes = strip(readFileSync(file, 'utf8'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A tag with no notes is a lightweight tag with extra steps, and `deploy.mjs`
// refuses those. Refusing here is what makes every release carry its own record.
if (!notes || notes === tag) die('no notes — nothing released');

if (dry) {
  console.log(version);
  console.log(`extension version: ${publicVersion}`);
  if (withoutWindowsHelper) console.log('Build without Windows helpers');
  console.log(notes);
  process.exit(0);
}

// --- 4. prove the tag's source ---------------------------------------------

// One line rewritten rather than re-serialised: JSON.stringify would drop the
// field order and prettier's formatting, making every release a big diff.
const updated = manifestRaw
  .replace(/^ {2}"squadronBuild": "posix-staging",\r?\n/m, '')
  .replace(
    `"version": "${manifestVersion}"`,
    `"version": "${publicVersion}"` +
      (withoutWindowsHelper ? ',\n  "squadronBuild": "posix-staging"' : '')
  );
if (updated === manifestRaw) die(`no "version": "${manifestVersion}" line in package.json`);

// The archive is HEAD plus the version bump: exactly what the tag will name.
// Testing it here keeps another session's uncommitted files out of the answer.
if (
  execFileSync('git', ['show', 'HEAD:package.json'], { cwd: ROOT, encoding: 'utf8' }) !==
  manifestRaw
)
  die('commit package.json changes before releasing');
const head = git(['rev-parse', 'HEAD']);
const changelog = git(['show', `${head}:CHANGELOG.md`], true) ?? '';
const entry = changelog
  .split(/^##[ \t]+/m)
  .find((section) => section.split(/\r?\n/)[0].trim() === publicVersion);
if (!entry?.split(/\r?\n/).slice(1).join('\n').trim())
  die(`commit a nonempty \`## ${publicVersion}\` entry in CHANGELOG.md before releasing`);
if (git(['diff', head, '--', 'CHANGELOG.md']))
  die('commit CHANGELOG.md changes before releasing — only committed notes ship');
try {
  const candidate = await candidates.prepare(ROOT, {
    parent: head,
    branch,
    tag,
    publicVersion,
    manifestRaw,
    updated,
    notes,
    noPush
  });
  await candidates.execute(ROOT, candidate, { noPush });
} catch (error) {
  die(error.message);
}
