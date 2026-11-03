import * as assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as path from 'node:path';
import {
  assistant,
  calls,
  setup,
  text,
  tool,
  turnsIn,
  user,
  write
} from './claude_transcript_helpers';
before(setup);

/** An absolute path under `/proj` as `noteWrite` resolves one: on win32 that
 *  is `C:\proj\…`, so a POSIX literal would never match. */
const proj = (...parts: string[]): string => path.resolve('/proj', ...parts);

/** A tool call that names a file — the shape `Write`, `Edit` and `Read` share. */
const writes = (
  name: string,
  file: string
): { type: string; name: string; input: { file_path: string } }[] => [
  { type: 'tool_use', name, input: { file_path: file } }
];

describe('readRecent', () => {
  it('names the files a turn wrote, and no file it only read', async () => {
    // Observed over every transcript on this machine, 2026-07-29: `file_path`
    // rides `Write`, `Edit` and `Read` and nothing else. Only the writes are a
    // result; a read is the agent browsing, and every turn does it.
    const file = await write('wrote', [
      user('write the doc'),
      assistant([
        ...text('written'),
        ...writes('Read', proj('notes.md')),
        ...writes('Write', proj('docs/PRD.md')),
        ...writes('Edit', proj('src/app.ts'))
      ])
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(turns[1]?.files, [proj('docs/PRD.md'), proj('src/app.ts')]);
  });

  it('resolves a relative file_path against the entry it was written on', async () => {
    // 172 of the ~17 000 paths on this machine are relative, and every one of
    // them has a `cwd` on its entry. A raw path is not openable, so the resolve
    // happens here rather than in the half that cannot see the cwd.
    const file = await write('relative', [
      user('fix it'),
      { ...assistant(writes('Edit', 'src/app.ts')), cwd: proj('worktree') }
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(turns[1]?.files, [proj('worktree/src/app.ts')]);
  });

  it('names a file once however many times the turn wrote it', async () => {
    const file = await write('repeat', [
      user('edit twice'),
      assistant([
        ...writes('Edit', proj('app.ts')),
        ...writes('Edit', proj('app.ts')),
        ...writes('Write', proj('new.ts'))
      ])
    ]);
    assert.deepEqual((await turnsIn(file))[1]?.files, [proj('app.ts'), proj('new.ts')]);
  });

  it('merges the files of tool-only turns the way it merges their tools', async () => {
    // The shape a writing stretch actually has: one entry per call, none of them
    // carrying words. Merged away without this, the files would go with them —
    // and 77.6% of writing turns are exactly this shape.
    const file = await write('merged-files', [
      user('do it'),
      assistant(writes('Write', proj('a.md'))),
      assistant(writes('Edit', proj('b.ts'))),
      assistant(text('both done'))
    ]);
    const turns = await turnsIn(file);
    assert.deepEqual(turns[1]?.files, [proj('a.md'), proj('b.ts')]);
    assert.deepEqual(calls(turns[1]), ['Write', 'Edit']);
  });

  it('leaves a turn that wrote nothing without the field at all', async () => {
    const file = await write('read-only', [
      user('look around'),
      assistant([...text('had a look'), ...writes('Read', '/proj/app.ts'), ...tool('Grep')])
    ]);
    assert.equal((await turnsIn(file))[1]?.files, undefined);
  });

  describe('how much each of them wrote', () => {
    /** An `Edit` as the CLI writes one: both sides of the hunk, whole. */
    const edit = (file: string, old: string, neu: string) => [
      {
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: file, old_string: old, new_string: neu }
      }
    ];
    const lines = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => `line ${i + from}`).join('\n');

    it('counts the change, not the anchor the agent quoted around it', async () => {
      // An `Edit`'s `old_string` is whatever matched uniquely, not a hunk. One
      // line changed inside a 400-line quote is 400 lines on both sides, and an
      // untrimmed delta prints +400 −400 where `git diff` prints +1 −1 — the
      // pill would state how much context the agent needed, in the same two
      // numbers, with nothing saying which question it answered.
      const before = `${lines(200)}\nTARGET\n${lines(200, 500)}`;
      const after = `${lines(200)}\nCHANGED\n${lines(200, 500)}`;
      const file = await write('anchor', [
        user('rename it'),
        assistant(edit(proj('app.ts'), before, after))
      ]);
      assert.deepEqual((await turnsIn(file))[1]?.sizes, {
        [proj('app.ts')]: { add: 1, del: 1 }
      });
    });

    it('counts a Write as all of it added and nothing deleted', async () => {
      const file = await write('whole', [
        user('make it'),
        assistant([
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: proj('new.ts'), content: lines(12) }
          }
        ])
      ]);
      assert.deepEqual((await turnsIn(file))[1]?.sizes, {
        [proj('new.ts')]: { add: 12, del: 0 }
      });
    });

    it('does not count the phantom last line a trailing newline makes', async () => {
      // `split('\n')` on "a\nb\n" is three, and the third is empty. Most `Write`
      // content ends in a newline, so the naive count is off by one everywhere.
      const file = await write('trailing', [
        user('make it'),
        assistant([
          { type: 'tool_use', name: 'Write', input: { file_path: proj('n.ts'), content: 'a\nb\n' } }
        ])
      ]);
      assert.deepEqual((await turnsIn(file))[1]?.sizes, { [proj('n.ts')]: { add: 2, del: 0 } });
    });

    it('counts the same hunk however each side ends', async () => {
      // The phantom last line again, on the other side of the seam: `hunk` split
      // both sides raw, so two trailing newlines cancelled in its tail trim and
      // one was counted as a whole added or deleted line. `b` -> `b\nc\n` read
      // `+2 −0`. `git diff` says `+2 −1` there — it counts the newline arriving
      // at the end of `b` as a change to that line, which this does not — and
      // both agree on the net, which is what the pill states.
      const file = await write('newlines', [
        user('four ways'),
        assistant([
          ...edit(proj('neither.ts'), 'a\nb', 'a\nc'),
          ...edit(proj('both.ts'), 'a\nb\n', 'a\nc\n'),
          ...edit(proj('old-only.ts'), 'b\n', 'b\nc'),
          ...edit(proj('new-only.ts'), 'b', 'b\nc\n')
        ])
      ]);
      assert.deepEqual((await turnsIn(file))[1]?.sizes, {
        [proj('neither.ts')]: { add: 1, del: 1 },
        [proj('both.ts')]: { add: 1, del: 1 },
        [proj('old-only.ts')]: { add: 1, del: 0 },
        [proj('new-only.ts')]: { add: 1, del: 0 }
      });
    });

    it('sums a MultiEdit hunk by hunk', async () => {
      const file = await write('multi', [
        user('fix both'),
        assistant([
          {
            type: 'tool_use',
            name: 'MultiEdit',
            input: {
              file_path: proj('app.ts'),
              edits: [
                { old_string: 'a', new_string: 'a\nb' },
                { old_string: 'x\ny', new_string: 'x' }
              ]
            }
          }
        ])
      ]);
      assert.deepEqual((await turnsIn(file))[1]?.sizes, {
        [proj('app.ts')]: { add: 1, del: 1 }
      });
    });

    it('sums a file the turn wrote twice, where files names it once', async () => {
      const file = await write('twice', [
        user('edit twice'),
        assistant([...edit(proj('app.ts'), 'a', 'a\nb'), ...edit(proj('app.ts'), 'p\nq', 'p')])
      ]);
      const turn = (await turnsIn(file))[1];
      assert.deepEqual(turn?.files, [proj('app.ts')]);
      assert.deepEqual(turn?.sizes, { [proj('app.ts')]: { add: 1, del: 1 } });
    });

    it('keys a relative path under the absolute one files resolved', async () => {
      const file = await write('rel-size', [
        user('fix it'),
        { ...assistant(edit('src/app.ts', 'a', 'a\nb')), cwd: proj('worktree') }
      ]);
      const turn = (await turnsIn(file))[1];
      assert.deepEqual(turn?.files, [proj('worktree/src/app.ts')]);
      assert.deepEqual(turn?.sizes, { [proj('worktree/src/app.ts')]: { add: 1, del: 0 } });
    });

    it('says nothing about a write it cannot see, and draws no pill for it', async () => {
      // A `Bash` heredoc is not in `WRITES`, so the path never enters `files` —
      // there is no pill, and therefore nothing to mark unknown. The limit is
      // real and is stated in the task file, not on a row that does not exist.
      const file = await write('bash-write', [
        user('write it'),
        assistant([
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: "cat > /proj/x.ts <<'EOF'\nhi\nEOF" }
          }
        ])
      ]);
      const turn = (await turnsIn(file))[1];
      assert.equal(turn?.files, undefined);
      assert.equal(turn?.sizes, undefined);
    });

    it('leaves a write whose input it cannot read out of sizes, but keeps its pill', async () => {
      // The `±?` case, and the only one there is: a tool in `WRITES` whose input
      // arrived in a shape `sizeOf` does not know.
      const file = await write('odd-shape', [
        user('fix it'),
        assistant([
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: proj('app.ts'), patch: '@@ -1 +1 @@' }
          }
        ])
      ]);
      const turn = (await turnsIn(file))[1];
      assert.deepEqual(turn?.files, [proj('app.ts')]);
      assert.equal(turn?.sizes, undefined);
    });

    it('never keys a size under a path files does not carry', async () => {
      // The sidecar's one invariant. `files` dedupes and `sizes` sums, so they
      // are merged by different rules at three points and can drift apart; a
      // size with no pill is invisible, and a pill with no size reads as `±?`
      // for a write that was measured perfectly well.
      const file = await write('invariant', [
        user('do it'),
        assistant([...writes('Read', '/proj/read.ts'), ...edit('/proj/a.ts', 'a', 'a\nb')]),
        assistant(edit('/proj/b.ts', 'x\ny', 'x')),
        assistant(text('done'))
      ]);
      for (const turn of await turnsIn(file)) {
        for (const key of Object.keys(turn.sizes ?? {})) {
          assert.ok(turn.files?.includes(key), `${key} has a size and no pill`);
        }
      }
    });
  });
});
