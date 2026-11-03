/**
 * The one command line both agent-facing CLIs are written in.
 *
 * Flag/value pairs, and nothing cleverer — every value here is free text, and a
 * prompt full of spaces and quotes must survive being one argument.
 *
 * A flag the caller does not declare is malformed, and that is the whole of the
 * difference from a bag of strings: `--promt hello` used to parse perfectly and
 * be reported as "a `--prompt` is required", which sends an agent looking for a
 * missing argument it is in fact passing. The usage line, which lists every
 * flag, is the answer to the question actually being asked.
 *
 * Shared rather than copied because there are two of these now: a rule about
 * what an agent's mistake looks like is one an agent should meet the same way
 * whichever command it typed.
 */

import { BRANDS, isBrand } from '../core/brands';
import { IDENTITY_ENV } from '../core/identity';
import type { BrandId } from '../core/model';

export const BRAND_CHOICES = BRANDS.join('|');

export const BRAND_WORDS = brandWords(BRANDS);

/** What the command line said, once: every declared flag, all optional. */
export type Flags<F extends readonly string[]> = { [K in F[number]]?: string };

/**
 * `undefined` means malformed, which the caller reports as usage rather than
 * guessing.
 *
 * `bare` names the flags that take no value — `--only`, `--self`. They are
 * stored as the empty string, so presence is `!== undefined` and never
 * truthiness: a value-taking flag can legitimately be given `""`, and one test
 * for both kinds is one fewer rule to remember. Declared apart from `flags`
 * rather than inferred, because the pair walk is what lets a *value* start with
 * `--` — guessing from the next argument would make `--name --only` mean two
 * different things depending on what followed it.
 *
 * It is typed `F[number][]`, not `string[]`, so a name that is not a declared
 * flag will not compile. Spelt loosely, a typo'd `bare` entry silently failed to
 * match: the flag then took a value, and `--only --self` parsed as
 * `only: '--self'` — a command line meaning something else, from a mistake the
 * compiler was already holding the answer to.
 */
export function parseFlags<F extends readonly string[]>(
  argv: readonly string[],
  flags: F,
  bare: readonly F[number][] = []
): Flags<F> | undefined {
  const out: Flags<F> = {};
  for (let i = 0; i < argv.length;) {
    const flag = argv[i];
    if (flag === undefined || !flag.startsWith('--')) {
      return undefined;
    }
    // Asserted once, at the lookup: `F`'s constraint widens `find` back to
    // `string`, and an assertion at each write site is one more place a later
    // change goes unnoticed.
    const name = flags.find((known) => known === flag.slice(2)) as F[number] | undefined;
    // A repeat is malformed rather than last-wins: `--pids 1 --pids 2` would
    // otherwise wait on 2 alone, and no verb takes a flag twice.
    if (name === undefined || out[name] !== undefined) {
      return undefined;
    }
    if (bare.includes(name)) {
      out[name] = '';
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      return undefined;
    }
    out[name] = value;
    i += 2;
  }
  return out;
}

/**
 * A verb's flags that were renamed, old spelling to new, so the usage line it
 * prints can say which one the caller meant.
 */
export type Renamed<F extends readonly string[]> = Readonly<Record<string, F[number]>>;

/**
 * The usage line, led by every renamed flag the command line used. The old
 * spelling is refused, not accepted: one live spelling per flag.
 *
 * Only asked once `parseFlags` has refused the line, so an argument is not told
 * apart from a value here: a value that reads `--title` earns a hint about a
 * line that is already wrong.
 */
export function usageFor<F extends readonly string[]>(
  argv: readonly string[],
  usage: string,
  renamed: Renamed<F>
): string {
  const used = new Set(
    argv.map((arg) => arg.slice(2)).filter((name) => Object.hasOwn(renamed, name))
  );
  return [...[...used].map((name) => `--${name} is now --${renamed[name]}`), usage].join('\n');
}

/**
 * This process's session id, from whichever brand planted it.
 *
 * Every brand's spelling is one row of `IDENTITY_ENV` (`core/identity.ts`),
 * which carries when each was observed.
 *
 * **Why a marker outranks an id.** Observed 2026-08-16: an extension host
 * launched from a Claude session leaks that brand's id onto every child, since
 * `childTransport` copies `process.env`. A marker is set only in a process that
 * genuinely is that brand's tool child, so it survives the leak where an id
 * cannot — without the marked pass first, a Grok spawn under such a host would
 * be parented on the host's ancestor.
 *
 * **The order matters less than it looks, and that is deliberate.** No ordering
 * of these rungs is safe on its own: a host booted from one brand's shell tool
 * carries that brand's id, so whichever rung is highest wins for every session
 * under it regardless of what the session actually is. `childTransport`
 * (`core/session.ts`) settles it instead by deleting every name in that same
 * table from every child it spawns, which is why a session we start only ever
 * finds the one its own CLI planted. What is left is a CLI someone *types*
 * inside another session's terminal, where both vars are genuinely present and
 * only a marker can tell them apart — so the table's declaration order is the
 * better guess there and not a guarantee, and reordering it changes this
 * answer.
 *
 * Empty is absent. Shared so `squadron-spawn`'s parent and
 * `squadron-end`'s `--caller-session-id` name this session the same way.
 */
export function ownSessionId(env: NodeJS.ProcessEnv): string | undefined {
  const entries = Object.values(IDENTITY_ENV);
  const marked = entries.filter(({ marker }) => marker !== undefined && env[marker]);
  return [...marked, ...entries]
    .map(({ id }) => env[id])
    .find((id) => id !== undefined && id !== '');
}

/**
 * The brand whose variable `ownSessionId` read, walked the same way: whose
 * command tool is running this verb, and so which shell runs what it prints.
 */
export function ownBrand(env: NodeJS.ProcessEnv): BrandId | undefined {
  const entries = Object.entries(IDENTITY_ENV) as [BrandId, (typeof IDENTITY_ENV)[BrandId]][];
  const marked = entries.filter(([, { marker }]) => marker !== undefined && env[marker]);
  return [...marked, ...entries].find(([, { id }]) => env[id] !== undefined && env[id] !== '')?.[0];
}

/**
 * The pid the CLI publishes this session's own state under, so a verb can find
 * its own record without knowing what a session is called.
 *
 * `IDENTITY_ENV`'s `pid` column, walked exactly as `ownSessionId` walks `id`
 * above — a marked process first, then declaration order. Which brands state
 * one, and the probes behind that, are on the column itself; only Claude does,
 * so a caller of either other brand still reads as unknown here and
 * `pickWindow`'s origin term still does not fire for it.
 *
 * Claude's is the pid `readPublished` keys its map on, and it tracks a
 * `--resume` that changes the process, which the sessionId does not.
 *
 * A pid can be leaked down a process tree the way an id can, and unlike
 * `ownSessionId` this does not refuse one: a Grok or Codex tool child under a
 * Claude ancestor reads that ancestor's pid (observed 2026-09-08), which
 * resolves to the ancestor's window — usually the window that child wants. See
 * `IDENTITY_NAMES` for why the scrub leaves it alone.
 */
export function ownPid(env: NodeJS.ProcessEnv): number | undefined {
  const entries = Object.values(IDENTITY_ENV);
  const marked = entries.filter(({ marker }) => marker !== undefined && env[marker]);
  const stated = [...marked, ...entries]
    .map(({ pid }) => (pid === undefined ? undefined : env[pid]))
    .find((value) => value !== undefined && value !== '');
  const pid = Number(stated);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * A roster brand, or nothing. Empty is nothing — the window treats a missing
 * brand as Claude, and sending `""` would be a third spelling of the same
 * fact. A string that is not a brand is also nothing, so `main` can refuse it
 * as usage rather than posting a request the window will not start.
 */
export function asBrand(value: string | undefined): BrandId | undefined {
  return isBrand(value) ? value : undefined;
}

function brandWords(brands: readonly string[]): string {
  const last = brands.at(-1);
  if (last === undefined) return '';
  const head = brands.slice(0, -1);
  return head.length === 0 ? last : `${head.join(', ')} or ${last}`;
}
