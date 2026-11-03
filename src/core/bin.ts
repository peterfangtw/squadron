/**
 * Where `claude` is, for a process that cannot assume a shell found it.
 *
 * A terminal spawn never had this problem: the shell resolves the name against
 * whatever the user's rc files built. A child of the extension host has no
 * shell, and the host's own `PATH` is whatever the IDE was launched with — from
 * Finder or a Dock icon, that is the bare login environment, which on this
 * machine does not contain `~/.local/bin`. Observed 2026-07-27:
 * `env -i PATH=/usr/bin:/bin sh -c 'command -v claude'` finds nothing, while
 * `~/.local/bin/claude` is there and reports `2.1.220`.
 *
 * Going through a login shell to find it would work and is exactly what this
 * path exists to stop: a shell means quoting for a shell again, and the quoting
 * of untrusted prompt text is the bug class the whole owned-session task is
 * walking away from. So the search is done here, in the open, and a failure is
 * a refusal with a reason rather than an exception out of `spawn`.
 *
 * Which places each brand looks is decided here, ranked setting, installer's
 * path, then `PATH` by the `Candidates` contract. What a path is as an
 * executable on this OS, and starting what was found, is `platform/executables`.
 */

import * as os from 'os';
import * as path from 'path';
import * as platform from './platform';
import type { Executables, Program } from './platform/executables';

export type BinaryFound = {
  ok: true;
  program: Program;
  /** The executable — or, under a runner, its script. For the log line that
   *  says once per spawn what was found; never something to start. */
  path: string;
  /** Which rule found it, for the same log line. */
  source: 'setting' | 'home' | 'path';
};
export type BinaryMissing = { ok: false; reason: string };

/** One CLI's search, in the words its refusals use. */
type Cli = {
  name: string;
  /** Where its installer puts it, under the home directory. */
  installed: string;
  /** The same, as the refusal names it. */
  looked: string;
  setting: string;
};

const CLAUDE: Cli = {
  name: 'claude',
  installed: path.join('.local', 'bin', 'claude'),
  looked: '~/.local/bin',
  setting: 'squadron.claudePath'
};

/** The installer symlink, not the versioned download (observed 1.0.4); do not
 *  hardcode the downloads path. On win32 it is `~/.grok/bin/grok.exe`
 *  (observed 2026-10-21). */
const GROK: Cli = {
  name: 'grok',
  installed: path.join('.grok', 'bin', 'grok'),
  looked: '~/.grok/bin',
  setting: 'squadron.grokPath'
};

/** Observed 0.151.0: `~/.local/bin/codex` links into
 *  `~/.codex/packages/standalone/current/bin/codex`. Resolve the stable public
 *  symlink rather than the package store, then fall back to PATH. */
const CODEX: Cli = {
  name: 'codex',
  installed: path.join('.local', 'bin', 'codex'),
  looked: '~/.local/bin',
  setting: 'squadron.codexPath'
};

/**
 * The `claude` to spawn, or why there is none.
 *
 * `override` is the user's setting, and it is deliberately **not** a hint: an
 * explicit path that does not resolve refuses here rather than falling through
 * to the search. Quietly running a different binary than the one someone named
 * is worse than not starting — especially since the reason they named it is
 * usually that the search would find the wrong one.
 *
 * `env` and `executables` are parameters so this stays testable on any host,
 * with any OS's rules; the caller passes `process.env`, which for the
 * extension host is the IDE's own environment.
 */
export function claudeBinary(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  executables: Executables = platform.executables
): Promise<BinaryFound | BinaryMissing> {
  return find(CLAUDE, override, env, executables);
}

/** The `grok` to spawn, or why there is none. Same search as `claudeBinary`. */
export function grokBinary(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  executables: Executables = platform.executables
): Promise<BinaryFound | BinaryMissing> {
  return find(GROK, override, env, executables);
}

/** The `codex` app-server binary to spawn. Same search as `claudeBinary`. */
export function codexBinary(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  executables: Executables = platform.executables
): Promise<BinaryFound | BinaryMissing> {
  return find(CODEX, override, env, executables);
}

async function find(
  cli: Cli,
  override: string | undefined,
  env: NodeJS.ProcessEnv,
  executables: Executables
): Promise<BinaryFound | BinaryMissing> {
  const setting = override?.trim();
  const search = await executables.find(
    {
      ...(setting ? { setting } : {}),
      installed: path.join(os.homedir(), cli.installed),
      name: cli.name
    },
    env
  );
  if (search.kind === 'found') {
    return { ok: true, program: search.program, path: search.path, source: search.source };
  }
  if (search.kind === 'setting') {
    return {
      ok: false,
      reason:
        search.refused !== undefined
          ? `The \`${cli.name}\` path in settings cannot be started: ${search.refused}`
          : `The \`${cli.name}\` path in settings is not an executable file: ${search.file}`
    };
  }
  return {
    ok: false,
    reason: search.refused
      ? `${search.refused} Looked in ${cli.looked} and on this process’s PATH — set ` +
        `\`${cli.setting}\` to an executable it can start.`
      : `No \`${cli.name}\` executable found. Looked in ${cli.looked} and on this ` +
        `process’s PATH — set \`${cli.setting}\` to where it is installed.`
  };
}
