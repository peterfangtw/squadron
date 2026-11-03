/**
 * A control's flip, held on screen from the press until a push agrees.
 *
 * The host's push lands a beat after the press, and one composed before the
 * host took the write would put the switch back under the finger. So the
 * reader's value is shown until a push carries it, or until the host answers
 * the write without it — a refusal, or a write that did not land.
 *
 * Settling is not a read. `shown` never retires a flip; `FlipHolds.settle`
 * does, on every push, for every hold the set made, whether or not the
 * surface drawing it is open. A flip settled only where it is painted
 * outlives the push that agreed with it while that surface is shut, and is
 * then drawn over a later value it never asked for.
 */
export class FlipHold<K, V> {
  private readonly wanted = new Map<K, V>();

  /** `pushed` reads the latest push's value for a key; undefined is a key
   *  the push does not name, which settles nothing. */
  constructor(private readonly pushed: (key: K) => V | undefined) {}

  /** The reader pressed: show `value` for `key` until a push agrees. */
  hold(key: K, value: V): void {
    this.wanted.set(key, value);
  }

  /** What `key`'s control shows: the flip held, else what was pushed. */
  shown(key: K, pushed: V): V {
    return this.wanted.has(key) ? (this.wanted.get(key) as V) : pushed;
  }

  /** The host refused the write, or it did not land: show what was pushed.
   *  Given the value that write asked for, only while the flip still holds
   *  it — a later press is a later write, and its own answer is coming. */
  drop(key: K, asked?: V): void {
    if (asked !== undefined && this.wanted.get(key) !== asked) return;
    this.wanted.delete(key);
  }

  /** What is held, for a paint signature. */
  held(): ReadonlyMap<K, V> {
    return this.wanted;
  }

  /** Retire every flip the latest push agrees with. */
  settle(): void {
    for (const [key, value] of this.wanted) {
      if (this.pushed(key) === value) this.wanted.delete(key);
    }
  }
}

/** Every hold one panel keeps, settled together on each push. */
export class FlipHolds {
  private readonly all: { settle(): void }[] = [];

  add<K, V>(pushed: (key: K) => V | undefined): FlipHold<K, V> {
    const hold = new FlipHold(pushed);
    this.all.push(hold);
    return hold;
  }

  settle(): void {
    for (const hold of this.all) hold.settle();
  }
}
