/**
 * Remote on the bottom drawer: the bar word's dot and tip, and the two
 * columns behind it. The left leads with this window's switch, then the
 * messengers; reason, refusal, warnings and hint stay pinned under the list.
 * The right is the selected messenger's setup — the check, the tokens, the
 * allowed accounts, and an empty Interactions slot. The guide opens over the
 * board in a centred sheet (`sheet.ts`).
 *
 * Paint only. Every word, the tone, what is missing and the check's verdict
 * arrive decided on `StateMessage.remote` (`ui/remote_view.ts`). The frame's
 * open and close stay in `bottom_drawer.ts`.
 */

import { $, ago, el, q } from './dom';
import * as holds from './holds';
import { morph, switchRow } from './kit';
import { messengerMark } from './messenger_marks';
import * as remoteSetup from './remote_setup';
import * as sheet from './sheet';
import { ui, vscode } from './state';
import { tipRows, why, type TipRow } from './tip';
import * as bottomDrawer from './bottom_drawer';
import * as sheetParts from './sheet_parts';
import type { HubWord } from './bottom_drawer_modes';

/** Said wherever Remote would be, in a host that sends none. */
const UNAVAILABLE = 'Remote is not available in this window.';
/** The left column's switch. The messenger it runs through is the list under it. */
const SWITCH_LABEL = 'Enable Remote';
const GUIDE = 'gscrim';

/** This window's switch, flipped and not yet echoed. Kept until a push
 *  agrees. A `remoteChoice` that did not land drops the flip it names. */
const switchHold = holds.add<'switch', boolean>(() => ui.state.remote?.on);
/** Check pressed and no state push since. The host answers with `checking`
 *  on its next push, so until then the press is held dead here; a reply that
 *  is not a push (`remoteChoice`, a failed allowlist save) says nothing about
 *  the check and leaves it held. */
let checkPosted = false;
/** The messenger the open guide was opened for; undefined while it is shut.
 *  Its Copy and Open act on whichever messenger the host has chosen when
 *  pressed, so a push that selects another shuts it. */
let guideFor: string | undefined;

export function repaintRemote(active: boolean, pushed: boolean): void {
  if (pushed) {
    checkPosted = false;
    remoteSetup.settleAllowlist();
  }
  if (active) paintRemoteSheet();
  if (guideFor !== undefined && guideFor !== ui.state.remote?.messengers.selected) {
    sheet.closeSheet(GUIDE);
    guideClosed();
  }
}

/** The host's answer to `setRemote`. Order against the state push does not
 *  matter: either way the flip stands until a push shows the same. */
export function settleRemote(msg: { on: boolean; landed: boolean }): void {
  if (!msg.landed) switchHold.drop('switch', msg.on);
  bottomDrawer.repaintMode('remote');
}

export function remoteBar(): HubWord {
  const remote = ui.state.remote;
  return {
    ...(remote && remote.tone !== 'off' ? { tone: remote.tone } : {}),
    tip: remote ? tip(remote) : UNAVAILABLE
  };
}

function tip(remote: RemoteStateView): string {
  return remote.holderPath ? `${remote.status}, at ${remote.holderPath}` : remote.status;
}

export function paintRemoteSheet(): void {
  const list = q($('bottomdrawer-body'), '.bdlist');
  const detail = q($('bottomdrawer-body'), '.bddetail');
  const remote = ui.state.remote;
  if (!remote) {
    const none = el('div', 'fnone', UNAVAILABLE);
    none.dataset.key = 'remote:none';
    morph(list, [none]);
    morph(detail, []);
    return;
  }
  const messengers = el('div', 'messengers');
  messengers.dataset.key = 'remote:messengers';
  messengers.append(...remote.messengers.rows.map((row) => messengerRow(row, remote)));
  const column = [
    remoteSwitch(remote),
    sheetParts.columnHead('remote:messengers-title', 'Messengers'),
    messengers
  ];
  const notes = switchNotes(remote);
  // An empty footer draws its rule, and a rule under nothing is a stray line.
  if (notes.length > 0) {
    const pinned = el('div', 'pinned');
    pinned.dataset.key = 'remote:pinned';
    pinned.append(...notes);
    column.push(pinned);
  }
  morph(list, column);
  morph(detail, [
    setupSection(remote),
    remoteSetup.tokens(remote.setup),
    remoteSetup.allowed(remote.setup),
    interactions()
  ]);
}

/**
 * One messenger. The selected one is drilled and carries the link's state, or
 * Not configured with what is missing in its tip;
 * the right column is its setup. A messenger not built yet refuses the press
 * and says why in its tip. Choosing between built ones is not offered here,
 * so another live row refuses as well.
 */
function messengerRow(row: RemoteMessengerRow, remote: RemoteStateView): HTMLElement {
  const selected = row.id === remote.messengers.selected;
  const node = el('button', selected ? 'mrow pick drilled' : 'mrow pick');
  node.dataset.key = `remote:messenger:${row.id}`;
  if (selected) node.setAttribute('aria-current', 'true');
  else node.setAttribute('aria-disabled', 'true');
  const said = selected ? remote.messengers.state.tip : row.tip;
  if (said) node.dataset.tip = said;
  const mark = messengerMark(row.id);
  if (mark) node.append(mark);
  const text = el('span', 'txt');
  text.append(el('span', 't', row.label));
  const value = el('span', 'val');
  const { state } = remote.messengers;
  if (selected) value.append(el('span', `mdot ${state.tone}`), state.text);
  else if (!row.live) value.append('Not yet');
  value.append(el('i', 'into'));
  node.append(text, value);
  return node;
}

/**
 * This window's switch, above the messengers, and only the switch: the link's
 * state and what setup lacks are the selected messenger's row. The handler
 * reads nothing from this paint: the row outlives it, and `switchRow` reads
 * the refusal off the row when pressed.
 *
 * Missing setup refuses the press, since this window already knows it cannot
 * work. Another window holding Remote does not: that can outlive a crashed
 * holder, and the press is what re-checks it (D37).
 */
function remoteSwitch(remote: RemoteStateView): HTMLElement {
  const missing = remote.missing.length > 0;
  const row = switchRow(
    SWITCH_LABEL,
    undefined,
    switchHold.shown('switch', remote.on),
    (on) => {
      switchHold.hold('switch', on);
      vscode.postMessage({ type: 'setRemote', on });
    },
    undefined,
    'switch'
  );
  if (missing) row.setAttribute('aria-disabled', 'true');
  row.dataset.key = 'remote:switch';
  return row;
}

/** Reason, refusal, warnings and hint: pinned under the list, and only when one is said. */
function switchNotes(remote: RemoteStateView): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (remote.reason) nodes.push(line('remote-reason', remote.reason));
  if (remote.refused) nodes.push(line('remote-refused', remote.refused));
  nodes.push(...remote.warnings.map(warning));
  if (remote.hint) nodes.push(line('remote-hint', remote.hint));
  return nodes;
}

/** One warning, with its press only where a press can be the fix (U18). */
function warning(w: RemoteStateView['warnings'][number], index: number): HTMLElement {
  const box = el('div', 'remote-warn');
  box.dataset.key = `remote:warn:${index}`;
  box.append(el('span', 'txt', w.text));
  if (w.fix) {
    const { label, key } = FIXES[w.fix];
    const fix = el('button', 'fbtn', label) as HTMLButtonElement;
    fix.type = 'button';
    fix.dataset.key = `remote:warn:${index}:fix`;
    fix.onclick = () => vscode.postMessage({ type: 'setFlag', key, on: true });
    box.append(fix);
  }
  return box;
}

/** What each warning's press turns on, named for the switch it flips. */
const FIXES: Record<
  NonNullable<RemoteStateView['warnings'][number]['fix']>,
  { label: string; key: FlagKey }
> = {
  keepAwake: { label: 'Keep awake', key: 'cafe' },
  awakeRemote: { label: 'Stay awake', key: 'cafeRemote' }
};

/**
 * The check: one verdict row, and under it the setup steps as a checklist,
 * each marked by what the check found. A passing check is the row alone, its
 * facts in a tip; a check in flight hides the steps until it answers.
 */
function setupSection(remote: RemoteStateView): HTMLElement {
  const { check, setup } = remote;
  const sect = remoteSetup.section(
    'setup',
    `${setup.messenger} setup`,
    undefined,
    `Check asks ${setup.messenger} with these tokens, the way Remote connects, without turning Remote on.`
  );
  sect.append(verdictRow(check, setup));
  const steps = setup.create?.steps ?? [];
  if (check.verdict !== 'ok' && check.verdict !== 'checking' && steps.length) {
    sect.append(checklist(steps, check.marks));
  }
  return sect;
}

const VERDICT_CLASS: Record<RemoteCheckView['verdict'], string> = {
  never: 'todo',
  checking: 'busy',
  ok: 'ok',
  setup: 'bad',
  unreachable: 'warn'
};
const VERDICT_GLYPH: Partial<Record<RemoteCheckView['verdict'], string>> = {
  ok: '✓ ',
  setup: '✕ '
};

function verdictRow(check: RemoteCheckView, setup: RemoteSetupView): HTMLElement {
  const row = el('div', `field verdict ${VERDICT_CLASS[check.verdict]}`);
  row.dataset.key = 'remote:verdict';
  const label = el('span', 'k', `${VERDICT_GLYPH[check.verdict] ?? ''}${check.text}`);
  const rows: TipRow[] = check.facts.map((fact) => [fact.label, fact.value, '']);
  // Aged at each paint, so the 3 s push keeps it current.
  if (check.at !== undefined) rows.push(['Checked', `${ago(Date.now() - check.at)} ago`, '']);
  if (check.verdict === 'ok' && rows.length) {
    const facts = why('What the check was told');
    facts.dataset.key = 'remote:verdict:facts';
    delete facts.dataset.tip;
    tipRows(facts, 'Last check', rows);
    label.append(facts);
  }
  const acts = el('span', 'acts');
  acts.append(checkButton(check));
  if (setup.create) acts.append(guideButton());
  row.append(label, el('span'), acts);
  return row;
}

/** Dead while a check is in flight, or pressed and not yet answered: the
 *  runner ignores a second start, and a live press that does nothing reads as
 *  broken. Read off the node when pressed, since the morph keeps it. */
function checkButton(check: RemoteCheckView): HTMLElement {
  const busy = checkPosted || check.verdict === 'checking';
  const text = busy ? 'Checking…' : check.verdict === 'never' ? 'Check' : 'Check again';
  const b = el('button', 'fbtn', text) as HTMLButtonElement;
  b.type = 'button';
  b.dataset.key = 'remote:check';
  if (busy) b.setAttribute('aria-disabled', 'true');
  b.onclick = (event) => {
    if ((event.currentTarget as HTMLElement).getAttribute('aria-disabled') === 'true') return;
    checkPosted = true;
    vscode.postMessage({ type: 'checkRemote' });
    paintRemoteSheet();
  };
  return b;
}

function guideButton(): HTMLElement {
  const b = el('button', 'fbtn', 'Guide') as HTMLButtonElement;
  b.type = 'button';
  b.dataset.key = 'remote:guide';
  b.setAttribute('aria-haspopup', 'dialog');
  b.onclick = openGuide;
  return b;
}

/** A step's mark is its number until the check says done or failed. The
 *  classes are this list's own: `.step` and `.done` are the composer's. */
function checklist(steps: { title: string; text: string }[], marks: string[]): HTMLElement {
  const list = el('div', 'checklist');
  list.dataset.key = 'remote:checklist';
  steps.forEach((step, index) => {
    const mark = marks[index] ?? 'todo';
    const state = mark === 'todo' ? '' : ` st-${mark}`;
    const row = el('div', `field gstep${state}`);
    row.dataset.key = `remote:step:${index}`;
    const label = el('span', 'k');
    const glyph = mark === 'done' ? '✓' : mark === 'failed' ? '✕' : String(index + 1);
    const info = why(step.text);
    info.dataset.key = `remote:step:${index}:why`;
    label.append(el('span', `mk${state}`, glyph), el('span', 'stepname', step.title), info);
    row.append(label);
    list.append(row);
  });
  return list;
}

/** Labelled and empty until there are switches to put in it. */
function interactions(): HTMLElement {
  const sect = remoteSetup.section('interactions', 'Interactions', 'later');
  const slot = el('div', 'slot', 'What Remote may do from your phone. Coming in a later version.');
  slot.dataset.key = 'remote:interactions:slot';
  sect.append(slot);
  return sect;
}

/**
 * The guide: every step's text, what an app made by hand must be set to, and
 * Copy and the create page in its foot, both host-side. It reads the setup
 * when opened and is not repainted: a push that keeps the messenger moves
 * nothing in it, and one that selects another shuts it (`repaintRemote`).
 */
function openGuide(): void {
  const remote = ui.state.remote;
  const made = remote?.setup.create;
  if (!remote || !made) return;
  const guide = sheet.openSheet({
    id: GUIDE,
    position: 'board',
    title: `Set up ${remote.setup.messenger}`,
    mark: messengerMark(remote.messengers.selected),
    wide: true,
    onClose: guideClosed
  });
  guideFor = remote.messengers.selected;

  const steps = el('ol');
  for (const step of made.steps) steps.append(el('li', null, step.text));
  guide.body.append(steps);
  if (made.existing?.length) {
    const rows = el('dl');
    for (const row of made.existing)
      rows.append(el('dt', null, row.label), el('dd', null, row.value));
    guide.body.append(el('div', 'ashint', 'Using an app you already have'), rows);
  }

  const group = el('span', 'grp');
  if (made.copyLabel) {
    const copy = footButton('b sec', made.copyLabel);
    // "Copied" stays until the guide shuts: the copy happened, and nothing
    // un-happens it.
    copy.onclick = () => {
      vscode.postMessage({ type: 'copyRemoteSetup' });
      copy.textContent = 'Copied';
    };
    group.append(copy);
  }
  if (made.link) {
    const link = footButton('b sec', 'Open the create page');
    link.onclick = () => vscode.postMessage({ type: 'openRemoteSetupLink' });
    group.append(link);
  }
  const done = footButton('b pri', 'Done');
  done.onclick = () => {
    guide.close();
    guideClosed();
  };
  guide.foot.append(group, done);
  done.focus();
}

/** Back on the button that opened it, found now: the column is morphed. A
 *  messenger with no guide has none, and the drawer's close takes it. */
function guideClosed(): void {
  guideFor = undefined;
  if (!bottomDrawer.isModeOpen('remote')) return;
  (
    document.querySelector<HTMLElement>('#bottomdrawer [data-key="remote:guide"]') ??
    $('bottomdrawer-close')
  ).focus();
}

function footButton(cls: string, text: string): HTMLButtonElement {
  const b = el('button', cls, text) as HTMLButtonElement;
  b.type = 'button';
  return b;
}

function line(cls: string, text: string): HTMLElement {
  const p = el('p', cls, text);
  p.dataset.key = `remote:${cls}`;
  return p;
}
