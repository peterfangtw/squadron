/**
 * What the Keep-awake drawer says: the state the master switch carries, the
 * figures beside it, and the tone the bar's dot takes.
 *
 * Words only. Whether the machine is held is the keeper's (`core/awake.ts`,
 * merged across windows into `AwakeView`); this turns that, the two switches
 * and the clock into lines, so the webview paints and a test reads them
 * headlessly.
 */

import { BATTERY_FLOOR_PCT, LEASE_MS, SILENCE_MS } from './lease';

/** Said once under the title. */
export const AWAKE_NOTE =
  'Keep this Mac awake while a session works. The Mac still sleeps when you close the lid.';

/** `on` is held now, `held` is a reason it is not when the reader may want it
 *  to be, `quiet` is nothing to hold, `off` is the feature not running. */
export type AwakeTone = 'on' | 'held' | 'quiet' | 'off';

export type AwakeState = {
  tone: AwakeTone;
  head: string;
  reason: string;
  /** Minutes of lease left, in words. Only while held. */
  left?: string;
  /** Share of a lease left, 0..1. Only while held. */
  fill?: number;
};

export type AwakeFacts = {
  /** The merged hold; absent with the setting off or off macOS. */
  view: AwakeView | undefined;
  /** `squadron.cafe.enabled`. */
  enabled: boolean;
  /** `squadron.cafe.remote`. */
  remoteHold: boolean;
  /** Remote is on in some window, this one or another (`RemoteStateView.onSomewhere`).
   *  The keeper's setting is machine-wide, so a hold switched off there is off
   *  here too. */
  remoteOn: boolean;
  /** `squadron.cafe.warm`. */
  warmHold: boolean;
  /** A session in this window has Warm on (`StateMessage.warmOn`). */
  warmOn: boolean;
};

export function awakeState(facts: AwakeFacts, now: number): AwakeState {
  const { view } = facts;
  if (!facts.enabled) {
    return {
      tone: 'off',
      head: 'Off',
      reason: facts.remoteOn
        ? 'The Mac sleeps as usual · Remote cannot keep it awake either'
        : 'The Mac sleeps as usual'
    };
  }
  if (view === undefined || view.reason === 'unsupported' || view.reason === 'off') {
    return { tone: 'off', head: 'Not available', reason: 'Keep-awake runs on macOS only' };
  }
  switch (view.reason) {
    case 'drinking':
      return view.until > now ? held(view, now) : idle(facts);
    case 'idle':
      return idle(facts);
    case 'stale':
      return {
        tone: 'held',
        head: 'Lets it sleep',
        reason: 'A session went silent · it no longer keeps the Mac awake'
      };
    case 'battery':
      return {
        tone: 'held',
        head: 'Lets it sleep',
        reason: `On battery below ${BATTERY_FLOOR_PCT}% · nothing keeps the Mac awake${facts.remoteOn ? ', Remote included' : ''}`
      };
  }
}

/** The master switch's detail: why, then that the setting is machine-wide. */
export function awakeDetail(state: AwakeState): string {
  return `${state.reason}. Applies to every window.`;
}

/** Sessions outrank Remote, and Remote outranks Warm: a lease poured for
 *  several says the most pressing. */
function held(view: Extract<AwakeView, { reason: 'drinking' }>, now: number): AwakeState {
  const remaining = view.until - now;
  const clock = {
    left: `${Math.ceil(remaining / 60_000)} min left`,
    fill: Math.min(1, remaining / LEASE_MS)
  };
  if (view.sessions > 0) {
    return {
      tone: 'on',
      head: 'Awake',
      reason: `Kept awake for ${count(view.sessions)}`,
      ...clock
    };
  }
  if (view.remote) {
    return {
      tone: 'on',
      head: 'Awake for Remote',
      reason: 'Nothing working · awake so messages from your phone arrive',
      ...clock
    };
  }
  if (view.warmSessions) {
    return {
      tone: 'on',
      head: 'Awake for Warm',
      reason: `Nothing working · awake so ${caches(view.warmSessions)} warm`,
      ...clock
    };
  }
  return {
    tone: 'on',
    head: 'Awake',
    reason: 'Nothing working · awake until the time left runs out',
    ...clock
  };
}

function idle(facts: AwakeFacts): AwakeState {
  if (facts.remoteOn && !facts.remoteHold) {
    return {
      tone: 'held',
      head: 'Lets it sleep',
      reason: 'Remote is on, nothing working · may sleep and miss messages'
    };
  }
  if (facts.warmOn && !facts.warmHold) {
    return {
      tone: 'held',
      head: 'Lets it sleep',
      reason: 'Warm is on, nothing working · may sleep and miss a ping'
    };
  }
  return {
    tone: 'quiet',
    head: 'Lets it sleep',
    reason: 'Nothing working · the Mac sleeps as usual'
  };
}

/** The bar's dot: lit while held, the waiting hue while refused when wanted,
 *  and clear otherwise. */
export function awakeBarTone(tone: AwakeTone): 'on' | 'held' | undefined {
  return tone === 'on' || tone === 'held' ? tone : undefined;
}

function count(sessions: number): string {
  return sessions === 1 ? '1 session' : `${sessions} sessions`;
}

function caches(sessions: number): string {
  return sessions === 1 ? "1 session's cache stays" : `${sessions} sessions' caches stay`;
}

export type AwakeFigure = { label: string; detail: string; value: string };

/** Drawn in this order. Battery outranks these in `decide` and is still last. */
export function awakeConfig(): AwakeFigure[] {
  return [
    {
      label: 'After work stops',
      detail:
        'The Mac stays awake this long after the last session stops working. The same limit applies if Squadron stops.',
      value: `up to ${minutes(LEASE_MS)}`
    },
    {
      label: 'Silent session',
      detail:
        'A working session that sends nothing for this long no longer keeps the Mac awake. Long builds and tests fit in this time.',
      value: minutes(SILENCE_MS)
    },
    {
      label: 'Battery below',
      detail: 'On battery and below this level, nothing keeps the Mac awake.',
      value: `${BATTERY_FLOOR_PCT}%`
    }
  ];
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}
