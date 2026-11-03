import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CpuSample, MIN_WINDOW_MS, cpuSample, machineView, meter } from '../../core/machine';

const CORES = 4;
/** A window exactly at the floor, so a test widens or narrows from one place. */
const WINDOW = MIN_WINDOW_MS * CORES;

/** A sample that many ticks on from `from`, of which `busy` were not idle. */
const after = (from: CpuSample, total: number, busy: number): CpuSample => ({
  busy: from.busy + busy,
  total: from.total + total,
  cores: from.cores
});

const start: CpuSample = { busy: 1000, total: 10000, cores: CORES };

describe('cpuSample', () => {
  it('reads counters that only grow, over every core on this machine', () => {
    const first = cpuSample();
    assert.ok(first.cores >= 1);
    assert.ok(first.total >= first.busy, 'idle time went missing from the total');
    const second = cpuSample();
    assert.ok(second.total >= first.total, 'a cumulative counter went backwards');
  });
});

describe('meter', () => {
  it('says nothing on the first poll, which has nothing to diff', () => {
    const next = meter({}, start);
    assert.equal(next.cpu, undefined);
    assert.deepEqual(next.at, start);
  });

  it('divides the busy ticks by the window once one is wide enough', () => {
    const next = meter({ at: start }, after(start, WINDOW, WINDOW / 4));
    assert.equal(next.cpu, 25);
  });

  it('holds the old sample when the window is too short to mean anything', () => {
    // The 3s poll is not the only thing that repaints the panel — a selection
    // or a burst of frames brings a refresh too, and two samples milliseconds
    // apart are noise dressed as a reading.
    const prev = { at: start, cpu: 40 };
    const next = meter(prev, after(start, WINDOW - 1, 0));
    assert.deepEqual(next, prev, 'a sub-second window was divided anyway');
  });

  it('keeps widening a held window until it can be divided', () => {
    const held = meter({ at: start }, after(start, WINDOW / 2, WINDOW / 2));
    assert.equal(held.cpu, undefined);
    // The second short sample is measured against the original, not against the
    // one that was thrown away — so the two halves add up to one full window.
    const done = meter(held, after(start, WINDOW, WINDOW / 2));
    assert.equal(done.cpu, 50);
  });

  it('restarts on counters that went backwards, rather than paint a number', () => {
    // Counters only ever grow, so this is a machine that slept: the previous
    // sample is not this uptime's any more.
    const woke = { busy: 5, total: 50, cores: CORES };
    const next = meter({ at: start, cpu: 40 }, woke);
    assert.equal(next.cpu, undefined, 'a stale reading survived a resume');
    assert.deepEqual(next.at, woke);
  });

  it('clamps to the 0-100 a percentage is, whatever the counters did', () => {
    // Busy outrunning total is not something a healthy machine reports, but
    // nothing here is our file to guarantee.
    const wild = meter({ at: start }, after(start, WINDOW, WINDOW * 2));
    assert.equal(wild.cpu, 100);
  });

  it('reports a fully idle window as zero, not as nothing known', () => {
    const idle = meter({ at: start }, after(start, WINDOW, 0));
    assert.equal(idle.cpu, 0);
  });
});

/**
 * What the wire is told about the machine. Each reading's absence is a wait the
 * nav draws as one, so neither may hide the other, and an answer of nothing is
 * kept apart from no answer yet.
 */
describe('machineView', () => {
  const read = { used: 1, total: 8 };

  it('says nothing until either reading exists', () => {
    assert.equal(machineView(undefined, undefined), undefined);
  });

  it('sends the load alone while memory is still out', () => {
    assert.deepEqual(machineView(34, undefined), { cpu: 34 });
  });

  it('sends memory without waiting for a second CPU sample', () => {
    assert.deepEqual(machineView(undefined, read), { memory: read });
  });

  it('keeps a read that answered nothing, which is not a read still out', () => {
    assert.deepEqual(machineView(undefined, null), { memory: null });
    assert.deepEqual(machineView(34, null), { cpu: 34, memory: null });
  });

  it('sends both once both exist', () => {
    assert.deepEqual(machineView(34, read), { cpu: 34, memory: read });
  });
});
