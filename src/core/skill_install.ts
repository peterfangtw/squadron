import * as platform from './platform';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Writes our bundled skills into `~/<cli>/skills/` — one CLI's
 * directory per call, named by that brand's `CliAdapter.skillRoot` — and
 * refuses to write anything else.
 *
 * The shims in `~/.squadron/bin/` are rewritten on every activation with no
 * checks at all, and that is right for them: the tree is ours, the files are
 * compiled bundles, nobody edits them. None of that survives the move to a
 * CLI's directory, which is the reader's. So this module answers one question before
 * every write — *is the file at that path ours, unedited, and not from a newer
 * build than this one* — and leaves it alone whenever the answer is no.
 *
 * Ownership is carried by the file itself: a trailing comment naming the
 * version that wrote it, the sha256 of everything above it, and a shared bundle
 * revision for same-version selection. No ownership sidecar. One
 * under `~/.squadron/` would stop being ours the first time that tree is
 * swept, leaving our own file permanently unrecognisable; one inside the skill
 * directory would put a file of ours somewhere the CLI scans.
 *
 * **There is no uninstall.** Settings are per IDE install, not per machine, and
 * the flag defaults off — so a delete at activation means the window where the
 * reader never set it deletes the file the window where they did just wrote, at
 * every launch, forever. A skill left on disk while the flag is off documents
 * verbs that refuse with a reason, which is idle rather than wrong.
 *
 * No `vscode` import: plain fs and text, tested headlessly like `hooks.ts`.
 */

/** The skill's directory name, and so the name it is invoked by. */
export const SKILL_NAME = 'squadron';

export const SKILL_FILES = [
  { skill: SKILL_NAME, name: 'SKILL.md' },
  { skill: SKILL_NAME, name: 'agents/openai.yaml' },
  { skill: 'squadron-workflow-builder', name: 'SKILL.md' },
  { skill: 'squadron-workflow-builder', name: 'agents/openai.yaml' },
  { skill: 'squadron-workflow-builder', name: 'FORMAT.md' },
  { skill: 'squadron-workflow-builder', name: 'LANES.md' },
  { skill: 'squadron-heavy-runs', name: 'SKILL.md' },
  { skill: 'squadron-heavy-runs', name: 'agents/openai.yaml' }
] as const;

export type SkillFile = (typeof SKILL_FILES)[number];

/** What one attempt did, for the log. Every value but `written` and `current`
 *  means the file on disk was left exactly as it was found. */
export type SkillInstallOutcome =
  | 'written'
  | 'current'
  | 'left-foreign'
  | 'left-newer'
  | 'left-tie'
  | 'no-cli-dir'
  | 'unsafe-path'
  | 'failed';

/** A `CliAdapter.skillRoot` as the two arguments every call here takes: the
 *  directory the walk trusts, and the CLI's directory inside it. */
export function skillTarget(root: string): [cliDir: string, parent: string] {
  // A filesystem root is its own parent, and a UNC share's `basename` still names it.
  return path.dirname(root) === root ? ['', root] : [path.basename(root), path.dirname(root)];
}

/** Where it goes for one CLI, by the two halves of `skillTarget`. */
export function skillPaths(
  cliDir: string,
  parent: string,
  asset: SkillFile = SKILL_FILES[0]
): {
  cliRoot: string;
  dir: string;
  file: string;
} {
  const cliRoot = path.join(parent, cliDir);
  const dir = path.join(cliRoot, 'skills', asset.skill);
  return { cliRoot, dir, file: path.join(dir, asset.name) };
}

/**
 * The text the hash is taken over.
 *
 * Trailing whitespace per line and trailing blank lines are removed, because
 * without that a reader who opens the file to see what was installed and saves
 * it out of habit trips `files.trimTrailingWhitespace` or
 * `files.insertFinalNewline`, the hash stops matching, and the file is foreign
 * *forever* — no upgrade ever lands again and the only signal is a line in an
 * output channel. Cosmetic saves survive; a real edit still wins.
 */
export function normaliseBody(text: string): string {
  // `\r` is line-trailing whitespace here, and that is the whole CRLF fix.
  // `files.eol` defaults to `auto`, which is `\r\n` on Windows, so a reader
  // there who opens the file and saves rewrites every line without touching a
  // character — and the file would be foreign forever, which is the exact
  // failure this function exists to prevent, by default, on that platform.
  //
  // Not a `\r\n` → `\n` pass: `readInstalledText` splits on `\n` and hashes the
  // body it rejoins, so by then each line's `\r` has no `\n` after it to match.
  // Stripping at the line end catches it in both callers.
  return text.replace(/[ \t\r]+$/gm, '').replace(/\n*$/, '\n');
}

function hashOf(body: string): string {
  return createHash('sha256').update(normaliseBody(body)).digest('hex');
}

export function stampLine(
  body: string,
  version: string,
  format: 'markdown' | 'yaml' = 'markdown',
  bundleHash?: string
): string {
  const stamp = `squadron ${version} ${hashOf(body)}${bundleHash ? ` ${bundleHash}` : ''}`;
  return format === 'yaml' ? `# ${stamp}` : `<!-- ${stamp} -->`;
}

const STAMP = /^<!-- squadron (\S+) ([0-9a-f]{64})(?: ([0-9a-f]{64}))? -->$/;
const YAML_STAMP = /^# squadron (\S+) ([0-9a-f]{64})(?: ([0-9a-f]{64}))?$/;

/**
 * A calver as numbers, or nothing when it is not one.
 *
 * Nothing is the load-bearing case. The version being compared came off disk and
 * may have been written by a build that does not exist yet — a `-rc1` suffix or
 * a truncated `2026.34` parses to `NaN`, and *every* comparison involving `NaN`
 * is false, so "is the disk newer than us?" would answer no and we would
 * overwrite the one input that exists to make us back off.
 */
function parseVersion(text: string): number[] | undefined {
  const parts = text.split('.');
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    out.push(Number(part));
  }
  return out.length > 0 ? out : undefined;
}

/** Negative when `a` is older. Missing trailing parts count as zero, so
 *  `2026.34` sorts below `2026.34.1`. */
function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type Installed =
  | { kind: 'absent' }
  | { kind: 'foreign' }
  | { kind: 'ours'; version: number[]; hash: string; bundleHash?: string };

/**
 * What is at that path, in the only three terms the decision needs.
 *
 * `foreign` covers every way the file can fail to be ours — no stamp, a stamp
 * whose hash no longer matches the body above it, a version that will not parse.
 * They are one outcome because the action is one action: leave it.
 */
export function readInstalledText(text: string): Installed {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? '').trim() === '') last--;
  const finalLine = (lines[last] ?? '').trim();
  const stamp = STAMP.exec(finalLine) ?? YAML_STAMP.exec(finalLine);
  if (!stamp) return { kind: 'foreign' };
  const [, rawVersion = '', hash = '', bundleHash] = stamp;
  const version = parseVersion(rawVersion);
  if (!version) return { kind: 'foreign' };
  if (hashOf(lines.slice(0, last).join('\n')) !== hash) return { kind: 'foreign' };
  return { kind: 'ours', version, hash, ...(bundleHash ? { bundleHash } : {}) };
}

/**
 * Whether to write, given what is there and what we hold.
 *
 * The tie is the half a strict newer-than rule misses, and it is the *normal*
 * state while this feature is built: an Extension Development Host runs the
 * working tree at the same `package.json` version as the deployed VSIX with a
 * different `SKILL.md` in it. Both would write, on every activation, and the
 * file's contents would depend on which window opened last. Comparing the hashes
 * breaks it the same way in both processes, so the pair converges instead.
 */
export function decide(
  installed: Installed,
  ourVersion: number[],
  ourHash: string,
  ourBundleHash?: string
): 'write' | 'current' | 'left-foreign' | 'left-newer' | 'left-tie' {
  if (installed.kind === 'absent') return 'write';
  if (installed.kind === 'foreign') return 'left-foreign';
  const order = compareVersion(installed.version, ourVersion);
  if (order > 0) return 'left-newer';
  if (order < 0) return 'write';
  // One revision wins every file; separate file hashes can mix opposite policies.
  // A legacy stamp migrates once, and old installers leave the extended stamp alone.
  // ponytail: overlapping writers converge on later activations; use a per-skill
  // lock if installation ever needs to commit the whole bundle atomically.
  if (ourBundleHash !== installed.bundleHash) {
    if (!ourBundleHash) return 'left-tie';
    return !installed.bundleHash || ourBundleHash < installed.bundleHash ? 'write' : 'left-tie';
  }
  if (installed.hash === ourHash) return 'current';
  return ourHash < installed.hash ? 'write' : 'left-tie';
}

/** Unique per writer, and deliberately not ending in `.md`. Two windows
 *  activating in the same second would otherwise share one inode through a fixed
 *  name — `hooks.ts` uses one and survives it only because ownership there is a
 *  substring of a command it wrote, which outlives corruption around it. A
 *  whole-body hash does not: the interleaved write renames cleanly, mismatches
 *  its own stamp, and is foreign to every build from then on. */
let seq = 0;

/**
 * Every path component below the verified root is real, or we do not write.
 *
 * Resolving only the destination directory and the file is safe by luck of where
 * a link happens to sit. `~/.claude/skills` symlinked wholesale — ordinary
 * dotfile practice — moves it one component up, where neither check looks, and
 * the write lands inside whatever repository that link points at.
 *
 * The parent directory itself is resolved rather than compared, so a machine whose
 * home is a link is not refused for it; everything below is compared literally.
 * `writeFile` is what follows a link — `rename(2)` does not follow a final
 * component — so this runs immediately before the write rather than at read
 * time, which is also what keeps the TOCTOU window short.
 */
async function resolveDir(
  parent: string,
  cliDir: string,
  create: boolean,
  asset: SkillFile = SKILL_FILES[0]
): Promise<string | undefined> {
  let expected: string;
  try {
    expected = await fs.realpath(parent);
  } catch {
    return undefined;
  }
  // The CLI's directory is in the walk because the existence check above it is
  // an `fs.stat`, which follows a link and would call a symlinked `~/.claude` a
  // directory.
  for (const part of [cliDir, 'skills', asset.skill, ...asset.name.split('/').slice(0, -1)]) {
    expected = path.join(expected, part);
    try {
      if (!(await isItself(expected))) return undefined;
    } catch {
      // Not there yet. Nothing to distrust, and on the read-only pass nothing to
      // create either — a component that does not exist cannot be a link.
      if (!create) continue;
      try {
        await fs.mkdir(expected);
      } catch {
        // Losing a `mkdir` race is not evidence of a link, and treating it as
        // one meant the second of two windows restored at login reported
        // `unsafe-path` — the module's one alarming outcome, telling a reader to
        // go looking for a symlink that was never there — and installed nothing.
        // Re-verify instead: a link still fails this, a winner's directory does
        // not.
        try {
          if (!(await isItself(expected))) return undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return expected;
}

/**
 * Whether an existing component is what its path says rather than a link. A case
 * difference alone is not one: a moved root keeps the override's spelling, and a
 * case-insensitive volume answers `realpath` with the directory's own.
 */
async function isItself(component: string): Promise<boolean> {
  const real = await fs.realpath(component);
  if (real === component) return true;
  if (real.toLowerCase() !== component.toLowerCase()) return false;
  return !(await fs.lstat(component)).isSymbolicLink();
}

/**
 * Removes what a crashed write left behind.
 *
 * The temps sit inside a directory the CLI scans, which is the same objection
 * that ruled out keeping a sidecar there. One `try` per entry rather than one
 * around the loop: `fs.rm` throws on a directory without `recursive`, and with
 * the guard outside, one awkwardly-named entry ended the sweep and every later
 * temp survived it.
 *
 * A temp belonging to a live writer is left alone — deleting one between its
 * `writeFile` and its `rename` costs that writer a spurious `failed`, and its
 * pid is right there in the name.
 */
async function sweepTemps(dir: string, fileName: string): Promise<void> {
  const prefix = `${fileName}.`;
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const temp = /^([1-9]\d*)\.\d+\.tmp$/.exec(name.slice(prefix.length));
    if (!temp) continue;
    const pid = Number(temp[1]);
    if (pid !== process.pid && isLive(pid)) continue;
    await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

/** Whether a temp names a process that still exists. `kill(pid, 0)` throws
 *  `ESRCH` when it does not, and `EPERM` when it does and is not ours — which is
 *  still alive, so only `ESRCH` counts as gone. */
function isLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * What a reader is told about one CLI's copy, without writing anything.
 * `undefined` when the CLI has no directory here — the case `installSkill`
 * calls `no-cli-dir`. `foreign` is every path the installer will not write:
 * a file it did not write or cannot read, and a link anywhere on the way, so
 * the reader is never told a switch will install what `unsafe-path` refuses.
 * An older stamp of ours is still `installed`, since the next activation
 * upgrades it.
 */
export async function skillStatus(
  cliDir: string,
  parent: string
): Promise<'installed' | 'missing' | 'foreign' | undefined> {
  const { cliRoot, file } = skillPaths(cliDir, parent);
  try {
    if (!(await fs.stat(cliRoot)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  if ((await resolveDir(parent, cliDir, false)) === undefined) return 'foreign';
  if ((await fs.lstat(file).catch(() => undefined))?.isSymbolicLink() === true) return 'foreign';
  try {
    const installed = readInstalledText(await fs.readFile(file, 'utf8'));
    return installed.kind === 'ours' ? 'installed' : 'foreign';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'foreign';
  }
}

/**
 * Installs the skill, or says why it did not.
 *
 * `sourceFile` is the vendored copy inside the extension — `install/skills/…` on
 * disk, so an upgrade ships new text the same way it ships new bundles.
 */
export async function installSkill(
  sourceFile: string,
  version: string,
  cliDir: string,
  parent: string,
  asset: SkillFile = SKILL_FILES[0],
  bundle?: { hash: string; body: string }
): Promise<SkillInstallOutcome> {
  if (!SKILL_FILES.some((file) => file.skill === asset.skill && file.name === asset.name))
    return 'failed';
  const ourVersion = parseVersion(version);
  if (!ourVersion) return 'failed';

  const { cliRoot, file } = skillPaths(cliDir, parent, asset);
  // No CLI, no skills directory to put anything in. Creating one would be this
  // extension inventing a tree for a program that is not installed.
  try {
    if (!(await fs.stat(cliRoot)).isDirectory()) return 'no-cli-dir';
  } catch {
    return 'no-cli-dir';
  }

  // Before the file is read, not just before it is written. Reading through a
  // link and judging what is on the other side would report the *target's*
  // contents as the reason — `left-foreign` about somebody's own skill — when
  // the fact worth telling them is that the path leaves the CLI's tree at all.
  const safeDir = await resolveDir(parent, cliDir, false, asset);
  if (safeDir === undefined) return 'unsafe-path';

  let source: string;
  try {
    source = bundle?.body ?? (await fs.readFile(sourceFile, 'utf8'));
  } catch {
    return 'failed';
  }
  const ourHash = hashOf(source);

  // Before the read, for the reason the directory walk runs before it: reading
  // through a link judges a document outside the CLI's tree and reports the
  // *target's* state as the reason, when the fact worth telling is that the path
  // leaves the tree at all.
  if ((await fs.lstat(file).catch(() => undefined))?.isSymbolicLink() === true) {
    return 'unsafe-path';
  }

  let installed: Installed = { kind: 'absent' };
  try {
    installed = readInstalledText(await fs.readFile(file, 'utf8'));
  } catch (err) {
    // **Only "not there" is `absent`.** Every other read failure used to land
    // here as `absent`, and `absent` means write — so a file we could not read
    // was a file we destroyed. The write is a `rename(2)` into the parent, which
    // needs no permission at all on the file it replaces, so a mode-000 or
    // root-owned `SKILL.md` was silently replaced and reported as `written`.
    // Same door for a symlink loop and for a file past the string cap. A
    // document we cannot read is a document we cannot prove is ours, which is
    // the posture an unparseable stamp already gets.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'left-foreign';
  }

  // Above the verdict, not on the write path: once the steady state is
  // `current`, a temp left by some other build's crashed write would never be
  // collected by the build that keeps activating.
  const fileName = path.basename(asset.name);
  await sweepTemps(safeDir, fileName);

  const verdict = decide(installed, ourVersion, ourHash, bundle?.hash);
  if (verdict !== 'write') return verdict;

  // Again, creating this time. The first pass was before the read; this one sits
  // against the write, which is what closes the window in between.
  const dir = await resolveDir(parent, cliDir, true, asset);
  if (dir === undefined) return 'unsafe-path';

  const body = source.endsWith('\n') ? source : `${source}\n`;
  const tmp = path.join(dir, `${fileName}.${process.pid}.${seq++}.tmp`);
  const dest = file;
  try {
    // `wx` so a name that somehow collides fails rather than truncating whatever
    // is under it — and, as a bonus, refuses to follow a link at the temp path.
    const format = asset.name.endsWith('.yaml') ? 'yaml' : 'markdown';
    await fs.writeFile(tmp, `${body}${stampLine(source, version, format, bundle?.hash)}\n`, {
      flag: 'wx'
    });
    // The walk above stops at the directory, on the reasoning that `rename(2)`
    // does not follow a final-component symlink. True, and not enough: renaming
    // over a link *destroys the link*, orphaning the file the reader pointed it
    // at so their edits stop reaching the CLI. Their target survives; their
    // arrangement does not. So the file gets the same answer the directories do.
    const link = await fs.lstat(dest).catch(() => undefined);
    if (link?.isSymbolicLink()) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      return 'unsafe-path';
    }
    await platform.files.replace(tmp, dest, { kind: 'state' });
    return 'written';
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return 'failed';
  }
}

export async function installBundledSkills(
  sourceDir: string,
  version: string,
  cliDir: string,
  parent: string
): Promise<{ file: string; outcome: SkillInstallOutcome }[]> {
  const results: { file: string; outcome: SkillInstallOutcome }[] = [];
  for (const skill of new Set(SKILL_FILES.map((asset) => asset.skill))) {
    const assets = SKILL_FILES.filter((asset) => asset.skill === skill);
    let contents: { asset: SkillFile; body: string }[];
    try {
      contents = await Promise.all(
        assets.map(async (asset) => ({
          asset,
          body: await fs.readFile(path.join(sourceDir, skill, asset.name), 'utf8')
        }))
      );
    } catch {
      const { file } = skillPaths(cliDir, parent, { skill, name: 'SKILL.md' });
      results.push({ file, outcome: 'failed' });
      continue;
    }
    const bundleHash = hashOf(
      JSON.stringify(contents.map(({ asset, body }) => [asset.name, normaliseBody(body)]))
    );
    for (const { asset, body } of contents) {
      const { file } = skillPaths(cliDir, parent, asset);
      const outcome = await installSkill(
        path.join(sourceDir, asset.skill, asset.name),
        version,
        cliDir,
        parent,
        asset,
        { hash: bundleHash, body }
      );
      results.push({ file, outcome });
      // A foreign or refused entrypoint owns its directory; leave its references alone.
      if (asset.name === 'SKILL.md' && outcome !== 'written' && outcome !== 'current') break;
    }
  }
  return results;
}
