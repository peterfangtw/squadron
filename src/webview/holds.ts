/**
 * Every flip the panel holds on screen ahead of the host's echo
 * (`ui/flip_hold.ts`). `main.ts` settles the set once per state push, before
 * any surface repaints, so no surface's paint is where a flip retires.
 */

import * as flipHold from '../ui/flip_hold';
import { ui } from './state';

const all = new flipHold.FlipHolds();

export function add<K, V>(pushed: (key: K) => V | undefined): flipHold.FlipHold<K, V> {
  return all.add(pushed);
}

export function settle(): void {
  all.settle();
}

/** `setFlag` switches, by `FlagKey`, which names the `StateMessage` field the
 *  setting is pushed on: Warm's New sessions and Keep-awake's two switches. */
export const flags = add<FlagKey, boolean>((key) => ui.state[key]);

/** The host's answer to `setFlag`: a write that did not land drops its flip. */
export function settleFlag(msg: { key: FlagKey; on: boolean; landed: boolean }): void {
  if (!msg.landed) flags.drop(msg.key, msg.on);
}
