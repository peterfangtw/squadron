import * as path from 'path';
import { movedRoot } from '../cli_home';

/**
 * Where the CLI keeps its state. A leaf: `paths.ts` fixes its constants from
 * this on load, and `skills.ts` and `skillRoot` ask it with their own home.
 *
 * An absolute `CLAUDE_CONFIG_DIR` moves everything, sessions, transcripts and
 * credentials included, and `~/.claude.json` is then not read even if present
 * (observed 2026-11-02, CLI 2.1.316, scratch home on win32). Relative, `~/x` and
 * empty values land under each session's own cwd (empty: all but
 * `~/.claude.json`) and read as unset: a card shrinks, and the CLI's own advice
 * is to set an absolute path.
 */
function moved(env: NodeJS.ProcessEnv): string | undefined {
  return movedRoot(env, 'CLAUDE_CONFIG_DIR');
}

export function claudeRoot(home: string, env: NodeJS.ProcessEnv): string {
  return moved(env) ?? path.join(home, '.claude');
}

/** Inside a moved root, but beside the default one. */
export function claudeConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(moved(env) ?? home, '.claude.json');
}
