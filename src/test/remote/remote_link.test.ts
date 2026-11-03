import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canTurnOn, normalizeAllowlist } from '../../core/bridge/allow';
import type { Holder } from '../../core/remote/holder';
import * as link from '../../core/remote/link';
import type { RemoteEvent, RemoteSetup, RemoteState } from '../../core/remote/link';

const T0 = 1_700_000_000_000;
const SENTINEL = 'xq-SENTINEL-7f3a9c';

const setup: RemoteSetup = {
  messenger: { id: 'fake', label: 'Test messenger' },
  fields: [{ key: 'token', label: 'Bot token', set: true }],
  allowlist: ['T1:U1']
};

const elsewhere: Holder = {
  windowId: 'w-other',
  label: 'agentsview — staging',
  folder: '/work/agentsview',
  pid: 4321,
  startedAt: T0,
  since: T0
};

/** Folds `events` from off, each at its own minute, with the sentinel as the
 *  one credential value. */
function run(...events: RemoteEvent[]): RemoteState {
  return events.reduce(
    (state, event, i) =>
      link.remoteReduce(state, event, { now: T0 + i * 60_000, secrets: [SENTINEL] }),
    link.initialRemote(setup)
  );
}

describe('remoteReduce', () => {
  it('starts off, with no refusal', () => {
    assert.deepEqual(link.initialRemote(setup), { state: { kind: 'off' }, setup });
  });

  it('records a turn-on refused for a missing field, and for an empty allowlist', () => {
    const missing = canTurnOn({
      fields: [{ key: 'token', label: 'Bot token' }],
      credentials: {},
      allowlist: ['a']
    });
    const empty = canTurnOn({ fields: [], credentials: {}, allowlist: [] });
    assert.equal(missing.ok, false);
    assert.equal(empty.ok, false);
    const byField = run({ kind: 'turnOn', result: missing });
    assert.deepEqual(byField.state, { kind: 'off' });
    assert.deepEqual(byField.refused, {
      reason: 'Remote needs the Bot token first.',
      at: T0
    });
    assert.equal(
      run({ kind: 'turnOn', result: empty }).refused?.reason,
      'Remote needs an allowed account first.'
    );
  });

  it('names the window that holds Remote, by its label, when that is the refusal', () => {
    const state = run({ kind: 'turnOn', result: { ok: false, holder: elsewhere } });
    assert.deepEqual(state.refused?.holder, { label: elsewhere.label, folder: elsewhere.folder });
    assert.match(state.refused?.reason ?? '', /agentsview — staging/);
    assert.deepEqual(state.state, {
      kind: 'elsewhere',
      holder: { label: elsewhere.label, folder: elsewhere.folder }
    });
  });

  it('goes connecting, connected, reconnecting and connected again, keeping since across a warning', () => {
    const on = run({ kind: 'turnOn', result: { ok: true } });
    assert.deepEqual(on.state, { kind: 'connecting' });
    const up = run(
      { kind: 'turnOn', result: { ok: true } },
      { kind: 'link', link: { kind: 'connected' } }
    );
    assert.deepEqual(up.state, { kind: 'connected', since: T0 + 60_000 });
    const down = link.remoteReduce(
      up,
      { kind: 'link', link: { kind: 'reconnecting', reason: 'socket closed' } },
      { now: T0 + 120_000, secrets: [] }
    );
    assert.deepEqual(down.state, { kind: 'reconnecting', reason: 'socket closed' });
    const back = link.remoteReduce(
      down,
      { kind: 'link', link: { kind: 'connected' } },
      { now: T0 + 180_000, secrets: [] }
    );
    assert.deepEqual(back.state, { kind: 'connected', since: T0 + 180_000 });
    const warned = link.remoteReduce(
      back,
      { kind: 'link', link: { kind: 'connected', warning: 'another client holds this app' } },
      { now: T0 + 240_000, secrets: [] }
    );
    assert.deepEqual(warned.state, {
      kind: 'connected',
      since: T0 + 180_000,
      warning: 'another client holds this app'
    });
  });

  it('fails from connected, with the reason and whether it retries', () => {
    const failed = run(
      { kind: 'turnOn', result: { ok: true } },
      { kind: 'link', link: { kind: 'connected' } },
      { kind: 'link', link: { kind: 'failed', reason: 'token revoked', retry: false } }
    );
    assert.deepEqual(failed.state, { kind: 'failed', reason: 'token revoked', retry: false });
  });

  it('a successful turn-on clears the last refusal', () => {
    const state = run(
      { kind: 'turnOn', result: { ok: false, reason: 'Remote needs the Bot token first.' } },
      { kind: 'turnOn', result: { ok: true } }
    );
    assert.equal(state.refused, undefined);
  });

  it('turns off from any on state, clearing the refusal, and says why when it was not asked', () => {
    const off = run(
      { kind: 'turnOn', result: { ok: true } },
      { kind: 'link', link: { kind: 'connected' } },
      { kind: 'turnOff' }
    );
    assert.deepEqual(off.state, { kind: 'off' });
    const taken = run(
      { kind: 'turnOn', result: { ok: true } },
      { kind: 'turnOff', reason: 'Another window took Remote.' }
    );
    assert.deepEqual(taken.state, { kind: 'off', reason: 'Another window took Remote.' });
  });

  it('ignores a link move while off, so a late frame cannot turn it back on', () => {
    const state = run({ kind: 'link', link: { kind: 'connected' } });
    assert.deepEqual(state.state, { kind: 'off' });
  });

  it('shows a live holder elsewhere, and off again once it has gone', () => {
    const seen = run({ kind: 'holderSeen', holder: elsewhere });
    assert.deepEqual(seen.state, {
      kind: 'elsewhere',
      holder: { label: elsewhere.label, folder: elsewhere.folder }
    });
    const gone = link.remoteReduce(
      seen,
      { kind: 'holderSeen', holder: undefined },
      { now: T0, secrets: [] }
    );
    assert.deepEqual(gone.state, { kind: 'off' });
  });

  it('does not take a holder read for its own while on', () => {
    const on = run(
      { kind: 'turnOn', result: { ok: true } },
      { kind: 'holderSeen', holder: elsewhere }
    );
    assert.deepEqual(on.state, { kind: 'connecting' });
  });

  it('keeps a sentinel token in any adapter reason out of the state', () => {
    const leaky = `invalid_auth for ${SENTINEL} (${SENTINEL})`;
    const states = [
      run({ kind: 'turnOn', result: { ok: false, reason: leaky } }),
      run(
        { kind: 'turnOn', result: { ok: true } },
        { kind: 'link', link: { kind: 'reconnecting', reason: leaky } }
      ),
      run(
        { kind: 'turnOn', result: { ok: true } },
        { kind: 'link', link: { kind: 'failed', reason: leaky, retry: false } }
      ),
      run(
        { kind: 'turnOn', result: { ok: true } },
        { kind: 'link', link: { kind: 'connected', warning: leaky } }
      ),
      run({ kind: 'turnOn', result: { ok: true } }, { kind: 'turnOff', reason: leaky })
    ];
    for (const state of states) {
      const shown = JSON.stringify(link.remoteView(state, 'drinking'));
      assert.equal(shown.includes(SENTINEL), false, shown);
      assert.equal(shown.includes('invalid_auth for …'), true, shown);
    }
  });

  it('replaces its setup, the allowlist as the normalised ids', () => {
    const ids = normalizeAllowlist([' T1:U1 ', 'T1:U1', 7, 'T2:U9', '']);
    const state = run({ kind: 'setup', setup: { ...setup, allowlist: ids } });
    assert.deepEqual(state.setup.allowlist, ['T1:U1', 'T2:U9']);
    assert.equal(link.remoteView(state, 'idle').setup.allowlist.length, 2);
  });
});

describe('remoteReduce: a refusal or an off reason outlives no cause', () => {
  const at = { now: T0, secrets: [] };
  const unset: RemoteSetup = {
    ...setup,
    fields: [{ key: 'token', label: 'Bot token', set: false }]
  };
  const nobody: RemoteSetup = { ...setup, allowlist: [] };
  const missing = {
    ok: false as const,
    reason: 'Remote needs the Bot token first.',
    cause: 'setup' as const
  };

  it('drops a refusal naming a holder once no holder is seen, and keeps it while that holder is', () => {
    const refused = run({ kind: 'turnOn', result: { ok: false, holder: elsewhere } });
    const still = link.remoteReduce(refused, { kind: 'holderSeen', holder: elsewhere }, at);
    assert.equal(still.refused?.holder?.label, elsewhere.label);
    const gone = link.remoteReduce(still, { kind: 'holderSeen', holder: undefined }, at);
    assert.equal(gone.refused, undefined);
    assert.deepEqual(gone.state, { kind: 'off' });
  });

  it('drops a refusal naming a holder once another window holds Remote', () => {
    const refused = run({ kind: 'turnOn', result: { ok: false, holder: elsewhere } });
    const other: Holder = { ...elsewhere, windowId: 'w-third', label: 'third window' };
    const moved = link.remoteReduce(refused, { kind: 'holderSeen', holder: other }, at);
    assert.equal(moved.refused, undefined);
    assert.deepEqual(moved.state, {
      kind: 'elsewhere',
      holder: { label: 'third window', folder: elsewhere.folder }
    });
  });

  it('drops a refusal for setup once the setup is satisfied, and not before', () => {
    const refused = run({ kind: 'setup', setup: unset }, { kind: 'turnOn', result: missing });
    const half = link.remoteReduce(
      refused,
      { kind: 'setup', setup: { ...unset, allowlist: [] } },
      at
    );
    assert.equal(half.refused?.reason, missing.reason);
    const done = link.remoteReduce(half, { kind: 'setup', setup }, at);
    assert.equal(done.refused, undefined);
  });

  it('keeps a refusal that setup did not cause when the setup changes', () => {
    const refused = run({
      kind: 'turnOn',
      result: { ok: false, reason: 'the messenger would not build' }
    });
    const after = link.remoteReduce(refused, { kind: 'setup', setup }, at);
    assert.equal(after.refused?.reason, 'the messenger would not build');
  });

  it('drops an off reason setup caused once the setup is satisfied', () => {
    const off = run(
      { kind: 'turnOn', result: { ok: true } },
      { kind: 'setup', setup: nobody },
      { kind: 'turnOff', reason: 'Remote needs an allowed account first.', cause: 'setup' }
    );
    assert.deepEqual(off.state, {
      kind: 'off',
      reason: 'Remote needs an allowed account first.',
      cause: 'setup'
    });
    assert.deepEqual(link.remoteReduce(off, { kind: 'setup', setup }, at).state, { kind: 'off' });
  });

  it('a turn-off while off drops the refusal and the off reason; elsewhere stays elsewhere', () => {
    const off = run(
      { kind: 'turnOn', result: { ok: true } },
      { kind: 'turnOff', reason: 'Remote went off here: its holder file was removed.' },
      { kind: 'turnOn', result: { ok: false, reason: 'the messenger would not build' } },
      { kind: 'turnOff' }
    );
    assert.deepEqual(off, { state: { kind: 'off' }, setup });
    const seen = run(
      { kind: 'turnOn', result: { ok: false, holder: elsewhere } },
      { kind: 'turnOff' }
    );
    assert.equal(seen.refused, undefined);
    assert.equal(seen.state.kind, 'elsewhere');
  });
});

describe('remoteView', () => {
  it('carries awake in every on state and not when off or elsewhere', () => {
    const on: RemoteState[] = [
      run({ kind: 'turnOn', result: { ok: true } }),
      run({ kind: 'turnOn', result: { ok: true } }, { kind: 'link', link: { kind: 'connected' } }),
      run(
        { kind: 'turnOn', result: { ok: true } },
        { kind: 'link', link: { kind: 'reconnecting', reason: 'r' } }
      ),
      run(
        { kind: 'turnOn', result: { ok: true } },
        { kind: 'link', link: { kind: 'failed', reason: 'f', retry: false } }
      )
    ];
    for (const state of on) assert.equal(link.remoteView(state, 'off').awake, 'off');
    assert.equal('awake' in link.remoteView(run(), 'drinking'), false);
    assert.equal(
      'awake' in link.remoteView(run({ kind: 'holderSeen', holder: elsewhere }), 'drinking'),
      false
    );
  });

  it('says the Remote hold is off only while Remote is on here, and only when it is off', () => {
    const on = run({ kind: 'turnOn', result: { ok: true } });
    assert.equal(link.remoteView(on, 'idle', false).awakeRemote, false);
    assert.equal('awakeRemote' in link.remoteView(on, 'idle', true), false);
    assert.equal('awakeRemote' in link.remoteView(run(), 'idle', false), false);
  });

  it('never carries a credential value, only whether each field is set', () => {
    const view = link.remoteView(run(), 'idle');
    assert.deepEqual(view.setup.fields, [{ key: 'token', label: 'Bot token', set: true }]);
  });
});

describe('redact', () => {
  it('replaces every value of four characters or more, longest first', () => {
    assert.equal(link.redact('a abcd abcdef b', ['abcd', 'abcdef', 'ab']), 'a … … b');
  });

  it('leaves text with no value in it as it is', () => {
    assert.equal(link.redact('socket closed', ['secret-token']), 'socket closed');
  });
});

describe('the switch across a restart', () => {
  const now = T0 + 3_600_000;

  it('stays off after a crash, which stamps nothing', () => {
    // The socket and every owned session died with the window.
    assert.equal(link.restores({ remembered: true, offAt: undefined, now }), false);
  });

  it('comes back after a reload, and not after a window closed for longer', () => {
    assert.equal(link.RESTORE_MS, 120_000);
    assert.equal(link.restores({ remembered: true, offAt: now - 30_000, now }), true);
    assert.equal(link.restores({ remembered: true, offAt: now - link.RESTORE_MS, now }), false);
    assert.equal(link.restores({ remembered: true, offAt: now - 600_000, now }), false);
  });

  it('never comes back once it was turned off', () => {
    assert.equal(link.restores({ remembered: false, offAt: undefined, now }), false);
  });

  const later = (memory: { on: boolean; offAt?: number } | undefined) =>
    link.restores({
      remembered: memory?.on ?? false,
      offAt: memory?.offAt,
      now: now + link.RESTORE_MS + 1
    });

  it('stamps the close from the remembered switch, though a rebuild has no engine built', () => {
    // A rebuild tears the engine down while the switch stays on; a close in
    // that gap stamped nothing, and the reload after it read as a crash.
    const memory = new link.SwitchMemory();
    memory.set({ on: true });
    const stamped = memory.close(now);
    assert.deepEqual(stamped, { on: true, offAt: now });
    assert.equal(
      link.restores({ remembered: true, offAt: stamped?.offAt, now: now + 1_000 }),
      true
    );
    assert.equal(later(stamped), false);
  });

  it('keeps the stamp when a turn-on finishes after the close', () => {
    const memory = new link.SwitchMemory();
    assert.equal(memory.close(now), undefined, 'nothing to stamp while off');
    assert.deepEqual(memory.set({ on: true }), { on: true, offAt: now });
    assert.equal(later(memory.set({ on: true })), false);
    assert.deepEqual(memory.set({ on: false }), { on: false });
  });
});

describe('the messenger and its secrets', () => {
  it('keys one secret per field, under the messenger', () => {
    assert.equal(link.secretKey('fake', 'token'), 'squadron.remote.fake.token');
  });

  it('chooses the first listed messenger unless one is named', () => {
    const dev = { unlisted: true };
    const chosen = link.chooseMessenger(undefined, dev);
    assert.equal(chosen.listed, true);
    assert.equal(link.chooseMessenger('fake', dev).id, 'fake');
    assert.equal(link.chooseMessenger('', dev).id, chosen.id);
    assert.equal(link.chooseMessenger('no-such', dev).id, chosen.id);
    assert.equal(link.chooseMessenger('constructor', dev).id, chosen.id);
  });

  it('chooses an unlisted messenger only where unlisted ones may run', () => {
    const shipped = { unlisted: false };
    const chosen = link.chooseMessenger('fake', shipped);
    assert.equal(chosen.listed, true);
    assert.equal(chosen.id, link.chooseMessenger(undefined, shipped).id);
    assert.equal(link.chooseMessenger(chosen.id, shipped).id, chosen.id);
  });
});

describe('Remote turning itself off', () => {
  it('says the holder file went, or names the window that has it now', () => {
    assert.match(link.holderLost(undefined), /removed/);
    const taken = link.holderLost({ label: elsewhere.label });
    assert.match(taken, /agentsview — staging/);
  });
});

describe('the switch as remembered on disk', () => {
  it('reads what was written, and anything else as off', () => {
    assert.deepEqual(link.readRemembered('{"on":true}'), { on: true });
    assert.deepEqual(link.readRemembered('{"on":true,"offAt":5}'), { on: true, offAt: 5 });
    assert.deepEqual(link.readRemembered('{"on":false,"offAt":5}'), { on: false, offAt: 5 });
    for (const text of [undefined, '', 'nope', '[]', '{"on":"yes"}', '{"on":true,"offAt":"x"}']) {
      assert.deepEqual(link.readRemembered(text), { on: false }, String(text));
    }
  });
});
