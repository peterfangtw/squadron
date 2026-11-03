import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { orchestrationOn } from '../../cli/gate';
import type { WindowClaim } from '../../core/model';

function claim(id: string, orchestration?: unknown): WindowClaim {
  return {
    id,
    label: id,
    app: 'VS Code',
    shellPids: [],
    updatedAt: Date.now(),
    ...(orchestration === undefined ? {} : { orchestration: orchestration as boolean })
  };
}

describe('orchestrationOn', () => {
  it("reads the caller's own window when it is live", () => {
    assert.equal(orchestrationOn([claim('a', true), claim('b', false)], 'a'), true);
    assert.equal(orchestrationOn([claim('a', false), claim('b', true)], 'a'), false);
  });

  it('falls back to any live window being on once the origin has gone', () => {
    assert.equal(orchestrationOn([claim('b', false), claim('c', true)], 'gone'), true);
    assert.equal(orchestrationOn([claim('b', false)], 'gone'), false);
  });

  it('falls back the same way for a caller with no origin', () => {
    assert.equal(orchestrationOn([claim('b', true)], undefined), true);
  });

  it('is off with no live window', () => {
    assert.equal(orchestrationOn([], 'a'), false);
    assert.equal(orchestrationOn([], undefined), false);
  });

  it('reads an absent or non-boolean field as off', () => {
    assert.equal(orchestrationOn([claim('a')], 'a'), false);
    assert.equal(orchestrationOn([claim('a', 'yes')], 'a'), false);
    assert.equal(orchestrationOn([claim('a', 1)], undefined), false);
  });
});
