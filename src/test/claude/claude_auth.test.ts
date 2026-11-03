import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  claudeAuthStamp,
  claudePlanLabel,
  loginUrlFrom,
  loginWantsPaste,
  parseClaudeAuthStatus,
  claudePlanOfConfig,
  parseClaudePlanName,
  parseClaudeRateLimitTier,
  startClaudeLogin
} from '../../core/claude/auth';
import { alive, heldDescendant, ownHeld, until, watchTable } from '../fixtures/root_only';
import { nodeCli } from '../fixtures/node_cli';

describe('parseClaudeAuthStatus', () => {
  it('reads the signed-out shape observed 2026-08-09', () => {
    const status = parseClaudeAuthStatus(`{
      "loggedIn": false,
      "authMethod": "none",
      "apiProvider": "firstParty"
    }`);
    assert.deepEqual(status, {
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'firstParty'
    });
  });

  it('reads the signed-in shape observed 2026-09-01', () => {
    const status = parseClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'reader@example.com',
        orgId: '00000000-0000-4000-8000-000000000001',
        orgName: "reader@example.com's Organization",
        subscriptionType: 'max'
      })
    );
    assert.deepEqual(status, {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'reader@example.com',
      subscriptionType: 'max'
    });
  });

  it('leaves the chip to claudePlanLabel rather than printing the CLI word', () => {
    const status = parseClaudeAuthStatus('{"loggedIn":true,"subscriptionType":"max"}');
    assert.equal(status?.subscriptionType, 'max');
    assert.equal(status?.plan, undefined);
  });

  it('takes no identity from keys the CLI has never sent', () => {
    const status = parseClaudeAuthStatus(
      JSON.stringify({ loggedIn: true, account: 'a@b.c', userEmail: 'c@d.e', subscription: 'Max' })
    );
    assert.deepEqual(status, { loggedIn: true });
  });

  it('degrades to Signed in without inventing an email', () => {
    const status = parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claudeai"}');
    assert.equal(status?.loggedIn, true);
    assert.equal(status?.email, undefined);
  });

  it('refuses a body that is not status JSON', () => {
    assert.equal(parseClaudeAuthStatus(''), undefined);
    assert.equal(parseClaudeAuthStatus('not json'), undefined);
    assert.equal(parseClaudeAuthStatus('{"loggedIn":"yes"}'), undefined);
  });
});

describe('claudePlanLabel', () => {
  it('names the two Max tiers as the plans Anthropic sells', () => {
    assert.equal(claudePlanLabel('max', 'default_claude_max_20x'), 'Ultra');
    assert.equal(claudePlanLabel('max', 'default_claude_max_5x'), 'Max');
  });

  it('draws no chip for a Max tier it cannot name', () => {
    // `Max` is one plan now, so printing it here would call an Ultra account Max.
    assert.equal(claudePlanLabel('max', 'default_claude_max_50x'), undefined);
    assert.equal(claudePlanLabel('max', 'default_claude_zero'), undefined);
    assert.equal(claudePlanLabel('max'), undefined);
  });

  it('takes a stated name on a tier the table cannot name', () => {
    assert.equal(claudePlanLabel('max', 'default_claude_max_50x', 'Ultra Plus'), 'Ultra Plus');
  });

  it('prefers the name the account states over the tier table', () => {
    assert.equal(claudePlanLabel('max', 'default_claude_max_20x', 'Max Plus'), 'Max Plus');
    assert.equal(claudePlanLabel('team', undefined, 'Team Premium'), 'Team Premium');
  });

  it('lets a stated name draw no chip for a word outside the four', () => {
    assert.equal(claudePlanLabel('free', undefined, 'Free'), undefined);
    assert.equal(claudePlanLabel(undefined, undefined, 'Ultra'), undefined);
  });

  it('ignores the tier for a plan that has none', () => {
    assert.equal(claudePlanLabel('pro', 'default_claude_max_20x'), 'Pro');
    assert.equal(claudePlanLabel('team'), 'Team');
    assert.equal(claudePlanLabel('enterprise'), 'Enterprise');
  });

  it("draws no chip for a word the CLI's own switch does not name", () => {
    // `Claude API` is that switch's default and is not a subscription, so a
    // word outside the four states no plan rather than a title-cased guess.
    assert.equal(claudePlanLabel('max_ultra'), undefined);
    assert.equal(claudePlanLabel('free'), undefined);
    assert.equal(claudePlanLabel(undefined), undefined);
    assert.equal(claudePlanLabel(' '), undefined);
  });
});

describe('parseClaudeRateLimitTier', () => {
  it('reads the tier off the config the CLI mirrors it into', () => {
    assert.equal(
      parseClaudeRateLimitTier(
        JSON.stringify({
          numStartups: 1157,
          oauthAccount: {
            emailAddress: 'reader@example.com',
            organizationType: 'claude_max',
            organizationRateLimitTier: 'default_claude_max_20x',
            userRateLimitTier: null
          }
        })
      ),
      'default_claude_max_20x'
    );
  });

  it('reads the one key observed to carry it, and no other', () => {
    // The CLI reads neither of these — it takes the Keychain copy, which the org
    // key matched. A seat tier has never been seen populated, so preferring one
    // over the other would be an invented precedence rather than an observed one.
    assert.equal(
      parseClaudeRateLimitTier('{"oauthAccount":{"userRateLimitTier":"default_claude_max_5x"}}'),
      undefined
    );
  });

  it('states no tier rather than throwing on a config it cannot use', () => {
    assert.equal(parseClaudeRateLimitTier(''), undefined);
    assert.equal(parseClaudeRateLimitTier('not json'), undefined);
    assert.equal(parseClaudeRateLimitTier('{"numStartups":1}'), undefined);
    assert.equal(parseClaudeRateLimitTier('{"oauthAccount":null}'), undefined);
    assert.equal(
      parseClaudeRateLimitTier('{"oauthAccount":{"organizationRateLimitTier":null}}'),
      undefined
    );
  });
});

describe('claudePlanOfConfig', () => {
  const config = (account: Record<string, unknown>): string =>
    JSON.stringify({ oauthAccount: account });
  const tier = { organizationRateLimitTier: 'default_claude_max_20x' };

  it('joins the tier and the stated name off one config', () => {
    assert.equal(
      claudePlanOfConfig('max', config({ ...tier, planDisplayName: 'Max Plus' })),
      'Max Plus'
    );
    assert.equal(claudePlanOfConfig('max', config(tier)), 'Ultra');
  });

  it('draws no Max chip off a config it could not read', () => {
    assert.equal(claudePlanOfConfig('max', ''), undefined);
    assert.equal(claudePlanOfConfig('max', '{"oauthAccount": {"organiza'), undefined);
  });

  it('keeps a plan the subscription word already names', () => {
    assert.equal(claudePlanOfConfig('pro', ''), 'Pro');
  });
});

describe('parseClaudePlanName', () => {
  const named = (planDisplayName: unknown): string =>
    JSON.stringify({ oauthAccount: { planDisplayName } });

  it('reads the name the CLI stores from the account profile', () => {
    assert.equal(parseClaudePlanName(named('Ultra')), 'Ultra');
    assert.equal(parseClaudePlanName(named('Max 5x+')), 'Max 5x+');
  });

  it('treats what the CLI would refuse as unstated', () => {
    assert.equal(parseClaudePlanName(named('<b>Ultra</b>')), undefined);
    assert.equal(parseClaudePlanName(named(' Ultra')), undefined);
    assert.equal(parseClaudePlanName(named('x'.repeat(41))), undefined);
    assert.equal(parseClaudePlanName(named('')), undefined);
    assert.equal(parseClaudePlanName(named(null)), undefined);
    assert.equal(parseClaudePlanName(named(7)), undefined);
    assert.equal(parseClaudePlanName('not json'), undefined);
  });
});

describe('login stdout helpers', () => {
  it('pulls the authorize URL from the CLI line', () => {
    const line =
      "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code";
    const url = loginUrlFrom(line);
    assert.ok(url?.startsWith('https://claude.com/cai/oauth/authorize'));
  });

  it('takes an authorize URL whose host is not the one we pinned', () => {
    // The fixture prints claude.com, so a pinned host passes every test and
    // still paints a sheet with no link the day the CLI moves.
    assert.equal(
      loginUrlFrom(
        'If the browser did not open, visit: https://auth.anthropic.com/oauth/authorize?x=1'
      ),
      'https://auth.anthropic.com/oauth/authorize?x=1'
    );
    assert.equal(
      loginUrlFrom('  https://login.example.test/v2/oauth/authorize?code=true  '),
      'https://login.example.test/v2/oauth/authorize?code=true'
    );
  });

  it('prefers claude.com when a chunk offers more than one authorize link', () => {
    const both =
      'https://mirror.example.test/oauth/authorize?a=1\nhttps://claude.com/cai/oauth/authorize?b=2';
    assert.equal(loginUrlFrom(both), 'https://claude.com/cai/oauth/authorize?b=2');
  });

  it('drops the styling a link is printed in', () => {
    // A URL token stops at whitespace and an escape is not whitespace, so a
    // styled link used to carry its own reset into `openExternal`.
    const esc = String.fromCharCode(27);
    assert.equal(
      loginUrlFrom(`visit: ${esc}[4mhttps://claude.com/cai/oauth/authorize?code=true${esc}[0m`),
      'https://claude.com/cai/oauth/authorize?code=true'
    );
  });

  it('says nothing when a chunk carries no authorize link', () => {
    assert.equal(loginUrlFrom('Opening browser…'), undefined);
    assert.equal(loginUrlFrom('see https://docs.example.test/help for help'), undefined);
  });

  it('notices the paste prompt', () => {
    assert.equal(loginWantsPaste('Paste code here if prompted > '), true);
    assert.equal(loginWantsPaste('Opening browser to sign in…'), false);
  });
});

describe('startClaudeLogin child env', () => {
  it('sets BROWSER=true over whatever the reader exported', async (t) => {
    // The other half of that invariant. A reader's own $BROWSER must not win:
    // it would re-open the loopback door the sheet knows nothing about.
    const fixture = await nodeCli(
      t,
      "fs.writeFileSync(seen, process.env.BROWSER ?? '<unset>'); hold();"
    );
    const { bin, seen } = fixture;
    const before = process.env.BROWSER;
    process.env.BROWSER = 'sentinel-browser';
    try {
      const session = await startClaudeLogin(() => {}, bin);
      assert.ok(!('ok' in session), 'fixture refused to start');
      const start = Date.now();
      while (Date.now() - start < 2000) {
        try {
          assert.equal(await fs.readFile(seen, 'utf8'), 'true');
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(await fs.readFile(seen, 'utf8'), 'true');
      session.cancel();
    } finally {
      if (before === undefined) delete process.env.BROWSER;
      else process.env.BROWSER = before;
    }
  });
});

describe('startClaudeLogin split URL', () => {
  it('emits one whole URL when a chunk boundary lands inside it', async (t) => {
    // A pipe splits where it likes. Emitting the half read before the rest
    // arrived put two `url` events on the stream, and the host — which opens
    // for this brand now — opened a truncated authorize URL before the real
    // one.
    const fixture = await nodeCli(
      t,
      `
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id");
hold(() => process.stdout.write("=fake-split\\nPaste code here if prompted > "));
`
    );
    const { bin } = fixture;
    const urls: string[] = [];
    const phases: string[] = [];
    const session = await startClaudeLogin((event) => {
      if (event.type === 'url') urls.push(event.url);
      if (event.type === 'phase') phases.push(event.phase);
    }, bin);
    assert.ok(!('ok' in session), 'fixture refused to start');
    await fixture.ready();
    await fixture.output();
    assert.deepEqual(urls, []);
    await fixture.release();
    const start = Date.now();
    while (!phases.includes('paste') && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(urls, [
      'https://claude.com/cai/oauth/authorize?code=true&client_id=fake-split'
    ]);
    // The unterminated prompt is the whole reason the tail is read early.
    assert.ok(phases.includes('paste'), 'the paste prompt never landed');
    session.cancel();
  });
});

describe('claudeAuthStamp', () => {
  const account = {
    accountUuid: 'acct-1',
    emailAddress: 'a@example.com',
    organizationUuid: 'org-1',
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_20x',
    profileFetchedAt: 1
  };

  async function config(body: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stamp-'));
    const file = path.join(dir, '.claude.json');
    await fs.writeFile(file, JSON.stringify(body));
    return file;
  }

  /** A rewrite the stat can see, whatever the filesystem's clock resolution. */
  async function rewrite(file: string, body: unknown): Promise<void> {
    await fs.writeFile(file, JSON.stringify(body));
    const later = new Date(Date.now() + 5000);
    await fs.utimes(file, later, later);
  }

  it('ignores a profile refetch and a session rewriting the rest of the file', async () => {
    const file = await config({ oauthAccount: account, numStartups: 1 });
    const first = await claudeAuthStamp(file);
    await rewrite(file, { oauthAccount: { ...account, profileFetchedAt: 2 }, numStartups: 2 });
    assert.equal(await claudeAuthStamp(file), first);
  });

  it('moves on a different account, tier, plan name or org, and on a sign-out', async () => {
    const file = await config({ oauthAccount: account });
    const seen = new Set([await claudeAuthStamp(file)]);
    for (const next of [
      { ...account, emailAddress: 'b@example.com' },
      { ...account, organizationRateLimitTier: 'default_claude_max_5x' },
      { ...account, planDisplayName: 'Ultra' },
      { ...account, organizationUuid: 'org-2' }
    ]) {
      await rewrite(file, { oauthAccount: next });
      seen.add(await claudeAuthStamp(file));
    }
    // What the CLI's sign-out leaves: the config, with no account in it.
    await rewrite(file, { numStartups: 3 });
    seen.add(await claudeAuthStamp(file));
    assert.equal(seen.size, 6);
  });

  it('tells a missing file from a file with no account', async () => {
    const file = await config({});
    const empty = await claudeAuthStamp(file);
    await fs.rm(file);
    assert.notEqual(await claudeAuthStamp(file), empty);
  });

  it('cannot tell a stamp from a half-done write it has nothing to keep for', async () => {
    const file = await config({});
    await fs.writeFile(file, '{"oauthAccount": {"accountUu');
    assert.equal(await claudeAuthStamp(file), undefined);
  });

  it('keeps the last good stamp over a write caught half-done', async () => {
    const file = await config({ oauthAccount: account });
    const good = await claudeAuthStamp(file);
    await fs.writeFile(file, '{"oauthAccount": {"accountUu');
    const later = new Date(Date.now() + 5000);
    await fs.utimes(file, later, later);
    assert.equal(await claudeAuthStamp(file), good);
  });
});

describe('startClaudeLogin cancellation', () => {
  it('ends only its root and leaves a held descendant unsignalled', async (t) => {
    const fixture = await nodeCli(t, heldDescendant() + 'hold();');
    // Owned before the spawn: a failure from here on still ends both.
    const held = ownHeld(t, () => fs.readFile(fixture.seen, 'utf8').catch(() => undefined));
    const table = await watchTable(t);
    const session = await startClaudeLogin(() => {}, fixture.bin);
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
  it('ends a held descendant when setup fails after creating it', async (t) => {
    // The root records both pids, then exits before it is ever ready.
    const fixture = await nodeCli(t, heldDescendant() + 'process.exit(3);');
    const held = ownHeld(t, () => fs.readFile(fixture.seen, 'utf8').catch(() => undefined));
    const session = await startClaudeLogin(() => {}, fixture.bin);
    assert.ok(!('ok' in session), 'fixture refused to start');
    const { root, descendant } = await held.pids();
    await assert.rejects(fixture.ready(), /did not become ready/);
    assert.equal(alive(descendant), true);
    await held.dispose();
    assert.equal(alive(descendant), false);
    assert.equal(alive(root), false);
  });
});
