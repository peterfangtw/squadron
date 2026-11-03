import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import * as results from '../../../scripts/test-results.mjs';
import { repoRoot } from '../helpers';

const ROOT = repoRoot();
const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('SQUADRON_VERIFY_') &&
      !key.startsWith('SQUADRON_RUN') &&
      !key.startsWith('GIT_') &&
      key !== 'NODE_TEST_CONTEXT'
  )
);

async function probe(
  files: Record<string, string>,
  entries: string[],
  barrel = false
): Promise<string[]> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-receipt-')));
  try {
    for (const [name, source] of Object.entries(files))
      await fs.writeFile(path.join(dir, name), source);
    const outputs = entries.map((file) => path.join(dir, file));
    const launch = barrel ? [path.join(dir, 'barrel.cjs')] : outputs;
    const events = path.join(dir, 'events.jsonl');
    const ran = cp.spawnSync(
      process.execPath,
      [
        '--test',
        `--test-reporter=${pathToFileURL(path.join(ROOT, 'scripts/checkpoint-reporter.mjs')).href}`,
        `--test-reporter-destination=${events}`,
        ...launch
      ],
      { env: clean, encoding: 'utf8' }
    );
    assert.notEqual(ran.status, null, ran.stderr);
    const code = `import { fileResults } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/test-results.mjs')).href)};
      console.log(JSON.stringify(fileResults(${JSON.stringify(events)}, ${JSON.stringify(outputs)}, ${JSON.stringify(barrel ? launch[0] : null)}).filter(result=>result.outcome==='passed').map(result=>result.file)));`;
    const parsed = cp.spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: clean,
      encoding: 'utf8'
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    return (JSON.parse(parsed.stdout) as string[]).map((file) => path.basename(file));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const green = `const {describe,it}=require('node:test');describe('first',()=>it('green',()=>{}));describe('second',()=>it('green too',()=>{}));`;

describe('verification completion receipts', () => {
  it('retains a completed file when another file fails, including all its sections', async () => {
    assert.deepEqual(
      await probe(
        { 'ok.cjs': green, 'red.cjs': `require('node:test').it('red',()=>{throw Error('red')});` },
        ['ok.cjs', 'red.cjs']
      ),
      ['ok.cjs']
    );
  });
  it('refuses a root-after failure even when the per-file Node summary says success', async () => {
    assert.deepEqual(
      await probe(
        { 'hook.cjs': green + `require('node:test').after(()=>{throw Error('after')});` },
        ['hook.cjs']
      ),
      []
    );
  });
  it('refuses a shared helper root-hook failure in a standalone entry', async () => {
    assert.deepEqual(
      await probe(
        {
          'hook.cjs': "require('node:test').after(()=>{throw Error('shared root after')});",
          'entry.cjs': "require('./hook.cjs');" + green
        },
        ['entry.cjs']
      ),
      []
    );
  });
  it('refuses a worker that crashes after a passing body', async () => {
    assert.deepEqual(
      await probe({ 'crash.cjs': green + `setTimeout(()=>process.exit(2),10);` }, ['crash.cjs']),
      []
    );
  });
  it('aggregates every section in a barrel file and preserves another complete file', async () => {
    assert.deepEqual(
      await probe(
        {
          'ok.cjs': green,
          'red.cjs':
            green +
            `require('node:test').describe('last',()=>require('node:test').it('red',()=>{throw Error('red')}));`,
          'barrel.cjs': `require('./ok.cjs');require('./red.cjs');`
        },
        ['ok.cjs', 'red.cjs'],
        true
      ),
      ['ok.cjs']
    );
  });
  it('blocks all barrel receipts on root teardown failure despite green sections', async () => {
    assert.deepEqual(
      await probe(
        {
          'ok.cjs': green,
          'barrel.cjs': `require('./ok.cjs');require('node:test').after(()=>{throw Error('cleanup')});`
        },
        ['ok.cjs'],
        true
      ),
      []
    );
  });
  it('preserves an earlier file when a later section hook fails', async () => {
    assert.deepEqual(
      await probe(
        {
          'ok.cjs': green,
          'suite.cjs': `const {describe,it,after}=require('node:test');describe('a',()=>{after(()=>{throw Error('section')});it('g',()=>{});});`,
          'barrel.cjs': `require('./ok.cjs');require('./suite.cjs');`
        },
        ['ok.cjs', 'suite.cjs'],
        true
      ),
      ['ok.cjs']
    );
  });
  it('blocks every file when a required file registers a root after hook', async () => {
    assert.deepEqual(
      await probe(
        {
          'ok.cjs': green,
          'root.cjs': green + `require('node:test').after(()=>{throw Error('root')});`,
          'barrel.cjs': `require('./ok.cjs');require('./root.cjs');`
        },
        ['ok.cjs', 'root.cjs'],
        true
      ),
      []
    );
  });
});

function passEvidence(file: string, workerMs: number, rootMs: number): string {
  const row = (value: unknown) => JSON.stringify(value);
  return (
    [
      row({
        type: 'test:complete',
        data: {
          file,
          name: file,
          line: 1,
          column: 1,
          nesting: 0,
          details: { passed: true, duration_ms: workerMs }
        }
      }),
      row({
        type: 'test:complete',
        data: {
          file,
          name: 'case',
          line: 2,
          column: 1,
          nesting: 0,
          details: { passed: true, duration_ms: rootMs }
        }
      }),
      row({ type: 'test:summary', data: { file } })
    ].join('\n') + '\n'
  );
}

describe('lifecycle evidence outside a passing summary', () => {
  it('reads missing and malformed evidence as incomplete, and a torn-only file as not-run', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-results-')));
    try {
      const entry = path.join(dir, 'one.cjs');
      await fs.writeFile(entry, '');
      const incomplete = {
        file: entry,
        outcome: 'incomplete' as const,
        ms: 0,
        reason: 'missing or malformed lifecycle evidence'
      };
      assert.deepEqual(results.fileResults(path.join(dir, 'missing.jsonl'), [entry]), [incomplete]);
      const events = path.join(dir, 'events.jsonl');
      await fs.writeFile(events, '{not json}\n');
      assert.deepEqual(results.fileResults(events, [entry]), [incomplete]);
      await fs.writeFile(events, '{torn');
      assert.deepEqual(results.fileResults(events, [entry]), [
        { file: entry, outcome: 'not-run', ms: 0 }
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the worker duration and leaves an unseen file not-run when a torn tail follows a complete file', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-results-')));
    try {
      const ran = path.join(dir, 'ran.cjs');
      const absent = path.join(dir, 'absent.cjs');
      await fs.writeFile(ran, '');
      await fs.writeFile(absent, '');
      const events = path.join(dir, 'events.jsonl');
      await fs.writeFile(events, passEvidence(ran, 17, 5) + '{torn');
      assert.deepEqual(results.fileResults(events, [ran, absent]), [
        { file: ran, outcome: 'passed', ms: 17 },
        { file: absent, outcome: 'not-run', ms: 0 }
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a duplicate or unusable smoke registration instead of choosing an owner', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sq-results-')));
    try {
      const first = path.join(dir, 'first.cjs');
      const second = path.join(dir, 'second.cjs');
      const events = path.join(dir, 'events.jsonl');
      await fs.writeFile(events, '\n');
      const duplicate = results.fileResults(events, [first, second], null, [
        { file: first, name: 'same' },
        { file: second, name: 'same' }
      ]);
      assert.deepEqual(
        duplicate.map((row) => row.reason),
        ['duplicate smoke section name', 'duplicate smoke section name']
      );
      assert.ok(duplicate.every((row) => row.outcome === 'incomplete' && row.ms === 0));
      const unusable = results.fileResults(events, [first], null, [
        { name: 'section' } as { file: string; name: string }
      ]);
      assert.deepEqual(unusable, [
        {
          file: first,
          outcome: 'incomplete',
          ms: 0,
          reason: 'unsupported registration record'
        }
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
