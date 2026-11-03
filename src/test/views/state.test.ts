import { ticketPriority, ticketState, ticketSourceView } from '../ticket_fixtures';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Session } from '../../core/model';
import { ReadWorkflow, WorkflowEdit } from '../../core/workflows/workflows';
import {
  buildState,
  commitOwnedBoard,
  ownedLifecycleKey,
  StateInputs,
  stateKey,
  toWorkflowView
} from '../../ui/state';
import { openPanel, stateMessage, threadView } from '../harness';
import * as warmRows from '../../ui/warm_rows';
import * as cacheTtl from '../../core/cache_ttl';
import { DEFAULT_WARM_POLICY, type WarmPolicy } from '../../core/warm_policy';

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid',
  cwd: '/work/app',
  name: '',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: 0,
  transcript: '',
  ...over
});

const edit = (over: Partial<WorkflowEdit> = {}): WorkflowEdit => ({
  id: 'broken',
  label: 'Broken',
  path: '/home/u/.squadron/workflows/broken.json',
  reasons: ['review needs ship, which is not an earlier step'],
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan' },
    { id: 'review', label: 'Review', prompt: 'review', needs: ['ship'] }
  ],
  ...over
});

const workflow = (over: Partial<ReadWorkflow> = {}): ReadWorkflow => ({
  id: 'ship',
  label: 'Ship it',
  path: '/home/u/.squadron/workflows/ship.json',
  steps: [
    {
      id: 'plan',
      label: 'Plan',
      uses: '/plan',
      prompt: 'should not cross',
      check: { command: 'true' }
    },
    { id: 'build', label: 'Build', prompt: 'build it' }
  ],
  ...over
});

const base = (over: Partial<StateInputs> = {}): StateInputs => ({
  sessions: [],
  workspaceFolder: undefined,
  folderRoots: new Map(),
  arrangements: new Map(),
  workflowOrder: undefined,
  thread: undefined,
  machine: undefined,
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
  theme: 'follow',
  model: '',
  efforts: {},
  models: [],
  tickets: undefined,
  ticketSource: undefined,
  workflows: [],
  workflowEdits: [],
  skills: new Map(),
  now: 0,
  ...over
});

describe('default launch directory', () => {
  it('uses the main folder rather than an alphabetically earlier session folder', () => {
    const message = buildState(
      base({ workspaceFolder: '/work/z-app', sessions: [session({ cwd: '/work/a-other' })] })
    );
    assert.equal(message.defaultCwd, '/work/z-app');
  });

  it('keeps the opened worktree directory even when groups use its repo root', () => {
    const workspaceFolder = '/work/z-app/.worktrees/feature';
    const message = buildState(
      base({
        workspaceFolder,
        folderRoots: new Map([[workspaceFolder, '/work/z-app']]),
        sessions: [session({ cwd: '/work/a-other' })]
      })
    );
    assert.deepEqual(
      message.groups.map((group) => group.cwd),
      ['/work/z-app', '/work/a-other']
    );
    assert.equal(message.defaultCwd, workspaceFolder);
  });

  it('does not borrow a sorted session folder when no workspace is open', () => {
    const message = buildState(
      base({
        sessions: [session({ cwd: '/work/z-other' }), session({ pid: 200, cwd: '/work/a-other' })]
      })
    );
    assert.deepEqual(
      message.groups.map((group) => group.cwd),
      ['/work/a-other', '/work/z-other']
    );
    assert.equal(message.defaultCwd, undefined);
    assert.equal(buildState(base()).defaultCwd, undefined);
  });

  it('keeps older fixture pushes compatible without a default launch directory', (t) => {
    const p = openPanel(t);
    const legacy = stateMessage(
      buildState(base({ sessions: [session({ name: 'Existing session' })] })).groups
    );
    delete legacy.defaultCwd;
    p.push(legacy);
    assert.equal(p.window.document.querySelector('.card .name')?.textContent, 'Existing session');
    assert.equal(stateMessage([]).defaultCwd, undefined);
    assert.equal(stateMessage([], { defaultCwd: '/work/app' }).defaultCwd, '/work/app');
  });
});

/**
 * What the panel compares two pushes by, so it can skip the ones that changed
 * nothing (`TASK_done_panel_repaint_cost.md`). Two claims, and they pull
 * against each other: the machine readings must not count, and *everything else*
 * must — a field this quietly ignores is a field the panel would stop
 * repainting, with no failure anywhere to say so.
 */
describe('stateKey', () => {
  const state = (over: Partial<StateInputs> = {}) => buildState(base(over));

  it('is the same for two polls that changed nothing', () => {
    assert.equal(stateKey(state()), stateKey(state()));
  });

  it('ignores the load and the memory, which move on every poll by nature', () => {
    // The reason this function exists. Comparing these would mean no two
    // messages ever compared equal and the dedupe never fired once.
    const quiet = state({ machine: { cpu: 4, memory: { used: 1, total: 8 } } });
    const busy = state({ machine: { cpu: 91, memory: { used: 7, total: 8 } } });
    assert.equal(stateKey(quiet), stateKey(busy));
  });

  it('notices a reading arriving, which is the end of a wait the nav draws', () => {
    // Skipped for UNCHANGED_MS, the first CPU sample on an idle board sat behind
    // a loading face for 15s. The shape is news; the values above are not.
    const read = { used: 1, total: 8 };
    const shapes = [
      state({}),
      state({ machine: { cpu: 4 } }),
      state({ machine: { memory: read } }),
      state({ machine: { cpu: 4, memory: read } }),
      state({ machine: { cpu: 4, memory: null } })
    ].map(stateKey);
    assert.equal(new Set(shapes).size, shapes.length, 'two machine shapes shared a key');
  });

  it('notices a session going from idle to busy', () => {
    const idle = state({ sessions: [session({ status: 'idle' })] });
    const working = state({ sessions: [session({ status: 'busy' })] });
    assert.notEqual(stateKey(idle), stateKey(working));
  });

  it('notices a session arriving and one leaving', () => {
    const one = state({ sessions: [session()] });
    const two = state({ sessions: [session(), session({ pid: 200, sessionId: 'other' })] });
    assert.notEqual(stateKey(one), stateKey(two));
    assert.notEqual(stateKey(two), stateKey(state({ sessions: [] })));
  });

  it('notices the dock moving, which is most of the weight on the wire', () => {
    const before = state({ thread: threadView({ status: 'idle' }) });
    const after = state({ thread: threadView({ status: 'busy' }) });
    assert.notEqual(stateKey(before), stateKey(after));
  });

  it('notices the coffee being refilled', () => {
    // `awake` was the other field that differed on every push, and it was fixed
    // rather than excluded: what rides now is an epoch that moves on a refill.
    const early = state({ cafe: true, awake: { reason: 'drinking', until: 1000, sessions: 1 } });
    const later = state({ cafe: true, awake: { reason: 'drinking', until: 9000, sessions: 1 } });
    assert.notEqual(stateKey(early), stateKey(later));
  });

  it('notices a file open for repair arriving', () => {
    assert.notEqual(stateKey(state()), stateKey(state({ workflowEdits: [edit()] })));
  });

  it('notices a setting being turned off', () => {
    assert.notEqual(
      stateKey(state({ soundLevel: 'normal' })),
      stateKey(state({ soundLevel: 'off' }))
    );
  });
});

describe('toWorkflowView', () => {
  it('keeps id, label and per-step id/label/prompt for the editor', () => {
    assert.deepEqual(toWorkflowView(workflow()), {
      id: 'ship',
      label: 'Ship it',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'should not cross' },
        { id: 'build', label: 'Build', prompt: 'build it' }
      ]
    });
  });

  // Without it a reopened file is seeded by run order, and the saved order is lost.
  it('carries the lane order', () => {
    const view = toWorkflowView({ ...workflow(), lanes: ['s2', 's1'] });
    assert.deepEqual(view.lanes, ['s2', 's1']);
  });

  it('does not carry path or check onto the wire', () => {
    const view = toWorkflowView(workflow());
    assert.deepEqual(Object.keys(view).sort(), ['id', 'label', 'steps']);
    assert.deepEqual(Object.keys(view.steps[0]!).sort(), ['id', 'label', 'prompt']);
  });

  it('does not carry a declared output or check onto the wire', () => {
    const view = toWorkflowView(
      workflow({
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'p', output: 'plan.md', check: { command: 'true' } }
        ]
      })
    );
    assert.deepEqual(Object.keys(view.steps[0] ?? {}).sort(), ['id', 'label', 'prompt']);
  });

  it('carries lane, needs, model, effort and brand, and drops empties', () => {
    const view = toWorkflowView(
      workflow({
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'p', lane: '', needs: [] },
          {
            id: 'build',
            label: 'Build',
            prompt: 'b',
            lane: 's1',
            needs: ['plan'],
            brand: 'claude',
            model: 'opus-5',
            effort: 'high',
            check: { command: 'true' }
          }
        ]
      })
    );
    assert.deepEqual(view.steps[0], { id: 'plan', label: 'Plan', prompt: 'p' });
    assert.deepEqual(view.steps[1], {
      id: 'build',
      label: 'Build',
      prompt: 'b',
      lane: 's1',
      needs: ['plan'],
      brand: 'claude',
      model: 'opus-5',
      effort: 'high'
    });
  });
});

describe('buildState', () => {
  /**
   * The café's two fields, carried rather than dropped.
   *
   * This is here because they *were* dropped, and everything else was green:
   * `panel.ts` spread them into the inputs, `buildState` copied field by field
   * and named neither, and an object spread gets no excess-property check from
   * TypeScript — so the compiler had nothing to say and the panel drew no cup
   * at all. Every jsdom scenario pushes a `StateMessage` directly, so none of
   * them crossed this function.
   *
   * Assert the whole hop for any field only the host can supply.
   */
  it('carries the café through to the wire', () => {
    const awake = { reason: 'drinking' as const, until: 42, sessions: 2 };
    const message = buildState(base({ cafe: true, awake, cafeAt: { x: 12, y: 34 } }));
    assert.deepEqual(message.awake, awake);
    assert.deepEqual(message.cafeAt, { x: 12, y: 34 });
    assert.equal(message.cafe, true);
  });

  /**
   * The gear's two fields, on the same "assert the whole hop" rule the café
   * case states — the host is the only supplier, every jsdom scenario pushes a
   * `StateMessage` directly, and an object spread gets no excess-property
   * check. Dropped here, the gear would read `default` forever and every draft
   * would open on the catalog's first row with nothing red.
   */
  it('carries the default model and its window through to the wire', () => {
    const message = buildState(base({ model: 'haiku', contextWindow: 200_000 }));
    assert.equal(message.model, 'haiku');
    assert.equal(message.contextWindow, 200_000);
  });

  /** Unset is `''` and no window — a fresh profile, which is what almost every
   *  reader has, and not the same as "the first window". */
  it('carries an unset default as the empty string and no window', () => {
    const message = buildState(base());
    assert.equal(message.model, '');
    assert.equal(message.contextWindow, undefined);
  });

  it('leaves the café off the wire when the host supplies none', () => {
    // Absent is what takes the cup away — off this platform, or setting off.
    const message = buildState(base({ cafe: false }));
    assert.equal(message.awake, undefined);
    assert.equal(message.cafeAt, undefined);
  });

  it('always returns type state and the scalar flags', () => {
    const message = buildState(
      base({
        orchestrators: true,
        skipPermissions: true,
        executionCapture: true,
        soundLevel: 'loud',
        devServers: true,
        theme: 'ink'
      })
    );
    assert.equal(message.type, 'state');
    assert.equal(message.orchestrators, true);
    assert.equal(message.skipPermissions, true);
    assert.equal(message.executionCapture, true);
    assert.equal(message.soundLevel, 'loud');
    assert.equal(message.devServers, true);
    assert.equal(message.theme, 'ink');
    assert.deepEqual(message.groups, []);
    assert.equal(message.thread, undefined);
    // Mapped arrays, possibly empty — matches refresh()'s post today.
    assert.deepEqual(message.workflows, []);
    assert.deepEqual(message.workflowEdits, []);
  });

  it('attaches a thread when the host built one', () => {
    const thread: ThreadView = {
      pid: 100,
      name: 'x',
      fullCwd: '/work/app',
      status: 'idle',
      reading: { word: 'idle', tally: 'idle' },
      canControl: true,
      startedAt: 0,
      updatedAt: 0,
      cacheTtlMs: 60 * 60_000,
      exchanges: [],
      canSend: true,
      canAttach: true,
      who: 'claude'
    };
    const message = buildState(base({ thread }));
    assert.equal(message.thread, thread);
  });

  it('trims workflows to the wire shape', () => {
    const message = buildState(base({ workflows: [workflow()] }));
    assert.deepEqual(message.workflows, [
      {
        id: 'ship',
        label: 'Ship it',
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'should not cross' },
          { id: 'build', label: 'Build', prompt: 'build it' }
        ]
      }
    ]);
  });

  it('puts the workflows in the reader’s order', () => {
    const list = [
      workflow({ id: 'alpha', label: 'Alpha' }),
      workflow({ id: 'zulu', label: 'Zulu' }),
      workflow({ id: 'mike', label: 'Mike' })
    ];
    const message = buildState(
      base({
        workflows: list,
        workflowOrder: {
          schema: 1,
          updatedAt: 0,
          order: ['zulu', 'mike']
        }
      })
    );
    // Stated first in the order stated; Alpha was never placed, so it appends.
    assert.deepEqual(
      message.workflows?.map((w) => w.id),
      ['zulu', 'mike', 'alpha']
    );
  });

  it('sorts by label when the reader has stated nothing', () => {
    const message = buildState(
      base({
        workflows: [
          workflow({ id: 'zulu', label: 'Zulu' }),
          workflow({ id: 'alpha', label: 'Alpha' })
        ]
      })
    );
    assert.deepEqual(
      message.workflows?.map((w) => w.id),
      ['alpha', 'zulu']
    );
  });

  it('projects a repair file beside the runnable list', () => {
    const message = buildState(
      base({
        workflows: [workflow({ id: 'alpha', label: 'Alpha' })],
        workflowEdits: [edit({ id: 'zulu', label: 'Zulu' }), edit({ id: 'mike', label: 'Mike' })],
        workflowOrder: {
          schema: 1,
          updatedAt: 0,
          order: ['zulu', 'mike', 'alpha']
        }
      })
    );
    assert.deepEqual(
      message.workflows?.map((w) => w.id),
      ['alpha']
    );
    assert.deepEqual(Object.keys(message.workflows?.[0] ?? {}).sort(), ['id', 'label', 'steps']);
    assert.deepEqual(
      message.workflowEdits?.map((w) => w.id),
      ['zulu', 'mike']
    );
    const shown = message.workflowEdits?.[0];
    assert.equal(shown?.repair, true);
    assert.deepEqual(Object.keys(shown ?? {}).sort(), [
      'id',
      'label',
      'reasons',
      'repair',
      'steps'
    ]);
    assert.equal(shown && 'path' in shown, false);
  });

  it('passes tickets and linear through', () => {
    const tickets: TicketView[] = [
      {
        scopeId: 'team-a',
        key: 't1',
        identifier: 'AV-1',
        title: 'One',
        url: 'https://linear.app/x',
        priority: ticketPriority(0),
        state: ticketState('Todo')
      }
    ];
    const ticketSource: TicketSourceStatus = { ...ticketSourceView(), linked: true };
    const message = buildState(base({ tickets, ticketSource }));
    assert.equal(message.tickets, tickets);
    assert.equal(message.ticketSource, ticketSource);
  });

  it('keeps this window\u2019s folder on top', () => {
    // The sort reads `workspaceFolder`, which comes from the host and is never
    // pending, so there is no poll in which the other repo takes the top of the
    // board. The folder sorts *after* the session's on purpose: a tie falling
    // through to the path is the reposition this test exists to stop.
    const sessions = [session({ pid: 7, cwd: '/work/alpha' })];
    const message = buildState(base({ sessions, workspaceFolder: '/work/zulu' }));
    assert.equal(message.groups[0]?.cwd, '/work/zulu');
  });

  it('puts a session into a group (wiring only, not the grouping rules)', () => {
    const sessions = [session({ pid: 42, cwd: '/work/app', name: 'agent' })];
    const message = buildState(base({ sessions, workspaceFolder: '/work/app' }));
    assert.ok(message.groups.length >= 1);
    const pids = message.groups.flatMap((g) => g.sessions.map((s) => s.pid));
    assert.ok(pids.includes(42));
  });

  it('carries the accounts list through, rows and readings alike', () => {
    const usage: UsageView = {
      windows: [{ id: 'session', short: '5h', pct: 10, resetsAt: Date.now() + 3600_000 }]
    };
    const accounts: AccountView[] = [
      {
        brand: 'claude',
        name: 'Claude',
        mark: 'claude',
        state: 'signed_in',
        detail: 'Claude',
        usage
      }
    ];
    // One carrier: the row states the brand, whether it is signed in, and what
    // its windows read. A second top-level field meant Claude by decree and had
    // one reader left, on a branch the host could no longer reach. What is
    // asserted here is only the pass-through — which row gets which reading is
    // `walkUsage`'s, and is asserted there.
    const message = buildState(base({ accounts }));
    assert.deepEqual(message.accounts, accounts);
  });

  it('opens onboarding once the first auth poll lands, installed CLI or not', () => {
    const missing: AccountView = {
      brand: 'claude',
      name: 'Claude',
      mark: 'claude',
      state: 'not_installed',
      detail: 'Not installed'
    };
    assert.equal(buildState(base()).onboarding, false);
    assert.equal(buildState(base({ accounts: [missing] })).onboarding, true);
    assert.equal(
      buildState(base({ accounts: [{ ...missing, state: 'signed_in' }] })).onboarding,
      true
    );
  });

  it('keeps onboarding shut once this install has finished it', () => {
    const missing: AccountView = {
      brand: 'claude',
      name: 'Claude',
      mark: 'claude',
      state: 'not_installed',
      detail: 'Not installed'
    };
    assert.equal(buildState(base({ accounts: [missing], onboardingDone: true })).onboarding, false);
  });
});

/**
 * The webview announcing itself, which is what makes the post dedupe safe.
 *
 * `panel.ts` skips a state push identical to the last one it sent — sound only
 * while the document it sent that one to is still the document on screen. The
 * host outlives the webview: a tab dragged to another editor group, `Developer:
 * Reload Webviews` and a renderer crash all rebuild it with `panel.ts` running
 * throughout. Without this the new document would sit empty until the state
 * happened to change, which on a quiet board is the 15 s `UNCHANGED_MS` floor.
 *
 * The host half — clearing the comparison and refreshing — imports `vscode` and
 * is hand-checked; this is the claim that can be made headlessly, and it is the
 * half that would silently stop being true.
 */
describe('the webview announces a fresh document', () => {
  it('posts ready as it loads, before any scenario touches it', (t) => {
    const p = openPanel(t);
    assert.deepEqual(
      p.onLoad.filter((m) => m.type === 'ready'),
      [{ type: 'ready' }],
      'the bundle sent no ready on load, so a reloaded webview would stay empty'
    );
  });

  it('sends it once, not on every push', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([]));
    p.push(stateMessage([]));
    assert.deepEqual(
      p.posted.filter((m) => m.type === 'ready'),
      []
    );
  });
});

describe('buildState carries the machine skills', () => {
  it('states the window discovery union without sessions', () => {
    const message = buildState(
      base({
        editorSkills: ['design', 'ponytail']
      })
    );
    assert.deepEqual(message.skills, ['design', 'ponytail']);
  });

  it("states each directory's skills on only its group", () => {
    const message = buildState(
      base({
        sessions: [session(), session({ pid: 200, sessionId: 'other', cwd: '/work/other' })],
        skills: new Map([
          ['/work/app', { claude: ['ponytail'], codex: ['shared'] }],
          ['/work/other', { grok: ['design'] }]
        ])
      })
    );
    assert.deepEqual(
      message.groups.map((group) => [group.cwd, group.skillsByBrand]),
      [
        ['/work/app', { claude: ['ponytail'], codex: ['shared'] }],
        ['/work/other', { grok: ['design'] }]
      ]
    );
  });

  it('omits the field when nothing is known, so the editor draws no trigger', () => {
    assert.equal(buildState(base()).skills, undefined);
  });
});

/**
 * The warm list paints what the scheduler decided and nothing it re-derives,
 * so the hop from `warmDue` to the card is asserted here: every jsdom scenario
 * pushes a `CardView.warm` it wrote itself.
 */
describe("buildState decides each card's warm row", () => {
  const MIN = 60_000;
  const port = {
    status: 'idle' as const,
    running: false,
    queued: 0,
    pending: 0,
    exited: false,
    inFlight: false
  };
  const warmOf = (message: ReturnType<typeof buildState>, pid: number) =>
    message.groups.flatMap((g) => g.sessions).find((c) => c.pid === pid)?.warm;

  it('states the next ping the scheduler would send, and the window it ends at', () => {
    const now = 1_000 * MIN;
    const message = buildState(
      base({
        now,
        warmCache: true,
        sessions: [
          session({
            warm: true,
            warmPort: port,
            contextPct: 20,
            updatedAt: now - 10 * MIN,
            cache: { ttlMs: 60 * MIN, source: 'measured', at: now - 10 * MIN }
          })
        ]
      })
    );
    assert.equal(message.warmCache, true);
    assert.deepEqual(warmOf(message, 100), {
      on: true,
      ttlMs: 60 * MIN,
      source: 'measured',
      nextAt: now + 45 * MIN,
      endsAt: now + 110 * MIN,
      held: undefined
    });
  });

  it('holds a session no port reaches, on the lifetime its brand would have', () => {
    const message = buildState(
      base({ now: 5 * MIN, sessions: [session({ brand: 'grok', background: true })] })
    );
    assert.deepEqual(warmOf(message, 100), {
      on: false,
      ttlMs: DEFAULT_WARM_POLICY.ttlMs.grok,
      source: 'measured',
      nextAt: undefined,
      endsAt: undefined,
      held: 'unsupported'
    });
  });

  it('schedules a session whose context usage nobody has stated', () => {
    const message = buildState(
      base({
        now: 5 * MIN,
        sessions: [
          session({
            warm: true,
            warmPort: port,
            updatedAt: 4 * MIN,
            cache: { ttlMs: 60 * MIN, source: 'measured', at: 4 * MIN }
          })
        ]
      })
    );
    assert.equal(warmOf(message, 100)?.held, undefined);
    assert.equal(warmOf(message, 100)?.nextAt, 59 * MIN);
  });

  it('times each card against the policy the host read, and pushes its figures', () => {
    const now = 1_000 * MIN;
    const policy: WarmPolicy = {
      ttlMs: { ...DEFAULT_WARM_POLICY.ttlMs, claude: 20 * MIN },
      marginMs: 3 * MIN,
      windowMs: 45 * MIN
    };
    const message = buildState(
      base({
        now,
        warmPolicy: policy,
        sessions: [
          session({
            warm: true,
            warmPort: port,
            updatedAt: now - 10 * MIN,
            cache: { ttlMs: 20 * MIN, source: 'configured', at: now - 10 * MIN }
          })
        ]
      })
    );
    assert.equal(warmOf(message, 100)?.nextAt, now + 7 * MIN);
    assert.equal(warmOf(message, 100)?.endsAt, now + 35 * MIN);
    assert.deepEqual(message.warmConfig, cacheTtl.warmConfig(policy));
  });

  it('describes the shared budget without claiming observed expiry', () => {
    const note = warmRows.warmNote(DEFAULT_WARM_POLICY.windowMs);
    assert.match(
      note,
      /Keep idle sessions' prompt caches warm for up to 2h after the last real turn/
    );
    assert.doesNotMatch(note, /before the cache/);
    assert.match(warmRows.warmNote(90 * MIN), /for up to 1h 30m after/);
  });

  it("words the card's stamp as Warm's time left only while it can still refresh a live cache", () => {
    const now = 1_000_000_000;
    const live = now + MIN;
    const on: WarmView = { on: true, ttlMs: 60 * MIN, source: 'measured', endsAt: now + 80 * MIN };
    assert.equal(warmRows.warmStamp(on, 'idle', now, live), 'warm for 1h 20m');
    const held: Record<WarmHeldView, string | undefined> = {
      unsupported: undefined,
      busy: undefined,
      ask: undefined,
      queued: undefined,
      ended: undefined,
      warming: 'warm for 1h 20m',
      'short-ttl': undefined,
      'window-short': undefined,
      failed: undefined,
      'no-cache': undefined
    };
    for (const [reason, text] of Object.entries(held) as [WarmHeldView, string | undefined][]) {
      assert.equal(warmRows.warmStamp({ ...on, held: reason }, 'idle', now, live), text, reason);
    }
    assert.equal(warmRows.warmStamp(on, 'idle', now, now), undefined);
    assert.equal(warmRows.warmStamp(on, 'idle', now, now - 1), undefined);
    assert.equal(warmRows.warmStamp({ ...on, held: 'warming' }, 'idle', now, now), undefined);
    // Over, off, or mid-turn: the stamp keeps the last message's age.
    assert.equal(warmRows.warmStamp({ ...on, endsAt: now }, 'idle', now, live), undefined);
    assert.equal(warmRows.warmStamp({ ...on, on: false }, 'idle', now, live), undefined);
    assert.equal(warmRows.warmStamp({ ...on, endsAt: undefined }, 'idle', now, live), undefined);
    assert.equal(warmRows.warmStamp(on, 'busy', now, live), undefined);
    assert.equal(warmRows.warmStamp(on, 'waiting', now, live), undefined);
    assert.equal(warmRows.warmStamp(undefined, 'idle', now, live), undefined);
  });
});

describe('owned board lifecycle', () => {
  it('discards a gather crossed by exit and immediately queues a current replacement', async () => {
    const ending = session({ closing: true });
    let current = [ending];
    const accepted: Session[][] = [];
    const queued: string[] = [];
    const capture = [...current];
    const lifecycle = ownedLifecycleKey(capture);
    await Promise.resolve();
    current = [];
    const effects = {
      commit: () => {
        accepted.push(capture);
      },
      refresh: () => {
        queued.push('refresh');
      }
    };
    assert.equal(commitOwnedBoard(lifecycle, current, effects), false);
    assert.equal(accepted.length, 0, 'an exited card was published');
    assert.deepEqual(queued, ['refresh']);
    const replacement = [...current];
    assert.equal(
      commitOwnedBoard(ownedLifecycleKey(replacement), current, {
        commit: () => {
          accepted.push(replacement);
        },
        refresh: () => {
          assert.fail('the replacement is current');
        }
      }),
      true
    );
    assert.deepEqual(accepted, [[]]);
  });

  it('rejects snapshots from before an End, failure, exit or pid replacement', () => {
    const live = session();
    const states = [
      [live],
      [{ ...live, closing: true as const }],
      [{ ...live, endStuck: true as const }],
      [],
      [{ ...live, startedAt: live.startedAt + 1_000 }]
    ];
    const keys = states.map(ownedLifecycleKey);
    assert.equal(new Set(keys).size, states.length);
  });

  it('allows a gathered board to publish while other sessions stream', () => {
    const live = session();
    assert.equal(
      ownedLifecycleKey([{ ...live, status: 'busy', updatedAt: 100, name: 'New title' }]),
      ownedLifecycleKey([live])
    );
  });
});
