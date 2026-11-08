import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Conversation } from '../../core/thread';
import { TurnCapture, type CapturePort, type CaptureEdge } from '../../core/turn_capture';

interface Observer {
  readonly id: number;
}

/** A capture over a recording port; `order` interleaves port calls and slots. */
function harness() {
  const order: string[] = [];
  const released: string[] = [];
  const port: CapturePort = {
    openUnknown: (_cwd, context) => {
      order.push(`openUnknown:${context.turn}`);
      return Promise.resolve();
    },
    uncertainExecution: (_cwd, context) => {
      order.push(`wake:${context.turn}`);
      return () => released.push(context.turn);
    },
    closeExecution: (_cwd, observation) => {
      order.push(observation ? 'close:observed' : 'close');
      return Promise.resolve({});
    },
    discard: () => {
      order.push('discard');
    }
  };
  const conversation = {
    pending: () => {
      order.push('slot');
    }
  } as unknown as Conversation;
  let next = 0;
  const create = (): Observer => ({ id: ++next });
  const capture = new TurnCapture<Observer>(
    port,
    'runtime',
    () => conversation,
    () => () =>
      Promise.resolve({
        observed: true,
        calls: []
      })
  );
  return { capture, order, released, create };
}

const turn = (over: Partial<{ inFlight: boolean; baselining: boolean }> = {}) => ({
  cwd: '/Users/me/src/squadron',
  owner: 'claude:sid',
  id: 't1',
  inFlight: false,
  baselining: false,
  ...over
});

const edge = (over: Partial<CaptureEdge>): CaptureEdge => ({
  running: false,
  warm: false,
  inFlight: false,
  cwd: '/Users/me/src/squadron',
  ...over
});

describe('TurnCapture', () => {
  it('opens an unknown turn with its own observer when nothing is draining', () => {
    const { capture, order, create } = harness();
    capture.opened(turn(), create);
    assert.deepEqual(order, ['openUnknown:t1']);
    assert.deepEqual(capture.observer, { id: 1 });
  });

  it('opens an uncertain wake instead while a drain is baselining', () => {
    const { capture, order, create } = harness();
    capture.opened(turn({ baselining: true }), create);
    assert.deepEqual(order, ['wake:t1']);
    assert.equal(capture.observer, undefined);
  });

  it('opens a wake when an observer waits for a prompt not yet in flight', () => {
    const { capture, order, create } = harness();
    capture.install({ id: 9 });
    capture.opened(turn(), create);
    assert.deepEqual(order, ['wake:t1']);
    assert.deepEqual(capture.observer, { id: 9 }, 'the drain keeps its observer');
  });

  it('opens nothing for a turn already in flight under an observer', () => {
    const { capture, order, create } = harness();
    capture.install({ id: 9 });
    capture.opened(turn({ inFlight: true }), create);
    assert.deepEqual(order, []);
  });

  it('keeps one wake open at a time, released once', () => {
    const { capture, order, released, create } = harness();
    capture.opened(turn({ baselining: true }), create);
    capture.opened({ ...turn({ baselining: true }), id: 't2' }, create);
    assert.deepEqual(order, ['wake:t1']);
    capture.releaseWake();
    capture.releaseWake();
    assert.deepEqual(released, ['t1']);
  });

  it('leaves the wake open when a turn ends; its native turn releases it', () => {
    const { capture, released, create } = harness();
    capture.opened(turn({ baselining: true }), create);
    capture.ended('/Users/me/src/squadron', { warm: false, baselining: false });
    assert.deepEqual(released, []);
  });

  it('reserves the thread slot before the capture settles', () => {
    const { capture, order, create } = harness();
    capture.opened(turn(), create);
    capture.ended('/Users/me/src/squadron', { warm: false, baselining: false });
    assert.deepEqual(order, ['openUnknown:t1', 'close:observed', 'slot']);
    assert.equal(capture.observer, undefined, 'the observer is taken');
  });

  it('captures nothing on a warm end or while a drain is baselining', () => {
    const { capture, order, create } = harness();
    capture.opened(turn(), create);
    capture.ended('/Users/me/src/squadron', { warm: true, baselining: false });
    capture.ended('/Users/me/src/squadron', { warm: false, baselining: true });
    assert.deepEqual(order, ['openUnknown:t1']);
    assert.deepEqual(capture.observer, { id: 1 }, 'the observer survives for the real end');
  });

  it('closes again on a repeat end, with no observer to hand over', () => {
    const { capture, order, create } = harness();
    capture.opened(turn(), create);
    capture.ended('/Users/me/src/squadron', { warm: false, baselining: false });
    capture.ended('/Users/me/src/squadron', { warm: false, baselining: false });
    assert.deepEqual(order, ['openUnknown:t1', 'close:observed', 'slot', 'close', 'slot']);
  });

  it('discards the drain baseline and drops its observer', () => {
    const { capture, order } = harness();
    capture.install({ id: 3 });
    capture.discard();
    assert.deepEqual(order, ['discard']);
    assert.equal(capture.observer, undefined);
  });

  describe('follow', () => {
    it('opens on the rising edge and closes on the falling one', () => {
      const { capture, order, released, create } = harness();
      capture.follow(edge({ running: true }), { owner: 'claude:sid', create }, false);
      assert.equal(capture.running, true);
      capture.follow(edge({ running: true }), { owner: 'claude:sid', create }, false);
      capture.follow(edge({ running: false }), { owner: 'claude:sid', create }, false);
      assert.equal(order.length, 3);
      assert.match(order[0] ?? '', /^openUnknown:/);
      assert.deepEqual(order.slice(1), ['close:observed', 'slot']);
      assert.deepEqual(released, []);
      assert.equal(capture.running, false);
    });

    it('releases the wake on the falling edge', () => {
      const { capture, released, create } = harness();
      capture.follow(edge({ running: true }), { owner: 'claude:sid', create }, true);
      capture.follow(edge({ running: false }), { owner: 'claude:sid', create }, false);
      assert.equal(released.length, 1);
    });

    it('opens nothing without an owner', () => {
      const { capture, order } = harness();
      capture.follow(edge({ running: true }), undefined, false);
      assert.deepEqual(order, []);
      assert.equal(capture.running, true);
    });

    it('neither opens nor closes on a warm edge, but remembers it', () => {
      const { capture, order, create } = harness();
      capture.follow(edge({ running: true, warm: true }), { owner: 'claude:sid', create }, false);
      assert.equal(capture.running, true);
      capture.follow(edge({ running: false, warm: true }), { owner: 'claude:sid', create }, false);
      assert.deepEqual(order, []);
    });
  });
});
