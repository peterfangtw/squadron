import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountRow,
  accountRows,
  accountSessionCounts,
  completeAccountPoll,
  foldAccountStatuses
} from '../../core/accounts';
import { adapter } from '../../core/adapter';

const grokSoon = {
  brand: 'grok' as const,
  name: 'Grok',
  mark: 'grok',
  state: 'coming_soon' as const,
  detail: 'Coming soon'
};

describe('account poll completion', () => {
  it('keeps the newer result when an older probe finishes last', () => {
    const state = {
      authGen: 2,
      authTried: {},
      accounts: {},
      installed: {}
    };
    assert.equal(
      completeAccountPoll(state, 2, { claude: { loggedIn: false } }, { claude: false }),
      true
    );
    assert.equal(
      completeAccountPoll(state, 1, { claude: { loggedIn: true } }, { claude: true }),
      false
    );
    assert.deepEqual(state, {
      authGen: 2,
      authTried: { claude: true },
      accounts: { claude: { loggedIn: false } },
      installed: { claude: false }
    });
  });
});

describe('loginOpensBrowser', () => {
  it('is false for both CLIs that open no tab', () => {
    // Half of Claude's two-value invariant — the other half is the
    // `BROWSER=true` asserted below, and either alone is a reader with no tab
    // or two. Nothing structural binds them, so this pair is the binding.
    assert.equal(adapter('codex')?.loginOpensBrowser, false);
    assert.equal(adapter('claude')?.loginOpensBrowser, false);
  });

  it('leaves the one that opens its own to do it', () => {
    // Not a device-code question: Grok states a `userCode` exactly as Codex
    // does, and still opens the tab itself through LaunchServices. Keying the
    // host's open on the code rather than the brand doubled Grok's window.
    const cli = adapter('grok');
    // Asserted, not optional-chained: absent means yes, so a registry that
    // stopped answering for a brand would read as a pass.
    assert.ok(cli, 'grok has an adapter');
    assert.notEqual(cli.loginOpensBrowser, false);
  });
});

describe('accountRows', () => {
  it('preserves the complete live row order supplied by the host', () => {
    const claude = accountRow({ loggedIn: false }, { brand: 'claude', sessionCount: 0 });
    const rows = accountRows([claude, grokSoon]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.brand, 'claude');
    assert.equal(rows[0]?.name, 'Claude');
    assert.equal(rows[0]?.mark, 'claude');
    assert.equal(rows[0]?.state, 'signed_out');
    assert.equal(rows[1]?.state, 'coming_soon');
    assert.equal(rows[1]?.name, 'Grok');
    assert.equal(rows[1]?.mark, 'grok');
    assert.equal(rows[1]?.detail, 'Coming soon');
  });

  it('nests usage under a signed-in Claude row and names sessions', () => {
    const usage = {
      windows: [
        { id: 'session', short: '5h', pct: 12 },
        { id: 'weekly', short: 'wk', pct: 78 }
      ]
    };
    const claude = accountRow(
      { loggedIn: true, email: 'a@b.c' },
      { brand: 'claude', sessionCount: 4, usage, plan: 'Max' }
    );
    const rows = accountRows([claude, grokSoon]);
    assert.equal(claude.state, 'signed_in');
    assert.equal(claude.label, 'a@b.c');
    assert.equal(claude.plan, 'Max');
    assert.equal(claude.detail, 'Claude · 4 sessions');
    assert.deepEqual(claude.usage, usage);
    assert.equal(rows[0], claude);
  });

  it('carries the reading date the host puts on the wire', () => {
    const usage = {
      windows: [
        { id: 'session', short: '5h', pct: 3 },
        { id: 'weekly', short: 'wk', pct: 9 }
      ],
      at: 1_700_000_000_000
    };
    const claude = accountRow({ loggedIn: true }, { brand: 'claude', sessionCount: 1, usage });
    assert.equal(claude.usage?.at, 1_700_000_000_000);
  });

  it('counts a card on its brand, and a card with no brand on Claude', () => {
    const mixed = accountSessionCounts([
      { brand: 'claude' },
      { brand: 'grok' },
      { brand: 'claude' },
      { brand: 'codex' },
      {}
    ]);
    assert.equal(mixed.claude, 3);
    assert.equal(mixed.grok, 1);
    assert.equal(mixed.codex, 1);
    assert.equal(
      accountSessionCounts([{ brand: 'grok' }, { brand: 'claude' }, { brand: 'grok' }, {}]).grok,
      2
    );
    assert.equal(accountSessionCounts([{ brand: 'grok' }]).claude, 0);
    assert.equal(accountSessionCounts([{ brand: 'claude' }]).grok, 0);
  });

  it('says Signed in when logged in without an email', () => {
    const claude = accountRow({ loggedIn: true }, { brand: 'claude', sessionCount: 0 });
    assert.equal(claude.label, 'Signed in');
    assert.equal(claude.detail, 'Claude');
    // A row carries the reading it is handed and invents none. Which windows a
    // brand has is its port's to declare (`core/adapter.ts`), and
    // `refreshUsage` is the one place that turns them into a row — two
    // declarations of one fact is two that can disagree.
    assert.equal(claude.usage, undefined);
  });

  it('says Not installed over a signed-in status when no binary resolves', () => {
    const grok = accountRow(
      { loggedIn: true, email: 'g@x.ai' },
      { brand: 'grok', sessionCount: 0, installed: false }
    );
    assert.equal(grok.state, 'not_installed');
    assert.equal(grok.label, 'Not installed');
    assert.equal(grok.detail, 'Grok');
    assert.equal(grok.usage, undefined);
  });

  it('names where Install goes on a not-installed row', () => {
    const grok = accountRow(
      { loggedIn: false },
      { brand: 'grok', sessionCount: 0, installed: false, installHost: 'docs.x.ai' }
    );
    assert.equal(grok.detail, 'Grok · installs from docs.x.ai');
  });

  it('keeps a canned Grok signed-in row as given', () => {
    const grok = {
      brand: 'grok' as const,
      name: 'Grok',
      mark: 'grok',
      state: 'signed_in' as const,
      label: 'g@x.ai',
      detail: 'Grok · 2 sessions'
    };
    const rows = accountRows([
      accountRow({ loggedIn: false }, { brand: 'claude', sessionCount: 0 }),
      grok
    ]);
    assert.equal(rows[1]?.state, 'signed_in');
    assert.equal(rows[1]?.label, 'g@x.ai');
    assert.equal(rows[1]?.detail, 'Grok · 2 sessions');
  });
});

describe('foldAccountStatuses', () => {
  const prev = { claude: { loggedIn: true, email: 'a@b.c', plan: 'Max' } };

  it('keeps the previous entry when the answer is undefined', () => {
    assert.deepEqual(foldAccountStatuses(prev, { claude: undefined }).claude, prev.claude);
  });

  it('replaces a brand that answered', () => {
    assert.deepEqual(foldAccountStatuses(prev, { claude: { loggedIn: false } }).claude, {
      loggedIn: false
    });
  });

  it('leaves a brand never asked absent, which is not signed out', () => {
    const next = foldAccountStatuses(prev, { claude: { loggedIn: true } });
    assert.equal(next.grok, undefined);
    assert.equal(foldAccountStatuses({}, {}).claude, undefined);
  });

  it('keeps a stored brand this poll did not mention', () => {
    assert.deepEqual(foldAccountStatuses(prev, {}).claude, prev.claude);
  });
});

import { settledPrefix } from '../../core/accounts';

describe('settledPrefix', () => {
  it('holds back the token still being written', () => {
    assert.equal(settledPrefix('visit: https://claude.com/cai/oauth/auth'), 'visit: ');
    assert.equal(settledPrefix('https://claude.com/no-space-before-it'), '');
  });

  it('settles a token the moment anything follows it', () => {
    assert.equal(settledPrefix('visit: https://claude.com/x '), 'visit: https://claude.com/x ');
    assert.equal(
      settledPrefix('visit: https://claude.com/x\nnext'),
      'visit: https://claude.com/x\n'
    );
  });

  it('leaves the paste prompt readable, which is why the tail is read at all', () => {
    // The prompt never ends its line; its trailing space is the boundary.
    assert.equal(settledPrefix('Paste code here if prompted > '), 'Paste code here if prompted > ');
  });
});

describe('account port', () => {
  it('is stated by every brand', () => {
    for (const brand of ['claude', 'grok', 'codex'] as const) {
      assert.ok(adapter(brand)?.account, `${brand} has no account port`);
    }
  });
});
