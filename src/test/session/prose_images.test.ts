import * as assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';
let proseImages: typeof import('../../core/prose_images');
before(async () => {
  await tempHome();
  proseImages = await import('../../core/prose_images');
});
describe('an image a turn pointed at in its prose', () => {
  it('reads a long line dense with unclosed alts without stalling on it', () => {
    // Uncapped, this shape cost 3.9 s at 128 KB — the scan restarting at every
    // `![`, which is not the backtracking the first fix addressed.
    const text = '!['.repeat(65 * 1024);
    const began = process.cpuUsage();
    const parsed = proseImages.proseImages(text, 'u1', 0, undefined);
    const used = process.cpuUsage(began);
    assert.deepEqual(parsed, { prose: text, refs: [] });
    assert.ok(used.user + used.system < 200_000, 'parse used over 200ms of CPU');
  });
});
