import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { disposeHome, resetDir, tempHome } from '../home';

type Catalog = typeof import('../../core/conversation_catalog');
type Conversations = typeof import('../../core/conversations');
let catalog: Catalog;
let conversations: Conversations;
let paths: typeof import('../../core/paths');
let record: typeof import('../../core/record');
let home: string;
const NOW = 40 * 86400000;

before(async () => {
  home = await tempHome();
  catalog = await import('../../core/conversation_catalog');
  conversations = await import('../../core/conversations');
  paths = await import('../../core/paths');
  record = await import('../../core/record');
});
after(async () => disposeHome(home));
beforeEach(async () => {
  await resetDir(paths.CATALOG_DIR);
  await resetDir(paths.TRANSCRIPTS_DIR);
});

async function write(id: string, cwd: string, at = NOW): Promise<void> {
  await record.appendLine(id, { role: 'user', text: id, at }, { cwd, brand: 'codex' });
}

async function read(reader: InstanceType<Conversations['ConversationReader']>, cwd: string) {
  const prepared = await reader.read(cwd, NOW);
  await prepared.maintain();
  return conversations.mergeConversations([prepared.rows], cwd);
}

describe('transcript catalog storage', () => {
  it('round-trips raw paths and stable summaries', async () => {
    const entry = {
      f: 'record.jsonl',
      stamp: [12, 1, 2, 0, 0] as const,
      cwd: 'c:\\Work\\Foo',
      brand: 'codex' as const,
      summary: { title: 'first prompt', at: NOW }
    };
    assert.equal(await catalog.writeCatalog(new Map([[entry.f, entry]])), true);
    assert.deepEqual(await catalog.readCatalog(), new Map([[entry.f, entry]]));
  });

  it('drops corrupt, conflicting, traversal and oversized entries without losing valid neighbors', async () => {
    const entry = { f: 'good.jsonl', stamp: [12, 1, 2, 0, 0] };
    await fs.mkdir(paths.CATALOG_DIR, { recursive: true });
    await fs.writeFile(
      paths.CATALOG_FILE,
      [
        '{"v":1}',
        JSON.stringify(entry),
        '{broken',
        JSON.stringify({ ...entry, f: '../outside.jsonl' }),
        JSON.stringify({ ...entry, f: 'duplicate.jsonl' }),
        JSON.stringify({ ...entry, f: 'duplicate.jsonl', stamp: [13, 1, 2, 0, 0] }),
        JSON.stringify({ ...entry, f: 'huge.jsonl', cwd: '界'.repeat(1000), brand: 'codex' }),
        JSON.stringify({ ...entry, f: 'partial.jsonl', cwd: 'C:\\work' }),
        JSON.stringify({ ...entry, f: 'finite.jsonl', stamp: [12, null, 2, 0, 0] }),
        JSON.stringify({
          ...entry,
          f: 'aged-missing.jsonl',
          cwd: '/work',
          brand: 'codex',
          summary: { aged: true }
        }),
        JSON.stringify({
          ...entry,
          f: 'title-missing.jsonl',
          cwd: '/work',
          brand: 'codex',
          summary: { title: 'without timestamp' }
        }),
        ''
      ].join('\n')
    );
    assert.deepEqual([...((await catalog.readCatalog())?.keys() ?? [])], ['good.jsonl']);
    for (const header of ['{"v":2}', '{broken']) {
      await fs.writeFile(paths.CATALOG_FILE, header + '\n' + JSON.stringify(entry) + '\n');
      assert.equal(await catalog.readCatalog(), undefined);
    }
  });

  it('preserves the previous cache when publication is superseded or the destination refuses writes', async () => {
    const entry = { f: 'old.jsonl', stamp: [12, 1, 2, 0, 0] as const };
    assert.equal(await catalog.writeCatalog(new Map([[entry.f, entry]])), true);
    assert.equal(await catalog.writeCatalog(new Map(), () => false), false);
    assert.deepEqual(await catalog.readCatalog(), new Map([[entry.f, entry]]));
    await fs.rm(paths.CATALOG_FILE);
    await fs.mkdir(paths.CATALOG_FILE);
    assert.equal(await catalog.writeCatalog(new Map()), false);
    assert.deepEqual(await fs.readdir(paths.CATALOG_DIR), [path.basename(paths.CATALOG_FILE)]);
  });

  it('retries an incomplete header and supports a header beyond the first 4 KiB', async () => {
    await fs.mkdir(paths.TRANSCRIPTS_DIR, { recursive: true });
    const file = record.recordFile('header');
    await fs.writeFile(file, '{"v":2');
    assert.equal(await catalog.readHeader('header.jsonl'), undefined);
    const cwd = '/work/' + 'x'.repeat(5000);
    await fs.writeFile(
      file,
      JSON.stringify({ v: 2, sessionId: 'header', cwd, brand: 'codex' }) + '\n'
    );
    assert.equal((await catalog.readHeader('header.jsonl'))?.entry.cwd, cwd);
  });

  it('sweeps crashed cache temps without deleting the catalog or transcripts', async () => {
    const prune = await import('../../core/prune');
    await write('permanent', '/work/project');
    await catalog.writeCatalog(new Map());
    const tmp = path.join(paths.CATALOG_DIR, 'transcripts.v1.jsonl.1.0.tmp');
    await fs.writeFile(tmp, 'partial');
    const old = new Date(Date.now() - 2 * 86400000);
    await fs.utimes(tmp, old, old);
    await fs.utimes(paths.CATALOG_FILE, old, old);
    await prune.pruneStatus();
    await assert.rejects(fs.stat(tmp), { code: 'ENOENT' });
    assert.ok((await fs.stat(paths.CATALOG_FILE)).isFile());
    assert.ok((await fs.stat(record.recordFile('permanent'))).isFile());
  });

  it('summarises a tail exactly as splitting the decoded tail did, through reused buffers', async () => {
    const legacy = async (f: string): Promise<number | undefined> => {
      const bytes = await fs.readFile(path.join(paths.TRANSCRIPTS_DIR, f));
      const start = Math.max(0, bytes.length - 128 * 1024);
      const lines = bytes.subarray(start).toString('utf8').split('\n');
      if (start) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const at: unknown = (JSON.parse(lines[i] ?? '') as { at?: unknown }).at;
          if (typeof at === 'number' && Number.isFinite(at)) return at;
        } catch {
          // not a line with a timestamp
        }
      }
      return undefined;
    };
    const filler = (n: number): string => '😀'.repeat(n);
    await write('long', '/work/project');
    // A cut tail whose first, partial line carries the newest-looking `at`:
    // the fragment must not count.
    await record.appendLine('long', { role: 'assistant', text: filler(40_000), at: NOW + 9 });
    await record.appendLine('long', { role: 'assistant', text: 'mid', at: NOW + 3 });
    await record.appendLine('long', { role: 'assistant', text: filler(10) });
    await write('short', '/work/project', NOW + 1);
    await record.appendLine(
      'nostamp',
      { role: 'user', text: 'no time' },
      { cwd: '/work/project', brand: 'codex' }
    );
    await write('cut', '/work/project');
    await record.appendLine('cut', { role: 'assistant', text: filler(33_000), at: NOW + 7 });
    // The tail starts exactly at a whole line, which splitting still dropped.
    const whole = JSON.stringify({ role: 'assistant', text: 'whole', at: NOW + 8 }) + '\n';
    const rest = JSON.stringify({ role: 'assistant', text: '' }).length + 1;
    const pad =
      JSON.stringify({ role: 'assistant', text: 'p'.repeat(128 * 1024 - whole.length - rest) }) +
      '\n';
    await fs.writeFile(
      record.recordFile('aligned'),
      JSON.stringify({
        v: record.SCHEMA,
        sessionId: 'aligned',
        cwd: '/work/project',
        brand: 'codex'
      }) +
        '\n' +
        JSON.stringify({ role: 'user', text: 'aligned', at: NOW }) +
        '\n' +
        whole +
        pad
    );
    const buffers = catalog.summaryBuffers();
    for (const f of [
      'long.jsonl',
      'short.jsonl',
      'nostamp.jsonl',
      'cut.jsonl',
      'aligned.jsonl',
      'short.jsonl'
    ]) {
      const entry = (await catalog.readHeader(f))?.entry;
      assert.ok(entry);
      const fresh = await catalog.readSummary(entry, NOW);
      const reused = await catalog.readSummary(entry, NOW, buffers);
      assert.deepEqual(reused, fresh, f);
      assert.equal(reused?.entry.summary?.at, await legacy(f), f);
    }
    assert.equal(await legacy('aligned.jsonl'), undefined, 'the aligned cut was not exercised');
    assert.equal(await legacy('long.jsonl'), NOW + 3);
  });

  it('does not certify a summary when the opened record changes during the read', async (t) => {
    await write('moving', '/work/project');
    const entry = (await catalog.readHeader('moving.jsonl'))?.entry;
    assert.ok(entry);
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === record.recordFile('moving')) {
        const read = handle.read.bind(handle);
        let changed = false;
        t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof handle.read>) => {
          if (!changed) {
            changed = true;
            await fs.appendFile(
              record.recordFile('moving'),
              JSON.stringify({ role: 'assistant', at: NOW + 1 }) + '\n'
            );
          }
          return read(...readArgs);
        });
      }
      return handle;
    });
    assert.equal((await catalog.readSummary(entry, NOW))?.stable, false);
  });
});

describe('catalog-backed conversation reads', () => {
  it('answers a cold open before publishing its catalog, then leaves unchanged reads write-free', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-repo-'));
    await record.appendLine(
      'first',
      { role: 'user', text: 'x'.repeat(118) + '😀 trailing', at: NOW },
      { cwd, brand: 'codex' }
    );
    const reader = new conversations.ConversationReader();
    const cold = await reader.read(cwd, NOW);
    assert.deepEqual(
      cold.rows.map((r) => r.sessionId),
      ['first']
    );
    await assert.rejects(fs.stat(paths.CATALOG_FILE), { code: 'ENOENT' });
    await cold.maintain();
    const warm = await read(reader, cwd);
    assert.deepEqual(warm, conversations.mergeConversations([cold.rows], cwd));
    const stamp = await fs.stat(paths.CATALOG_FILE);
    await read(reader, cwd);
    const unchanged = await fs.stat(paths.CATALOG_FILE);
    assert.deepEqual(
      [unchanged.ino, unchanged.size, unchanged.mtimeMs, unchanged.ctimeMs],
      [stamp.ino, stamp.size, stamp.mtimeMs, stamp.ctimeMs]
    );
    reader.dispose();
  });

  it('keeps oversized summaries visible without rewriting an unchanged cache', async (t) => {
    const git = await import('../../core/git');
    const cwd = '/work/' + 'x'.repeat(1840);
    t.mock.method(git, 'readCheckout', () => Promise.resolve({ repoRoot: cwd }));
    t.mock.method(git, 'readWorktrees', () => Promise.resolve([{ path: cwd }]));
    await record.appendLine(
      'oversized',
      { role: 'user', text: 't'.repeat(120), at: NOW },
      { cwd, brand: 'codex' }
    );
    const reader = new conversations.ConversationReader();
    const cold = await read(reader, cwd);
    assert.equal(cold.length, 1);
    // The cold build summarises the family before it publishes, so the
    // oversized entry never reaches the catalog.
    assert.equal((await catalog.readCatalog())?.has('oversized.jsonl'), false);
    assert.deepEqual(await read(reader, cwd), cold);
    assert.equal((await catalog.readCatalog())?.has('oversized.jsonl'), false);
    const before = await fs.stat(paths.CATALOG_FILE);
    assert.deepEqual(await read(reader, cwd), cold);
    const after = await fs.stat(paths.CATALOG_FILE);
    assert.deepEqual(
      [after.ino, after.mtimeMs, after.ctimeMs],
      [before.ino, before.mtimeMs, before.ctimeMs]
    );
    reader.dispose();
  });

  it('ranks a cold open by recorded activity, whatever order the files’ mtimes give', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-cold-order-'));
    await fs.mkdir(path.join(cwd, '.git'));
    await fs.writeFile(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    // Every record in the window, mtimes the reverse of activity: the 40
    // newest files are the 40 least recently active conversations.
    for (let i = 0; i < 45; i++) {
      const id = `reversed-${i}`;
      await write(id, cwd, NOW - i * 1000);
      await fs.utimes(record.recordFile(id), new Date(NOW - (45 - i)), new Date(NOW - (45 - i)));
    }
    const reader = new conversations.ConversationReader();
    const cold = await reader.read(cwd, NOW);
    assert.deepEqual(
      conversations.mergeConversations([cold.rows], cwd).map((r) => r.sessionId),
      Array.from({ length: 20 }, (_, i) => `reversed-${i}`)
    );
    assert.equal(cold.rows.length, 45);
    reader.dispose();
  });

  it('ranks the whole family by recorded activity, cold or cached', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-floor-'));
    await fs.mkdir(path.join(cwd, '.git'));
    await fs.writeFile(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const asked = path.join(cwd, 'app');
    await fs.mkdir(asked);
    for (let i = 0; i < 65; i++) {
      const id = `candidate-${i}`;
      await write(id, cwd, i < 30 ? 1 : NOW - i);
      await fs.utimes(record.recordFile(id), new Date(NOW - i), new Date(NOW - i));
    }
    await record.appendLine(
      'untitled',
      { role: 'assistant', text: 'working', at: NOW + 1 },
      { cwd, brand: 'codex' }
    );
    await write('asked', asked, NOW - 1000);
    const reader = new conversations.ConversationReader();
    // 30 aged records hold the newest mtimes, which would use up 30 of an mtime
    // selection's 40 slots. Every open, the first included, ranks the family
    // by recorded activity (Q6a), the asked folder's floor displacing the
    // twentieth.
    const cold = await read(reader, asked);
    assert.deepEqual(
      cold.map((r) => r.sessionId),
      [...Array.from({ length: 19 }, (_, i) => `candidate-${i + 30}`), 'asked']
    );
    assert.ok(cold.every((r) => r.lastActivity >= NOW - 30 * 86400000));
    assert.deepEqual(await read(reader, asked), cold);
    reader.dispose();
  });

  it('revives aged ended records and completed prompts on their next open', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-revive-'));
    await write('aged', cwd, 1);
    await record.appendLine(
      'pending',
      { role: 'assistant', text: 'preparing', at: NOW },
      { cwd, brand: 'codex' }
    );
    const reader = new conversations.ConversationReader();
    assert.deepEqual(await read(reader, cwd), []);
    assert.deepEqual(await read(reader, cwd), []);
    await record.appendLine('aged', { role: 'assistant', text: 'returned', at: NOW });
    await record.appendLine('pending', { role: 'user', text: 'ready', at: NOW + 1 });
    assert.deepEqual(
      (await read(reader, cwd)).map((r) => r.sessionId),
      ['pending', 'aged']
    );
    reader.dispose();
  });

  it('recovers unknown and replaced headers and survives a failed directory read', async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-replace-'));
    await write('known', cwd);
    await record.appendLine('unknown', { role: 'user', text: 'not indexed', at: NOW });
    const reader = new conversations.ConversationReader();
    await read(reader, cwd);
    await read(reader, cwd);
    const original = await fs.readFile(paths.CATALOG_FILE, 'utf8');
    const readdir = fs.readdir;
    const mock = t.mock.method(fs, 'readdir', (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === paths.TRANSCRIPTS_DIR) return Promise.reject(new Error('temporary failure'));
      return readdir(...args);
    });
    await read(reader, cwd);
    assert.equal(await fs.readFile(paths.CATALOG_FILE, 'utf8'), original);
    mock.mock.restore();
    const replacement = path.join(paths.TRANSCRIPTS_DIR, 'replacement.tmp');
    await fs.writeFile(
      replacement,
      JSON.stringify({ v: 2, sessionId: 'known', cwd, brand: 'claude' }) +
        '\n' +
        JSON.stringify({ role: 'user', text: 'replacement', at: NOW + 2 }) +
        '\n'
    );
    await fs.rename(replacement, record.recordFile('known'));
    await fs.writeFile(
      record.recordFile('unknown'),
      JSON.stringify({ v: 2, sessionId: 'unknown', cwd, brand: 'grok' }) +
        '\n' +
        JSON.stringify({ role: 'user', text: 'completed', at: NOW + 1 }) +
        '\n'
    );
    assert.deepEqual(
      (await read(reader, cwd)).map((r) => [r.sessionId, r.brand, r.title]),
      [
        ['known', 'claude', 'replacement'],
        ['unknown', 'grok', 'completed']
      ]
    );
    reader.dispose();
  });

  it('lists a record appended to during its header and summary reads without caching it', async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-live-'));
    await write('settled', cwd);
    const reader = new conversations.ConversationReader();
    await read(reader, cwd);
    await write('live', cwd, NOW + 1);
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === record.recordFile('live')) {
        const read = handle.read.bind(handle);
        t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof handle.read>) => {
          await fs.appendFile(
            record.recordFile('live'),
            JSON.stringify({ role: 'assistant', at: NOW + 2 }) + '\n'
          );
          return read(...readArgs);
        });
      }
      return handle;
    });
    assert.deepEqual(
      (await read(reader, cwd)).map((r) => r.sessionId),
      ['live', 'settled']
    );
    assert.equal((await catalog.readCatalog())?.has('live.jsonl'), false);
    reader.dispose();
  });

  it('does not cache a header whose path was replaced during the read', async (t) => {
    const asked = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-moved-'));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-other-'));
    await write('moved', other);
    const snapshot = path.join(home, 'old-header.tmp');
    await fs.copyFile(record.recordFile('moved'), snapshot);
    const reader = new conversations.ConversationReader();
    const replacement = path.join(paths.TRANSCRIPTS_DIR, 'replacement.tmp');
    await fs.writeFile(
      replacement,
      JSON.stringify({ v: 2, sessionId: 'moved', cwd: asked, brand: 'codex' }) +
        '\n' +
        JSON.stringify({ role: 'user', text: 'moved here', at: NOW }) +
        '\n'
    );
    const open = fs.open;
    let replaced = false;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === record.recordFile('moved') && !replaced) {
        // A separate old handle preserves the stale-read race without denying Windows replacement.
        const handle = await open(snapshot, args[1], args[2]);
        try {
          await fs.rename(replacement, record.recordFile('moved'));
          replaced = true;
          return handle;
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      return open(...args);
    });
    const cold = await reader.read(asked, NOW);
    assert.ok(replaced);
    // The family read after header discovery finds it again, under its real cwd.
    assert.deepEqual(
      cold.rows.map((r) => r.title),
      ['moved here']
    );
    await cold.maintain();
    assert.equal((await catalog.readCatalog())?.get('moved.jsonl')?.cwd, asked);
    assert.deepEqual(
      (await read(reader, asked)).map((r) => r.title),
      ['moved here']
    );
    reader.dispose();
  });

  it('summarises a family larger than two pages in full on its first open, publishing once and leaving reopens write-free', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-family-'));
    for (let i = 0; i < 45; i++) await write(`family-${i}`, cwd, NOW - i);
    await write('aged', cwd, NOW - 31 * 86400000);
    const reader = new conversations.ConversationReader();
    const cold = await reader.read(cwd, NOW);
    assert.deepEqual(
      cold.rows.map((r) => r.sessionId),
      Array.from({ length: 45 }, (_, i) => `family-${i}`)
    );
    await cold.maintain();
    const cached = await catalog.readCatalog();
    assert.equal(cached?.get('family-44.jsonl')?.summary?.title, 'family-44');
    assert.deepEqual(cached?.get('aged.jsonl')?.summary, { at: NOW - 31 * 86400000, aged: true });
    const published = await fs.stat(paths.CATALOG_FILE);
    const warm = await reader.read(cwd, NOW);
    assert.deepEqual(warm.rows, cold.rows);
    await warm.maintain();
    assert.equal((await fs.stat(paths.CATALOG_FILE)).mtimeMs, published.mtimeMs);
    await record.appendLine('family-44', { role: 'assistant', text: 'back', at: NOW + 5 });
    const changed = await reader.read(cwd, NOW);
    assert.equal(changed.rows[0]?.sessionId, 'family-44');
    assert.equal(changed.rows[0]?.lastActivity, NOW + 5);
    await changed.maintain();
    assert.equal((await catalog.readCatalog())?.get('family-44.jsonl')?.summary?.at, NOW + 5);
    const rewritten = await fs.stat(paths.CATALOG_FILE);
    const again = await reader.read(cwd, NOW);
    await again.maintain();
    const unchanged = await fs.stat(paths.CATALOG_FILE);
    assert.deepEqual(
      [unchanged.ino, unchanged.size, unchanged.mtimeMs],
      [rewritten.ino, rewritten.size, rewritten.mtimeMs]
    );
    reader.dispose();
  });

  it('bounds header discovery, and the next read waits for the first catalog', async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-overlap-'));
    for (let i = 0; i < 30; i++) await write(`overlap-${i}`, cwd, NOW + i);
    const reader = new conversations.ConversationReader();
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = catalog.readHeader;
    let calls = 0;
    t.mock.method(catalog, 'readHeader', async (name: string) => {
      calls++;
      if (calls === 8) started();
      await gate;
      return original(name);
    });
    const reading = reader.read(cwd, NOW);
    await eight;
    assert.equal(calls, 8);
    release();
    const cold = await reading;
    assert.equal(calls, 30);
    const building = cold.maintain();
    const joining = reader.read(cwd, NOW);
    await building;
    const warm = await joining;
    await warm.maintain();
    assert.equal(calls, 30, 'the next read discovered every header again');
    assert.deepEqual(
      conversations.mergeConversations([warm.rows], cwd),
      conversations.mergeConversations([cold.rows], cwd)
    );
    reader.dispose();
  });

  it('recovers transient header failures without certifying a negative cache hit', async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-transient-'));
    await write('recover', cwd);
    const reader = new conversations.ConversationReader();
    const failure = t.mock.method(catalog, 'readHeader', () => Promise.resolve(undefined));
    const cold = await reader.read(cwd, NOW);
    assert.deepEqual(cold.rows, []);
    await cold.maintain();
    assert.equal((await catalog.readCatalog())?.has('recover.jsonl'), false);
    failure.mock.restore();
    assert.deepEqual(
      (await read(reader, cwd)).map((r) => r.sessionId),
      ['recover']
    );
    reader.dispose();
  });

  it('keeps Windows drive spellings and UNC family boundaries through cold and warm reads', async (t) => {
    const git = await import('../../core/git');
    const { withWin32Paths } = await import('../win32_paths');
    let root = String.raw`C:\work\Foo`;
    t.mock.method(git, 'readCheckout', () => Promise.resolve({ repoRoot: root }));
    t.mock.method(git, 'readWorktrees', () => Promise.resolve([{ path: root }]));
    await write('drive', 'c:/work/Foo/child', NOW);
    await write('case-distinct', String.raw`C:\work\foo\child`, NOW + 1);
    await write('unc', '//server/share/child', NOW);
    await write('other-share', '//server/other/child', NOW + 1);
    const reader = new conversations.ConversationReader();
    await withWin32Paths(async () => {
      assert.deepEqual(
        (await read(reader, root)).map((r) => r.sessionId),
        ['drive']
      );
      assert.deepEqual(
        (await read(reader, root)).map((r) => r.sessionId),
        ['drive']
      );
      root = String.raw`\\server\share`;
      const rows = await read(reader, root);
      assert.deepEqual(
        rows.map((r) => r.sessionId),
        ['unc']
      );
      assert.equal(rows[0]?.cwd, '//server/share/child');
    });
    reader.dispose();
  });

  it('serializes an in-flight publication before committing a newer prepared view', async (t) => {
    const platform = await import('../../core/platform');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-publish-'));
    await write('active', cwd);
    const reader = new conversations.ConversationReader();
    await read(reader, cwd);
    await read(reader, cwd);
    await record.appendLine('active', { role: 'assistant', text: 'older', at: NOW + 1 });
    const older = await reader.read(cwd, NOW);
    let release = (): void => {};
    let arrived = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replacing = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const replace = platform.files.replace.bind(platform.files);
    let first = true;
    t.mock.method(platform.files, 'replace', async (...args: Parameters<typeof replace>) => {
      if (args[1] === paths.CATALOG_FILE && first) {
        first = false;
        arrived();
        await gate;
      }
      return replace(...args);
    });
    const olderWrite = older.maintain();
    await replacing;
    await record.appendLine('active', { role: 'assistant', text: 'newer', at: NOW + 2 });
    const newer = await reader.read(cwd, NOW);
    const newerWrite = newer.maintain();
    release();
    await Promise.all([olderWrite, newerWrite]);
    assert.equal((await catalog.readCatalog())?.get('active.jsonl')?.summary?.at, NOW + 2);
    reader.dispose();
  });

  it('rejects an older prepared publication after a newer read and stops maintenance on disposal', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-order-'));
    await write('first', cwd);
    const reader = new conversations.ConversationReader();
    const older = await reader.read(cwd, NOW);
    await write('second', cwd, NOW + 1);
    const newer = await reader.read(cwd, NOW);
    await newer.maintain();
    const body = await fs.readFile(paths.CATALOG_FILE, 'utf8');
    await older.maintain();
    assert.equal(await fs.readFile(paths.CATALOG_FILE, 'utf8'), body);
    assert.ok((await catalog.readCatalog())?.has('second.jsonl'));
    const pending = await reader.read(cwd, NOW);
    reader.dispose();
    await pending.maintain();
    assert.equal(await fs.readFile(paths.CATALOG_FILE, 'utf8'), body);
  });

  it('answers overlapping opens with the last one asked, and only it publishes', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-overlapping-'));
    await write('first', cwd);
    const reader = new conversations.ConversationReader();
    const [older, newer] = await Promise.all([reader.read(cwd, NOW), reader.read(cwd, NOW)]);
    assert.equal(older.current(), false);
    assert.equal(newer.current(), true);
    assert.deepEqual(
      newer.rows.map((r) => r.sessionId),
      ['first']
    );
    await older.maintain();
    assert.equal(await catalog.readCatalog(), undefined, 'the superseded open published');
    await newer.maintain();
    assert.ok((await catalog.readCatalog())?.has('first.jsonl'));
    reader.dispose();
  });
});
