import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shiftImageMarkers, withoutImageMarkers } from '../../core/markers';

/**
 * The rule both halves of the panel share. The merge shifts a queued message's
 * markers; titles and echo matching read the prose under them. Every case
 * below is about the same distinction: a number this message attached is a
 * reference and may be rewritten, and any other number is prose.
 */

describe('withoutImageMarkers', () => {
  it('leaves the prose, and closes the gap the marker left', () => {
    assert.equal(withoutImageMarkers('look [Image #1] at this'), 'look at this');
    assert.equal(withoutImageMarkers('[Image #1] why is this clipped?'), 'why is this clipped?');
  });

  it('answers empty for a message that was only markers', () => {
    assert.equal(withoutImageMarkers('[Image #1]'), '');
    assert.equal(withoutImageMarkers('[Image #1] [Image #2] '), '');
  });

  it('leaves a message with no markers in it exactly as it was', () => {
    assert.equal(withoutImageMarkers('nothing to see'), 'nothing to see');
  });
});

describe('shiftImageMarkers', () => {
  it('shifts what the message carried', () => {
    assert.equal(shiftImageMarkers('a [Image #1] b [Image #2]', 2, 2), 'a [Image #3] b [Image #4]');
  });

  it('leaves a number past what it carried, which is prose about an older turn', () => {
    assert.equal(shiftImageMarkers('as in [Image #9] earlier', 2, 1), 'as in [Image #9] earlier');
  });

  it('is a no-op at offset zero, so the head of a merge is untouched', () => {
    assert.equal(shiftImageMarkers('first [Image #1]', 0, 1), 'first [Image #1]');
  });

  it('keeps the punctuation that followed the marker', () => {
    assert.equal(shiftImageMarkers('see [Image #1]!', 1, 1), 'see [Image #2]!');
    assert.equal(shiftImageMarkers('see [Image #1]\nnext', 1, 1), 'see [Image #2]\nnext');
  });
});
