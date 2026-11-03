import * as path from 'path';

/**
 * The root a CLI's override names, if it names one place.
 *
 * Observed 2026-11-02 on win32, Claude 2.1.316, Codex 0.166.0, Grok 1.0.70: an
 * absolute value moves the root; a padded one is taken literally or refused; a
 * relative one, and Grok's `~/x`, land under each session's own cwd; an empty one
 * is unset. So only an absolute value is a place this process can read.
 *
 * `path.isAbsolute` also passes win32's `\x` and `//x`, which resolve against the
 * current drive, so two processes on two drives would name two places. Their
 * parsed root is one separator; `C:\` and a UNC share's are longer.
 */
export function movedRoot(env: NodeJS.ProcessEnv, variable: string): string | undefined {
  const value = env[variable];
  if (!value || !path.isAbsolute(value)) return undefined;
  if (path.sep === '\\' && path.parse(value).root.length < 3) return undefined;
  return path.resolve(value);
}
