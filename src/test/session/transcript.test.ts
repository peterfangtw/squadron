import * as assert from 'node:assert/strict';

import * as path from 'node:path';

import { describe, it } from 'node:test';

import {
  recentUserFrom,
  noteWrite,
  sizeOf,
  warmOwned,
  type WriteInput,
  type Written
} from '../../core/transcript';

const proj = (...parts: string[]) => path.resolve('/proj', ...parts);

describe('sizeOf', () => {
  // Reachable only through `readRecent` until it moved to `core/transcript.ts`
  // for the Grok reader to call. The cases below are what that reader relies on.

  it('counts what a Write put down, and never a deletion', () => {
    // The frame does not carry what was there before, so an overwrite still
    // reports add-only — recorded on `sizeOf` itself, asserted here.
    assert.deepEqual(sizeOf('Write', { content: 'a\nb\nc\n' }), { add: 3, del: 0 });
  });

  it('does not count the phantom line a trailing newline splits into', () => {
    assert.deepEqual(sizeOf('Write', { content: 'a\n' }), { add: 1, del: 0 });
    assert.deepEqual(sizeOf('Write', { content: 'a' }), { add: 1, del: 0 });
    assert.deepEqual(sizeOf('Write', { content: '' }), { add: 0, del: 0 });
  });

  it('trims an Edit down to the hunk, not the anchor the agent matched on', () => {
    const old = 'ctx1\nctx2\nold\nctx3\nctx4\n';
    const neu = 'ctx1\nctx2\nnew\nctx3\nctx4\n';
    assert.deepEqual(sizeOf('Edit', { old_string: old, new_string: neu }), { add: 1, del: 1 });
  });

  it('reads an Edit that only adds, and one that only removes', () => {
    assert.deepEqual(sizeOf('Edit', { old_string: 'a\n', new_string: 'a\nb\n' }), {
      add: 1,
      del: 0
    });
    assert.deepEqual(sizeOf('Edit', { old_string: 'a\nb\n', new_string: 'a\n' }), {
      add: 0,
      del: 1
    });
  });

  it('sums a MultiEdit across its hunks', () => {
    assert.deepEqual(
      sizeOf('MultiEdit', {
        edits: [
          { old_string: 'a\n', new_string: 'a\nb\n' },
          { old_string: 'x\ny\n', new_string: 'z\n' }
        ]
      }),
      { add: 2, del: 2 }
    );
  });

  it('answers nothing for a call with no input at all', () => {
    assert.equal(sizeOf('Write', undefined), undefined);
  });

  it('answers nothing for a shape it does not know', () => {
    // A tool outside the three it reads — `NotebookEdit` is in `WRITES` and has
    // no size here on purpose — and a write whose keys arrived wrong.
    assert.equal(sizeOf('NotebookEdit', { file_path: '/proj/n.ipynb' }), undefined);
    assert.equal(sizeOf('Write', { content: 42 }), undefined);
    assert.equal(sizeOf('Edit', { old_string: 'a' }), undefined);
    // Cast because `edits` is the one `WriteInput` field narrower than `unknown`;
    // the runtime guard is what another program's JSON actually meets.
    assert.equal(sizeOf('MultiEdit', { edits: 'nope' } as unknown as WriteInput), undefined);
  });

  it('answers nothing for a MultiEdit one of whose hunks is unreadable', () => {
    // The whole call, not the readable prefix: a partial sum would state a
    // magnitude smaller than what landed.
    assert.equal(
      sizeOf('MultiEdit', {
        edits: [{ old_string: 'a\n', new_string: 'a\nb\n' }, { old_string: 'x\n' }]
      }),
      undefined
    );
  });
});

describe('noteWrite', () => {
  // One copy for both brands, so the rules below are asserted once rather than
  // per reader. Each brand's test covers only its own wiring into this.
  const fold = (
    name: string,
    input: WriteInput | undefined,
    cwd: string | undefined
  ): { files: string[]; sizes: Record<string, Written> } => {
    const files: string[] = [];
    const sizes: Record<string, Written> = {};
    noteWrite(files, sizes, name, input, cwd);
    return { files, sizes };
  };

  it('drops a relative path when no cwd can resolve it', () => {
    // `path.resolve('', rel)` would hand back one under the extension host's own
    // working directory — a pill naming a file nothing wrote, on a path that may
    // well exist. `WRITES` says a missing pill beats one naming a file never
    // written. Both readers went through the fabricating form until 2026-08-28.
    assert.deepEqual(fold('Write', { file_path: 'src/a.ts', content: 'x\n' }, undefined), {
      files: [],
      sizes: {}
    });
  });

  it('still takes an absolute path with no cwd', () => {
    assert.deepEqual(fold('Write', { file_path: proj('a.ts'), content: 'x\n' }, undefined), {
      files: [proj('a.ts')],
      sizes: { [proj('a.ts')]: { add: 1, del: 0 } }
    });
  });

  it('resolves a relative path against the cwd it was given', () => {
    assert.deepEqual(fold('Write', { file_path: 'src/a.ts', content: 'x\n' }, proj()).files, [
      proj('src/a.ts')
    ]);
  });

  it('gates on WRITES, not merely on naming a file_path', () => {
    // The one branch no reader test could reach: on both brands today every tool
    // carrying `file_path` happens to be a writer, so only a synthetic call pins
    // the gate. Without it a future read-side tool naming `file_path` would draw
    // a write pill.
    assert.deepEqual(fold('Read', { file_path: '/proj/a.ts', content: 'x\n' }, '/proj'), {
      files: [],
      sizes: {}
    });
  });

  it('keeps a path it cannot size, and skips a call naming no file', () => {
    assert.deepEqual(fold('Edit', { file_path: proj('a.ts'), old_string: 'a' }, proj()), {
      files: [proj('a.ts')],
      sizes: {}
    });
    assert.deepEqual(fold('Write', { content: 'x\n' }, '/proj'), { files: [], sizes: {} });
    assert.deepEqual(fold('Write', undefined, '/proj'), { files: [], sizes: {} });
  });
});

describe('warmOwned', () => {
  it('ends a ping’s span at a trigger, as at any new input', () => {
    // A background command ending after a legacy ping: the turn the CLI starts
    // answers the command, not the ping.
    assert.deepEqual(
      warmOwned([
        { role: 'warm' },
        { role: 'assistant' },
        { mark: 'trigger' },
        { role: 'assistant' }
      ]),
      [true, true, false, false]
    );
  });
});

describe('recent user turns', () => {
  for (const count of [0, 1, 10, 11, 25]) {
    it(`selects the last ten complete user turns from ${count} prompts without byte or row cuts`, () => {
      const rows = Array.from({ length: count }, (_, i) => [
        { role: 'user', text: `prompt ${i}` },
        ...Array.from({ length: 65 }, (_, n) => ({ role: 'assistant', text: `reply ${i}.${n}` })),
        { role: 'assistant', text: 'x'.repeat(300_000) },
        { role: 'user', text: 'maintenance', maintenance: true }
      ]).flat();
      const from = recentUserFrom(rows);
      assert.equal(from, Math.max(0, count - 10) * 68);
      const selected = rows.slice(from);
      assert.equal(
        selected.filter((row) => row.role === 'user' && !('maintenance' in row)).length,
        Math.min(10, count)
      );
      assert.equal(selected.length, Math.min(10, count) * 68);
    });
  }
});
