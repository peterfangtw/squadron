/**
 * Remote's setup, drawn in the sheet's right column: the tokens, and the
 * accounts allowed to drive this machine. `remote_sheet.ts` places them under
 * the setup check.
 *
 * Paint only, and no credential is ever in this document. A token is typed
 * into the host's own password box (`setRemoteField`), so the column reads only
 * whether each token is set. Every word here is the messenger's own setup
 * data, arrived on `StateMessage.remote.setup`; nothing names a messenger.
 *
 * The column is morphed on every push, so every node is keyed and every
 * handler reads the row, the field and the list when pressed: a kept node
 * keeps the handler of the paint that made it.
 */

import { icon } from '../ui/icons';
import * as dom from './dom';
import * as state from './state';
import { why } from './tip';

/** An id typed and not yet added. Kept here rather than in the field, so a
 *  repaint that rebuilds the field does not empty it. */
let draftId = '';
/** Remove tokens is asking on its row. */
let confirming = false;
/**
 * The lists this column posted that no push has echoed yet, oldest first.
 * Each edit is the whole list, so one composed on the pushed list before the
 * host's echo would undo the edit still in flight: remove A, then B, would
 * post `[A]` and allow A again. The newest is what the next edit composes on.
 */
let sent: string[][] = [];
/** The list the previous push carried, joined. */
let lastPushed: string | undefined;
/** Why the host could not save the last edit, drawn until the next one. */
let failed: string | undefined;

/**
 * Settle the edits in flight against a push that changed the list. One equal
 * to a list this column sent is that edit's echo: it and every older one have
 * landed, and any newer stay in flight. One equal to none is a write
 * elsewhere, and an edit composed on the stale list would restore what that
 * write removed, so all of them go. Run on every push: the host's echo can
 * land with the sheet shut, and a push that repeats the list says nothing.
 */
export function settleAllowlist(): void {
  const now = pushed().join('\n');
  if (now !== lastPushed) {
    const echoed = sent.findIndex((ids) => ids.join('\n') === now);
    sent = echoed === -1 ? [] : sent.slice(echoed + 1);
  }
  lastPushed = now;
}

/** The host could not save the edit in flight: the pushed list is what
 *  stands, so the next edit composes on it, and the reason is drawn. An
 *  account the messenger refused goes back in the field to correct, unless
 *  the reader has typed there since. */
export function allowlistFailed(reason: string, account?: string): void {
  sent = [];
  failed = reason;
  if (account !== undefined && draftId === '') draftId = account;
}

/** One block of the right column: a caps head with an optional count and
 *  explanation, then its rows. `name` is its class and its key. */
export function section(name: string, title: string, summary?: string, tip?: string): HTMLElement {
  const sect = dom.el('div', `sect ${name}`);
  sect.dataset.key = `remote:${name}`;
  const head = dom.el('div', 'column-head');
  head.dataset.key = `remote:${name}:head`;
  const lead = dom.el('span', 'lead');
  lead.append(dom.el('h3', 'column-title', title));
  if (tip !== undefined) lead.append(keyed(why(tip), `remote:${name}:why`));
  head.append(lead);
  if (summary !== undefined) head.append(dom.el('span', 'summary', summary));
  sect.append(head);
  return sect;
}

export function tokens(setup: RemoteSetupView): HTMLElement {
  const set = setup.fields.filter((field) => field.set).length;
  const sect = section(
    'tokens',
    'Tokens',
    `${set} of ${setup.fields.length} set`,
    'Kept in the OS keychain, never in settings files. Paste… opens the host’s own password box, so no token is typed into the panel.'
  );
  for (const field of setup.fields) {
    const row = keyed(dom.el('div', 'field remote-field'), `remote:field:${field.key}`);
    const value = dom.el('span', field.set ? 'v set' : 'v', field.set ? 'Set' : 'Not set');
    const ask = button(field.set ? 'Replace…' : 'Paste…', `remote:field:${field.key}:ask`);
    ask.setAttribute('aria-label', `${field.set ? 'Replace' : 'Paste'} ${field.label}`);
    ask.onclick = () => state.vscode.postMessage({ type: 'setRemoteField', key: field.key });
    const name = dom.el('span', 'k', field.label);
    if (field.help !== undefined)
      name.append(keyed(why(field.help), `remote:field:${field.key}:why`));
    row.append(name, value, acts(ask));
    sect.append(row);
  }
  if (set > 0) sect.append(forgetRow());
  return sect;
}

/** Asks on its own row, in the shape of the workflow list's delete. A press
 *  repaints only this row, found from the button pressed: a push repaints the
 *  column, not a press. */
function forgetRow(): HTMLElement {
  const row = keyed(dom.el('div', 'field remote-forget'), 'remote:forget');
  row.append(...forgetControls());
  return row;
}

function forgetControls(): HTMLElement[] {
  if (!confirming) {
    const remove = button('Remove tokens', 'remote:forget:ask');
    remove.onclick = () => {
      confirming = true;
      const row = repaintForget(remove);
      row?.querySelector<HTMLElement>('.danger')?.focus();
    };
    return [remove];
  }
  const yes = button('Remove', 'remote:forget:yes');
  yes.classList.add('danger');
  yes.onclick = () => {
    confirming = false;
    state.vscode.postMessage({ type: 'forgetRemote' });
    repaintForget(yes);
  };
  const no = button('Cancel', 'remote:forget:no');
  no.onclick = () => {
    confirming = false;
    repaintForget(no)?.querySelector<HTMLElement>('button')?.focus();
  };
  const ask = keyed(dom.el('span', 'ask', 'Remove every token?'), 'remote:forget:q');
  return [ask, yes, no];
}

function repaintForget(pressed: HTMLElement): HTMLElement | null {
  const row = pressed.closest<HTMLElement>('.remote-forget');
  row?.replaceChildren(...forgetControls());
  return row;
}

export function allowed(setup: RemoteSetupView): HTMLElement {
  const sect = section(
    'allowed',
    'Allowed accounts',
    String(setup.allowlist.length),
    // A wrong id admits nobody, silently (D9), so the rule rides with the help.
    `${setup.sender.help} Messages from anyone else are ignored, with no reply.`
  );
  if (setup.space) sect.append(...spaceRows(setup.space));
  for (const id of setup.allowlist) {
    const unusable = setup.unusable?.find((each) => each.account === id);
    const row = keyed(dom.el('div', 'field remote-id'), `remote:id:${id}`);
    row.classList.toggle('bad', unusable !== undefined);
    const remove = button('', `remote:id:${id}:x`, 'remote-x');
    remove.innerHTML = icon('x', 13);
    remove.setAttribute('aria-label', `Remove ${id}`);
    remove.dataset.tip = 'Remove';
    remove.onclick = () => post(listed().filter((each) => each !== id));
    row.append(dom.el('span', 'k', id), dom.el('span'), remove);
    sect.append(row);
    if (unusable) sect.append(problem(unusable.reason, `remote:id:${id}:problem`));
  }

  const add = keyed(dom.el('div', 'remote-allow'), 'remote:allow');
  const field = keyed(document.createElement('input'), 'remote:allow:field');
  // Never a password field: what is typed here is an id, and no secret is
  // ever typed into this document.
  field.type = 'text';
  field.value = draftId;
  field.spellcheck = false;
  field.autocomplete = 'off';
  field.setAttribute('aria-label', 'Account to allow');
  if (setup.sender.placeholder) field.placeholder = setup.sender.placeholder;
  field.oninput = (event) => {
    draftId = (event.currentTarget as HTMLInputElement).value;
  };
  field.onkeydown = (event) => {
    if (event.key !== 'Enter' || dom.imeKey(event)) return;
    event.preventDefault();
    addFrom(event.currentTarget as HTMLElement);
  };
  const press = button('Add', 'remote:allow:add');
  press.onclick = (event) => addFrom(event.currentTarget as HTMLElement);
  add.append(field, press);
  sect.append(add);
  if (failed !== undefined) sect.append(failure(failed));
  return sect;
}

/** Desired state: the whole list as it should be after this add. The field is
 *  the one beside the control pressed, read now. */
function addFrom(control: HTMLElement): void {
  const field = control.closest('.remote-allow')?.querySelector('input');
  if (!field) return;
  const id = field.value.trim();
  const ids = listed();
  if (!id || ids.includes(id)) return;
  post([...ids, id]);
  draftId = '';
  field.value = '';
}

/** What the next edit composes on: the newest edit in flight, else the pushed
 *  list. Read when pressed. */
function listed(): string[] {
  return sent.at(-1) ?? pushed();
}

function pushed(): string[] {
  return state.ui.state.remote?.setup.allowlist ?? [];
}

/**
 * The messenger's space, which every account above composes with: a row
 * reading its value or Not set, with Set… or Change… asking the host's own
 * box; why a stored one cannot be used; and a different one the last check
 * found, with Use.
 */
function spaceRows(space: NonNullable<RemoteSetupView['space']>): HTMLElement[] {
  const row = keyed(dom.el('div', 'field remote-space'), 'remote:space');
  const name = dom.el('span', 'k', space.label);
  name.append(keyed(why(space.help), 'remote:space:why'));
  const value = dom.el('span', space.value ? 'v set' : 'v', space.value ?? 'Not set');
  const ask = button(space.value ? 'Change…' : 'Set…', 'remote:space:ask');
  ask.setAttribute('aria-label', `${space.value ? 'Change' : 'Set'} ${space.label}`);
  ask.onclick = () => state.vscode.postMessage({ type: 'setRemoteSpace' });
  row.append(name, value, acts(ask));
  const rows = [row];
  if (space.problem !== undefined) rows.push(problem(space.problem, 'remote:space:problem'));
  if (space.found !== undefined) rows.push(foundRow(space.found));
  return rows;
}

function foundRow(found: string): HTMLElement {
  const row = keyed(dom.el('div', 'remote-found'), 'remote:space:found');
  const use = button('Use', 'remote:space:use');
  use.setAttribute('aria-label', `Use ${found}`);
  use.onclick = () => state.vscode.postMessage({ type: 'setRemoteSpace', value: found });
  row.append(dom.el('span', 'txt', `The tokens are for ${found}.`), use);
  return row;
}

function problem(reason: string, key: string): HTMLElement {
  return keyed(dom.el('p', 'remote-problem', reason), key);
}

function failure(reason: string): HTMLElement {
  const line = keyed(dom.el('p', 'remote-failed', reason), 'remote:failed');
  line.setAttribute('role', 'alert');
  return line;
}

function post(ids: string[]): void {
  sent.push(ids);
  failed = undefined;
  document.querySelector('#bottomdrawer .remote-failed')?.remove();
  state.vscode.postMessage({ type: 'setRemoteAllowlist', ids });
}

function acts(...buttons: HTMLElement[]): HTMLElement {
  const box = dom.el('span', 'acts');
  box.append(...buttons);
  return box;
}

function button(text: string, key: string, cls = 'fbtn'): HTMLButtonElement {
  const b = keyed(dom.el('button', cls, text) as HTMLButtonElement, key);
  b.type = 'button';
  return b;
}

function keyed<T extends HTMLElement>(node: T, key: string): T {
  node.dataset.key = key;
  return node;
}
