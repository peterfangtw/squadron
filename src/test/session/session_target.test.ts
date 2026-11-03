import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as target from '../../core/session_target';
import { session } from '../views_helpers';
import type { Session } from '../../core/model';

const owner = { canControl: true, owner: { kind: 'window', windowId: 'window-b' } } as const;
const invalid = { canControl: false, reason: 'invalid' } as const;

describe('session target contract', () => {
  const cases: { name: string; over: Partial<Session>; reason?: string }[] = [
    { name: 'background', over: { background: true }, reason: 'background' },
    { name: 'legacy owner', over: { source: 'owned', windowId: 'window-b' } },
    { name: 'new owner', over: { control: owner } },
    {
      name: 'background legacy priority',
      over: { background: true, source: 'owned', windowId: 'window-b' },
      reason: 'background'
    },
    {
      name: 'background metadata contradicts owned alias',
      over: { source: 'owned', control: { canControl: false, reason: 'background' } },
      reason: 'invalid'
    },
    { name: 'unpublished', over: {}, reason: 'unpublished' },
    { name: 'bare window is no pipe', over: { windowId: 'window-b' }, reason: 'unpublished' },
    { name: 'missing legacy owner', over: { source: 'owned' }, reason: 'owner-missing' },
    {
      name: 'empty legacy owner',
      over: { source: 'owned', windowId: '' },
      reason: 'owner-missing'
    },
    {
      name: 'unclaimed new owner',
      over: {
        control: { canControl: true, owner: { kind: 'unclaimed', reason: 'owner-missing' } }
      },
      reason: 'owner-missing'
    },
    {
      name: 'invalid cannot fall back',
      over: { source: 'owned', windowId: 'window-b', control: invalid },
      reason: 'invalid'
    },
    {
      name: 'background contradicts control',
      over: { background: true, control: owner },
      reason: 'invalid'
    },
    {
      name: 'owner aliases disagree',
      over: { windowId: 'window-a', control: owner },
      reason: 'invalid'
    }
  ];
  for (const row of cases) {
    it(row.name, () => {
      const selected = session({ pid: 42, startedAt: 1000, ...row.over });
      const result = target.resolveTarget(selected, { claims: [{ id: 'window-b' }] });
      if (row.reason) {
        assert.deepEqual(result, { ok: false, reason: row.reason });
      } else {
        assert.deepEqual(result, {
          ok: true,
          session: selected,
          address: { pid: 42, startedAt: 1000, windowId: 'window-b' },
          reachability: 'confirmed'
        });
      }
    });
  }

  it('keeps absent owner claims advisory for local and foreign pipes', () => {
    const selected = session({ source: 'owned', windowId: 'window-b' });
    const result = target.resolveTarget(selected, { claims: [{ id: 'elsewhere' }] });
    assert.ok(result.ok);
    assert.equal(result.reachability, 'unconfirmed');
    assert.equal(result.address.windowId, 'window-b');
  });

  it('uses only a matching publication as exit evidence, never as an address donor', () => {
    const selected = session({ pid: 42, startedAt: 1000, control: owner });
    for (const over of [{ startedAt: 10_000 }, { pid: 99 }]) {
      const result = target.resolveTarget(selected, {
        published: new Map([
          [42, { session: { ...selected, ...over }, exit: { code: 0, signal: null } }]
        ])
      });
      assert.ok(result.ok);
      assert.deepEqual(result.address, { pid: 42, startedAt: 1000, windowId: 'window-b' });
    }
    assert.deepEqual(
      target.resolveTarget(selected, {
        published: new Map([[42, { session: selected, exit: { code: 0, signal: null } }]])
      }),
      { ok: false, reason: 'exited' }
    );
    assert.ok(target.resolveTarget(selected).ok, 'no publication is no exit');
    assert.deepEqual(
      target.resolveTarget(session({ pid: 42, startedAt: 1000 }), {
        published: new Map([[42, { session: selected }]])
      }),
      { ok: false, reason: 'unpublished' }
    );
  });

  it('bounds and narrows present metadata without permissive fallback', () => {
    assert.deepEqual(target.readControlFacts(owner), owner);
    assert.deepEqual(target.readControlFacts({ canControl: false, reason: 'background' }), {
      canControl: false,
      reason: 'background'
    });
    for (const raw of [
      undefined,
      null,
      [],
      {},
      { canControl: true },
      { ...owner, reason: 'background' },
      { canControl: false, reason: 'background', owner: owner.owner },
      { canControl: true, owner: { kind: 'window', windowId: '' } },
      { canControl: true, owner: { kind: 'window', windowId: 'x'.repeat(1025) } },
      { canControl: true, owner: { kind: 'unclaimed', reason: 'wat' } }
    ]) {
      assert.deepEqual(target.readControlFacts(raw), invalid);
    }
    const malformed = {
      ...session({ source: 'owned', windowId: 'window-b' }),
      control: null
    } as unknown as Session;
    assert.deepEqual(target.controlOf(malformed), invalid);
  });
});
