import * as path from 'path';
import type { SkillSource } from '../skills';
import { grokRoot } from './home';

export function skillSources(
  home: string,
  env: NodeJS.ProcessEnv,
  cwd?: string
): readonly SkillSource[] {
  const base = cwd ?? home;
  const own = cwd ? path.join(cwd, '.grok') : grokRoot(home, env);
  // 1.0.62 inspect: compatibility roots ignore the other CLIs' home overrides.
  // It also lists Claude's command files and, at user scope, its own bundled
  // skills under GROK_HOME (probed 2026-10-18).
  return [
    ...[own, ...['.agents', '.claude', '.cursor'].map((name) => path.join(base, name))].map(
      (root) => ({ directory: path.join(root, 'skills') })
    ),
    {
      directory: path.join(base, '.claude', 'commands'),
      format: 'commands' as const,
      nameFrom: 'metadata' as const
    },
    ...(cwd ? [] : [{ directory: path.join(own, 'bundled', 'skills') }])
  ];
}
