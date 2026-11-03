import * as platform from '../core/platform';
import type { PathKey } from '../core/platform/paths';

/**
 * Runs `body` with path keys, and containment, folded to lower case while every
 * raw path stays as spelled. A stand-in, not win32's fold (drive letter and
 * separators only): the POSIX-shaped fixtures here have neither, and every
 * other host's key is the raw path, so only this tells a join that compares
 * keys from one that still compares spellings.
 */
export async function withFoldedKeys<T>(body: () => T | Promise<T>): Promise<T> {
  const { key, contains } = platform.paths;
  platform.paths.key = (raw) => raw.toLowerCase() as PathKey;
  platform.paths.contains = (outer, inner) => contains(outer.toLowerCase(), inner.toLowerCase());
  try {
    return await body();
  } finally {
    platform.paths.key = key;
    platform.paths.contains = contains;
  }
}
