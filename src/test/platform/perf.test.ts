import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { record, report, reset } from '../../core/perf';

describe('perf counters', () => {
  beforeEach(() => reset());

  it('accumulates calls, time and bytes under one name', () => {
    record('post', 4, 1024);
    record('post', 6, 2048);
    const text = report();
    assert.match(text, /post/);
    assert.match(text, /2 calls/);
    // (4 + 6) / 2
    assert.match(text, /5\.0ms avg/);
  });

  it('omits the weight for a counter that carries no bytes', () => {
    record('refresh');
    assert.doesNotMatch(report(), /KB\/min/);
  });

  it('reports bytes only for the counter that has them', () => {
    record('refresh');
    record('post', 0, 4096);
    const lines = report().split('\n');
    assert.ok(lines.some((l) => l.includes('refresh') && !l.includes('KB/min')));
    assert.ok(lines.some((l) => l.includes('post') && l.includes('KB/min')));
  });

  it('keeps names apart', () => {
    record('refresh', 50);
    record('post');
    record('post');
    const lines = report().split('\n');
    assert.ok(lines.some((l) => l.includes('refresh') && l.includes('1 calls')));
    assert.ok(lines.some((l) => l.includes('post') && l.includes('2 calls')));
  });

  it('sorts by name, so two readings line up side by side', () => {
    record('state');
    record('post');
    record('refresh');
    const names = report()
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[0]);
    assert.deepEqual(names, ['post', 'refresh', 'state']);
  });

  it('says so rather than reporting an empty window', () => {
    assert.match(report(), /nothing recorded/);
  });

  it('reset clears what was counted', () => {
    record('refresh');
    reset();
    assert.match(report(), /nothing recorded/);
  });

  it('averages zero rather than dividing by it', () => {
    record('refresh');
    assert.match(report(), /0\.0ms avg/);
  });
});
