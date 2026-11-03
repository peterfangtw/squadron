import * as vscode from 'vscode';
import { adapter } from '../core/adapter';
import { BRANDS } from '../core/brands';
import * as coordination from '../core/coordination/usage';
import { signInFor, signInRetryAt, storedSignIn } from '../core/signin';
import { UsageRefresher, liveReaderFor } from '../core/usage_refresh';
import type { Reconciler } from '../core/reconcile';
import type { BrandUsage } from '../core/usage';
import { configuredPath } from './cli_path';
import { ownedReporter, ownedSessions } from './sessions';

export function accountUsage(runtime: Reconciler, log: (line: string) => void): UsageRefresher {
  const known = async (): Promise<(BrandUsage & { generation: string })[]> => {
    const result: (BrandUsage & { generation: string })[] = [];
    for (const brand of BRANDS) {
      const source = adapter(brand)?.usage;
      if (!source || (await storedSignIn(brand))?.loggedIn !== true) continue;
      try {
        result.push({
          brand,
          source,
          signedIn: true,
          generation: await coordination.generation(brand)
        });
      } catch (error) {
        log(`usage: ${brand}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  };
  return new UsageRefresher(runtime, {
    observations: known,
    liveReader: ({ brand, source, generation }) => {
      const cli = adapter(brand);
      return liveReaderFor(
        source,
        ownedReporter(brand, generation),
        cli ? configuredPath(cli) : undefined
      );
    },
    retryAt: signInRetryAt,
    sessions: () => ownedSessions(vscode.env.sessionId),
    now: Date.now,
    log,
    brands: async () => {
      for (const brand of BRANDS) {
        const cli = adapter(brand);
        if (cli?.account)
          await signInFor(brand, cli.account, { now: Date.now(), override: configuredPath(cli) });
      }
      const brands: BrandUsage[] = [];
      for (const { brand, source, generation } of await known()) {
        const cli = adapter(brand);
        if (!cli) continue;
        const override = configuredPath(cli);
        brands.push({
          brand,
          generation,
          signedIn: true,
          source: {
            ...source,
            read: async (_override, options) => {
              const live = ownedReporter(brand, generation);
              if (live) await options?.remember?.([]);
              const controller = new AbortController();
              const signal = options?.signal
                ? AbortSignal.any([options.signal, controller.signal])
                : controller.signal;
              let timer: NodeJS.Timeout | undefined;
              try {
                const answer = live
                  ? await Promise.race([
                      live.read(signal).catch(() => undefined),
                      new Promise<undefined>((resolve) => {
                        timer = setTimeout(() => {
                          controller.abort();
                          resolve(undefined);
                        }, 10_000);
                      })
                    ])
                  : undefined;
                if (answer) return answer;
              } finally {
                clearTimeout(timer);
              }
              return source.read(override, options);
            }
          }
        });
      }
      return brands;
    }
  });
}
