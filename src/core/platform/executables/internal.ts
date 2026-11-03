import type { Spawned } from './index';

/** The program and, for a script entry point, the runtime that runs it. */
type Invocation = { path: string; runner?: string };

let invocationOf: (program: Program) => Invocation;
let programOf: (invocation: Invocation) => Program;

/** A CLI as found, in one value so its runner cannot be paired with another
 *  path on the way to a spawn. Nothing outside this capability can read it. */
export class Program {
  readonly #invocation: Invocation;

  private constructor(invocation: Invocation) {
    this.#invocation = invocation;
  }

  static {
    invocationOf = (program) => program.#invocation;
    programOf = (invocation) => new Program(invocation);
  }
}

/** A program its caller names outright rather than finds: a test's fake CLI,
 *  a script under `process.execPath`. Lint holds it to tests. */
export function named(file: string, runner?: string): Program {
  return programOf(runner === undefined ? { path: file } : { path: file, runner });
}

function argvOf(program: Program, args: readonly string[]): { file: string; argv: string[] } {
  const { path: file, runner } = invocationOf(program);
  return runner ? { file: runner, argv: [file, ...args] } : { file, argv: [...args] };
}

/** Some refusals are thrown rather than emitted — win32's `EINVAL` for a
 *  `.cmd`, `ERR_INVALID_ARG_VALUE` for a NUL in an argument. */
export function spawned<C>(start: () => C): Spawned<C> {
  try {
    return { supported: true, status: 'ok', value: start() };
  } catch (error) {
    return {
      supported: true,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Internal execution path shared by executables and console login; never returns invocation authority. */
export function invoke<C>(
  program: Program,
  args: readonly string[],
  run: (file: string, argv: string[]) => C
): C {
  const { file, argv } = argvOf(program, args);
  return run(file, argv);
}
