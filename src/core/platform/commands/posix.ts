import type { Arg, Env, Policy } from './index';

/**
 * POSIX sh spelling: words joined by one space, single quotes closed and
 * reopened around an apostrophe. An environment entry is a `NAME=value`
 * prefix, scoped to this one command.
 */
export function render(program: string, args: readonly Arg[], policy: Policy, env?: Env): string {
  const prefix = Object.entries(env ?? {}).map(
    ([name, value]) => `${name}=${spell(value, 'word')}`
  );
  return [
    ...prefix,
    spell(program, policy.program),
    ...args.map((arg) => argument(arg, policy.args))
  ].join(' ');
}

export function placeholder(label: string): string {
  return `"${label}"`;
}

function argument(arg: Arg, quoting: Policy['args']): string {
  if (typeof arg === 'number') return String(arg);
  if (typeof arg === 'string') return spell(arg, quoting);
  return `${arg.option}=${spell(arg.value, quoting)}`;
}

function spell(text: string, quoting: Policy['program'] | Policy['args']): string {
  switch (quoting) {
    case 'literal':
      return text;
    case 'quoted':
      return singleQuoted(text);
    case 'word':
      return /^[\w@%+=:,./-]+$/.test(text) ? text : singleQuoted(text);
    case 'unescapedDouble':
      return `"${text}"`;
  }
}

function singleQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
