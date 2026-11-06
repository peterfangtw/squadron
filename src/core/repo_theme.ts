/**
 * The theme of the folder this window opened.
 *
 * One file per folder, never swept: a colour outlives the sessions started
 * there. Absent means the shared `squadron.theme` setting, so a folder that
 * has never chosen still follows whatever every window used to.
 *
 * Not a workspace setting. That write lands in the repo's settings file.
 */

import { createHash } from 'crypto';
import * as path from 'path';
import { readJson, writeAtomicJson } from './files';
import { THEMES_DIR } from './paths';
import * as platform from './platform';
import { isThemeName, type ThemeName } from './theme_names';

type RepoTheme = { schema: 1; folder: string; theme: ThemeName };

/**
 * The stored choice when this folder has one. `follow` is a choice: it is
 * not the same as no file, which still reads the shared setting.
 */
export function effectiveTheme(stored: ThemeName | undefined, fallback: unknown): ThemeName {
  return stored ?? (isThemeName(fallback) ? fallback : 'follow');
}

/** Same reason as `arrange.ts`: a path is not a legal file name, and the
 *  folder inside the file is what makes a hash collision visible. */
function fileFor(folder: string): string {
  return (
    createHash('sha256').update(platform.paths.key(folder)).digest('hex').slice(0, 16) + '.json'
  );
}

export async function readRepoTheme(folder: string): Promise<ThemeName | undefined> {
  if (folder === '') return undefined;
  const raw = await readJson<Partial<RepoTheme>>(path.join(THEMES_DIR, fileFor(folder)));
  if (
    !raw ||
    raw.schema !== 1 ||
    typeof raw.folder !== 'string' ||
    platform.paths.key(raw.folder) !== platform.paths.key(folder) ||
    !isThemeName(raw.theme)
  )
    return undefined;
  return raw.theme;
}

export function writeRepoTheme(folder: string, theme: ThemeName): Promise<boolean> {
  if (folder === '' || !isThemeName(theme)) return Promise.resolve(false);
  const record: RepoTheme = { schema: 1, folder, theme };
  return writeAtomicJson(path.join(THEMES_DIR, fileFor(folder)), record);
}
