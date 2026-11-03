/** Where a brand's binary is, as this window's settings name it. */

import * as vscode from 'vscode';
import { adapterFor } from '../core/adapter';
import type { CliAdapter } from '../core/adapter';
import type { Session } from '../core/model';

/**
 * The path override a brand's own setting holds, or `undefined` for both "this
 * brand declares no setting" and "nobody has filled it in".
 *
 * The adapter names the setting its own path lives in, so this reads one for
 * whichever brand it is given without knowing which brands exist. Every caller
 * that hands an override to a `CliAdapter` port goes through here — a second
 * spelling is a second brand list to keep.
 *
 * An unset setting reads as `''`, which is folded to `undefined` here rather
 * than at each caller: `core/bin.ts` takes the override as a refusal, not a
 * hint, and only decides that after `trim()` — so the blank never meant
 * anything, and one caller forgetting to fold it would look like a path.
 */
export function configuredPath(
  cli: Pick<CliAdapter, 'pathSetting'> | undefined
): string | undefined {
  if (!cli?.pathSetting) return undefined;
  return (
    vscode.workspace.getConfiguration('squadron').get<string>(cli.pathSetting, '') || undefined
  );
}

/** The settings box for a brand's binary path, filtered to that one key. A path
 *  set there forces a sign-in ask (`onDidChangeConfiguration` → `forceAuth`),
 *  so the accounts row follows on the next pass. */
export function openPathSetting(cli: Pick<CliAdapter, 'pathSetting'> | undefined): void {
  if (!cli?.pathSetting) return;
  void vscode.commands.executeCommand(
    'workbench.action.openSettings',
    `squadron.${cli.pathSetting}`
  );
}

/** The same, for the callers that hold a session rather than an adapter. */
export function configuredPathFor(session: Pick<Session, 'brand'>): string | undefined {
  return configuredPath(adapterFor(session));
}
