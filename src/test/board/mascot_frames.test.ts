import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { FRAMES, SIZE } from '../../ui/mascot_frames';
import { runs } from '../../ui/mascot';
import { repoRoot } from '../helpers';

const ROOT = repoRoot();

describe('the baked mascot frames', () => {
  // A hand edit, or a chick.mjs change nobody re-baked, fails here rather than
  // shipping a sprite the design source no longer draws.
  it('are what scripts/mascot.mjs bakes from the design source', () => {
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, [path.join('scripts', 'mascot.mjs'), '--check'], {
        cwd: ROOT,
        stdio: 'pipe'
      })
    );
  });

  it('each cover the whole grid, with no run crossing a row end', () => {
    for (const [name, frame] of Object.entries(FRAMES)) {
      const spans = runs(frame);
      assert.ok(spans.length > 0, `${name} paints nothing`);
      for (const span of spans)
        assert.ok(span.x + span.w <= SIZE, `${name} wraps at row ${span.y}`);
    }
  });

  it('are nine, the poses the chick holds', () => {
    assert.deepEqual(Object.keys(FRAMES), [
      'stand',
      'walk1',
      'walk2',
      'crouch',
      'fly1',
      'fly2',
      'alert',
      'happy',
      'sleep'
    ]);
  });
});
