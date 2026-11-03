/**
 * Where work from the messenger starts (D23–D27, D39). A folder comes from
 * the open windows' claims and never from a guess: a new job is offered the
 * folders open now, and a fresh session starts only where a window holds its
 * directory.
 */

import * as path from 'path';
import * as picker from './picker';
import { windowForCwd } from '../coordination/claims';
import type { WindowClaim } from '../model';
import type { Notice } from './model';
import type { ConversationRecord } from './store';
import { notOpenNotice, threadPointer } from './words';

/** How long a held prompt waits for its folder (D39). */
export const HELD_MS = 10 * 60_000;

/** One folder a job may start in, and the window that holds it. */
export type Offered = { folder: string; windowId: string };

export type NewJob =
  | { kind: 'refuse' }
  | { kind: 'start'; folder: Offered }
  | { kind: 'hold'; folders: Offered[]; expiresAt: number };

export type Picked =
  | { kind: 'start'; folder: Offered }
  | { kind: 'expired' }
  /** The picked folder's window closed before the tap (D24). */
  | { kind: 'gone'; open: Offered[] };

type Held = NonNullable<ConversationRecord['held']>;

/**
 * One entry per folder open in a window (D24), so two windows on one folder
 * are one button. The newest claim names the window; a window with no folder
 * offers none.
 */
export function foldersOffered(claims: readonly WindowClaim[]): Offered[] {
  const newest = new Map<string, WindowClaim>();
  for (const claim of claims) {
    if (claim.folder === undefined) continue;
    const key = path.resolve(claim.folder);
    const seen = newest.get(key);
    if (seen === undefined || claim.updatedAt > seen.updatedAt) newest.set(key, claim);
  }
  return [...newest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, claim]) => ({ folder, windowId: claim.id }));
}

/** A top-level message: refused with no folder open, started with one, held
 *  for a pick with several (D24, D27). */
export function newJob(claims: readonly WindowClaim[], now: number): NewJob {
  const folders = foldersOffered(claims);
  const [only] = folders;
  if (only === undefined) return { kind: 'refuse' };
  if (folders.length === 1) return { kind: 'start', folder: only };
  return { kind: 'hold', folders, expiresAt: now + HELD_MS };
}

/** A folder tapped on a held prompt, against the windows open at the tap. */
export function pickFolder(
  held: Held,
  folder: string,
  claims: readonly WindowClaim[],
  now: number
): Picked {
  if (now >= held.expiresAt) return { kind: 'expired' };
  const open = foldersOffered(claims);
  const found = open.find((offered) => offered.folder === path.resolve(folder));
  return found === undefined ? { kind: 'gone', open } : { kind: 'start', folder: found };
}

/** The held prompts whose time is up, for the engine to settle (D39). */
export function expiredHeld(
  records: readonly ConversationRecord[],
  now: number
): ConversationRecord[] {
  return records.filter((record) => record.state === 'held' && picker.expired(record.held, now));
}

/**
 * The window a fresh session starts in (D23): the one whose folder or repo
 * holds the ended root's directory, with no fallback (D26). Otherwise the
 * refusal, which names the directory.
 */
export async function freshWindow(
  claims: readonly WindowClaim[],
  cwd: string,
  resolve: (folders: Iterable<string>) => Promise<Map<string, string>>
): Promise<{ window: WindowClaim } | { refuse: Notice }> {
  const window = await windowForCwd(claims, cwd, resolve, { fallback: false });
  return window === undefined ? { refuse: notOpenNotice(cwd) } : { window };
}

/**
 * A fresh session's first prompt: the person's message, then one line pointing
 * at the ended session's record, to read only if needed (D23). A line that
 * reaches a session (`words.ts`'s header).
 */
export function freshPrompt(text: string, recordPath?: string): string {
  if (recordPath === undefined) return text;
  return `${text}\n\nThe previous session in this conversation ended. Its record is at ${recordPath}; read it only if you need the context.`;
}

/**
 * A joined thread's first prompt: the person's message, then one line pointing
 * at the thread file, to read only if the message needs it. No line when
 * nothing earlier was read. A line that reaches a session (`words.ts`'s header).
 */
export function threadPrompt(text: string, filePath: string, count: number): string {
  if (count <= 0) return text;
  return `${text}\n\n${threadPointer(filePath, count)}`;
}
