import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as flipHold from '../../ui/flip_hold';

describe('a flip held until a push agrees', () => {
  it('shows the flip over the pushed value until a settle sees them agree', () => {
    const pushed = new Map([['a', false]]);
    const holds = new flipHold.FlipHolds();
    const hold = holds.add<string, boolean>((key) => pushed.get(key));
    hold.hold('a', true);
    holds.settle();
    assert.equal(hold.shown('a', false), true, 'a push from before the press took the flip');
    pushed.set('a', true);
    holds.settle();
    pushed.set('a', false);
    assert.equal(hold.shown('a', false), false, 'an agreed flip outlived its push');
  });

  it('settles only in settle, so a paint that never runs cannot strand a flip', () => {
    const pushed = new Map([['a', false]]);
    const holds = new flipHold.FlipHolds();
    const hold = holds.add<string, boolean>((key) => pushed.get(key));
    hold.hold('a', true);
    assert.equal(hold.shown('a', true), true);
    // Read again against a later value: a read that settled would show false.
    assert.equal(hold.shown('a', false), true, 'reading the switch settled its flip');
  });

  it('settles every hold the set made, in one call', () => {
    const flags = new Map([['warmCache', false]]);
    const figures = new Map([['buffer', 5]]);
    const holds = new flipHold.FlipHolds();
    const flag = holds.add<string, boolean>((key) => flags.get(key));
    const figure = holds.add<string, number>((key) => figures.get(key));
    flag.hold('warmCache', true);
    figure.hold('buffer', 9);
    flags.set('warmCache', true);
    figures.set('buffer', 9);
    holds.settle();
    flags.set('warmCache', false);
    figures.set('buffer', 5);
    assert.equal(flag.shown('warmCache', false), false);
    assert.equal(figure.shown('buffer', 5), 5);
  });

  it('keeps a flip whose key no push names', () => {
    const holds = new flipHold.FlipHolds();
    const hold = holds.add<string, boolean>(() => undefined);
    hold.hold('gone', true);
    holds.settle();
    assert.equal(hold.shown('gone', false), true);
  });

  it('drops a flip the host refused, whatever was pushed', () => {
    const holds = new flipHold.FlipHolds();
    const hold = holds.add<string, boolean>(() => false);
    hold.hold('a', true);
    hold.drop('a');
    assert.equal(hold.shown('a', false), false);
    assert.deepEqual([...hold.held()], []);
  });

  it('keeps a later flip through the refusal of an earlier write', () => {
    const holds = new flipHold.FlipHolds();
    const hold = holds.add<string, number>(() => 60);
    hold.hold('ttl', 30);
    hold.hold('ttl', 45);
    hold.drop('ttl', 30);
    assert.equal(hold.shown('ttl', 60), 45, 'an older refusal dropped a newer commit');
    hold.drop('ttl', 45);
    assert.equal(hold.shown('ttl', 60), 60);
  });

  it('lists what it holds, for a paint signature', () => {
    const holds = new flipHold.FlipHolds();
    const hold = holds.add<string, number>(() => 1);
    hold.hold('a', 2);
    assert.deepEqual([...hold.held()], [['a', 2]]);
  });
});
