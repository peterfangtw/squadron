import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as allow from '../../core/bridge/allow';
import type { AccountRule } from '../../core/bridge/port';
import * as route from '../../core/bridge/route';

const FIELDS = [
  { key: 'bot', label: 'Bot token' },
  { key: 'app', label: 'App token' }
];

describe('the allowlist', () => {
  const list = allow.normalizeAllowlist(['T1:U1']);

  it('admits the listed sender', () => {
    assert.equal(allow.allowed({ id: 'T1:U1' }, list), true);
  });

  it('refuses a stranger', () => {
    assert.equal(allow.allowed({ id: 'T9:U9' }, list), false);
  });

  it('refuses a near miss: another team, another case, a stray space', () => {
    for (const id of ['T2:U1', 't1:u1', 'T1:U1 ', 'U1', 'T1:U10', '']) {
      assert.equal(allow.allowed({ id }, list), false, JSON.stringify(id));
    }
  });

  it('admits nobody when empty', () => {
    assert.equal(allow.allowed({ id: 'T1:U1' }, []), false);
  });
});

describe('normalizeAllowlist', () => {
  it('trims, drops blanks and non-strings, and keeps the first of a repeat', () => {
    const raw = [' T1:U1 ', '', '   ', 7, null, { id: 'T2:U2' }, 'T2:U2', 'T1:U1'];
    assert.deepEqual(allow.normalizeAllowlist(raw), ['T1:U1', 'T2:U2']);
  });

  it('reads a setting that is not a list as empty', () => {
    for (const raw of [undefined, null, 'T1:U1', 42, { 0: 'T1:U1' }]) {
      assert.deepEqual(allow.normalizeAllowlist(raw), [], JSON.stringify(raw));
    }
  });
});

describe('canTurnOn', () => {
  const credentials = { bot: 'b-123', app: 'a-456' };

  it('is ok with every field set and someone allowed', () => {
    assert.deepEqual(allow.canTurnOn({ fields: FIELDS, credentials, allowlist: ['T1:U1'] }), {
      ok: true
    });
  });

  it('refuses an empty allowlist', () => {
    const answer = allow.canTurnOn({ fields: FIELDS, credentials, allowlist: [] });
    assert.equal(answer.ok, false);
    if (!answer.ok) assert.match(answer.reason, /allowed account/);
  });

  it('refuses a missing or blank credential, naming its field', () => {
    const partial: Record<string, string>[] = [{ bot: 'b-123' }, { bot: 'b-123', app: '  ' }];
    for (const given of partial) {
      const answer = allow.canTurnOn({ fields: FIELDS, credentials: given, allowlist: ['T1:U1'] });
      assert.equal(answer.ok, false);
      if (!answer.ok) assert.match(answer.reason, /App token/);
    }
  });
});

describe('Deduper', () => {
  const MINUTE = 60_000;

  it('drops a repeated id across its whole window, and admits it after', () => {
    const seen = new allow.Deduper();
    assert.equal(seen.admit('e1', 0), true);
    assert.equal(seen.admit('e1', 1000), false);
    assert.equal(seen.admit('e2', 1000), true);
    assert.equal(seen.admit('e1', allow.DEDUPE_MS), false);
    assert.equal(seen.admit('e1', allow.DEDUPE_MS + 1), true);
  });

  it('outlasts the late rule by a redelivery, so no copy acts twice', () => {
    assert.ok(allow.DEDUPE_MS >= route.LATE_MS + 10 * MINUTE);
  });

  it('remembers at most 500, forgetting the oldest first', () => {
    const seen = new allow.Deduper();
    for (let n = 0; n < 501; n++) seen.admit(`e${n}`, n);
    assert.equal(seen.admit('e0', 600), true, 'the oldest was forgotten');
    assert.equal(seen.admit('e500', 600), false, 'the newest is still held');
  });
});

/** A rule that knows `U…` accounts, needing a `T…` space, and `T…:U…` as they
 *  stand: the shape a messenger with spaces states. */
const RULE: AccountRule = {
  refuse: (account) => (/^U\d$/.test(account) || /^T\d:U\d$/.test(account) ? undefined : 'no'),
  refuseSpace: (space) => (/^T\d$/.test(space) ? undefined : 'not a space'),
  sender: (account, space) =>
    account.includes(':') ? account : space === undefined ? undefined : `${space}:${account}`
};

describe('resolveAccounts', () => {
  it('composes each account with the space, in order', () => {
    assert.deepEqual(allow.resolveAccounts(RULE, ['U1', 'U2'], 'T1'), {
      ids: ['T1:U1', 'T1:U2'],
      unusable: []
    });
  });

  it('takes a complete sender id as it stands, so a list from before the space works', () => {
    assert.deepEqual(allow.resolveAccounts(RULE, ['T9:U1'], undefined).ids, ['T9:U1']);
  });

  it('holds back an account waiting on the space, and says so', () => {
    assert.deepEqual(allow.resolveAccounts(RULE, ['U1', 'T2:U2'], undefined), {
      ids: ['T2:U2'],
      unusable: [{ account: 'U1', problem: { kind: 'space' } }]
    });
  });

  it('reads a space the rule refuses as none set', () => {
    const resolved = allow.resolveAccounts(RULE, ['U1'], 'nonsense');
    assert.deepEqual(resolved.ids, []);
    assert.deepEqual(resolved.unusable, [{ account: 'U1', problem: { kind: 'space' } }]);
  });

  it('reports an account the rule refuses, with its reason, and never makes it home', () => {
    const resolved = allow.resolveAccounts(RULE, ['bob@example.com', 'U1'], 'T1');
    assert.deepEqual(resolved.ids, ['T1:U1']);
    assert.deepEqual(resolved.unusable, [
      { account: 'bob@example.com', problem: { kind: 'refused', reason: 'no' } }
    ]);
  });

  it('admits two spellings of one sender once', () => {
    assert.deepEqual(allow.resolveAccounts(RULE, ['U1', 'T1:U1'], 'T1').ids, ['T1:U1']);
  });
});

describe('admitAccounts', () => {
  it('writes an edit the rule takes whole', () => {
    assert.deepEqual(allow.admitAccounts(RULE, ['U1'], ['U1', 'U2']), {
      write: ['U1', 'U2'],
      refused: []
    });
  });

  it('leaves out an added account the rule refuses, and keeps the rest of the edit', () => {
    assert.deepEqual(allow.admitAccounts(RULE, ['U1'], ['U1', 'alice', 'U2']), {
      write: ['U1', 'U2'],
      refused: [{ account: 'alice', reason: 'no' }]
    });
  });

  it('never refuses an account already stored, so a removal always lands', () => {
    assert.deepEqual(allow.admitAccounts(RULE, ['alice', 'U1'], ['alice']), {
      write: ['alice'],
      refused: []
    });
  });

  it('normalizes what it is handed', () => {
    assert.deepEqual(allow.admitAccounts(RULE, [], [' U1 ', '', 'U1']).write, ['U1']);
  });
});

describe('canTurnOn, with accounts waiting on the space', () => {
  const ask = (set: boolean) =>
    allow.canTurnOn({
      fields: FIELDS,
      credentials: { bot: 'b', app: 'a' },
      allowlist: [],
      space: { label: 'Workspace', set }
    });

  it('names the space as what to fix, and that a check fills it', () => {
    assert.deepEqual(ask(false), {
      ok: false,
      reason: 'Remote needs the Workspace first. Check fills it in.'
    });
  });

  it('asks for one it can use when the one set is refused, which no check replaces', () => {
    assert.deepEqual(ask(true), { ok: false, reason: 'Remote needs a Workspace it can use.' });
  });
});

describe('waitsOnSpace', () => {
  it('is true only when an account waits on the space', () => {
    assert.equal(allow.waitsOnSpace(allow.resolveAccounts(RULE, ['U1'], undefined).unusable), true);
    assert.equal(allow.waitsOnSpace(allow.resolveAccounts(RULE, ['nope'], 'T1').unusable), false);
    assert.equal(allow.waitsOnSpace([]), false);
  });
});
