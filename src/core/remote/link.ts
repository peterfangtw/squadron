/**
 * Remote's switch and its link, as the panel draws them: every state, and
 * every move into one, as a pure reducer, so each is a test rather than
 * something watched in an IDE. `host/remote.ts` feeds it events and hands
 * `remoteView` to whoever draws.
 *
 * No credential value is held here. Each event that carries a reason is
 * redacted against the values the host passes beside it, as a second guard
 * behind every adapter's rule of naming no token; the values themselves are
 * never stored.
 */

import type { AccountProblem } from '../bridge/allow';
import type { Holder } from './holder';
import {
  messenger,
  messengers,
  type LinkState,
  type MessengerEntry,
  type SetupCheck
} from '../bridge/port';
import type { AwakeReason } from '../awake';

/** How a reader knows the window that holds Remote: its claim's label. */
export type HolderName = { label: string; folder?: string };

/** What a refusal or an off reason was about, when it can stop being true:
 *  `setup` is `canTurnOn`'s, gone once every field is set and someone is
 *  allowed. A refusal naming a holder carries the holder instead. */
export type Cause = 'setup';

export type RemoteLink =
  /** `reason` when Remote went off without being asked to: its holder file
   *  was taken, or the allowlist emptied. */
  | { kind: 'off'; reason?: string; cause?: Cause }
  /** Seen from a window that does not hold Remote. */
  | { kind: 'elsewhere'; holder: HolderName }
  | { kind: 'connecting' }
  | { kind: 'connected'; since: number; warning?: string }
  | { kind: 'reconnecting'; reason: string }
  | { kind: 'failed'; reason: string; retry: boolean };

export type RemoteSetup = {
  messenger: { id: string; label: string };
  /** Whether each credential is stored. Never its value. */
  fields: readonly { key: string; label: string; set: boolean }[];
  /** The setting through `normalizeAllowlist`; the count is its length. */
  allowlist: readonly string[];
  /** Each listed account the messenger cannot use, and why
   *  (`resolveAccounts`). Absent or empty: every one is usable. */
  unusable?: readonly { account: string; problem: AccountProblem }[];
  /** The space setting, for a messenger whose accounts have one: its value,
   *  and why the messenger refuses it when it does. */
  space?: { value?: string; refused?: string };
};

/** The last turn-on that did not happen. Drawn until its cause has gone,
 *  a turn-on succeeds, or a person turns Remote off. */
export type Refused = { reason: string; holder?: HolderName; cause?: Cause; at: number };

export type RemoteState = { state: RemoteLink; refused?: Refused; setup: RemoteSetup };

/** The setup check's runner (`core/remote/check.ts`) as the view reads it:
 *  never run, running, or its last result with when it finished. */
export type CheckState =
  { kind: 'never' } | { kind: 'checking' } | { kind: 'result'; result: SetupCheck; at: number };

/** What M4 draws. `awake` is keep-awake's verdict while this window holds
 *  Remote, so the panel can warn that the machine may sleep (U11), and
 *  `awakeRemote: false` that the reader turned the Remote hold off. `check`
 *  absent reads as never checked. */
export type RemoteView = RemoteState & {
  awake?: AwakeReason;
  awakeRemote?: false;
  check?: CheckState;
};

export type TurnedOn =
  | { ok: true }
  /** `canTurnOn`'s or the messenger's reason; or the live holder, which the
   *  reducer words. */
  | { ok: false; reason: string; holder?: undefined; cause?: Cause }
  | { ok: false; reason?: string; holder: Holder };

export type RemoteEvent =
  | { kind: 'turnOn'; result: TurnedOn }
  | { kind: 'link'; link: LinkState }
  /** Off while already off is a person dismissing what is drawn. */
  | { kind: 'turnOff'; reason?: string; cause?: Cause }
  /** A non-holder window's read of `holder.json` against the process table. */
  | { kind: 'holderSeen'; holder: Holder | undefined }
  | { kind: 'setup'; setup: RemoteSetup };

/** The clock, and the credential values every stored reason is redacted
 *  against. */
export type ReduceContext = { now: number; secrets: readonly string[] };

export function initialRemote(setup: RemoteSetup): RemoteState {
  return { state: { kind: 'off' }, setup };
}

export function remoteReduce(
  previous: RemoteState,
  event: RemoteEvent,
  context: ReduceContext
): RemoteState {
  const clean = (text: string) => redact(text, context.secrets);
  const { refused: _refused, ...rest } = previous;
  switch (event.kind) {
    case 'turnOn': {
      if (event.result.ok) return { ...rest, state: { kind: 'connecting' } };
      const holder = event.result.holder && nameOf(event.result.holder);
      const reason = event.result.reason ?? heldIn(holder?.label ?? '');
      const cause = event.result.holder ? undefined : event.result.cause;
      const refused: Refused = {
        reason: clean(reason),
        ...(holder === undefined ? {} : { holder }),
        ...(cause === undefined ? {} : { cause }),
        at: context.now
      };
      const state: RemoteLink =
        holder !== undefined && !isOn(previous.state)
          ? { kind: 'elsewhere', holder }
          : previous.state;
      return { ...previous, state, refused };
    }
    case 'link':
      return isOn(previous.state)
        ? { ...previous, state: linked(previous.state, event.link, context.now, clean) }
        : previous;
    case 'turnOff': {
      if (previous.state.kind === 'elsewhere') return rest;
      const state: RemoteLink =
        event.reason === undefined
          ? { kind: 'off' }
          : {
              kind: 'off',
              reason: clean(event.reason),
              ...(event.cause === undefined ? {} : { cause: event.cause })
            };
      return { ...rest, state };
    }
    case 'holderSeen': {
      // While on, the holder read is this window's own.
      if (isOn(previous.state)) return previous;
      const seen = event.holder && nameOf(event.holder);
      const held = previous.refused?.holder;
      const next =
        held && !(seen && seen.label === held.label && seen.folder === held.folder)
          ? rest
          : previous;
      if (seen) return { ...next, state: { kind: 'elsewhere', holder: seen } };
      return previous.state.kind === 'elsewhere' ? { ...next, state: { kind: 'off' } } : next;
    }
    case 'setup': {
      const next = { ...previous, setup: event.setup };
      if (!satisfied(event.setup)) return next;
      const { refused, state, ...kept } = next;
      return {
        ...kept,
        ...(refused && refused.cause !== 'setup' ? { refused } : {}),
        state: state.kind === 'off' && state.cause === 'setup' ? { kind: 'off' } : state
      };
    }
  }
}

/** Every credential stored and someone allowed: `canTurnOn`'s two asks, as
 *  the setup records them. */
function satisfied(setup: RemoteSetup): boolean {
  return setup.fields.every((field) => field.set) && usableAccounts(setup) > 0;
}

/** How many listed accounts the messenger can use. */
export function usableAccounts(setup: RemoteSetup): number {
  return setup.allowlist.length - (setup.unusable?.length ?? 0);
}

/** The state with keep-awake's reason, and the Remote hold when it is off,
 *  beside it while Remote is on here. */
export function remoteView(
  state: RemoteState,
  awake: AwakeReason,
  holdsForRemote = true
): RemoteView {
  if (!isOn(state.state)) return state;
  return holdsForRemote ? { ...state, awake } : { ...state, awake, awakeRemote: false };
}

/**
 * How long after this window last went off a restart still turns Remote back
 * on (a duration). A reload is back within seconds; a window closed and opened
 * again later starts with Remote off (D37, U12).
 */
export const RESTORE_MS = 120_000;

/**
 * Whether Remote turns itself back on as this window activates: it was on
 * when the window went, and the window stamped its going under `RESTORE_MS`
 * ago. A crash stamps nothing and counts as a close: the socket and every
 * owned session died with the window, so there is nothing to restore (U12).
 */
export function restores(input: {
  remembered: boolean;
  offAt: number | undefined;
  now: number;
}): boolean {
  if (!input.remembered || input.offAt === undefined) return false;
  return input.now - input.offAt < RESTORE_MS;
}

/** What a window keeps about its switch across a restart: on when it went,
 *  and when it went. A crash writes no `offAt`. */
export type Remembered = { on: boolean; offAt?: number };

/**
 * The switch as this window last wrote it, held so that a closing window
 * stamps its off-time from what it remembered — not from whether an engine is
 * built, which a rebuild tears down while the switch stays on. Once closed, an
 * "on" written later (a turn-on finishing behind the close) keeps the stamp,
 * so a later reopen past `RESTORE_MS` stays off (U12).
 */
export class SwitchMemory {
  private memory: Remembered = { on: false };
  private closedAt: number | undefined;

  /** What to write for `next`: `next`, or after the close the same switch
   *  with the close's stamp. */
  set(next: Remembered): Remembered {
    this.memory =
      next.on && this.closedAt !== undefined ? { on: true, offAt: this.closedAt } : next;
    return this.memory;
  }

  /** The window is going: what to write now, or nothing while off. */
  close(now: number): Remembered | undefined {
    this.closedAt ??= now;
    return this.memory.on ? this.set({ on: true }) : undefined;
  }
}

/** The file as written, or off for anything else: a file this window cannot
 *  read is a switch it does not turn back on. */
export function readRemembered(text: string | undefined): Remembered {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? '');
  } catch {
    return { on: false };
  }
  if (!raw || typeof raw !== 'object') return { on: false };
  const { on, offAt } = raw as { on?: unknown; offAt?: unknown };
  if (typeof on !== 'boolean') return { on: false };
  if (offAt === undefined) return { on };
  return typeof offAt === 'number' && Number.isFinite(offAt) ? { on, offAt } : { on: false };
}

/** Where one credential field is kept: one secret per field, per messenger. */
export function secretKey(messengerId: string, fieldKey: string): string {
  return `squadron.remote.${messengerId}.${fieldKey}`;
}

/**
 * The messenger Remote runs: the one the undeclared setting names, which is
 * the only way to the unlisted test messenger, else the first listed. An
 * unlisted one is chosen only where `unlisted` allows it, which the host
 * grants outside Production: the fake takes events from any local process
 * under any sender, so a workspace's settings must not reach it in an
 * installed extension.
 */
export function chooseMessenger(
  named: string | undefined,
  options: { unlisted: boolean }
): MessengerEntry {
  const chosen = named ? messenger(named) : undefined;
  if (chosen && (chosen.listed || options.unlisted)) return chosen;
  const listed = messengers().find((entry) => entry.listed);
  if (!listed) throw new Error('no listed messenger is registered');
  return listed;
}

/** Why Remote went off here on its own: the holder file stopped naming this
 *  window. */
export function holderLost(holder: HolderName | undefined): string {
  return holder
    ? `Remote went off here: ${holder.label} holds it now.`
    : 'Remote went off here: its holder file was removed.';
}

/** The refusal when another window holds Remote. */
export function heldIn(label: string): string {
  return `Remote is on in ${label || 'another window'}. Turn it off there first.`;
}

/** Each value of four characters or more, as `…`, longest first so a value
 *  inside another is not left half shown. Shorter values are too common to
 *  mean a credential. */
export function redact(text: string, values: readonly string[]): string {
  return [...values]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((out, value) => out.split(value).join('…'), text);
}

/** This window holds Remote, whatever its link is doing. */
export function isOn(state: RemoteLink): boolean {
  return state.kind !== 'off' && state.kind !== 'elsewhere';
}

/** Remote is on in some window: this one, or the one that holds it. */
export function onSomewhere(state: RemoteLink): boolean {
  return isOn(state) || state.kind === 'elsewhere';
}

function linked(
  state: RemoteLink,
  next: LinkState,
  now: number,
  clean: (text: string) => string
): RemoteLink {
  switch (next.kind) {
    case 'connecting':
      return { kind: 'connecting' };
    case 'connected': {
      const since = state.kind === 'connected' ? state.since : now;
      return next.warning === undefined
        ? { kind: 'connected', since }
        : { kind: 'connected', since, warning: clean(next.warning) };
    }
    case 'reconnecting':
      return { kind: 'reconnecting', reason: clean(next.reason) };
    case 'failed':
      return { kind: 'failed', reason: clean(next.reason), retry: next.retry };
  }
}

function nameOf(holder: Holder): HolderName {
  return holder.folder === undefined
    ? { label: holder.label }
    : { label: holder.label, folder: holder.folder };
}
