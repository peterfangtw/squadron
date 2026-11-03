import * as path from 'path';
import type { SkillSource } from '../skills';
import { codexRoot } from './home';

export function skillSources(
  home: string,
  env: NodeJS.ProcessEnv,
  cwd?: string
): readonly SkillSource[] {
  const roots = cwd
    ? [path.join(cwd, '.agents'), path.join(cwd, '.codex')]
    : [codexRoot(home, env), path.join(home, '.agents')];
  return roots.map((root) => ({ directory: path.join(root, 'skills'), metadata: 'required' }));
}
