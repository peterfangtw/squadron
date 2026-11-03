import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findRefs, refFor } from '../../core/session_ref';

describe('session refs', () => {
  it('finds what refFor wrote', () => {
    const path = '/Users/me/.claude/projects/-Users-me-proj/d6913539.jsonl';
    const text = `read ${refFor(6085, path)} first`;
    assert.deepEqual(findRefs(text), [
      { at: 5, text: refFor(6085, path), pid: 6085, transcript: path }
    ]);
  });

  it('finds every one, in order', () => {
    const text = `${refFor(1, '/a.jsonl')} and ${refFor(2, '/b.jsonl')}`;
    assert.deepEqual(
      findRefs(text).map((r) => r.pid),
      [1, 2]
    );
  });

  it('leaves a malformed one as prose', () => {
    assert.deepEqual(findRefs('@squadron[abc][/a.jsonl] @squadron[1][] @squadron[1]'), []);
  });
});
