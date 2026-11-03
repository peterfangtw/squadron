import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { awakeBarTone, awakeConfig, awakeState } from '../../ui/awake_rows';
import type { AwakeFacts } from '../../ui/awake_rows';
import { LEASE_MS } from '../../ui/lease';

const NOW = 1_800_000_000_000;

const facts = (over: Partial<AwakeFacts> = {}): AwakeFacts => ({
  view: { reason: 'idle' },
  enabled: true,
  remoteHold: true,
  remoteOn: false,
  warmHold: true,
  warmOn: false,
  ...over
});

const drinking = (
  over: Partial<{ until: number; sessions: number; remote: true; warmSessions: number }> = {}
): AwakeView => ({ reason: 'drinking', until: NOW + 7 * 60_000, sessions: 2, ...over });

describe('awakeState', () => {
  it('holds for the sessions, with the lease left as minutes and a share', () => {
    assert.deepEqual(awakeState(facts({ view: drinking() }), NOW), {
      tone: 'on',
      head: 'Awake',
      reason: 'Kept awake for 2 sessions',
      left: '7 min left',
      fill: (7 * 60_000) / LEASE_MS
    });
  });

  it('says one session in the singular', () => {
    assert.equal(
      awakeState(facts({ view: drinking({ sessions: 1 }) }), NOW).reason,
      'Kept awake for 1 session'
    );
  });

  it('rounds a part minute up, so a held lease never reads 0 min', () => {
    assert.equal(
      awakeState(facts({ view: drinking({ until: NOW + 20_000 }) }), NOW).left,
      '1 min left'
    );
  });

  it('holds for Remote alone when no session is held for', () => {
    const state = awakeState(
      facts({ view: drinking({ sessions: 0, remote: true }), remoteOn: true }),
      NOW
    );
    assert.equal(state.tone, 'on');
    assert.equal(state.head, 'Awake for Remote');
    assert.equal(state.reason, 'Nothing working · awake so messages from your phone arrive');
  });

  it('names the timer when a hold names nothing it keeps the Mac awake for', () => {
    assert.equal(
      awakeState(facts({ view: drinking({ sessions: 0 }) }), NOW).reason,
      'Nothing working · awake until the time left runs out'
    );
  });

  it('ranks sessions above Remote when a hold is for both', () => {
    const state = awakeState(
      facts({ view: drinking({ sessions: 1, remote: true }), remoteOn: true }),
      NOW
    );
    assert.equal(state.head, 'Awake');
    assert.equal(state.reason, 'Kept awake for 1 session');
  });

  it('holds for Warm alone when no session is held for', () => {
    const state = awakeState(facts({ view: drinking({ sessions: 0, warmSessions: 2 }) }), NOW);
    assert.equal(state.tone, 'on');
    assert.equal(state.head, 'Awake for Warm');
    assert.equal(state.reason, "Nothing working · awake so 2 sessions' caches stay warm");
  });

  it('ranks Remote above Warm when a lease holds for both', () => {
    const state = awakeState(
      facts({ view: drinking({ sessions: 0, remote: true, warmSessions: 1 }), remoteOn: true }),
      NOW
    );
    assert.equal(state.head, 'Awake for Remote');
  });

  it('ranks sessions above Warm when a lease holds for both', () => {
    const state = awakeState(facts({ view: drinking({ sessions: 1, warmSessions: 1 }) }), NOW);
    assert.equal(state.head, 'Awake');
    assert.equal(state.reason, 'Kept awake for 1 session');
  });

  it('reads a hold that ran out between pushes as not awake', () => {
    const state = awakeState(facts({ view: drinking({ until: NOW }) }), NOW);
    assert.equal(state.tone, 'quiet');
    assert.equal(state.left, undefined);
  });

  it('lets the machine sleep with nothing working', () => {
    assert.deepEqual(awakeState(facts(), NOW), {
      tone: 'quiet',
      head: 'Lets it sleep',
      reason: 'Nothing working · the Mac sleeps as usual'
    });
  });

  it('warns when Remote is on and its hold is off', () => {
    assert.deepEqual(awakeState(facts({ remoteOn: true, remoteHold: false }), NOW), {
      tone: 'held',
      head: 'Lets it sleep',
      reason: 'Remote is on, nothing working · may sleep and miss messages'
    });
  });

  it('warns when Warm is on and its hold is off', () => {
    assert.deepEqual(awakeState(facts({ warmOn: true, warmHold: false }), NOW), {
      tone: 'held',
      head: 'Lets it sleep',
      reason: 'Warm is on, nothing working · may sleep and miss a ping'
    });
  });

  it('stays quiet with Warm on and its hold on, or Warm off', () => {
    const quiet = {
      tone: 'quiet',
      head: 'Lets it sleep',
      reason: 'Nothing working · the Mac sleeps as usual'
    };
    assert.deepEqual(awakeState(facts({ warmOn: true, warmHold: true }), NOW), quiet);
    assert.deepEqual(awakeState(facts({ warmOn: false, warmHold: false }), NOW), quiet);
  });

  it('says a silent session no longer keeps the Mac awake, without a count it cannot know', () => {
    assert.deepEqual(awakeState(facts({ view: { reason: 'stale' } }), NOW), {
      tone: 'held',
      head: 'Lets it sleep',
      reason: 'A session went silent · it no longer keeps the Mac awake'
    });
  });

  it('names the battery floor, and Remote when it is on', () => {
    assert.equal(
      awakeState(facts({ view: { reason: 'battery' } }), NOW).reason,
      'On battery below 20% · nothing keeps the Mac awake'
    );
    assert.equal(
      awakeState(facts({ view: { reason: 'battery' }, remoteOn: true }), NOW).reason,
      'On battery below 20% · nothing keeps the Mac awake, Remote included'
    );
  });

  it('is off with the setting off, whatever the view says', () => {
    assert.deepEqual(awakeState(facts({ enabled: false, view: undefined }), NOW), {
      tone: 'off',
      head: 'Off',
      reason: 'The Mac sleeps as usual'
    });
  });

  it('says Remote cannot keep it awake either only when Remote is on', () => {
    assert.equal(
      awakeState(facts({ enabled: false, view: undefined, remoteOn: true }), NOW).reason,
      'The Mac sleeps as usual · Remote cannot keep it awake either'
    );
  });

  it('is unavailable with the setting on and no view, which is a machine with no caffeinate', () => {
    assert.deepEqual(awakeState(facts({ view: undefined }), NOW), {
      tone: 'off',
      head: 'Not available',
      reason: 'Keep-awake runs on macOS only'
    });
  });
});

describe('awakeConfig', () => {
  it('states the three figures in drawer order', () => {
    assert.deepEqual(awakeConfig(), [
      {
        label: 'After work stops',
        detail:
          'The Mac stays awake this long after the last session stops working. The same limit applies if Squadron stops.',
        value: 'up to 10 min'
      },
      {
        label: 'Silent session',
        detail:
          'A working session that sends nothing for this long no longer keeps the Mac awake. Long builds and tests fit in this time.',
        value: '60 min'
      },
      {
        label: 'Battery below',
        detail: 'On battery and below this level, nothing keeps the Mac awake.',
        value: '20%'
      }
    ]);
  });
});

describe('awakeBarTone', () => {
  it('lights the dot while held, warns while refused, and clears it otherwise', () => {
    assert.equal(awakeBarTone('on'), 'on');
    assert.equal(awakeBarTone('held'), 'held');
    assert.equal(awakeBarTone('quiet'), undefined);
    assert.equal(awakeBarTone('off'), undefined);
  });
});
