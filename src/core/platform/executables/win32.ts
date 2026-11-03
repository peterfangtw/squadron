/**
 * Windows executable lookup.
 *
 * The no-shell rule rules out cmd.exe, which is the only thing that runs a
 * `.cmd`. An npm install is one (`codex.cmd`), and `spawn` refuses it with a
 * synchronous `EINVAL`; `shell: true` would mangle the `--settings` JSON and
 * the multi-line prompt and make `child.pid` cmd's. So a shim is read rather
 * than run: whatever program it names is started directly (`followShim`).
 *
 * Third-party runtime substitution remains undecided; this follows only the
 * runtime named by the shim (invocation plan A2).
 */

import * as path from 'path';
import {
  compose,
  NONE,
  run,
  type Effects,
  type Executables,
  type Located,
  type Locator
} from './index';

export function executables(effects: Effects): Executables {
  return compose(locator(effects), effects);
}

/** What CreateProcess starts by itself. `X_OK` is `F_OK` on win32, so the
 *  extension is the only test there is. */
const NATIVE = new Set(['.exe', '.com']);
/** What only cmd.exe starts; read by `followShim` instead. */
const BATCH = new Set(['.cmd', '.bat']);

/** What `PATHEXT` falls back to when the variable is absent or empty. */
const DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd'];

function locator(effects: Effects): Locator {
  async function isFile(file: string): Promise<boolean> {
    try {
      return (await effects.stat(file)).isFile();
    } catch {
      return false;
    }
  }

  /** A name, tried as win32 tries it: with each `PATHEXT` extension unless it
   *  already carries one, in `PATHEXT`'s order. */
  async function locate(file: string, env: NodeJS.ProcessEnv): Promise<Located> {
    const candidates = path.win32.extname(file) ? [file] : pathExt(env).map((ext) => file + ext);
    let refused: Located | undefined;
    for (const candidate of candidates) {
      const found = await classify(candidate, env);
      if (found.kind === 'run') return found;
      if (found.kind === 'refused') refused ??= found;
    }
    return refused ?? NONE;
  }

  async function classify(file: string, env: NodeJS.ProcessEnv): Promise<Located> {
    const ext = path.win32.extname(file).toLowerCase();
    if (!NATIVE.has(ext) && !BATCH.has(ext)) return NONE;
    if (!(await isFile(file))) return NONE;
    if (NATIVE.has(ext)) return run(file);
    if (BATCH.has(ext)) return followShim(file, env);
    return NONE;
  }

  /**
   * A shim, followed to what it would have run, without cmd.exe.
   *
   * Its target is the package's entry point as npm wrote it down, so nothing
   * here knows any package's layout. The runtime is looked for where the shim
   * looks: beside it, then on `PATH`. Neither found is a refusal naming both —
   * this does not substitute a runtime of its own.
   */
  async function followShim(shim: string, env: NodeJS.ProcessEnv): Promise<Located> {
    let text: string;
    try {
      if ((await effects.stat(shim)).size > SHIM_BYTES) return cannotFollow(shim);
      text = await effects.readText(shim);
    } catch {
      return NONE;
    }
    const shape = parseShim(text);
    if (!shape) return cannotFollow(shim);
    const dir = path.win32.dirname(shim);
    const target = within(dir, shape.target);
    if (!shape.runtime) {
      return NATIVE.has(path.win32.extname(target).toLowerCase()) && (await isFile(target))
        ? run(target)
        : { kind: 'refused', reason: `${shim} runs ${target}, which is not an executable file.` };
    }
    if (!(await isFile(target))) {
      return { kind: 'refused', reason: `${shim} runs ${target}, which is not there.` };
    }
    const { beside, name } = shape.runtime;
    if (beside !== undefined) {
      const file = within(dir, beside);
      if (NATIVE.has(path.win32.extname(file).toLowerCase()) && (await isFile(file))) {
        return run(target, file);
      }
    }
    if (name !== undefined) {
      const runner = await nativeOnPath(name, env);
      if (runner) return run(target, runner);
    }
    return {
      kind: 'refused',
      reason: `${shim} runs its script with \`${name ?? beside ?? ''}\`, which is neither beside it nor on this process’s PATH.`
    };
  }

  /** The runtime a shim names, as win32 would find it — a program only: a
   *  runtime that is itself a shim is a chain this does not follow. */
  async function nativeOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const suffix = path.win32.extname(name).toLowerCase();
    if (suffix && !NATIVE.has(suffix)) return undefined;
    const candidates = suffix
      ? [name]
      : pathExt(env)
          .filter((ext) => NATIVE.has(ext))
          .map((ext) => name + ext);
    for (const dir of searchPath(env)) {
      for (const candidate of candidates) {
        const file = path.win32.join(dir, candidate);
        if (await isFile(file)) return file;
      }
    }
    return undefined;
  }

  return {
    join: (dir, name) => path.win32.join(dir, name),
    // win32 people type `~\`.
    expand: (file) =>
      /^~(?=$|[\\/])/.test(file)
        ? path.win32.join(effects.homedir(), file.slice(1))
        : path.win32.resolve(file),
    locate,
    searchPath
  };
}

function pathExt(env: NodeJS.ProcessEnv): string[] {
  const listed = entries(variable(env, 'PATHEXT'), ';');
  if (!listed.length) return DEFAULT_PATHEXT;
  return [...new Set(listed.map((ext) => ext.toLowerCase()))].filter(
    (ext) => NATIVE.has(ext) || BATCH.has(ext)
  );
}

function searchPath(env: NodeJS.ProcessEnv): string[] {
  return entries(variable(env, 'PATH'), ';');
}

/** win32's environment is case-insensitive and a copy of it is not: a child
 *  env built as an object literal can carry `Path`. */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((each) => each.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** A delimited list, with win32's quoted entries unquoted. An empty entry is
 *  `.` to a shell, and must not be here. */
function entries(value: string | undefined, delimiter: string): string[] {
  return (value ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

// --- npm shims ---------------------------------------------------------------

/** What a cmd shim runs, in its own relative spelling. `runtime` is absent when
 *  it runs `target` itself; otherwise it names the program that runs the
 *  script, beside the shim, by name on `PATH`, or both in that order. */
export type Shim = {
  target: string;
  runtime?: { beside?: string; name?: string };
};

/** A shim far past this is not one npm wrote; theirs are under 1 KiB. */
const SHIM_BYTES = 16 * 1024;

/** The shim's directory, as both generations of cmd-shim spell it. */
const DP0 = String.raw`"%(?:~dp0|dp0%)\\([^"%]+)"`;
/** The token run with the caller's arguments: the target. */
const TARGET = new RegExp(DP0 + String.raw`\s+%\*`);
const BESIDE = new RegExp(`^${DP0}$`);
const PROG_BESIDE = new RegExp(String.raw`^\s*SET\s+"_prog=%(?:~dp0|dp0%)\\([^"%]+)"\s*$`, 'im');
const PROG_NAME = /^\s*SET\s+"_prog=([\w.-]+)"\s*$/im;
/** Every other line the three shapes below carry, after any leading `@`. A
 *  line not here and not a launch line — a `set` of the CLI's environment, a
 *  `cd` — is one this cannot honour without cmd.exe. */
const SCAFFOLD = [
  /^echo off$/i,
  /^goto start$/i,
  /^:find_dp0$/i,
  /^set dp0=%~dp0$/i,
  /^exit \/b$/i,
  /^:start$/i,
  /^setlocal$/i,
  /^call :find_dp0$/i,
  new RegExp(String.raw`^if exist ${DP0} \($`, 'i'),
  /^\) else \($/i,
  /^\)$/,
  /^set pathext=%pathext:;\.js;=;%$/i,
  PROG_BESIDE,
  PROG_NAME
];
/** What npm 11 runs ahead of `"%_prog%"` on its launch line. */
const HANDOFF = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC%$/i;

/**
 * The program a cmd shim starts, read off its text, or `undefined` for one this
 * cannot account for in full — which is then refused, never run.
 *
 * Three shapes, observed rather than recalled:
 * - npm 11.19 (`npm install -g`, 2026-10-21), a script with a `node` shebang:
 *   `SET "_prog=%dp0%\node.exe"` if that exists, else `SET "_prog=node"`, then
 *   `… & "%_prog%"  "%dp0%\node_modules\<pkg>\<bin>" %*`.
 * - npm 11.19, a bin that is an executable: `"%dp0%\node_modules\<pkg>\<bin>" %*`.
 * - The older cmd-shim Node ships as `corepack.cmd` (Node 24.20): an
 *   `IF EXIST "%~dp0\node.exe"` pair of lines, `"%~dp0\node.exe"  "<target>" %*`
 *   and `node  "<target>" %*`.
 *
 * Any other line, or anything more on a launch line — a shebang's extra
 * arguments, a redirect — is a shape not seen, and refused.
 */
export function parseShim(text: string): Shim | undefined {
  let target: string | undefined;
  let direct = false;
  const runtime: { beside?: string; name?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^@/, '');
    if (!line || SCAFFOLD.some((known) => known.test(line))) continue;
    const hit = TARGET.exec(line);
    if (!hit?.[1] || line.slice(hit.index + hit[0].length).trim()) return undefined;
    if (target !== undefined && hit[1] !== target) return undefined;
    target = hit[1];
    const before = line.slice(0, hit.index);
    const handoff = before.lastIndexOf('&');
    if (handoff >= 0 && !HANDOFF.test(before.slice(0, handoff).trim())) return undefined;
    const prog = before
      .slice(handoff + 1)
      .trim()
      .replace(/^@/, '');
    const beside = BESIDE.exec(prog)?.[1];
    if (!prog) direct = true;
    else if (prog === '"%_prog%"') {
      runtime.beside ??= PROG_BESIDE.exec(text)?.[1];
      runtime.name ??= PROG_NAME.exec(text)?.[1];
    } else if (beside) runtime.beside ??= beside;
    else if (/^[\w.-]+$/.test(prog)) runtime.name ??= prog;
    else return undefined;
  }
  if (target === undefined) return undefined;
  const runs = runtime.beside !== undefined || runtime.name !== undefined;
  if (direct === runs) return undefined;
  return direct ? { target } : { target, runtime };
}

/** A shim-relative path, `\`-separated as cmd-shim writes it. */
function within(dir: string, relative: string): string {
  return path.win32.join(dir, relative);
}

function cannotFollow(shim: string): Located {
  return {
    kind: 'refused',
    reason: `${shim} is a batch file in a shape Squadron cannot follow, and it runs none through a shell.`
  };
}
