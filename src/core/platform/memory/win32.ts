import { compose, reading, type Effects, type Memory } from './index';

/** GlobalMemoryStatusEx's ullAvailPhys includes the standby list as available.
 *  Unverified legacy reader: docs/reference/machine_memory.md. No spawn. */
export function memory(effects: Pick<Effects, 'totalmem' | 'freemem'>): Memory {
  return compose(() => reading(effects.totalmem() - effects.freemem(), effects.totalmem()));
}
