import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { tempHome, writeJson, win } from '../helpers';

type GrokUsage = typeof import('../../core/grok/usage');
type GrokFetch = import('../../core/grok/usage').GrokFetch;

let usage: GrokUsage;
let store: typeof import('../../core/usage');
let home: string;

before(async () => {
  home = await tempHome();
  usage = await import('../../core/grok/usage');
  store = await import('../../core/usage');
});

beforeEach(async () => {
  await store.forgetUsageFor('grok', home);
  await fs.rm(path.join(home, '.squadron'), { recursive: true, force: true });
  await fs.rm(path.join(home, '.grok'), { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Observed 2026-08-16, CLI 1.0.4 live body (subset the fold reads).
 *
 * The *shape* is the observation — a seven-day weekly period. The instants are
 * anchored to test time rather than recorded, because `currentUsage` drops a
 * reading past its reset: the observed `2026-08-30` end turned four passing
 * tests red on 2026-08-31 with no code change, and a later fixed date would do
 * it again. Anything asserting a specific instant reads `RESETS`, which is
 * derived from this.
 */
const PERIOD_END = new Date(Date.now() + 2 * DAY_MS);
const LIVE = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: new Date(PERIOD_END.getTime() - 7 * DAY_MS).toISOString(),
      end: PERIOD_END.toISOString()
    },
    creditUsagePercent: 32.0
  }
};

const RESETS = Math.floor(Date.parse(LIVE.config.currentPeriod.end) / 1000);

/** A clock inside the recorded period. The walk clears a figure whose window
 *  has reset, so scenarios about what a *fetch* does have to be walked while
 *  the body they fetch is still current — on the wall clock these went red the
 *  day the recording's own week ended. */
const WITHIN = Date.parse(LIVE.config.currentPeriod.start) + 60_000;

async function writeKey(): Promise<void> {
  const file = path.join(home, '.grok', 'auth.json');
  await writeJson(file, { 'https://auth.x.ai::client': { key: 'k'.repeat(24) } });
}

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body)
  } as Response;
}

function stubFetch(body: unknown, status = 200) {
  return () => Promise.resolve(jsonRes(body, status));
}

describe('grokUsageFrom', () => {
  it('folds the 2026-08-16 live shape', () => {
    const view = usage.grokUsageFrom(LIVE);
    // Both windows the panel can draw: the one Grok has, and the one it does
    // not, which is `null` rather than absent so the chip can say `5h none`.
    assert.deepEqual(
      view?.windows.map((window) => window.id),
      ['session', 'weekly']
    );
    assert.equal(win(view, 'weekly')?.pct, 32);
    assert.equal(win(view, 'weekly')?.resetsAt, RESETS);
    assert.equal(win(view, 'session')?.pct, null);
  });

  it('keeps the weekly window with no percent', () => {
    const view = usage.grokUsageFrom({
      config: { currentPeriod: LIVE.config.currentPeriod }
    });
    // The reset time survives a missing percent: we know when the window turns
    // over even when we have no figure inside it.
    assert.deepEqual(view, {
      windows: [
        { id: 'session', short: '5h', pct: null },
        { id: 'weekly', short: 'wk', resetsAt: RESETS }
      ]
    });
  });

  it('rejects a non-object', () => {
    assert.equal(usage.grokUsageFrom(null), undefined);
    assert.equal(usage.grokUsageFrom('nope'), undefined);
    assert.equal(usage.grokUsageFrom(1), undefined);
  });

  it('rejects a percent that is not finite', () => {
    const view = usage.grokUsageFrom({
      config: { creditUsagePercent: Number.POSITIVE_INFINITY }
    });
    assert.deepEqual(view, {
      windows: [
        { id: 'session', short: '5h', pct: null },
        { id: 'weekly', short: 'wk' }
      ]
    });
  });
});

/** Grok's port, as `grok/adapter.ts` binds it. `read` is stubbed per test —
 *  what the seam promises is the answer's shape, not the socket. */
const grokPort = (
  read: () => Promise<import('../../core/model').RateLimits | undefined>
): import('../../core/adapter').UsageSource => ({
  windows: [usage.GROK_SESSION, usage.GROK_WINDOW],
  read,
  everyMs: 0,

  noResetMs: usage.GROK_NO_RESET_MS
});

/**
 * One pass of the host's walk — `core/usage.ts`'s own, so these scenarios cannot
 * drift from what ships.
 *
 * The read clock is wound back each time because these are about what a fetch
 * does, not about how often one is spent; the cadence has its own tests. A
 * record with no figure comes back as nothing, since the question here is
 * whether there is a reading rather than which windows the brand has.
 */
async function pass(fetchImpl: ReturnType<typeof stubFetch>) {
  const port = grokPort(() => usage.readGrokUsage({ home, fetch: fetchImpl }));

  const view = await store.walkUsage([{ brand: 'grok', source: port, signedIn: true }], {
    sessions: [],

    now: WITHIN,
    home
  });
  const got = view.get('grok');
  return got?.windows.some((window) => typeof window.pct === 'number') ? got : undefined;
}

describe('readGrokUsage', () => {
  it('returns the folded 200 body', async () => {
    await writeKey();
    const view = await usage.readGrokUsage({ home, fetch: stubFetch(LIVE) });
    assert.equal(win(view, 'weekly')?.pct, 32);
    assert.equal(win(view, 'session')?.pct, null);
  });

  it('answers nothing on a 401, and touches no store', async () => {
    await writeKey();
    await store.writeStoredUsage(
      'grok',
      { windows: [{ id: 'weekly', short: 'wk', pct: 32 }] },
      home
    );
    assert.equal(await usage.readGrokUsage({ home, fetch: stubFetch({}, 401) }), undefined);
    // A 401 still says nothing about the account: renewal is attempted only
    // for a bearer whose stated expiry has passed, and this one states none.
    const file = path.join(home, '.squadron', 'usage.grok.json');
    assert.equal(win(await store.readStoredUsage('grok', home), 'weekly')?.pct, 32);
    assert.ok(await fs.stat(file));
  });

  it('answers nothing when auth.json yields no key', async () => {
    // The CLI rewrites `auth.json` on every 6h token refresh (observed
    // 2026-08-18: birth and `create_time` move together). A file we cannot read
    // a key out of is that, not a sign-out.
    await writeJson(path.join(home, '.grok', 'auth.json'), { 'https://auth.x.ai::client': {} });
    assert.equal(await usage.readGrokUsage({ home, fetch: stubFetch(LIVE) }), undefined);
  });

  it('treats a missing percent as no weekly reading', async () => {
    await writeKey();
    const view = await usage.readGrokUsage({
      home,
      fetch: stubFetch({ config: { currentPeriod: LIVE.config.currentPeriod } })
    });
    // The window is still Grok's; what is missing is a figure for it.
    assert.deepEqual(view, {
      windows: [
        { id: 'session', short: '5h', pct: null },
        { id: 'weekly', short: 'wk', resetsAt: RESETS }
      ]
    });
    assert.equal(win(view, 'weekly')?.pct, undefined);
  });
});

describe("the account's Grok reading, end to end", () => {
  it('keeps last good on 401', async () => {
    await writeKey();
    await pass(stubFetch(LIVE));
    assert.equal(win(await pass(stubFetch({}, 401)), 'weekly')?.pct, 32);
  });

  it('keeps the figure when auth.json goes, because a poll may not forget', async () => {
    await writeKey();
    await pass(stubFetch(LIVE));
    await fs.rm(path.join(home, '.grok', 'auth.json'));
    // The regression this replaces: the poll used to read a missing or
    // half-written `auth.json` as a sign-out and delete the store under it, so a
    // figure went for the length of a file rewrite. Only the verb forgets now.
    assert.equal(win(await pass(stubFetch(LIVE)), 'weekly')?.pct, 32);
    await store.forgetUsageFor('grok', home);
    assert.equal(await store.readStoredUsage('grok', home), undefined);
  });

  it('lets a topped-up account read lower inside the same period', async () => {
    await writeKey();
    await pass(stubFetch(LIVE));
    const cheaper = {
      config: { ...LIVE.config, creditUsagePercent: 4 }
    };
    // Credits bought mid-period: same `currentPeriod.end`, lower figure, and the
    // later reading is the true one. Every brand reads that way now.
    assert.equal(win(await pass(stubFetch(cheaper)), 'weekly')?.pct, 4);
  });

  it('drops an expired weekly', async () => {
    await writeKey();
    const past = Math.floor(WITHIN / 1000) - 60;
    await pass(
      stubFetch({
        config: {
          creditUsagePercent: 40,
          currentPeriod: { end: new Date(past * 1000).toISOString() }
        }
      })
    );
    // Last period's 40% is not low, it is wrong — and with its figure gone the
    // record states nothing, which is no reading at all. The signed-in row still
    // says Grok has a weekly window, so the chip draws `wk -`.
    assert.equal(await pass(stubFetch({}, 401)), undefined);
  });
});

/** `expires_at` in the CLI's spelling, so the reader takes the same path it
 *  takes against a real file. */
const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, -1)}000+00:00`;

async function writeKeyExpiring(expiresAt: string): Promise<void> {
  await writeJson(path.join(home, '.grok', 'auth.json'), {
    'https://auth.x.ai::client': {
      key: 'k'.repeat(24),
      refresh_token: 'r'.repeat(24),
      oidc_client_id: 'client',
      expires_at: expiresAt
    }
  });
}

/** A billing GET that records which bearer it was handed. */
function watchedFetch(body: unknown): { fetch: GrokFetch; seen: (string | undefined)[] } {
  const seen: (string | undefined)[] = [];
  return {
    seen,
    fetch: (_url, init) => {
      seen.push(init?.headers?.Authorization);
      return Promise.resolve(jsonRes(body));
    }
  };
}

describe('readGrokUsage renewal', () => {
  it('sends no refresh while the bearer is still good', async () => {
    await writeKeyExpiring(stamp(Date.now() + 3_600_000));
    let asked = 0;
    const view = await usage.readGrokUsage({
      home,
      fetch: stubFetch(LIVE),
      refresh: () => {
        asked += 1;
        return Promise.resolve(undefined);
      }
    });
    assert.equal(asked, 0);
    assert.equal(win(view, 'weekly')?.pct, 32);
  });

  it('sends no refresh when the bearer states no expiry', async () => {
    // An unknown clock must never become a token POST every poll — the token
    // rotates on use, so a guess here is spent credential, not a wasted request.
    await writeKey();
    let asked = 0;
    const view = await usage.readGrokUsage({
      home,
      fetch: stubFetch(LIVE),
      refresh: () => {
        asked += 1;
        return Promise.resolve(undefined);
      }
    });
    assert.equal(asked, 0);
    assert.equal(win(view, 'weekly')?.pct, 32);
  });

  it('bills with the renewed bearer once the old one has expired', async () => {
    await writeKeyExpiring(stamp(Date.now() - 60_000));
    const billing = watchedFetch(LIVE);
    const view = await usage.readGrokUsage({
      home,
      fetch: billing.fetch,
      refresh: () => Promise.resolve({ key: 'renewed', expiresAt: Date.now() + 3_600_000 })
    });
    assert.deepEqual(billing.seen, ['Bearer renewed']);
    assert.equal(win(view, 'weekly')?.pct, 32);
  });

  it('answers nothing when renewal fails, and touches no store', async () => {
    await writeKeyExpiring(stamp(Date.now() - 60_000));
    await store.writeStoredUsage(
      'grok',
      { windows: [{ id: 'weekly', short: 'wk', pct: 32 }] },
      home
    );
    const billing = watchedFetch(LIVE);
    assert.equal(
      await usage.readGrokUsage({
        home,
        fetch: billing.fetch,
        refresh: () => Promise.resolve(undefined)
      }),
      undefined
    );
    // No expired bearer reaches billing: the reading we already have is better
    // than a 401, and renewal failing is not news about the account.
    assert.deepEqual(billing.seen, []);
    assert.equal(win(await store.readStoredUsage('grok', home), 'weekly')?.pct, 32);
  });
});
