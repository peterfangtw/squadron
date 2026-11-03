/**
 * How one word of a command is spelled. Each producer's choice is a byte
 * contract: a native hook is trusted by its exact command text, so an
 * equivalent spelling is still a change (Codex re-asks for review).
 *
 * - `literal`: the producer's own fixed text, written as given — never a
 *   path or a value from outside.
 * - `quoted`: always single-quoted.
 * - `word`: single-quoted only where the shell would split or expand it.
 *
 * Policies are POSIX spellings. Windows PowerShell has one spelling per value
 * and reads only `literal` from them.
 */
export type Quoting = 'literal' | 'quoted' | 'word';

/**
 * A producer's quoting, its program and its arguments decided apart, so an
 * always-quoted program cannot drift into conditional quoting or back.
 * `unescapedDouble` is the dev-host runner's legacy spelling: each word in
 * double quotes with nothing escaped inside, so a `"`, `$` or backtick in a
 * path breaks it. A known defect, kept byte for byte.
 */
export type Policy =
  | { readonly program: 'literal' | 'quoted'; readonly args: 'quoted' | 'word' }
  | { readonly program: 'unescapedDouble'; readonly args: 'unescapedDouble' };

/**
 * A number is written bare under every policy: digits need no quoting, and
 * `cli/step.ts` rewrites `--opened <n>` inside a rendered prompt. An `option`
 * is `--name=value`, the name as given and the value quoted by the policy.
 */
export type Arg = string | number | { readonly option: string; readonly value: string };

/**
 * The shell a command is written for.
 *
 * - `posix`: sh, bash, zsh — and Git Bash, which runs a native `C:\…` path
 *   quoted this way (observed 2026-10-27).
 * - `windows-powershell`: Windows PowerShell 5.1 and its legacy rule for
 *   building a native command line. PowerShell 7.3+ passes arguments by
 *   another rule and is not this shell.
 */
export type Shell = 'posix' | 'windows-powershell';

/**
 * Which shell a consumer runs commands in, as its brand states it: always a
 * POSIX shell, or the host's own (sh on macOS, Windows PowerShell on Windows).
 * The brand knows its CLI; the OS backend knows its shell.
 */
export type ShellFamily = 'posix' | 'native';

/**
 * Set before the program runs. In Windows PowerShell it lasts for the rest
 * of that process's command text; hook consumers start a fresh process per hook.
 */
export type Env = Readonly<Record<string, string>>;

export interface Commands {
  /** The shell this host's consumer of `family` runs. Unbound. */
  shell(this: void, family: ShellFamily): Shell;
  /**
   * Total: text for a shell or an agent to run, never an argv to execute.
   * Whether every value arrives intact is `carries`. Unbound, so a producer
   * can hold it. A producer appends nothing after an env-bearing render.
   */
  render(
    this: void,
    program: string,
    args: readonly Arg[],
    policy: Policy,
    shell: Shell,
    env?: Env
  ): string;
  /**
   * Whether `render`'s text delivers every argument to `program` exactly. A
   * POSIX shell carries everything except doubled backslashes through win32's
   * native-to-Git-Bash hop. Windows PowerShell hands a `.cmd` to cmd, which
   * loses `"`, line breaks, a trailing backslash and a `%NAME%` pair. Native
   * values with both whitespace and `"` need a known target parser.
   */
  carries(this: void, program: string, args: readonly Arg[], shell: Shell): boolean;
  /**
   * A described value the reader fills in, e.g. `"<what you did>"`, spelled
   * so it stays one argument once filled with prose.
   */
  placeholder(this: void, label: string, shell: Shell): string;
}

/** A shell as a reader would name it, for text that tells a person where to run something. */
export const SHELL_NAMES: Readonly<Record<Shell, string>> = {
  posix: 'a POSIX shell',
  'windows-powershell': 'Windows PowerShell 5.1'
};
