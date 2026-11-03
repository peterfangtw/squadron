import * as path from 'path';
import { containment, type PathKey, type Paths } from './index';

/**
 * The raw path, byte for byte: no case folding, symlink resolution or slash
 * normalization. Also the unchanged, unverified legacy path on other POSIX hosts.
 */
export function paths(): Paths {
  const key = (raw: string) => raw as PathKey;
  return { key, contains: containment(path.posix, key) };
}
