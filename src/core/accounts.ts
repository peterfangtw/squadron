/**
 * Product account types — brand-neutral so a second CLI's login cannot grow
 * an arm inside Claude's auth file.
 *
 * Status parses stay at each CLI's seam. This file paints the product row
 * and names the login child's events.
 */

import { mapBrands, sessionBrand } from './brands';
import type { BrandId, RateLimits } from './model';

/** One row of the accounts list, already in panel vocabulary. */
export type AccountRow = {
  brand: BrandId;
  /** Display name. The webview must not invent this from `brand`. */
  name: string;
  /** Paint key for the mark table. Same strings as `brand` today. */
  mark: string;
  state: 'signed_in' | 'signed_out' | 'coming_soon' | 'not_installed';
  /** Primary line: email, "Signed in", "Not installed", or empty for coming soon. */
  label?: string;
  /** Secondary line: `Claude · 4 sessions`, `Coming soon`, … */
  detail: string;
  /** Plan chip when the CLI named one (e.g. Max). */
  plan?: string;
  /** Nested plan usage when signed in. */
  usage?: RateLimits;
};

export type LoginPhase = 'starting' | 'browser' | 'paste' | 'waiting' | 'done' | 'error';

export type LoginEvent =
  | { type: 'phase'; phase: LoginPhase; message?: string }
  /**
   * The sign-in door, and **re-emitted whenever a field of it is revised** —
   * Grok reads the `userCode` off a line after the URL and sends the pair
   * again. So a consumer that paints this follows every one, and a consumer
   * that *acts* on it acts once per login: a second `openExternal` is a second
   * tab, not a corrected one.
   *
   * The URL itself never changes door mid-login. A producer reading it out of
   * a stream owes `settledPrefix` for that — a half-written one emitted early
   * is a revision the rule above cannot save.
   */
  | { type: 'url'; url: string; userCode?: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null };

/**
 * The part of a chunk no later chunk can change: up to its last whitespace.
 * Everything after that is a token still being written.
 *
 * A login child is read as it arrives, and the tail of its buffer is scanned
 * before the newline that ends it — the paste prompt never sends one. Scanning
 * the raw tail read a URL split across two chunks as a whole one: the truncated
 * half went out as a `url` event, the entire URL followed it, and the host
 * opened both.
 */
export function settledPrefix(buf: string): string {
  const tail = buf.search(/\s\S*$/);
  return tail === -1 ? '' : buf.slice(0, tail + 1);
}

/** One login child. Caller owns lifecycle: submit code (Claude), cancel. */
export type LoginSession = {
  submit(code: string): void;
  cancel(): void;
};

export type AccountStatus = {
  loggedIn: boolean;
  email?: string;
};

/** What the account store keeps. Extra CLI fields are dropped before they land. */
export type AccountRowStatus = AccountStatus & { plan?: string };

/** A brand's own status read, cut to what a row draws and nothing else. */
export function rowStatus(status: {
  loggedIn: boolean;
  email?: string;
  plan?: string;
}): AccountRowStatus {
  return {
    loggedIn: status.loggedIn,
    ...(status.email ? { email: status.email } : {}),
    ...(status.plan ? { plan: status.plan } : {})
  };
}

/**
 * Merge one auth poll into the store.
 *
 * A brand whose answer is `undefined` keeps its previous entry. Claude's probe
 * answers that on a missing binary, a timeout, a spawn error, and stdout that
 * will not parse — writing it through would sign the reader out until the next
 * tick. An answer replaces. A brand this poll did not mention keeps whatever it
 * had, and one never stored stays absent, which is not a signed-out reading.
 */
export function foldAccountStatuses(
  prev: Partial<Record<BrandId, AccountRowStatus>>,
  answers: Partial<Record<BrandId, AccountRowStatus | undefined>>
): Partial<Record<BrandId, AccountRowStatus>> {
  const next: Partial<Record<BrandId, AccountRowStatus>> = { ...prev };
  for (const brand of Object.keys(answers) as BrandId[]) {
    const answer = answers[brand];
    if (answer === undefined) continue;
    next[brand] = answer;
  }
  return next;
}

/** Commit a completed auth fan-out only if no newer one started meanwhile. */
export function completeAccountPoll(
  state: {
    authGen: number;
    authTried: Partial<Record<BrandId, boolean>>;
    accounts: Partial<Record<BrandId, AccountRowStatus>>;
    installed: Partial<Record<BrandId, boolean>>;
  },
  generation: number,
  answers: Partial<Record<BrandId, AccountRowStatus | undefined>>,
  installed: Partial<Record<BrandId, boolean>>
): boolean {
  if (generation !== state.authGen) return false;
  state.authTried = Object.fromEntries(Object.keys(answers).map((brand) => [brand, true]));
  state.accounts = foldAccountStatuses(state.accounts, answers);
  state.installed = installed;
  return true;
}

/** Identity and extras a status parse does not carry. `plan` is Claude's. */
export type AccountBrandFacts = {
  brand: BrandId;
  sessionCount: number;
  usage?: RateLimits;
  plan?: string;
  /** Whether this brand's binary resolved. Absent until the host has looked. */
  installed?: boolean;
  /** Host of the brand's install page, so a not-installed row says where
   *  Install goes before anyone clicks it. */
  installHost?: string;
};

const NAME: Record<BrandId, string> = {
  claude: 'Claude',
  grok: 'Grok',
  codex: 'Codex'
};

/**
 * What a reader calls a brand.
 *
 * Exported off the accounts list's own map rather than restated, because there
 * is no second answer to give: this is the map that already had to name `codex`,
 * which has no adapter to be asked. **That is the argument for where this
 * lives** — a brand has a name before this build can drive it, so the name is a
 * fact about the brand and not about the CLI port. A `CliAdapter.label` was
 * tried and removed for exactly that: it could not answer for the one brand
 * this map exists to name.
 */
export function brandName(brand: BrandId): string {
  return NAME[brand];
}

/** Absent brand is the pre-seam default, so it counts on the Claude row only. */
export function accountSessionCounts(
  sessions: readonly { readonly brand?: BrandId }[]
): Record<BrandId, number> {
  const counts = mapBrands(() => 0);
  for (const session of sessions) counts[sessionBrand(session.brand)] += 1;
  return counts;
}

export function accountRow(status: AccountStatus, brandFacts: AccountBrandFacts): AccountRow {
  const name = NAME[brandFacts.brand];
  // Ahead of sign-in: an account whose CLI cannot run is not one to show as
  // live, whatever its status says (`brandAvailability` has why they differ).
  if (brandFacts.installed === false) {
    return {
      brand: brandFacts.brand,
      name,
      mark: brandFacts.brand,
      state: 'not_installed',
      label: 'Not installed',
      detail: brandFacts.installHost ? `${name} · installs from ${brandFacts.installHost}` : name
    };
  }
  if (!status.loggedIn) {
    return {
      brand: brandFacts.brand,
      name,
      mark: brandFacts.brand,
      state: 'signed_out',
      label: 'Not signed in',
      detail: name
    };
  }
  const sessions =
    brandFacts.sessionCount > 0
      ? ` · ${brandFacts.sessionCount} session${brandFacts.sessionCount === 1 ? '' : 's'}`
      : '';
  return {
    brand: brandFacts.brand,
    name,
    mark: brandFacts.brand,
    state: 'signed_in',
    label: status.email ?? 'Signed in',
    detail: name + sessions,
    ...(brandFacts.plan ? { plan: brandFacts.plan } : {}),
    usage: brandFacts.usage
  };
}

/**
 * Account rows for the wire. Does not map any CLI's status JSON — callers pass
 * already-built rows in the product's paint order.
 */
export function accountRows(rows: readonly AccountRow[]): AccountRow[] {
  return [...rows];
}
