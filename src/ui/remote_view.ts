/**
 * What Remote says in this window, and what its switch may do.
 *
 * Words only. Every rule about Remote is `core/remote/link.ts`'s or
 * `core/bridge/`'s; this turns `RemoteHost.view()` and the selected
 * messenger's setup into `RemoteStateView`, so the webview paints decided
 * words and a test reads them headlessly. A reason those modules wrote is drawn
 * verbatim. No credential value, manifest text or URL reaches the result.
 */

import type { AwakeReason } from '../core/awake';
import { waitsOnSpace, type AccountProblem } from '../core/bridge/allow';
import * as port from '../core/bridge/port';
import type { MessengerSetup } from '../core/bridge/port';
import * as link from '../core/remote/link';
import type { CheckState, RemoteLink, RemoteView } from '../core/remote/link';

/** What `canTurnOn` (`core/bridge/allow.ts`) asks for when the list is empty,
 *  drawn before the press rather than as its refusal. */
const NO_ACCOUNT = 'an allowed account';

/** A closed lid sleeps whatever keep-awake holds (D4, `macos_power.md`). */
const LID_HINT = 'Keep the lid open: a closed lid sleeps regardless.';

/** Messengers not built yet, drawn so a reader looking for one learns why it
 *  is not there. Words only: `core/bridge/` names no messenger it does not
 *  run. Each tip is the PRD decision that keeps it out (D28, D29). */
const NOT_BUILT: readonly RemoteMessengerRow[] = [
  {
    id: 'discord',
    label: 'Discord',
    live: false,
    tip: 'Not supported yet. A DM has no threads, so each session’s conversation would be a reply chain (D29).'
  },
  {
    id: 'telegram',
    label: 'Telegram',
    live: false,
    tip: 'Not supported yet. A message that is not a reply starts new work, never the latest conversation (D28).'
  }
];

/** Keep-awake's verdicts that can cost a message while Remote is on. `off` is
 *  a setting a press can turn back on (U18), and so is the Remote hold: `idle`
 *  and `stale` warn only with it off (`REMOTE_HOLD_OFF`), since with it on
 *  they are a check not yet caught up with Remote turning on. The others have
 *  no press. */
const AWAKE_WARNINGS: Partial<Record<AwakeReason, RemoteStateView['warnings'][number]>> = {
  off: {
    text: 'Keep-awake is off, so this machine may sleep and miss messages.',
    fix: 'keepAwake'
  },
  battery: { text: 'On battery, this machine is not being kept awake. Plug it in.' },
  unsupported: {
    text: 'This machine cannot be kept awake from here, and may sleep while you are away.'
  }
};

export function remoteStateView(view: RemoteView, setup: MessengerSetup): RemoteStateView {
  const on = link.isOn(view.state);
  const words = linkWords(view.state);
  const tone = view.refused && !on ? 'fault' : words.tone;
  const missing = [
    ...view.setup.fields.filter((field) => !field.set).map((field) => field.label),
    ...missingAccount(view, setup)
  ];
  return {
    on,
    onSomewhere: link.onSomewhere(view.state),
    tone,
    status: words.status,
    ...(words.reason === undefined ? {} : { reason: words.reason }),
    ...(view.refused ? { refused: view.refused.reason } : {}),
    ...(view.state.kind === 'elsewhere' && view.state.holder.folder !== undefined
      ? { holderPath: view.state.holder.folder }
      : {}),
    warnings: on ? warnings(view) : [],
    ...(view.state.kind === 'connected' ? { hint: LID_HINT } : {}),
    missing,
    messengers: messengerRows(view, messengerState(tone, words.status, missing)),
    check: checkView(view.check, setup),
    setup: setupView(view, setup)
  };
}

type LinkWords = {
  tone: RemoteStateView['tone'];
  status: string;
  reason?: string;
};

/** A save of the allowed accounts that failed, as the sheet says it.
 *  The host's reason follows, since it names what to fix: a settings file
 *  with errors in it, say. None when it could not be redacted. */
export function allowlistNotSaved(detail: string | undefined): string {
  return detail === undefined
    ? 'The allowed accounts were not saved.'
    : `The allowed accounts were not saved: ${detail}`;
}

/** Nothing when an account is usable; else the space when an account waits
 *  on it, since that is the fix, else an account. */
function missingAccount(view: RemoteView, setup: MessengerSetup): string[] {
  if (link.usableAccounts(view.setup) > 0) return [];
  const space = setup.sender.space;
  return [space && waitsOnSpace(view.setup.unusable ?? []) ? space.label : NO_ACCOUNT];
}

/** Why one listed account cannot be used, as its row says it. A check
 *  fills an unset space and never replaces a set one it refuses. */
function accountProblem(problem: AccountProblem, view: RemoteView, setup: MessengerSetup): string {
  if (problem.kind === 'refused') return problem.reason;
  const label = setup.sender.space?.label ?? 'space';
  return view.setup.space?.refused === undefined
    ? `Waiting on the ${label}: press Check, or set it.`
    : `Waiting on the ${label}, which cannot be used: change it.`;
}

/** The space row: the messenger's words, what is set, and what the last ok
 *  check found when that differs from what is set. */
function spaceView(view: RemoteView, setup: MessengerSetup): RemoteSetupView['space'] {
  const words = setup.sender.space;
  if (!words) return undefined;
  const { value, refused } = view.setup.space ?? {};
  const result = view.check?.kind === 'result' ? view.check.result : undefined;
  const found = result?.kind === 'ok' ? result.space : undefined;
  return {
    label: words.label,
    help: words.help,
    ...(words.placeholder === undefined ? {} : { placeholder: words.placeholder }),
    ...(value === undefined ? {} : { value }),
    ...(refused === undefined ? {} : { problem: refused }),
    ...(found !== undefined && value !== undefined && found !== value ? { found } : {})
  };
}

/** The accounts the messenger refused of one edit, as the sheet says them:
 *  each reason names what one looks like. */
export function accountsNotAdded(refused: readonly { account: string; reason: string }[]): string {
  return refused.map(({ account, reason }) => `${account} was not added. ${reason}`).join(' ');
}

function linkWords(state: RemoteLink): LinkWords {
  switch (state.kind) {
    case 'off':
      return {
        tone: 'off',
        status: 'Off',
        ...(state.reason ? { reason: state.reason } : {})
      };
    case 'elsewhere':
      return {
        tone: 'elsewhere',
        status: state.holder.label
          ? `On in another window: ${state.holder.label}`
          : 'On in another window'
      };
    case 'connecting':
      return { tone: 'pending', status: 'Connecting…' };
    case 'connected':
      return { tone: 'live', status: 'Connected' };
    case 'reconnecting':
      return { tone: 'pending', status: 'Reconnecting', reason: state.reason };
    // `retry` is not drawn: a failed link's remedy is setup (M1 E).
    case 'failed':
      return { tone: 'fault', status: 'Not connected', reason: state.reason };
  }
}

const REMOTE_HOLD_OFF: RemoteStateView['warnings'][number] = {
  text: 'Keep-awake does not hold for Remote, so this machine may sleep and miss messages.',
  fix: 'awakeRemote'
};

function warnings(view: RemoteView): RemoteStateView['warnings'] {
  const awake = awakeWarning(view);
  const linked = view.state.kind === 'connected' ? view.state.warning : undefined;
  return [...(awake ? [awake] : []), ...(linked ? [{ text: linked }] : [])];
}

function awakeWarning(view: RemoteView): RemoteStateView['warnings'][number] | undefined {
  if (view.awake === undefined) return undefined;
  if ((view.awake === 'idle' || view.awake === 'stale') && view.awakeRemote === false) {
    return REMOTE_HOLD_OFF;
  }
  return AWAKE_WARNINGS[view.awake];
}

/** The selected row's word. Missing setup outranks only a quiet Off: a
 *  refusal, a live link or another window's hold is the news. */
function messengerState(
  tone: RemoteStateView['tone'],
  status: string,
  missing: readonly string[]
): RemoteMessengerState {
  if (tone !== 'off' || missing.length === 0) return { tone, text: status };
  return { tone: 'unset', text: 'Not configured', tip: `Needs ${missing.join(', ')}` };
}

/** The registry's listed messengers, and the selected one even when it is
 *  unlisted, so its setup never draws under another's row; then the ones not
 *  built yet. */
function messengerRows(
  view: RemoteView,
  state: RemoteMessengerState
): RemoteStateView['messengers'] {
  const current = view.setup.messenger;
  const listed = port.messengers().filter((entry) => entry.listed);
  const rows = listed.map(({ id, label }) => ({ id, label, live: true }));
  const live = rows.some((row) => row.id === current.id)
    ? rows
    : [...rows, { id: current.id, label: current.label, live: true }];
  return {
    rows: [...live, ...NOT_BUILT.filter((row) => !port.messenger(row.id))],
    selected: current.id,
    state
  };
}

/** The check's own result in words, with
 *  one mark per setup step: a failed step after done ones and before steps
 *  still to do; every step done on an ok; none blamed when the messenger
 *  could not be asked. */
function checkView(check: CheckState | undefined, setup: MessengerSetup): RemoteCheckView {
  const steps = setup.create?.steps ?? [];
  const every = (mark: RemoteCheckView['marks'][number]) => steps.map(() => mark);
  const found = check ?? { kind: 'never' };
  switch (found.kind) {
    case 'never':
      return { verdict: 'never', text: 'Not checked', marks: every('todo'), facts: [] };
    case 'checking':
      return { verdict: 'checking', text: 'Checking…', marks: every('todo'), facts: [] };
    case 'result':
      return {
        ...checkedView(found.result, steps.length),
        at: found.at
      };
  }
}

function checkedView(result: port.SetupCheck, steps: number): RemoteCheckView {
  const marks = (mark: (index: number) => RemoteCheckView['marks'][number]) =>
    Array.from({ length: steps }, (_, index) => mark(index));
  switch (result.kind) {
    case 'ok':
      return {
        verdict: 'ok',
        text: 'Configured',
        marks: marks(() => 'done'),
        facts: result.facts.map(({ label, value }) => ({ label, value }))
      };
    case 'setup':
      return {
        verdict: 'setup',
        text: result.reason,
        marks: marks((index) =>
          index < result.step ? 'done' : index === result.step ? 'failed' : 'todo'
        ),
        facts: []
      };
    case 'unreachable':
      return { verdict: 'unreachable', text: result.reason, marks: marks(() => 'todo'), facts: [] };
  }
}

function setupView(view: RemoteView, setup: MessengerSetup): RemoteSetupView {
  const create = setup.create;
  const space = spaceView(view, setup);
  return {
    messenger: view.setup.messenger.label,
    fields: view.setup.fields.map(({ key, label, set }) => {
      const help = setup.fields.find((field) => field.key === key)?.help;
      return { key, label, set, ...(help === undefined ? {} : { help }) };
    }),
    allowlist: [...view.setup.allowlist],
    ...(view.setup.unusable?.length
      ? {
          unusable: view.setup.unusable.map(({ account, problem }) => ({
            account,
            reason: accountProblem(problem, view, setup)
          }))
        }
      : {}),
    sender: {
      help: setup.sender.help,
      ...(setup.sender.placeholder === undefined ? {} : { placeholder: setup.sender.placeholder })
    },
    ...(space === undefined ? {} : { space }),
    ...(create
      ? {
          create: {
            steps: create.steps.map(({ title, text }) => ({ title, text })),
            ...(create.existing
              ? { existing: create.existing.map(({ label, value }) => ({ label, value })) }
              : {}),
            ...(create.copy ? { copyLabel: create.copy.label } : {}),
            link: create.link !== undefined
          }
        }
      : {})
  };
}
