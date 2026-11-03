import { HOST_OWNED } from './host_owned';
import * as fixtureRoots from '../../../scripts/fixture-roots.cjs';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { constants, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { projectSlug } from '../../core/claude/transcript';
import { testPlatform, writeJson } from '../helpers';
import * as ownership from './ownership';
import * as hosts from './ide';
import * as capture from './capture';
import * as seedFiles from './seed';
import * as paths from '../../core/paths';
import * as observation from '../../../scripts/observation.mjs';

/**
 * The IDE the smoke scenarios run against: one launch, one teardown, shared by
 * however many `*.smoke.ts` files are loaded.
 *
 * Nothing here is a test. The hooks below are registered on the *importing*
 * process's root suite, so a scenario file that imports this boots the host
 * when run alone, and the barrel (`e2e.ts`) boots it once for all of them —
 * `require` evaluates this module exactly once either way.
 *
 * State is read through `ctx` rather than exported directly: `tsconfig` emits
 * CommonJS, so a bare `export let` reassigned inside `before()` is an emit
 * detail rather than a contract. Getters hold under either module system.
 */

/*
 * The host is `ide.ts`'s probe list. No host starts a cold profile without the
 * two workarounds below: `--use-inmemory-secretstorage` for a keychain that
 * the temp `HOME` has none of, and `clearOnboarding()` for a first-run layer
 * over the workbench.
 */
const REPO = path.join(__dirname, '..', '..', '..');
/** The fake CLI the jsdom suite drives, here spawned by the extension itself. */
const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-cli.js');
/** Grok login / logout / models; `agent stdio` forwards to fake-acp. */
const FAKE_GROK = path.join(__dirname, '..', 'fixtures', 'fake-grok.js');
/** Codex app-server account/model/runtime peer. */
const FAKE_CODEX = path.join(__dirname, '..', 'fixtures', 'fake-codex.js');
/** The file the composer's clip picks, written into the session's directory. */
export const PICKABLE = 'pick-me.txt';

/**
 * The file a turn wrote, for the diff behind its counts. Committed with one
 * body and left in the tree with another, so both sides of the diff have
 * content — a fixture where `git show HEAD:` answers nothing would open an
 * editor that proves only that a command resolved.
 */
export const DIFFED = 'counted.ts';
const DIFFED_AT_HEAD = 'export const n = 1;\nexport const m = 2;\n';
const DIFFED_IN_TREE = 'export const n = 1;\nexport const m = 3;\nexport const k = 4;\n';

/**
 * A second file, in a repository of its own, for the one scenario that has to
 * **move HEAD**.
 *
 * `project` is shared: the servers line reads its branches, the monorepo
 * fixture is a worktree cut from it, and several files boot sessions in it. A
 * scenario that commits there and resets afterwards is a mutation every later
 * file has to be immune to, and proving that immunity costs more than a second
 * `git init`. A pill's path is whatever the transcript says it is and need not
 * sit under the session's own cwd, so this repo is reachable from the same
 * thread while touching nothing else.
 */
export const MOVED_REPO = 'diffrepo';
export const MOVED = 'moved.ts';
const MOVED_AT_HEAD = 'export const p = 1;\nexport const q = 2;\n';
const MOVED_IN_TREE = 'export const p = 1;\nexport const q = 3;\nexport const r = 4;\n';

/**
 * An `AskUserQuestion` somebody already answered, as the CLI writes one down:
 * the questions ride the call, and the picks ride the *result* entry's
 * `toolUseResult`, keyed by the full question text. Copied field for field off a
 * real record under `~/.claude/projects` (2026-08-13) — a fixture agreeing with
 * our reader rather than with the CLI would pass while the real thing failed.
 *
 * Two questions, because the thread draws one pill per question and the second
 * is what proves a record is drawn per pill rather than once. One is a label
 * with a note beside it; the other is a pick plus words no label carries, which
 * is where 19% of measured answers land
 * (`cli_state/claude/transcript.md`, 265 of 1397).
 *
 * Those words run past one line of the record's own-words row on purpose: the
 * row used to clip them and pan the column sideways, and a fixture short enough
 * to fit could not have said so.
 */
export const ASKED = {
  questions: [
    {
      question: 'Which branch should this land on?',
      header: 'Branch',
      options: [
        { label: 'staging', description: 'installs, never publishes' },
        { label: 'main', description: 'publishable' }
      ],
      multiSelect: false
    },
    {
      question: 'Which checks should run?',
      header: 'Checks',
      options: [{ label: 'lint' }, { label: 'test' }, { label: 'typecheck' }],
      multiSelect: true
    }
  ],
  answers: {
    'Which branch should this land on?': 'staging',
    'Which checks should run?': [
      'lint',
      'a quick manual pass over the pieces no runner covers — the scroll at the bottom edge of the dock, the cafe pouring, and whichever sheet the last change moved, which is the half a green barrel has never once been able to speak for'
    ]
  },
  annotations: {
    'Which branch should this land on?': { notes: 'only after the smoke run passes' }
  }
};

/** The project's branch, which is what a server chip is named after. */
export const BRANCH = 'smoke-main';

/**
 * The monorepo fixture's branch — **a worktree of the repository above, not a
 * second repository.**
 *
 * Both shapes have to be on the board at once, because the invariant worth a
 * host is the *pair*: a plain repo's sheet unchanged beside a monorepo's grown
 * one. Making the existing fixture declare workspaces would have proved the new
 * path by destroying the baseline.
 *
 * A worktree rather than its own repo because of what puts a section on the
 * board at all. `serverContext` keys sections by the roots it derives from open
 * windows and from live sessions — and this window is open on `project`, so
 * that repo's section costs nothing to keep. A separate repo would have needed a
 * session of its own to be visible, which means a live process, which means the
 * section expires when that process does: the row simply stops being drawn
 * partway through a long suite, and the failure reads as a feature that never
 * rendered. A worktree is `readWorktrees`' answer for a repo already on screen,
 * so it needs nothing alive at all.
 */
export const MONO_BRANCH = 'smoke-mono';

/** The two apps that monorepo declares. Each is a runner in settings, so this
 *  needs no framework and no install — and it is also how the `commands` map is
 *  proven to reach a subdirectory at all, which it could not before. */
export const MONO_APPS = ['one', 'two'] as const;

/**
 * A third worktree, whose root `package.json` declares **both** `dev` and
 * `start` and which no `commands` entry names — the ambiguity `tracker` ships and
 * detection refuses to resolve.
 *
 * A worktree for the reason `MONO_BRANCH` is one, and no settings entry on
 * purpose: the moment one exists the row is runnable and the case is gone.
 */
export const AMBIG_BRANCH = 'smoke-ambiguous';

/**
 * A runner that is a server and nothing else: no framework, no install, and no
 * `package.json` for detection to read. Settings beat detection, which is what
 * makes this the whole of the fixture — `${port}` is substituted at launch
 * exactly as it is for a real one, and the body is `ok` so a green chip can be
 * proven to be *our* server rather than whatever else holds that port.
 */
const SERVE_CMD =
  `${JSON.stringify(process.execPath)} -e ` +
  JSON.stringify(
    "require('http').createServer((_,s)=>s.end('ok')).listen(Number(process.argv[1]))"
  ) +
  ' ${port}';

/**
 * The environment a `git` here must not inherit. The gate runs from the
 * pre-commit hook, and git exports `GIT_DIR` and `GIT_INDEX_FILE` into it —
 * they beat `cwd`, so a temp-repo command would silently operate on this
 * checkout. `release.test.ts` says the same at greater length.
 */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);

/**
 * Pause between Playwright operations so a human can follow along.
 * `SQUADRON_SMOKE_SLOW=250` → 250ms. Non-numeric / missing / 0 → no delay.
 *
 * Not Playwright's browser `slowMo`: `_electron.launch` does not take that
 * option. We sleep before locator actions instead (same effect for watching).
 */
const SLOW_MS = (() => {
  const raw = process.env['SQUADRON_SMOKE_SLOW'];
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

/** Locator methods that move the suite forward — each waits `SLOW_MS` first. */
const SLOW_ACTIONS = [
  'click',
  'dblclick',
  'fill',
  'press',
  'type',
  'pressSequentially',
  'hover',
  'check',
  'uncheck',
  'selectOption',
  'setInputFiles',
  'tap',
  'focus',
  'blur',
  'clear'
] as const;

let slowed = false;

/**
 * Instrument locators (and the workbench keyboard) so actions pause when
 * slow-mo is on. Done once on the Locator prototype Playwright hands back —
 * smoke is the only consumer of this process.
 */
function enableSlowMo(sample: Page): void {
  if (SLOW_MS <= 0) return;
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, SLOW_MS));
  const proto = Object.getPrototypeOf(sample.locator('body')) as Record<
    string,
    ((this: unknown, ...args: unknown[]) => Promise<unknown>) | undefined
  >;
  // Once per process: the prototype outlives a relaunch's page, and a second
  // pass would wrap the pause around itself.
  for (const name of slowed ? [] : SLOW_ACTIONS) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    proto[name] = async function (this: unknown, ...args: unknown[]) {
      await pause();
      return orig.apply(this, args);
    };
  }
  slowed = true;
  // Command palette uses page.keyboard, not a locator.
  const kb = sample.keyboard;
  const press = kb.press.bind(kb);
  kb.press = async (key, options) => {
    await pause();
    return press(key, options);
  };
  const type = kb.type.bind(kb);
  kb.type = async (text, options) => {
    await pause();
    return type(text, options);
  };
}

let home: string;
let profile: string;
let argvLog: string;
let envLog: string;
let app: ElectronApplication;
let hostProcess: ChildProcess | undefined;
let connection: ownership.WorkerConnection;
let launchId: string | undefined;
let closingHost: Promise<void> | undefined;
let page: Page;
let tracker: http.Server;
/** `HOME` as planted, before any host wrote to it — what `resetHost` restores. */
let seed: string;
/** The folder the window is opened on. */
let workspace: string;
/** Every scenario's settings, written at launch and again by every reset. */
let launchSettings: Record<string, unknown>;
/** No section has run on this host yet, so there is nothing to reset. */
let fresh = true;
/** A section ended without every step passing; the next one gets a new host. */
let dirty = false;
const resetHooks: (() => void)[] = [];

/** How long `app.close()` is given before the tree under it is killed. */
const CLOSE_MS = 10_000;
/** A reload that has not finished by then is treated as a wedged host. */
const RELOAD_MS = 45_000;
/** A case that runs past this is a red, not a hang (the step drag, AGENTS.md). */
const STEP_MS = 120_000;

/**
 * The reset's commands, bound to keys in the profile's `keybindings.json`
 * rather than typed into the palette: an id cannot fuzzy-match a neighbour,
 * and a key needs no wait for the palette's list to settle.
 */
const RESET_KEYS = {
  killTerminals: {
    key: 'ctrl+alt+shift+f1',
    chord: 'Control+Alt+Shift+F1',
    command: 'workbench.action.terminal.killAll'
  },
  closePanel: {
    key: 'ctrl+alt+shift+f2',
    chord: 'Control+Alt+Shift+F2',
    command: 'workbench.action.closePanel'
  },
  closeEditors: {
    key: 'ctrl+alt+shift+f3',
    chord: 'Control+Alt+Shift+F3',
    command: 'workbench.action.closeAllEditors'
  },
  reload: {
    key: 'ctrl+alt+shift+f4',
    chord: 'Control+Alt+Shift+F4',
    command: 'workbench.action.reloadWindow'
  }
} as const;

/**
 * Remote's four commands, and closing one window, on keys for the same reason
 * as the reset's: the commands are in the palette only under `squadron.debug`,
 * and a key reaches whichever window it is pressed in.
 */
export const REMOTE_KEYS = {
  turnOn: {
    key: 'ctrl+alt+shift+f5',
    chord: 'Control+Alt+Shift+F5',
    command: 'squadron.remote.turnOn'
  },
  turnOff: {
    key: 'ctrl+alt+shift+f6',
    chord: 'Control+Alt+Shift+F6',
    command: 'squadron.remote.turnOff'
  },
  connect: {
    key: 'ctrl+alt+shift+f7',
    chord: 'Control+Alt+Shift+F7',
    command: 'squadron.remote.connect'
  },
  disconnect: {
    key: 'ctrl+alt+shift+f8',
    chord: 'Control+Alt+Shift+F8',
    command: 'squadron.remote.disconnect'
  },
  closeWindow: {
    key: 'ctrl+alt+shift+f9',
    chord: 'Control+Alt+Shift+F9',
    command: 'workbench.action.closeWindow'
  }
} as const;

/** Run on every reset, for a scenario module holding something a reset ends —
 *  `kit.ts`'s memoised fixture session. */
export function onReset(hook: () => void): void {
  resetHooks.push(hook);
}

/**
 * What a scenario file reads instead of the bindings above. Getters, because
 * these are assigned in `before()` and the emit is CommonJS.
 */
export const ctx = {
  get application(): ElectronApplication {
    return app;
  },
  /** The workbench page — the half of the window that is not a webview. */
  get page(): Page {
    return page;
  },
  /** The temp `HOME` discovery reads, and where fixture state is written. */
  get home(): string {
    return home;
  },
  /**
   * The IDE's own main process, so a scenario can tell this host's children
   * from the rest of the machine's.
   *
   * The extension host is a descendant rather than this pid itself, which is
   * why the one reader walks `ps` instead of comparing directly — see the
   * keep-awake case in `session.smoke.ts`.
   */
  get hostPid(): number {
    return hostProcess?.pid ?? 0;
  },
  /** The `--user-data-dir` root, so a scenario can rewrite User/settings.json. */
  get profile(): string {
    return profile;
  }
};

/**
 * Rewrite this profile's User settings, for a scenario about a setting.
 *
 * Merged rather than replaced: the launch-time object above is every scenario
 * file's, and a patch that dropped `squadron.claudePath` would take the CLI
 * away from every test after it. No reload — `panel.ts` reads each flag through
 * `getConfiguration` per call, so the next poll sees the write — and the wait
 * is that poll (3s) plus the host's own file watch, since a scenario that
 * asserted immediately would be reading the board the write has not reached.
 */
export async function patchSettings(patch: Record<string, unknown>): Promise<void> {
  const file = path.join(profile, 'data', 'User', 'settings.json');
  const current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  await writeJson(file, { ...current, ...patch });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

/** The one ticket the canned tracker serves, named where a test can read it. */
export const TICKET = { identifier: 'SMK-1', title: 'a ticket to drag' };

export const ticketTracker: {
  failure?: {
    status: number;
    message: string;
    code?: string;
    optionsOnly?: boolean;
    detailsOnly?: boolean;
  };
  holdDetail?: boolean;
  detailRequested?: () => void;
  detailCancelled?: () => void;
  requests: { query: string; variables: Record<string, unknown> }[];
} = { requests: [] };

/** The real host reaches this scoped GraphQL fixture over HTTP, without an account. */
async function fakeTracker(): Promise<{ server: http.Server; endpoint: string }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
      ticketTracker.requests.push(request);
      const { query, variables } = request;
      if (query.includes('TicketDetail') && ticketTracker.holdDetail) {
        res.on('close', () => ticketTracker.detailCancelled?.());
        ticketTracker.detailRequested?.();
        return;
      }
      const catalog = query.includes('TicketScopes');
      const failure = ticketTracker.failure;
      if (
        failure &&
        (!failure.optionsOnly || /TicketMembers|TicketStates|TicketOptions/.test(query)) &&
        (!failure.detailsOnly || query.includes('TicketDetail'))
      ) {
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            errors: [{ message: failure.message, extensions: { code: failure.code } }]
          })
        );
        return;
      }
      const page = (nodes: unknown[]) => ({
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null }
      });
      const team =
        variables.scopeId ??
        (typeof variables.id === 'string' && variables.id.startsWith('team-a-')
          ? 'team-a'
          : undefined) ??
        (variables.filter as { team?: { id?: { eq?: string } } } | undefined)?.team?.id?.eq;
      const valid = team === 'team-a' || team === 'team-b';
      if (!catalog && !query.includes('TicketOptions') && !valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'A native team ID is required' }] }));
        return;
      }
      const data = query.includes('TicketDetail')
        ? {
            issue: {
              id: variables.id,
              identifier: TICKET.identifier,
              title: TICKET.title,
              team: { id: team },
              url: 'https://example.invalid/' + TICKET.identifier,
              assignee: null,
              state: { id: 'team-a-started', name: 'In Progress' },
              description:
                '## Acceptance\n\n**Rendered Markdown** stays readable.\n\n' +
                Array.from(
                  { length: 32 },
                  (_, i) =>
                    '### Case ' +
                    i +
                    '\n\nA long paragraph for independently scrolling ticket details.\n\n'
                ).join('')
            }
          }
        : catalog
          ? {
              teams: page([
                { id: 'team-a', key: 'ENG', name: 'Engineering' },
                { id: 'team-b', key: 'OPS', name: 'Operations' }
              ])
            }
          : query.includes('TicketMembers')
            ? { team: { members: page([{ id: 'u_1', displayName: 'smoke' }]) } }
            : query.includes('TicketStates')
              ? {
                  team: {
                    states: page([
                      {
                        id: (typeof team === 'string' ? team : '') + '-started',
                        name: 'In Progress',
                        type: 'started',
                        position: 1
                      },
                      {
                        id: (typeof team === 'string' ? team : '') + '-done',
                        name: 'Done',
                        type: 'completed',
                        position: 2
                      }
                    ])
                  }
                }
              : query.includes('issuePriorityValues')
                ? {
                    viewer: { id: 'u_1', displayName: 'smoke' },
                    issuePriorityValues: [
                      { priority: 1, label: 'Urgent' },
                      { priority: 2, label: 'High' }
                    ]
                  }
                : {
                    issues: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: (typeof team === 'string' ? team : '') + '-tk_1',
                          identifier: team === 'team-a' ? TICKET.identifier : 'OPS-1',
                          title: TICKET.title,
                          priority: 2,
                          url: 'https://example.invalid/' + TICKET.identifier,
                          state: {
                            id: (typeof team === 'string' ? team : '') + '-started',
                            name: 'In Progress',
                            type: 'started'
                          }
                        }
                      ]
                    }
                  };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('tracker did not listen');
  return { server, endpoint: `http://127.0.0.1:${address.port}/graphql` };
}

/**
 * The environment the IDE must be launched with, which is not this process's.
 *
 * Run from a terminal the extension host opened, `process.env` carries
 * `ELECTRON_RUN_AS_NODE=1` and the `VSCODE_*` block. The first one is fatal and
 * silent: the binary then *is* node, so it rejects the workbench's own flags
 * with `bad option: --user-data-dir=…` — a node error that reads like the host
 * refusing them. That misreading is what got this suite deleted once. Strip
 * them, and 2.3.1 launches on the same flags it always did.
 */
function ideEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(fixtureRoots.withoutCliRoots(process.env))) {
    if (value === undefined) continue;
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) continue;
    env[key] = value;
  }
  if (testPlatform() === 'win32') {
    // The fake CLIs' `.cmd` shims run `node` by name (`writeShim`).
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path';
    env[key] = [path.dirname(process.execPath), env[key]].filter(Boolean).join(path.delimiter);
  }
  return {
    ...env,
    ...overrides,
    ...homeVars(),
    CODEX_HOME: path.join(home, '.codex'),
    GROK_HOME: path.join(home, '.grok')
  };
}

/**
 * A turn that wrote a file, as the CLI would have written it down — the fixture
 * behind the counts on a pill and the diff behind them.
 *
 * Both sides are real. `DIFFED` is committed with one body and left in the tree
 * with another, so the editor that opens has content on the left *and* the
 * right; the transcript's `Edit` carries the same two bodies, so the counts the
 * pill draws are a reading of the same change git will show. A fixture whose
 * before-image was empty would prove only that a command resolved — which is
 * the failure mode this whole step exists to catch.
 */
async function writeTranscript(project: string): Promise<void> {
  const file = path.join(project, DIFFED);
  await fs.writeFile(file, DIFFED_AT_HEAD);
  commit(project, DIFFED, 'counted');
  await fs.writeFile(file, DIFFED_IN_TREE);

  // The second repository, whose whole purpose is that one scenario may move
  // its HEAD without any other file having to be immune to it.
  const moved = path.join(home, MOVED_REPO);
  await fs.mkdir(moved, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=diff-main', moved], { env: CLEAN });
  const movedFile = path.join(moved, MOVED);
  await fs.writeFile(movedFile, MOVED_AT_HEAD);
  commit(moved, MOVED, 'moved');
  await fs.writeFile(movedFile, MOVED_IN_TREE);

  const dir = path.join(home, '.claude', 'projects', projectSlug(project));
  await fs.mkdir(dir, { recursive: true });
  // The CLI's own entry shape, field for field — a fixture that agreed with our
  // reader instead of with the CLI would pass while the real thing failed, which
  // is the rule `fixtures/fake-cli.ts` is written under.
  // **Every assistant entry carries `message.id`, as the real CLI's does.** It
  // is what `readWitnessed` collects, and what tells our own record from this
  // file: an id here that our record never saw is the evidence that we did not
  // witness this conversation, so `drawable` stands aside and the reader gets
  // the file. Without one the set is empty, the fixture's own single draft turn
  // looks like the whole story, and every pill these entries exist for vanishes.
  const entries = [
    { type: 'user', message: { content: 'change the constants' } },
    {
      type: 'assistant',
      cwd: project,
      message: {
        id: 'msg_counted',
        content: [
          { type: 'text', text: 'Adjusted them.' },
          {
            type: 'tool_use',
            id: 'toolu_counted',
            name: 'Edit',
            input: { file_path: file, old_string: DIFFED_AT_HEAD, new_string: DIFFED_IN_TREE }
          }
        ]
      }
    },
    { type: 'user', message: { content: 'and the other repo' } },
    {
      type: 'assistant',
      cwd: project,
      message: {
        id: 'msg_moved',
        content: [
          { type: 'text', text: 'Adjusted those too.' },
          {
            type: 'tool_use',
            id: 'toolu_moved',
            name: 'Edit',
            input: { file_path: movedFile, old_string: MOVED_AT_HEAD, new_string: MOVED_IN_TREE }
          }
        ]
      }
    },
    {
      type: 'assistant',
      cwd: project,
      message: {
        id: 'msg_asked',
        content: [
          { type: 'text', text: 'Two things before the rest.' },
          {
            type: 'tool_use',
            id: 'toolu_asked',
            name: 'AskUserQuestion',
            input: { questions: ASKED.questions }
          }
        ]
      }
    },
    // The result entry carries exactly one `tool_result` block, which is what
    // `core/transcript.ts` requires before it attaches the record: one
    // `toolUseResult` cannot say which of two calls it belongs to.
    {
      type: 'user',
      cwd: project,
      toolUseResult: ASKED,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_asked',
            content:
              'Your questions have been answered: "Which branch should this land on?"="staging". You can now continue with these answers in mind.'
          }
        ]
      }
    }
  ];
  await fs.writeFile(
    path.join(dir, 'smoke.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  );
}

/** One file committed in one repository. The identity is passed per-command: a
 *  temp `HOME` has no git config to read one from, which is why the monorepo
 *  fixture below does the same. */
function commit(repo: string, file: string, message: string): void {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env: CLEAN, stdio: 'ignore' });
  git('add', file);
  git(
    '-c',
    'user.email=smoke@example.invalid',
    '-c',
    'user.name=smoke',
    'commit',
    '--quiet',
    '-m',
    message
  );
}

async function ide(): Promise<string> {
  const executable = await hosts.installed();
  // An unknown host version prevents automatic smoke comparison.
  observation.event('smoke:host', { executable, version: await hosts.version(executable) });
  return executable;
}

before(async () => {
  connection = await ownership.connectWorker();
  home = connection.paths.home;
  profile = connection.paths.profile;
  seed = connection.paths.seed;
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  Object.assign(process.env, homeVars());
  const project = path.join(home, 'project');
  await fs.mkdir(project, { recursive: true });
  const skillFixtures = [
    ['.claude', 'dataviz'],
    ['.claude', 'ponytail'],
    ['.claude', 'caveman:caveman'],
    ['.claude', 'a-skill-with-a-deliberately-very-long-name-to-push-the-menu-wide'],
    ['.codex', 'codex-folder-marker'],
    ['.grok', 'grok-folder-marker'],
    ['.agents', 'shared-folder-marker']
  ] as const;
  for (const [cli, name] of skillFixtures) {
    const directory = path.join(home, cli, 'skills', name.replace(':', '-'));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Smoke fixture\n---\n`
    );
  }
  for (const cli of ['.claude', '.codex', '.grok']) {
    const directory = path.join(project, cli, 'skills', 'project-folder-marker');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: project-folder-marker\ndescription: Smoke fixture\n---\n'
    );
  }
  // Something for the composer's clip to pick. In the session's own directory,
  // which is where the dialog opens.
  await fs.writeFile(path.join(project, PICKABLE), 'pick me\n');
  // A repository, because the servers section lists a repo's branches and a
  // plain directory has none — `serverContext` drops a root whose
  // `readWorktrees` comes back empty. `git init` alone is enough: the branch is
  // read out of `.git/HEAD`, which exists before there is anything to commit.
  execFileSync('git', ['init', '--quiet', `--initial-branch=${BRANCH}`, project], { env: CLEAN });

  // A transcript for that session, which is where the dock's turns come from —
  // the pid file says a session exists, and only this says what it did.
  //
  // Filed under the slug of the *unresolved* project path, because that is what
  // the pid file's `cwd` says and what `locateTranscript` derives from. Its
  // sweep of `projects/` would find this either way; matching the derivation
  // means the fixture does not depend on the fallback to be found.
  await writeTranscript(project);

  // The monorepo fixture: a worktree of the repository above, carrying the one
  // thing that makes it a monorepo — a root `package.json` declaring `apps/*`.
  //
  // Its root declares workspaces and resolves to **no runner of its own**: no
  // scripts, and no `commands` entry keyed at the root. That is deliberate, and
  // it is the case the `workspaces` flag exists for — the row is `unrunnable`,
  // and without that flag it would not be a button, so the sheet listing its
  // apps could never be opened. Only a host proves it, since only a host runs
  // `serverContext`.
  //
  // `git worktree add` needs a commit to branch from, which `git init` alone
  // does not leave; the identity is passed per-command because a temp `HOME` has
  // no git config to read one from.
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', project, ...args], { env: CLEAN, stdio: 'ignore' });
  git(
    '-c',
    'user.email=smoke@example.invalid',
    '-c',
    'user.name=smoke',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'root'
  );
  // **Realpath, and it is load-bearing on macOS.** `os.tmpdir()` hands back
  // `/var/folders/…`, which is a symlink to `/private/var/folders/…`, and git
  // records a worktree by its resolved path. The panel keys `commands` and its
  // runner cache by the path git reported, so a settings entry written against
  // the unresolved one matches nothing: the apps resolve to no runner, and the
  // sheet draws no What field with every other part of the fixture correct.
  git('worktree', 'add', '--quiet', '-b', MONO_BRANCH, path.join(home, 'mono-tree'));
  const monorepo = await fs.realpath(path.join(home, 'mono-tree'));

  for (const app of MONO_APPS) {
    await fs.mkdir(path.join(monorepo, 'apps', app), { recursive: true });
    // A manifest with no scripts: a directory is a project because it has one,
    // and what it *runs* comes from settings below.
    await writeJson(path.join(monorepo, 'apps', app, 'package.json'), { name: app });
  }
  // Matches `apps/*` and has no manifest, so it must contribute nothing —
  // the monorepo `workspaces.ts` measured has two directories exactly like it.
  await fs.mkdir(path.join(monorepo, 'apps', 'three'), { recursive: true });
  await writeJson(path.join(monorepo, 'package.json'), {
    name: 'smoke-monorepo',
    workspaces: ['apps/*']
  });

  // The ambiguous tree. The script bodies are never run — what is asserted is
  // which script the reader is *offered*, and a runner's command is composed
  // from the script's name and the manifest's dependencies, never from what it
  // says. `build` is here to be ignored: only four names are candidates.
  git('worktree', 'add', '--quiet', '-b', AMBIG_BRANCH, path.join(home, 'ambig-tree'));
  const ambiguous = await fs.realpath(path.join(home, 'ambig-tree'));
  await writeJson(path.join(ambiguous, 'package.json'), {
    name: 'smoke-ambiguous',
    scripts: { dev: 'true', start: 'true', build: 'true' }
  });

  // Two authored workflows, so Attach and the bar can prove a pick rather than
  // a single forced row. Multi-step on the first so the observe drawer has a
  // real rail (jsdom covers paint rules; smoke proves host join + click).
  // Written before launch because the panel reads the directory on its poll.
  await writeJson(path.join(home, '.squadron', 'workflows', 'smoke-flow.json'), {
    schema: 1,
    id: 'smoke-flow',
    label: 'smoke workflow',
    steps: [
      { id: 'one', label: 'One', prompt: 'do the one step' },
      { id: 'two', label: 'Two', prompt: 'do the two step' },
      { id: 'three', label: 'Three', prompt: 'do the three step' }
    ]
  });
  await writeJson(path.join(home, '.squadron', 'workflows', 'smoke-alt.json'), {
    schema: 1,
    id: 'smoke-alt',
    label: 'smoke alt',
    steps: [
      { id: 'a', label: 'A', prompt: 'do a' },
      { id: 'b', label: 'B', prompt: 'do b' }
    ]
  });
  // Existing scenarios own their exact workflow fixtures. The examples scenario
  // removes this marker and reloads to exercise first-install activation.
  await fs.writeFile(path.join(home, '.squadron', paths.WORKFLOW_EXAMPLES_MARKER_NAME), '');

  // `startOwned` execs `claudePath` directly — no runner — so the fake CLI, a
  // .js file, needs a shell in front of it to be a `claude` the extension can
  // start. Written into the profile's user settings before launch, since the
  // setting is read at spawn and nothing here can reach the settings UI.
  argvLog = path.join(profile, 'claude-argv.jsonl');
  // Every spawn's environment, one JSON object a line (`fixtures/env_log.ts`):
  // the only witness to what a child was handed, which `remote.smoke.ts`
  // searches for a messenger credential that must never reach one.
  envLog = path.join(profile, 'fake-env.jsonl');
  // `FAKE_CLI_ARGV` names the file the fixture appends its launch line to, the
  // way `codexShim` names its store below. Passed on the shim rather than
  // derived from `HOME`: the child's environment is composed and scrubbed by
  // `core/session.ts`, and a fixture guessing at a path fails by writing where
  // nobody reads.
  const shim = await writeShim(path.join(profile, 'claude'), FAKE, {
    FAKE_CLI_ARGV: argvLog,
    FAKE_ENV_LOG: envLog
  });
  const codexShim = await writeShim(path.join(profile, 'codex'), FAKE_CODEX, {
    FAKE_CODEX_STORE: path.join(home, '.codex', 'fake-threads.json')
  });
  // In the profile rather than at `~/.grok/bin/grok`, so `squadron.grokPath`
  // is the *only* way to reach it: the well-known path would find this fixture
  // whether or not the setting were read, and then the lever the Grok adapter
  // now names would be untested here. Default signed in; accounts.smoke flips
  // `auth.json`, which is a different file and still under `home`.
  const grokShim = await writeShim(path.join(profile, 'grok'), FAKE_GROK, {});
  await writeJson(path.join(home, '.grok', 'auth.json'), {
    'https://auth.x.ai::smoke': { email: 'grok-smoke@example.invalid', key: 'x' }
  });
  // The tracker is up before the host, because the endpoint is a setting the
  // panel reads per fetch and the port is only known once it is listening.
  const served = await fakeTracker();
  tracker = served.server;
  // Every scenario file's settings, written once. They are read at launch, so a
  // file cannot add to them later — which is why this is the union rather than
  // per-scenario. A key the loaded scenarios never touch costs nothing.
  launchSettings = {
    'squadron.claudePath': shim,
    'squadron.codexPath': codexShim,
    'squadron.grokPath': grokShim,
    'squadron.linear.endpoint': served.endpoint,
    // The servers line is behind an experiment switch and off by default, so
    // two scenario files would drive a board that draws no chips at all. On
    // here rather than flipped per scenario: it is read at launch, like every
    // other key in this object.
    'squadron.devServers.enabled': true,
    // Audible by default, and a profile left audible beeps on every finished
    // turn in the barrel.
    'squadron.sound.level': 'off',
    // A runner that is a server and nothing else: no framework, no install, and
    // no `package.json` for detection to read. Settings beat detection, which is
    // what makes this the whole of the fixture — `${port}` is substituted at
    // launch exactly as it is for a real one.
    'squadron.run.commands': {
      // Keyed by each app directory, not by the monorepo root. Before this
      // feature an entry for a subdirectory rendered nowhere — nothing ever
      // asked `resolveRunners` about a path below a tree — so this half of the
      // fixture is also the assertion that it now reaches one.
      ...Object.fromEntries(
        MONO_APPS.map((app) => [
          path.join(monorepo, 'apps', app),
          [{ id: 'dev', label: `smoke ${app}`, command: SERVE_CMD }]
        ])
      ),
      [project]: [{ id: 'dev', label: 'smoke server', command: SERVE_CMD }]
    },
    // The composer's clip opens `showOpenDialog`, which is a native sheet by
    // default — outside the page, so Playwright can neither see it nor dismiss
    // it, and the suite would hang on the click. The host's own in-workbench
    // file dialog is the same API answered by a quick input, which is
    // driveable. What that costs is stated at the test: the seam is proven,
    // the platform's own sheet is not.
    'files.simpleDialog.enable': true,
    // On by default, and then the pty host revives a dev server's terminal
    // across `resetHost`'s reload with the server still holding its port, while
    // the map that could stop it died with the old extension host.
    'terminal.integrated.enablePersistentSessions': false,
    // A fresh profile offers the host's own update, as a prompt in front of
    // whoever is at the machine while the suite runs.
    'update.mode': 'none'
  };
  workspace = project;

  // The seed every later section's `HOME` is put back from: taken here, after
  // the planting and before a host has written anything, because the planting
  // itself is not idempotent (its commits, `worktree add`).
  await fs.cp(home, seed, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE
  });
});

/**
 * A fake CLI the extension can start as `file`, running `script` on this Node
 * with `env` set, and the path to name in its setting. POSIX: an sh shim.
 * win32 runs no sh file, and the product follows only an npm-shaped `.cmd`
 * (`parseShim`, `platform/executables/win32.ts`), which sets no variable: it
 * names a sidecar entry beside it that sets `env` and loads the fixture, on
 * the `node` that `ideEnv` puts first on `PATH`.
 */
async function writeShim(
  file: string,
  script: string,
  env: Record<string, string>
): Promise<string> {
  if (testPlatform() === 'win32') {
    const entry = file + '.js';
    await fs.writeFile(
      entry,
      `Object.assign(process.env, ${JSON.stringify(env)});\nrequire(${JSON.stringify(script)});\n`
    );
    await fs.writeFile(file + '.cmd', `@node  "%~dp0\\${path.basename(entry)}" %*\r\n`);
    return file + '.cmd';
  }
  const vars = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)} `);
  await fs.writeFile(
    file,
    `#!/bin/sh\n${vars.join('')}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 }
  );
  return file;
}

/**
 * One host up, on `profile/data`: settings and the reset's keys written, the
 * IDE launched, its window pinned, the first-run layer cleared.
 */
async function launch(settings: Record<string, unknown>): Promise<void> {
  const user = path.join(profile, 'data', 'User');
  await writeJson(path.join(user, 'settings.json'), settings);
  await writeJson(
    path.join(user, 'keybindings.json'),
    [...Object.values(RESET_KEYS), ...Object.values(REMOTE_KEYS)].map(({ key, command }) => ({
      key,
      command
    }))
  );

  const windows = path.join(home, '.squadron', 'windows');
  const oldClaims = new Set(await fs.readdir(windows).catch(() => []));
  launchId = await connection.allocate();
  app = await _electron.launch({
    executablePath: process.env['SQUADRON_SMOKE_LAUNCHER'],
    args: [
      `--user-data-dir=${path.join(profile, 'data')}`,
      `--extensions-dir=${path.join(profile, 'ext')}`,
      `--extensionDevelopmentPath=${REPO}`,
      '--disable-updates',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      // Secret storage in memory rather than in the OS keychain, and not
      // optional here. `HOME` points at a temp directory so discovery reads
      // fixtures instead of the real machine, and macOS looks for the login
      // keychain under `$HOME/Library/Keychains` — which that directory has
      // none of. The host's first secret then raises a native *Keychain Not
      // Found* sheet: outside the page, so nothing here can dismiss it, and on
      // the fork it also stops the webview painting. `--password-store` is the
      // wrong lever, being a Linux-only Chromium switch; Electron's
      // `safeStorage` goes to the Keychain on macOS whatever it says.
      '--use-inmemory-secretstorage',
      workspace
    ],
    env: ideEnv({ SQUADRON_SMOKE_IDE: await ide(), SQUADRON_SMOKE_LAUNCH: launchId })
  });
  await app.context().addInitScript(gateHostState);
  hostProcess = app.process();
  const pid = hostProcess.pid;
  console.log(`smoke host ${pid} launched at ${new Date().toISOString()}`);
  hostProcess.once('exit', (code, signal) => {
    console.log(
      `smoke host ${pid} exited: code=${code}, signal=${signal}, at=${new Date().toISOString()}`
    );
  });
  page = await app.firstWindow();
  page.once('close', () => {
    console.log(`smoke host ${pid} page closed at ${new Date().toISOString()}`);
  });
  watchConsole(page);
  // The host restores whatever bounds the machine last left it — and one
  // scenario reads layout against absolute widths. `panel.smoke`'s nav ladder
  // proves a container step only when two rungs straddle it. The shell stays
  // open, so the rungs are the board at the dock's 280px floor, at its 36%
  // width, and at its half-panel ceiling. That span straddles the 480px step
  // on this pin. The 600–900px steps used to be reached by a shut dock, whose
  // board was the whole panel (~880px at 1536, the workbench keeping ~656px
  // of chrome). They are out of reach while the ceiling is half the panel,
  // and widening the window does not bring them back on a 1456px work area.
  // Unpinned, the board was 784 and the ladder lost a step. The ask is cut to
  // the primary display's work area: macOS lets a wider window overhang the
  // right edge (the dock was drawn off-screen on a 1470x956 display) and
  // shoves a taller one back on every launch. A work area down to 1456 wide
  // still leaves the 480px step inside the span. Set in the main process:
  // the window is the host's, not the page's.
  //
  // Typed here rather than from `electron`: the package is the host binary's,
  // not a dependency of ours, so Playwright's `typeof import('electron')`
  // resolves to nothing and every call through it is an unsafe one to the lint.
  type Bounds = { x: number; y: number; width: number; height: number };
  type Windows = {
    getAllWindows(): { setBounds(b: Bounds): void; getBounds(): Bounds }[];
  };
  type Screen = { getPrimaryDisplay(): { workArea: Bounds; workAreaSize: { width: number } } };
  const pin = (): Promise<void> =>
    within(
      app.evaluate((electron) => {
        const { BrowserWindow, screen } = electron as unknown as {
          BrowserWindow: Windows;
          screen: Screen;
        };
        const area = screen.getPrimaryDisplay().workArea;
        BrowserWindow.getAllWindows()[0]?.setBounds({
          x: area.x,
          y: area.y,
          width: Math.min(1536, area.width),
          height: Math.min(1000, area.height)
        });
      }),
      'pinning the window'
    );
  /** What the window is, against the widest it is allowed to be: the ask cut
   *  to the work area, as the pin cuts it. Primary display because the pin
   *  puts the window there. */
  const ruler = (): Promise<{ got: number; want: number }> =>
    within(
      app.evaluate((electron) => {
        const { BrowserWindow, screen } = electron as unknown as {
          BrowserWindow: Windows;
          screen: Screen;
        };
        return {
          got: BrowserWindow.getAllWindows()[0]?.getBounds().width ?? 0,
          want: Math.min(1536, screen.getPrimaryDisplay().workAreaSize.width)
        };
      }),
      'reading the window width'
    );

  await pin();
  enableSlowMo(page);
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  // Pinned again, and read back rather than hoped at. The call above lands
  // before the workbench has laid out, and one barrel run in eleven had the
  // host restore its own bounds over it afterwards: the board read 786px —
  // the unpinned figure recorded above — and the nav ladder straddled three
  // steps instead of four, failing twenty tests later as a layout assertion
  // with nothing in its message about the window. Read-back immediately after
  // `setBounds` proves nothing, since the overwrite is the *later* event, so
  // this wants the width still standing three reads apart.
  await pin();
  let read = await ruler();
  let settled = 0;
  for (let tries = 0; tries < 30 && settled < 3; tries++) {
    await page.waitForTimeout(100);
    read = await ruler();
    if (read.got >= read.want) settled++;
    else {
      // Reported, because a silent retry is indistinguishable from a pin that
      // took first time: three green runs say nothing about this path unless
      // it says so itself.
      console.log(`  (window drifted to ${read.got}px of ${read.want}px, re-pinning)`);
      settled = 0;
      await pin();
    }
  }
  // A boot that cannot pin its own ruler fails here, naming the width, rather
  // than handing every layout case a board it never agreed to.
  if (settled < 3) {
    throw new Error(
      `the host window would not hold its bounds: asked ${read.want}px wide, read ${read.got}px`
    );
  }
  await clearOnboarding();
  await until(
    async () => (await fs.readdir(windows).catch(() => [])).some((name) => !oldClaims.has(name)),
    page
  );
}

/**
 * A second window in this host's instance, on `folder`, as Playwright's second
 * page — what `remote.smoke.ts` needs and nothing else here does, which is why
 * it runs alone: no reset knows this window.
 *
 * Opened the way a person opens one, by the IDE's own CLI with `--new-window`
 * against this profile, and observed on VS Code 1.141.0
 * (`TASK_done_messenger_host.md`, Probe results): the running instance
 * opens it, its extension host loads the development extension with no flag
 * of its own, and it claims under a `sessionId` of its own. The CLI does not
 * inherit `--use-inmemory-secretstorage`, and without it every secret read in
 * that window hangs on the keychain the temp `HOME` lacks.
 */
export async function secondWindow(folder: string): Promise<Page> {
  // The CLI beside the binary: `Contents/MacOS/Code` →
  // `Contents/Resources/app/bin/code`, as the app bundle lays them out.
  const binary = await ide();
  const cli = path.join(path.dirname(path.dirname(binary)), 'Resources', 'app', 'bin', 'code');
  const opened = app.waitForEvent('window', { timeout: 30_000 });
  execFileSync(
    cli,
    [
      '--new-window',
      `--user-data-dir=${path.join(profile, 'data')}`,
      `--extensions-dir=${path.join(profile, 'ext')}`,
      // A window takes the flags of the request that opened it, not the
      // instance's, so each one `launch` passes is passed again.
      '--disable-updates',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--use-inmemory-secretstorage',
      folder
    ],
    { env: ideEnv(), stdio: 'ignore', timeout: 30_000 }
  );
  const second = await opened;
  await second.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await clearOnboarding(second);
  return second;
}

/**
 * Whatever first-run overlay the host laid over the workbench, removed.
 *
 * A fresh `--user-data-dir` is a first run, and a fork's first run is its
 * welcome: a full-window layer that is not the workbench, sits above it and
 * intercepts every click aimed at anything below — including a webview's. It
 * cannot be answered, since answering it means signing in.
 *
 * Matched on the word rather than on a product's own class, so this stays a
 * statement about first runs and not about which IDE is being driven. Stock
 * VS Code has no such node and this is a no-op there.
 */
export async function clearOnboarding(on: Page = page): Promise<void> {
  await on.evaluate(() => {
    document.querySelectorAll('[class*="onboarding"]').forEach((node) => node.remove());
  });
}

after(async () => {
  const results = await Promise.allSettled([
    closeHost(),
    tracker
      ? ownership.bounded(
          new Promise<void>((resolve, reject) => {
            tracker.close((error) => (error ? reject(error) : resolve()));
            tracker.closeAllConnections();
          }),
          3000,
          'tracker close'
        )
      : Promise.resolve()
  ]);
  if (connection) await connection.release();
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result): unknown => result.reason),
      'smoke teardown failed'
    );
});

/** Worker SIGKILL skips hooks; the supervisor owns this tree (task Notes). */
export function closeHost(): Promise<void> {
  if (closingHost) return closingHost;
  if (!launchId || !connection) return Promise.resolve();
  const id = launchId;
  const closingApp = app;
  const work = (async () => {
    await connection.prepare(id);
    try {
      await ownership.bounded(
        Promise.resolve().then(() => closingApp?.close()),
        CLOSE_MS,
        'host close'
      );
    } catch {
      // A disposed Playwright handle does not release supervisor ownership.
    }
    await connection.finish(id);
    if (launchId === id) launchId = undefined;
  })();
  closingHost = work;
  void work.then(
    () => {
      closingHost = undefined;
    },
    () => {
      closingHost = undefined;
    }
  );
  return work;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How far one section got: steps registered, begun, and passed — and whether
 *  it has stopped, which is sticky so a timed-out step finishing late cannot
 *  bring `done` level with `started` and let the next one run. */
type Progress = {
  name: string;
  registered: number;
  started: number;
  done: number;
  stopped: boolean;
  active?: { name: string; began: number; timeout: number };
  capture?: Promise<string | undefined>;
  captureComplete?: boolean;
};
/** The section whose body is being evaluated, so `step` knows where it is. */
let registering: Progress | undefined;

/**
 * A scenario file's `describe`, as a section: it starts on a host reset to the
 * planted state, and its first red skips the rest of it.
 *
 * Before this, a red travelled. Inside a file, each later case waited out its
 * 30 s on a premise that was gone; across files, a leftover `#picker` once
 * failed twenty-nine cases in five later files; and a host Playwright lost took
 * every case after it (2026-09-24). A section that does not finish green leaves
 * `dirty` set, and the next section gets a new host rather than a reload.
 *
 * The reset is this section's **first** `before`, registered ahead of `body`,
 * because node:test runs hooks in registration order and the file's own
 * (`openPanel`, `fixtureSession`, a sign-in) need the reset host.
 * A settings override is written before that section's host starts or reloads.
 */
/** Node reports describe/it on this file. The scenario id is the caller, recorded for resume. */
function rememberSection(name: string): void {
  const record = process.env['SQUADRON_SMOKE_REGISTRATION'];
  if (!record) return;
  const caller = new Error().stack
    ?.split('\n')
    .map((line) => /\((.*):\d+:\d+\)/.exec(line)?.[1])
    .find(
      (file) =>
        file !== undefined &&
        !file.endsWith(`${path.sep}boot.js`) &&
        !file.endsWith(`${path.sep}boot.ts`) &&
        (file.endsWith('.smoke.js') || file.endsWith('.smoke.ts'))
    );
  if (!caller) throw new Error(`smoke section has no scenario file: ${name}`);
  let rows: { file: string; name: string }[] = [];
  try {
    const parsed = JSON.parse(readFileSync(record, 'utf8')) as unknown;
    if (Array.isArray(parsed)) rows = parsed as { file: string; name: string }[];
  } catch {
    rows = [];
  }
  rows.push({ file: caller, name });
  writeFileSync(record, JSON.stringify(rows));
}

export function section(
  name: string,
  body: () => void,
  settings?: () => Record<string, unknown>
): void {
  rememberSection(name);
  describe(name, () => {
    const progress: Progress = { name, registered: 0, started: 0, done: 0, stopped: false };
    // No hook timeout: node:test would abandon a reset still launching, and the
    // next section's would start a second IDE on the same profile. Every await
    // inside is bounded instead.
    before(() =>
      observation.measure('smoke:reset', () => resetHost(settings?.()), { section: name })
    );
    // Registered before body(): observed Node 23 after hooks run in this order,
    // so a timeout's capture precedes the scenario's cleanup and the next reset.
    after(async () => {
      if (progress.done < progress.registered) dirty = true;
      if (progress.started > progress.done && progress.active) {
        progress.stopped = true;
        const abandoned = !progress.captureComplete;
        progress.capture ??= observation.measure(
          'smoke:capture',
          () =>
            evidence(
              progress.name,
              progress.active!.name,
              new Error(`step did not finish within ${progress.active!.timeout} ms`)
            ),
          { section: progress.name }
        );
        const folder = await progress.capture;
        if (folder && abandoned) console.error(`  evidence: ${folder}`);
      }
    });
    registering = progress;
    body();
    registering = undefined;
  });
}

/**
 * One case of a section. Skipped once an earlier one in the same section did
 * not pass — counted, not caught, because a case that hits its timeout never
 * throws here: node:test abandons its promise and moves on.
 */
export function step(name: string, fn: (t: TestContext) => unknown, timeout = STEP_MS): void {
  const progress = registering;
  if (!progress) throw new Error(`step "${name}" is not inside a section`);
  progress.registered++;
  it(name, { timeout }, async (t) => {
    if (progress.stopped || progress.done < progress.started) {
      progress.stopped = true;
      t.skip('env: an earlier step in this section failed');
      return;
    }
    progress.started++;
    const span = observation.start('smoke:body', { section: progress.name, step: name });
    const cancelled = (): void => span.end('cancelled');
    t.signal.addEventListener('abort', cancelled, { once: true });
    progress.active = { name, began: Date.now(), timeout };
    try {
      await fn(t);
      span.end(t.signal.aborted ? 'cancelled' : 'passed');
      progress.done++;
    } catch (error) {
      span.end(t.signal.aborted ? 'cancelled' : 'failed');
      progress.stopped = true;
      // Leave time for node:test to report the original error before its timeout.
      const budget = Math.max(
        0,
        Math.min(3000, progress.active.timeout - (Date.now() - progress.active.began) - 250)
      );
      progress.capture ??= observation.measure(
        'smoke:capture',
        () => evidence(progress.name, name, error, budget),
        { section: progress.name, step: name }
      );
      const folder = await progress.capture;
      progress.captureComplete = true;
      if (folder) {
        const pointer = `\n  evidence: ${folder}`;
        try {
          if (error instanceof Error) {
            // Playwright and assert may have materialised stack before message changes.
            if (error.stack) error.stack = error.stack.replace(/(?=\n|$)/, pointer);
            error.message += pointer;
          } else console.error(pointer);
        } catch {
          console.error(pointer);
        }
      }
      throw error;
    } finally {
      t.signal.removeEventListener('abort', cancelled);
    }
  });
}

/** Page events cross both webview frames on stock VS Code 1.140.0 (2026-10-02).
 *  Injected evaluate lines have no source URL; do not invent their frame. */
let consoleLines: string[] = [];
function watchConsole(on: Page): void {
  const lines: string[] = [];
  consoleLines = lines;
  const remember = (line: string): void => {
    lines.push(`${new Date().toISOString()} ${line}`);
    if (lines.length > 500) lines.shift();
  };
  on.on('load', () => {
    lines.length = 0;
  });
  on.on('console', (message) =>
    remember(`${message.type()} ${message.location().url || '<unknown frame>'} ${message.text()}`)
  );
  on.on('pageerror', (error) => remember(`pageerror ${error.stack ?? error.message}`));
}

let captures = 0;
/** Capture only the host that failed. Each piece is bounded independently; a
 *  missing or wedged surface must not replace the test's original error. */
async function evidence(
  sectionName: string,
  stepName: string,
  error: unknown,
  budget = 3000
): Promise<string | undefined> {
  if (budget <= 0) return undefined;
  const on = page;
  const sourceHome = home;
  const sourceLogs = path.join(profile, 'data', 'logs');
  const sourceArgv = argvLog;
  const lines = consoleLines.join('\n');
  const slug = (name: string): string =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'unnamed';
  let folder: string | undefined;
  const deadline = Date.now() + budget;
  const missing: string[] = [];
  const piece = async (name: string, work: () => Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('capture deadline')),
            Math.max(1, Math.min(1500, deadline - Date.now()))
          );
        })
      ]);
    } catch (failure) {
      missing.push(`${name}: ${String(failure)}`);
    } finally {
      clearTimeout(timer);
    }
  };
  const copyPiece = async (name: string, source: string, target: string): Promise<void> => {
    try {
      await capture.copy(source, target, Math.max(1, Math.min(1500, deadline - Date.now())));
    } catch (failure) {
      missing.push(`${name}: ${String(failure)}`);
    }
  };
  try {
    await piece('directory', async () => {
      const root = process.env['SQUADRON_RUN'] ?? path.join(connection.paths.root, 'evidence');
      folder = path.join(
        root,
        'smoke',
        `${String(++captures).padStart(2, '0')}-${slug(sectionName)}--${slug(stepName)}`
      );
      await fs.mkdir(folder, { recursive: true });
    });
    if (missing.length || !folder) return undefined;
    const target = folder;
    await Promise.all([
      piece('error.txt', () =>
        fs.writeFile(
          path.join(target, 'error.txt'),
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        )
      ),
      piece('screenshot.png', () =>
        on.screenshot({ path: path.join(target, 'screenshot.png'), timeout: 1500 })
      ),
      piece('panel.html', async () => {
        const doc = await on
          .frameLocator('iframe.webview.ready')
          .last()
          .frameLocator('iframe#active-frame')
          .locator('html')
          .evaluate((el) => el.outerHTML, undefined, { timeout: 1500 });
        await fs.writeFile(path.join(target, 'panel.html'), doc);
      }),
      piece('workbench.txt', async () => {
        const text = await on
          .locator(
            '.monaco-dialog-box:visible, .notifications-toasts:visible, .quick-input-widget:visible'
          )
          .allInnerTexts();
        await fs.writeFile(path.join(target, 'workbench.txt'), text.join('\n'));
      }),
      piece('console.log', () => fs.writeFile(path.join(target, 'console.log'), lines)),
      copyPiece('host-logs/', sourceLogs, path.join(target, 'host-logs')),
      copyPiece('home/', sourceHome, path.join(target, 'home')),
      piece('claude-argv.jsonl', () =>
        fs.copyFile(sourceArgv, path.join(target, 'claude-argv.jsonl'))
      )
    ]);
    if (missing.length)
      await piece('capture.log', () =>
        fs.writeFile(path.join(target, 'capture.log'), missing.join('\n'))
      );
  } catch {
    /* even folder creation is best-effort */
  }
  return folder;
}

/**
 * The host as a section should find it: nothing open, `HOME` as planted, the
 * launch settings, and none of an earlier section's children.
 *
 * A reload when the last section passed, and a new host when it did not, when
 * the old one is gone, or when the reload itself cannot finish — a host held by
 * a custom-style modal or a wedged drag is alive and still unresettable, and
 * one path for "dead" and "wedged" is simpler than telling them apart.
 */
async function resetHost(settings?: Record<string, unknown>): Promise<void> {
  const selectedSettings = { ...launchSettings, ...settings };
  if (fresh) {
    fresh = false;
    await observation.measure('smoke:launch', () => launch(selectedSettings));
    return;
  }
  for (const hook of resetHooks) hook();
  const proc = hostProcess;
  const alive = proc && !page.isClosed() && proc.exitCode === null && proc.signalCode === null;
  if (alive && !dirty) {
    const reloading = reload(selectedSettings);
    const outcome = await observation
      .measure('smoke:reload', () => ownership.bounded(reloading, RELOAD_MS, 'host reload'))
      .then(() => 'reloaded')
      .catch((error: unknown) => String(error).split('\n')[0] ?? '');
    if (outcome === 'reloaded') return;
    console.log(`  (reset by reload failed: ${outcome}; relaunching)`);
  }
  dirty = false;
  await closeHost();
  restoreHome();
  await fs.rm(path.join(home, '.vscode-shared'), { recursive: true, force: true });
  // Every claim is the dead host's now, and one is live on its timestamp for
  // `CLAIM_STALE_MS` — a second window to anything that routes by claim.
  await fs.rm(path.join(home, '.squadron', 'windows'), { recursive: true, force: true });
  await fs.rm(path.join(profile, 'data'), { recursive: true, force: true });
  await observation.measure('smoke:relaunch', () => launch(selectedSettings));
}

/**
 * Reset in place: the window reloaded over a restored `HOME`.
 *
 * Everything the reload would carry across is shut first. Editors come back
 * after a reload, and a dev server's terminal would too without
 * `enablePersistentSessions: false` — measured 2026-09-24, the server still
 * holding its port with nothing left that could stop it.
 */
async function reload(settings: Record<string, unknown>): Promise<void> {
  // Held, not read through the module binding: an abandoned reload must not
  // drive the page a relaunch put there.
  const p = page;
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await p.mouse.up();
  await p.keyboard.press(RESET_KEYS.killTerminals.chord);
  await p.keyboard.press(RESET_KEYS.closePanel.chord);
  await p.keyboard.press(RESET_KEYS.closeEditors.chord);
  await writeJson(path.join(profile, 'data', 'User', 'settings.json'), settings);
  restoreHome();

  const windows = path.join(home, '.squadron', 'windows');
  const claims = async (): Promise<string[]> => fs.readdir(windows).catch(() => []);
  const old = new Set(await claims());
  await Promise.all([
    p.waitForEvent('load', { timeout: RELOAD_MS }),
    p.keyboard.press(RESET_KEYS.reload.chord)
  ]);
  await p.waitForSelector('.monaco-workbench', { timeout: RELOAD_MS });
  await clearOnboarding(p);

  // The new host's claim is the witness that it activated. The old one is
  // removed by hand: `deactivate()` leaves it, and it reads as a second live
  // window for `CLAIM_STALE_MS` (90 s) — measured 2026-09-24.
  await until(async () => (await claims()).some((name) => !old.has(name)), p);
  await Promise.all([...old].map((name) => fs.rm(path.join(windows, name), { force: true })));

  // What the old host wrote between the restore and its own `deactivate()`.
  // Logged rather than failed: a record naming a dead pid is read as dead.
  // Empty activation directories are expected; only file drift is reported.
  const drift = seedFiles.drift(seed, home, HOST_OWNED);
  if (drift.length > 0) {
    console.log(`  (reset left ${drift.length} off the seed: ${drift.join(', ')})`);
  }
}

/** `HOME` put back as planted, bar what the host writes at activation. */
function restoreHome(): void {
  seedFiles.restore(seed, home, HOST_OWNED);
}

/** Poll until `ready`, or fail naming how long it waited — or at once, when
 *  the page it is waiting on has been closed under it. */
async function until(ready: () => Promise<boolean>, on: Page): Promise<void> {
  const deadline = Date.now() + RELOAD_MS;
  while (!(await ready())) {
    if (on.isClosed()) throw new Error('the page closed while waiting');
    if (Date.now() > deadline) throw new Error(`not ready after ${RELOAD_MS} ms`);
    await sleep(100);
  }
}

/** `work`, or a failure naming it once `RELOAD_MS` has passed — for the one
 *  kind of await here Playwright puts no timeout on, a main-process evaluate. */
async function within<T>(work: Promise<T>, what: string): Promise<T> {
  return ownership.bounded(work, RELOAD_MS, what);
}

/** Every launch line `fake-cli.ts` was started with, one JSON array per line —
 *  the only witness to what a flag did after it left the panel. */
export const argvLogPath = (): string => argvLog;
/** Where the fake `claude` writes each spawn's environment. */
export const envLogPath = (): string => envLog;

/** The fixture `HOME`, for a scenario that needs to read what the host wrote —
 *  the ports store, whose key shape is the thing under test rather than
 *  something the panel ever displays. */
export const homeDir = (): string => home;

/**
 * Smoke's one home composer, for this worker and every child it starts. Both
 * variables, because win32's `os.homedir()` reads `USERPROFILE`. Not
 * `helpers.homeEnv`: that refuses a home outside its temp base, and this one
 * lives under the run root, and it would move the temp directory too.
 */
export function homeVars(): Record<'HOME' | 'USERPROFILE', string> {
  // eslint-disable-next-line squadron/home-write -- the composer the rule points at
  return { HOME: home, USERPROFILE: home };
}

/** The panel's document, behind VS Code's two webview iframes. */
export const panel = () =>
  page.frameLocator('iframe.webview.ready').last().frameLocator('iframe#active-frame');

declare global {
  interface Window {
    /** Set by `gateHostState` once the gate is in front of a `message` listener. */
    squadronGateArmed?: boolean;
    /** Set by `holdingHostState` while it holds; `held` is the newest push it kept. */
    squadronHold?: { held?: unknown };
  }
}

/**
 * Keep the host's own `state` pushes off the panel while `measure` reads a
 * fixture the scenario pushed itself. A push landing mid-measure repaints the
 * real board over the fixture: the host pushes while a fresh panel settles and
 * re-sends an unchanged state every 15 s, so a measure lasting seconds meets one.
 *
 * Only a trusted event is held — the host's `postMessage` is one, a scenario's
 * `dispatchEvent` is not — so the fixture's own pushes always land. The newest
 * push held is replayed on release: the host re-sends only on a change or after
 * those 15 s, so a dropped one leaves the fixture on screen for the next step.
 */
export async function holdingHostState<T>(measure: () => Promise<T>): Promise<T> {
  // One handle for both ends, so the release reaches the frame that was held
  // even if another webview has become `panel()`'s last one meanwhile.
  const body = await panel().locator('body').elementHandle();
  if (!body) throw new Error('no panel to hold');
  const armed = await body.evaluate(() => {
    if (!window.squadronGateArmed) return false;
    window.squadronHold = {};
    return true;
  });
  if (!armed) throw new Error('the host-state gate is not armed in the panel frame');
  try {
    return await measure();
  } finally {
    // A panel already gone takes the hold with it, and its error is not this one.
    await body
      .evaluate(() => {
        const held = window.squadronHold?.held;
        window.squadronHold = undefined;
        if (held !== undefined) window.dispatchEvent(new MessageEvent('message', { data: held }));
      })
      .catch(() => undefined);
    await body.dispose().catch(() => undefined);
  }
}

/**
 * The gate `holdingHostState` closes, put ahead of the panel's own `message`
 * listener — the one position from which it can stop a push. Chromium calls a
 * window's listeners in the order they were added, capture or not, so a hold a
 * scenario adds after the bundle has loaded runs after the bundle has painted.
 *
 * An init script cannot just add the gate: VS Code fills the webview frame with
 * `document.open`, which erases every listener on its window and keeps its
 * globals. So it wraps `addEventListener` and adds the gate in front of each
 * `message` listener the frame's window takes; adding the same listener twice is
 * a no-op, so the gate keeps the first slot it gets. Every frame below the
 * workbench takes it, and only one being held holds anything: the panel's
 * frame starts as `about:blank`, so no URL names it when this runs.
 */
function gateHostState(): void {
  if (window === window.top) return;
  const gate = (event: Event): void => {
    const hold = window.squadronHold;
    if (!hold || !event.isTrusted || !(event instanceof MessageEvent)) return;
    const data = event.data as { type?: unknown } | null;
    if (data?.type !== 'state') return;
    hold.held = data;
    event.stopImmediatePropagation();
  };
  // Called back with an explicit receiver below, which `unbound-method` cannot see.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (this === window && type === 'message') {
      add.call(window, 'message', gate, true);
      window.squadronGateArmed = true;
    }
    add.call(this, type, listener, options);
  };
}

/**
 * The panel, open — for every scenario file that needs one but is not the file
 * testing how it gets opened.
 *
 * Idempotent on purpose: every reset shuts the panel, so a section's `before`
 * opens it, and a later step in the same section calling this again must not
 * press the palette a second time — a second press toggles nothing useful. So:
 * open only if `#cards` is not already there.
 */
export async function openPanel(): Promise<void> {
  const already = await panel()
    .locator('#cards')
    .count()
    .catch(() => 0);
  if (already > 0) return;
  await clearOnboarding();
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.type('Squadron: Show Sessions Overview');
  await page.keyboard.press('Enter');
  await panel().locator('#cards').waitFor({ timeout: 30_000 });
  await passOnboarding();
}

/** Shut every editor, the panel's included — which disposes its webview, so
 *  the next `openPanel()` is a new document fed by the same host. */
export async function closeEditors(): Promise<void> {
  await page.keyboard.press(RESET_KEYS.closeEditors.chord);
  await panel().locator('#cards').waitFor({ state: 'detached', timeout: 30_000 });
}

/**
 * Onboarding opens over every fresh profile, as a modal that takes every click
 * aimed at the board. It is decided on the push that first carries accounts —
 * the same one that swaps the nav's plain usage span for `.limwrap` — so once
 * that is drawn the dialog is up or never will be. Continue then Skip writes
 * `onboarding.done` to this profile's globalState, which a reset's reload
 * keeps, so a host pays this once. With no CLI installed Continue is held, and
 * the dialog is left for `onboarding.smoke.ts`, the section that sets that up.
 */
export async function passOnboarding(): Promise<void> {
  const accounts = await panel()
    .locator('#nav .limwrap')
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!accounts) return;
  const dialog = panel().locator('#onboarding[open]');
  if ((await dialog.count()) === 0) return;
  const proceed = dialog.locator('#onboarding-continue');
  if (await proceed.isDisabled()) return;
  await proceed.click();
  await dialog.locator('#onboarding-skip').click();
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
}
