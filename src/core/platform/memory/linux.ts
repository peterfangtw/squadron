/** Unverified, unchanged Linux reader; container evidence: docs/reference/machine_memory.md. */
import { compose, labelled, reading, type Effects, type Memory, type Reading } from './index';

export function memory(effects: Pick<Effects, 'readText'>): Memory {
  // /proc/meminfo describes the host even inside a capped container.
  return compose(
    async () =>
      (await cgroupLimit(effects)) ?? parseMemInfo(await effects.readText('/proc/meminfo'))
  );
}

/** The container's ceiling if there is one, else nothing — see `parseCgroup`. */
async function cgroupLimit(effects: Pick<Effects, 'readText'>): Promise<Reading | undefined> {
  try {
    const [max, current] = await Promise.all([
      effects.readText('/sys/fs/cgroup/memory.max'),
      effects.readText('/sys/fs/cgroup/memory.current')
    ]);
    return parseCgroup(max, current);
  } catch {
    return undefined;
  }
}

/**
 * `/proc/meminfo` -> a reading. `MemAvailable`, never `MemFree`: it is the
 * kernel's own estimate of what a new allocation could get, reclaimable page
 * cache included, which is the same correction darwin needs. Falling back to
 * `MemFree` when it is missing would reproduce the macOS lie on a platform that
 * does not have it, so a kernel too old to carry the field gets no reading.
 *
 * Every value in that file is in kB whatever else the line says.
 */
function parseMemInfo(text: string): Reading | undefined {
  const total = labelled(text, 'MemTotal');
  const available = labelled(text, 'MemAvailable');
  if (total === undefined || available === undefined) return undefined;
  return reading((total - available) * 1024, total * 1024);
}

/**
 * cgroup v2's own two numbers -> a reading, for the container case.
 *
 * `/proc/meminfo` is the *host's* inside a container, and a Dev Container or a
 * Codespace is an ordinary VS Code host. Unguarded, the gauge paints a build
 * server's 512 GiB for a session capped at 4, or reads comfortable while the
 * kernel is about to OOM-kill it at its limit — a plausible wrong number, which
 * is the failure this file exists to avoid.
 *
 * `memory.max` is the literal string `max` when the cgroup is unlimited, which
 * `Number` makes `NaN` and `reading` rejects — so an uncapped container falls
 * through to `/proc/meminfo`, where the host's figure is the right one.
 */
function parseCgroup(max: string, current: string): Reading | undefined {
  return reading(Number(current.trim()), Number(max.trim()));
}
