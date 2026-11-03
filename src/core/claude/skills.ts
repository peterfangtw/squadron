import * as path from 'path';
import type { SkillSource } from '../skills';
import { claudeRoot } from './home';

export function skillSources(
  home: string,
  env: NodeJS.ProcessEnv,
  cwd?: string
): readonly SkillSource[] {
  const root = cwd ? path.join(cwd, '.claude') : claudeRoot(home, env);
  return [
    { directory: path.join(root, 'skills') },
    { directory: path.join(root, 'commands'), format: 'commands' }
  ];
}
