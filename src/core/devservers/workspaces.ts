import * as fs from 'fs/promises';
import * as path from 'path';
import { PackageJson } from './runners';

/**
 * Which directories in a tree are projects of their own — the monorepo half of
 * "what can I start here".
 *
 * Two questions, deliberately different in cost. `declaresWorkspaces` is a
 * boolean the poll can afford: it reads nothing this pass has not already read.
 * `projectDirs` walks the disk and is only ever asked when the run sheet opens,
 * which is the slot `ports.ts:occupancy` already owns.
 *
 * **Read, not resolved.** Nothing here runs a package manager or resolves a
 * dependency graph — it answers "which directories did this repo declare", and
 * a directory with no `package.json` in it is not a project however loudly a
 * glob names it. Observed 2026-08-04 in `~/src/acme-web`, where two
 * of ten `apps/*` matches have no manifest at all.
 *
 * Every failure is the same failure: no workspaces, which is exactly today's
 * behaviour for every repo that has none.
 */

/** The `pnpm` manifest, beside `package.json` and read only for its one block. */
export const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

/**
 * The most directories a tree may contribute. Each one costs a `package.json`
 * read on sheet open, and the menu stops being a menu long before 64 — this is
 * a bound on the walk, not a number anyone should reach.
 */
const MAX_DIRS = 64;

/**
 * How far below the tree a project may sit. `apps/*` is two segments and is the
 * shape every workspace manifest observed uses; a `**` recurses to here and
 * stops, so a deep `node_modules`-shaped tree cannot turn one sheet open into a
 * full-disk walk.
 */
const MAX_DEPTH = 2;

/**
 * Does this tree declare workspaces at all — the cheap question, asked on the
 * poll.
 *
 * This exists so an ambiguous-root monorepo stays reachable. Its root
 * `package.json` may resolve to no runner (two candidate scripts, or none), and
 * a row with no runner is drawn `unrunnable` and is not a button — so without
 * this the sheet that would list its apps can never be opened.
 *
 * `hasPnpmFile` is one `stat` the caller makes; `pkg` is the manifest the poll
 * has already parsed. Neither is a new read.
 */
export function declaresWorkspaces(pkg: PackageJson | undefined, hasPnpmFile: boolean): boolean {
  return hasPnpmFile || patternsFromPackageJson(pkg).length > 0;
}

/**
 * Every directory in this tree that is a project: the tree root first, then each
 * declared workspace directory that actually contains a `package.json`.
 *
 * The root is unconditional and is not suppressed in a monorepo. In
 * acme-web it is `bun run --filter '*' dev` — booting everything is a real
 * thing to want, and it is the only entry a plain repo has.
 *
 * The rest are sorted, so a menu's order does not depend on `readdir`.
 */
export async function projectDirs(
  treePath: string,
  pkg: PackageJson | undefined
): Promise<string[]> {
  const patterns = [...patternsFromPackageJson(pkg), ...(await patternsFromPnpm(treePath))];
  const matched = new Set<string>();
  for (const pattern of patterns) {
    if (matched.size >= MAX_DIRS) {
      break;
    }
    for (const dir of await expand(treePath, pattern)) {
      matched.add(dir);
    }
  }

  const projects: string[] = [];
  for (const dir of [...matched].sort()) {
    if (dir !== treePath && (await hasManifest(dir))) {
      projects.push(dir);
    }
  }
  return [treePath, ...projects.slice(0, MAX_DIRS - 1)];
}

/**
 * The npm/yarn/bun declaration, in both spellings the format allows. Anything
 * that is not a string is not a pattern — this is a parse of a file another
 * program wrote, like every other read here.
 */
function patternsFromPackageJson(pkg: PackageJson | undefined): string[] {
  const declared = pkg?.workspaces;
  const list = Array.isArray(declared) ? declared : declared?.packages;
  return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : [];
}

/**
 * The `pnpm` declaration, **read as one block rather than as YAML.**
 *
 * Find `packages:` at column 0, take its indented `- ` items, stop at the next
 * column-0 key. Measured against
 * t3code's `pnpm-workspace.yaml` on 2026-08-04,
 * which carries `allowBuilds:`, `catalog:`, `overrides:`, `patchedDependencies:`
 * and four more sibling keys — several with `- ` lines of their own. "Collect
 * every line starting with `- `" would have returned `browser-tabs-lock: false`
 * and `"@clerk/backend@3.13.0"` as workspace directories, and that is the
 * regression this shape exists to prevent.
 *
 * No YAML dependency (AGENTS.md: no new package where a stdlib-shaped parse
 * does), and nothing outside the block can leak in.
 */
async function patternsFromPnpm(treePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(treePath, PNPM_WORKSPACE_FILE), 'utf8');
  } catch {
    return [];
  }

  const patterns: string[] = [];
  let inBlock = false;
  // The BOM goes first: JS `\s` includes U+FEFF, so a file that starts with one
  // makes `packages:` read as an indented line and the block never opens at all.
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
      continue;
    }
    // Column 0 and not a sequence item: a key. Either the one wanted, or the one
    // that ends it — `catalog:` is what terminates `packages:` in the t3code
    // file.
    //
    // **The item test comes first, and it is load-bearing.** YAML lets a
    // sequence sit at column 0 under its key, and pnpm reads that file fine:
    //
    // ```yaml
    // packages:
    // - 'apps/*'
    // ```
    //
    // Treating those dashes as keys ended the block on its own first entry, so
    // the whole list was dropped and the repo offered its root alone — silently,
    // since a file that exists still answers `declaresWorkspaces`.
    if (!/^\s/.test(line) && !/^-\s/.test(line)) {
      if (inBlock) {
        break;
      }
      inBlock = /^packages\s*:/.test(line);
      continue;
    }
    if (!inBlock) {
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line)?.[1];
    if (item === undefined) {
      // Indented but not an item — a nested mapping under `packages:`, which is
      // not a shape this understands. Stop rather than guess at it.
      break;
    }
    const value = unquote(item);
    if (value.length > 0) {
      patterns.push(value);
    }
  }
  return patterns;
}

/**
 * One scalar off a `- ` line: the quoted form whole, the bare form up to its
 * trailing comment. Both spellings appear in the same t3code file.
 */
function unquote(item: string): string {
  const quoted = /^(['"])(.*?)\1/.exec(item);
  if (quoted) {
    return quoted[2] ?? '';
  }
  return item.split(' #')[0]?.trim() ?? '';
}

/**
 * A pattern to the directories it names.
 *
 * Three shapes are understood — a literal path, a trailing `/*`, and a trailing
 * `/**` — and **everything else is dropped rather than approximated**. A `!`
 * negation dropped is one directory too many in a menu; a `!` negation treated
 * as a literal is a directory named `!foo`, and a mid-segment `packages/*-app`
 * read as `packages/*` is every package in the repo. A pattern this cannot read
 * contributes nothing, which is the same degradation as a missing manifest.
 */
async function expand(treePath: string, pattern: string): Promise<string[]> {
  const clean = pattern.trim().replace(/\/+$/, '');
  if (clean.length === 0 || clean.startsWith('!') || clean.startsWith('/')) {
    return [];
  }

  const recursive = clean.endsWith('/**') || clean === '**';
  const single = clean.endsWith('/*') || clean === '*';
  const prefix = recursive
    ? clean.slice(0, -'**'.length)
    : single
      ? clean.slice(0, -'*'.length)
      : clean;

  // A star anywhere else is a shape this does not read — including one left in
  // the prefix, which is what `packages/*/src` and `apps/*-web` reduce to here.
  if (prefix.includes('*')) {
    return [];
  }

  const base = path.resolve(treePath, prefix);
  if (!within(treePath, base)) {
    return [];
  }
  if (!recursive && !single) {
    return depthOf(treePath, base) <= MAX_DEPTH && (await isDir(base)) ? [base] : [];
  }
  return walk(treePath, base, recursive);
}

/**
 * Every directory under `base`, one level down or as deep as `MAX_DEPTH` allows.
 *
 * `node_modules` and dot directories are never descended into and never
 * returned: the first is where a `**` becomes a full-disk walk, and the second
 * is `.git` and every tool's cache, none of which is a workspace however it is
 * globbed.
 */
async function walk(treePath: string, base: string, recursive: boolean): Promise<string[]> {
  if (depthOf(treePath, base) >= MAX_DEPTH + 1) {
    return [];
  }
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const dir = path.join(base, entry.name);
    if (depthOf(treePath, dir) > MAX_DEPTH) {
      continue;
    }
    found.push(dir);
    if (recursive) {
      found.push(...(await walk(treePath, dir, true)));
    }
    if (found.length >= MAX_DIRS) {
      break;
    }
  }
  return found;
}

/** How many segments below the tree a path sits. The tree itself is 0. */
function depthOf(treePath: string, dir: string): number {
  const rel = path.relative(treePath, dir);
  return rel.length === 0 ? 0 : rel.split(path.sep).length;
}

/** Whether a resolved path is still inside the tree — a `../` in a pattern is not. */
function within(treePath: string, dir: string): boolean {
  const rel = path.relative(treePath, dir);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** A directory is a project when it has a manifest. A glob match alone is not one. */
async function hasManifest(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dir, 'package.json'))).isFile();
  } catch {
    return false;
  }
}
