import * as path from 'path';
import { movedRoot } from '../cli_home';

/** Where the CLI keeps its state. A leaf, for `core/claude/home.ts`'s reason. */
export function codexRoot(home: string, env: NodeJS.ProcessEnv): string {
  return movedRoot(env, 'CODEX_HOME') ?? path.join(home, '.codex');
}
