import * as assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';

let loadBoard: typeof import('../../cli/board').loadBoard;
let targetRefusal: typeof import('../../cli/board').targetRefusal;

before(async () => {
  await tempHome();
  ({ loadBoard, targetRefusal } = await import('../../cli/board'));
});

describe('loadBoard', () => {
  it('is exit 3 when no window has claimed, not an empty board', async () => {
    const result = await loadBoard();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 3);
    assert.match(result.reason, /no IDE window/);
  });
});

describe('targetRefusal', () => {
  it('gives each resolution failure its own sentence', () => {
    const background = targetRefusal('background', 'pid 7', 'send on');
    const unpublished = targetRefusal('unpublished', 'pid 7', 'send on');
    const missing = targetRefusal('owner-missing', 'pid 7', 'send on');
    const invalid = targetRefusal('invalid', 'pid 7', 'send on');
    const exited = targetRefusal('exited', 'pid 7', 'send on');
    assert.equal(new Set([background, unpublished, missing, invalid, exited]).size, 5);
    assert.match(background, /background/);
    assert.doesNotMatch(background, /has a pipe/);
    assert.match(unpublished, /no window publishes a pipe/);
    assert.doesNotMatch(unpublished, /has a pipe/);
    assert.match(missing, /has a pipe, but no window claims it/);
    assert.match(invalid, /invalid control facts/);
    assert.match(exited, /has exited/);
  });
});
