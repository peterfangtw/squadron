import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, writeJson } from '../helpers';

type Prune = typeof import('../../core/prune');
type Paths = typeof import('../../core/paths');

let prune: Prune;
let paths: Paths;
/** Sidecar top — dumps, activity, leftover order. */
let dumps: string;
/** Product home — lineage, live, arrange, runs, workflows, windows, pastes. */
let state: string;

before(async () => {
  const home = await tempHome();
  prune = await import('../../core/prune');
  paths = await import('../../core/paths');
  dumps = path.join(home, '.claude', 'squadron');
  state = path.join(home, '.squadron');
});

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

/** Writes a file and backdates it, which is the only thing the sweep reads. */
async function aged(file: string, days: number): Promise<string> {
  await writeJson(file, { ok: true });
  const when = new Date(Date.now() - days * prune.DAY_MS);
  await fs.utimes(file, when, when);
  return file;
}

describe('pruneOlderThan', () => {
  it('drops what is past the age and keeps what is inside it', async () => {
    const dir = path.join(dumps, 'age');
    const old = await aged(path.join(dir, 'old.json'), 3);
    const fresh = await aged(path.join(dir, 'fresh.json'), 0.5);

    await prune.pruneOlderThan(dir, prune.DAY_MS);

    assert.equal(await exists(old), false);
    assert.equal(await exists(fresh), true);
  });

  it('sweeps only what the filter accepts', async () => {
    const dir = path.join(dumps, 'filtered');
    const json = await aged(path.join(dir, 'session.json'), 30);
    const other = await aged(path.join(dir, 'notes.txt'), 30);

    await prune.pruneOlderThan(dir, prune.DAY_MS, (name) => name.endsWith('.json'));

    assert.equal(await exists(json), false);
    assert.equal(await exists(other), true);
  });

  // Age does not recurse: a leftover store dir under DUMP_DIR, or `windows/`
  // under STATE_DIR, would go with everything in it.
  it('leaves subdirectories alone however old they are', async () => {
    const dir = path.join(dumps, 'nested');
    const child = path.join(dir, 'sub');
    const kept = await aged(path.join(child, 'inside.json'), 30);
    const when = new Date(Date.now() - 30 * prune.DAY_MS);
    await fs.utimes(child, when, when);

    await prune.pruneOlderThan(dir, prune.DAY_MS);

    assert.equal(await exists(child), true);
    assert.equal(await exists(kept), true);
  });

  it('says nothing about a directory that was never written', async () => {
    await assert.doesNotReject(prune.pruneOlderThan(path.join(dumps, 'absent'), prune.DAY_MS));
  });
});

describe('pruneStatus', () => {
  it('leaves schema-3 admissions and original native receipts to their live owners, beyond age cutoffs', async () => {
    const conversation = await aged(path.join(paths.CONVERSATIONS_DIR, 'abcdefgh.json'), 400);
    await fs.writeFile(
      conversation,
      JSON.stringify({ schema: 3, messages: [{ incoming: { version: 1 } }] })
    );
    const publication = await aged(path.join(paths.LIVE_DIR, '5004.json'), 400);
    await fs.writeFile(
      publication,
      JSON.stringify({ schema: 1, receiverIdentity: { version: 1 }, incomingDeliveries: [{}] })
    );
    const old = new Date(Date.now() - 400 * prune.DAY_MS);
    await fs.utimes(conversation, old, old);
    await fs.utimes(publication, old, old);
    await prune.pruneStatus();
    assert.equal(await exists(conversation), true);
    assert.equal(await exists(publication), true);
  });
  it('drops a dead session and keeps one inside the weekly window', async () => {
    const dead = await aged(path.join(dumps, 'dead.json'), 8);
    const deadOverlay = await aged(path.join(dumps, 'dead.activity.json'), 8);
    const deadAsk = await aged(path.join(dumps, 'dead.ask.json'), 8);
    const deadAnswer = await aged(path.join(dumps, 'dead.answered.json'), 8);
    // Six days is past a day but inside the seven the weekly rate window can
    // still be true for, which is the whole reason the gate is not a day.
    const weekOld = await aged(path.join(dumps, 'week.json'), 6);

    await prune.pruneStatus();

    for (const file of [dead, deadOverlay, deadAsk, deadAnswer]) {
      assert.equal(await exists(file), false, `expected ${path.basename(file)} gone`);
    }
    assert.equal(await exists(weekOld), true);
  });

  // Both homes: leftover at DUMP_DIR (excluded from that sweep) and live at
  // STATE_DIR (that top is not swept). A dump next to the leftover still goes.
  it('never sweeps the workflow order, however long since it was stated', async () => {
    const leftover = await aged(path.join(dumps, 'workflows.order.json'), 400);
    const order = await aged(path.join(state, 'workflows.order.json'), 400);
    const dump = await aged(path.join(dumps, 'somesession.json'), 8);

    await prune.pruneStatus();

    assert.equal(await exists(leftover), true);
    assert.equal(await exists(order), true);
    assert.equal(await exists(dump), false);
  });

  // The one subdirectory with no sweep of its own: a spawn record is written
  // once and never touched, so an age here is a ceiling on how long an edge is
  // remembered rather than a reading of what is still alive.
  it('forgets a lineage edge past the week, and keeps a fresher one', async () => {
    const stale = await aged(path.join(state, 'lineage', '4001.json'), 8);
    const recent = await aged(path.join(state, 'lineage', '4002.json'), 6);

    await prune.pruneStatus();

    assert.equal(await exists(stale), false);
    assert.equal(await exists(recent), true);
  });

  // The same week lineage gets, and for the same reason: the row is written
  // once and never touched, and the longest window that counts it is fifteen
  // minutes — so the age is a ceiling on memory, not a reading of liveness.
  it('forgets a send past the week, and keeps a fresher one', async () => {
    const stale = await aged(path.join(state, 'actions', 'old.json'), 8);
    const recent = await aged(path.join(state, 'actions', 'new.json'), 6);

    await prune.pruneStatus();

    assert.equal(await exists(stale), false);
    assert.equal(await exists(recent), true);
  });

  // Swept as a backstop rather than as the policy: a live record is removed by
  // the window that wrote it on every ordinary ending, so what ages out here is
  // what a crashed host left behind.
  it('drops a live record a crashed window left, and keeps a fresher one', async () => {
    const stale = await aged(path.join(state, 'live', '5001.json'), 8);
    const recent = await aged(path.join(state, 'live', '5002.json'), 6);

    await prune.pruneStatus();

    assert.equal(await exists(stale), false);
    assert.equal(await exists(recent), true);
  });

  // The thread file is the conversation's, so it gets the conversation's month.
  it('forgets a thread file past the month, and keeps one inside it', async () => {
    const stale = await aged(path.join(paths.THREADS_DIR, 'old.md'), 31);
    const recent = await aged(path.join(paths.THREADS_DIR, 'new.md'), 29);

    await prune.pruneStatus();

    assert.equal(await exists(stale), false);
    assert.equal(await exists(recent), true);
  });

  // A month rather than the week its neighbours get, and the extra weeks cost
  // nothing: a slot is a pid, every pid is dead within hours, so a file this old
  // already resolves to the derived board.
  it('forgets an arrangement past the month, and keeps one inside it', async () => {
    const stale = await aged(path.join(state, 'arrange', 'a1.json'), 31);
    const recent = await aged(path.join(state, 'arrange', 'a2.json'), 29);

    await prune.pruneStatus();

    assert.equal(await exists(stale), false);
    assert.equal(await exists(recent), true);
  });

  // Same week as its neighbours, for the lineage reason: a run record stops
  // being written the moment the run stops being advanced, so a stale mtime is
  // work that is long done rather than a run somebody is watching.
  it('drops a run past the week, and keeps a fresher one', async () => {
    const stale = await aged(path.join(state, 'runs', 'run-old.json'), 8);
    const recent = await aged(path.join(state, 'runs', 'run-new.json'), 6);

    await prune.pruneStatus();

    assert.equal(await exists(stale), false);
    assert.equal(await exists(recent), true);
  });

  // The one directory here that is the user's own work rather than our
  // per-session litter. Nothing may age it out, however long it has sat.
  it('never sweeps an authored workflow, at any age', async () => {
    const ancient = await aged(path.join(state, 'workflows', 'ship.json'), 400);

    await prune.pruneStatus();

    assert.equal(await exists(ancient), true);
  });

  // Every writer under `squadron/` renames a `${file}.${pid}.${seq}.tmp` into
  // place, so a crash mid-write orphans one. A `.json`-only filter excluded them
  // from every sweep by construction, forever.
  it('drops the temp file a crashed write left behind', async () => {
    const stale = [
      await aged(path.join(state, 'lineage', '4003.json.900.0.tmp'), 8),
      await aged(path.join(state, 'runs', 'run-x.json.900.1.tmp'), 8),
      await aged(path.join(state, 'live', '5003.json.900.2.tmp'), 8),
      await aged(path.join(state, 'arrange', 'a3.json.900.3.tmp'), 31)
    ];
    // A write in flight is minutes old, never days: the age is what keeps the
    // sweep off one.
    const inFlight = await aged(path.join(state, 'runs', 'run-y.json.900.4.tmp'), 0.5);

    await prune.pruneStatus();

    for (const file of stale) {
      assert.equal(await exists(file), false, `expected ${path.basename(file)} gone`);
    }
    assert.equal(await exists(inFlight), true);
  });

  // `windows/` is the one directory swept for its temps alone: `readClaims`
  // removes a stale claim as it reads it, but through a `.json` filter that
  // never opens a temp. A window republishes every 30s and dies by having its
  // extension host killed, so these accumulate daily rather than at a crash.
  it("drops a window claim's orphaned temp without touching the claim", async () => {
    const orphan = await aged(path.join(state, 'windows', 'w1.json.900.7.tmp'), 2);
    const inFlight = await aged(path.join(state, 'windows', 'w2.json.900.8.tmp'), 0.5);

    await prune.pruneStatus();

    assert.equal(await exists(orphan), false);
    assert.equal(await exists(inFlight), true);
  });

  it('leaves the directories that sweep themselves', async () => {
    const paste = await aged(path.join(state, 'pastes', 'shot.png'), 30);
    const claim = await aged(path.join(state, 'windows', 'window.json'), 30);

    await prune.pruneStatus();

    assert.equal(await exists(paste), true);
    assert.equal(await exists(claim), true);
  });
});

describe('pruneExecution', () => {
  const runner = (digit: string) => `${digit.repeat(64)}.js`;
  let serial = 0;

  /** One `execution/<runtime>/` directory, its newest file `days` old. */
  async function runtime(root: string, days: number): Promise<string> {
    const id = `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
    const directory = path.join(root, id);
    await fs.mkdir(path.join(directory, 'plugin'), { recursive: true });
    await fs.writeFile(path.join(directory, 'context.json'), '{}');
    await fs.writeFile(path.join(directory, 'plugin', 'hooks.json'), '{}');
    const when = new Date(Date.now() - days * prune.DAY_MS);
    for (const name of await fs.readdir(directory, { recursive: true }))
      await fs.utimes(path.join(directory, name), when, when);
    await fs.utimes(directory, when, when);
    return directory;
  }

  async function installed(root: string, name: string, days: number): Promise<string> {
    const file = path.join(root, 'runners', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'runner');
    const when = new Date(Date.now() - days * prune.DAY_MS);
    await fs.utimes(file, when, when);
    return file;
  }

  it('removes runtimes and runners a week untouched, and keeps the rest', async () => {
    const root = path.join(state, 'execution-sweep');
    const old = await runtime(root, 8);
    // A host that died yesterday: its journal is what activation's sweep ends it from.
    const recent = await runtime(root, 1);
    const stale = await installed(root, runner('a'), 8);
    const used = await installed(root, runner('b'), 6);

    await prune.pruneExecution(root);

    assert.equal(await exists(old), false);
    assert.equal(await exists(recent), true);
    assert.equal(await exists(stale), false);
    assert.equal(await exists(used), true);
  });

  it('keeps a runtime while anything inside it was written this week', async () => {
    const root = path.join(state, 'execution-inside');
    const directory = await runtime(root, 8);
    await fs.appendFile(path.join(directory, 'plugin', 'hooks.json'), ' ');

    await prune.pruneExecution(root);

    assert.equal(await exists(directory), true);
  });
});
