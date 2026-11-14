import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { after, before, it, mock } from 'node:test';
import type { ServePort } from '../../core/coordination/serve_owned';
import type * as domain from '../../core/routines/routines';
import type * as types from '../../core/routines/types';
import { liveClaim, repoRoot, tempHome, testPlatform } from '../helpers';
import { incomingPlatformFixture } from '../remote/incoming_platform_helpers';
import * as owners from '../remote/incoming_owner_helpers';
import * as nativeTools from '../remote/native_tool_helpers';

/**
 * The installed `squadron-routine done` at its process boundary: real argv, the
 * caller proved from inside a fake owned CLI's native tool child, and run state
 * seeded only through the routine domain API. Gate refusal and an unprovable
 * caller are `gate_cli.test.ts`'s; ancestor topology is `fetch_cli.test.ts`'s;
 * the holder-free receiver arm is `serve_owned.test.ts`'s.
 */

type Child = Awaited<ReturnType<typeof owners.child>>;

const run = promisify(cp.execFile);
let paths: typeof import('../../core/paths');
let routines: typeof import('../../core/routines/routines');
let schedule: typeof import('../../core/routines/schedule');
let command: string;
let root: string;
let claimPath: string;
let first: Child;
let second: Child;
let serving: ReturnType<typeof setInterval> | undefined;
let previousTemp: Pick<NodeJS.ProcessEnv, 'TEMP' | 'TMP' | 'TMPDIR'>;
let disposePrivateFiles: (() => Promise<void>) | undefined;
const children: Child[] = [];

before(async () => {
  const home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  paths = await import('../../core/paths');
  routines = await import('../../core/routines/routines');
  schedule = await import('../../core/routines/schedule');
  const ownership = await import('../../core/owned_incoming');
  const requests = await import('../../core/coordination/requests');
  const serve = await import('../../core/coordination/serve_owned');
  const platform = await import('../../core/platform');
  root = path.join(home, 'routine-cli');
  await fs.mkdir(root);
  root = await fs.realpath(root);
  const temporary = path.join(root, 'temporary');
  await fs.mkdir(temporary);
  previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: temporary, TMP: temporary, TMPDIR: temporary });
  mock.method(os, 'tmpdir', () => temporary);

  await fs.mkdir(paths.BIN_DIR, { recursive: true });
  await platform.launchers.install(
    paths.BIN_DIR,
    'squadron-routine',
    path.join(repoRoot(), 'dist/squadron-routine.js')
  );
  await platform.launchers.installHelperLocator(paths.BIN_DIR, repoRoot());
  command = platform.launchers.scriptPath(paths.BIN_DIR, 'squadron-routine');

  const host = new ownership.IncomingHost('destination');
  const capability = await host.capability();
  assert.ok(capability);
  const windows = (await import('../../core/coordination/claims')).WINDOWS_DIR;
  await fs.mkdir(windows, { recursive: true });
  claimPath = path.join(windows, `${capability.host.windowId}.json`);
  await fs.writeFile(
    claimPath,
    JSON.stringify(liveClaim({ id: capability.host.windowId, label: 'test window', folder: root }))
  );

  for (const name of ['first', 'second']) {
    const cwd = path.join(root, name);
    await fs.mkdir(cwd);
    const child = await owners.child(host, 'claude', cwd);
    children.push(child);
    assert.equal(await child.publish(), true);
  }
  [first, second] = children as [Child, Child];

  // No Remote holder anywhere: a routine's receiver proof must not need one.
  const port: ServePort = {
    owned: (pid) => children.find((child) => child.pid === pid)?.handle,
    end: () => false,
    start: () => Promise.resolve({ ok: false, reason: 'no starts here', outcome: 'stopped' }),
    holder: () => Promise.resolve(undefined),
    incomingHolder: () => Promise.resolve(undefined),
    incomingAccess: () => host.capability(),
    evidence: (challenge, query) =>
      host.evidence(
        children.map((child) => child.owner),
        challenge,
        query,
        (owner) =>
          children.find((child) => child.owner === owner)?.publish() ?? Promise.resolve(false)
      )
  };
  let claiming = false;
  serving = setInterval(() => {
    if (claiming) return;
    claiming = true;
    void requests
      .claimRequests(
        capability.host.windowId,
        (request) => serve.serveOwned(request, port) ?? Promise.resolve({ ok: false })
      )
      .finally(() => {
        claiming = false;
      });
  }, 20);
});

after(async () => {
  clearInterval(serving);
  await Promise.all(children.splice(0).map((child) => child.close()));
  for (const key of ['TEMP', 'TMP', 'TMPDIR'] as const) {
    if (previousTemp[key] === undefined) delete process.env[key];
    else process.env[key] = previousTemp[key];
  }
  await disposePrivateFiles?.();
});

it('refuses malformed arguments with usage before reading state (exit 1)', async () => {
  const runId = crypto.randomUUID();
  for (const argv of [
    [],
    ['finish', '--run-id', runId],
    ['done'],
    ['done', '--run-id', 'not-a-uuid'],
    ['done', '--run-id', runId, '--note', 'x'.repeat(201)],
    ['done', '--run-id', runId, '--run-id', runId],
    ['done', '--run-id', runId, '--unknown', 'x']
  ]) {
    const failed = await run(process.execPath, [command, ...argv]).then(
      () => undefined,
      (error: { code: number; stdout: string; stderr: string }) => error
    );
    assert.equal(failed?.code, 1, JSON.stringify(argv));
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /usage: squadron-routine done --run-id/);
  }
});

it('completes only the admitted run from its exact receiver, idempotently (exit 0)', async () => {
  const seeded = await seed(first, 'bind');
  const early = await done(first, seeded.runId);
  assert.equal(early.code, 2, early.stderr);
  assert.match(early.stderr, /not the current admitted attempt/);
  assert.equal((await attemptOf(seeded)).phase, 'bound');

  await apply(seeded.scope, { kind: 'admitPrompt', runId: seeded.runId, owner: seeded.owner });
  const completed = await done(first, seeded.runId, ['--note', 'Checked the dependencies']);
  assert.equal(completed.code, 0, completed.stderr);
  assert.match(completed.stdout, new RegExp(`Routine run ${seeded.runId} completed`));
  const finished = await attemptOf(seeded);
  assert.equal(finished.phase, 'done');
  assert.equal(finished.note, 'Checked the dependencies');
  const definition = await definitionOf(seeded);
  assert.equal(definition.activeRunId, undefined);
  assert.deepEqual(
    definition.handled.map(({ key, outcome, runId }) => ({ key, outcome, runId })),
    [{ key: seeded.occurrenceKey, outcome: 'completed', runId: seeded.runId }]
  );

  const repeated = await done(first, seeded.runId);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal((await definitionOf(seeded)).handled.length, 1);
  assert.equal((await attemptOf(seeded)).note, 'Checked the dependencies');
});

it("refuses another session's run and leaves it to its own receiver (exit 2)", async () => {
  const seeded = await seed(second, 'admitPrompt');
  const foreign = await done(first, seeded.runId);
  assert.equal(foreign.code, 2, foreign.stderr);
  assert.match(foreign.stderr, /Only the associated routine session/);
  assert.equal((await attemptOf(seeded)).phase, 'admitted');
  assert.equal((await definitionOf(seeded)).activeRunId, seeded.runId);

  const own = await done(second, seeded.runId);
  assert.equal(own.code, 0, own.stderr);
  assert.equal((await attemptOf(seeded)).phase, 'done');
});

it('refuses a run with no locator (exit 2)', async () => {
  const missing = await done(first, crypto.randomUUID());
  assert.equal(missing.code, 2, missing.stderr);
  assert.match(missing.stderr, /No associated routine run was found/);
});

it('reports unreadable run evidence as a machine failure (exit 5)', async () => {
  const broken = crypto.randomUUID();
  await fs.mkdir(paths.ROUTINE_RUNS_DIR, { recursive: true });
  await fs.writeFile(path.join(paths.ROUTINE_RUNS_DIR, `${broken}.json`), '{');
  const locator = await done(first, broken);
  assert.equal(locator.code, 5, locator.stderr);

  // A real locator over a repository record that no longer validates.
  const scratch = path.join(root, 'corrupt');
  await fs.mkdir(scratch);
  const seeded = await seed(first, 'reserve', scratch);
  await fs.writeFile(routines.routineEvidencePath(seeded.scope), JSON.stringify({ schema: 1 }));
  const state = await done(first, seeded.runId);
  assert.equal(state.code, 5, state.stderr);
  assert.match(state.stderr, /Unsupported or corrupt routine state/);
});

type Seeded = {
  scope: types.Scope;
  routineId: string;
  runId: string;
  occurrenceKey: string;
  owner: types.Attempt['owner'];
};

/** One routine and one run advanced through the production actions, up to `through`. */
async function seed(
  child: Child,
  through: 'reserve' | 'bind' | 'admitPrompt',
  cwd = child.owner.receiverIdentity.cwd
): Promise<Seeded> {
  const receiver = child.owner.receiverIdentity;
  const scope = await routines.resolveScope(cwd);
  const now = Date.now();
  const saved = await apply(
    scope,
    {
      kind: 'save',
      expectedDefinitionRevision: null,
      draft: {
        name: 'Review dependencies',
        enabled: true,
        schedule: { kind: 'daily', time: '09:00' },
        task: {
          doc: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Review the dependencies' }] }
            ]
          },
          delivered: 'Review the dependencies',
          targetChoice: { kind: 'default' },
          attachments: {},
          savedFromCwd: cwd
        }
      }
    },
    now
  );
  const definition = saved.definition;
  assert.ok(definition);
  const seeded: Seeded = {
    scope,
    routineId: definition.id,
    runId: crypto.randomUUID(),
    occurrenceKey: schedule.occurrence(definition, now).key,
    owner: receiver.host
  };
  const { runId, owner } = seeded;
  await apply(
    scope,
    {
      kind: 'reserve',
      id: definition.id,
      expectedDefinitionRevision: definition.definitionRevision,
      runId,
      occurrenceKey: seeded.occurrenceKey,
      target: { brand: 'claude' },
      owner
    },
    now
  );
  if (through === 'reserve') return seeded;
  await apply(scope, { kind: 'spawning', runId, owner });
  await apply(scope, {
    kind: 'recordChild',
    runId,
    owner,
    child: { pid: receiver.pid, startedAt: receiver.osStartedAt, startSource: receiver.startSource }
  });
  const sessionId = child.handle.state.sessionId;
  assert.ok(sessionId);
  await apply(scope, { kind: 'bind', runId, owner, receiver, sessionId });
  if (through === 'admitPrompt') await apply(scope, { kind: 'admitPrompt', runId, owner });
  return seeded;
}

async function apply(
  scope: types.Scope,
  action: DistributiveOmit<domain.Action, 'operationId'>,
  now = Date.now()
): Promise<Extract<types.Result, { kind: 'ok' }>> {
  const result = await routines.applyRoutineAction(
    scope,
    { ...action, operationId: crypto.randomUUID() },
    now
  );
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  return result;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

async function repository(seeded: Seeded): Promise<types.Repository> {
  const snapshot = await routines.readRoutineSnapshot(seeded.scope);
  assert.equal(snapshot.kind, 'ok', JSON.stringify(snapshot));
  return snapshot.snapshot.repository;
}

async function attemptOf(seeded: Seeded): Promise<types.Attempt> {
  const attempt = (await repository(seeded)).attempts[seeded.runId];
  assert.ok(attempt);
  return attempt;
}

async function definitionOf(seeded: Seeded): Promise<types.Definition> {
  const definition = (await repository(seeded)).routines[seeded.routineId];
  assert.ok(definition);
  return definition;
}

/** The installed verb, as the session's own command tool runs it. */
function done(child: Child, runId: string, extra: string[] = []): Promise<nativeTools.ToolResult> {
  const shell = paths.verbCommand(
    testPlatform() === 'win32' ? 'windows-powershell' : 'posix',
    'squadron-routine',
    'done',
    '--run-id',
    runId,
    ...extra
  );
  return nativeTools.runNativeTool(child, shell, { resultDir: root, claim: claimPath });
}
