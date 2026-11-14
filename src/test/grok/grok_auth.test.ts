import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { nodeCli } from '../fixtures/node_cli';
import { alive, heldDescendant, ownHeld, until, watchTable } from '../fixtures/root_only';
import { accountRow } from '../../core/accounts';
import type { ProcessTable } from '../../core/scan';
import { disposeHome, modeBitsSkip, needsFileSymlinks, tempHome } from '../helpers';

let home: string;
let grokPreflight: typeof import('../../core/grok/auth').grokPreflight;
let grokAuthStatus: typeof import('../../core/grok/auth').grokAuthStatus;
let grokAuthStamp: typeof import('../../core/grok/auth').grokAuthStamp;
let parseDeviceAuth: typeof import('../../core/grok/auth').parseDeviceAuth;
let startGrokLogin: typeof import('../../core/grok/auth').startGrokLogin;
let grokAuthLogout: typeof import('../../core/grok/auth').grokAuthLogout;
let grokAccessToken: typeof import('../../core/grok/auth').grokAccessToken;
let refreshGrokBearer: typeof import('../../core/grok/auth').refreshGrokBearer;
let grokRefreshLock: typeof import('../../core/paths').grokRefreshLock;
type GrokTokenFetch = import('../../core/grok/auth').GrokTokenFetch;
type TokenReply = Awaited<ReturnType<GrokTokenFetch>>;

after(() => disposeHome(home));

before(async () => {
  home = await tempHome();
  ({
    grokPreflight,
    grokAuthStatus,
    grokAuthStamp,
    parseDeviceAuth,
    startGrokLogin,
    grokAuthLogout,
    grokAccessToken,
    refreshGrokBearer
  } = await import('../../core/grok/auth'));
  ({ grokRefreshLock } = await import('../../core/paths'));
});

const authFile = (): string => path.join(home, '.grok', 'auth.json');

async function writeAuth(body: string): Promise<void> {
  await fs.mkdir(path.dirname(authFile()), { recursive: true });
  await fs.writeFile(authFile(), body);
}

/** Observed 2026-08-16, CLI 1.0.4, scratch HOME, `grok login --device-auth`. */
const DEVICE_STDERR = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=CGB6-Y7VF

Confirm this code in your browser:

  CGB6-Y7VF

\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m

Waiting for authorization...
`;

describe('grokPreflight', () => {
  it('refuses when auth.json is missing', async () => {
    await fs.rm(authFile(), { force: true });
    const ready = await grokPreflight();
    assert.equal(ready.ok, false);
    if (!ready.ok) {
      assert.equal(ready.reason, 'Grok is not signed in.');
    }
  });

  it('passes when a non-empty auth.json is there', async () => {
    await writeAuth('{"token":"x"}');
    assert.deepEqual(await grokPreflight(), { ok: true });
  });
});

describe('grokAuthStatus', () => {
  it('is signed out when the file is missing', async () => {
    const dir = path.join(home, 'missing-home');
    await fs.mkdir(dir, { recursive: true });
    assert.deepEqual(await grokAuthStatus(dir), { loggedIn: false });
  });

  it('is signed out when the file is empty', async () => {
    const dir = path.join(home, 'empty-home');
    const file = path.join(dir, '.grok', 'auth.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
    assert.deepEqual(await grokAuthStatus(dir), { loggedIn: false });
  });

  it('reads a nested email (observed 2026-08-16 shape)', async () => {
    const dir = path.join(home, 'email-home');
    const file = path.join(dir, '.grok', 'auth.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        'https://auth.x.ai::client': { email: 'reader@x.ai', key: 'do-not-return' }
      })
    );
    assert.deepEqual(await grokAuthStatus(dir), { loggedIn: true, email: 'reader@x.ai' });
  });

  it('is signed in without email when the field is absent', async () => {
    const dir = path.join(home, 'no-email-home');
    const file = path.join(dir, '.grok', 'auth.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ 'https://auth.x.ai::client': { key: 'x' } }));
    assert.deepEqual(await grokAuthStatus(dir), { loggedIn: true });
  });

  it('is signed out after logout clears the credential map', async () => {
    const dir = path.join(home, 'logout-home');
    const file = path.join(dir, '.grok', 'auth.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ 'https://auth.x.ai::client': { key: 'x' } }));
    assert.deepEqual(await grokAuthStatus(dir), { loggedIn: true });

    await fs.writeFile(file, '{}');
    assert.deepEqual(await grokAuthStatus(dir), { loggedIn: false });
  });

  it('treats malformed JSON as signed in without email', async () => {
    const dir = path.join(home, 'bad-json-home');
    const file = path.join(dir, '.grok', 'auth.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    assert.deepEqual(await grokAuthStatus(dir), { loggedIn: true });
  });
});

/** A bearer carrying a JWT `exp`, so the fallback has something true to read. */
const jwtWithExp = (seconds: number): string =>
  [
    'eyJhbGciOiJIUzI1NiJ9',
    Buffer.from(JSON.stringify({ exp: seconds })).toString('base64url'),
    'sig'
  ].join('.');

/** The observed 2026-08-16 shape: one top-level `https://auth.x.ai::<client-id>`. */
async function writeCredential(name: string, body: unknown): Promise<string> {
  const dir = path.join(home, name);
  const file = path.join(dir, '.grok', 'auth.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body));
  return dir;
}

describe('grokAccessToken', () => {
  it('is absent when the file is missing', async () => {
    const dir = path.join(home, 'token-missing');
    await fs.mkdir(dir, { recursive: true });
    assert.equal(await grokAccessToken(dir), undefined);
  });

  it('is absent when the file has no key', async () => {
    const dir = await writeCredential('token-no-key', { email: 'a@x.ai' });
    assert.equal(await grokAccessToken(dir), undefined);
  });

  it('reads the bearer and its stated expiry from one entry', async () => {
    const dir = await writeCredential('token-nested', {
      'https://auth.x.ai::client': {
        email: 'a@x.ai',
        key: 'x'.repeat(24),
        expires_at: '2026-08-16T09:46:09.123456+00:00'
      }
    });
    const bearer = await grokAccessToken(dir);
    assert.equal(bearer?.key, 'x'.repeat(24));
    assert.equal(bearer?.expiresAt, Date.parse('2026-08-16T09:46:09.123456+00:00'));
  });

  it('falls back to the bearer JWT exp when expires_at is missing', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const dir = await writeCredential('token-jwt', {
      'https://auth.x.ai::client': { key: jwtWithExp(exp) }
    });
    assert.equal((await grokAccessToken(dir))?.expiresAt, exp * 1000);
  });

  it('states no expiry for an opaque bearer', async () => {
    const dir = await writeCredential('token-opaque', {
      'https://auth.x.ai::client': { key: 'x'.repeat(24) }
    });
    const bearer = await grokAccessToken(dir);
    assert.equal(bearer?.key, 'x'.repeat(24));
    assert.equal(bearer?.expiresAt, undefined);
  });

  it('ignores an unparseable expires_at rather than guessing', async () => {
    const dir = await writeCredential('token-bad-expiry', {
      'https://auth.x.ai::client': { key: 'x'.repeat(24), expires_at: 'not a date' }
    });
    assert.equal((await grokAccessToken(dir))?.expiresAt, undefined);
  });

  it("never pairs one entry's bearer with another's expiry", async () => {
    const dir = await writeCredential('token-two', {
      'https://auth.x.ai::first': {
        key: 'a'.repeat(24),
        expires_at: '2026-08-16T09:46:09.000000+00:00'
      },
      'https://auth.x.ai::second': {
        key: 'b'.repeat(24),
        expires_at: '2027-01-01T00:00:00.000000+00:00'
      }
    });
    const bearer = await grokAccessToken(dir);
    assert.equal(bearer?.key, 'a'.repeat(24));
    assert.equal(bearer?.expiresAt, Date.parse('2026-08-16T09:46:09.000000+00:00'));
  });
});

describe('accountRow (grok)', () => {
  it('paints signed out', () => {
    const row = accountRow({ loggedIn: false }, { brand: 'grok', sessionCount: 0 });
    assert.equal(row.brand, 'grok');
    assert.equal(row.name, 'Grok');
    assert.equal(row.mark, 'grok');
    assert.equal(row.state, 'signed_out');
    assert.equal(row.label, 'Not signed in');
    assert.equal(row.detail, 'Grok');
    assert.equal(row.usage, undefined);
    assert.equal(row.plan, undefined);
  });

  it('paints signed in with email and session count', () => {
    const row = accountRow({ loggedIn: true, email: 'a@x.ai' }, { brand: 'grok', sessionCount: 2 });
    assert.equal(row.state, 'signed_in');
    assert.equal(row.label, 'a@x.ai');
    assert.equal(row.detail, 'Grok · 2 sessions');
    // Signed in with nothing fetched yet is a row with no reading. Which
    // windows Grok has is declared on its port and filled in by `refreshUsage`,
    // which is what draws `wk -` rather than nothing at all.
    assert.equal(row.usage, undefined);
  });

  it('says Signed in when there is no email', () => {
    const row = accountRow({ loggedIn: true }, { brand: 'grok', sessionCount: 0 });
    assert.equal(row.label, 'Signed in');
    assert.equal(row.detail, 'Grok');
  });
});

describe('parseDeviceAuth', () => {
  it('reads the observed 1.0.4 stderr', () => {
    assert.deepEqual(parseDeviceAuth(DEVICE_STDERR), {
      url: 'https://accounts.x.ai/oauth2/device?user_code=CGB6-Y7VF',
      userCode: 'CGB6-Y7VF'
    });
  });

  it('takes a bare /oauth2/device link', () => {
    assert.deepEqual(
      parseDeviceAuth('  https://accounts.x.ai/oauth2/device?user_code=NEJB-B6C2  '),
      {
        url: 'https://accounts.x.ai/oauth2/device?user_code=NEJB-B6C2',
        userCode: 'NEJB-B6C2'
      }
    );
  });

  it('takes XXXX-XXXX after Confirm this code when the URL has no user_code', () => {
    const text = 'Confirm this code in your browser:\n\n  ABCD-EF12\n';
    assert.deepEqual(parseDeviceAuth(text), { userCode: 'ABCD-EF12' });
  });

  it('says nothing when a chunk carries no device link', () => {
    assert.deepEqual(parseDeviceAuth('Waiting for authorization...'), {});
  });
});

describe('startGrokLogin', () => {
  it('emits url + userCode from a fixture child and cancels without throwing', async (t) => {
    const { bin } = await nodeCli(
      t,
      `process.stderr.write(${JSON.stringify(DEVICE_STDERR)}); hold();`
    );
    const events: { type: string; url?: string; userCode?: string; phase?: string }[] = [];
    const session = await startGrokLogin((event) => {
      if (event.type === 'url') events.push(event);
      if (event.type === 'phase') events.push({ type: 'phase', phase: event.phase });
    }, bin);
    assert.ok(!('ok' in session), 'fixture refused to start');
    const start = Date.now();
    while (!events.some((e) => e.type === 'url') && Date.now() - start < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const url = events.find((e) => e.type === 'url');
    assert.equal(url?.url, 'https://accounts.x.ai/oauth2/device?user_code=CGB6-Y7VF');
    assert.equal(url?.userCode, 'CGB6-Y7VF');
    assert.ok(events.some((e) => e.phase === 'waiting'));
    session.cancel();
  });
});

describe('startGrokLogin split URL', () => {
  it('emits one whole URL, and its code with it, when a chunk splits the link', async (t) => {
    // The `user_code` rides on this CLI's URL, so a half-read link is a sheet
    // with no code as well as a dead one. Claude's reader had the same hole:
    // `settledPrefix` is the shared answer.
    const fixture = await nodeCli(
      t,
      `
process.stderr.write("To sign in, open this URL in your browser:\\n\\n  https://accounts.x.ai/oauth2/device?user_c");
hold(() => process.stderr.write("ode=CGB6-Y7VF\\n"));
`
    );
    const { bin } = fixture;
    const urls: { url: string; userCode?: string }[] = [];
    const session = await startGrokLogin((event) => {
      if (event.type === 'url')
        urls.push({ url: event.url, ...(event.userCode ? { userCode: event.userCode } : {}) });
    }, bin);
    assert.ok(!('ok' in session), 'fixture refused to start');
    await fixture.ready();
    await fixture.output();
    assert.deepEqual(urls, []);
    await fixture.release();
    const start = Date.now();
    while (urls.length === 0 && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(urls, [
      { url: 'https://accounts.x.ai/oauth2/device?user_code=CGB6-Y7VF', userCode: 'CGB6-Y7VF' }
    ]);
    session.cancel();
  });
});

describe('startGrokLogin child env', () => {
  it('passes $BROWSER through untouched', async (t) => {
    // The override this used to set was dead — the CLI opens through
    // LaunchServices — and a `BROWSER=true` re-added here would be invisible
    // on macOS while silencing the open on any host that reads it.
    const { bin, seen } = await nodeCli(
      t,
      "fs.writeFileSync(seen, process.env.BROWSER ?? '<unset>'); hold();"
    );
    const before = process.env.BROWSER;
    process.env.BROWSER = 'sentinel-browser';
    try {
      const session = await startGrokLogin(() => {}, bin);
      assert.ok(!('ok' in session), 'fixture refused to start');
      const start = Date.now();
      while (Date.now() - start < 2000) {
        try {
          assert.equal(await fs.readFile(seen, 'utf8'), 'sentinel-browser');
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(await fs.readFile(seen, 'utf8'), 'sentinel-browser');
      session.cancel();
    } finally {
      if (before === undefined) delete process.env.BROWSER;
      else process.env.BROWSER = before;
    }
  });
});

describe('grokAuthLogout', () => {
  it('returns ok when the fixture exits 0', async (t) => {
    const { bin } = await nodeCli(t, 'process.exit(0);');
    assert.deepEqual(await grokAuthLogout(bin), { ok: true });
  });

  it('returns a reason when the fixture exits non-zero', async (t) => {
    const { bin } = await nodeCli(
      t,
      "process.stderr.write('nope\\n'); process.exitCode = 1; process.exit(1);"
    );
    const result = await grokAuthLogout(bin);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /nope/);
  });

  it('returns a reason when the binary is missing', async () => {
    const result = await grokAuthLogout(path.join(home, 'no-such-grok'));
    assert.equal(result.ok, false);
  });
});

describe('startGrokLogin missing binary', () => {
  it('refuses without throwing', async () => {
    const result = await startGrokLogin(() => {}, path.join(home, 'no-such-grok'));
    assert.equal('ok' in result && result.ok, false);
  });
});

/**
 * A process table with no Grok in it, and one credible enough to act on.
 *
 * `refreshGrokBearer` takes the scan as a seam because `/bin/ps` is hardcoded
 * at `scan.ts:313`: without it, "an empty table means ps failed" has nothing to
 * assert against, and a developer with `grok` open would go red on an unrelated
 * diff.
 */
const emptyTable = (): ProcessTable => ({
  claude: new Map(),
  grok: new Map(),
  codex: new Map(),
  parents: new Map(),
  starts: new Map(),
  groups: new Map(),
  shellParents: new Set()
});

const quietMachine = (): ProcessTable => ({
  ...emptyTable(),
  complete: true,
  parents: new Map([[1, 0]])
});

const grokRunning = (): ProcessTable => {
  const table = quietMachine();
  table.grok.set(4242, { pid: 4242, ppid: 1, command: 'grok agent stdio', startedAt: 0 });
  return table;
};

const OLD_REFRESH = 'refresh-old-'.repeat(3);
const NEW_REFRESH = 'refresh-new-'.repeat(3);

/** The observed live record, minus values that never leave the machine. */
const credentialFile = (refresh: string, expiresAt: string): unknown => ({
  'https://auth.x.ai::client': {
    email: 'a@x.ai',
    first_name: 'A',
    auth_mode: 'oauth',
    key: 'bearer-'.repeat(4),
    refresh_token: refresh,
    expires_at: expiresAt,
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'client',
    something_a_later_cli_added: 42
  }
});

const EXPIRED = '2020-01-01T00:00:00.000000+00:00';
const authPath = (dir: string): string => path.join(dir, '.grok', 'auth.json');

/** A token endpoint that counts what reached it, so "exactly one POST" is an
 *  assertion rather than a hope. */
type SentRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

function tokenEndpoint(reply: () => Promise<TokenReply>): {
  fetch: GrokTokenFetch;
  calls: SentRequest[];
} {
  const calls: SentRequest[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, ...init });
      return reply();
    }
  };
}

const ok = (body: unknown) => (): Promise<TokenReply> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

describe('refreshGrokBearer', () => {
  for (const persistent of [true, false]) {
    it(`reports ${persistent ? 'persistent' : 'transient'} rename failure without restarting persistence or refresh`, async (t) => {
      const dir = await writeCredential(
        `save-failure-${persistent}`,
        credentialFile(OLD_REFRESH, EXPIRED)
      );
      const file = authPath(dir);
      const before = await fs.readFile(file, 'utf8');
      const endpoint = tokenEndpoint(rotate());
      const rename = fs.rename;
      let attempts = 0;
      t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] !== file) return rename(...args);
        attempts++;
        if (persistent || attempts === 1) {
          throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
        }
        await rename(...args);
      });
      const options = {
        home: dir,
        fetch: endpoint.fetch,
        scan: () => Promise.resolve(quietMachine())
      };

      assert.equal(await refreshGrokBearer(options), undefined);
      assert.equal(attempts, 1);
      assert.equal(await fs.readFile(file, 'utf8'), before);
      assert.deepEqual(await fs.readdir(path.dirname(file)), ['auth.json']);
      assert.equal(await exists(lockFor(OLD_REFRESH, dir)), true);
      assert.equal(await refreshGrokBearer(options), undefined);
      assert.equal(endpoint.calls.length, 1);
      assert.equal(attempts, 1);
    });
  }

  it('persists the rotated token with one rename and keeps unknown credential fields', async (t) => {
    const dir = await writeCredential('save-success', credentialFile(OLD_REFRESH, EXPIRED));
    const file = authPath(dir);
    const endpoint = tokenEndpoint(rotate());
    let attempts = 0;
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === file) attempts++;
      await rename(...args);
    });

    assert.equal(
      (
        await refreshGrokBearer({
          home: dir,
          fetch: endpoint.fetch,
          scan: () => Promise.resolve(quietMachine())
        })
      )?.key,
      'fresh-'.repeat(4)
    );
    assert.equal(attempts, 1);
    const written = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(written['https://auth.x.ai::client'].key, 'fresh-'.repeat(4));
    assert.equal(written['https://auth.x.ai::client'].refresh_token, NEW_REFRESH);
    assert.equal(written['https://auth.x.ai::client'].something_a_later_cli_added, 42);
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['auth.json']);
    assert.equal(await exists(lockFor(OLD_REFRESH, dir)), false);
    assert.equal(endpoint.calls.length, 1);
  });

  it(
    'updates a credential symlink target while keeping the link',
    { skip: needsFileSymlinks() },
    async () => {
      const dir = await writeCredential('save-symlink', credentialFile(OLD_REFRESH, EXPIRED));
      const file = authPath(dir);
      const target = path.join(dir, 'credential.json');
      await fs.rename(file, target);
      await fs.symlink(target, file);
      const endpoint = tokenEndpoint(rotate());

      assert.ok(
        await refreshGrokBearer({
          home: dir,
          fetch: endpoint.fetch,
          scan: () => Promise.resolve(quietMachine())
        })
      );
      assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
      const written = JSON.parse(await fs.readFile(target, 'utf8'));
      assert.equal(written['https://auth.x.ai::client'].refresh_token, NEW_REFRESH);
      assert.deepEqual(await fs.readdir(dir), ['.grok', '.squadron', 'credential.json']);
      assert.equal(endpoint.calls.length, 1);
    }
  );

  it('sends the observed form body to the allowlisted endpoint', async () => {
    const dir = await writeCredential('refresh-body', credentialFile(OLD_REFRESH, EXPIRED));
    const endpoint = tokenEndpoint(
      ok({ access_token: 'fresh-'.repeat(4), expires_in: 21600, refresh_token: NEW_REFRESH })
    );
    const bearer = await refreshGrokBearer({
      home: dir,
      fetch: endpoint.fetch,
      scan: () => Promise.resolve(quietMachine())
    });

    assert.equal(bearer?.key, 'fresh-'.repeat(4));
    assert.equal(endpoint.calls.length, 1);
    assert.equal(endpoint.calls[0]?.url, 'https://auth.x.ai/oauth2/token');
    assert.equal(endpoint.calls[0]?.method, 'POST');
    // A form body without this header is refused by every OAuth endpoint, and
    // with the live probe deferred this assertion is the only thing checking it.
    assert.equal(endpoint.calls[0]?.headers['content-type'], 'application/x-www-form-urlencoded');
    const sent = new URLSearchParams(endpoint.calls[0]?.body ?? '');
    assert.equal(sent.get('grant_type'), 'refresh_token');
    assert.equal(sent.get('refresh_token'), OLD_REFRESH);
    assert.equal(sent.get('client_id'), 'client');
    assert.ok(endpoint.calls[0]?.signal instanceof AbortSignal);
  });

  it(
    'rotates the credential at 0600, keeping every field it did not set',
    { skip: modeBitsSkip },
    async () => {
      const dir = await writeCredential('refresh-write', credentialFile(OLD_REFRESH, EXPIRED));
      await refreshGrokBearer({
        home: dir,
        fetch: tokenEndpoint(
          ok({ access_token: 'fresh-'.repeat(4), expires_in: 21600, refresh_token: NEW_REFRESH })
        ).fetch,
        scan: () => Promise.resolve(quietMachine())
      });

      const written = JSON.parse(await fs.readFile(authPath(dir), 'utf8'));
      const entry = written['https://auth.x.ai::client'];
      assert.equal(entry.key, 'fresh-'.repeat(4));
      assert.equal(entry.refresh_token, NEW_REFRESH);
      assert.equal(entry.email, 'a@x.ai');
      assert.equal(entry.oidc_issuer, 'https://auth.x.ai');
      assert.equal(entry.something_a_later_cli_added, 42);
      // The CLI's own spelling: six fractional digits and an offset, not `Z`.
      assert.match(
        entry.expires_at as string,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/
      );
      assert.equal((await fs.stat(authPath(dir))).mode & 0o777, 0o600);
    }
  );

  it('falls back to the new bearer JWT exp when expires_in is absent', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const dir = await writeCredential('refresh-jwt', credentialFile(OLD_REFRESH, EXPIRED));
    const bearer = await refreshGrokBearer({
      home: dir,
      fetch: tokenEndpoint(ok({ access_token: jwtWithExp(exp) })).fetch,
      scan: () => Promise.resolve(quietMachine())
    });
    assert.equal(bearer?.expiresAt, exp * 1000);
  });

  it('sends nothing when the bearer has not expired yet', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString().replace('Z', '000+00:00');
    const dir = await writeCredential('refresh-fresh', credentialFile(OLD_REFRESH, future));
    const endpoint = tokenEndpoint(ok({}));
    const bearer = await refreshGrokBearer({
      home: dir,
      fetch: endpoint.fetch,
      scan: () => Promise.resolve(quietMachine())
    });
    assert.equal(endpoint.calls.length, 0);
    assert.equal(bearer?.key, 'bearer-'.repeat(4));
  });

  it('suppresses renewal while any Grok process is alive', async () => {
    const dir = await writeCredential('refresh-live', credentialFile(OLD_REFRESH, EXPIRED));
    const endpoint = tokenEndpoint(ok({}));
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: endpoint.fetch,
        scan: () => Promise.resolve(grokRunning())
      }),
      undefined
    );
    assert.equal(endpoint.calls.length, 0);
  });

  it('suppresses renewal when the process table cannot be trusted', async () => {
    const dir = await writeCredential('refresh-unknown', credentialFile(OLD_REFRESH, EXPIRED));
    const endpoint = tokenEndpoint(ok({}));
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: endpoint.fetch,
        scan: () => Promise.resolve(emptyTable())
      }),
      undefined
    );
    assert.equal(endpoint.calls.length, 0);
  });

  it('suppresses renewal when the table is incomplete, which may have dropped a Grok row', async () => {
    // A Windows row whose start will not convert is left out of the table,
    // which is then incomplete: the rows it kept say nothing of the one it lost.
    const dir = await writeCredential('refresh-partial', credentialFile(OLD_REFRESH, EXPIRED));
    const endpoint = tokenEndpoint(ok({}));
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: endpoint.fetch,
        scan: () => Promise.resolve({ ...quietMachine(), complete: false })
      }),
      undefined
    );
    assert.equal(endpoint.calls.length, 0);
  });

  it('lets only one of two concurrent callers spend the token', async () => {
    const dir = await writeCredential('refresh-race', credentialFile(OLD_REFRESH, EXPIRED));
    const endpoint = tokenEndpoint(
      ok({ access_token: 'fresh-'.repeat(4), expires_in: 21600, refresh_token: NEW_REFRESH })
    );
    const both = { home: dir, fetch: endpoint.fetch, scan: () => Promise.resolve(quietMachine()) };
    const pair = await Promise.all([refreshGrokBearer(both), refreshGrokBearer(both)]);
    assert.equal(endpoint.calls.length, 1);
    // One of them spent the token and got the bearer; the other got nothing or
    // the same bearer off disk — but neither may report a *stale* key.
    assert.ok(pair.some((bearer) => bearer?.key === 'fresh-'.repeat(4)));
    assert.ok(pair.every((bearer) => bearer === undefined || bearer.key === 'fresh-'.repeat(4)));
  });

  it('never replays a token whose response was lost', async () => {
    const dir = await writeCredential('refresh-lost', credentialFile(OLD_REFRESH, EXPIRED));
    const before = await fs.readFile(authPath(dir), 'utf8');
    const lost = tokenEndpoint(() => Promise.reject(new Error('socket hung up')));

    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: lost.fetch,
        scan: () => Promise.resolve(quietMachine())
      }),
      undefined
    );
    // The credential is untouched: the old token may already be spent, but it
    // is the only one the reader has.
    assert.equal(await fs.readFile(authPath(dir), 'utf8'), before);

    // A second poll must not send it again — the server may have rotated it.
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: lost.fetch,
        scan: () => Promise.resolve(quietMachine())
      }),
      undefined
    );
    assert.equal(lost.calls.length, 1);

    // A CLI run or a re-login supplies a different token, and that one is fair game.
    await fs.writeFile(authPath(dir), JSON.stringify(credentialFile(NEW_REFRESH, EXPIRED)));
    await refreshGrokBearer({
      home: dir,
      fetch: lost.fetch,
      scan: () => Promise.resolve(quietMachine())
    });
    assert.equal(lost.calls.length, 2);
  });

  it('writes nothing when the response carries no future expiry', async () => {
    const dir = await writeCredential('refresh-noexp', credentialFile(OLD_REFRESH, EXPIRED));
    const before = await fs.readFile(authPath(dir), 'utf8');
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: tokenEndpoint(ok({ access_token: 'opaque-'.repeat(4) })).fetch,
        scan: () => Promise.resolve(quietMachine())
      }),
      undefined
    );
    assert.equal(await fs.readFile(authPath(dir), 'utf8'), before);
  });

  it('discards a rotation the credential no longer matches', async () => {
    const dir = await writeCredential('refresh-changed', credentialFile(OLD_REFRESH, EXPIRED));
    const bearer = await refreshGrokBearer({
      home: dir,
      scan: () => Promise.resolve(quietMachine()),
      // The CLI wins the race while our request is in flight.
      fetch: tokenEndpoint(async () => {
        await fs.writeFile(authPath(dir), JSON.stringify(credentialFile('cli-won', EXPIRED)));
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ access_token: 'x', expires_in: 60 })
        };
      }).fetch
    });
    assert.equal(bearer, undefined);
    const now = JSON.parse(await fs.readFile(authPath(dir), 'utf8'));
    assert.equal(now['https://auth.x.ai::client'].refresh_token, 'cli-won');
  });

  it('leaves the credential alone when the endpoint refuses', async () => {
    const dir = await writeCredential('refresh-401', credentialFile(OLD_REFRESH, EXPIRED));
    const before = await fs.readFile(authPath(dir), 'utf8');
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: tokenEndpoint(() =>
          Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: 'invalid_grant' })
          })
        ).fetch,
        scan: () => Promise.resolve(quietMachine())
      }),
      undefined
    );
    assert.equal(await fs.readFile(authPath(dir), 'utf8'), before);
  });
});

/** The marker's name is the whole guard, so a test has to be able to spell it. */
const lockFor = (token: string, dir: string): string =>
  grokRefreshLock(createHash('sha256').update(token).digest('hex').slice(0, 16), dir);

const exists = async (file: string): Promise<boolean> =>
  await fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

/** What `fetch` rejects with: a bare `TypeError` carrying the real error, or an
 *  `AggregateError` of them, on `cause`. */
const transportFailure = (cause: unknown): TypeError =>
  Object.assign(new TypeError('fetch failed'), { cause });

const rotate = (): ReturnType<typeof ok> =>
  ok({ access_token: 'fresh-'.repeat(4), expires_in: 21600, refresh_token: NEW_REFRESH });

describe('refreshGrokBearer guard file', () => {
  it('aborts before sending when the token changed during the process scan', async () => {
    const dir = await writeCredential('guard-moved', credentialFile(OLD_REFRESH, EXPIRED));
    const endpoint = tokenEndpoint(rotate());
    // The scan is the one unbounded await before the claim — `/bin/ps` takes
    // 50-300ms, which is room enough for the CLI to rotate underneath us.
    const bearer = await refreshGrokBearer({
      home: dir,
      fetch: endpoint.fetch,
      scan: async () => {
        await fs.writeFile(authPath(dir), JSON.stringify(credentialFile('cli-rotated', EXPIRED)));
        return quietMachine();
      }
    });
    assert.equal(bearer, undefined);
    // Not one request: the token we were about to spend is no longer on disk,
    // so somebody else has already spent it.
    assert.equal(endpoint.calls.length, 0);
    assert.equal(await exists(lockFor(OLD_REFRESH, dir)), false);
  });

  it('keeps the marker after a lost response and drops it after a clean write', async () => {
    const dir = await writeCredential('guard-life', credentialFile(OLD_REFRESH, EXPIRED));
    await refreshGrokBearer({
      home: dir,
      fetch: tokenEndpoint(() => Promise.reject(new Error('socket hung up'))).fetch,
      scan: () => Promise.resolve(quietMachine())
    });
    assert.equal(await exists(lockFor(OLD_REFRESH, dir)), true);

    // A CLI run supplies a token that was never sent, and that one may be.
    await fs.writeFile(authPath(dir), JSON.stringify(credentialFile(NEW_REFRESH, EXPIRED)));
    await refreshGrokBearer({
      home: dir,
      fetch: tokenEndpoint(
        ok({ access_token: 'k', expires_in: 600, refresh_token: 'third-'.repeat(4) })
      ).fetch,
      scan: () => Promise.resolve(quietMachine())
    });
    // Spent and rotated away, so its marker has no one left to protect.
    assert.equal(await exists(lockFor(NEW_REFRESH, dir)), false);
    assert.equal(await exists(lockFor('third-'.repeat(4), dir)), false);
  });

  it('sweeps an abandoned marker but never one for the token now on disk', async () => {
    const dir = await writeCredential('guard-sweep', credentialFile(OLD_REFRESH, EXPIRED));
    const abandoned = grokRefreshLock('0123456789abcdef', dir);
    // A peer that is mid-flight, or that lost a response, against the token
    // this refresh is about to write. Deleting this one is what would let a
    // spent token be replayed.
    const peers = lockFor(NEW_REFRESH, dir);
    await fs.mkdir(path.join(dir, '.squadron', 'windows'), { recursive: true });
    await fs.writeFile(abandoned, '{}');
    await fs.writeFile(peers, '{}');
    // Neighbours the sweep must not touch, in the directory it reads.
    await fs.writeFile(path.join(dir, '.squadron', 'usage.grok.json'), '{}');
    await fs.writeFile(path.join(dir, '.squadron', 'workflow-order.json'), '{}');
    await fs.writeFile(path.join(dir, '.squadron', 'windows', 'w.json'), '{}');

    await refreshGrokBearer({
      home: dir,
      fetch: tokenEndpoint(rotate()).fetch,
      scan: () => Promise.resolve(quietMachine())
    });

    assert.equal(await exists(abandoned), false);
    assert.equal(await exists(peers), true);
    // The sweep runs over `~/.squadron` itself, where the usage store lives.
    // Only its name pattern keeps `fs.rm` off these.
    assert.equal(await exists(path.join(dir, '.squadron', 'usage.grok.json')), true);
    assert.equal(await exists(path.join(dir, '.squadron', 'workflow-order.json')), true);
    assert.equal(await exists(path.join(dir, '.squadron', 'windows', 'w.json')), true);
  });

  it('does not send a token a peer finished spending while it was starting', async () => {
    const dir = await writeCredential('guard-peer', credentialFile(OLD_REFRESH, EXPIRED));
    const endpoint = tokenEndpoint(rotate());
    const first = refreshGrokBearer({
      home: dir,
      fetch: endpoint.fetch,
      scan: () => Promise.resolve(quietMachine())
    });
    // The second window read the credential before the first wrote, and reaches
    // its claim only after the first has finished and taken its marker away.
    const second = refreshGrokBearer({
      home: dir,
      fetch: endpoint.fetch,
      scan: async () => {
        await first;
        return quietMachine();
      }
    });
    // One POST, and the second window paints the bearer the first one wrote
    // rather than nothing — the renewal it was about to attempt has happened.
    const renewed = { key: 'fresh-'.repeat(4), expiresAt: (await first)?.expiresAt };
    assert.deepEqual(await Promise.all([first, second]), [renewed, renewed]);
    assert.equal(endpoint.calls.length, 1);
  });

  it('refuses when the entry states no client id', async () => {
    const dir = await writeCredential('guard-noclient', {
      'https://auth.x.ai::client': {
        key: 'k'.repeat(24),
        refresh_token: OLD_REFRESH,
        expires_at: EXPIRED
      }
    });
    const endpoint = tokenEndpoint(rotate());
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        fetch: endpoint.fetch,
        scan: () => Promise.resolve(quietMachine())
      }),
      undefined
    );
    assert.equal(endpoint.calls.length, 0);
  });

  it('drains a refused body and keeps the marker', async () => {
    const dir = await writeCredential('guard-400', credentialFile(OLD_REFRESH, EXPIRED));
    let drained = 0;
    await refreshGrokBearer({
      home: dir,
      scan: () => Promise.resolve(quietMachine()),
      fetch: () =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => {
            drained += 1;
            return Promise.resolve({ error: 'invalid_grant' });
          }
        })
    });
    // An unread body holds the connection open until GC, and a persistent
    // `invalid_grant` takes this branch on every poll.
    assert.equal(drained, 1);
    // A 400 is still post-send: the server saw the token, so it is never resent.
    assert.equal(await exists(lockFor(OLD_REFRESH, dir)), true);
  });

  it('releases the marker when the request never left the machine', async () => {
    const dir = await writeCredential('guard-offline', credentialFile(OLD_REFRESH, EXPIRED));
    const before = await fs.readFile(authPath(dir), 'utf8');
    assert.equal(
      await refreshGrokBearer({
        home: dir,
        scan: () => Promise.resolve(quietMachine()),
        fetch: () => Promise.reject(transportFailure({ code: 'ENOTFOUND' }))
      }),
      undefined
    );
    assert.equal(await fs.readFile(authPath(dir), 'utf8'), before);
    // Name resolution failed, so xAI never saw the token. Nothing sweeps a
    // marker but a later successful write-back, so keeping this one would
    // freeze the chip permanently on one offline poll.
    assert.equal(await exists(lockFor(OLD_REFRESH, dir)), false);

    const endpoint = tokenEndpoint(rotate());
    const bearer = await refreshGrokBearer({
      home: dir,
      fetch: endpoint.fetch,
      scan: () => Promise.resolve(quietMachine())
    });
    assert.equal(bearer?.key, 'fresh-'.repeat(4));
    assert.equal(endpoint.calls.length, 1);
  });

  it('keeps the marker when one connect leg got further than a refusal', async () => {
    const dir = await writeCredential('guard-halfway', credentialFile(OLD_REFRESH, EXPIRED));
    await refreshGrokBearer({
      home: dir,
      scan: () => Promise.resolve(quietMachine()),
      // undici tries A and AAAA and reports both. A socket that was reset had a
      // connection, so this is the ambiguous case however the other leg failed.
      fetch: () =>
        Promise.reject(
          transportFailure(
            new AggregateError([
              Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
              Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
            ])
          )
        )
    });
    assert.equal(await exists(lockFor(OLD_REFRESH, dir)), true);
  });

  it('gives up on the budget without writing or clearing the marker', async () => {
    const dir = await writeCredential('guard-abort', credentialFile(OLD_REFRESH, EXPIRED));
    const before = await fs.readFile(authPath(dir), 'utf8');
    const bearer = await refreshGrokBearer({
      home: dir,
      budgetMs: 5,
      scan: () => Promise.resolve(quietMachine()),
      // Never answers. Only the signal ends this.
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    });
    assert.equal(bearer, undefined);
    assert.equal(await fs.readFile(authPath(dir), 'utf8'), before);
    // The request left the machine, so this is the ambiguous case: the marker
    // stays, and that token is never sent again.
    assert.equal(await exists(lockFor(OLD_REFRESH, dir)), true);
  });
});

describe('grokAuthStamp', () => {
  it('moves when auth.json is rewritten or removed', async () => {
    await fs.rm(authFile(), { force: true });
    const absent = await grokAuthStamp(home);
    await writeAuth('{"a":1}');
    const first = await grokAuthStamp(home);
    assert.equal(await grokAuthStamp(home), first);
    await writeAuth('{"a":1,"b":2}');
    const renewed = await grokAuthStamp(home);
    await fs.rm(authFile());
    assert.equal(new Set([absent, first, renewed]).size, 3);
    assert.equal(await grokAuthStamp(home), absent);
  });
});

describe('startGrokLogin cancellation', () => {
  it('ends only its root and leaves a held descendant unsignalled', async (t) => {
    const fixture = await nodeCli(t, heldDescendant() + 'hold();');
    // Owned before the spawn: a failure from here on still ends both.
    const held = ownHeld(t, () => fs.readFile(fixture.seen, 'utf8').catch(() => undefined));
    const table = await watchTable(t);
    const session = await startGrokLogin(() => {}, fixture.bin);
    assert.ok(!('ok' in session), 'fixture refused to start');
    const { root, descendant } = await held.pids();
    await fixture.ready();
    session.cancel();
    await until(() => !alive(root));
    // Root only, by the owner's own ask: nothing read the table, nothing was
    // signalled through it, and the held descendant (a browser, say) lives on,
    // unresolved rather than ended.
    assert.equal(table.reads(), 0);
    assert.equal(table.signals(), 0);
    assert.equal(alive(descendant), true);
  });
});
