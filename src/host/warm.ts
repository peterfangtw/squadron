import * as vscode from 'vscode';
import type * as reconcile from '../core/reconcile';
import { CacheWarmer } from '../core/warmer';
import { ownedSession, ownedSessions, readWarmPolicy, setWarm, setWarmFailure } from './sessions';

/** The cache warmer on this window's registry and settings. */
export function cacheWarmer(
  runtime: reconcile.Reconciler,
  log: (line: string) => void
): CacheWarmer {
  return new CacheWarmer(runtime, {
    sessions: () => ownedSessions(vscode.env.sessionId),
    handle: ownedSession,
    policy: readWarmPolicy,
    setWarm,
    setWarmFailure,
    log
  });
}
