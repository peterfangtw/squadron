/**
 * The name a person or an agent **stated** a conversation should have.
 *
 * A card's name is otherwise read entirely out of whichever CLI is behind it,
 * and that has two costs. A brand with no rename door cannot be renamed at all;
 * a brand that has one only shows the new name once the CLI agrees, which is a
 * drain at an idle edge, a file rewritten, and a poll — or, where the echo never
 * arrives, never. This is the statement kept where every window can read it, so
 * the board takes a rename at once and treats the CLI's own answer as
 * confirmation rather than as the reading.
 *
 * **Keyed on brand and session id, not on pid.** A name belongs to the
 * conversation, which is the CLI's own model of it — Claude writes a
 * `custom-title` into the transcript rather than into the session file — and it
 * is what lets a stated name reach a resume picker row, where a pid means
 * nothing. Brand is in the key for `conversationKey`'s reason: two brands may
 * share a session id.
 *
 * **Never swept.** The same call `TRANSCRIPTS_DIR` and `CHECKPOINTS_DIR` make,
 * and for a sharper reason: the name is what makes an old picker row findable,
 * so sweeping it takes away the very thing that made the conversation
 * identifiable. One small file per *named* session — most sessions are never
 * named — so the whole store is kilobytes. `docs/reference/state_retention.md`.
 *
 * Best effort throughout, like every other store here: a machine that cannot
 * write this still renames the session in whichever CLI has a door for it, and
 * every card degrades to the name it shows today.
 */

import * as path from 'path';
import { isBrand } from './brands';
import { conversationKey } from './identity';
import { readJson, readJsonDir, writeAtomicJson } from './files';
import type { BrandId } from './model';
import { NAMES_DIR } from './paths';

/** One conversation's stated name. */
export type StatedName = {
  schema: 1;
  brand: BrandId;
  sessionId: string;
  /** What `sessionName` returned — cleaned and cut, so a card, a picker row and
   *  the CLI all carry the same string (`core/coordination/spawn.ts`). */
  name: string;
  statedAt: number;
};

/**
 * Where one conversation's name is written.
 *
 * `<brand>.<sessionId>.json`, one file per conversation rather than a shared
 * map, for `acks.ts`'s reason: temp-then-rename makes a write atomic, not a
 * read-modify-write safe, and two windows renaming two cards in the same tick
 * would cost one of them its name. A session id is a UUID and a brand is one of
 * three words, so the pair is its own file name.
 */
export function statedNameFile(brand: BrandId, sessionId: string): string {
  return path.join(NAMES_DIR, `${brand}.${sessionId}.json`);
}

/** Records what this conversation is to be called, now. Says whether it landed. */
export function writeStatedName(
  brand: BrandId,
  sessionId: string,
  name: string,
  at: number
): Promise<boolean> {
  return writeAtomicJson(statedNameFile(brand, sessionId), {
    schema: 1,
    brand,
    sessionId,
    name,
    statedAt: at
  } satisfies StatedName);
}

/**
 * Every stated name on the machine, by `conversationKey`.
 *
 * Unreadable, half-written, foreign and future-schema files are skipped rather
 * than thrown over: this is read on the panel's poll, and one bad file must not
 * cost the whole board its names. The key inside the record has to agree with
 * the key in the file name — `readPublished`'s guard, and the cheapest one
 * against a record copied under a name it never described.
 */
export async function readStatedNames(): Promise<Map<string, StatedName>> {
  const found = await readJsonDir(NAMES_DIR, (raw, file) => {
    const named = statedName(raw, path.basename(file, '.json'));
    return named ? ([conversationKey(named.brand, named.sessionId), named] as const) : undefined;
  });
  return new Map(found);
}

/** One conversation's stated name, from its own file: the resume picker needs
 *  the names of one family's records, not every file in `names/`. */
export async function readStatedName(
  brand: BrandId,
  sessionId: string
): Promise<StatedName | undefined> {
  return statedName(
    await readJson<unknown>(statedNameFile(brand, sessionId)),
    `${brand}.${sessionId}`
  );
}

function statedName(raw: unknown, stem: string): StatedName | undefined {
  const record = raw as Partial<StatedName> | undefined;
  if (
    record?.schema !== 1 ||
    !isBrand(record.brand) ||
    typeof record.sessionId !== 'string' ||
    typeof record.name !== 'string' ||
    !record.name ||
    typeof record.statedAt !== 'number'
  ) {
    return undefined;
  }
  const named = record as StatedName;
  return stem === `${named.brand}.${named.sessionId}` ? named : undefined;
}
