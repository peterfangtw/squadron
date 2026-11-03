import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, describe, it } from 'node:test';
import type { Session } from '../../core/model';
import { linkDir, outRoot, tempHome } from '../helpers';
type Authored = import('../../core/transcript').Authored;
let mod: typeof import('../../core/adapter');
let record: typeof import('../../core/record');
let checkpoint: typeof import('../../core/checkpoint');
before(async () => {
  await tempHome();
  mod = await import('../../core/adapter');
  record = await import('../../core/record');
  checkpoint = await import('../../core/checkpoint');
});

/**
 * The read side of `core/checkpoint.ts`: what a turn's own diff, gated against
 * its neighbours, adds to the pills the frames already drew.
 *
 * As in `readSessionTranscript picks a source` in `adapter.test.ts`, our record
 * has to win the source pick before attribution is reachable. This is the
 * degradation worth remembering: a conversation the CLI's file wins carries no
 * `ck` notes and draws no checkpoint pills.
 */
describe('a turn claims what the tree says it wrote', () => {
  it('keeps a pre-upgrade turn’s own bare-id window as self, and lets any other bare-id window compete', async () => {
    const sid = 'legacy-own-window';
    const native = await transcript(sid, ['msg_1']);
    const file = at('legacy-own.txt');
    await record.appendLine(sid, { role: 'user', text: 'write' });
    await record.appendLine(sid, { role: 'assistant', text: 'done', m: 'msg_1' });
    await record.appendLine(sid, { ck: ck([file], {}) });
    // What every build before brand-qualified owners wrote beside that note.
    await checkpoint.appendWindow(TREE, { sid, start: 1000, end: 2000, paths: [file] });
    const own = await mod.readSessionTranscript(session(sid, native));
    assert.equal(own.ours, true);
    assert.deepEqual(turnOf(own).files, [file]);
    assert.equal(turnOf(own).concurrent, undefined);
    // The same bare id over another interval proves no ownership, so it competes.
    await checkpoint.appendWindow(TREE, { sid, start: 1100, end: 1900, paths: [file] });
    const contested = await mod.readSessionTranscript(session(sid, native));
    assert.deepEqual(turnOf(contested).files ?? [], []);
    assert.equal(turnOf(contested).concurrent, true);
  });

  it('retains legacy alias subtraction when a recorded canonical checkpoint is replayed after restart', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-alias-replay-'))
    );
    const alias = `${root}-alias`;
    await fs.mkdir(path.join(root, '.git'));
    await linkDir(root, alias);
    try {
      await (await import('../../core/git')).readTree(alias);
      const file = path.join(root, 'peer.txt');
      const native = await transcript('ck-alias-replay', ['msg_1']);
      await record.appendLine('ck-alias-replay', { role: 'user', text: 'write' });
      await record.appendLine('ck-alias-replay', { role: 'assistant', text: 'done', m: 'msg_1' });
      await record.appendLine('ck-alias-replay', {
        ck: { ...ck([file], {}), tree: root, aliases: [alias] }
      });
      await checkpoint.appendWindow(alias, {
        sid: 'neighbor',
        start: 1100,
        end: 1900,
        paths: [path.join(alias, 'peer.txt')]
      });
      const input = { ...session('ck-alias-replay', native), cwd: root };
      const before = await mod.readSessionTranscript(input);
      assert.equal(before.ours, true);
      assert.deepEqual(turnOf(before).files ?? [], []);
      const nativeFile = path.join(alias, 'deleted.txt');
      const preciseId = 'ck-precise-alias-replay';
      const preciseTranscript = await transcript(preciseId, ['msg_1']);
      const nativeSizes = { [nativeFile]: { add: 2, del: 3 } };
      await record.appendLine(preciseId, { role: 'user', text: 'write' });
      await record.appendLine(preciseId, {
        role: 'assistant',
        text: 'done',
        m: 'msg_1',
        files: [nativeFile],
        sizes: nativeSizes
      });
      await record.appendLine(preciseId, {
        ex: {
          version: 1,
          kind: 'coverage',
          tree: root,
          owner: mod.conversationKey('claude', preciseId),
          runtime: 'alias-runtime',
          turn: 'precise',
          start: 1000,
          end: 2000,
          source: 'execution',
          calls: [],
          windows: [{ ...ck([path.join(root, 'deleted.txt')], {}), tree: root, aliases: [alias] }]
        }
      });
      const precise = { ...session(preciseId, preciseTranscript), cwd: root };
      assert.deepEqual(turnOf(await mod.readSessionTranscript(precise)).files, [nativeFile]);
      const script = `
        const adapter = require(process.argv[2]);
        Promise.all(JSON.parse(process.argv[1]).map(input => adapter.readSessionTranscript(input))).then((reads) => {
          console.log(JSON.stringify(reads.map(read => ({
            ours: read.ours, files: read.recent.exchanges[1]?.files ?? [],
            sizes: read.recent.exchanges[1]?.sizes ?? {}
          }))));
        }).catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      const result = await promisify(execFile)(process.execPath, [
        '-e',
        script,
        JSON.stringify([input, precise]),
        path.resolve(outRoot(), 'core/adapter.js')
      ]);
      assert.deepEqual(JSON.parse(result.stdout) as unknown, [
        { ours: true, files: [], sizes: {} },
        { ours: true, files: [nativeFile], sizes: nativeSizes }
      ]);
    } finally {
      await fs.rm(alias);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps native alias paths while preferring canonical execution-floor Git counts', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-native-alias-'))
    );
    await fs.mkdir(path.join(root, '.git'));
    const alias = `${root}-alias`;
    await linkDir(root, alias);
    try {
      const git = await import('../../core/git');
      await git.readTree(alias);
      const native = path.join(alias, 'deleted.txt');
      const inferred = path.join(root, 'deleted.txt');
      const file = await transcript('ck-alias', ['msg_1']);
      await record.appendLine('ck-alias', { role: 'user', text: 'write' });
      await record.appendLine('ck-alias', {
        role: 'assistant',
        text: 'done',
        m: 'msg_1',
        files: [native],
        sizes: { [native]: { add: 2, del: 3 } }
      });
      await record.appendLine('ck-alias', {
        ck: { ...ck([inferred], { [inferred]: { add: 9, del: 7 } }), tree: root }
      });
      const floor = {
        ...ck([inferred], { [inferred]: { add: 9, del: 7 } }),
        tree: root,
        aliases: [alias],
        from: { tree: 'a'.repeat(40), head: 'a'.repeat(40), at: 1000 },
        to: { tree: 'b'.repeat(40), head: 'a'.repeat(40), at: 2000 }
      };
      await record.appendLine('ck-alias', {
        ex: {
          version: 1,
          kind: 'coverage',
          owner: 'claude\0ck-alias',
          runtime: 'alias-runtime',
          turn: 'first',
          tree: root,
          start: 1000,
          end: 2000,
          source: 'execution',
          calls: [],
          floor,
          windows: [
            { ...floor, changes: { files: [native], sizes: { [native]: { add: 2, del: 3 } } } }
          ]
        }
      });
      const drawn = await mod.readSessionTranscript({ ...session('ck-alias', file), cwd: alias });
      assert.deepEqual(turnOf(drawn).files, [native]);
      assert.deepEqual(turnOf(drawn).sizes, { [native]: { add: 9, del: 7 } });
    } finally {
      await fs.rm(alias);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const TREE = '/repo/claimed';
  const at = (name: string) => `${TREE}/${name}`;

  async function transcript(name: string, ids: string[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-ck-'));
    const file = path.join(dir, `${name}.jsonl`);
    await fs.writeFile(
      file,
      ids
        .map((id, n) =>
          JSON.stringify({
            type: 'assistant',
            uuid: `u-${id}`,
            timestamp: new Date(1_700_000_000_000 + n).toISOString(),
            message: { role: 'assistant', id, model: 'claude-opus-5', content: [] }
          })
        )
        .join('\n') + '\n'
    );
    return file;
  }

  const session = (sessionId: string, file: string): Session =>
    ({ pid: 1, sessionId, cwd: TREE, transcript: file, brand: 'claude' }) as Session;

  const ck = (files: string[], sizes: Record<string, { add: number; del: number }>) => ({
    tree: TREE,
    from: { tree: 'aaa', head: 'h0', at: 1000 },
    to: { tree: 'bbb', head: 'h0', at: 2000 },
    changes: { files, sizes }
  });

  /** The turn the pills land on: the last thing written before the note. */
  const turnOf = (drawn: { recent: { exchanges: readonly unknown[] } }): Authored =>
    drawn.recent.exchanges[1] as Authored;

  it('keeps each whole-turn baseline through native-only and silent attribution, on both read paths', async () => {
    const sid = 'ck-turn-baselines';
    const file = await transcript(sid, ['base_1', 'base_2', 'base_3', 'base_4']);
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    const native = at('native.ts');
    const nativeSize = { add: 3, del: 1 };
    await record.appendLine(sid, { role: 'user', text: 'first' });
    await record.appendLine(sid, {
      role: 'assistant',
      text: 'editing',
      m: 'base_1',
      files: [native],
      sizes: { [native]: nativeSize }
    });
    await record.appendLine(sid, { mark: 'break' });
    await record.appendLine(sid, { role: 'assistant', text: 'done', m: 'base_2' });
    await record.appendLine(sid, {
      ck: {
        ...ck([native], { [native]: { add: 9, del: 9 } }),
        from: { tree: first, head: 'h0', at: 1000 }
      }
    });
    await record.appendLine(sid, { role: 'user', text: 'second' });
    await record.appendLine(sid, {
      role: 'assistant',
      text: 'rewritten',
      m: 'base_3',
      files: [native],
      sizes: { [native]: nativeSize }
    });
    await record.appendLine(sid, {
      ck: {
        ...ck([at('inferred.ts')], { [at('inferred.ts')]: { add: 1, del: 0 } }),
        from: { tree: second, head: 'h0', at: 3000 },
        to: { tree: 'c'.repeat(40), head: 'unexplained-head', at: 4000 }
      }
    });
    await record.appendLine(sid, { role: 'user', text: 'without checkpoint' });
    await record.appendLine(sid, { role: 'assistant', text: 'legacy', m: 'base_4' });
    const history = await record.readRecord(sid);
    assert.ok(history);
    const before = structuredClone(history.exchanges);
    const readings = [
      await mod.readSessionTranscript(session(sid, file)),
      await mod.ownedTranscript('claude', {
        conversation: sid,
        generation: 0,
        history,
        recent: { exchanges: history.exchanges, truncated: false },
        tail: []
      })
    ];
    for (const drawn of readings) {
      assert.equal(drawn.ours, true);
      assert.deepEqual(
        drawn.recent.exchanges.map((x) => ('mark' in x ? x : x.base)),
        [first, first, { mark: 'break' }, first, second, second, undefined, undefined]
      );
      for (const index of [1, 5]) {
        const exchange = drawn.recent.exchanges[index];
        assert.ok(exchange && !('mark' in exchange));
        assert.deepEqual(exchange.files, [native]);
        assert.deepEqual(exchange.sizes, {
          [native]: index === 1 ? { add: 9, del: 9 } : nativeSize
        });
      }
    }
    assert.deepEqual(history.exchanges, before, 'projection does not mutate captured history');
  });

  for (const scenario of [
    {
      name: 'execution floor without a separate checkpoint',
      checkpoint: false,
      floor: true,
      expected: 'b'
    },
    {
      name: 'earlier checkpoint followed by floorless execution',
      checkpoint: true,
      floor: false,
      expected: 'a'
    },
    {
      name: 'earlier checkpoint ahead of a different execution floor',
      checkpoint: true,
      floor: true,
      expected: 'a'
    },
    {
      name: 'execution windows without a whole-turn baseline',
      checkpoint: false,
      floor: false,
      expected: undefined
    }
  ]) {
    it(`resolves the turn baseline for ${scenario.name}`, async () => {
      const sid = `ck-ex-base-${Number(scenario.checkpoint)}-${Number(scenario.floor)}`;
      const file = await transcript(sid, ['ex_base_1', 'ex_base_2']);
      const tree = path.resolve(TREE);
      const native = path.join(tree, 'native.ts');
      const shell = path.join(tree, 'shell.ts');
      const whole = {
        ...ck([], {}),
        tree,
        from: { tree: 'a'.repeat(40), head: 'd'.repeat(40), at: 1000 },
        to: { tree: 'e'.repeat(40), head: 'd'.repeat(40), at: 2000 }
      };
      await record.appendLine(sid, { role: 'user', text: 'write' });
      await record.appendLine(sid, {
        role: 'assistant',
        text: 'native',
        m: 'ex_base_1',
        files: [native],
        sizes: { [native]: { add: 2, del: 0 } }
      });
      if (scenario.checkpoint) await record.appendLine(sid, { ck: whole });
      await record.appendLine(sid, { role: 'assistant', text: 'shell', m: 'ex_base_2' });
      await record.appendLine(sid, {
        ex: {
          version: 1,
          kind: 'coverage',
          owner: `claude\0${sid}`,
          runtime: 'runtime',
          turn: 'first',
          tree,
          start: 1000,
          end: 2000,
          source: 'execution',
          calls: [],
          ...(scenario.floor
            ? { floor: { ...whole, from: { ...whole.from, tree: 'b'.repeat(40) } } }
            : {}),
          windows: [
            {
              ...whole,
              from: { ...whole.from, tree: 'c'.repeat(40), at: 1200 },
              to: { ...whole.to, at: 1800 },
              changes: { files: [shell], sizes: { [shell]: { add: 1, del: 0 } } }
            }
          ]
        }
      });
      const history = await record.readRecord(sid);
      assert.ok(history);
      assert.equal(history.execution?.size, 1, 'execution evidence was accepted');
      assert.equal(history.checkpoints.size, Number(scenario.checkpoint));
      const drawn = await mod.readSessionTranscript(session(sid, file));
      assert.equal(drawn.ours, true);
      assert.deepEqual(
        drawn.recent.exchanges.map((x) => ('mark' in x ? undefined : x.base)),
        Array<string | undefined>(3).fill(scenario.expected?.repeat(40))
      );
      const last = drawn.recent.exchanges[2];
      assert.ok(last && !('mark' in last));
      assert.deepEqual(last.files, [shell], 'precise execution attribution still supplies pills');
    });
  }

  it('draws a write no frame carried, which is the whole point', async () => {
    const file = await transcript('ck-shell', ['msg_1']);
    await record.appendLine('ck-shell', { role: 'user', text: 'write it with sed' });
    await record.appendLine('ck-shell', { role: 'assistant', text: 'done', m: 'msg_1' });
    await record.appendLine('ck-shell', {
      ck: ck([at('by-shell.txt')], { [at('by-shell.txt')]: { add: 4, del: 1 } })
    });

    const drawn = await mod.readSessionTranscript(session('ck-shell', file));
    assert.equal(drawn.ours, true);
    assert.deepEqual(turnOf(drawn).files, [at('by-shell.txt')]);
    assert.deepEqual(turnOf(drawn).sizes, { [at('by-shell.txt')]: { add: 4, del: 1 } });
    assert.equal(turnOf(drawn).concurrent, undefined, 'nobody else was in the tree');
  });

  it('uses precise execution paths with whole-turn Git counts even when execution captures overlap', async (t) => {
    const sid = 'execution-merge';
    const file = await transcript(sid, ['msg_1']);
    await record.appendLine(sid, { role: 'user', text: 'write' });
    await record.appendLine(sid, {
      role: 'assistant',
      text: 'done',
      m: 'msg_1',
      files: [at('native')],
      sizes: { [at('native')]: { add: 3, del: 1 } }
    });
    const floor = {
      ...ck([at('gap'), at('native'), at('shell')], {
        [at('gap')]: { add: 9, del: 0 },
        [at('native')]: { add: 2, del: 1 },
        [at('shell')]: { add: 1, del: 0 }
      }),
      from: { tree: 'a'.repeat(40), head: 'a'.repeat(40), at: 1000 },
      to: { tree: 'b'.repeat(40), head: 'a'.repeat(40), at: 2000 }
    };
    await record.appendLine(sid, { ck: floor });
    await record.appendLine(sid, {
      ex: {
        version: 1,
        kind: 'coverage',
        owner: `claude\0${sid}`,
        runtime: 'runtime',
        turn: 'first',
        tree: TREE,
        start: 1000,
        end: 2000,
        source: 'execution',
        calls: [],
        floor,
        windows: [
          {
            ...floor,
            changes: {
              files: [at('native'), at('shell')],
              sizes: { [at('native')]: { add: 20, del: 10 }, [at('shell')]: { add: 1, del: 0 } }
            }
          },
          {
            ...floor,
            changes: {
              files: [at('native')],
              sizes: { [at('native')]: { add: 20, del: 10 } }
            }
          }
        ]
      }
    });
    const drawn = await mod.readSessionTranscript(session(sid, file));
    assert.deepEqual(turnOf(drawn).files, [at('native'), at('shell')]);
    assert.deepEqual(turnOf(drawn).sizes, {
      [at('native')]: { add: 2, del: 1 },
      [at('shell')]: { add: 1, del: 0 }
    });
    const harness = await import('../harness');
    const panel = harness.openThread(
      t,
      harness.threadView({
        exchanges: drawn.recent.exchanges.map((exchange) =>
          'mark' in exchange
            ? exchange
            : {
                role: exchange.role,
                text: exchange.text,
                files: exchange.files,
                sizes: exchange.sizes,
                blocks:
                  exchange.role === 'user' ? [{ prose: exchange.text }] : [{ html: exchange.text }]
              }
        )
      })
    );
    assert.deepEqual(
      [...panel.window.document.querySelectorAll('#thread .wpill')].map((pill) => pill.textContent),
      ['native+2−1', 'shell+1−0']
    );
  });

  it('replaces a native count with the Git total without adding a second pill', async () => {
    const file = await transcript('ck-both', ['msg_1']);
    await record.appendLine('ck-both', { role: 'user', text: 'write then patch' });
    await record.appendLine('ck-both', {
      role: 'assistant',
      text: 'done',
      m: 'msg_1',
      files: [at('a.ts')],
      sizes: { [at('a.ts')]: { add: 10, del: 0 } }
    });
    await record.appendLine('ck-both', {
      ck: ck([at('a.ts'), at('b.ts')], {
        [at('a.ts')]: { add: 12, del: 3 },
        [at('b.ts')]: { add: 1, del: 0 }
      })
    });

    const drawn = await mod.readSessionTranscript(session('ck-both', file));
    assert.deepEqual(turnOf(drawn).files, [at('a.ts'), at('b.ts')], 'one pill each, in order');
    assert.deepEqual(turnOf(drawn).sizes, {
      [at('a.ts')]: { add: 12, del: 3 },
      [at('b.ts')]: { add: 1, del: 0 }
    });
  });

  for (const scenario of [
    'no-floor',
    'binary',
    'reverted',
    'rewritten',
    'unavailable',
    'uncertain',
    'contested'
  ] as const) {
    it(`keeps Git counts and native fallback distinct for ${scenario} execution coverage`, async () => {
      const sid = `ck-count-source-${scenario}`;
      const tree = `${TREE}/${sid}`;
      const file = `${tree}/source.txt`;
      const native = await transcript(sid, ['edit_1', 'edit_2']);
      await record.appendLine(sid, { role: 'user', text: 'edit and restore' });
      const inputs = [
        { add: 5, del: 4 },
        { add: 4, del: 5 }
      ] as const;
      const betweenTools = scenario === 'uncertain' || scenario === 'contested';
      for (const [i, size] of inputs.entries()) {
        await record.appendLine(sid, {
          role: 'assistant',
          text: '',
          m: `edit_${i + 1}`,
          files: [file],
          sizes: { [file]: size }
        });
      }
      const first = {
        tree,
        from: { tree: 'a'.repeat(40), head: 'a'.repeat(40), at: 1000 },
        to: { tree: 'b'.repeat(40), head: 'a'.repeat(40), at: betweenTools ? 1400 : 1600 },
        changes: { files: [file], sizes: { [file]: inputs[0] } }
      };
      const second = {
        ...first,
        from: { ...first.to, at: 1500 },
        to: { ...first.from, at: 2000 },
        changes: { files: [file], sizes: { [file]: inputs[1] } }
      };
      const floor = {
        ...first,
        to: second.to,
        ...(scenario === 'rewritten' ? { from: { ...first.from, op: 'merge' } } : {}),
        changes: { files: scenario === 'binary' ? [file] : [], sizes: {} }
      };
      await record.appendLine(sid, {
        ex: {
          version: 1,
          kind: 'coverage',
          owner: `claude\0${sid}`,
          runtime: 'count-runtime',
          turn: 'first',
          tree,
          start: 1000,
          end: 2000,
          source: 'execution',
          calls: [],
          windows: scenario === 'binary' ? [first] : [first, second],
          ...(scenario === 'no-floor' ? {} : { floor })
        }
      });
      if (scenario === 'unavailable') {
        await fs.mkdir(checkpoint.windowsFile(tree), { recursive: true });
      } else if (scenario === 'uncertain') {
        await checkpoint.appendExecution(tree, {
          version: 1,
          kind: 'execution',
          tree,
          owner: 'neighbor',
          runtime: 'other-runtime',
          actor: 'neighbor',
          call: 'pending',
          edge: 'before',
          start: 1410,
          end: 1420
        });
        await checkpoint.appendExecution(tree, {
          version: 1,
          kind: 'runtime-end',
          tree,
          runtime: 'other-runtime',
          at: 1490
        });
      } else if (scenario === 'contested') {
        await checkpoint.appendWindow(tree, {
          sid: 'neighbor',
          start: 1410,
          end: 1490,
          paths: [file]
        });
      }
      const drawn = await mod.readSessionTranscript({ ...session(sid, native), cwd: tree });
      const sizes = drawn.recent.exchanges.flatMap((x) =>
        'mark' in x ? [] : Object.values(x.sizes ?? {})
      );
      assert.deepEqual(
        sizes,
        scenario === 'binary'
          ? []
          : scenario === 'reverted'
            ? [{ add: 0, del: 0 }]
            : betweenTools
              ? [{ add: 9, del: 9 }]
              : inputs
      );
    });
  }

  for (const prose of [false, true]) {
    it(`shows one Git total for repeated edits ${prose ? 'separated by prose' : 'in one fold'}, without changing the raw record`, async (t) => {
      const sid = `ck-repeated-edit-counts-${prose}`;
      const file = at('sample.txt');
      const native = await transcript(sid, [
        'edit_1',
        ...(prose ? ['commentary'] : []),
        'edit_2',
        'answer'
      ]);
      await record.appendLine(sid, { role: 'user', text: 'edit twice' });
      for (const m of ['edit_1', 'edit_2']) {
        if (prose && m === 'edit_2')
          await record.appendLine(sid, {
            role: 'assistant',
            text: 'Now edit again',
            m: 'commentary'
          });
        await record.appendLine(sid, {
          role: 'assistant',
          text: '',
          m,
          files: [file],
          sizes: { [file]: { add: 5, del: 4 } }
        });
      }
      await record.appendLine(sid, { role: 'assistant', text: 'done', m: 'answer' });
      await record.appendLine(sid, { ck: ck([file], { [file]: { add: 2, del: 1 } }) });
      const drawn = await mod.readSessionTranscript(session(sid, native));
      const exchanges: ExchangeView[] = drawn.recent.exchanges.map((exchange) =>
        'mark' in exchange
          ? exchange
          : {
              role: exchange.role,
              text: exchange.text,
              files: exchange.files,
              sizes: exchange.sizes,
              base: exchange.base,
              blocks:
                exchange.role === 'user'
                  ? [{ prose: exchange.text }]
                  : exchange.text
                    ? [{ html: exchange.text }]
                    : [{ summary: 'Changed file' }]
            }
      );
      const fold = await import('../../ui/fold');
      const harness = await import('../harness');
      const panel = harness.openThread(
        t,
        harness.threadView({
          exchanges,
          folds: fold.folds(exchanges, false)
        })
      );
      assert.deepEqual(
        [...panel.window.document.querySelectorAll('#thread .wpill')].map(
          (pill) => pill.textContent
        ),
        ['sample.txt+2−1']
      );
      panel.window.document
        .querySelectorAll<HTMLElement>('#thread .foldbtn')
        .forEach((button) => button.click());
      assert.deepEqual(
        [...panel.window.document.querySelectorAll('#thread .turn .wpill')].map(
          (pill) => pill.textContent
        ),
        ['sample.txt+2−1']
      );
      const history = await record.readRecord(sid);
      assert.deepEqual(
        history?.exchanges
          .filter((exchange) => !('mark' in exchange) && exchange.files?.includes(file))
          .map((exchange) => ('mark' in exchange ? undefined : exchange.sizes)),
        [{ [file]: { add: 5, del: 4 } }, { [file]: { add: 5, del: 4 } }]
      );
    });
  }

  for (const brand of ['claude', 'grok'] as const) {
    it(`keeps a ${brand} streamed write through a record read when checkpoint paths are contested`, async () => {
      const name = `ck-stream-${brand}`;
      const tree = path.resolve(`/repo/${name}`);
      const written = path.join(tree, 'notes.md');
      const file = await transcript(name, ['msg_1']);
      const input = { file_path: 'notes.md', old_string: 'old\n', new_string: 'new\nextra\n' };
      if (brand === 'claude') {
        const tee = await import('../../core/claude/tee');
        await record.appendLine(name, { role: 'user', text: 'edit it' });
        for (const line of tee.lineForFrame(
          {
            type: 'assistant',
            message: {
              id: 'msg_1',
              content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input }]
            }
          },
          1000,
          tree
        )) {
          await record.appendLine(name, line);
        }
      } else {
        await fs.writeFile(
          file,
          [
            { type: 'user', content: 'edit it', prompt_index: 0 },
            { type: 'assistant', content: 'done' }
          ]
            .map((row) => JSON.stringify(row))
            .join('\n') + '\n'
        );
        const { GrokTee, linesOf } = await import('../../core/grok/tee');
        const tee = new GrokTee(tree, name);
        const lines = [
          ...linesOf(
            tee.teed(
              'session/update',
              {
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: { type: 'text', text: 'edit it' },
                  _meta: { promptIndex: 0 }
                }
              },
              1000
            )
          ),
          ...linesOf(
            tee.teed(
              'session/update',
              {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'done' }
                }
              },
              1000
            )
          ),
          ...linesOf(
            tee.teed(
              'session/update',
              {
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'call-aaa-0',
                  title: 'search_replace',
                  rawInput: input
                }
              },
              1000
            )
          ),
          ...linesOf(tee.closeTurn({ stop: 'end_turn' }, 1000))
        ];
        for (const line of lines) await record.appendLine(name, line);
      }
      await checkpoint.appendWindow(tree, {
        sid: 'somebody-else',
        start: 1500,
        end: 1800,
        paths: [written]
      });
      await record.appendLine(name, {
        ck: {
          tree,
          from: { tree: 'aaa', head: 'h0', at: 1000 },
          to: { tree: 'bbb', head: 'h0', at: 2000 },
          changes: { files: [written], sizes: { [written]: { add: 9, del: 9 } } }
        }
      });
      const drawn = await mod.readSessionTranscript({ ...session(name, file), brand, cwd: tree });
      assert.equal(drawn.ours, true);
      assert.deepEqual(turnOf(drawn).files, [written]);
      assert.deepEqual(turnOf(drawn).sizes, { [written]: { add: 2, del: 1 } });
    });
  }

  /**
   * Rule 2 as the numbers settled it: the contested path is omitted, the rest
   * still draw, and the marker is about the window rather than about any file
   * left in the list.
   */
  it('leaves out what a neighbour touched, and says the list is short', async () => {
    const file = await transcript('ck-shared', ['msg_1']);
    await checkpoint.appendWindow(TREE, {
      sid: 'somebody-else',
      start: 1500,
      end: 1800,
      paths: [at('shared.ts')]
    });
    await record.appendLine('ck-shared', { role: 'user', text: 'do it' });
    await record.appendLine('ck-shared', { role: 'assistant', text: 'done', m: 'msg_1' });
    await record.appendLine('ck-shared', {
      ck: ck([at('mine.ts'), at('shared.ts')], {
        [at('mine.ts')]: { add: 2, del: 0 },
        [at('shared.ts')]: { add: 9, del: 9 }
      })
    });

    const drawn = await mod.readSessionTranscript(session('ck-shared', file));
    assert.deepEqual(turnOf(drawn).files, [at('mine.ts')]);
    assert.equal(turnOf(drawn).concurrent, true);
    assert.deepEqual(Object.keys(turnOf(drawn).sizes ?? {}), [at('mine.ts')], 'sizes ⊆ files');
  });

  /**
   * The memo, and the third input `drawableFor` cannot see. Its cache keys on
   * the object identity of the record and the CLI's file, which is what lets
   * `renderTranscript` skip a ~148 KB view rebuild — so a neighbour's window
   * file has to be in this key or the corrected attribution never repaints.
   */
  it('hands the same thread back until a neighbour moves, and a new one after', async () => {
    const file = await transcript('ck-memo', ['msg_1']);
    const tree = '/repo/memo';
    await record.appendLine('ck-memo', { role: 'user', text: 'do it' });
    await record.appendLine('ck-memo', { role: 'assistant', text: 'done', m: 'msg_1' });
    await record.appendLine('ck-memo', {
      ck: {
        tree,
        from: { tree: 'aaa', head: 'h0', at: 1000 },
        to: { tree: 'bbb', head: 'h0', at: 2000 },
        changes: {
          files: [`${tree}/one.ts`],
          sizes: { [`${tree}/one.ts`]: { add: 1, del: 0 } }
        }
      }
    });

    const history = await record.readRecord('ck-memo');
    assert.ok(history);
    const shot = {
      conversation: 'ck-memo',
      generation: 0,
      history,
      recent: { exchanges: history.exchanges, truncated: false },
      tail: []
    };
    const owned = await mod.ownedTranscript('claude', shot);
    assert.deepEqual(turnOf(owned).files, [`${tree}/one.ts`]);
    assert.equal((await mod.ownedTranscript('claude', shot)).recent, owned.recent);

    const first = await mod.readSessionTranscript(session('ck-memo', file));
    const again = await mod.readSessionTranscript(session('ck-memo', file));
    assert.equal(again.recent, first.recent, 'nothing moved, so nothing repaints');

    await checkpoint.appendWindow(tree, {
      sid: 'somebody-else',
      start: 1500,
      end: 1800,
      paths: [`${tree}/one.ts`]
    });
    const after = await mod.readSessionTranscript(session('ck-memo', file));
    assert.notEqual(after.recent, first.recent, 'a neighbour landing is a repaint');
    assert.deepEqual((after.recent.exchanges[1] as Authored).files, undefined);
    assert.equal((after.recent.exchanges[1] as Authored).concurrent, true);
    assert.equal((await mod.readSessionTranscript(session('ck-memo', file))).recent, after.recent);
    const ownedAfter = await mod.ownedTranscript('claude', shot);
    assert.notEqual(ownedAfter.recent, owned.recent);
    assert.deepEqual(turnOf(ownedAfter).files, undefined);
    assert.equal(turnOf(ownedAfter).concurrent, true);
    assert.equal((await mod.ownedTranscript('claude', shot)).recent, ownedAfter.recent);
  });
});
