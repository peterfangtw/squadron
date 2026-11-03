import type * as path from 'path';

declare const pathKey: unique symbol;

/**
 * A directory's comparison identity: what two paths are compared, keyed,
 * hashed into a store filename or tested for containment by. Never read, spawned
 * or displayed — the raw path stays beside it for that.
 */
export type PathKey = string & { readonly [pathKey]: true };

export interface Paths {
  /** Total: every raw path has a key, and a key's key is itself. Unbound,
   *  so it can be handed on as a mapper. */
  key(this: void, raw: string): PathKey;
  /** Whether `inner` is `outer` or below it, lexically, under the key's policy:
   *  each normalized (`.`, `..`, doubled and trailing separators), keyed, then
   *  prefix-tested at a separator. Inputs must be absolute on POSIX; on win32,
   *  fully qualified drives, complete UNC shares or supported device forms.
   *  Other inputs hold and are held by nothing; resolve them first.
   *  Total and effect-free, so no alias resolution. */
  contains(this: void, outer: string, inner: string): boolean;
}

/**
 * `contains` for a backend's own path flavor and key.
 *
 * Normalized before the prefix test, or it is no containment test: `/repo/../x`
 * starts with `/repo/`. Prefix rather than `relative`, because
 * `path.win32.relative` ignores case across the whole path while the key keeps
 * it past the drive letter. `opaque` names inputs whose dot segments the
 * flavor must not resolve; they contain nothing. `admit` checks raw inputs
 * before normalization can erase their qualification.
 */
export function containment(
  flavor: path.PlatformPath,
  key: (raw: string) => string,
  opaque: (raw: string) => boolean = () => false,
  admit: (raw: string) => boolean = (raw) => flavor.isAbsolute(raw)
): Paths['contains'] {
  const settle = (raw: string): string | undefined => {
    if (!admit(raw) || (opaque(raw) && DOT_SEGMENT.test(raw))) return undefined;
    const normal = flavor.normalize(raw);
    const { root } = flavor.parse(normal);
    // A root keeps its separator: `/`, `C:\`, `\\server\share\`.
    const bare = normal.length > root.length && normal.endsWith(flavor.sep);
    return key(bare ? normal.slice(0, -1) : normal);
  };
  return (outer, inner) => {
    const held = settle(outer);
    const under = settle(inner);
    if (held === undefined || under === undefined) return false;
    const prefix = held.endsWith(flavor.sep) ? held : held + flavor.sep;
    return under === held || under.startsWith(prefix);
  };
}

const DOT_SEGMENT = /(?:^|[\\/])\.{1,2}(?=[\\/]|$)/;
