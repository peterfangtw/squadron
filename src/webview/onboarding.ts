/**
 * First-launch onboarding: which CLIs this machine has, then three slides.
 * Design, states and the switch/checkbox rule: docs/mockups/onboarding.html.
 *
 * The host decides whether to open (`state.onboarding`); this module owns the
 * step. The setup rows are re-read off `ui.state.accounts` on every push, so a
 * CLI installed while the dialog is up flips its row and frees Continue.
 */

import { accountRow, authSheetOpen, startLogin } from './accounts';
import { orchestratorsRow } from './board_settings';
import { $, el } from './dom';
import { ui, vscode } from './state';

const dialog = $('onboarding') as HTMLDialogElement;

const SLIDES: readonly {
  title: string;
  img?: string;
  lead: string;
  hint?: string;
  settings?: () => HTMLElement[];
}[] = [
  {
    title: 'Every session, at a glance',
    img: 'board.png',
    lead:
      'Start Claude Code, Codex and Grok sessions from here and keep them in one place. See ' +
      'which are working and which are waiting on you, then open one to read it or reply.',
    hint: 'Only sessions this window starts show up here — not ones you start in a terminal.'
  },
  {
    title: 'Agents that work together',
    img: 'collab.png',
    lead:
      'A session can start other sessions, send them messages and wait for their answers, ' +
      'even on a different CLI. Ask Claude to have Codex build a feature and Grok review it.',
    settings: () => [orchestratorsRow('switch'), ...skillRow()]
  },
  {
    title: 'Your Linear backlog',
    img: 'tickets.png',
    lead:
      'Open Tickets to browse your Linear backlog by status. Filter by assignee, status or ' +
      'priority while keeping your conversation open.',
    hint: 'Click a ticket identifier to open it in Linear.'
  }
];

/** 0 is setup; 1..3 are the slides. */
let step = 0;
/** The acknowledgement box, for the showing it was ticked in. */
let acked = false;
/** This panel means the dialog to be up — the host asked, or the gear did. */
let wanted = false;
/** Finished here; the host's flag catches up on the next push. */
let doneHere = false;
/** What the dialog last painted, so a push that changed nothing repaints
 *  nothing — every 3s rebuild would take the focus and the hover with it. */
let painted = '';

// Escape taken on the keydown, not left to the native `cancel` that is its
// default action: a cancel comes after dispatch, by which time the window's
// interrupt (composer.ts) has heard a key nobody consumed. Preventing the
// keydown also suppresses that cancel; the listener below keeps any other
// close request.
dialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  dismiss();
});
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  dismiss();
});

function dismiss(): void {
  if (step === 0 && gated()) return;
  finish();
}

/** From the gear: open at setup, whatever the host's flag says. */
export function openOnboarding(): void {
  wanted = true;
  step = 0;
  acked = false;
  renderOnboarding();
}

export function renderOnboarding(): void {
  if (ui.state.onboarding && !doneHere) wanted = true;
  // The login sheet lives under #board and this is a modal in the top layer:
  // held shut while it is up, the next push after it closes brings it back.
  if (!wanted || authSheetOpen()) return;
  if (!dialog.open) {
    painted = '';
    dialog.showModal();
  }
  paint();
}

/** Nothing installed: setup waits for the box, and Escape does nothing. */
function gated(): boolean {
  return !(ui.state.accounts ?? []).some(
    (a) => a.state === 'signed_in' || a.state === 'signed_out'
  );
}

function finish(): void {
  wanted = false;
  doneHere = true;
  dialog.close();
  vscode.postMessage({ type: 'onboardingDone' });
}

function go(to: number): void {
  step = to;
  paint();
}

function paint(): void {
  const key = JSON.stringify([
    step,
    acked,
    ui.state.accounts,
    ui.state.orchestrators,
    ui.state.skillInstall
  ]);
  if (key === painted) return;
  painted = key;
  const focused = document.activeElement?.id;
  dialog.replaceChildren(...(step === 0 ? setup() : slide(step - 1)));
  if (focused) document.getElementById(focused)?.focus();
}

function head(title: string, label: string): HTMLElement {
  const h = el('div', 'ashead');
  h.append(el('b', null, title), el('span', 'obstep', label));
  return h;
}

function setup(): HTMLElement[] {
  const body = el('div', 'asbody');
  const lead = el('p', 'alead');
  lead.append(
    'Squadron runs the coding CLIs already on this machine and never installs one for you. ' +
      'It needs ',
    el('b', null, 'at least one'),
    ', installed and signed in.'
  );
  const list = el('div', 'oblist');
  for (const acct of ui.state.accounts ?? []) {
    list.append(accountRow(acct, { login: stepAside }));
  }
  const hint = el('p', 'ashint');
  hint.append(
    'Installed but listed as not installed? An editor opened from the Dock doesn’t see your ' +
      'shell’s PATH — use ',
    el('b', null, 'Set path'),
    '.'
  );
  body.append(lead, list, hint);

  const proceed = el('button', 'b pri', 'Continue') as HTMLButtonElement;
  proceed.id = 'onboarding-continue';
  if (gated()) {
    const box = el('input', 'check') as HTMLInputElement;
    box.type = 'checkbox';
    box.id = 'onboarding-ack';
    box.checked = acked;
    box.onchange = () => {
      acked = box.checked;
      proceed.disabled = !acked;
    };
    const label = el('label', 'setup-check');
    label.append(box, el('span', null, 'I understand that a CLI is needed to start sessions.'));
    body.append(label);
    proceed.disabled = !acked;
  }
  proceed.onclick = () => go(1);

  const recheck = el('button', 'b sec obleft', 'Check again');
  recheck.id = 'onboarding-recheck';
  recheck.onclick = () => vscode.postMessage({ type: 'recheckClis' });
  const foot = el('div', 'asfoot');
  foot.append(recheck, proceed);
  return [head('Welcome to Squadron', 'Setup'), body, foot];
}

function slide(i: number): HTMLElement[] {
  const s = SLIDES[i];
  if (!s) return [];
  const out = [head(s.title, `${i + 1} of ${SLIDES.length}`)];
  const media = document.body.dataset.media;
  if (media && s.img) {
    const shot = el('figure', 'obshot');
    const img = el('img') as HTMLImageElement;
    img.src = `${media}/${s.img}`;
    img.alt = '';
    shot.append(img);
    out.push(shot);
  }
  const body = el('div', 'asbody');
  body.append(el('p', 'alead', s.lead));
  if (s.hint) body.append(el('p', 'ashint', s.hint));
  if (s.settings) {
    const list = el('div', 'oblist');
    list.append(...s.settings());
    body.append(list);
  }
  out.push(body);

  const dots = el('span', 'obdots obleft');
  for (let j = 0; j < SLIDES.length; j++) dots.append(el('i', j === i ? 'on' : null));
  const foot = el('div', 'asfoot');
  foot.append(dots);
  const last = i === SLIDES.length - 1;
  if (!last) {
    const skip = el('button', 'b', 'Skip');
    skip.id = 'onboarding-skip';
    skip.onclick = finish;
    foot.append(skip);
  }
  const back = el('button', 'b sec', 'Back');
  back.id = 'onboarding-back';
  back.onclick = () => go(step - 1);
  const next = el('button', 'b pri', last ? 'Done' : 'Next');
  next.id = 'onboarding-next';
  next.onclick = last ? finish : () => go(step + 1);
  foot.append(back, next);
  out.push(foot);
  return out;
}

const SKILL_STATE: Record<SkillInstallView['state'], string> = {
  installed: 'installed',
  missing: 'not installed',
  foreign: 'Squadron leaves this path alone'
};

/** Whether each CLI has the skill, as a row under the switch that installs it:
 *  turning it on writes the skill for every CLI with a directory, and so does
 *  turning it on again — which is what a CLI installed since the window opened
 *  needs. */
function skillRow(): HTMLElement[] {
  const rows = ui.state.skillInstall ?? [];
  if (rows.length === 0) return [];
  const foreign = rows.filter((r) => r.state === 'foreign').map((r) => r.name);
  const detail = rows.some((r) => r.state === 'missing')
    ? ui.state.orchestrators
      ? 'Switch Orchestration off and on to install it.'
      : 'Turning Orchestration on installs it.'
    : foreign.length
      ? `Squadron leaves the path for ${foreign.join(' and ')} alone.`
      : 'Tells a session it can do this.';
  const text = el('span', 'txt');
  text.append(el('span', 't', 'Squadron skill'), el('span', 'd', detail));
  const marks = el('span', 'skmarks');
  for (const r of rows) {
    const mark = el('span', `sk ${r.state}`, r.name);
    // No `data-tip`: `tip.ts` draws in <body>, under this modal's top layer.
    // The glyph and the `.d` line carry the state; this names it for a reader.
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', `${r.name}: ${SKILL_STATE[r.state]}`);
    marks.append(mark);
  }
  const row = el('div', 'mrow obskill');
  row.id = 'onboarding-skill';
  row.append(text, marks);
  return [row];
}

/** Sign in from a setup row: the login sheet cannot be seen through a modal. */
function stepAside(acct: AccountView): void {
  dialog.close();
  startLogin(acct);
}
