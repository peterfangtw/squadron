/**
 * What a directory can be told to run, and how a port reaches it.
 *
 * Detection only, deliberately: one obvious script or none. A wrong guess costs
 * more than a blank, so an ambiguous `package.json` resolves to nothing here and
 * `candidateRunners` hands the list on instead — `ServerRowView.candidates` is
 * where what becomes of it is written down.
 *
 * **The port flag is measured, not assumed** (2026-07-26, task file):
 * `PORT=4321 npm run dev` against Vite served **5173**, so an env variable is
 * not a port for every toolchain. An appended flag beat both `PORT` and a
 * pinned `-p 3001` in the script itself, which is why the flag goes last.
 */

import { createHash } from 'crypto';
import * as platform from '../platform';

/**
 * Everything one directory answers about starting, as `host/runs.ts` memoises
 * it. Named here rather than written inline at each holder: it was the same
 * literal in three files, so a field cost three identical edits.
 *
 * `key` is the cache token — the manifests' mtimes and the settings that shaped
 * the answer — and belongs to the record for the same reason: a caller holding
 * the offer can tell whether it is still the one it read.
 */
export type RunnerOffer = {
  key: string;
  runners: Runner[];
  workspaces: boolean;
  candidates: Runner[];
};

/** One thing a directory can start. */
export type Runner = {
  /** Stable across polls and windows: the npm script's own name. */
  id: string;
  /** What the row calls it. */
  label: string;
  /** The shell line, carrying `${port}` unless the runner is portless. */
  command: string;
  /** No port at all — the extension dev host, which opens a window instead. */
  portless?: boolean;
  /**
   * The command carries no measured flag, so the port rides on `PORT` alone and
   * may be ignored. The row says so rather than lying about where the server is.
   */
  guessed?: boolean;
  /**
   * The port this toolchain serves on unasked — a convention, not a
   * measurement, and it binds nothing: the flag in `command` is what decides
   * the port. Set only where that flag was measured, so never on a `guessed`
   * runner. The servers sheet offers the block that starts here.
   */
  defaultPort?: number;
};

/** The `package.json` fields this reads. Everything else is none of its business. */
export type PackageJson = {
  scripts?: { [name: string]: string };
  dependencies?: { [name: string]: string };
  devDependencies?: { [name: string]: string };
  /** `vscode` here is what makes a directory an extension, and so bootable as
   *  a development host. */
  engines?: { [name: string]: string };
  /**
   * The monorepo declaration, in both spellings npm accepts. Read by
   * `core/devservers/workspaces.ts` and by nothing here — a workspace root's own runner is
   * detected exactly like any other directory's.
   */
  workspaces?: string[] | { packages?: string[] };
};

/** In preference order, though two matches resolve to none rather than the first. */
const CANDIDATES = ['dev', 'start', 'serve', 'storybook'];

/**
 * The port flag each toolchain was observed to honour, and the port it serves
 * on unasked. Anything not here gets `PORT` and a `guessed` mark — never an
 * invented flag, since an unknown one is an argument error at best and a
 * silently different port at worst. One table, so a toolchain cannot carry a
 * flag without a port or the reverse.
 */
const FLAGS: { [pkg: string]: { flag: string; port: number } } = {
  vite: { flag: '-- --port ${port}', port: 5173 },
  next: { flag: '-- -p ${port}', port: 3000 },
  // Measured 2026-08-04 against `~/src/acme-web/apps/site`,
  // astro 5.x: `PORT=4399 npm run dev` served **4321**, its own default, and
  // the appended flag served 4399.
  astro: { flag: '-- --port ${port}', port: 4321 },
  // Measured the same day against `apps/support-worker`, wrangler 4.63:
  // `PORT=4399` served **8787**, and the appended flag served the port asked
  // for. Wrangler binds `[::1]`, which is why `free()` tests both families.
  wrangler: { flag: '-- --port ${port}', port: 8787 }
};

/**
 * The one script a directory obviously serves from, or nothing.
 *
 * Two candidates is nothing, not the first: a repo with both `dev` and `start`
 * has made a distinction this cannot read.
 */
export function detectRunner(pkg: PackageJson | undefined): Runner | undefined {
  const [name, ...rest] = candidatesIn(pkg);
  return name !== undefined && rest.length === 0 ? runnerFor(name, pkg) : undefined;
}

/**
 * The scripts detection refused to choose between, as runners — empty whenever
 * `detectRunner` had an answer, or where there was never a candidate. The two
 * never both return something, and no board row is drawn from this one.
 */
export function candidateRunners(pkg: PackageJson | undefined): Runner[] {
  const found = candidatesIn(pkg);
  return found.length > 1 ? found.map((name) => runnerFor(name, pkg)) : [];
}

const candidatesIn = (pkg: PackageJson | undefined): string[] =>
  CANDIDATES.filter((name) => typeof pkg?.scripts?.[name] === 'string');

/** One script's runner. The ambiguity above is about *which* script, never about
 *  how a port reaches it, so both callers build a runner the same way. */
function runnerFor(name: string, pkg: PackageJson | undefined): Runner {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  // First match wins, and a package can depend on two of these — acme-web's
  // `apps/site` carries both `astro` and `wrangler`, since it deploys to one
  // and is built by the other. They were measured to take the same flag, so the
  // order costs no boot today — only which block is offered (astro's, since it
  // is listed first); a toolchain added here with a *different* flag would need
  // this to read the script body rather than the dependency list.
  const known = Object.entries(FLAGS).find(([toolchain]) => toolchain in deps)?.[1];
  return {
    id: name,
    label: `npm run ${name}`,
    command: known ? `npm run ${name} ${known.flag}` : `npm run ${name}`,
    ...(known ? { defaultPort: known.port } : { guessed: true })
  };
}

/**
 * An extension development host for this directory, when it is an extension and
 * the caller could find the IDE's own launcher.
 *
 * Port-less: it opens a window rather than listening on anything, so there is
 * nothing to pick and nothing to probe — the terminal existing is the whole of
 * "it started". It is here beside the dev servers because the question a reader
 * asks is the same one, and `docs/PRD/PRD_shipped_dev_servers.md` A11 says one
 * optional field covers it.
 *
 * `npm run compile &&` is folded in deliberately (Q6): `tsc` and `esbuild` are
 * separate tools here, and a dev host booted without the second one silently
 * runs whatever was in `dist/` last.
 */
export function devHostRunner(
  cwd: string,
  pkg: PackageJson | undefined,
  ideCli: string | undefined
): Runner | undefined {
  if (!ideCli || !pkg?.engines?.['vscode']) {
    return undefined;
  }
  return {
    id: 'devhost',
    label: 'Extension dev host',
    // Quoted, both of them: an install path has spaces in it far more often
    // than a repo path does, and neither is ours to assume anything about.
    // Two commands, so composed here: `render` spells only the second.
    command: `npm run compile && ${platform.commands.render(
      ideCli,
      [{ option: '--extensionDevelopmentPath', value: cwd }],
      { program: 'unescapedDouble', args: 'unescapedDouble' },
      // The terminal's shell is the dev-servers plan's to observe (W7.4).
      'posix'
    )}`,
    portless: true
  };
}

/**
 * What a directory offers: what the reader wrote down for it, or what detection
 * found. Settings win outright — a person who has named a command has answered
 * the question detection is guessing at.
 *
 * The dev host is appended rather than competing: it is not a dev server, and a
 * repo that is both an extension and a web project should offer both.
 */
export function resolveRunners(
  cwd: string,
  settings: { commands?: { [cwd: string]: Runner[] }; detect?: boolean; ideCli?: string },
  pkg: PackageJson | undefined
): Runner[] {
  const named = namedRunners(commandsFor(settings.commands, cwd));
  if (settings.detect === false) {
    // The setting is "read `package.json` at all", so it silences the dev host
    // too — that is a read of `engines` and nothing else.
    return named;
  }
  const base = named.length ? named : toList(detectRunner(pkg));
  return [...base, ...toList(devHostRunner(cwd, pkg, settings.ideCli))];
}

/**
 * The reader's entry for a directory. Its keys are paths a person typed, so
 * they match by key, an exact spelling first.
 */
function commandsFor(commands: { [cwd: string]: unknown } | undefined, cwd: string): unknown {
  if (!commands) return undefined;
  if (Object.hasOwn(commands, cwd)) return commands[cwd];
  const want = platform.paths.key(cwd);
  return Object.entries(commands).find(([dir]) => platform.paths.key(dir) === want)?.[1];
}

/**
 * The settings entry, narrowed. This is typed `Runner[]` and is whatever JSON
 * the reader put in `settings.json` — the contributed schema is a bare object —
 * so it is a parse of a file another program wrote like any other here.
 *
 * A bare string is the edit to expect (`"/repo": "npm run dev"`), and spreading
 * one gives a runner per character; an entry missing `command` reaches
 * `substitute` and throws off the message handler, after a record has already
 * been written. Both are a row that cannot work, so neither becomes a row.
 */
function namedRunners(value: unknown): Runner[] {
  return Array.isArray(value) ? value.filter(isRunner) : [];
}

/** Narrowed field by field, like `isServer` — `command` above all, which is what runs. */
function isRunner(value: unknown): value is Runner {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const runner = value as Partial<Runner>;
  return (
    typeof runner.id === 'string' &&
    runner.id.length > 0 &&
    typeof runner.label === 'string' &&
    typeof runner.command === 'string' &&
    runner.command.length > 0
  );
}

const toList = (runner: Runner | undefined): Runner[] => (runner ? [runner] : []);

/** `${port}` in a command line, wherever the reader put it. */
export function substitute(command: string, port: number | undefined): string {
  return port === undefined ? command : command.replaceAll('${port}', String(port));
}

/**
 * A runner's command, as something two windows can compare without either
 * sending the other a command to run.
 *
 * `squadron.run.commands` is per-workspace, so one `runnerId` can name a
 * different command in each window. When a start is routed, the addressed
 * window resolves the id under its own settings and checks this against the
 * asking window's — a mismatch is refused, and the start goes back to the
 * window whose reader chose it. Unsubstituted, since the port is chosen per
 * start and is not what is being compared.
 */
export function commandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 16);
}
