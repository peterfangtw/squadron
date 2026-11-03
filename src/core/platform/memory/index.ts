import { unsupported, type Result } from '../unsupported';

/**
 * How much of the machine's RAM is in use. Bytes rather than a percentage,
 * because the dial's fill wants the ratio and the figure beside it wants the
 * absolute — the wire should carry the thing both are derived from.
 */
export type Reading = {
  /** In use, by the host OS's own definition of the phrase. */
  used: number;
  /** What that is a share of — installed RAM, or a cgroup's ceiling. */
  total: number;
};

export interface Effects {
  run(file: string, options: { timeout: number }): Promise<string>;
  readText(file: string): Promise<string>;
  totalmem(): number;
  freemem(): number;
}

export interface Memory {
  /** No reading for a changed report; failed effects remain distinct. Never throws. */
  read(): Promise<Result<Reading | undefined>>;
}

export function compose(read: () => Reading | undefined | Promise<Reading | undefined>): Memory {
  return {
    async read() {
      try {
        return { supported: true, status: 'ok', value: await read() };
      } catch (error) {
        return {
          supported: true,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}

export function refused(os: NodeJS.Platform): Memory {
  return { read: () => Promise.resolve(unsupported('memory.read', os, 'no memory reader')) };
}

/** A labelled count on its own line, as `vm_stat` and `/proc` both write them.
 * Absent rather than zero when the line is not there: a partial table summed as
 * if it were whole is the one failure that still looks plausible. */
export function labelled(text: string, label: string): number | undefined {
  const found = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text);
  const digits = found?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * The one gate every arm returns through, so no caller has to ask whether a
 * reading makes sense. A share that is negative, larger than its whole, or a
 * share of nothing is not a smaller reading — it is a parse that went wrong,
 * and the honest answer to that is the same as to a missing tool.
 *
 * Here rather than at the last consumer: `src/AGENTS.md` puts a decision worth
 * a test in `core/`, and the alternative was one defensive line in the webview
 * that no scenario could reach.
 */
export function reading(used: number, total: number): Reading | undefined {
  if (!Number.isFinite(used) || !Number.isFinite(total)) return undefined;
  if (total <= 0 || used < 0 || used > total) return undefined;
  return { used, total };
}
