import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, writeJson } from '../helpers';
import type { LineageEntry } from '../../core/coordination/lineage';

type Lineage = typeof import('../../core/coordination/lineage');

let home: string;
let lineage: Lineage;

const dir = () => path.join(home, '.squadron', 'lineage');

before(async () => {
  home = await tempHome();
  lineage = await import('../../core/coordination/lineage');
});

const entry = (over: Partial<LineageEntry> = {}): LineageEntry => ({
  schema: 1,
  parentSessionId: 'parent-1',
  spawnedAt: 1000,
  cwd: '/tmp/project',
  requestId: 'req-1',
  ...over
});

async function reset(): Promise<void> {
  await fs.rm(dir(), { recursive: true, force: true });
}

describe('the lineage store', () => {
  it('has nothing to say before anything has spawned', async () => {
    await reset();
    assert.equal((await lineage.readLineage()).size, 0);
  });

  it('round-trips an edge, keyed by the child shell pid', async () => {
    await reset();
    await lineage.writeLineage(4242, entry({ ticketRef: 'ENG-412' }));

    const edges = await lineage.readLineage();
    assert.deepEqual(edges.get(4242), {
      schema: 1,
      kind: 'spawn',
      parentSessionId: 'parent-1',
      spawnedAt: 1000,
      cwd: '/tmp/project',
      requestId: 'req-1',
      ticketRef: 'ENG-412'
    });
  });

  // The record is self-describing wherever it is read, which is what makes a
  // lineage edge the `spawn` variant rather than a second shape.
  it('states the kind a caller never had to pass', async () => {
    await reset();
    await lineage.writeLineage(4242, entry());

    assert.equal((await lineage.readLineage()).get(4242)?.kind, 'spawn');
  });

  // Every entry on disk before the field existed, and all of them spawns.
  it('reads an entry that states no kind, because there was only one', async () => {
    await reset();
    await writeJson(path.join(dir(), '4242.json'), {
      schema: 1,
      parentSessionId: 'parent-1',
      spawnedAt: 1000,
      cwd: '/tmp/project',
      requestId: 'req-1'
    });

    const edge = (await lineage.readLineage()).get(4242);
    assert.equal(edge?.parentSessionId, 'parent-1');
    assert.equal(edge?.kind, undefined);
  });

  it('round-trips the fan-out the spawn belongs to', async () => {
    await reset();
    await lineage.writeLineage(4242, entry({ originSessionId: 'gen1' }));

    assert.equal((await lineage.readLineage()).get(4242)?.originSessionId, 'gen1');
  });

  it('reads an entry an older build wrote, which names no origin', async () => {
    await reset();
    await lineage.writeLineage(4242, entry());

    const edge = (await lineage.readLineage()).get(4242);
    assert.equal(edge?.parentSessionId, 'parent-1');
    assert.equal(edge?.originSessionId, undefined);
  });

  it('leaves no temp file behind, and none that a panel would parse', async () => {
    await reset();
    await lineage.writeLineage(7, entry());
    assert.deepEqual(await fs.readdir(dir()), ['7.json']);
  });

  it('keeps both children when two windows spawn at once', async () => {
    await reset();
    // The property one-file-per-child exists for: a shared map read-modify-written
    // by two windows in the same tick keeps whichever wrote last.
    await Promise.all([
      lineage.writeLineage(11, entry({ parentSessionId: 'a', requestId: 'ra' })),
      lineage.writeLineage(22, entry({ parentSessionId: 'b', requestId: 'rb' }))
    ]);

    const edges = await lineage.readLineage();
    assert.equal(edges.get(11)?.parentSessionId, 'a');
    assert.equal(edges.get(22)?.parentSessionId, 'b');
  });

  it('re-spawning into the same shell replaces that shell’s edge', async () => {
    await reset();
    await lineage.writeLineage(11, entry({ parentSessionId: 'first', spawnedAt: 1000 }));
    await lineage.writeLineage(11, entry({ parentSessionId: 'second', spawnedAt: 2000 }));

    const edges = await lineage.readLineage();
    assert.equal(edges.size, 1);
    assert.equal(edges.get(11)?.parentSessionId, 'second');
  });

  it('skips what it cannot read and keeps what it can', async () => {
    await reset();
    await lineage.writeLineage(11, entry());
    await fs.writeFile(path.join(dir(), '12.json'), '{ half writ');
    // Not ours: no pid for a name, and a file that is not JSON at all.
    await fs.writeFile(path.join(dir(), 'notes.json'), JSON.stringify(entry()));
    await fs.writeFile(path.join(dir(), 'README'), 'nothing to see');

    const edges = await lineage.readLineage();
    assert.deepEqual([...edges.keys()], [11]);
  });

  it('drops an entry with no spawn time, since nothing can be bounded by it', async () => {
    await reset();
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(path.join(dir(), '13.json'), JSON.stringify({ schema: 1, cwd: '/tmp' }));

    assert.equal((await lineage.readLineage()).size, 0);
  });
});

describe('the spawn join', () => {
  const edges = (over: Partial<Record<number, LineageEntry>> = {}) =>
    new Map(Object.entries(over).map(([pid, e]) => [Number(pid), e as LineageEntry]));

  it('stamps both fields from an edge on the session’s own pid', () => {
    const map = edges({ 11: entry({ spawnedAt: 1000, originSessionId: 'gen1' }) });

    assert.deepEqual(lineage.spawnedBy(map, { pid: 11, startedAt: 2000 }), {
      parentSessionId: 'parent-1',
      originSessionId: 'gen1'
    });
  });

  it('stamps the fan-out of an edge that names no parent', () => {
    const map = edges({
      11: entry({ spawnedAt: 1000, parentSessionId: undefined, originSessionId: 'gen1' })
    });

    assert.deepEqual(lineage.spawnedBy(map, { pid: 11, startedAt: 2000 }), {
      originSessionId: 'gen1'
    });
  });

  it('refuses an edge stamped after the session started', () => {
    // The floor, past its slack: a recycled pid meeting an older edge.
    const map = edges({ 11: entry({ spawnedAt: 5000 }) });

    assert.deepEqual(lineage.spawnedBy(map, { pid: 11, startedAt: 1000 }), {});
  });

  it('refuses an edge the session started long after, stamping neither field', () => {
    const map = edges({ 11: entry({ spawnedAt: 1000, originSessionId: 'gen1' }) });

    assert.deepEqual(lineage.spawnedBy(map, { pid: 11, startedAt: 3600_000 }), {});
  });

  it('admits a start up to the slack before the edge, and nothing beyond', () => {
    // Every brand reads `startedAt` off `ps`, whose second-granularity start
    // sits before the fork the edge was stamped after, so the slack is the
    // rule rather than a knob any caller passes.
    const map = edges({ 11: entry({ spawnedAt: 5000 }) });

    assert.equal(lineage.spawnedBy(map, { pid: 11, startedAt: 3000 }).parentSessionId, 'parent-1');
    assert.deepEqual(lineage.spawnedBy(map, { pid: 11, startedAt: 2999 }), {});
  });

  it('refuses a start it cannot read as a number', () => {
    // `parsePsRow` dates a row with `Date.parse(lstart)`, and `ps` honours
    // `LC_TIME`: a localised weekday the regex still matches parses to `NaN`.
    // A `NaN` gap is below no floor and above no ceiling, so two negated
    // comparisons admitted the very edge both of them exist to refuse — a
    // stranger's parent on a card, from a start nobody could read.
    const map = edges({ 11: entry({ spawnedAt: 5000, originSessionId: 'gen1' }) });

    assert.deepEqual(lineage.spawnedBy(map, { pid: 11, startedAt: NaN }), {});
  });

  it('says nothing when there is no edge', () => {
    assert.deepEqual(lineage.spawnedBy(edges(), { pid: 11, startedAt: 2000 }), {});
  });

  it('counts a pid alive only while its start is that spawn', () => {
    const edge = { spawnedAt: 5_000 };
    assert.equal(lineage.lineageAlive(11, edge, 5_000), true);
    assert.equal(lineage.lineageAlive(11, edge, 5_000 + 5 * 60_000), false);
    assert.equal(lineage.lineageAlive(11, edge, undefined), false);
  });
});
