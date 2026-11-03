import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COALESCE_MS,
  COOLDOWN_MS,
  Director,
  facts,
  FLIGHTS_PER_MINUTE,
  POSE,
  type Board,
  type Fact
} from '../../ui/mascot';
import { cardView, groupView } from '../harness';

const board = (sessions: CardView[], awake?: AwakeView): Board => ({
  groups: [groupView({ sessions })],
  ...(awake ? { awake } : {})
});
const card = (pid: number, over: Partial<CardView> = {}): CardView =>
  cardView({ pid, status: 'busy', ...over });
const DONE = { word: 'done', tally: 'done' } as unknown as CardReading;
const DRINKING: AwakeView = { reason: 'drinking', until: 1, sessions: 1 };

describe('mascot facts', () => {
  it('says nothing on the first push, whatever the board holds', () => {
    assert.deepEqual(facts(undefined, board([card(1, { status: 'waiting' }), card(2)])), []);
  });

  it('says nothing when the board did not change', () => {
    const b = board([card(1), card(2, { status: 'waiting', unread: DONE })]);
    assert.deepEqual(facts(b, b), []);
  });

  it('names a card whose status became waiting', () => {
    assert.deepEqual(facts(board([card(1)]), board([card(1, { status: 'waiting' })])), [
      { kind: 'waiting', pid: 1 }
    ]);
  });

  it('names a finished turn when unread appears, not while it stays', () => {
    const read = board([card(1, { status: 'idle', unread: DONE }), card(2)]);
    assert.deepEqual(facts(board([card(1), card(2)]), read), [{ kind: 'done', pid: 1 }]);
    assert.deepEqual(facts(read, read), []);
  });

  it('names a card absent from the last push as new', () => {
    assert.deepEqual(facts(board([card(1)]), board([card(1), card(2)])), [
      { kind: 'start', pid: 2 }
    ]);
  });

  it('says everything went idle once, on the push that quietened the last card', () => {
    const quiet = board([card(1, { status: 'idle' }), card(2, { status: 'idle' })]);
    assert.deepEqual(facts(board([card(1, { status: 'idle' }), card(2)]), quiet), [
      { kind: 'idle' }
    ]);
    assert.deepEqual(facts(quiet, quiet), []);
  });

  it('says the hold ended when awake leaves drinking, and only then', () => {
    const cards = [card(1, { status: 'idle' })];
    assert.deepEqual(facts(board(cards, DRINKING), board(cards, { reason: 'idle' })), [
      { kind: 'sleep' }
    ]);
    assert.deepEqual(facts(board(cards, DRINKING), board(cards)), [{ kind: 'sleep' }]);
    assert.deepEqual(facts(board(cards, { reason: 'idle' }), board(cards)), []);
  });
});

describe('the mascot director', () => {
  /** A director on a clock the test moves. */
  function rig(): { d: Director; at: (ms: number) => void } {
    let now = 0;
    return { d: new Director(() => now), at: (ms) => (now = ms) };
  }
  const yes = (): boolean => true;

  it('opens one batch per window, due a coalesce after the first fact', () => {
    const { d, at } = rig();
    at(100);
    assert.equal(d.offer([{ kind: 'done', pid: 1 }]), 100 + COALESCE_MS);
    at(400);
    assert.equal(d.offer([{ kind: 'done', pid: 2 }]), undefined);
    assert.equal(d.offer([]), undefined);
  });

  it('decides a storm once, for the highest-ranked fact', () => {
    const { d, at } = rig();
    for (let i = 0; i < 10; i++) d.offer([{ kind: 'done', pid: i }]);
    d.offer([{ kind: 'waiting', pid: 42 }]);
    at(COALESCE_MS);
    assert.deepEqual(d.decide(yes, yes), { fact: { kind: 'waiting', pid: 42 }, fly: true });
    assert.equal(d.decide(yes, yes), undefined);
  });

  it('poses a second finish inside the cooldown, and flies a dialog through it', () => {
    const { d, at } = rig();
    d.offer([{ kind: 'done', pid: 1 }]);
    at(COALESCE_MS);
    assert.equal(d.decide(yes, yes)?.fly, true);
    at(2000);
    d.offer([{ kind: 'done', pid: 2 }]);
    at(2000 + COALESCE_MS);
    assert.deepEqual(d.decide(yes, yes), { fact: { kind: 'done', pid: 2 }, fly: false });
    d.offer([{ kind: 'waiting', pid: 3 }]);
    at(4000 + COALESCE_MS);
    assert.deepEqual(d.decide(yes, yes), { fact: { kind: 'waiting', pid: 3 }, fly: true });
  });

  it('flies again for the same rank once the cooldown is over', () => {
    const { d, at } = rig();
    d.offer([{ kind: 'done', pid: 1 }]);
    at(COALESCE_MS);
    d.decide(yes, yes);
    at(COALESCE_MS + COOLDOWN_MS);
    d.offer([{ kind: 'done', pid: 2 }]);
    at(2 * COALESCE_MS + COOLDOWN_MS);
    assert.equal(d.decide(yes, yes)?.fly, true);
  });

  it('poses once the minute has spent its flights', () => {
    const { d, at } = rig();
    let t = 0;
    for (let i = 0; i < FLIGHTS_PER_MINUTE; i++) {
      at(t);
      d.offer([{ kind: 'waiting', pid: i }]);
      at((t += COALESCE_MS + COOLDOWN_MS));
      assert.equal(d.decide(yes, yes)?.fly, true, `flight ${i + 1}`);
    }
    // Past the cooldown, so only the budget can be what holds it.
    d.offer([{ kind: 'waiting', pid: 9 }]);
    at((t += COOLDOWN_MS + COALESCE_MS));
    assert.deepEqual(d.decide(yes, yes), { fact: { kind: 'waiting', pid: 9 }, fly: false });
    // The window trails: a minute after the first flight, one is free again.
    d.offer([{ kind: 'waiting', pid: 10 }]);
    at(COALESCE_MS + COOLDOWN_MS + 60_000);
    assert.equal(d.decide(yes, yes)?.fly, true);
  });

  it('drops a stale winner and acts on the next fact still true', () => {
    const { d, at } = rig();
    d.offer([
      { kind: 'start', pid: 1 },
      { kind: 'waiting', pid: 2 }
    ]);
    at(COALESCE_MS);
    const act = d.decide((f: Fact) => f.kind !== 'waiting', yes);
    assert.deepEqual(act, { fact: { kind: 'start', pid: 1 }, fly: true });
  });

  it('decides nothing when every fact went stale', () => {
    const { d, at } = rig();
    d.offer([{ kind: 'done', pid: 1 }]);
    at(COALESCE_MS);
    assert.equal(
      d.decide(() => false, yes),
      undefined
    );
  });

  it('never flies for the hold ending', () => {
    const { d, at } = rig();
    d.offer([{ kind: 'sleep' }]);
    at(COALESCE_MS);
    assert.deepEqual(d.decide(yes, yes), { fact: { kind: 'sleep' }, fly: false });
  });

  it('spends no budget when the webview says it cannot fly', () => {
    const { d, at } = rig();
    d.offer([{ kind: 'waiting', pid: 1 }]);
    at(COALESCE_MS);
    assert.equal(d.decide(yes, () => false)?.fly, false);
    d.offer([{ kind: 'done', pid: 2 }]);
    at(2 * COALESCE_MS);
    assert.equal(d.decide(yes, yes)?.fly, true, 'a pose started no cooldown');
  });

  it('forgets an open batch on reset', () => {
    const { d, at } = rig();
    d.offer([{ kind: 'done', pid: 1 }]);
    d.reset();
    at(COALESCE_MS);
    assert.equal(d.decide(yes, yes), undefined);
    assert.equal(d.offer([{ kind: 'done', pid: 1 }]), 2 * COALESCE_MS);
  });
});

describe('mascot poses', () => {
  it('holds alert for a dialog, and stands after a reaction', () => {
    assert.deepEqual(POSE.waiting, [{ frame: 'alert' }]);
    assert.deepEqual(POSE.done, [{ frame: 'happy', ms: 1400 }, { frame: 'stand' }]);
    assert.deepEqual(POSE.start, [{ frame: 'happy', ms: 900 }, { frame: 'stand' }]);
    assert.equal(POSE.sleep.at(-1)?.frame, 'sleep');
  });
});
