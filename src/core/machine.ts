/**
 * The machine every session on the board is sharing, as two readings.
 *
 * `os.cpus()` gives cumulative tick counters, so a percentage is never one
 * reading: it is two, and the window between them. `cpuSample` is the impure
 * half; `meter` is the rule, and the whole of what has a test.
 *
 * Memory acquisition and interpretation belong to platform.memory; observed
 * evidence is in docs/reference/machine_memory.md.
 */
import * as os from 'node:os';
import * as platform from './platform';
import type { Reading } from './platform/memory';

/** Ticks across every core, at one instant. Meaningless alone. */
export type CpuSample = {
  /** Everything but idle. */
  busy: number;
  /** Idle included — the denominator. */
  total: number;
  /** How many cores those ticks are spread over, which sets the floor below. */
  cores: number;
};

/**
 * What one poll leaves behind: the counters to diff against next time, and the
 * answer to keep saying until there is a better one.
 */
export type CpuMeter = {
  at?: CpuSample;
  /** 0–100, or absent while nothing is yet known. */
  cpu?: number;
};

/**
 * The shortest window worth dividing by. Ticks are milliseconds per core, so
 * this is a second of wall clock.
 *
 * It exists because a refresh is not only the 3s poll — a selection change or a
 * burst of frames brings one too, and two samples milliseconds apart are noise
 * dressed as a reading. Under the floor the window is widened rather than
 * divided, so the gauge moves at one speed whatever provoked the paint.
 */
export const MIN_WINDOW_MS = 1000;

/** The counters as they stand. One read, whatever the core count. */
export function cpuSample(): CpuSample {
  const cpus = os.cpus();
  let busy = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total, cores: cpus.length };
}

/**
 * One poll's worth of metering: the previous state and a fresh sample in, the
 * next state out. Pure, so the three cases that matter are a test rather than
 * something to watch happen.
 *
 * - No previous sample: start the window, say nothing yet. Absence is not zero
 *   — zero is a claim about an idle machine, and this is a claim about nothing
 *   being known.
 * - Window under the floor: hold the old sample so it keeps widening, and
 *   repeat the last answer.
 * - Counters that went backwards: they only ever grow, so this is not the same
 *   machine-uptime any more — a laptop resumed from sleep is the ordinary case.
 *   Restart from here and drop the stale reading rather than paint a number the
 *   arithmetic cannot stand behind.
 */
export function meter(prev: CpuMeter, next: CpuSample): CpuMeter {
  const at = prev.at;
  if (!at) return { at: next, cpu: prev.cpu };

  const total = next.total - at.total;
  const busy = next.busy - at.busy;
  if (total < 0 || busy < 0) return { at: next };
  if (total < MIN_WINDOW_MS * next.cores) return prev;

  return { at: next, cpu: Math.max(0, Math.min(100, (busy / total) * 100)) };
}

export type MemoryReading = Reading;

/** Failed, unsupported or changed OS readings leave the CPU dial alone. */
export async function readMemory(): Promise<MemoryReading | undefined> {
  const result = await platform.memory.read();
  return result.supported && result.status === 'ok' ? result.value : undefined;
}

/**
 * The machine as the wire carries it, out of the meter's load and the last
 * memory read. `memory` is `null` once a read has settled with nothing — kept
 * apart from `undefined`, a read still out — because the nav draws the first as
 * "-" and the second as a wait. Neither reading waits for the other: memory can
 * settle before the meter has two samples to diff.
 */
export function machineView(
  cpu: number | undefined,
  memory: MemoryReading | null | undefined
): { cpu?: number; memory?: MemoryReading | null } | undefined {
  if (cpu === undefined && memory === undefined) return undefined;
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory })
  };
}
