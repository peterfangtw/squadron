import { SKILL_FILES } from '../../core/skill_install';

/** What seed restoration must leave alone: written by the host at activation, not planted. */
export const HOST_OWNED = [
  // VS Code 1.143 holds sharedStorage/state.vscdb open for the host lifetime.
  '.vscode-shared',
  '.squadron/bin',
  '.squadron/windows',
  ...['.claude', '.codex', '.grok'].flatMap((cli) =>
    [...new Set(SKILL_FILES.map((asset) => asset.skill))].map((name) => `${cli}/skills/${name}`)
  ),
  '.claude/settings.json'
];
