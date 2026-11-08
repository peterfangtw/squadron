import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { disposeHome, tempHome } from '../helpers';
import { withFoldedKeys } from '../folded_keys';
import { withWin32Paths } from '../win32_paths';
import * as git from '../../core/git';

type Conversations = typeof import('../../core/conversations');
type RecordStore = typeof import('../../core/record');

let conversations: Conversations;
let record: RecordStore;
let home: string;

before(async () => {
  home = await tempHome();
  conversations = await import('../../core/conversations');
  record = await import('../../core/record');
});
after(async () => {
  await disposeHome(home);
});

async function write(
  id: string,
  cwd: string,
  brand: 'claude' | 'grok' | 'codex',
  title: string,
  firstAt: number,
  lastAt = firstAt
): Promise<void> {
  await record.appendLine(id, { role: 'user', text: title, at: firstAt }, { cwd, brand });
  await record.appendLine(id, { role: 'assistant', text: 'done', at: lastAt });
  const when = new Date(lastAt);
  await fs.utimes(record.recordFile(id), when, when);
}

/** Inside the 30-day window for every `at` these cases write. */
const NOW = 100_000;

/** The family's rows as a first open reads them, with no catalog yet. */
async function listed(cwd: string): Promise<import('../../core/conversations').Conversation[]> {
  const reader = new conversations.ConversationReader();
  const read = await reader.read(cwd, NOW);
  reader.dispose();
  return read.rows;
}

async function checkout(dir: string): Promise<string> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

async function worktree(main: string, tree: string, name: string): Promise<string> {
  const admin = path.join(main, '.git', 'worktrees', name);
  await fs.mkdir(admin, { recursive: true });
  await fs.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/side\n');
  await fs.writeFile(path.join(admin, 'commondir'), '../..\n');
  await fs.writeFile(path.join(admin, 'gitdir'), `${path.join(tree, '.git')}\n`);
  await fs.mkdir(tree, { recursive: true });
  await fs.writeFile(path.join(tree, '.git'), `gitdir: ${admin}\n`);
  return tree;
}

describe('a family’s conversations', () => {
  it('resumes non-Git scratch descendants without borrowing unrelated conversations', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-scratch-history-'))
    );
    const scratch = path.join(root, '.squadron', 'scratch');
    const first = path.join(scratch, 'first');
    const second = path.join(scratch, 'second');
    const unrelated = path.join(root, '.squadron', 'scratch-old', 'neighbour');
    for (const directory of [first, second, unrelated])
      await fs.mkdir(directory, { recursive: true });
    await write('scratch-first', first, 'claude', 'first scratch task', 1000);
    await write('scratch-second', second, 'codex', 'second scratch task', 2000);
    await write('scratch-unrelated', unrelated, 'grok', 'other task', 3000);
    assert.deepEqual(
      (await listed(scratch)).map((row) => [row.sessionId, row.cwd]),
      [
        ['scratch-second', second],
        ['scratch-first', first]
      ]
    );
  });
  it('keeps Windows case-distinct and cross-root records outside the checkout', async (t) => {
    let root = 'C:\\x\\Foo';
    const cwds = [
      'c:/x/Foo/child',
      'C:\\x\\foo\\child',
      'D:\\x\\Foo\\child',
      '\\\\srv\\b\\child',
      'C:\\x\\Foo\\..\\other',
      'C:\\x\\Foo2\\child'
    ];
    for (const [i, cwd] of cwds.entries())
      await write(`lexical-${i}`, cwd, 'claude', cwd, 9000 + i);
    await write('lexical-unc-good', '//srv/a/child', 'claude', 'inside', 9100);
    await write('lexical-unc-other', '\\\\srv\\b\\child', 'claude', 'outside', 9200);
    t.mock.method(git, 'readCheckout', () => Promise.resolve({ repoRoot: root }));
    t.mock.method(git, 'readWorktrees', () => Promise.resolve([{ path: root }]));
    await withWin32Paths(async () => {
      const rows = await listed(root);
      assert.deepEqual(
        rows.map((row) => row.sessionId),
        ['lexical-0']
      );
      assert.equal(rows[0]?.cwd, cwds[0]);
      root = '\\\\srv\\a';
      assert.deepEqual(
        (await listed(root)).map((row) => row.sessionId),
        ['lexical-unc-good']
      );
    });
  });

  it('returns a directory’s records newest-first, in one row shape across brands', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-conversations-'));
    await write('own-claude', cwd, 'claude', 'first line\nignored', 1000, 2000);
    await write('own-grok', cwd, 'grok', 'second', 3000, 4000);
    await write('own-codex', cwd, 'codex', 'third', 5000, 6000);

    const rows = await listed(cwd);
    assert.deepEqual(
      rows.map((row) => [row.sessionId, row.brand, row.title, row.lastActivity]),
      [
        ['own-codex', 'codex', 'third', 6000],
        ['own-grok', 'grok', 'second', 4000],
        ['own-claude', 'claude', 'first line', 2000]
      ]
    );
    assert.ok(rows.every((row) => row.titled === false));
  });

  it('sorts by recorded activity rather than file mtime', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-authored-order-'));
    await write('own-authored-newer', cwd, 'claude', 'newer', 3000);
    await write('own-authored-older', cwd, 'claude', 'older', 1000);
    await fs.utimes(record.recordFile('own-authored-newer'), new Date(1000), new Date(1000));
    await fs.utimes(record.recordFile('own-authored-older'), new Date(4000), new Date(4000));

    const rows = await listed(cwd);
    assert.deepEqual(
      rows.map((row) => row.sessionId),
      ['own-authored-newer', 'own-authored-older']
    );
  });

  it('skips a pre-index record whose header names no directory', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-unindexed-'));
    await record.appendLine('own-unindexed', { role: 'user', text: 'old', at: 1000 });
    assert.deepEqual(await listed(cwd), []);
  });

  it('skips headers that cannot identify a current indexed conversation', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-bad-header-'));
    const headers = [
      { v: record.SCHEMA + 1, sessionId: 'own-bad-schema', cwd, brand: 'claude' },
      { v: record.SCHEMA, sessionId: 'another-id', cwd, brand: 'claude' },
      { v: record.SCHEMA, sessionId: 'own-bad-brand', cwd, brand: 'other' },
      { v: record.SCHEMA, sessionId: 'own-bad-cwd', cwd: 42, brand: 'claude' }
    ];
    const ids = ['own-bad-schema', 'own-bad-id', 'own-bad-brand', 'own-bad-cwd'];
    await fs.mkdir(path.dirname(record.recordFile(ids[0] ?? '')), { recursive: true });
    await Promise.all(
      ids.map((id, index) =>
        fs.writeFile(
          record.recordFile(id),
          `${JSON.stringify(headers[index])}\n${JSON.stringify({ role: 'user', text: id, at: 1000 })}\n`
        )
      )
    );

    assert.deepEqual(await listed(cwd), []);
  });

  it('cuts a prompt title at 120 characters', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-title-'));
    await write('own-long', cwd, 'claude', 'x'.repeat(140), 1000);
    const [row] = await listed(cwd);
    assert.equal(row?.title.length, 120);
    assert.ok(row?.title.endsWith('…'));
  });

  it('includes sibling worktrees and resolves each row’s branch', async () => {
    const repo = await checkout(await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-repo-')));
    const tree = await worktree(
      repo,
      await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-tree-')),
      'side'
    );
    await write('own-root', repo, 'claude', 'root', 1000);
    await write('own-side', tree, 'codex', 'side', 2000);

    const rows = await listed(repo);
    assert.deepEqual(
      rows.map((row) => [row.sessionId, row.cwd, row.branch]),
      [
        ['own-side', tree, 'side'],
        ['own-root', repo, 'main']
      ]
    );
  });

  it('excludes nested repositories and working directories that no longer exist', async () => {
    const repo = await checkout(await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-boundary-')));
    const nested = await checkout(path.join(repo, 'vendor', 'sdk'));
    const missing = path.join(repo, 'trees', 'removed');
    await write('own-boundary-root', repo, 'claude', 'root', 1000);
    await write('own-boundary-nested', nested, 'claude', 'nested', 3000);
    await write('own-boundary-missing', missing, 'claude', 'missing', 2000);

    const rows = await listed(repo);
    assert.deepEqual(
      rows.map((row) => row.sessionId),
      ['own-boundary-root']
    );
  });

  it('keeps a floor for the directory that opened the picker', async () => {
    const repo = await checkout(await fs.mkdtemp(path.join(os.tmpdir(), 'av-own-floor-')));
    const app = path.join(repo, 'apps', 'web');
    await fs.mkdir(app, { recursive: true });
    for (let i = 0; i < 8; i++) {
      await write(`own-busy-${i}`, repo, 'grok', `busy ${i}`, 10_000 + i);
    }
    await write('own-here', app, 'claude', 'here', 1000);

    const rows = conversations.mergeConversations(await listed(app), app, 4);
    assert.equal(rows.length, 4);
    assert.ok(rows.some((row) => row.sessionId === 'own-here'));
  });
});

describe('mergeConversations', () => {
  it('keeps the floor for the asked directory under another spelling of it', () =>
    withFoldedKeys(() => {
      const row = (sessionId: string, cwd: string, lastActivity: number) => ({
        sessionId,
        title: sessionId,
        titled: false,
        lastActivity,
        cwd,
        brand: 'claude' as const
      });
      const busy = [1, 2, 3, 4].map((i) => row(`busy-${i}`, '/repo', 10 + i));
      const rows = conversations.mergeConversations(
        [...busy, row('here', '/Repo/Apps/Web', 1)],
        '/repo/apps/web',
        2
      );
      assert.deepEqual(
        rows.map((r) => r.sessionId),
        ['busy-4', 'here']
      );
    }));
});
