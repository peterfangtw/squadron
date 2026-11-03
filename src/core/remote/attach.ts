/**
 * Which files an agent's `squadron-attach` may send, and how often (M3). One
 * copy, because the shim and the holder both apply it: the shim so a refusal
 * arrives before a request is written, the holder because a raw request file
 * reaches it without the shim, and it is the process that reads the file.
 *
 * The extension host and every session run as one user, so the operating
 * system cannot say what the caller may read. The line is drawn where the
 * session's own tools work — its cwd, its working tree, the temp directory —
 * so the holder never reads a file from a place the session's permission rules
 * never covered. A guard against a careless or injected one-line attach, not a
 * sandbox: the same agent can print any file it reads into its final text.
 *
 * Names no messenger, and imports nothing from `core/bridge/port.ts`, whose
 * registry reaches a messenger's socket client — the shim bundles this file.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readTree } from '../git';

/** Our own cap (U13), whatever the messenger takes. */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

/** Under Telegram's 1024-character caption, the smallest the seam is designed
 *  for, so no adapter splits one. */
export const CAPTION_MAX = 1000;

/**
 * How long the shim waits for the holder (a duration): the upload of a file at
 * the cap over an uplink of 2 Mbit/s at the least, about 42 s, and the calls
 * around it. A messenger's own upload deadline sits under this, so the agent
 * hears the outcome rather than "may have been posted". Past `STALE_MS`, as
 * `cli/spawn.ts`'s wait is, and for its reason — the shim reads only whether
 * a reply came.
 */
export const ATTACH_REPLY_MS = 60_000;

/** `checkPrompt`'s set: control characters bar newline and tab. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

export type Refused = { ok: false; reason: string };

/** Where a session's file may come from: its roots, and what is never sent,
 *  both realpathed. */
export type Area = { roots: readonly string[]; deny: readonly string[] };

/** A file `inspectFile` found: the path as given with its directory
 *  realpathed, its own realpath, and its size. */
export type Inspected = { ok: true; given: string; real: string; size: number };

/**
 * The directories a session's files may come from, realpathed: its cwd, the
 * working tree that holds it, and the temp directories, where agents write
 * screenshots. The working tree and not `repoRoot`, which for a linked
 * worktree is another checkout. A root that does not exist is dropped, and so
 * is the filesystem's: under `/`, `~/Library` survives `realpath` as
 * `/System/Volumes/Data/Users/<me>/Library`, which no deny entry names.
 */
export async function attachRoots(
  cwd: string,
  options: { tmp?: readonly string[] } = {}
): Promise<string[]> {
  const tmp = options.tmp ?? [os.tmpdir(), '/tmp'];
  const tree = await readTree(cwd);
  const roots = await realDirs([cwd, ...(tree ? [tree.treeRoot] : []), ...tmp]);
  return roots.filter((dir) => path.parse(dir).root !== dir);
}

/**
 * What is never sent from a session at `roots`: `base` (Squadron's state, the
 * host's user data), and `~/Library` where a root holds it — a session in
 * `$HOME` or a dotfiles repo would otherwise reach the login keychain, browser
 * cookies and Messages' database. A session working inside `~/Library` keeps
 * its own files. Realpathed, so `checkPath` compares like with like.
 */
export async function attachDeny(
  roots: readonly string[],
  base: readonly string[],
  home: string = os.homedir()
): Promise<string[]> {
  const [denied, library] = await Promise.all([
    realDirs(base),
    realDirs([path.join(home, 'Library')])
  ]);
  const reached = library.filter((dir) =>
    roots.some((root) => root !== dir && within(root, dir) !== undefined)
  );
  return [...new Set([...denied, ...reached])];
}

/** Each directory realpathed, missing ones dropped, duplicates once. */
export async function realDirs(dirs: readonly string[]): Promise<string[]> {
  const real = await Promise.all(dirs.map((dir) => fs.realpath(dir).catch(() => undefined)));
  return [...new Set(real.filter((dir): dir is string => dir !== undefined))];
}

/**
 * Whether a found file may go, against the roots and the directories that are
 * never sent (Squadron's state, the host's user data). Pure: both paths are
 * passed in.
 *
 * The hidden rule reads each path relative to the deepest root it falls in, so
 * a session started under `.worktrees/` is not refused wholesale while `.env`,
 * `.git/` and `.ssh/` under its root are. It runs on the realpath, which is
 * where the bytes are, and on the name as given, so a link called `.env` is
 * refused for what it says it is.
 */
export function checkPath(
  file: { given: string; real: string },
  roots: readonly string[],
  deny: readonly string[]
): { ok: true; root: string } | Refused {
  const shown = file.given;
  for (const dir of deny) {
    if (within(dir, file.real) !== undefined || within(dir, file.given) !== undefined) {
      return { ok: false, reason: `${shown} is inside ${dir}, which is never sent` };
    }
  }
  const root = deepest(roots, file.real);
  if (root === undefined) {
    return {
      ok: false,
      reason:
        `${shown} is outside this session's working directory, its working tree and the temp ` +
        `directory (${roots.join(', ')}); copy it into one of them first`
    };
  }
  const givenRoot = deepest(roots, file.given);
  const hidden =
    hiddenPart(within(root, file.real) ?? '') ??
    hiddenPart(
      givenRoot === undefined ? path.basename(file.given) : (within(givenRoot, file.given) ?? '')
    );
  if (hidden !== undefined) {
    return {
      ok: false,
      reason: `${shown} has a hidden component (${hidden}); hidden paths are never sent`
    };
  }
  return { ok: true, root };
}

/**
 * The file an agent named, resolved against `base` (the shim's cwd, or the
 * session's in the holder), or why it cannot go. `maxBytes` is the
 * messenger's limit where the holder knows one; the smaller cap wins, and the
 * refusal says whose it was.
 *
 * Statted, never opened: the holder's `readChecked` opens what this checked and
 * checks again through the descriptor.
 */
export async function inspectFile(
  raw: string,
  base: string,
  maxBytes: number = ATTACH_MAX_BYTES
): Promise<Inspected | Refused> {
  const resolved = path.resolve(base, raw);
  let real: string;
  let dir: string;
  try {
    [real, dir] = await Promise.all([fs.realpath(resolved), fs.realpath(path.dirname(resolved))]);
  } catch {
    return { ok: false, reason: `no such file: ${resolved}` };
  }
  const given = path.join(dir, path.basename(resolved));
  const info = await fs.lstat(real).catch(() => undefined);
  if (!info) return { ok: false, reason: `no such file: ${resolved}` };
  if (info.isDirectory()) return { ok: false, reason: `${given} is a directory, not a file` };
  if (!info.isFile()) {
    return { ok: false, reason: `${given} is not a regular file (a socket, FIFO or device)` };
  }
  if (info.size === 0) return { ok: false, reason: `${given} is empty` };
  const cap = Math.min(ATTACH_MAX_BYTES, maxBytes);
  if (info.size > cap) return { ok: false, reason: tooLarge(given, info.size, cap) };
  return { ok: true, given, real, size: info.size };
}

/** The refusal for a file over the cap, naming whose cap it is. */
export function tooLarge(shown: string, size: number, cap: number): string {
  const limit =
    cap < ATTACH_MAX_BYTES ? `the messenger's limit of ${sizeOf(cap)}` : 'the 10 MiB limit';
  return `${shown} is ${sizeOf(size)}, over ${limit}`;
}

/** A size as a reader says it. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)} KB`;
  return `${round(bytes / (1024 * 1024))} MB`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The caption as it is posted: trimmed, absent when empty. A bad one is
 *  usage, the caller's to fix by typing again. */
export function checkCaption(raw: string | undefined): { ok: true; caption?: string } | Refused {
  const caption = raw?.trim() ?? '';
  if (caption === '') return { ok: true };
  if (caption.length > CAPTION_MAX) {
    return {
      ok: false,
      reason: `the caption is ${caption.length} characters; the limit is ${CAPTION_MAX}`
    };
  }
  if (CONTROL.test(caption)) {
    return { ok: false, reason: 'the caption contains control characters' };
  }
  return { ok: true, caption };
}

/**
 * How the messenger should preview a file, by extension. Not
 * `core/pastes.ts`'s table: that one says which images a CLI accepts. Type
 * limits nothing (U15).
 */
const MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  zip: 'application/zip'
};

export function mimeOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** Per sending session, the one cap (U14): ten a minute, of any type, so a
 *  run of screenshots fits where a looping agent does not. */
const SESSION_MAX = 10;
const SESSION_MS = 60_000;

/** A place under the cap, held from admission until the attachment settles. */
export type Slot = { readonly key: string };

/**
 * The rate cap, in the holder's memory: the one process that serves every
 * attachment (D37), so no file is needed, and a reload emptying it is fine
 * for a cap measured in minutes. Admission takes a slot at once, so a burst
 * sent before the first upload finishes is capped like one sent after it; a
 * post keeps its slot, dated when it landed, and a refusal frees it, costing
 * the phone nothing. Reads the time it is given and keeps no timer.
 */
export class AttachGuard {
  /** `at` is the admission until the post lands, then the post's time. */
  private posts: { key: string; at: number; landed: boolean }[] = [];

  admit(key: string, now: number): { ok: true; slot: Slot } | Refused {
    this.forget(now);
    const mine = this.posts.filter((post) => post.key === key);
    if (mine.length >= SESSION_MAX) {
      return {
        ok: false,
        reason: `this session has sent ${SESSION_MAX} files in the last minute (${SESSION_MAX} a minute); wait`
      };
    }
    const slot = { key, at: now, landed: false };
    this.posts.push(slot);
    return { ok: true, slot };
  }

  /** The attachment was posted, or may have been: its slot stays, dated `now`. */
  posted(slot: Slot, now: number): void {
    const post = this.posts.find((held) => held === slot);
    if (post) {
      post.at = now;
      post.landed = true;
    }
  }

  /** Nothing was posted: the slot is free again. */
  release(slot: Slot): void {
    this.posts = this.posts.filter((held) => held !== slot);
  }

  /** A slot still in flight stays, however slow its upload, so it counts
   *  when it lands. */
  private forget(now: number): void {
    this.posts = this.posts.filter((post) => !post.landed || now - post.at < SESSION_MS);
  }
}

/** `child` relative to `dir` when it is `dir` or under it. */
function within(dir: string, child: string): string | undefined {
  const relative = path.relative(dir, child);
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function deepest(roots: readonly string[], file: string): string | undefined {
  return roots
    .filter((root) => within(root, file) !== undefined)
    .sort((a, b) => b.length - a.length)[0];
}

function hiddenPart(relative: string): string | undefined {
  return relative.split(path.sep).find((part) => part.startsWith('.') && part !== '.');
}
