import type { Commands } from './index';
import * as posix from './posix';
import * as powershell from './powershell';

/** Grammar belongs to the shell, not the OS: each backend maps families onto it. */
export const grammar: Omit<Commands, 'shell'> = {
  render: (program, args, policy, shell, env) =>
    shell === 'posix'
      ? posix.render(program, args, policy, env)
      : powershell.render(program, args, policy, env),
  carries: (program, args, shell) => shell === 'posix' || powershell.carries(program, args),
  placeholder: (label, shell) =>
    shell === 'posix' ? posix.placeholder(label) : powershell.placeholder(label)
};
