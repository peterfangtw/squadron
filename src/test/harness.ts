import { ticketSourceView } from './ticket_fixtures';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { JSDOM, DOMWindow } from 'jsdom';
import { warmConfig } from '../core/cache_ttl';
import { DEFAULT_WARM_POLICY } from '../core/warm_policy';
import { panelDocument } from '../ui/document';
import { resolve, type CardFacts } from '../ui/reading';
import { offersInterrupt } from '../ui/views';

/**
 * DOM test rig: the real panel document — `panelDocument()`'s markup, CSS and
 * inlined compiled webview script — running under jsdom. Tests drive it the
 * way `panel.ts` does, by posting `PanelMessage`s, and observe it the way the
 * host does, through the `WebviewMessage`s the script posts back.
 *
 * The `acquireVsCodeApi` stub must exist before parse: the script calls it
 * while being read, in `state.ts`, so it is injected in `beforeParse`, not
 * patched in.
 */

/**
 * The version the rig's document is stamped with. Not the real one: a scenario
 * asserting on `package.json`'s current value would go red on every bump.
 */
export const TEST_VERSION = '1999.1.0';

export interface Panel {
  window: DOMWindow;
  /**
   * Every message the webview script posted to the host **after it loaded**,
   * oldest first — so `posted[0]` is the first thing the scenario caused.
   *
   * What the bundle sends on load is `onLoad` instead, and the split is
   * deliberate: the handshake is not something a scenario did, and leaving it at
   * the head of this array would have made every existing `posted[0]` assertion
   * mean something new. See `ready` in `protocol.d.ts`.
   */
  posted: WebviewMessage[];
  /** What the script posted while the document was loading, before any scenario
   *  touched it. */
  onLoad: WebviewMessage[];
  /** Deliver a host -> webview message; handlers run synchronously. */
  push(msg: PanelMessage): void;
  /** What the script has stashed in `setState` — the panel's memory of itself. */
  saved(): PanelState | undefined;
}

/**
 * `saved` seeds what `getState()` returns before the script runs, which is the
 * only way to test what the panel restores rather than what it stores.
 */
export function openPanel(t: TestContext, saved?: PanelState): Panel {
  // `panelDocument()` swaps in a "run npm run compile" stub document when the
  // webview bundle is missing — absence-assertions would pass against it.
  const bundle = path.join(__dirname, '..', 'webview', 'main.js');
  assert.ok(fs.existsSync(bundle), 'webview bundle missing — run npm run compile');

  const posted: WebviewMessage[] = [];
  let state: PanelState | undefined = saved;
  let dispatch: (msg: PanelMessage) => void = () => {};
  const deliverCarried = (msg: StateMessage): void => {
    const thread = carriedThread.get(msg);
    if (!thread) return;
    const select = [...posted].reverse().find((row) => row.type === 'select');
    if (select?.type === 'select' && select.pid === thread.pid) {
      dispatch(orderedThread(posted, select.selection, thread));
      return;
    }
    pendingThread.set(posted, thread);
  };
  const dom = new JSDOM(panelDocument(TEST_VERSION), {
    url: 'https://squadron.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLDialogElement.prototype.showModal = function showModal(): void {
        this.setAttribute('open', '');
      };
      window.HTMLDialogElement.prototype.close = function close(): void {
        this.removeAttribute('open');
      };
      const api: WebviewApi = {
        // Cloned into this realm: the script builds messages against the
        // window's prototypes, and deepStrictEqual compares prototypes.
        postMessage: (message) => {
          posted.push(structuredClone(message));
          if (message.type !== 'select') return;
          const thread = pendingThread.get(posted);
          if (!thread || thread.pid !== message.pid) return;
          pendingThread.delete(posted);
          dispatch(orderedThread(posted, message.selection, thread));
        },
        getState: () => state,
        setState: (next) => {
          state = next;
        }
      };
      (window as unknown as { acquireVsCodeApi: () => WebviewApi }).acquireVsCodeApi = () => api;
      // jsdom has no layout, so it ships no `scrollIntoView` at all — not a
      // no-op, an absent property. Every keyboard-walked list in here keeps its
      // row in view with one, and unstubbed the call throws mid-paint and takes
      // the rest of the repaint with it. A no-op is what a browser would do for
      // a row already on screen, which is every row in a window with no size.
      window.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
      // Absent the same way on Range, and ProseMirror's `coordsAtPos` (the @
      // menu's caret line) calls both. A zero rect is what every element here
      // already reports; placement against a real caret is smoke's.
      window.Range.prototype.getClientRects = function getClientRects(): DOMRectList {
        return window.document.body.getClientRects();
      };
      window.Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
        return window.document.body.getBoundingClientRect();
      };
      // jsdom has no viewport. Real intersection delivery is covered in smoke.
      window.IntersectionObserver = class {
        observe(): void {}
        unobserve(): void {}
      };
      // jsdom paints nothing, and without the `canvas` package its
      // `getContext` returns null *and* prints "Not implemented" on every call.
      // The null is the contract the mascot degrades on; the print is noise.
      window.HTMLCanvasElement.prototype.getContext = function getContext(): null {
        return null;
      } as typeof window.HTMLCanvasElement.prototype.getContext;
      // jsdom ships no `CSS` namespace at all, so `CSS.escape` is a
      // ReferenceError rather than a missing method — the same shape as the
      // stub above, one level further out. `bottom_drawer.ts` calls it after a
      // keyboard move, and unstubbed it throws *after* the reorder has already
      // committed: jsdom logs the error and the test still passes. A thrown
      // error sitting inside a green run is what hides the next real one, and
      // this was the only one in the suite. The focus it guards survives either
      // way — `render` morphs keyed by id rather than replacing, so the
      // row node is relocated and keeps focus on its own. What reaches the
      // escape is a workflow id, validated elsewhere as a single path segment,
      // and backslash-prefixing everything outside an identifier is what the
      // real one does for those.
      (window as unknown as { CSS: { escape: (value: string) => string } }).CSS = {
        escape: (value) => value.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`)
      };
    }
  });

  t.after(() => dom.window.close());
  // The document has run by now — jsdom parses synchronously here — so anything
  // in `posted` is the bundle announcing itself rather than a scenario acting.
  const onLoad = posted.splice(0, posted.length);
  dispatch = (msg) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: msg }));
  return {
    window: dom.window,
    posted,
    onLoad,
    push: (msg) => {
      if (msg.type === 'thread' || msg.type === 'threadPatch')
        noteThreadSequence(posted, msg.selection, msg.sequence);
      dispatch(msg);
      if (msg.type === 'state') deliverCarried(msg);
    },
    saved: () => state
  };
}

/**
 * Assert required request correlation, then expose the feature payload a
 * scenario is about. Protocol-specific scenarios should inspect `posted`
 * directly when the actual identity value is their subject.
 */
export function assertedMessageBody(message: WebviewMessage | undefined): unknown {
  assert.ok(message, 'nothing was posted');
  const OPERATION =
    /^(send|files)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-\d+$/;
  if (message.type === 'select') {
    assert.match(message.selection, /^select-[0-9a-f-]{36}-\d+$/);
    const { selection: _selection, ...body } = message;
    return body;
  }
  if (message.type === 'send') {
    assert.equal(typeof message.startedAt, 'number');
    assert.match(message.operationId, OPERATION);
    const { startedAt: _startedAt, operationId: _operationId, ...body } = message;
    return body;
  }
  // No `startedAt`: a file pick is addressed by box rather than by session, so
  // the operation id is the whole of its correlation and a draft can post one.
  if (message.type === 'pickFiles') {
    assert.match(message.operationId, OPERATION);
    const { operationId: _operationId, ...body } = message;
    return body;
  }
  if (message.type === 'respond') {
    assert.equal(typeof message.startedAt, 'number');
    const { startedAt: _startedAt, ...body } = message;
    return body;
  }
  if (
    message.type === 'close' ||
    message.type === 'interrupt' ||
    message.type === 'dismissQueued' ||
    message.type === 'sendNow' ||
    message.type === 'rename' ||
    message.type === 'cancelWorkflow' ||
    message.type === 'retryWorkflow'
  ) {
    assert.equal(typeof message.startedAt, 'number');
    const { startedAt: _startedAt, ...body } = message;
    return body;
  }
  return message;
}

export function openSettings(p: Panel, category = 'General'): HTMLElement {
  const dialog = p.window.document.querySelector<HTMLDialogElement>('#settings');
  dialog?.querySelector<HTMLButtonElement>('.settings-close')?.click();
  const gear = p.window.document.querySelector<HTMLElement>('#nav-actions .gear');
  assert.ok(gear, 'no settings gear in the nav bar');
  gear.click();
  assert.ok(dialog?.open, 'the gear opened no settings dialog');
  [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')]
    .find((tab) => tab.textContent === category)
    ?.click();
  return dialog;
}

/** Raise the bottom drawer's Agents mode off its hub word, from shut or from
 *  another mode, and hand back the drawer. */
export function openAgents(p: Panel): HTMLElement {
  const doc = p.window.document;
  const drawer = doc.querySelector<HTMLElement>('#bottomdrawer');
  if (drawer && !drawer.hidden) doc.querySelector<HTMLElement>('#bottomdrawer-close')?.click();
  const word = doc.querySelector<HTMLElement>('#bottomhub .agents-tab');
  assert.ok(word, 'no Agents word on the bottom hub');
  word.click();
  assert.ok(drawer && !drawer.hidden, 'Agents opened no drawer');
  return drawer;
}

/** A switch row's label alone: `.t`'s first child rather than the whole of it,
 *  since a row may carry a `.tag` in there too ("beta") and `textContent` runs
 *  the two words together. */
export const switchLabel = (row: Element): string | null | undefined =>
  row.querySelector('.t')?.firstChild?.textContent;

export function switchRow(menu: HTMLElement, label: string): HTMLElement {
  const row = [...menu.querySelectorAll<HTMLElement>('.mrow')].find(
    (r) => switchLabel(r) === label
  );
  assert.ok(row, `no "${label}" switch in the settings menu`);
  const page = row.closest('[role="tabpanel"]');
  const tab = page?.getAttribute('aria-labelledby');
  if (tab && (page as HTMLElement).hidden) menu.querySelector<HTMLElement>(`#${tab}`)?.click();
  return row;
}

/** Whether that row's switch is on, read the way a screen reader would. */
export const switchedOn = (row: HTMLElement): boolean =>
  row.getAttribute('aria-checked') === 'true';

// ---- fixtures --------------------------------------------------------------

const SESSION_STARTED_AT = Date.now() - 60_000;

// The `Partial<T>`-override shape `views.test.ts` uses; a scenario states
// only what it is about.

// A card states the facts `toCard` reads (`unseen`, `turnOutcome`) beside its
// own fields, and its reading is resolved off them the way the host resolves
// it — so a scenario says what a session is, never which word that ranks to.
// One that passes `reading` states the whole answer, and nothing is resolved.
// `canInterrupt` is decided the same way off the fixture's facts unless stated.
export const cardView = (
  over: Partial<CardView> & Partial<Pick<CardFacts, 'unseen' | 'turnOutcome'>> = {}
): CardView => {
  const { unseen = false, turnOutcome, ...fields } = over;
  const card = {
    pid: 101,
    name: 'session',
    fullCwd: '/Users/someone/proj',
    status: 'idle' as const,
    hasCommand: false,
    brand: 'claude' as const,
    canControl: true,
    startedAt: SESSION_STARTED_AT,
    updatedAt: Date.now() - 30_000,
    cacheTtlMs: 60 * 60_000,
    ...(fields.status === 'busy'
      ? {}
      : {
          cacheFrom: fields.updatedAt ?? Date.now() - 30_000,
          cacheUntil: (fields.updatedAt ?? Date.now() - 30_000) + 60 * 60_000
        }),
    ...fields
  };
  const { reading } = card;
  const read = reading
    ? { ...card, reading }
    : { ...resolve({ ...card, unseen, neverSeen: false, turnOutcome }), ...card };
  return { ...read, canInterrupt: fields.canInterrupt ?? offersInterrupt(read) };
};

/** One offered model row as `PanelState.models` carries it: one entry per
 *  (model × window). */
export const modelView = (over: Partial<ModelView> = {}): ModelView => ({
  value: 'claude-opus-5-5',
  name: 'Opus 5.5',
  id: 'claude-opus-5-5',
  brand: 'claude',
  brandLabel: 'Claude',
  window: 1_000_000,
  efforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  defaultEffort: 'medium',
  ...over
});

export const groupView = (over: Partial<GroupView> = {}): GroupView => ({
  label: '~/proj',
  app: 'VS Code',
  cwd: '/Users/someone/proj',
  sessions: [cardView()],
  // Empty rather than absent: a group whose folder is a repository always has at
  // least its own tree, and a scenario about the section passes rows.
  servers: [],
  // No `slots` and no `families`: the common case is a board nobody has
  // arranged, and defaulting either would put every scenario here on a render
  // path it has never taken. A scenario about arrangement passes one.
  ...over
});

/**
 * The host's answer to one `openRunPicker`.
 *
 * `starts` defaults to a single entry, which is the plain-repo shape: one thing
 * to run, so the sheet draws no *What* field and looks exactly as it did before
 * the field existed. A monorepo scenario passes two or more.
 *
 * The single entry's `key` is the bare runner id, which is how `ports.ts` keys a
 * runner at the tree root — so `lastUsed: { dev: 3000 }` is the remembered port
 * for the default fixture.
 */
export const portsMsg = (over: Partial<PortsMessage> = {}): PortsMessage => ({
  type: 'ports',
  cwd: '/Users/someone/proj',
  branch: 'side',
  runnerId: 'dev',
  ports: [
    { port: 3000, free: true },
    { port: 3001, free: true }
  ],
  starts: [{ cwd: '/Users/someone/proj', runnerId: 'dev', label: 'npm run dev', key: 'dev' }],
  lastUsed: {},
  ...over
});

/**
 * A thread the panel drives — the default, unlike `cardView`, and deliberately
 * the other way round from it.
 *
 * A card defaults to one this window does not drive, which is the harder case
 * and the one a scenario forgets to set. A thread is where sending, answering
 * and interrupting are, and those exist for a session on a pipe this window
 * holds alone — so a composer scenario built on the other fixture would be
 * describing a surface that is not drawn. `unreachableThread` below is the
 * read-only half, and it says so in its name.
 */
type ThreadOver = Omit<Partial<ThreadView>, 'workflow'> & {
  workflow?: Omit<NonNullable<ThreadView['workflow']>, 'phase'> & {
    phase?: NonNullable<ThreadView['workflow']>['phase'];
  };
};

/** `phase` is required on the wire; a fixture that omits it still describes a
 *  run, so the default follows the step marker it already set, else running. */
function workflowPhase(
  workflow: NonNullable<ThreadOver['workflow']>
): NonNullable<ThreadView['workflow']>['phase'] {
  if (workflow.phase) return workflow.phase;
  const tone = workflow.step?.tone;
  return tone === 'done' || tone === 'failed' ? tone : 'running';
}

export const threadView = (over: ThreadOver = {}): ThreadView => {
  const { workflow, exchanges = [], ...rest } = over;
  const thread = {
    ...cardView(rest),
    owned: true,
    exchanges,
    // Two, because the interesting rules are about more than one: order is load
    // order, and a namespaced name must survive whole. A scenario about *no*
    // menu overrides this to `undefined` rather than relying on the default.
    skills: ['dataviz', 'caveman:caveman'],
    canSend: true,
    canAttach: true,
    canModel: true,
    who: 'claude',
    ...rest,
    ...(workflow ? { workflow: { ...workflow, phase: workflowPhase(workflow) } } : {})
  };
  // Decided again over the thread's own `owned`, as `toCard` decides it.
  return { ...thread, canInterrupt: rest.canInterrupt ?? offersInterrupt(thread) };
};

/** A thread for a session this window cannot write to — another window drives
 *  it and its published record did not land. Read whole, written to never.
 *  `canSend` is false at the source, so a scenario cannot ask for a composer the
 *  host would refuse anyway. */
export const unreachableThread = (over: Partial<ThreadView> = {}): ThreadView =>
  threadView({ owned: undefined, canSend: false, canAttach: false, canModel: false, ...over });

/** One question of an ask, as it arrives on the session's pipe. */
export const questionView = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
  question: 'Which way?',
  multiSelect: false,
  options: [{ label: 'Left', description: 'the scenic route' }, { label: 'Right' }],
  ...over
});

/** An `AskUserQuestion` waiting on the pipe of a session the panel drives. */
export const askRequest = (
  over: Partial<Extract<PendingRequestView, { kind: 'ask' }>> = {}
): PendingRequestView => ({
  requestId: 'req-1',
  kind: 'ask',
  questions: [questionView()],
  ...over
});

/**
 * The same ask once somebody has answered it, as a turn carries it.
 *
 * The arrays are dense and indexed like the questions, which is what the wire
 * promises — a scenario overriding `questions` alone would otherwise get a
 * record whose picks belong to a different list.
 */
export const answeredAsk = (over: Partial<AnsweredAskView> = {}): AnsweredAskView => {
  const questions = over.questions ?? [questionView()];
  return {
    questions,
    picks: questions.map((_, i) => (i === 0 ? [0] : [])),
    texts: questions.map(() => ''),
    notes: questions.map(() => ''),
    ...over
  };
};

/** A permission prompt on the same pipe. No `always` by default: a request
 *  carries suggestions only sometimes, and the button follows them. */
export const permissionRequest = (
  over: Partial<Extract<PendingRequestView, { kind: 'permission' }>> = {}
): PendingRequestView => ({
  requestId: 'req-1',
  kind: 'permission',
  toolName: 'Write',
  label: 'notes.txt',
  input: '{\n  "file_path": "/proj/notes.txt"\n}',
  ...over
});

/**
 * One authored workflow, as the picker gets it. Three steps, because a
 * one-step fixture cannot tell a row that counts from one that says `1`.
 *
 * There is no `runView` beside this and there is nothing to add one for: a run
 * never crosses the wire, so no fixture can build one.
 */
export const workflowView = (over: Partial<WorkflowView> = {}): WorkflowView => ({
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: '/plan the work' },
    { id: 'build', label: 'Build', prompt: 'implement it', needs: ['plan'] },
    { id: 'review', label: 'Review', prompt: 'review the diff', needs: ['build'] }
  ],
  ...over
});

// No `workflows`: absence is the machine that has authored none, and it is what
// every scenario written before this feature is asserting. Defaulting it would put
// every one of them on a render path — a bar — that none has ever drawn. Which
// workflow is armed is not here because it is not on the wire at all: it is the
// bar's own mode, and `bottom_hub.test.ts` says why.
/** A reading rides an account row and nothing else, so a scenario that wants a
 *  figure on the chip wants a row — and still writes one line for it. */
const withUsage = (usage: UsageView): AccountView[] => [
  {
    brand: 'claude',
    name: 'Claude',
    mark: 'claude',
    state: 'signed_in',
    label: 'a@b.c',
    detail: 'Claude',
    usage
  },
  { brand: 'grok', name: 'Grok', mark: 'grok', state: 'signed_out', detail: 'Grok' },
  { brand: 'codex', name: 'Codex', mark: 'codex', state: 'coming_soon', detail: 'Coming soon' }
];

/**
 * Remote off in a window that is fully set up: one field set, one allowed id,
 * a two-step create, its one messenger selected and never checked, so a
 * scenario about one state or one missing piece overrides only that. `setup` merges, so `{ setup: { allowlist: [] } }` keeps
 * the rest. `stateMessage` leaves `remote` absent, which is a host without
 * `RemoteHost` and what every scenario before Remote asserts.
 */
export const remoteStateView = (
  over: Partial<Omit<RemoteStateView, 'setup' | 'messengers'>> & {
    setup?: Partial<RemoteSetupView>;
    messengers?: Omit<RemoteStateView['messengers'], 'state'> & { state?: RemoteMessengerState };
  } = {}
): RemoteStateView => {
  const { setup, messengers, ...rest } = over;
  return {
    on: false,
    // Unrefused, as most scenarios are: the holder here, or another window.
    onSomewhere: rest.on === true || rest.tone === 'elsewhere',
    tone: 'off',
    status: 'Off',
    warnings: [],
    missing: [],
    check: { verdict: 'never', text: 'Not checked', marks: ['todo', 'todo'], facts: [] },
    ...rest,
    messengers: {
      rows: [{ id: 'chat', label: 'Chat', live: true }],
      selected: 'chat',
      ...messengers,
      state: messengers?.state ?? { tone: rest.tone ?? 'off', text: rest.status ?? 'Off' }
    },
    setup: {
      messenger: 'Chat',
      fields: [{ key: 'bot', label: 'Bot token', set: true }],
      allowlist: ['T1:U1'],
      sender: { help: 'Your member id, from your profile.', placeholder: 'T…:U…' },
      create: {
        steps: [
          { title: 'Open it', text: 'Open the create page.' },
          { title: 'Paste it', text: 'Paste the manifest.' }
        ],
        copyLabel: 'Copy manifest',
        link: true
      },
      ...setup
    }
  };
};

/** Thread views tests still pass beside board state. `push` posts them on the
 * ordered channel; they are not fields of `StateMessage`. */
const carriedThread = new WeakMap<StateMessage, ThreadView>();
const pendingThread = new WeakMap<WebviewMessage[], ThreadView>();
const threadSequence = new WeakMap<WebviewMessage[], Map<string, number>>();

const noteThreadSequence = (
  posted: WebviewMessage[],
  selection: string,
  sequence: number
): void => {
  const seen = threadSequence.get(posted) ?? new Map<string, number>();
  threadSequence.set(posted, seen);
  const prior = seen.get(selection) ?? 0;
  if (sequence > prior) seen.set(selection, sequence);
};

const orderedThread = (
  posted: WebviewMessage[],
  selection: string,
  thread: ThreadView
): ThreadMessage => {
  const seen = threadSequence.get(posted) ?? new Map<string, number>();
  threadSequence.set(posted, seen);
  const sequence = (seen.get(selection) ?? 0) + 1;
  seen.set(selection, sequence);
  return { type: 'thread', selection, generation: 0, sequence, thread };
};

export const stateMessage = (
  groups: GroupView[],
  over: Partial<Omit<StateMessage, 'type' | 'groups'>> & {
    usage?: UsageView;
    thread?: ThreadView;
  } = {}
): StateMessage => {
  const { usage, thread, ...rest } = over;
  const message: StateMessage = {
    type: 'state',
    groups,
    defaultCwd: undefined,
    cafe: false,
    cafeRemote: false,
    cafeWarm: false,
    warmOn: false,
    orchestrators: false,
    skipPermissions: false,
    executionCapture: false,
    soundLevel: 'off',
    devServers: false,
    mascot: false,
    warmCache: false,
    warmConfig: warmConfig(DEFAULT_WARM_POLICY),
    theme: 'follow',
    model: '',
    efforts: {},
    models: [],
    ticketSource: ticketSourceView({ linked: false }),
    ...(usage && !rest.accounts ? { accounts: withUsage(usage) } : {}),
    ...rest
  };
  if (thread) carriedThread.set(message, thread);
  return message;
};

/** Open the panel, select the thread's card, and deliver the thread. */
export function openThread(
  t: TestContext,
  thread: ThreadView,
  extra: Partial<Omit<StateMessage, 'type' | 'groups'>> = {}
): Panel {
  const p = openPanel(t);
  const groups = [
    groupView({ sessions: [cardView({ pid: thread.pid, startedAt: thread.startedAt })] })
  ];
  p.push(stateMessage(groups));
  p.window.document.querySelector<HTMLElement>('.card')?.click();
  p.push(stateMessage(groups, { thread, ...extra }));
  return p;
}

/**
 * Mention a workflow on the selected session's next message, the way a reader
 * does: the composer's **Apply workflow…** drops its own list upward, and a
 * press on a row arms it and shuts the menu.
 *
 * Here rather than in each file because five of them reach for it, and because
 * this door has moved twice already — every file that spelt it out had to be
 * edited both times.
 */
export function attachWorkflow(p: Panel, label: string): void {
  p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
  const row = [...p.window.document.querySelectorAll<HTMLElement>('#wattach .fmenu .mitem')].find(
    (r) => (r.querySelector('.nm')?.textContent ?? '').includes(label)
  );
  if (!row) throw new Error(`the composer's menu has no row for ${label}`);
  row.click();
}

/** Every workflow the composer's own menu is offering, by name. Open it first
 *  — `attachWorkflow` is the press-and-pick; this is the read. */
export function attachRows(p: Panel): string[] {
  return [...p.window.document.querySelectorAll<HTMLElement>('#wattach .fmenu .mitem')].map(
    (r) => r.querySelector('.nm')?.textContent ?? ''
  );
}

/**
 * Press Enter in the composer, the way the send path is reached.
 *
 * `cancelable` stays false: that is the event these suites have always sent.
 */
export const enter = (p: Panel): void => {
  composerKey(p, 'Enter', { cancelable: false });
};

/**
 * Press the New half of a group's add slot — which opens that group's draft in
 * the dock and posts nothing at all.
 *
 * `cwd` picks a group when the board has more than one; the first slot
 * otherwise, which is every single-group scenario.
 */
export function newDraft(p: Panel, cwd?: string): void {
  const halves = [...p.window.document.querySelectorAll<HTMLElement>('.card.add .half')];
  const half = halves.find(
    (h) => h.dataset.act === 'open' && (cwd === undefined || h.dataset.cwd === cwd)
  );
  assert.ok(half, `no New half${cwd === undefined ? '' : ` for ${cwd}`}`);
  half.click();
}

/**
 * Type literal text into the composer, replacing what is there, and announce
 * the edit. `caret`, when passed, is placed before that announcement: the
 * menu reads it off the `input` event. On the editor it is placed after the
 * typing, as a move, which the menu reads too.
 *
 * Omitted, the selection is left as the write left it. `typeIn` has always
 * worked that way, and a caller that does not pass one is relying on it.
 *
 * An editor types through `typeProse`, so input rules run. Without one, the
 * node is assigned `value` and fires `input`, which is what the menu reads.
 * A caret there is a string index; on the editor it is a document position,
 * the number `select` takes.
 */
export function typeIn(p: Panel, text: string, caret?: number): void {
  const node = composerNode(p);
  const host = composerHost(node);
  if (host) {
    // Enter sends here; Shift+Enter is the line break a textarea's `\n` was.
    typeProse(p, host, text, { shiftKey: true });
    if (caret !== undefined) selectComposer(p, caret);
    return;
  }
  const box = node as HTMLTextAreaElement;
  box.value = text;
  if (caret !== undefined) box.setSelectionRange(caret, caret);
  box.dispatchEvent(new p.window.Event('input', { bubbles: true }));
}

/**
 * Put markdown in as the document, not as an edit. An editor imports it,
 * which does not fire `onChange`. A textarea holds the characters themselves,
 * so this assigns `value` and fires nothing — assigning `value` has never
 * told the menu.
 */
export function importComposer(p: Panel, markdown: string): void {
  const node = composerNode(p);
  const host = composerHost(node);
  if (host) {
    proseOf(host).importMarkdown(markdown);
    return;
  }
  (node as HTMLTextAreaElement).value = markdown;
}

/** What a paste into the composer carries. `body` defaults to the bytes the
 *  image scenarios have always built (`PNGDATA`). */
export type ComposerPaste = {
  text?: string;
  html?: string;
  files?: { name: string; type: string; body?: string }[];
};

/**
 * Paste into the composer. Plain text and HTML go in as a paste event, so an
 * editor takes them with input rules off. A textarea leaves a text paste to
 * the browser, and jsdom inserts nothing, so the plain text is written at the
 * caret and announced — what the browser would have done. Files are the
 * image paste the composer already handles; they are not also inserted as text.
 */
export function pasteComposer(p: Panel, paste: ComposerPaste): void {
  const target = composerTarget(p);
  const event = new p.window.Event('paste', { bubbles: true, cancelable: true });
  const files = (paste.files ?? []).map(
    (file) => new p.window.File([file.body ?? 'PNGDATA'], file.name, { type: file.type })
  );
  const flavours: Record<string, string> = {};
  if (paste.text !== undefined) flavours['text/plain'] = paste.text;
  if (paste.html !== undefined) flavours['text/html'] = paste.html;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      types: Object.keys(flavours),
      items: [],
      getData: (type: string) => flavours[type] ?? ''
    }
  });
  target.dispatchEvent(event);
  if (event.defaultPrevented || files.length > 0 || paste.text === undefined) return;
  if (composerHost(composerNode(p))) return;
  const box = target as HTMLTextAreaElement;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  box.value = box.value.slice(0, start) + paste.text + box.value.slice(end);
  const at = start + paste.text.length;
  box.setSelectionRange(at, at);
  box.dispatchEvent(new p.window.Event('input', { bubbles: true }));
}

/**
 * Put `@` at the end of `before` and press it, without an `input` event.
 *
 * The character is already in the box when the key arrives. A browser would
 * not have inserted it yet; these suites always have, because the keydown is
 * what opens the menu and nothing else follows it.
 */
export function typeMention(p: Panel, before: string): void {
  const text = `${before}@`;
  importComposer(p, text);
  selectComposer(p, text.length);
  composerKey(p, '@', { cancelable: false });
}

/** The whole gesture a draft is sent by: New, type, Enter. */
export function sendDraft(p: Panel, text: string, cwd?: string): void {
  newDraft(p, cwd);
  typeIn(p, text);
  enter(p);
}

/** The last `open` posted, which is what a draft's first send is. */
export function lastOpen(p: Panel): Extract<WebviewMessage, { type: 'open' }> {
  const open = [...p.posted].reverse().find((m) => m.type === 'open');
  assert.ok(open && open.type === 'open', 'nothing posted an open');
  return open;
}

/**
 * Answer that open the way the host does: a `reveal` carrying the pid it
 * started and the draft id it was asked for. That is what promotes the draft —
 * the webview copies its contents onto the pid and posts the ordinary `send`.
 */
export function answerOpen(p: Panel, pid: number, startedAt = Date.now()): void {
  const open = lastOpen(p);
  p.push({
    type: 'reveal',
    pid,
    startedAt,
    ...(open.draftId === undefined ? {} : { draftId: open.draftId })
  });
}

/** Answer the most recent send with the exact operation context the host echoes. */
export function answerSend(
  p: Panel,
  result: Pick<SendResultMessage, 'ok' | 'reason' | 'text'>
): void {
  const request = [...p.posted].reverse().find((message) => message.type === 'send');
  assert.ok(request?.type === 'send', 'nothing posted a send');
  p.push({
    type: 'sendResult',
    pid: request.pid,
    startedAt: request.startedAt,
    operationId: request.operationId,
    ...result
  });
}

/** Answer the most recent dialog decision with the incarnation it addressed. */
export function answerRespond(p: Panel, result: Pick<RespondResultMessage, 'ok' | 'reason'>): void {
  const request = [...p.posted].reverse().find((message) => message.type === 'respond');
  assert.ok(request?.type === 'respond', 'nothing posted a response');
  p.push({
    type: 'respondResult',
    pid: request.pid,
    startedAt: request.startedAt,
    requestId: request.requestId,
    ...result
  });
}

/**
 * Answer the most recent file-dialog request with its operation identity.
 *
 * The id alone, which is what the host sends back: the box that asked
 * registered it, and nothing else on the message says where the paths go.
 */
export function answerFilePick(p: Panel, paths: string[]): void {
  const request = [...p.posted].reverse().find((m) => m.type === 'pickFiles');
  assert.ok(request?.type === 'pickFiles', 'nothing posted a file pick');
  p.push({ type: 'pickedFiles', operationId: request.operationId, paths });
}

/**
 * Press Escape in the composer, the way the interrupt path is reached.
 * Cancelable like a real keydown: an owner that takes the key says so with
 * `preventDefault`, a no-op on an event that cannot be cancelled.
 */
export const escape = (p: Panel): void => {
  composerKey(p, 'Escape', { keyCode: 27, code: 'Escape' });
};

/**
 * The document as the one property a view transition is driven through. jsdom
 * has none, which is why every scenario that does not install this runs the
 * panel's no-API path.
 */
const doc = (p: Panel): Record<string, unknown> =>
  p.window.document as unknown as Record<string, unknown>;

/**
 * Stand in for `startViewTransition`, holding each callback rather than running
 * it — so a scenario can ask what has and has not happened yet while the
 * "transition" is still in flight. Returns the callbacks as they arrive.
 *
 * Real `startViewTransition` runs its callback before the next rendering step
 * and not inline, so holding it is the honest model as well as the useful one:
 * a scenario that asserts the DOM before calling it is asserting what the
 * browser would really show for a frame.
 *
 * A transition already running needs no standing in: the browser skips it as
 * this call's own first step, so "was the stale one cut" and "did this one
 * start" are the same count, and it is the one below.
 *
 * `ready` rejects, because that is what a skipped transition's does — and
 * skipping is how most of them end here. Uncaught, Chromium reports it as
 * `Transition was skipped` in the panel's console; uncaught here, `node --test`
 * fails the file. Same rejection, both places, which is the point of modelling
 * it rather than handing back a bare object.
 *
 * `finished` resolves when the scenario runs the callback, which is as close as
 * jsdom gets to "the motion is over": it is what the dock undoes its transition
 * name on, so a stub without it would leave that name on the element forever
 * while every existing scenario still passed.
 */
export const captureVT = (p: Panel): (() => void)[] => {
  const started: (() => void)[] = [];
  doc(p).startViewTransition = (cb: () => void) => {
    let land = (): void => {};
    const finished = new Promise<void>((resolve) => {
      land = (): void => resolve();
    });
    // `finally`, because Chromium settles `finished` when the callback throws
    // too — it rejects rather than resolving, and either way the name comes
    // back. A stub that only landed on success would report a leak the browser
    // does not have.
    started.push(() => {
      try {
        cb();
      } finally {
        land();
      }
    });
    return {
      skipTransition: () => {},
      ready: Promise.reject(new Error('Transition was skipped')),
      finished
    };
  };
  return started;
};

/** True where the panel would find no View Transitions API — jsdom's default. */
export const hasVT = (p: Panel): boolean => doc(p).startViewTransition !== undefined;

/**
 * A prose box (`webview/prose.ts`) as a test reaches it: the hook its host
 * carries, since the bundle is a module instance this file cannot import.
 * `type` goes through the editor's text-input path, as a keystroke does.
 */
export interface ProseBox {
  value(): string;
  type(text: string): void;
  select(from: number, to?: number): void;
  importMarkdown(md: string): void;
  restore(snapshot: ProseNode, options: { history: 'fresh' }): boolean;
  insertChip(kind: string, expansion: string, attachmentId?: string): void;
  focus(): void;
  snapshot(): ProseNode;
}

/** Four paragraphs, the third empty: alpha 1–6, beta 8–12, gamma 16–21.
 *  Markdown cannot say it, since an import drops the empty paragraph. */
export const FOUR_LINES: ProseNode = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'beta' }] },
    { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: 'gamma' }] }
  ]
};

/** The composer's editor. */
export function composerProse(p: Panel): ProseBox {
  return proseOf(p.window.document.getElementById('input'));
}

/** A composer control in the formatting toolbar, by the format it applies. */
export function formatButton(p: Panel, format: string): HTMLButtonElement {
  const button = p.window.document.querySelector<HTMLButtonElement>(
    `#formatbar button[data-format="${format}"]`
  );
  assert.ok(button, `no ${format} control`);
  return button;
}

/** A ProseMirror JSON node, as `snapshot()` hands it over. */
type ProseNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: ProseNode[];
};

/** The editor mounted on `host`. Fails where a box is not one. */
export function proseOf(host: Element | null | undefined): ProseBox {
  assert.ok(host, 'no box');
  const hook = (host as unknown as { prose?: ProseBox }).prose;
  assert.ok(hook, `${host.className} is not a prose box`);
  return hook;
}

/** The element keys land on and focus sits in: the editor root inside a host. */
export function proseRoot(host: Element | null | undefined): HTMLElement {
  proseOf(host);
  const root = host?.querySelector<HTMLElement>('.ProseMirror');
  assert.ok(root, 'no editor root inside the box');
  return root;
}

/** A keydown on the editor root, the way a browser sends one. */
export function proseKey(
  p: Panel,
  host: Element | null | undefined,
  key: string,
  mods: KeyboardEventInit = {}
): KeyboardEvent {
  const event = new p.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...mods
  });
  proseRoot(host).dispatchEvent(event);
  return event;
}

/** `#input`, the composer. It is the prose host. */
function composerNode(p: Panel): HTMLElement {
  const node = p.window.document.getElementById('input');
  assert.ok(node, 'no composer');
  return node;
}

/**
 * The mounted editor, when `#input` is its host or sits inside one. Absent
 * when the node has no prose hook.
 */
function composerHost(node: HTMLElement): HTMLElement | undefined {
  if ((node as { prose?: ProseBox }).prose) return node;
  const parent = node.closest<HTMLElement>('.prose');
  if (parent && (parent as { prose?: ProseBox }).prose) return parent;
  return undefined;
}

/**
 * Whether the composer refuses typing. The editor says so by attribute
 * (`aria-disabled`), since a `div` has no `disabled`; the textarea by its own.
 */
export function composerDisabled(p: Panel): boolean {
  const node = composerNode(p);
  return composerHost(node)
    ? node.getAttribute('aria-disabled') === 'true'
    : (node as HTMLTextAreaElement).disabled;
}

/** What the composer's placeholder says: an attribute on the editor's host. */
export function composerPlaceholder(p: Panel): string {
  const node = composerNode(p);
  return composerHost(node)
    ? (node.getAttribute('placeholder') ?? '')
    : (node as HTMLTextAreaElement).placeholder;
}

/** Where a key or a paste lands: the editor root, or the textarea. */
export function composerTarget(p: Panel): HTMLElement {
  const node = composerNode(p);
  const host = composerHost(node);
  return host ? proseRoot(host) : node;
}

/** The delivery text. The editor's `value()`, or the textarea's. */
export function composerValue(p: Panel): string {
  const node = composerNode(p);
  const host = composerHost(node);
  return host ? proseOf(host).value() : (node as HTMLTextAreaElement).value;
}

/**
 * The box as the reader sees it: on the editor its text with each chip as its
 * label, where `composerValue` is the delivery and a chip is its expansion. A
 * textarea shows what it holds.
 */
export function composerShown(p: Panel): string {
  const node = composerNode(p);
  return composerHost(node) ? (composerTarget(p).textContent ?? '') : composerValue(p);
}

/** The selection, as indexes into the delivery (`textIndex`). A range on the
 *  editor has no caret, so both ends are 0 until a suite needs the range. */
export function composerSelection(p: Panel): { start: number; end: number } {
  const node = composerNode(p);
  const host = composerHost(node);
  if (!host) {
    const box = node as HTMLTextAreaElement;
    return { start: box.selectionStart ?? 0, end: box.selectionEnd ?? 0 };
  }
  const box = proseOf(host) as ProseBox & { selection?: { caret(): number | null } };
  const caret = box.selection?.caret();
  const at = caret === null || caret === undefined ? 0 : textIndex(box.snapshot(), caret);
  return { start: at, end: at };
}

/** Set the selection, as indexes into the delivery: the textarea's own, and
 *  on the editor mapped to document positions (`docPosition`). */
export function selectComposer(p: Panel, from: number, to = from): void {
  const node = composerNode(p);
  const host = composerHost(node);
  if (host) {
    const box = proseOf(host);
    const doc = box.snapshot();
    box.select(docPosition(doc, from), docPosition(doc, to));
    return;
  }
  (node as HTMLTextAreaElement).setSelectionRange(from, to);
}

/**
 * The editor's inline content as the text a suite indexes into: each textblock
 * in order, one character between two; a chip as wide as its expansion, which
 * is one position; a hard break one character. What a textarea index meant,
 * for the text these suites write — a list's markers are not counted.
 */
type Run = { pos: number; chars: number; atom: boolean };

const TEXTBLOCKS = new Set(['paragraph', 'codeBlock']);

function textRuns(doc: ProseNode): Run[][] {
  const blocks: Run[][] = [];
  const walk = (node: ProseNode, pos: number): number => {
    if (node.type === 'text') return node.text?.length ?? 0;
    if (TEXTBLOCKS.has(node.type)) {
      const runs: Run[] = [];
      let at = pos + 1;
      for (const child of node.content ?? []) {
        const text = child.type === 'text';
        const chars = text
          ? (child.text?.length ?? 0)
          : child.type === 'chip'
            ? typeof child.attrs?.expansion === 'string'
              ? child.attrs.expansion.length
              : 0
            : 1;
        runs.push({ pos: at, chars, atom: !text });
        at += text ? chars : 1;
      }
      blocks.push(runs.length ? runs : [{ pos: pos + 1, chars: 0, atom: false }]);
      return at + 1 - pos;
    }
    if (!node.content) return 1;
    let at = pos + 1;
    for (const child of node.content) at += walk(child, at);
    return at + 1 - pos;
  };
  let at = 0;
  for (const child of doc.content ?? []) at += walk(child, at);
  return blocks;
}

/** A delivery index as a document position. An index inside a chip lands
 *  after it; past the end, at the end. */
export function docPosition(doc: ProseNode, index: number): number {
  let left = index;
  let end = 1;
  for (const runs of textRuns(doc)) {
    for (const run of runs) {
      if (left <= run.chars) {
        if (!run.atom) return run.pos + left;
        return left === 0 ? run.pos : run.pos + 1;
      }
      left -= run.chars;
      end = run.pos + (run.atom ? 1 : run.chars);
    }
    left -= 1;
    if (left < 0) return end;
  }
  return end;
}

/** A document position as a delivery index: `docPosition`'s inverse. */
export function textIndex(doc: ProseNode, position: number): number {
  let index = 0;
  for (const runs of textRuns(doc)) {
    for (const run of runs) {
      const width = run.atom ? 1 : run.chars;
      if (position >= run.pos && position <= run.pos + width) {
        if (!run.atom) return index + position - run.pos;
        return index + (position > run.pos ? run.chars : 0);
      }
      index += run.chars;
    }
    index += 1;
  }
  return Math.max(0, index - 1);
}

/** A cancelable keydown on the composer. */
export function composerKey(p: Panel, key: string, mods: KeyboardEventInit = {}): KeyboardEvent {
  const node = composerNode(p);
  const host = composerHost(node);
  if (host) return proseKey(p, host, key, mods);
  const event = new p.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...mods
  });
  node.dispatchEvent(event);
  return event;
}

/**
 * Chips in the composer, in order. `kind` is the chip's class (`skill`,
 * `model`, `image`, `file`). `ref` is the dock's name for a session pill; a
 * chip carries `session`.
 */
export function composerPills(p: Panel, kind?: string): HTMLElement[] {
  const host = composerHost(composerNode(p));
  const pills = host ? [...host.querySelectorAll<HTMLElement>('.pchip')] : [];
  const cls = kind === 'ref' ? 'session' : kind;
  return cls ? pills.filter((pill) => pill.classList.contains(cls)) : pills;
}

/**
 * Type `text` into a prose box: each line through the text-input path, and
 * Enter between lines, which is a key rather than a character — with the
 * modifiers in `newline`, as Shift in the composer, whose Enter sends.
 * Everything in the box is selected first, so the words replace what was
 * there, as writing a textarea's `value` did.
 */
export function typeProse(
  p: Panel,
  host: Element | null | undefined,
  text: string,
  newline: KeyboardEventInit = {}
): void {
  const box = proseOf(host);
  const size = contentSize(box.snapshot());
  box.select(1, Math.max(1, size - 1));
  if (!text) {
    proseKey(p, host, 'Backspace');
    return;
  }
  text.split('\n').forEach((line, i) => {
    if (i > 0) proseKey(p, host, 'Enter', newline);
    box.type(line);
  });
}

/** A node's width in document positions: text by its length, a leaf as one. */
function nodeSize(node: ProseNode): number {
  if (node.type === 'text') return node.text?.length ?? 0;
  if (!node.content) return node.type === 'paragraph' ? 2 : 1;
  return 2 + contentSize(node);
}

const contentSize = (node: ProseNode): number =>
  (node.content ?? []).reduce((sum, child) => sum + nodeSize(child), 0);
