/** Memory Used matches Activity Monitor; observed evidence: docs/reference/machine_memory.md. */
import { compose, labelled, reading, type Effects, type Memory, type Reading } from './index';

export function memory(effects: Pick<Effects, 'run' | 'totalmem'>): Memory {
  return compose(async () =>
    parseVmStat(await effects.run('/usr/bin/vm_stat', { timeout: SPAWN_MS }), effects.totalmem())
  );
}

/**
 * A backstop, not a latency budget — the read measures at ~1 ms. `vm_stat` takes
 * kernel locks, and the moment it could block on one is real memory pressure,
 * which is the moment this reading is most wanted and least able to wait.
 * Without it a stalled read is invisible: nothing throws, so the failure projection
 * never runs.
 */
const SPAWN_MS = 2000;

/**
 * `vm_stat`'s table -> a reading, given the installed bytes it does not print.
 *
 * **Anonymous minus purgeable, plus wired, plus compressed.** That is Activity
 * Monitor's *Memory Used* — App Memory + Wired + Compressed — and matching it is
 * the whole point: a reader who doubts the dial opens Activity Monitor, and the
 * two must agree or the panel is the thing that looks broken.
 *
 * The obvious sum is the wrong one. `vm_stat` partitions the same pages twice:
 * by age (active / inactive / speculative) and by kind (anonymous /
 * file-backed). Summing `wired + active + compressed` takes the age cut, which
 * counts active *file cache* as used and drops inactive *app* memory — 15.14 GiB
 * against Activity Monitor's 19.35 on the machine this was written on. Only the
 * kind cut answers "how much memory do the programs have", and only `vm_stat`
 * prints it.
 *
 * Purgeable is subtracted because those pages are anonymous but reclaimable
 * without cost, which is exactly how Activity Monitor arrives at App Memory.
 *
 * The page size is read from the header rather than assumed — 16 KiB on Apple
 * silicon, 4 KiB on Intel.
 */
function parseVmStat(stdout: string, total: number): Reading | undefined {
  const head = /page size of (\d+) bytes/.exec(stdout);
  const pageSize = head?.[1];
  if (pageSize === undefined) return undefined;

  const anonymous = labelled(stdout, 'Anonymous pages');
  const purgeable = labelled(stdout, 'Pages purgeable');
  const wired = labelled(stdout, 'Pages wired down');
  const compressed = labelled(stdout, 'Pages occupied by compressor');
  if (
    anonymous === undefined ||
    purgeable === undefined ||
    wired === undefined ||
    compressed === undefined
  ) {
    return undefined;
  }

  return reading((anonymous - purgeable + wired + compressed) * Number(pageSize), total);
}
