import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import * as layout from '../../ui/bottom_hub_layout';

it('keeps the full row when it fits, otherwise reserves More and its gaps', () => {
  const widths = [100, 70, 90, 110, 110];
  for (const [available, expected] of [
    [516, 5],
    [515.5, 4],
    [360, 3],
    [280, 2],
    [200, 1],
    [100, 1]
  ]) {
    assert.equal(layout.visibleOptions(widths, available!, 60, 9), expected);
  }
  assert.equal(layout.visibleOptions([], 0, 60, 9), 0);
});
