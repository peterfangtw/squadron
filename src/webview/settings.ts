import * as accounts from './accounts';
import * as controls from './board_settings';
import * as dom from './dom';
import * as kit from './kit';
import * as onboarding from './onboarding';
import * as state from './state';
import * as icons from '../ui/icons';
import * as changelog from '../ui/changelog';
import releaseText from '../../CHANGELOG.md';

const dialog = dom.$('settings') as HTMLDialogElement;
const categories = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'accounts', label: 'Accounts', icon: 'terminal' },
  { id: 'model', label: 'Model', icon: 'cpu' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'report', label: 'Report', icon: 'flag' },
  { id: 'changelog', label: 'Changelog', icon: 'notes' },
  { id: 'about', label: 'About', icon: 'info' }
] as const;
export type Category = (typeof categories)[number]['id'];
let selected: Category = 'general';
let wanted = false;
const surveyClickedKey = 'squadron.surveyClicked';
let surveyClicked = false;

function surveyPending(): boolean {
  if (surveyClicked) return false;
  try {
    return localStorage.getItem(surveyClickedKey) !== 'true';
  } catch {
    return true;
  }
}

export function control(): HTMLElement {
  const gear = dom.el('button', 'gear');
  gear.classList.toggle('survey-pending', surveyPending());
  gear.innerHTML = ICONS.settings;
  gear.dataset.tip = 'Squadron settings';
  gear.setAttribute('aria-label', 'Squadron settings');
  gear.setAttribute('aria-haspopup', 'dialog');
  gear.onclick = open;
  return gear;
}

function open(): void {
  kit.closeMenu();
  wanted = true;
  mount();
  render();
  if (!dialog.open) dialog.showModal();
}

function close(): void {
  wanted = false;
  kit.closeMenu();
  dialog.close();
  document.querySelector<HTMLElement>('#nav .gear')?.focus();
}

document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape' || !dialog.open || dom.imeKey(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (kit.heldOpen(dialog)) kit.onMenuKey(event);
    else close();
  },
  true
);
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  close();
});
dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
    close();
});

function mount(): void {
  const header = dom.el('header', 'ashead');
  const glyph = dom.el('span', 'settings-symbol');
  glyph.innerHTML = ICONS.settings;
  const title = dom.el('b', null, 'Settings');
  title.id = 'settings-title';
  const dismiss = dom.el('button', 'settings-close');
  dismiss.innerHTML = ICONS.x;
  dismiss.setAttribute('aria-label', 'Close settings');
  dismiss.onclick = close;
  header.append(glyph, title, dismiss);
  const layout = dom.el('div', 'settings-layout');
  const tabs = dom.el('nav', 'settings-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Settings categories');
  for (const [index, category] of categories.entries()) {
    const tab = dom.el('button', 'settings-tab');
    if (category.id === 'report') tab.classList.toggle('survey-pending', surveyPending());
    const mark = dom.el('span');
    mark.innerHTML = icons.icon(category.icon, 16);
    tab.append(mark, dom.el('span', null, category.label));
    tab.id = `settings-tab-${category.id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `settings-${category.id}`);
    tab.onclick = () => select(category.id);
    tab.onkeydown = (event) => {
      let next = index;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
        next = (index + 1) % categories.length;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
        next = (index + categories.length - 1) % categories.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = categories.length - 1;
      else return;
      event.preventDefault();
      const destination = categories[next];
      if (destination) select(destination.id, true);
    };
    tabs.append(tab);
    const page = dom.el('section', 'settings-page');
    page.id = `settings-${category.id}`;
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', tab.id);
    page.tabIndex = 0;
    layout.append(page);
  }
  layout.prepend(tabs);
  const footer = dom.el('footer', 'asfoot settings-foot');
  footer.append(dom.el('span', null, 'Changes apply immediately'));
  const version = document.body.dataset.version;
  if (version) footer.append(dom.el('span', null, `Squadron ${version}`));
  dialog.replaceChildren(header, layout, footer);
  select(selected);
  orientTabs();
}

function orientTabs(): void {
  dialog
    .querySelector('[role="tablist"]')
    ?.setAttribute('aria-orientation', window.innerWidth <= 580 ? 'horizontal' : 'vertical');
}
window.addEventListener('resize', orientTabs);

function select(category: Category, focus = false): void {
  kit.closeMenu();
  selected = category;
  for (const item of categories) {
    const on = item.id === category;
    const tab = dom.q(dialog, `#settings-tab-${item.id}`);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    dom.q(dialog, `#settings-${item.id}`).hidden = !on;
    if (on && focus) tab.focus();
  }
}

/** State pushes refresh values without replacing the modal's frame or selected tab. */
export function render(): void {
  if (!wanted || accounts.authSheetOpen()) return;
  const s = state.ui.state;
  const signatures: Record<Category, unknown> = {
    general: [s.soundLevel, s.devServers, s.mascot],
    accounts: s.accounts,
    model: [s.models, s.model, s.contextWindow, s.efforts],
    appearance: s.theme,
    report: surveyPending(),
    changelog: document.body.dataset.version,
    about: document.body.dataset.version
  };
  for (const category of categories) {
    const page = dom.q(dialog, `#settings-${category.id}`);
    if (kit.heldOpen(page)) continue;
    kit.paintIfChanged(page, JSON.stringify([state.ui.ready, signatures[category.id]]), () => {
      paintPage(page, category.id);
    });
  }
  if (!dialog.open) dialog.showModal();
}

/** Rebuilds a page, putting the focus back on the same control. A text field
 *  keeps what is typed in it and its caret too, or a push mid-typing would
 *  empty it. */
function paintPage(page: HTMLElement, category: Category): void {
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && page.contains(active);
  const key = focused ? controlKey(active) : undefined;
  const typed =
    focused && active instanceof HTMLInputElement
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : undefined;
  page.replaceChildren(...pageBody(category));
  if (!focused) return;
  const replacement =
    key === undefined
      ? undefined
      : [...page.querySelectorAll<HTMLElement>('button, summary, input')].find(
          (element) => controlKey(element) === key
        );
  (replacement ?? page).focus();
  if (typed && replacement instanceof HTMLInputElement) {
    replacement.value = typed.value;
    if (typed.start !== null && typed.end !== null)
      replacement.setSelectionRange(typed.start, typed.end);
  }
}

function controlKey(element: HTMLElement): string | undefined {
  if (element.dataset.focusKey) return element.dataset.focusKey;
  if (element.dataset.theme) return `theme:${element.dataset.theme}`;
  return element.matches('.mrow')
    ? (element.querySelector('.t')?.firstChild?.textContent ?? undefined)
    : undefined;
}

function lead(title: string, detail: string): HTMLElement[] {
  return [dom.el('h1', null, title), dom.el('p', 'settings-intro', detail)];
}

function pageBody(category: Category): HTMLElement[] {
  if (!state.ui.ready && !['report', 'changelog', 'about'].includes(category)) {
    return lead('Loading settings…', 'Your settings will appear when they are ready.');
  }
  switch (category) {
    case 'general':
      return [
        ...lead('General', 'Sound, the chips above each repo, and the chick on the board.'),
        ...controls.generalSettings()
      ];
    case 'accounts':
      return accountSettings();
    case 'model':
      return [
        ...lead('Model', 'Defaults for the sessions you open.'),
        dom.el('h2', null, 'Session defaults'),
        dom.el(
          'p',
          'settings-detail',
          'Choose a model and its starting effort. Sessions already running keep their current model.'
        ),
        controls.modelDefaults(),
        dom.el(
          'p',
          'settings-detail',
          'Each model remembers its own effort. It also applies when you resume a session on that model.'
        ),
        dom.el(
          'p',
          'settings-note',
          'These defaults apply to sessions you open here. A session started by another agent uses its own launch settings.'
        )
      ];
    case 'appearance':
      return [
        ...lead('Appearance', 'Follow your editor’s theme, or choose a Squadron preset.'),
        dom.el('h2', null, 'Theme'),
        dom.el('p', 'settings-detail', 'Kept for the folder this window opened.'),
        controls.themeSwatches()
      ];
    case 'report':
      return report();
    case 'changelog':
      return releaseNotes();
    case 'about':
      return about();
  }
}

function suspendForAuth(): void {
  kit.closeMenu();
  dialog.close();
  accounts.onAuthClosed(render);
}

function accountSettings(): HTMLElement[] {
  const head = lead('Accounts', 'Connect the agents you want to work with.');
  const note = dom.el('div', 'account-help');
  note.append(
    dom.el(
      'p',
      null,
      'Installed but not found? An editor opened from the Dock may not see your shell’s PATH. Use Set path to choose the executable.'
    )
  );
  const list = dom.el('div', 'settings-accounts');
  for (const account of state.ui.state.accounts ?? []) {
    const row = accounts.accountRow(account, undefined, suspendForAuth);
    for (const button of row.querySelectorAll<HTMLElement>('button')) {
      button.dataset.focusKey = `${account.brand}:${button.classList.contains('path') ? 'path' : 'account'}`;
    }
    const title = row.querySelector('.em .t');
    const detail = row.querySelector('.pl');
    if (title) title.textContent = account.name;
    if (detail)
      detail.textContent =
        account.state === 'signed_in' ? (account.label ?? account.detail) : account.detail;
    // A signed-in row already says so: its address and its Sign out.
    if (account.state !== 'signed_in') {
      const status = dom.el(
        'span',
        `account-state ${account.state}`,
        {
          signed_out: 'Not signed in',
          not_installed: 'Not installed',
          coming_soon: 'Coming soon'
        }[account.state]
      );
      row.querySelector('.id')?.append(status);
    }
    // One column beside the identity rather than lines under it, so every
    // account fits one page of the modal.
    const usage = dom.el('div', 'account-usage');
    usage.append(...row.querySelectorAll('.win'));
    row.querySelector('.id')?.after(usage);
    list.append(row);
  }
  if (!list.childElementCount)
    list.append(dom.el('p', 'settings-detail', 'Account status is not available yet.'));
  return [...head, note, list];
}

function report(): HTMLElement[] {
  const actions = dom.el('div', 'settings-report');
  for (const [label, page] of [
    ['Survey', 'survey'],
    ['Bugs', 'issue'],
    ['Request', 'issue']
  ] as const) {
    const button = dom.el('button', 'b sec', label) as HTMLButtonElement;
    if (page === 'survey') button.classList.toggle('survey-pending', surveyPending());
    button.onclick = () => {
      if (page === 'survey') {
        surveyClicked = true;
        try {
          localStorage.setItem(surveyClickedKey, 'true');
        } catch {
          // Storage can be disabled; still dismiss the nudge for this document.
        }
        for (const indicator of document.querySelectorAll(
          '#nav .gear.survey-pending, #settings .survey-pending'
        ))
          indicator.classList.remove('survey-pending');
      }
      state.vscode.postMessage({ type: 'openExtensionPage', page });
    };
    actions.append(button);
  }
  return [...lead('Report', 'Feedback, a bug, or something you want.'), actions];
}

function about(): HTMLElement[] {
  const nodes = [dom.el('h1', null, 'About Squadron')];
  const version = document.body.dataset.version;
  if (version) nodes.push(dom.el('p', 'settings-intro', `Version ${version}`));
  const links = dom.el('div', 'settings-links');
  for (const [page, label] of [
    ['marketplace', 'VS Code Marketplace'],
    ['openvsx', 'Open VSX']
  ] as const) {
    const link = dom.el('button', 'settings-link');
    link.dataset.page = page;
    link.append(dom.el('span', null, label));
    const mark = dom.el('span');
    mark.innerHTML = icons.icon('external', 14);
    link.append(mark);
    link.onclick = () => state.vscode.postMessage({ type: 'openExtensionPage', page });
    links.append(link);
  }
  const tour = dom.el('div', 'settings-tour');
  const show = dom.el('button', 'b sec', 'Show onboarding');
  show.onclick = () => {
    close();
    onboarding.openOnboarding();
  };
  tour.append(show, dom.el('p', 'settings-detail', 'Review setup and the quick tour.'));
  return [...nodes, links, tour];
}

function releaseNotes(): HTMLElement[] {
  const nodes = lead('Changelog', 'What changed in Squadron.');
  const version = document.body.dataset.version ?? '';
  const releases = changelog.releases(releaseText, version);
  for (const [index, release] of releases.entries()) {
    const details = document.createElement('details');
    details.className = 'release';
    details.open = index === 0;
    const summary = document.createElement('summary');
    summary.append(dom.el('span', null, release.version));
    if (release.version === version)
      summary.append(dom.el('span', 'current-release', 'Current version'));
    const body = dom.el('div', 'release-notes');
    appendReleaseText(body, release.body);
    details.append(summary, body);
    nodes.push(details);
  }
  if (!releases.length)
    nodes.push(dom.el('p', 'settings-detail', 'No release notes are available for this version.'));
  return nodes;
}

function appendReleaseText(body: HTMLElement, text: string): void {
  for (const block of text.split(/\n\s*\n/)) {
    if (block.startsWith('- ')) {
      const list = dom.el('ul');
      for (const item of block.split(/^[-] /m).filter(Boolean)) {
        list.append(dom.el('li', null, item.replace(/\s*\n\s*/g, ' ').trim()));
      }
      body.append(list);
    } else body.append(dom.el('p', null, block.replace(/\s*\n\s*/g, ' ')));
  }
}
