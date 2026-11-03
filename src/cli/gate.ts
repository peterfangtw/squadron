/**
 * Orchestration's gate over every write verb, run after argument parsing and
 * before anything else the verb reads or writes. No entry point, so importing
 * it executes nothing (`open.ts` says why that matters in a bundle).
 *
 * Not a boundary: a hand-written request file skips it, and the window's own
 * checks on spawn and send stay the authoritative ones.
 */

import { readClaims } from '../core/coordination/claims';
import type { WindowClaim } from '../core/model';
import { readPublished } from '../core/published';
import { ORCHESTRATION_OFF, isWriteVerb, type WriteVerb } from '../core/verbs';
import * as windows from './windows';

export const NO_WINDOW = 'no IDE window is running with Squadron installed';

/**
 * Whether Orchestration is on for a caller from window `origin`: that
 * window's claim while it is live, else whether any live claim is on. Only a
 * literal `true` is on — a window predating the field publishes none.
 */
export function orchestrationOn(
  claims: readonly WindowClaim[],
  origin: string | undefined
): boolean {
  const own = origin === undefined ? undefined : claims.find((c) => c.id === origin);
  if (own) return own.orchestration === true;
  return claims.some((c) => c.orchestration === true);
}

/**
 * Exits 3 with no live window (the switch cannot be read), 2 with
 * `ORCHESTRATION_OFF` while it is off, and returns while it is on.
 */
export async function refuseUnlessOn(verb: WriteVerb): Promise<void> {
  if (!isWriteVerb(verb)) throw new Error(`squadron-${String(verb)} is not a write verb`);
  const claims = await readClaims();
  if (claims.length === 0) refuse(verb, 3, NO_WINDOW);
  if (!orchestrationOn(claims, await callerWindow(process.env))) {
    refuse(verb, 2, ORCHESTRATION_OFF);
  }
}

/**
 * `windows.originWindow`, with the published records read only when the
 * planted variable is absent — every child of a current build has it.
 */
async function callerWindow(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const planted = env.SQUADRON_ORIGIN_WINDOW;
  if (planted !== undefined && planted !== '') return planted;
  return windows.originWindow(env, await readPublished());
}

function refuse(verb: WriteVerb, code: 2 | 3, reason: string): never {
  process.stderr.write(`squadron-${verb}: ${reason}\n`);
  process.exit(code);
}
