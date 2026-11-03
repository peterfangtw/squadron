import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { disjoint, scan, splice } from '../../core/tokens';

describe('scan', () => {
  it('finds known tokens left to right', () => {
    const hits = scan('x @a.ts y @b.ts', ['@a.ts', '@b.ts']);
    assert.deepEqual(hits, [
      { at: 2, text: '@a.ts' },
      { at: 10, text: '@b.ts' }
    ]);
  });

  it('does not invent hits for hand-typed @words', () => {
    assert.deepEqual(scan('hello @other', ['@a.ts']), []);
  });

  it('prefers a longer token when one is a prefix of the other', () => {
    // A file can be named `[Image #1].txt`. Longest-first is what stops the
    // shorter phrase inside it matching on its own.
    assert.deepEqual(scan('see @[Image #1].txt here', ['@[Image #1].txt', '[Image #1]']), [
      { at: 4, text: '@[Image #1].txt' }
    ]);
  });
});

describe('disjoint', () => {
  it('orders hits left to right and drops one starting inside an earlier one', () => {
    const hits = [
      { at: 9, text: 'cd' },
      { at: 0, text: 'abcdef' },
      { at: 3, text: 'de' }
    ];
    assert.deepEqual(disjoint(hits), [
      { at: 0, text: 'abcdef' },
      { at: 9, text: 'cd' }
    ]);
  });

  it('gives a tie to the hit listed first, whatever its length', () => {
    const short = { at: 2, text: 'ab', id: 'short' };
    const long = { at: 2, text: 'abcd', id: 'long' };
    assert.deepEqual(disjoint([short, long]), [short]);
  });
});

describe('splice', () => {
  it('keeps untouched prose and omits empty prose', () => {
    assert.deepEqual(
      splice('plain text', [], () => 'unused'),
      ['plain text']
    );
    assert.deepEqual(
      splice('', [], () => 'unused'),
      []
    );
    assert.deepEqual(
      splice('@a@b', scan('@a@b', ['@a', '@b']), (hit) => hit.text),
      ['@a', '@b']
    );
  });

  it('resumes slicing after the original hit when its replacement is shorter', () => {
    const text = 'see @first \n @second now';
    assert.deepEqual(
      splice(text, scan(text, ['@first', '@second']), (hit) => (hit.text === '@first' ? 'A' : 'B')),
      ['see ', 'A', ' \n ', 'B', ' now']
    );
  });

  it('keeps an empty replacement', () => {
    assert.deepEqual(
      splice('@a', scan('@a', ['@a']), () => ''),
      ['']
    );
  });

  it('passes extra hit fields through and accepts non-string replacements', () => {
    const hit = { at: 0, text: '@session', pid: 42, transcript: '/t.jsonl' };
    assert.deepEqual(
      splice('@session', [hit], ({ pid, transcript }) => ({ pid, transcript })),
      [{ pid: 42, transcript: '/t.jsonl' }]
    );
  });
});
