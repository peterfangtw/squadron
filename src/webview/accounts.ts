/**
 * Accounts surfaces: nav usage control → popover, login sheet, sign-out
 * confirm, and the dock login CTA. Design: mockups/auth-signin-signout.html for
 * the flow and the sheets; mockups/accounts-plan-and-reset.html for the row's
 * identity and window lines, which it supersedes — and which carries the two
 * directions not taken.
 *
 * All three brands are live, and every one of them lands the reader in a
 * browser — which side opens it is `CliAdapter.loginOpensBrowser`, and no
 * concern of this file. `coming_soon` stays a row state for whatever brand
 * boards next.
 */

import { ago, el, noLimitLabel, pctRank, until } from './dom';
import * as localPath from '../ui/local_path';
import { closeMenu, opensMenu } from './kit';
import { repaintMcpFooter } from './mcp_sheet';
import { closeSheet, openSheet } from './sheet';
import { ui, vscode } from './state';
import { sessionBrand } from '../core/brands';
import { isMidTurn } from '../core/model';
import { usageSlots } from '../ui/usage_chip';

/** `el('button')` returns HTMLElement; buttons need the real element type. */
export const btn = (cls: string | null, text?: string): HTMLButtonElement => {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  b.type = 'button';
  if (text !== undefined) b.textContent = text;
  return b;
};

/** Login sheet state driven by host `loginProgress` messages. */
let login: {
  brand: BrandId;
  name: string;
  mark: string;
  phase: LoginPhase;
  url?: string;
  userCode?: string;
  code?: string;
  message?: string;
} | null = null;

let afterAuth: (() => void) | undefined;

export function onAuthClosed(callback: () => void): void {
  afterAuth = callback;
}

/** Sign-out sheet open for this row. Confirm is local; waiting/error follow `confirmSignOut`. */
let signOut: {
  brand: BrandId;
  name: string;
  mark: string;
  label?: string;
  phase: 'confirm' | 'waiting' | 'error';
  message?: string;
} | null = null;

/**
 * Brand marks from `media/` (inlined — CSP has no img host for extension
 * media). Claude: fixed orange both themes. Grok: dual fills (white on dark UI,
 * #0A0A0A on light) toggled by CSS. Codex: currentColor → `--av-fg`.
 *
 * **Every path below is a copy of a file in `media/`**, which is the design
 * source `docs/mockups/auth-signin-signout.html` cites by name and the only
 * reason those files exist — nothing reads them at runtime, and
 * `package.json`'s `files` leaves them out of the VSIX. Re-copy from there
 * rather than editing a `d=` here, or the two drift and the mock stops
 * describing what ships.
 */
const CLAUDE_MARK = `<svg class="bm cl" viewBox="0 0 100 100" aria-hidden="true"><path fill="hsl(14.8, 63.1%, 59.6%)" d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"/></svg>`;

/** Paths from media/logo_grok_{light,dark}.svg (file name = mark colour). */
const GROK_P1 =
  'M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916';
const GROK_P2 =
  'M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339';
const GROK_MARK =
  `<svg class="bm gr" viewBox="0 0 1024 1024" aria-hidden="true">` +
  `<g class="on-dark"><path fill="#fff" d="${GROK_P1}"/><path fill="#fff" d="${GROK_P2}"/></g>` +
  `<g class="on-light"><path fill="#0A0A0A" d="${GROK_P1}"/><path fill="#0A0A0A" d="${GROK_P2}"/></g>` +
  `</svg>`;

/** media/logo_codex.svg — theme via currentColor. */
const CODEX_MARK = `<svg class="bm cx" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>`;

const MARKS: Record<string, string> = {
  claude: CLAUDE_MARK,
  grok: GROK_MARK,
  codex: CODEX_MARK
};

export const brandMark = (mark: string, muted = false): HTMLElement => {
  const wrap = el('span', muted ? 'bmwrap muted' : 'bmwrap');
  const svg = MARKS[mark];
  if (svg) wrap.innerHTML = svg;
  return wrap;
};

/** Log in only when no live brand is signed in. A coming-soon row is ignored. */
export function anySignedOut(): boolean {
  const live = (ui.state.accounts ?? []).filter((a) => a.state !== 'coming_soon');
  return live.length > 0 && !live.some((a) => a.state === 'signed_in');
}

/** Pointer is on the chip: a turn-end must not swap the digits under it. */
export let usageHover = false;

export let usageFlipping = false;

/** Out + delay + in, matching `lim-flip-*` in `css/nav.ts`. */
const USAGE_FLIP_MS = 340;

/** jsdom ships no `matchMedia`, so this is a feature test, not only a preference. */
const wantsUsageFlip = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: no-preference)').matches;

/** Clone the live chip face. Morph rewrites the button's children in place. */
export function snapshotUsageFace(root: ParentNode): HTMLElement | null {
  if (usageFlipping) return null;
  const lim = root.querySelector<HTMLElement>('.lim:not(.login)');
  if (!lim?.querySelector('.bmwrap')) return null;
  const face = el('span', 'limface');
  for (const n of Array.from(lim.childNodes)) face.append(n.cloneNode(true));
  return face;
}

/** False while a flip is mid-air: morph would replace the two faces with one. */
export function keepUsageFlip(from: HTMLElement): boolean {
  return !(usageFlipping && from.classList.contains('limwrap'));
}

/** Same direction every time, so a brand swap reads as a deck rather than a toggle. */
export function flipUsageChip(
  root: ParentNode,
  fromBrand: string | undefined,
  toBrand: string | undefined,
  outgoing: HTMLElement | null
): void {
  if (!outgoing || !fromBrand || !toBrand || fromBrand === toBrand) return;
  if (usageFlipping || !wantsUsageFlip()) return;
  const lim = root.querySelector<HTMLElement>('.lim:not(.login)');
  if (!lim?.querySelector('.bmwrap')) return;

  const incoming = el('span', 'limface in');
  incoming.append(...Array.from(lim.childNodes));
  outgoing.className = 'limface out';
  outgoing.setAttribute('aria-hidden', 'true');

  const stage = el('span', 'limstage');
  stage.append(outgoing, incoming);
  lim.append(stage);

  const fromW = outgoing.offsetWidth;
  const toW = incoming.offsetWidth;
  if (fromW && toW && fromW !== toW) {
    stage.style.width = `${fromW}px`;
    void stage.offsetWidth;
    stage.style.width = `${toW}px`;
  }

  usageFlipping = true;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    usageFlipping = false;
    if (!stage.isConnected) return;
    lim.replaceChildren(...Array.from(incoming.childNodes));
  };
  incoming.addEventListener('animationend', finish, { once: true });
  window.setTimeout(finish, USAGE_FLIP_MS + 80);
}

/**
 * Digits + `none`/`-` from `windows`, for the nav chip. The first slot sits in
 * `.w5` for the 600px cut; the popover spends the height to give each window a
 * line of its own instead, so this has one caller and no longer asks.
 *
 * `waiting` keeps every label and puts a placeholder in each figure's slot: the
 * windows are known and their readings are still being fetched.
 */
export function appendUsageSlots(
  host: HTMLElement,
  usage: UsageView | undefined,
  waiting = false
): void {
  const slots = usageSlots(usage);
  slots.forEach((slot, i) => {
    // Three states, stated by the record: a figure, `-` for a window with no
    // reading yet, `none` for one this brand does not have.
    const text =
      slot.pct === null ? 'none' : slot.pct === undefined ? '-' : Math.round(slot.pct) + '%';
    const rank = typeof slot.pct === 'number' ? pctRank(slot.pct) : '';
    const box = i === 0 ? el('span', 'w5') : host;
    const figure = waiting ? el('span', 'v') : el('span', ('v ' + rank).trim(), text);
    if (waiting) figure.append(el('span', 'bone'));
    box.append(el('span', 'k', slot.short + ' '), figure);
    // Never a trailing separator. The wrapped first slot used to take one
    // unconditionally, which was invisible while every brand had two windows and
    // leaves a bare dot the moment one states a single window.
    const last = i === slots.length - 1;
    if (i === 0) {
      if (!last) box.append(el('span', 'sep', ' · '));
      host.append(box);
    } else if (!last) {
      host.append(el('span', 'sep', ' · '));
    }
  });
}

/** This brand's row is signed out — the dock CTA, so a Grok card does not
 *  offer Claude login. */
export function signedOutFor(brand: string | undefined): boolean {
  return (
    !!brand &&
    (ui.state.accounts?.some((a) => a.brand === brand && a.state === 'signed_out') ?? false)
  );
}

export function takeLoginProgress(msg: LoginProgressMessage): void {
  login = {
    brand: msg.brand,
    name: login?.name ?? '',
    mark: login?.mark ?? '',
    // Absent means no change — `LoginProgressMessage.phase` says which pushes
    // carry none. The third term is a type obligation, not a designed state:
    // this function rebuilds `login` from null rather than returning, so the
    // field has to resolve even when there is no sheet behind the push.
    phase: msg.phase ?? login?.phase ?? 'starting',
    url: msg.url ?? login?.url,
    userCode: msg.userCode ?? login?.userCode,
    code: msg.brand === login?.brand ? login.code : undefined,
    message: msg.message
  };
  if (msg.phase === 'done') {
    login = null;
    hideAuthScrim();
    return;
  }
  paintLoginSheet();
}

export function takeSignOutResult(msg: SignOutResultMessage): void {
  if (!signOut || signOut.brand !== msg.brand) return;
  if (msg.phase === 'done') {
    hideAuthScrim();
    return;
  }
  signOut = { ...signOut, phase: 'error', message: msg.message };
  paintSignOutSheet();
}

/** Open login — from nav, menu, or chat CTA. */
export function startLogin(acct: AccountView): void {
  closeMenu();
  signOut = null;
  login = { brand: acct.brand, name: acct.name, mark: acct.mark, phase: 'starting' };
  paintLoginSheet();
  vscode.postMessage({ type: 'startLogin', brand: acct.brand });
}

export function askSignOut(acct: AccountView): void {
  closeMenu();
  if (login) vscode.postMessage({ type: 'cancelLogin' });
  login = null;
  signOut = {
    brand: acct.brand,
    name: acct.name,
    mark: acct.mark,
    label: acct.label,
    phase: 'confirm'
  };
  paintSignOutSheet();
}

/** A login or sign-out sheet is up over the board. */
export const authSheetOpen = (): boolean => login !== null || signOut !== null;

function hideAuthScrim(): void {
  login = null;
  signOut = null;
  closeSheet('ascrim');
  const callback = afterAuth;
  afterAuth = undefined;
  callback?.();
}

function sheetShell(
  title: string,
  mark: HTMLElement | null,
  locked = false
): { body: HTMLElement; foot: HTMLElement } {
  return openSheet({
    id: 'ascrim',
    position: 'board',
    title,
    ...(mark ? { mark } : {}),
    locked,
    onClose() {
      if (login) vscode.postMessage({ type: 'cancelLogin' });
      hideAuthScrim();
    }
  });
}

function paintLoginSheet(): void {
  if (!login) return;
  // Both halves arrive empty — sheetShell built them a line ago.
  const { body, foot } = sheetShell(
    `Sign in to ${login.name}`,
    brandMark(login.mark),
    login.phase !== 'error'
  );

  const phase = login.phase;
  const step = (n: string, label: string, state: 'done' | 'now' | ''): HTMLElement => {
    const row = el('div', ('astep ' + state).trim());
    row.append(el('div', 'k', n), el('div', 'ad', label));
    return row;
  };

  if (login.userCode) {
    body.append(step('✓', 'Open this to sign in', login.url ? 'done' : 'now'));
    if (login.url) {
      const url = el('div', 'aurl');
      url.append(el('span', null, login.url));
      const copy = btn('b sec', 'Copy');
      copy.onclick = () => {
        if (!login?.url) return;
        void navigator.clipboard?.writeText(login.url);
      };
      url.append(copy);
      body.append(url);
    }
    body.append(step(phase === 'waiting' ? '…' : '2', 'Confirm this code in the browser', 'now'));
    // Copyable for the same reason the URL above is: the reader is carrying it
    // into a browser field, and a code read off a panel and typed by hand is
    // the one step of this flow that can silently go wrong.
    const code = el('div', 'ucode');
    code.append(el('span', null, login.userCode));
    const copyCode = btn('b sec', 'Copy');
    copyCode.onclick = () => {
      if (!login?.userCode) return;
      void navigator.clipboard?.writeText(login.userCode);
    };
    code.append(copyCode);
    body.append(code);
    if (login.message && phase === 'error') {
      body.append(el('div', 'aerr', login.message));
    }
    const cancel = btn('b sec', 'Cancel');
    cancel.onclick = () => {
      vscode.postMessage({ type: 'cancelLogin' });
      hideAuthScrim();
    };
    const open = btn('b sec', 'Open browser');
    open.onclick = () => {
      if (!login?.url) return;
      vscode.postMessage({ type: 'openLoginUrl', url: login.url });
    };
    foot.append(cancel, open);
    return;
  }

  if (phase === 'starting') {
    body.append(step('1', 'Starting sign-in…', 'now'));
  } else if (phase === 'error' && !login.url) {
    // Spawn never reached a URL (missing binary). Not a paste.
    if (login.message) body.append(el('div', 'aerr', login.message));
    const cancel = btn('b sec', 'Cancel');
    cancel.onclick = () => {
      vscode.postMessage({ type: 'cancelLogin' });
      hideAuthScrim();
    };
    foot.append(cancel);
    return;
  } else {
    // Nothing opens a tab from in here. Either the host opened one or the CLI
    // did (`CliAdapter.loginOpensBrowser`); the link and Open browser below are
    // the reader's second chance at it.
    body.append(step('✓', 'Sign in in the browser, then copy the code', 'done'));
  }

  if (login.url) {
    const url = el('div', 'aurl');
    url.append(el('span', null, login.url));
    const copy = btn('b sec', 'Copy');
    copy.onclick = () => {
      if (!login?.url) return;
      void navigator.clipboard?.writeText(login.url);
    };
    url.append(copy);
    body.append(url);
  }

  if (phase === 'paste' || phase === 'waiting' || phase === 'error' || phase === 'browser') {
    body.append(
      step(
        phase === 'waiting' ? '…' : '2',
        phase === 'waiting' ? 'Checking the code…' : 'Paste the code here',
        'now'
      )
    );
    const input = document.createElement('input');
    input.className = 'acode';
    input.type = phase === 'waiting' ? 'text' : 'password';
    input.setAttribute('aria-label', 'Authorization code');
    input.placeholder = 'Paste authorization code';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const draft = login.code ?? '';
    if (phase === 'waiting') {
      input.disabled = true;
      input.value =
        draft.length > 12
          ? draft.slice(0, 4) + '••••••••' + draft.slice(-4)
          : '•'.repeat(draft.length);
    } else {
      input.value = draft;
      input.addEventListener('input', () => {
        if (login) login.code = input.value;
      });
    }
    body.append(input);

    if (login.message && phase === 'error') {
      body.append(el('div', 'aerr', login.message));
    }

    const cancel = btn('b sec', 'Cancel');
    cancel.onclick = () => {
      vscode.postMessage({ type: 'cancelLogin' });
      hideAuthScrim();
    };
    // Host openExternal only — never restart the login child (that re-opened a
    // second browser). The CLI has already opened once; this is the IDE path.
    const open = btn('b sec', 'Open browser');
    open.onclick = () => {
      if (!login?.url) return;
      vscode.postMessage({ type: 'openLoginUrl', url: login.url });
    };
    const submit = btn('b pri', phase === 'waiting' ? 'Checking…' : 'Submit');
    submit.disabled = phase === 'waiting';
    submit.onclick = () => {
      const code = input.value.trim();
      if (!login || login.phase === 'waiting' || !code) return;
      login.code = code;
      login.phase = 'waiting';
      paintLoginSheet();
      vscode.postMessage({ type: 'submitLoginCode', code });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit.click();
    });
    foot.append(cancel, open, submit);
    if (phase !== 'waiting') queueMicrotask(() => input.focus());
  } else {
    const cancel = btn('b sec', 'Cancel');
    cancel.onclick = () => {
      vscode.postMessage({ type: 'cancelLogin' });
      hideAuthScrim();
    };
    foot.append(cancel);
  }
}

function paintSignOutSheet(): void {
  if (!signOut) return;
  const leaving = signOut;
  const title =
    leaving.phase === 'waiting'
      ? `Signing out of ${leaving.name}…`
      : leaving.phase === 'error'
        ? `Sign out of ${leaving.name} failed`
        : `Sign out of ${leaving.name}?`;
  const { body, foot } = sheetShell(title, null, leaving.phase === 'waiting');
  if (leaving.phase === 'waiting') {
    const row = el('div', 'astep now');
    row.append(el('div', 'k', '…'), el('div', 'ad', 'Signing out…'));
    body.append(row);
    return;
  }
  if (leaving.phase === 'error') {
    body.append(el('div', 'aerr', leaving.message || 'Sign-out did not finish.'));
    const close = btn('b sec', 'Close');
    close.onclick = () => hideAuthScrim();
    foot.append(close);
    return;
  }

  const who = leaving.label ?? 'this account';
  const sessions = ui.state.groups
    .flatMap((g) => g.sessions)
    .filter((s) => sessionBrand(s.brand) === leaving.brand);
  const n = sessions.length;

  const lead = el('div', 'alead');
  lead.append(
    el('b', null, who),
    document.createTextNode(
      `. Credentials are shared by everything on this machine — these ${n} session${n === 1 ? '' : 's'} keep running and fail on their next request:`
    )
  );
  body.append(lead);

  const blast = el('div', 'ablast');
  const show = sessions.slice(0, 2);
  for (const s of show) {
    const row = el('div');
    row.append(brandMark(leaving.mark));
    const leaf = localPath.pathLeaf(s.fullCwd);
    row.append(document.createTextNode(' ' + (s.name || leaf)));
    if (isMidTurn(s.status)) row.append(el('span', 'atag', 'mid-turn'));
    blast.append(row);
  }
  if (n > 2) {
    blast.append(el('div', 'amore', `+ ${n - 2} more`));
  }
  if (n === 0) {
    blast.append(el('div', 'amore', 'No sessions running right now.'));
  }
  body.append(blast);
  body.append(el('div', 'akeep', 'Other accounts on this machine are unaffected.'));

  const cancel = btn('b sec', 'Cancel');
  cancel.onclick = () => hideAuthScrim();
  const go = btn('b dgr', `Sign out of ${leaving.name}`);
  go.onclick = () => {
    signOut = { ...leaving, phase: 'waiting' };
    vscode.postMessage({ type: 'confirmSignOut', brand: leaving.brand });
    paintSignOutSheet();
  };
  foot.append(cancel, go);
}

/**
 * Fill the accounts flyout body. Called from opensMenu's paint callback.
 */
export function paintAccountsMenu(m: HTMLElement): void {
  m.classList.add('smenu', 'accts');
  m.append(el('div', 'mhead', 'Accounts'));
  const accounts = ui.state.accounts ?? [];
  for (const acct of accounts) {
    m.append(accountRow(acct));
  }
  // Through the same guarded path as every later push, so the signature is
  // recorded here. Filling directly would leave `paintIfChanged` with nothing
  // to compare against, and the first state push after opening would replace a
  // footer that had not changed.
  repaintMcpFooter(m);
}

/**
 * One account, as the popover draws it. `setup` is onboarding's: a signed-in
 * row says Ready rather than offering Sign out, and Sign in goes through the
 * caller, which has a modal to take down before the login sheet can be seen.
 */
export function accountRow(
  acct: AccountView,
  setup?: { login: (acct: AccountView) => void },
  beforeAuth?: () => void
): HTMLElement {
  const row = el('div', 'acct');
  const muted = acct.state !== 'signed_in';
  row.append(brandMark(acct.mark, muted));
  const id = el('div', 'id');
  const em = el('div', muted ? 'em muted' : 'em');
  // The chip is the label's sibling rather than its tail, so the ellipsis has
  // only the label to take. Why that is the shape: `css/nav.ts`, `.acct .em`.
  em.append(el('span', 't', acct.label ?? acct.name));
  if (acct.plan) em.append(el('span', 'plan', acct.plan));
  id.append(em);

  // The age joins the detail line, where the rest of this row's provenance
  // already is, and leaves the figures below it to say only what they read.
  const at = acct.state === 'signed_in' ? acct.usage?.at : undefined;
  const age = at === undefined ? '' : ' · updated ' + ago(Date.now() - at) + ' ago';
  id.append(el('div', 'pl', acct.detail + age));
  row.append(id);

  if (acct.state === 'signed_in' && acct.usage && !setup) {
    for (const slot of usageSlots(acct.usage)) row.append(windowRow(slot));
  }

  if (acct.state === 'signed_in' && setup) {
    row.append(el('span', 'act ready', 'Ready'));
  } else if (acct.state === 'signed_in') {
    const act = btn('act out', 'Sign out');
    act.onclick = (e) => {
      e.stopPropagation();
      beforeAuth?.();
      askSignOut(acct);
    };
    row.append(act);
  } else if (acct.state === 'signed_out') {
    const act = btn('act in', 'Sign in');
    act.onclick = (e) => {
      e.stopPropagation();
      beforeAuth?.();
      (setup?.login ?? startLogin)(acct);
    };
    row.append(act);
  } else if (acct.state === 'coming_soon') {
    row.append(el('span', 'act soon', 'Soon'));
  } else if (acct.state === 'not_installed') {
    const install = btn('act in install', 'Install');
    install.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'installCli', brand: acct.brand });
    };
    const setPath = btn('act path', 'Set path');
    setPath.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'setCliPath', brand: acct.brand });
    };
    const acts = el('span', 'acts');
    acts.append(install, setPath);
    row.append(acts);
  }

  return row;
}

/**
 * One window's line: short name, a track, the figure, and when it turns over.
 *
 * The three states are the record's, not ours. A figure draws a track; `null`
 * says this brand has no such window, in the nav tip's own words, and draws
 * none — an empty track reads as 0%, which means untouched, the opposite of
 * what `null` says; `undefined` is a window with no reading yet and has no
 * width to draw either.
 *
 * The reset is the tip's rule and not the figure's: `core/usage.ts` retires a
 * figure the moment a later period is declared, so a window straight out of a
 * rollover has a reset time and no number — and that is the reading this line
 * exists to show. Only `null` has nothing to reset, a reset on a window the
 * brand does not have being a limit by implication. `resetsAt` rides `until()`,
 * the formatter the tip prints, so the two cannot drift.
 *
 * `resets 2h 14m` and not `resets in 2h 14m`, which is what the tip's heading
 * says: measured, the longer phrase does not fit beside a track at any width
 * this popover can spend. The verb stays either way — a bare `2h 14m left`
 * sitting after a percentage reads as quota remaining, which is its opposite.
 */
function windowRow(slot: UsageWindow): HTMLElement {
  const line = el('div', 'win');
  // Spaces in the text rather than only in the grid gaps, the rule
  // `appendUsageSlots` already keeps: a copy of this row is read as a sentence
  // by whatever it is pasted into, and gaps leave `5h10%resets 2h 14m` behind.
  // Both collapse to nothing where they land, at the edge of a cell.
  line.append(el('span', 'ws', slot.short + ' '));
  if (typeof slot.pct === 'number') {
    const rank = pctRank(slot.pct);
    const track = el('span', 'wb');
    const fill = el('i', rank);
    fill.style.width = Math.min(100, slot.pct) + '%';
    track.append(fill);
    line.append(track, el('span', ('wv ' + rank).trim(), Math.round(slot.pct) + '%'));
  } else {
    line.append(el('span', 'wv bare', slot.pct === null ? noLimitLabel(slot.short) : '-'));
  }
  if (slot.pct !== null && slot.resetsAt !== undefined) {
    line.append(el('span', 'wl', ' resets ' + until(slot.resetsAt)));
  }
  return line;
}

/**
 * Wire the lim control as a button that opens the accounts popover.
 * `fill` paints the usage digits when signed in (caller builds children).
 *
 * Signed-out still opens the **same** Accounts menu — not the login sheet.
 * Sheet opens from Sign in only.
 *
 * **Primitive:** `opensMenu` in `kit.ts` (`wireMenu` → `anchorMenu`). Do not
 * hand-roll a second flyout. Align `end` so the menu’s right edge sits on the
 * lim control (`right: 0` on the wrap — see `anchorMenu`). Repo-wide placement
 * policy (fixed default, board clamp) is taskhub **H58**.
 *
 * When `accounts` is absent, caller keeps the passive span — this is only used
 * once the host has pushed an accounts list.
 */
export function accountsControl(fill: (btn: HTMLElement) => void): HTMLElement {
  const wrap = el('span', 'fwrap limwrap');
  wrap.dataset.key = 'usage';
  wrap.addEventListener('pointerenter', () => {
    usageHover = true;
  });
  wrap.addEventListener('pointerleave', () => {
    usageHover = false;
  });
  const signedOut = anySignedOut();
  const control = btn(signedOut ? 'lim login' : 'lim');
  control.setAttribute('aria-label', signedOut ? 'Log in' : 'Accounts');
  if (signedOut) {
    control.textContent = 'Log in';
  } else {
    fill(control);
  }
  // `end`: hang under lim (CSS right:0 via anchorMenu). Not fixed — nav does
  // not scroll, and absolute under .fwrap is the gear’s path too.
  // fill re-reads accounts on each open, so one morph key works for both states.
  const menu = opensMenu(wrap, control, 'end', (m) => paintAccountsMenu(m));
  wrap.append(control, menu);
  return wrap;
}

/**
 * The dock's signed-out CTA: Log in opens the same sheet as the nav. Drawn only
 * for a session this window drives — the caller decides, and `chat.ts` says why.
 */
export function pipeLoginCta(brand?: string): HTMLElement {
  const acct = ui.state.accounts?.find(
    (a) => a.state === 'signed_out' && (brand === undefined || a.brand === brand)
  );
  const box = el('div', 'login-cta');
  if (!acct) return box;
  box.append(brandMark(acct.mark));
  const t = el('div', 't');
  t.append(el('b', null, `Not signed in to ${acct.name}`));
  t.append(el('span', null, 'Sign in once — credentials are machine-wide and fix every session.'));
  box.append(t);
  const go = btn('b pri', 'Log in');
  go.onclick = () => startLogin(acct);
  box.append(go);
  return box;
}
