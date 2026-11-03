import * as path from 'path';
import { movedRoot } from '../cli_home';

/** Where the CLI keeps its state. A leaf, for `core/claude/home.ts`'s reason. */
export function grokRoot(home: string, env: NodeJS.ProcessEnv): string {
  return movedRoot(env, 'GROK_HOME') ?? path.join(home, '.grok');
}
