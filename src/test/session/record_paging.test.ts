import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, it } from 'node:test';
import { tempHome } from '../helpers';
import type { RecordLine } from '../../core/record';

let record: typeof import('../../core/record');
before(async () => {
  await tempHome();
  record = await import('../../core/record');
});

async function fixture(id: string, lines: RecordLine[]): Promise<void> {
  const file = record.recordFile(id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      JSON.stringify({ v: record.SCHEMA, sessionId: id }),
      ...lines.map((line) => JSON.stringify(line)),
      ''
    ].join('\n')
  );
}

it('walks every recorded page in order and includes late results on their original calls', async () => {
  const lines: RecordLine[] = Array.from({ length: 150 }, (_, i) => ({
    role: 'assistant',
    text: `row ${i}`,
    blocks: [{ call: { id: `c${i}`, name: 'Bash' } }]
  }));
  lines.push({
    ret: [
      { id: 'c0', output: 'late first' },
      { id: 'c149', output: 'last' }
    ]
  });
  await fixture('pages', lines);
  const all = await record.readRecord('pages');
  let page = await record.readRecordPage('pages');
  assert.ok(page);
  const rows = [...page.recorded.exchanges];
  while (page.older) {
    page = await record.readRecordPage('pages', page.older);
    assert.ok(page);
    assert.ok(page.recorded.exchanges.length <= 60);
    rows.unshift(...page.recorded.exchanges);
  }
  assert.deepEqual(rows, all?.exchanges);
  assert.ok(page.newer);
  const next = await record.readRecordPage('pages', page.newer);
  assert.equal(
    next?.recorded.exchanges[0] && 'text' in next.recorded.exchanges[0]
      ? next.recorded.exchanges[0].text
      : '',
    'row 30'
  );
});

it('does not consume a torn final line; completing it adds exactly one row', async () => {
  await fixture('partial-page', [{ role: 'assistant', text: 'complete' }]);
  const file = record.recordFile('partial-page');
  const unicode = Buffer.from('🦄');
  await fs.appendFile(
    file,
    Buffer.concat([Buffer.from('{"role":"assistant","text":"split '), unicode.subarray(0, 2)])
  );
  const first = await record.readRecordPage('partial-page');
  assert.equal(first?.recorded.exchanges.length, 1);
  await fs.appendFile(file, Buffer.concat([unicode.subarray(2), Buffer.from('"}\n')]));
  const second = await record.readRecordPage('partial-page');
  assert.deepEqual(second?.recorded.exchanges, [
    { role: 'assistant', text: 'complete' },
    { role: 'assistant', text: 'split 🦄' }
  ]);
});

it('rejects cursors after replacement, same-size rewrite and truncation and preserves oversized atomic rows', async () => {
  const long = 'x'.repeat(300_000);
  await fixture('page-reset', [
    { role: 'user', text: 'old' },
    { role: 'assistant', text: long }
  ]);
  const page = await record.readRecordPage('page-reset');
  assert.ok(page?.older);
  assert.equal(page.recorded.exchanges.length, 1);
  assert.equal('text' in page.recorded.exchanges[0]! && page.recorded.exchanges[0].text, long);
  const file = record.recordFile('page-reset');
  await fs.rename(file, `${file}.old`);
  await fixture('page-reset', [{ role: 'assistant', text: 'replacement' }]);
  assert.equal(await record.readRecordPage('page-reset', page.cursor), undefined);
  const replacement = await record.readRecordPage('page-reset');
  assert.ok(replacement);
  const size = (await fs.stat(file)).size;
  await fixture('page-reset', [{ role: 'assistant', text: 'new content' }]);
  assert.equal((await fs.stat(file)).size, size);
  assert.equal(await record.readRecordPage('page-reset', replacement.cursor), undefined);
  const rewritten = await record.readRecordPage('page-reset');
  assert.ok(rewritten);
  await fixture('page-reset', []);
  assert.equal(await record.readRecordPage('page-reset', rewritten.cursor), undefined);
});

it('resolves repeated IDs and positional notes globally before page-local folding', async () => {
  const ck: import('../../core/checkpoint').TurnCheckpoint = {
    tree: '/repo',
    from: { tree: 'before', at: 1 },
    to: { tree: 'after', at: 2 },
    changes: { files: [], sizes: {} },
    moves: []
  };
  const ex: import('../../core/checkpoint').ExecutionCoverage = {
    version: 1,
    kind: 'coverage',
    owner: 'claude\0notes',
    runtime: 'runtime',
    turn: 'turn',
    tree: '/repo',
    start: 1,
    end: 2,
    source: 'execution',
    calls: [],
    windows: []
  };
  const call = (text: string): RecordLine => ({
    role: 'assistant',
    text,
    blocks: [{ call: { id: 'reused', name: 'Bash' } }]
  });
  const lines: RecordLine[] = [
    { ret: [{ id: 'reused', output: 'before call' }] },
    call('first'),
    { mark: 'break' },
    { ck },
    { ex },
    ...Array.from({ length: 65 }, (_, i): RecordLine => ({
      role: 'assistant',
      text: `middle ${i}`
    })),
    { role: 'user', text: 'user cannot own checkpoint' },
    { mark: 'break' },
    { ck },
    { ex },
    call('second'),
    { ret: [{ id: 'reused', output: 'second only' }] },
    { wm: { id: 'warm', phase: 'written' } },
    { role: 'warm', text: 'first warm', warmId: 'warm' },
    { role: 'warm', text: 'second warm', warmId: 'warm' },
    { wm: { id: 'warm', phase: 'closed', trafficAt: 3 } }
  ];
  await fixture('notes', lines);
  const full = await record.readRecord('notes');
  assert.ok(full);
  let page = await record.readRecordPage('notes');
  assert.ok(page);
  for (;;) {
    for (const row of page.recorded.exchanges) {
      const original: (typeof full.exchanges)[number] | undefined = full.exchanges.find(
        (x) => 'text' in x && 'text' in row && x.text === row.text
      );
      if (!original) continue;
      assert.deepEqual(row, original);
      assert.deepEqual(page.recorded.checkpoints.get(row), full.checkpoints.get(original));
      assert.deepEqual(page.recorded.execution?.get(row), full.execution?.get(original));
    }
    if (!page.older) break;
    page = await record.readRecordPage('notes', page.older);
    assert.ok(page);
  }
});

it('retains complete witness coverage before bounded recovery and keeps the safe navigation floor', async () => {
  const { readBaseline } = await import('../../core/thread');
  const lines: RecordLine[] = Array.from({ length: 700 }, (_, i) => ({
    role: 'assistant',
    text: `turn ${i}`,
    m: `m${i}`
  }));
  lines.unshift({ role: 'user', text: 'opening unkeyed prompt' });
  lines.push({ m: 'trailing' });
  await fixture('recovery-page', lines);
  const baseline = await readBaseline('recovery-page', () =>
    Promise.resolve({
      recent: { exchanges: [], truncated: true },
      witnessed: new Set(['m650', 'trailing']),
      order: []
    })
  );
  assert.equal(baseline.ours, true);
  const fold = new record.RecordFold();
  for (const line of baseline.lines) fold.push(line);
  assert.equal(fold.snapshot().exchanges.length, 50);
  assert.equal(baseline.recordFloor, 651);
  const page = await record.readRecordPage('recovery-page', undefined, baseline.recordFloor);
  assert.equal(page?.older, undefined);
  assert.equal(page?.recorded.exchanges.length, 50);
  const whole = await readBaseline('recovery-page', () =>
    Promise.resolve({
      recent: { exchanges: [], truncated: false },
      witnessed: new Set(['m0', 'm699', 'trailing']),
      order: []
    })
  );
  assert.equal(whole.ours, true);
  assert.equal(whole.partial, false);
  assert.equal(whole.recordFloor ?? 0, 0);
  assert.equal(whole.lines.filter((line) => 'role' in line).length, 701);
  const rejected = await readBaseline('recovery-page', () =>
    Promise.resolve({
      recent: { exchanges: [{ role: 'assistant', text: 'CLI fallback' }], truncated: true },
      witnessed: new Set(['missing-middle', 'm699']),
      order: [
        { key: 'missing-middle', from: 0 },
        { key: 'm699', from: 0 }
      ]
    })
  );
  assert.equal(rejected.ours, false);
});

it('reads bounded bytes after tiny appends and expires cursors when its record cache is evicted', async (t) => {
  await fixture(
    'io-page',
    Array.from({ length: 3000 }, (_, i) => ({
      role: 'assistant',
      text: `${i} ${'x'.repeat(1000)}`
    }))
  );
  const file = record.recordFile('io-page');
  let bytes = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', (async (...values: Parameters<typeof handle.read>) => {
        const got = await read(...values);
        bytes += got.bytesRead;
        return got;
      }) as typeof handle.read);
    }
    return handle;
  });
  const first = await record.readRecordPage('io-page');
  assert.ok(first);
  assert.ok(bytes > 3_000_000, 'cold scan observes the complete legacy record');
  await fs.appendFile(file, '{"role":"assistant","text":"appended"}\n');
  bytes = 0;
  const after = await record.readRecordPage('io-page');
  assert.ok(after);
  assert.ok(bytes < 256 * 1024, `append and materialized page read ${bytes} bytes`);
  for (let i = 0; i < 4; i++) {
    await fixture(`evict-${i}`, [{ role: 'user', text: 'one' }]);
    await record.readRecordPage(`evict-${i}`);
  }
  assert.equal(await record.readRecordPage('io-page', first.cursor), undefined);
});

it('does not retarget warm notes when the CLI coverage floor cuts away their owner', async () => {
  await fixture('warm-floor', [
    { wm: { id: 'W', phase: 'written' } },
    { role: 'warm', text: 'first', warmId: 'W', m: 'first' },
    { role: 'warm', text: 'second', warmId: 'W', m: 'second' },
    { wm: { id: 'W', phase: 'closed', trafficAt: 9 } }
  ]);
  const { readBaseline } = await import('../../core/thread');
  const baseline = await readBaseline('warm-floor', () =>
    Promise.resolve({
      recent: { exchanges: [], truncated: true },
      witnessed: new Set(['second']),
      order: []
    })
  );
  const fold = new record.RecordFold();
  for (const line of baseline.lines) fold.push(line);
  assert.deepEqual(fold.snapshot().exchanges, [
    { role: 'warm', text: 'second', warmId: 'W', warmEvidence: { id: 'W', phase: 'written' } }
  ]);
});

it('reapplies the byte target when late notes enlarge a retained page cursor', async () => {
  await fixture(
    'late-budget',
    Array.from({ length: 3 }, (_, i) => ({
      role: 'assistant',
      text: `budget ${i}`,
      blocks: [{ call: { id: `b${i}`, name: 'Bash' } }]
    }))
  );
  const page = await record.readRecordPage('late-budget');
  assert.ok(page);
  await fs.appendFile(
    record.recordFile('late-budget'),
    JSON.stringify({ ret: [{ id: 'b2', output: 'x'.repeat(300_000) }] }) + '\n'
  );
  const enlarged = await record.readRecordPage('late-budget', page.cursor);
  assert.equal(enlarged?.recorded.exchanges.length, 1);
  assert.ok(enlarged?.older);
});

for (const change of ['replace', 'remove', 'refuse'] as const) {
  it(`retries recovery when its coverage-checked record changes before the cut: ${change}`, async (t) => {
    const id = `recovery-race-${change}`;
    await fixture(id, [
      { role: 'assistant', text: 'first', m: 'first' },
      { role: 'assistant', text: 'second', m: 'second' }
    ]);
    const file = record.recordFile(id);
    const open = fs.open;
    let calls = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === file && ++calls === 2) {
        await fs.rename(file, `${file}.old`);
        if (change === 'replace')
          await fixture(id, [{ role: 'assistant', text: 'unverified replacement', m: 'foreign' }]);
        if (change === 'refuse')
          await fs.writeFile(file, JSON.stringify({ v: 999, sessionId: id }) + '\n');
      }
      return open(...args);
    });
    const { readBaseline } = await import('../../core/thread');
    const history = () =>
      Promise.resolve({
        recent: { exchanges: [], truncated: true },
        witnessed: new Set(['second']),
        order: []
      });
    await assert.rejects(readBaseline(id, history), /record changed during recovery/);
  });
}

it('keeps legacy whole-record reads of valid unterminated JSON while indexed pages await commit', async () => {
  await fixture('legacy-final', [{ role: 'assistant', text: 'first' }]);
  await record.readRecord('legacy-final');
  await fs.appendFile(
    record.recordFile('legacy-final'),
    '{"role":"assistant","text":"valid final"}'
  );
  assert.equal((await record.readRecord('legacy-final'))?.exchanges.length, 2);
  assert.equal((await record.readRecordPage('legacy-final'))?.recorded.exchanges.length, 1);
  await fs.appendFile(record.recordFile('legacy-final'), '\n');
  assert.equal((await record.readRecord('legacy-final'))?.exchanges.length, 2);
  assert.equal((await record.readRecordPage('legacy-final'))?.recorded.exchanges.length, 2);
});

for (const authored of [400, 401]) {
  it(`retains cap-boundary markers in the original ${authored}-authored-turn recovery window`, async () => {
    const id = `marker-cap-${authored}`;
    const lines: RecordLine[] = Array.from({ length: authored }, (_, i) => ({
      role: 'assistant',
      text: `authored ${i}`
    }));
    lines.splice(authored === 400 ? 0 : 1, 0, { mark: 'skill', skill: 'ponytail', by: 'you' });
    await fixture(id, lines);
    const full = record.drawable(await record.readRecord(id), new Set(), false);
    const { readBaseline } = await import('../../core/thread');
    const baseline = await readBaseline(id, () =>
      Promise.resolve({
        recent: { exchanges: [], truncated: false },
        witnessed: new Set<string>(),
        order: []
      })
    );
    const fold = new record.RecordFold();
    for (const line of baseline.lines) fold.push(line);
    assert.deepEqual({ exchanges: fold.snapshot().exchanges, truncated: baseline.partial }, full);
  });
}

it('does not lower the safe historical floor for a newly repaired tail witness', async () => {
  const id = 'tail-floor';
  await fixture(
    id,
    Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', text: `old ${i}`, m: `k${i}` }))
  );
  const { readBaseline } = await import('../../core/thread');
  const baseline = await readBaseline(id, () =>
    Promise.resolve({
      recent: {
        exchanges: [
          { role: 'assistant' as const, text: 'old 5' },
          { role: 'user' as const, text: 'new tail' }
        ],
        truncated: true
      },
      witnessed: new Set(['k5', 'new']),
      order: [
        { key: 'k5', from: 0 },
        { key: 'new', from: 1 }
      ]
    })
  );
  assert.equal(baseline.ours, true);
  assert.equal(baseline.missing?.length, 2);
  assert.equal(baseline.recordFloor, 5);
  const page = await record.readRecordPage(id, undefined, baseline.recordFloor);
  assert.equal(page?.older, undefined);
  assert.deepEqual(
    page?.recorded.exchanges.map((row) => ('text' in row ? row.text : '')),
    ['old 5', 'old 6', 'old 7']
  );
});

it('refuses a rewritten schema header even when the same inode grows and its old tail is unchanged', async () => {
  const id = 'header-and-append';
  await fixture(id, [{ role: 'assistant', text: 'x'.repeat(200) }]);
  await record.readRecord(id);
  const file = record.recordFile(id);
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(
    file,
    raw.replace('"v":2', '"v":9') + '{"role":"assistant","text":"appended"}\n'
  );
  assert.equal(await record.readRecord(id), undefined);
});

it('rejects a page whose open descriptor was replaced at the path before publication', async (t) => {
  const id = 'descriptor-race';
  await fixture(id, [{ role: 'assistant', text: 'old descriptor' }]);
  const file = record.recordFile(id);
  const open = fs.open;
  let replaced = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === file && !replaced) {
      replaced = true;
      await fs.rename(file, `${file}.old`);
      await fixture(id, [{ role: 'assistant', text: 'replacement descriptor' }]);
    }
    return handle;
  });
  await assert.rejects(record.readRecordPage(id), /record changed during page read/);
  const fresh = await record.readRecordPage(id);
  assert.equal(
    fresh?.recorded.exchanges[0] && 'text' in fresh.recorded.exchanges[0]
      ? fresh.recorded.exchanges[0].text
      : '',
    'replacement descriptor'
  );
});

it('loads the full recorded transcript beyond both page budgets when explicitly requested', async () => {
  const lines: RecordLine[] = Array.from({ length: 90 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `full ${i} ${'x'.repeat(6000)}`,
    blocks: [{ call: { id: `full-${i}`, name: 'Bash' } }]
  }));
  lines.push({ ret: [{ id: 'full-0', output: 'late oldest result' }] });
  await fixture('full-history', lines);
  const full = await record.readRecordPage('full-history', 'full');
  assert.ok(full);
  assert.deepEqual(full.recorded.exchanges, (await record.readRecord('full-history'))?.exchanges);
  assert.equal(full?.older, undefined);
  assert.equal(full?.newer, undefined);
});
