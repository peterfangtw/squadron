import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  TurnCheckpoints,
  attribute,
  attributeExecution,
  type ExecutionCoverage,
  capture,
  changesBetween,
  headMoves,
  selectExecution,
  type ExecutionBoundary,
  type ExecutionTurn,
  type Snapshot,
  type TurnCheckpoint,
  type TurnWindow
} from '../../core/checkpoint';
import { readTree, type Tree } from '../../core/git';
import { linkDir } from '../helpers';

/**
 * Against real repositories, like `git_show.test.ts` next door and unlike
 * `git.test.ts`: the module runs git rather than parsing its files, so a
 * hand-built `.git` would prove nothing about what `write-tree` and `diff-tree`
 * actually answer.
 *
 * Every write below goes through `fs`, never through a tool frame — which is
 * the whole point of the module. A test that used `Write` would be testing the
 * path that already worked.
 */

const run = promisify(execFile);

/**
 * `GIT_*` stripped, per `src/test/AGENTS.md`. The gate runs from the pre-commit
 * hook, which exports `GIT_DIR` and `GIT_INDEX_FILE` pointing at *this*
 * checkout, and they beat `-C` — so without this the temp repo's commands
 * silently read the repository being committed. This module sets
 * `GIT_INDEX_FILE` itself, which makes the trap worse rather than better.
 */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);

/**
 * Everything this file put in the temp directory, removed when it is done.
 *
 * Not housekeeping. Each `repo()` is a real git repository and the file makes
 * about thirty of them per run; left behind they accumulate across runs — 440
 * of them had piled up before this was added — and a temp directory that full
 * makes every later `mkdtemp` and `git init` in the whole suite slower, which
 * reads as an unrelated file hanging.
 */
const litter: string[] = [];

after(async () => {
  await Promise.all(litter.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  litter.push(dir);
  return dir;
}

/**
 * A repository with one commit. The realpath matters: `os.tmpdir()` is
 * `/var/folders/…`, a symlink to `/private/var/folders/…`, and `git worktree
 * add` records the resolved form.
 */
async function repo(files: Record<string, string> = { 'kept.txt': 'a\nb\nc\n' }): Promise<string> {
  const dir = await temp('squadron-ck-');
  const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  await git('add', '-A');
  await git('commit', '-m', 'first');
  return dir;
}

async function treeOf(dir: string): Promise<Tree> {
  const at = await readTree(dir);
  assert.ok(at, `no working tree at ${dir}`);
  return at;
}

describe('execution source selection', () => {
  it('persists proven aliases on precise windows without a retained floor', async () => {
    const dir = await repo();
    const alias = `${dir}-alias`;
    litter.push(alias);
    await linkDir(dir, alias);
    const tree = await treeOf(alias);
    const start = Date.now();
    const from = await capture(tree, 'alias-call');
    await fs.writeFile(path.join(dir, 'shell.txt'), 'command\n');
    const to = await capture(tree, 'alias-call');
    assert.ok(from && to);
    const selected = await selectExecution(
      {
        owner: 'alias-owner',
        runtime: 'alias-runtime',
        turn: 'alias-turn',
        tree: tree.treeRoot,
        start,
        end: to.at,
        observed: true,
        calls: [{ actor: 'alias-owner', call: 'alias-call', eligibility: 'write', settled: true }]
      },
      (
        [
          ['before', from],
          ['after', to]
        ] as const
      ).map(([edge, snapshot]) => ({
        version: 1,
        kind: 'execution',
        owner: 'alias-owner',
        runtime: 'alias-runtime',
        actor: 'alias-owner',
        call: 'alias-call',
        tree: tree.treeRoot,
        edge,
        start: snapshot.at,
        end: snapshot.at,
        snapshot
      }))
    );
    assert.equal(selected.source, 'execution');
    assert.equal(selected.floor, undefined);
    assert.deepEqual(selected.windows[0]?.changes.files, [path.join(dir, 'shell.txt')]);
    assert.ok(selected.windows[0]?.aliases?.includes(alias));
  });

  it('measures leaf writes while dropping writes in the gaps between commands', async () => {
    const dir = await repo();
    const tree = await treeOf(dir);
    const floorFrom = await capture(tree, 'floor');
    const edges: ExecutionBoundary[] = [];
    for (const [call, file] of [
      ['first', 'first.txt'],
      ['second', 'second.txt']
    ] as const) {
      const from = await capture(tree, call);
      await fs.writeFile(path.join(dir, file), 'command\n');
      const to = await capture(tree, call);
      assert.ok(from && to);
      edges.push({
        version: 1,
        kind: 'execution',
        owner: 'owner',
        runtime: 'runtime',
        actor: 'actor',
        call,
        tree: dir,
        edge: 'before',
        start: from.startedAt ?? from.at,
        end: from.at,
        snapshot: from
      });
      edges.push({
        version: 1,
        kind: 'execution',
        owner: 'owner',
        runtime: 'runtime',
        actor: 'actor',
        call,
        tree: dir,
        edge: 'after',
        start: to.startedAt ?? to.at,
        end: to.at,
        snapshot: to
      });
      if (call === 'first') await fs.writeFile(path.join(dir, 'gap.txt'), 'editor\n');
    }
    const floorTo = await capture(tree, 'floor');
    assert.ok(floorFrom && floorTo);
    const changes = await changesBetween(tree, floorFrom.tree, floorTo.tree);
    assert.ok(changes);
    const selected = await selectExecution(
      {
        owner: 'owner',
        runtime: 'runtime',
        turn: 'turn',
        tree: dir,
        start: floorFrom.startedAt ?? floorFrom.at,
        end: floorTo.at,
        observed: true,
        calls: ['first', 'second'].map((call) => ({
          actor: 'actor',
          call,
          eligibility: 'write',
          settled: true
        })),
        floor: { tree: dir, from: floorFrom, to: floorTo, changes }
      },
      edges
    );
    assert.equal(selected.source, 'execution');
    const drawn = attributeExecution(selected, []);
    assert.deepEqual(drawn.files, [path.join(dir, 'first.txt'), path.join(dir, 'second.txt')]);
    assert.deepEqual(drawn.sizes, {
      [path.join(dir, 'first.txt')]: { add: 1, del: 0 },
      [path.join(dir, 'second.txt')]: { add: 1, del: 0 }
    });
    assert.ok(changes.files.includes(path.join(dir, 'gap.txt')));
  });

  const turn = (over: Partial<ExecutionTurn> = {}): ExecutionTurn => ({
    owner: 'brand\0owner',
    runtime: 'runtime',
    turn: 'generation-1',
    tree: '/tree',
    start: 100,
    end: 300,
    observed: true,
    calls: [{ actor: 'actor', call: 'call', eligibility: 'write', settled: true }],
    floor: {
      tree: '/tree',
      from: { tree: 'a'.repeat(40), head: 'h', at: 100 },
      to: { tree: 'b'.repeat(40), head: 'h', at: 300 },
      changes: { files: ['/tree/gap'], sizes: {} }
    },
    ...over
  });
  const edge = (
    edge: 'before' | 'after',
    over: Partial<ExecutionBoundary> = {}
  ): ExecutionBoundary => ({
    version: 1,
    kind: 'execution',
    owner: 'brand\0owner',
    runtime: 'runtime',
    actor: 'actor',
    call: 'call',
    tree: '/tree',
    edge,
    start: edge === 'before' ? 120 : 180,
    end: edge === 'before' ? 130 : 190,
    snapshot: { tree: 'a'.repeat(40), head: 'h', at: edge === 'before' ? 130 : 190 },
    ...over
  });

  it('replaces the floor on a verified empty execution and excludes gap writes', async () => {
    const selected = await selectExecution(turn(), [edge('before'), edge('after')]);
    assert.equal(selected.source, 'execution');
    assert.deepEqual(
      selected.windows.flatMap((w) => w.changes.files),
      []
    );
  });

  it('accepts zero calls only with independent complete observation', async () => {
    assert.equal((await selectExecution(turn({ calls: [] }), [])).source, 'execution');
    assert.equal((await selectExecution(turn({ calls: [], observed: false }), [])).source, 'turn');
  });

  it('keeps the floor for missing, failed, pending, and interrupted captures', async () => {
    for (const boundaries of [
      [],
      [edge('before')],
      [edge('before', { snapshot: undefined }), edge('after')],
      [edge('before'), edge('after', { pending: true })],
      [edge('before'), edge('after', { runtime: 'old-runtime' })],
      [edge('before'), edge('after', { actor: 'peer' })],
      [edge('before'), edge('after', { tree: '/another-worktree' })],
      [edge('before'), edge('after', { context: 'another-turn' })]
    ])
      assert.equal((await selectExecution(turn(), boundaries)).source, 'turn');
    assert.equal((await selectExecution(turn({ floor: undefined }), [])).source, 'none');
  });

  it('rejects ambiguous duplicate/reversed pairs and calls not yet settled', async () => {
    assert.equal(
      (await selectExecution(turn(), [edge('before'), edge('before'), edge('after')])).source,
      'turn'
    );
    assert.equal(
      (await selectExecution(turn(), [edge('before'), edge('after', { start: 110, end: 115 })]))
        .source,
      'turn'
    );
    assert.equal(
      (
        await selectExecution(
          turn({ calls: [{ actor: 'actor', call: 'call', eligibility: 'write', settled: false }] }),
          [edge('before'), edge('after')]
        )
      ).source,
      'turn'
    );
  });

  it('requires ownership observations for captured native child calls', async () => {
    const boundaries = [
      edge('before'),
      edge('after'),
      edge('before', { actor: 'child', call: 'child-call' }),
      edge('after', { actor: 'child', call: 'child-call' })
    ];
    assert.equal((await selectExecution(turn(), boundaries)).source, 'turn');
    const calls = [
      ...turn().calls,
      { actor: 'child', call: 'child-call', eligibility: 'write' as const, settled: true }
    ];
    assert.equal((await selectExecution(turn({ calls }), boundaries)).source, 'execution');
  });

  it('keeps unknown tools conservative and exempts observed read-only calls', async () => {
    assert.equal(
      (
        await selectExecution(
          turn({
            calls: [{ actor: 'actor', call: 'call', eligibility: 'unknown', settled: true }]
          }),
          [edge('before'), edge('after')]
        )
      ).source,
      'turn'
    );
    assert.equal(
      (
        await selectExecution(
          turn({ calls: [{ actor: 'actor', call: 'call', eligibility: 'read', settled: true }] }),
          []
        )
      ).source,
      'execution'
    );
  });
});

describe('execution attribution', () => {
  const interval = (start: number, end: number): TurnCheckpoint => ({
    tree: '/tree',
    from: { tree: 'a', head: 'h', at: start },
    to: { tree: 'b', head: 'h', at: end },
    changes: { files: ['/tree/file'], sizes: { '/tree/file': { add: 2, del: 1 } } }
  });
  const coverage = (windows: TurnCheckpoint[]): ExecutionCoverage => ({
    version: 1,
    kind: 'coverage',
    owner: 'owner',
    runtime: 'runtime',
    turn: 'turn',
    tree: '/tree',
    start: 100,
    end: 300,
    source: 'execution',
    calls: [],
    windows
  });

  it('sums sequential windows once per path', () => {
    assert.deepEqual(attributeExecution(coverage([interval(100, 150), interval(200, 250)]), []), {
      files: ['/tree/file'],
      sizes: { '/tree/file': { add: 4, del: 2 } }
    });
  });
  it('omits inferred counts for overlapping same-owner windows', () => {
    assert.deepEqual(attributeExecution(coverage([interval(100, 200), interval(150, 250)]), []), {
      files: ['/tree/file'],
      sizes: {}
    });
  });
  it('withholds a candidate under unresolved competing evidence, not an awake peer alone', () => {
    const decision = coverage([interval(100, 200)]);
    assert.deepEqual(
      attributeExecution(decision, [
        { sid: 'them', start: 120, end: 180, paths: [], uncertain: true }
      ]),
      { files: [], sizes: {}, concurrent: true }
    );
    assert.deepEqual(
      attributeExecution(decision, [{ sid: 'them', start: 120, end: 180, paths: ['/tree/other'] }]),
      { files: ['/tree/file'], sizes: { '/tree/file': { add: 2, del: 1 } } }
    );
  });
  it('keeps rewrite suppression on each selected interval', () => {
    const rewritten = {
      ...interval(100, 200),
      moves: ['checkout'],
      to: { tree: 'b', head: 'new', at: 200 }
    };
    assert.deepEqual(attributeExecution(coverage([rewritten, interval(210, 250)]), []), {
      files: ['/tree/file'],
      sizes: { '/tree/file': { add: 2, del: 1 } }
    });
  });
});

describe('capture', () => {
  it('keeps differently spelled call owners on separate private indexes', async () => {
    const tree = await treeOf(await repo());
    assert.ok(await capture(tree, 'runtime:actor/call'));
    assert.ok(await capture(tree, 'runtime/actor:call'));
    const indexes = (await fs.readdir(tree.gitDir)).filter((file) =>
      /^squadron-.*\.index$/.test(file)
    );
    assert.equal(indexes.length, 2);
  });

  it('records the whole staging interval rather than pretending Git is atomic', async () => {
    const before = Date.now();
    const shot = await capture(await treeOf(await repo()), 'span');
    assert.ok(shot);
    assert.ok('startedAt' in shot);
    assert.equal(typeof shot.startedAt, 'number');
    assert.ok(Number(shot.startedAt) >= before && Number(shot.startedAt) <= shot.at);
  });

  it('answers a tree and the sha HEAD is on', async () => {
    const dir = await repo();
    const shot = await capture(await treeOf(dir), 'owner');
    assert.ok(shot);
    assert.match(shot.tree, /^[0-9a-f]{40,}$/);
    assert.match(shot.head ?? '', /^[0-9a-f]{40,}$/);
    assert.ok(shot.at > 0);
  });

  it('keeps its index inside the git directory, never in the tree', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    await capture(at, 'owner');
    assert.ok(
      (
        await fs.stat(
          path.join(
            at.gitDir,
            `squadron-${createHash('sha256').update('owner').digest('hex')}.index`
          )
        )
      ).isFile()
    );
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir, env: CLEAN });
    assert.equal(stdout.trim(), '', 'the capture must leave the working tree clean');
  });

  it("leaves the reader's own index and HEAD exactly where they were", async () => {
    const dir = await repo();
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await fs.writeFile(path.join(dir, 'staged.txt'), 'staged\n');
    await git('add', 'staged.txt');
    const before = (await git('diff', '--cached', '--name-only')).stdout;
    const head = (await git('rev-parse', 'HEAD')).stdout;

    await capture(await treeOf(dir), 'owner');

    assert.equal((await git('diff', '--cached', '--name-only')).stdout, before);
    assert.equal((await git('rev-parse', 'HEAD')).stdout, head);
  });

  it('answers the same tree warm as a cold index would', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const first = await capture(at, 'owner');
    await fs.writeFile(path.join(dir, 'kept.txt'), 'a\nb\nc\nd\n');
    const warm = await capture(at, 'owner');

    // What a caller with no index of its own would get for the same tree.
    const fresh = await temp('squadron-ck-idx-');
    const env = { ...CLEAN, GIT_INDEX_FILE: path.join(fresh, 'index') };
    await run('git', ['read-tree', 'HEAD'], { cwd: dir, env });
    await run('git', ['add', '-A', '--', '.'], { cwd: dir, env });
    const cold = (await run('git', ['write-tree'], { cwd: dir, env })).stdout.trim();

    assert.notEqual(warm?.tree, first?.tree);
    assert.equal(warm?.tree, cold);
  });

  it('answers nothing outside a repository', async () => {
    const dir = await temp('squadron-ck-bare-');
    assert.equal(
      await capture({ treeRoot: dir, gitDir: path.join(dir, '.git') }, 'owner'),
      undefined
    );
  });

  /**
   * The half of rule 3 a sha cannot make. A conflicted merge stops before
   * committing, so HEAD has not moved and the tree holds every file the merge
   * touched — an overlap test never fires and a sha comparison reads "unchanged".
   */
  it('names the operation a conflicted merge left the tree in, with HEAD unmoved', async () => {
    const dir = await repo({ 'clash.txt': 'base\n' });
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('checkout', '-b', 'other');
    await fs.writeFile(path.join(dir, 'clash.txt'), 'theirs\n');
    await git('commit', '-am', 'theirs');
    await git('checkout', 'main');
    await fs.writeFile(path.join(dir, 'clash.txt'), 'ours\n');
    await git('commit', '-am', 'ours');
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('merge', 'other').catch(() => undefined);

    const shot = await capture(await treeOf(dir), 'owner');
    assert.equal(shot?.op, 'merge');
    assert.equal(shot?.head, head, 'a conflicted merge does not move HEAD');
    assert.match(shot?.tree ?? '', /^[0-9a-f]{40,}$/, 'the tree is real, only unattributable');
  });

  it('names a stopped cherry-pick, and says nothing once it is resolved', async () => {
    const dir = await repo({ 'clash.txt': 'base\n' });
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('checkout', '-b', 'other');
    await fs.writeFile(path.join(dir, 'clash.txt'), 'theirs\n');
    await git('commit', '-am', 'theirs');
    await git('checkout', 'main');
    await fs.writeFile(path.join(dir, 'clash.txt'), 'ours\n');
    await git('commit', '-am', 'ours');
    await git('cherry-pick', 'other').catch(() => undefined);

    assert.equal((await capture(await treeOf(dir), 'owner'))?.op, 'cherry-pick');
    await git('cherry-pick', '--abort').catch(() => undefined);
    assert.equal((await capture(await treeOf(dir), 'owner'))?.op, undefined);
  });

  it('says nothing about an operation on a tree that finished one', async () => {
    const dir = await repo();
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('checkout', '-b', 'other');
    await fs.writeFile(path.join(dir, 'added.txt'), 'x\n');
    await git('add', '-A');
    await git('commit', '-m', 'clean');
    await git('checkout', 'main');
    await git('merge', 'other');

    // `MERGE_MSG` survives a completed merge, which is why it is not a marker.
    assert.equal((await capture(await treeOf(dir), 'owner'))?.op, undefined);
  });
});

describe('changesBetween', () => {
  /** The case the whole task exists for: no tool frame named any of this. */
  it('recovers a write no tool frame carried', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const from = await capture(at, 'owner');
    assert.ok(from);

    await fs.writeFile(path.join(dir, 'by-shell.txt'), 'one\ntwo\n');
    const to = await capture(at, 'owner');
    assert.ok(to);

    assert.deepEqual(await changesBetween(at, from.tree, to.tree), {
      files: [path.join(dir, 'by-shell.txt')],
      sizes: { [path.join(dir, 'by-shell.txt')]: { add: 2, del: 0 } }
    });
  });

  it('counts an edit both ways, and reports a deletion as removal alone', async () => {
    const dir = await repo({ 'kept.txt': 'a\nb\nc\n', 'gone.txt': 'x\n' });
    const at = await treeOf(dir);
    const from = await capture(at, 'owner');
    await fs.writeFile(path.join(dir, 'kept.txt'), 'a\nB\nc\nd\n');
    await fs.rm(path.join(dir, 'gone.txt'));
    const to = await capture(at, 'owner');

    assert.deepEqual(await changesBetween(at, from?.tree ?? '', to?.tree ?? ''), {
      files: [path.join(dir, 'gone.txt'), path.join(dir, 'kept.txt')],
      sizes: {
        [path.join(dir, 'kept.txt')]: { add: 2, del: 1 },
        [path.join(dir, 'gone.txt')]: { add: 0, del: 1 }
      }
    });
  });

  /** A binary file has a pill and no counts — what `chat.ts` already draws for a
   *  write `sizeOf` could not read. Absent from the map is a file *unchanged*. */
  it('names a binary file with no counts rather than dropping it', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const from = await capture(at, 'owner');
    await fs.writeFile(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 0, 3]));
    const to = await capture(at, 'owner');

    const changed = await changesBetween(at, from?.tree ?? '', to?.tree ?? '');
    assert.deepEqual(changed?.files, [path.join(dir, 'pic.bin')]);
    assert.deepEqual(changed?.sizes, {}, 'named, with no magnitude to state');
  });

  it('carries a path with a space in it, which is why the read is -z', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const from = await capture(at, 'owner');
    await fs.mkdir(path.join(dir, 'deep er'), { recursive: true });
    await fs.writeFile(path.join(dir, 'deep er', 'odd name.txt'), 'q\n');
    const to = await capture(at, 'owner');

    assert.deepEqual((await changesBetween(at, from?.tree ?? '', to?.tree ?? ''))?.files, [
      path.join(dir, 'deep er', 'odd name.txt')
    ]);
  });

  it('answers an empty set for two identical trees, which is not the same as nothing', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const shot = await capture(at, 'owner');
    assert.deepEqual(await changesBetween(at, shot?.tree ?? '', shot?.tree ?? ''), {
      files: [],
      sizes: {}
    });
  });

  it('answers nothing when a tree object has gone', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const shot = await capture(at, 'owner');
    assert.equal(await changesBetween(at, 'f'.repeat(40), shot?.tree ?? ''), undefined);
  });

  /** `.gitignore` is respected by `add -A`, so this is invisible on purpose —
   *  the same blindness `git status` has. Stated as a test so it is chosen. */
  it('does not see a write to an ignored path', async () => {
    const dir = await repo({ 'kept.txt': 'a\n', '.gitignore': 'built/\n' });
    const at = await treeOf(dir);
    const from = await capture(at, 'owner');
    await fs.mkdir(path.join(dir, 'built'), { recursive: true });
    await fs.writeFile(path.join(dir, 'built', 'out.js'), 'compiled\n');
    const to = await capture(at, 'owner');

    assert.deepEqual(await changesBetween(at, from?.tree ?? '', to?.tree ?? ''), {
      files: [],
      sizes: {}
    });
  });

  /** A worktree writes only in its own tree, and the paths come back rooted
   *  there — not in the repo it was cut from, which is what `repoRoot` names. */
  it('roots a linked worktree’s paths in that worktree', async () => {
    const main = await repo();
    const side = path.join(path.dirname(main), `${path.basename(main)}-side`);
    litter.push(side);
    await run('git', ['worktree', 'add', '-b', 'side', side], { cwd: main, env: CLEAN });

    const at = await treeOf(side);
    const from = await capture(at, 'owner');
    await fs.writeFile(path.join(side, 'only-here.txt'), 'x\n');
    const to = await capture(at, 'owner');

    assert.deepEqual((await changesBetween(at, from?.tree ?? '', to?.tree ?? ''))?.files, [
      path.join(side, 'only-here.txt')
    ]);
  });
});

describe('attribute', () => {
  it('subtracts an alias-spelled legacy path even when the file is deleted', async () => {
    const dir = await repo();
    const alias = path.join(await temp('squadron-alias-'), 'alias');
    await linkDir(dir, alias);
    await readTree(alias);
    const file = path.join(dir, 'deleted.txt');
    const ck: TurnCheckpoint = {
      tree: dir,
      from: { tree: 'a', head: 'h', at: 100 },
      to: { tree: 'b', head: 'h', at: 200 },
      changes: { files: [file], sizes: { [file]: { add: 0, del: 2 } } }
    };
    assert.deepEqual(
      attribute(ck, 'me', [
        {
          sid: 'them',
          start: 110,
          end: 190,
          paths: [path.join(alias, 'deleted.txt')]
        }
      ]),
      { files: [], sizes: {}, concurrent: true }
    );
  });

  const shot = (at: number, over: Partial<Snapshot> = {}): Snapshot => ({
    tree: `t${at}`,
    head: 'head0',
    at,
    ...over
  });

  const mine = (over: Partial<TurnCheckpoint> = {}): TurnCheckpoint => ({
    tree: '/repo',
    from: shot(100),
    to: shot(200),
    changes: { files: ['/repo/a.ts', '/repo/b.ts'], sizes: { '/repo/a.ts': { add: 3, del: 1 } } },
    ...over
  });

  const window = (over: Partial<TurnWindow> = {}): TurnWindow => ({
    sid: 'them',
    start: 0,
    end: 10,
    paths: [],
    ...over
  });

  it('draws everything where the tree was ours alone', () => {
    assert.deepEqual(attribute(mine(), 'me', []), {
      files: ['/repo/a.ts', '/repo/b.ts'],
      sizes: { '/repo/a.ts': { add: 3, del: 1 } }
    });
  });

  /** What rule 1 buys, and the case the 67% measurement is about: a neighbour
   *  that took its turn *before* mine opened is already inside my baseline. */
  it('ignores a neighbour whose turn closed before mine opened', () => {
    const before = window({ start: 10, end: 99, paths: ['/repo/a.ts'] });
    assert.deepEqual(attribute(mine(), 'me', [before]), {
      files: ['/repo/a.ts', '/repo/b.ts'],
      sizes: { '/repo/a.ts': { add: 3, del: 1 } }
    });
  });

  it('ignores my own earlier turns, which cannot contest me', () => {
    const own = window({ sid: 'me', start: 150, end: 160, paths: ['/repo/a.ts'] });
    assert.deepEqual(attribute(mine(), 'me', [own]), {
      files: ['/repo/a.ts', '/repo/b.ts'],
      sizes: { '/repo/a.ts': { add: 3, del: 1 } }
    });
  });

  /**
   * The plain overlap: windows intersect, on different files. 91% of overlapped
   * turns that named files. Nothing subtracted and **nothing marked** — the list
   * is complete, and a badge would say only that somebody else was awake, on
   * 85.6% of this checkout's writer turns.
   */
  it('says nothing about an overlap that touched none of my files', () => {
    const beside = window({ start: 150, end: 250, paths: ['/repo/theirs.ts'] });
    assert.deepEqual(attribute(mine(), 'me', [beside]), {
      files: ['/repo/a.ts', '/repo/b.ts'],
      sizes: { '/repo/a.ts': { add: 3, del: 1 } }
    });
  });

  /** The honest form the findings doc asks for: omit the contested file rather
   *  than name it with a badge on. */
  it('subtracts a file an overlapping neighbour also touched', () => {
    const clash = window({ start: 150, end: 250, paths: ['/repo/a.ts'] });
    assert.deepEqual(attribute(mine(), 'me', [clash]), {
      files: ['/repo/b.ts'],
      sizes: {},
      concurrent: true
    });
  });

  it('keeps the marker when subtraction leaves nothing at all', () => {
    const clash = window({ start: 150, end: 250, paths: ['/repo/a.ts', '/repo/b.ts'] });
    assert.deepEqual(attribute(mine(), 'me', [clash]), {
      files: [],
      sizes: {},
      concurrent: true
    });
  });

  it('subtracts across several overlapping neighbours at once', () => {
    const one = window({ sid: 'x', start: 150, end: 160, paths: ['/repo/a.ts'] });
    const two = window({ sid: 'y', start: 190, end: 500, paths: ['/repo/b.ts'] });
    assert.deepEqual(attribute(mine(), 'me', [one, two]).files, []);
  });

  /** Rule 3. A `checkout`, `merge` or `reset --hard` rewrites the tree by every
   *  file between two commits, with no neighbour involved. */
  it('withholds every path where HEAD moved under the turn', () => {
    const moved = mine({ to: shot(200, { head: 'head1' }) });
    assert.deepEqual(attribute(moved, 'me', []), { files: [], sizes: {} });
  });

  /** The half a sha cannot see: a conflicted merge leaves HEAD where it was. */
  it('withholds where the tree was part-way through a git operation', () => {
    const mid = mine({ to: shot(200, { op: 'merge' }) });
    assert.deepEqual(attribute(mid, 'me', []), { files: [], sizes: {} });
    const started = mine({ from: shot(100, { op: 'rebase' }) });
    assert.deepEqual(attribute(started, 'me', []), { files: [], sizes: {} });
  });

  /** Rule 3 is not a concurrency event, so it never raises the marker — the
   *  marker means "a path was taken out of this list". */
  it('withholds on a rewrite without calling it concurrency', () => {
    const moved = mine({ to: shot(200, { head: 'head1' }) });
    const beside = window({ start: 150, end: 250, paths: ['/repo/a.ts'] });
    assert.deepEqual(attribute(moved, 'me', [beside]), { files: [], sizes: {} });
  });

  /** 18.9% of writer turns run `git commit`, which touches no working-tree file,
   *  so the diff across it is still exactly the turn's own writes. */
  it('keeps every pill on a turn that committed its own work', () => {
    const committed = mine({ to: shot(200, { head: 'head1' }), moves: ['commit'] });
    assert.deepEqual(attribute(committed, 'me', []), {
      files: ['/repo/a.ts', '/repo/b.ts'],
      sizes: { '/repo/a.ts': { add: 3, del: 1 } }
    });
    const twice = mine({ to: shot(200, { head: 'head1' }), moves: ['commit', 'commit (amend)'] });
    assert.equal(attribute(twice, 'me', []).files.length, 2);
  });

  it('withholds where a commit run has anything else mixed into it', () => {
    const pulled = mine({
      to: shot(200, { head: 'head1' }),
      moves: ['commit', 'merge origin/main']
    });
    assert.deepEqual(attribute(pulled, 'me', []), { files: [], sizes: {} });
  });

  it('withholds where HEAD moved and the reflog cannot say how', () => {
    const opaque = mine({ to: shot(200, { head: 'head1' }), moves: undefined });
    assert.deepEqual(attribute(opaque, 'me', []), { files: [], sizes: {} });
  });

  /** Touching at an instant is not overlap: a turn that ended exactly as the
   *  next began wrote nothing inside the other's window. */
  it('does not count a neighbour that merely abuts my window', () => {
    const before = window({ start: 0, end: 100, paths: ['/repo/a.ts'] });
    const after = window({ start: 200, end: 300, paths: ['/repo/a.ts'] });
    assert.equal(attribute(mine(), 'me', [before]).concurrent, undefined);
    assert.equal(attribute(mine(), 'me', [after]).concurrent, undefined);
    assert.equal(attribute(mine(), 'me', [before, after]).files.length, 2);
  });

  it('counts a neighbour whose window swallows mine whole', () => {
    const around = window({ start: 0, end: 999, paths: ['/repo/a.ts'] });
    assert.equal(attribute(mine(), 'me', [around]).concurrent, true);
  });

  it('says nothing at all where the turn changed nothing', () => {
    const quiet = mine({ changes: { files: [], sizes: {} } });
    assert.deepEqual(attribute(quiet, 'me', []), { files: [], sizes: {} });
  });
});

describe('headMoves', () => {
  it('names a plain commit, which does not touch the working tree', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    await fs.writeFile(path.join(dir, 'kept.txt'), 'a\nb\nc\nd\n');
    await git('commit', '-am', 'second');
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();

    assert.deepEqual(await headMoves(at, before, after), ['commit']);
  });

  it('names every commit of a run of them', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    for (const n of ['two', 'three']) {
      await fs.writeFile(path.join(dir, `${n}.txt`), `${n}\n`);
      await git('add', '-A');
      await git('commit', '-m', n);
    }
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();
    assert.deepEqual(await headMoves(at, before, after), ['commit', 'commit']);
  });

  it('names an amend, which also leaves the tree alone', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('commit', '--amend', '--allow-empty', '-m', 'reworded');
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();
    assert.deepEqual(await headMoves(at, before, after), ['commit (amend)']);
  });

  /** The verbs rule 3 exists for. Each rewrites the working tree, and each gets
   *  a reflog action of its own — verified against git 2.39 on 2026-08-22. */
  it('names a switch to a branch with other content as a checkout', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('checkout', '-b', 'side');
    await fs.writeFile(path.join(dir, 'only-side.txt'), 'x\n');
    await git('add', '-A');
    await git('commit', '-m', 'side');
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', 'main');
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();

    assert.deepEqual(await headMoves(at, before, after), ['checkout']);
  });

  /**
   * `git checkout -b` at the same commit rewrites nothing, so the reflog entry
   * has `old === new` and never enters the walk. Asserted because the first
   * version of the test above used it and read the *correct* answer as a bug.
   */
  it('does not call a branch created at the current commit a rewrite', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-b', 'side');
    await fs.writeFile(path.join(dir, 'only-side.txt'), 'x\n');
    await git('add', '-A');
    await git('commit', '-m', 'side');
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();

    assert.deepEqual(await headMoves(at, before, after), ['commit']);
  });

  it('names a cherry-pick and a revert as themselves', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('checkout', '-b', 'side');
    await fs.writeFile(path.join(dir, 'picked.txt'), 'p\n');
    await git('add', '-A');
    await git('commit', '-m', 'two');
    await git('checkout', 'main');
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('cherry-pick', 'side');
    await git('revert', '--no-edit', 'HEAD');
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();

    assert.deepEqual(await headMoves(at, before, after), ['cherry-pick', 'revert']);
  });

  it('names a fast-forward merge as a merge, which is the pull that would slip a sha test', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('checkout', '-b', 'side');
    await fs.writeFile(path.join(dir, 'ff.txt'), 'f\n');
    await git('add', '-A');
    await git('commit', '-m', 'ff');
    await git('checkout', 'main');
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('merge', 'side');
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();

    assert.deepEqual(await headMoves(at, before, after), ['merge side']);
  });

  it('names a reset', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await fs.writeFile(path.join(dir, 'x.txt'), 'x\n');
    await git('add', '-A');
    await git('commit', '-m', 'two');
    const before = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('reset', '--hard', 'HEAD~1');
    const after = (await git('rev-parse', 'HEAD')).stdout.trim();
    assert.deepEqual(await headMoves(at, before, after), ['reset']);
  });

  it('answers an empty list where HEAD did not move at all', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir, env: CLEAN })).stdout.trim();
    assert.deepEqual(await headMoves(at, head, head), []);
  });

  /** Cannot-say, which the gate must read as "withhold" and never as "clean". */
  it('answers nothing when the reflog cannot account for the move', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir, env: CLEAN })).stdout.trim();
    assert.equal(await headMoves(at, 'f'.repeat(40), head), undefined);

    await fs.rm(path.join(at.gitDir, 'logs', 'HEAD'));
    assert.equal(await headMoves(at, head, 'e'.repeat(40)), undefined);
  });
});

describe('the index a capture stages into', () => {
  it('is per owner, so one poisoned index costs one session', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    await capture(at, 'session-a');
    await capture(at, 'session-b');
    const names = (await fs.readdir(at.gitDir)).filter((n) => n.endsWith('.index')).sort();
    assert.deepEqual(
      names,
      ['session-a', 'session-b']
        .map((owner) => `squadron-${createHash('sha256').update(owner).digest('hex')}.index`)
        .sort()
    );
  });

  /**
   * The failure nobody would ever find. A SIGKILL'd `git add` leaves the lock
   * behind, and without this every later capture for that owner fails with exit
   * 128 forever, across restarts, with no symptom anyone looks for. A SIGTERM'd
   * git cleans up after itself, so the subprocess timeout never causes this —
   * verified 2026-08-22.
   */
  it('clears a lock nobody is holding, rather than dying on it forever', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    await capture(at, 'owner');

    const lock = path.join(
      at.gitDir,
      `squadron-${createHash('sha256').update('owner').digest('hex')}.index.lock`
    );
    await fs.writeFile(lock, '');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(lock, old, old);

    await fs.writeFile(path.join(dir, 'after.txt'), 'x\n');
    const shot = await capture(at, 'owner');
    assert.ok(shot, 'a stale lock must not end checkpointing for this owner');
    assert.equal(await fs.stat(lock).catch(() => undefined), undefined, 'the lock is cleared');
  });

  /** A lock a live capture is holding is left alone — the age bound is what
   *  makes deleting one defensible at all. */
  it('leaves a fresh lock where it is, and answers nothing', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    await capture(at, 'owner');
    await fs.writeFile(
      path.join(
        at.gitDir,
        `squadron-${createHash('sha256').update('owner').digest('hex')}.index.lock`
      ),
      ''
    );

    assert.equal(await capture(at, 'owner'), undefined);
    assert.ok(
      await fs.stat(
        path.join(
          at.gitDir,
          `squadron-${createHash('sha256').update('owner').digest('hex')}.index.lock`
        )
      )
    );
  });

  it('sanitises an owner that is not a filename', async () => {
    const dir = await repo();
    const at = await treeOf(dir);
    assert.ok(await capture(at, '../../escape/../..'));
    const names = (await fs.readdir(at.gitDir)).filter((n) => n.endsWith('.index'));
    assert.deepEqual(names, [
      `squadron-${createHash('sha256').update('../../escape/../..').digest('hex')}.index`
    ]);
  });
});

/**
 * The two boundaries a session drives, and the three rules that live on them:
 * baseline unconditionally, consume the baseline, and pin the tree.
 */
describe('the turn lifecycle', () => {
  const write = (dir: string, name: string, body: string) =>
    fs.writeFile(path.join(dir, name), body);

  it('answers what a turn wrote, however it wrote it', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-1');
    await turn.open(dir);
    await write(dir, 'by-shell.txt', 'one\ntwo\n');

    const ck = await turn.close(dir);
    assert.ok(ck);
    assert.equal(ck.tree, dir);
    assert.deepEqual(ck.changes.files, [path.join(dir, 'by-shell.txt')]);
    assert.deepEqual(ck.changes.sizes[path.join(dir, 'by-shell.txt')], { add: 2, del: 0 });
    assert.deepEqual(ck.moves, [], 'HEAD did not move, which is not the same as cannot say');
  });

  /**
   * Rule 1, and the `t3code` bug it is written against: `ensurePreTurnBaseline`
   * opens `if (baselineExists) return`, so from turn 2 the baseline is frozen at
   * the previous turn's completion and every idle gap between turns is charged
   * to whoever speaks next.
   */
  it('re-baselines every turn, so an idle gap belongs to nobody', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-2');
    await turn.open(dir);
    await write(dir, 'turn-one.txt', 'a\n');
    await turn.close(dir);

    // Between turns: the reader edits a file in their own editor.
    await write(dir, 'while-idle.txt', 'not a turn\n');

    await turn.open(dir);
    await write(dir, 'turn-two.txt', 'b\n');
    const second = await turn.close(dir);
    assert.deepEqual(second?.changes.files, [path.join(dir, 'turn-two.txt')]);
  });

  /**
   * Not every idle edge follows a drain — `init` opens a turn, and so do
   * auto-compaction, a `/clear` and a resumed queue. Diffing those against the
   * last drain's baseline would hand them the gap before them.
   */
  it('consumes the baseline, so a second close answers nothing', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-3');
    await turn.open(dir);
    await write(dir, 'one.txt', 'a\n');
    assert.ok(await turn.close(dir));

    await write(dir, 'two.txt', 'b\n');
    assert.equal(await turn.close(dir), undefined);
  });

  it('answers nothing for a directory in no repository', async () => {
    const dir = await temp('squadron-bare-');
    const turn = new TurnCheckpoints('sess-4');
    await turn.open(dir);
    await write(dir, 'loose.txt', 'a\n');
    assert.equal(await turn.close(dir), undefined);
  });

  /**
   * The tree is pinned to the baseline because two linked worktrees of one
   * repository **share an object store** — so a session that stepped into one
   * mid-turn would get a diff that succeeded and named every file that differs
   * between two checkouts. An unrelated repository fails safe on the missing
   * object alone; this one does not.
   */
  it('drops the turn when the session left the tree it baselined in', async () => {
    const dir = await repo();
    const linked = path.join(dir, 'wt');
    await run('git', ['worktree', 'add', '-b', 'side', linked], { cwd: dir, env: CLEAN });

    const turn = new TurnCheckpoints('sess-5');
    await turn.open(dir);
    await write(dir, 'in-the-parent.txt', 'a\n');
    assert.equal(await turn.close(linked), undefined);
  });

  it('drops the index it warmed when the session ends', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-6');
    await turn.open(dir);
    const at = await treeOf(dir);
    const index = path.join(
      at.gitDir,
      `squadron-${createHash('sha256').update('sess-6').digest('hex')}.index`
    );
    assert.ok(await fs.stat(index));

    turn.end();
    // `end` rides the same chain the captures do, so one more turn of it is
    // enough to see the file gone.
    await turn.close(dir);
    assert.equal(await fs.stat(index).catch(() => undefined), undefined);
  });

  /**
   * `discard`, and the bug it was added for: a caller that takes a baseline and
   * then never releases a turn against it — the outbox emptied inside the
   * window, or a turn it did not start began there. Left set, that snapshot is
   * what the *next* idle edge diffs, and it reports a window its turn never
   * started in.
   */
  it('forgets a baseline no turn was ever released against', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-8');
    await turn.open(dir);
    await write(dir, 'nobody-asked.txt', 'a\n');

    turn.discard();
    assert.equal(await turn.close(dir), undefined, 'nothing to diff, and no gap charged');
  });

  /**
   * Why `discard` rides the chain rather than clearing the field where it
   * stands, which is the whole of its construction and had no case.
   *
   * `close` reads the baseline when its *work* runs, not when it is queued. A
   * synchronous clear landing between the two would take the snapshot out from
   * under a close already in flight — and that close belongs to a turn that was
   * released, so the turn would lose its pills for a bail that had nothing to
   * do with it.
   */
  it('does not steal the baseline from a close already on the chain', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-10');
    await turn.open(dir);
    await write(dir, 'the-turn-wrote.txt', 'a\n');

    // Queued, not awaited — then a discard behind it in the same tick.
    const closing = turn.close(dir);
    turn.discard();

    const ck = await closing;
    assert.ok(ck, 'the released turn keeps its diff');
    assert.deepEqual(ck.changes.files, [path.join(dir, 'the-turn-wrote.txt')]);
    // And the discard still leaves nothing behind for the next edge.
    assert.equal(await turn.close(dir), undefined);
  });

  it('keeps the index warm across a discard, unlike ending the session', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-9');
    await turn.open(dir);
    const at = await treeOf(dir);
    const index = path.join(
      at.gitDir,
      `squadron-${createHash('sha256').update('sess-9').digest('hex')}.index`
    );
    assert.ok(await fs.stat(index));

    turn.discard();
    await turn.close(dir);
    // Still there: a discard is one turn declining its baseline, not a session
    // ending, and dropping it would cost the next real turn a cold capture.
    assert.ok(await fs.stat(index), 'the warm index survives');

    // And the next turn baselines normally.
    await turn.open(dir);
    await write(dir, 'the-next-turn.txt', 'b\n');
    const ck = await turn.close(dir);
    assert.ok(ck);
    assert.deepEqual(ck.changes.files, [path.join(dir, 'the-next-turn.txt')]);
  });

  /**
   * `indexFile` states the contract this is the caller for: two `git add`s on
   * one index race for `index.lock` and the loser answers nothing at all. A
   * session opens a turn while its own spawn-time capture may still be running,
   * so the two are microseconds apart in production.
   */
  it('serialises overlapping captures rather than losing one to the lock', async () => {
    const dir = await repo();
    const turn = new TurnCheckpoints('sess-7');
    await Promise.all([turn.open(dir), turn.open(dir), turn.open(dir)]);
    await write(dir, 'after.txt', 'a\n');
    const ck = await turn.close(dir);
    assert.ok(ck, 'the last baseline survived the other two');
    assert.deepEqual(ck.changes.files, [path.join(dir, 'after.txt')]);
  });
});
