import type { Arg, Env, Policy } from './index';

/**
 * Windows PowerShell 5.1 spelling. Observed 2026-10-27 (5.1.26100.9711,
 * `-NoProfile -Command`, the route Codex and Grok run tool and hook commands
 * by): PowerShell rebuilds a native command line from each value, adding outer
 * quotes only around whitespace and escaping nothing inside.
 *
 * - A `.cmd`/`.bat` goes to cmd, which re-parses that line. A value written
 *   `'"value"'` reaches it quoted and arrives exactly, metacharacters and all;
 *   `carries` names what cannot.
 * - A native exe parses the line itself. Inner `"` are escaped by the C runtime
 *   rule and backslashes before any quote doubled. A value holding both
 *   whitespace and `"` has no single spelling: written `"…""…"` it reaches the
 *   UCRT and Rust's std parser (codex.exe, grok.exe) exactly, and Electron's
 *   CommandLineToArgvW splits it.
 *
 * The program is always invoked with `&` unless the producer wrote it literally.
 */
export function render(program: string, args: readonly Arg[], policy: Policy, env?: Env): string {
  const batch = isBatch(program);
  const prefix = Object.entries(env ?? {}).map(([name, value]) => `$env:${name}=${single(value)};`);
  const head = policy.program === 'literal' ? program : `& ${single(program)}`;
  const words = args.map((arg) => {
    if (typeof arg === 'number') return String(arg);
    const value = typeof arg === 'string' ? arg : `${arg.option}=${arg.value}`;
    return batch ? single(`"${value}"`) : native(value);
  });
  return [...prefix, head, ...words].join(' ');
}

/** Reject ambiguous native-parser spelling and what cmd loses through a batch file's `%*`. */
export function carries(program: string, args: readonly Arg[]): boolean {
  const batch = isBatch(program);
  return args.every((arg) => {
    if (typeof arg === 'number') return true;
    const value = typeof arg === 'string' ? arg : `${arg.option}=${arg.value}`;
    if (!batch) return !(value.includes('"') && /\s/.test(value));
    return !/["\r\n\0]/.test(value) && !value.endsWith('\\') && !/%[^%]+%/.test(value);
  });
}

export function placeholder(label: string): string {
  return single(`"${label}"`);
}

function isBatch(program: string): boolean {
  return /\.(cmd|bat)$/i.test(program);
}

function native(value: string): string {
  if (value === '') return `'""'`;
  const spaced = /[ \t]/.test(value);
  if (spaced && value.includes('"')) {
    return single(`"${value.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`);
  }
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"');
  return single(spaced ? escaped.replace(/(\\+)$/, '$1$1') : escaped);
}

function single(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}
