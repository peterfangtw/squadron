import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { tempHome } from '../helpers';
import type { AccountSource } from '../../core/adapter';
import type { AccountRowStatus } from '../../core/accounts';

let signin: typeof import('../../core/signin');
let home: string;

before(async () => {
  home = await tempHome();
  signin = await import('../../core/signin');
});

beforeEach(async () => {
  signin.resetSignInForTest();
  await fs.rm(path.join(home, '.squadron'), { recursive: true, force: true });
});

const IN: AccountRowStatus = { loggedIn: true, email: 'a@example.com', plan: 'Ultra' };
const OUT: AccountRowStatus = { loggedIn: false };

/** A port whose stamp and answer the test sets, counting every ask. */
function port(stamp: string | undefined, answer: AccountRowStatus | undefined) {
  const source = {
    stamp: stamp,
    answer: answer,
    asks: 0,
    gate: undefined as Promise<void> | undefined,
    port: undefined as unknown as AccountSource
  };
  source.port = {
    stamp: () => Promise.resolve(source.stamp),
    status: async () => {
      // Captured when asked, so a test can change the next answer while this
      // one is held at the gate.
      const answer = source.answer;
      source.asks += 1;
      if (source.gate) await source.gate;
      return answer;
    }
  };
  return source;
}

async function asked(cli: { asks: number }, n: number): Promise<void> {
  while (cli.asks < n) await new Promise((resolve) => setImmediate(resolve));
}

function opened(): { gate: Promise<void>; open: () => void } {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

describe('signInFor', () => {
  it('asks once on a missing record and reuses it while the stamp holds', async () => {
    const cli = port('s1', IN);
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 1, home }), IN);
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 2, home }), IN);
    assert.equal(cli.asks, 1);
  });

  it('asks again when the stamp moves, and stores the new answer', async () => {
    const cli = port('s1', IN);
    await signin.signInFor('claude', cli.port, { now: 1, home });
    cli.stamp = 's2';
    cli.answer = OUT;
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 2, home }), OUT);
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 3, home }), OUT);
    assert.equal(cli.asks, 2);
  });

  it('reuses a stored sign-out without asking', async () => {
    const cli = port('s1', OUT);
    await signin.signInFor('codex', cli.port, { now: 1, home });
    signin.resetSignInForTest();
    assert.deepEqual(await signin.signInFor('codex', cli.port, { now: 2, home }), OUT);
    assert.equal(cli.asks, 1);
  });

  it('reuses a record another window wrote, without asking', async () => {
    await signin.signInFor('grok', port('s1', IN).port, { now: 1, home });
    signin.resetSignInForTest();
    const other = port('s1', OUT);
    assert.deepEqual(await signin.signInFor('grok', other.port, { now: 2, home }), IN);
    assert.equal(other.asks, 0);
  });

  it('stores nothing on a failed ask and waits a minute before the next', async () => {
    const cli = port('s1', undefined);
    assert.equal(await signin.signInFor('claude', cli.port, { now: 0, home }), undefined);
    assert.equal(
      await signin.signInFor('claude', cli.port, { now: signin.RETRY_MS - 1, home }),
      undefined
    );
    assert.equal(cli.asks, 1);
    cli.answer = IN;
    assert.deepEqual(
      await signin.signInFor('claude', cli.port, { now: signin.RETRY_MS, home }),
      IN
    );
    assert.equal(cli.asks, 2);
  });

  it('answers the stale record when the ask fails, unless forced', async () => {
    const cli = port('s1', IN);
    await signin.signInFor('claude', cli.port, { now: 0, home });
    cli.stamp = 's2';
    cli.answer = undefined;
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 1, home }), IN);
    assert.equal(
      await signin.signInFor('claude', cli.port, { now: 2, home, force: true }),
      undefined
    );
  });

  it('asks over a matching stamp when forced', async () => {
    const cli = port('s1', IN);
    await signin.signInFor('claude', cli.port, { now: 1, home });
    cli.answer = OUT;
    assert.deepEqual(
      await signin.signInFor('claude', cli.port, { now: 2, home, force: true }),
      OUT
    );
    assert.equal(cli.asks, 2);
  });

  it('keeps each binary its own answer under one account', async () => {
    // A window whose path setting names another binary (a wrapper, a fixture)
    // reads the same config stamp and may answer differently.
    const other: AccountRowStatus = { loggedIn: true, email: 'other@example.com' };
    let asks = 0;
    const cli: AccountSource = {
      stamp: () => Promise.resolve('s1'),
      status: (override) => {
        asks += 1;
        return Promise.resolve(override ? other : IN);
      }
    };
    const shim = path.resolve('/opt/shim/claude');
    assert.deepEqual(
      await signin.signInFor('claude', cli, { now: 1, home, override: shim, force: true }),
      other
    );
    assert.deepEqual(await signin.signInFor('claude', cli, { now: 2, home }), IN);
    assert.equal(asks, 2);
    assert.deepEqual(await signin.signInFor('claude', cli, { now: 3, home }), IN);
    assert.deepEqual(
      await signin.signInFor('claude', cli, { now: 4, home, override: shim }),
      other
    );
    assert.equal(asks, 2);
    assert.deepEqual(await signin.storedSignIn('claude', { home }), IN);
    assert.deepEqual(await signin.storedSignIn('claude', { home, override: shim }), other);
  });

  it('reads a blank override as the default search', async () => {
    const cli = port('s1', IN);
    await signin.signInFor('claude', cli.port, { now: 1, home, override: '  ' });
    await signin.signInFor('claude', cli.port, { now: 2, home });
    assert.equal(cli.asks, 1);
  });

  it('asks on a record it cannot read', async () => {
    const file = path.join(home, '.squadron', 'signin.claude.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{"status":{"loggedIn":"yes"},"stamp":"s1","at":1}');
    const cli = port('s1', IN);
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 2, home }), IN);
    assert.equal(cli.asks, 1);
  });

  it('asks again when the stamp moved while the CLI was answering', async () => {
    const cli = port('s1', IN);
    const { gate, open } = opened();
    cli.gate = gate;
    const first = signin.signInFor('codex', cli.port, { now: 1, home });
    await asked(cli, 1);
    cli.stamp = 's2';
    open();
    await first;
    cli.gate = undefined;
    await signin.signInFor('codex', cli.port, { now: 2, home });
    assert.equal(cli.asks, 2);
  });

  it('waits a minute before asking again when the answer could not be stored', async () => {
    // A file where the store's directory should be: every write fails.
    const blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'signin-blocked-'));
    await fs.writeFile(path.join(blocked, '.squadron'), '');
    const cli = port('s1', IN);
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 0, home: blocked }), IN);
    await signin.signInFor('claude', cli.port, { now: 1, home: blocked });
    assert.equal(cli.asks, 1);
    await signin.signInFor('claude', cli.port, { now: signin.RETRY_MS, home: blocked });
    assert.equal(cli.asks, 2);
  });

  it('answers the record and asks nothing while the stamp cannot be told', async () => {
    const cli = port('s1', IN);
    await signin.signInFor('claude', cli.port, { now: 1, home });
    cli.stamp = undefined;
    cli.answer = OUT;
    assert.deepEqual(await signin.signInFor('claude', cli.port, { now: 2, home }), IN);
    signin.resetSignInForTest();
    await fs.rm(path.join(home, '.squadron'), { recursive: true, force: true });
    assert.equal(await signin.signInFor('claude', cli.port, { now: 3, home }), undefined);
    assert.equal(cli.asks, 1);
  });

  it('asks once for two overlapping passes', async () => {
    const cli = port('s1', IN);
    const { gate, open } = opened();
    cli.gate = gate;
    const first = signin.signInFor('codex', cli.port, { now: 1, home });
    const second = signin.signInFor('codex', cli.port, { now: 2, home });
    open();
    assert.deepEqual(await first, IN);
    assert.deepEqual(await second, IN);
    assert.equal(cli.asks, 1);
  });

  it('does not join a pass running for another binary', async () => {
    const cli = port('s1', IN);
    const { gate, open } = opened();
    cli.gate = gate;
    const shim = path.resolve('/opt/shim/codex');
    const first = signin.signInFor('codex', cli.port, { now: 1, home });
    const second = signin.signInFor('codex', cli.port, { now: 2, home, override: shim });
    open();
    await Promise.all([first, second]);
    assert.equal(cli.asks, 2);
  });

  it('asks again after an ask already running when forced', async () => {
    const cli = port('s1', IN);
    const { gate, open } = opened();
    cli.gate = gate;
    const before = signin.signInFor('codex', cli.port, { now: 1, home });
    await asked(cli, 1);
    cli.answer = OUT;
    const forced = signin.signInFor('codex', cli.port, { now: 2, home, force: true });
    open();
    assert.deepEqual(await before, IN);
    assert.deepEqual(await forced, OUT);
    assert.equal(cli.asks, 2);
  });
});

describe('refreshCatalog', () => {
  /** An account-sourced catalog whose stamp and refresh outcome the test sets. */
  function catalog(stamp: string, ok = true) {
    const cli = {
      stamp,
      ok,
      refreshes: 0,
      gate: undefined as Promise<void> | undefined,
      adapter: undefined as unknown as Parameters<typeof signin.refreshCatalog>[1]
    };
    cli.adapter = {
      modelSource: 'account',
      account: { stamp: () => Promise.resolve(cli.stamp), status: () => Promise.resolve(IN) },
      refreshModels: async () => {
        cli.refreshes += 1;
        if (cli.gate) await cli.gate;
        return cli.ok;
      }
    };
    return cli;
  }

  it('refreshes once per stamp, and again when the stamp moves', async () => {
    const cli = catalog('s1');
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 1 });
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 2 });
    assert.equal(cli.refreshes, 1);
    cli.stamp = 's2';
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 3 });
    assert.equal(cli.refreshes, 2);
  });

  it('refreshes again when the path setting names another binary', async () => {
    const cli = catalog('s1');
    const shim = path.resolve('/opt/shim/codex');
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 1 });
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 2, override: shim });
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 3, override: shim });
    assert.equal(cli.refreshes, 2);
  });

  it('leaves a signed-out brand and a maintained catalog alone', async () => {
    const cli = catalog('s1');
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: false, now: 1 });
    await signin.refreshCatalog(
      'claude',
      { ...cli.adapter, modelSource: 'maintained' },
      { signedIn: true, now: 1 }
    );
    assert.equal(cli.refreshes, 0);
  });

  it('waits a minute after a refresh that failed', async () => {
    const cli = catalog('s1', false);
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 0 });
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: signin.RETRY_MS - 1 });
    assert.equal(cli.refreshes, 1);
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: signin.RETRY_MS });
    assert.equal(cli.refreshes, 2);
  });

  it('refreshes over a matching stamp when forced', async () => {
    const cli = catalog('s1');
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 1 });
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 2, force: true });
    assert.equal(cli.refreshes, 2);
  });

  it('refreshes once for two overlapping passes', async () => {
    const cli = catalog('s1');
    const { gate, open } = opened();
    cli.gate = gate;
    const first = signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 1 });
    const second = signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 2 });
    open();
    await Promise.all([first, second]);
    assert.equal(cli.refreshes, 1);
  });

  it('refreshes again after one already running when forced', async () => {
    const cli = catalog('s1');
    const { gate, open } = opened();
    cli.gate = gate;
    const before = signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 1 });
    const forced = signin.refreshCatalog('codex', cli.adapter, {
      signedIn: true,
      now: 2,
      force: true
    });
    open();
    await Promise.all([before, forced]);
    assert.equal(cli.refreshes, 2);
  });

  it('leaves the catalog alone while the stamp cannot be told', async () => {
    const cli = catalog('s1');
    cli.adapter = {
      ...cli.adapter,
      account: { stamp: () => Promise.resolve(undefined), status: () => Promise.resolve(IN) }
    };
    await signin.refreshCatalog('codex', cli.adapter, { signedIn: true, now: 1 });
    assert.equal(cli.refreshes, 0);
  });
});
