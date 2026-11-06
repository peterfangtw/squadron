import * as platform from '../platform';
import * as fs from 'fs/promises';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { SETTINGS_FILE } from '../paths';

/**
 * Removes the hooks earlier builds installed in the user's
 * `~/.claude/settings.json` — the one place the extension writes into a file
 * the user owns, so the contract is narrow: remove only our entries (identified
 * by the script they run), and never touch another hook, the `statusLine`, or
 * any top-level key.
 *
 * That contract is enforced by *editing the text*, never by round-tripping the
 * document through `JSON.parse`/`JSON.stringify`. A round-trip rewrites the
 * whole file, which drops the user's comments and reflows every line they
 * formatted by hand — and on a file with comments in it, `JSON.parse` threw, so
 * the old fallback started from `{}` and the write replaced their settings
 * outright. `jsonc-parser` reads what the CLI reads (comments, trailing commas)
 * and `modify` returns the minimal edit for one path, so a file that is not
 * ours in shape stays exactly as it was everywhere we did not touch.
 *
 * No `vscode` import — plain fs and text, so it is tested headlessly.
 */

/**
 * Scripts this extension once installed and no longer does, removed from every
 * machine on every activation.
 *
 * Unconditional, and not merely "no longer installed": the entry lives in the
 * user's own `~/.claude/settings.json`, so a build that simply stops writing it
 * leaves it firing on every tool call, at a directory the host has since
 * deleted. With nothing of ours there, this costs one read on activation.
 *
 * The one place an old product name is load-bearing. `agentsview-dialog-hook.sh`
 * read a pending `AskUserQuestion` off disk. `squadron-hook.sh` was rich status:
 * a card's tool and a prompt the session file had not caught up with, for
 * sessions typed into a terminal — which no longer get a card — and
 * `agentsview-hook.sh` is the same script under the name it had before the
 * product became Squadron.
 */
export const RETIRED_SCRIPTS: readonly string[] = [
  'agentsview-dialog-hook.sh',
  'agentsview-hook.sh',
  'squadron-hook.sh'
];

type HookEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/**
 * Which commands in one entry run one of our scripts, matched on the file name
 * rather than the command install wrote. The path in that command carries both the
 * install location and the version (`…/<publisher>.squadron-<version>/bin/…`), so an
 * exact match cannot see an entry left by a dev host, or by the version this one
 * replaced — whose directory the host has already deleted, leaving a hook that
 * fails to open on every tool call.
 *
 * The cost is that we claim a command running a file of this name that we did
 * not write, and remove it. That is the deliberate edge of the narrow contract
 * above: still nothing outside `hooks`, still nothing that does not name one of
 * our scripts.
 */
function ourCommands(entry: unknown, scripts: readonly string[]): number[] {
  const hooks = (entry as HookEntry)?.hooks;
  // Anchored on the separator, so a script name does not swallow a longer name
  // ending in it — `agentsview-hook.sh` inside `agentsview-dialog-hook.sh`.
  return Array.isArray(hooks)
    ? hooks.flatMap((h, j) =>
        scripts.some((s) => h?.command?.endsWith(`/${s}`) === true) ? [j] : []
      )
    : [];
}

/**
 * The document as the CLI itself reads it — comments and trailing commas and
 * all. `undefined` means **do not write**: a file broken past what jsonc
 * tolerates, or one whose root is not an object, is left alone rather than
 * replaced with a sane one. A stale hook we could not remove fails on its own;
 * overwriting the settings of a user who fat-fingered a brace is not
 * recoverable.
 */
function parseSettings(raw: string): Record<string, unknown> | undefined {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length) {
    return undefined;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** One path deleted, as the minimal edit. No formatting options: a removal
 *  inserts nothing, so nothing of the user's is reflowed around it. */
function remove(text: string, jsonPath: (string | number)[]): string {
  return applyEdits(text, modify(text, jsonPath, undefined, {}));
}

/**
 * Remove every command running one of `scripts`, each deleted where it stands
 * so a comment or hand formatting beside it survives. A group left with none of
 * the user's commands goes whole; one that also holds theirs — the CLI's
 * `/hooks` menu can add to a group whose matcher fits — keeps them. An event
 * left empty is dropped, and so is a `hooks` object left empty, so a file that
 * had no hooks before ours is restored. A file with nothing of ours in it is
 * never written, which is the case on nearly every activation.
 */
export async function uninstallHooks(
  scripts: readonly string[] = RETIRED_SCRIPTS,
  file = SETTINGS_FILE
): Promise<void> {
  const raw = await fs.readFile(file, 'utf8').catch(() => undefined);
  const hooks = raw === undefined ? undefined : parseSettings(raw)?.hooks;
  if (raw === undefined || !hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return;
  }
  const events = hooks as Record<string, unknown>;
  const plan = new Map<string, { paths: (string | number)[][]; emptied: boolean }>();
  for (const [event, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) continue;
    const paths: (string | number)[][] = [];
    let whole = 0;
    // Highest first, so each index still names what it was read as.
    for (let i = entries.length - 1; i >= 0; i--) {
      const at = ourCommands(entries[i], scripts);
      if (at.length === 0) continue;
      if (at.length === (entries[i] as HookEntry).hooks?.length) {
        paths.push(['hooks', event, i]);
        whole++;
      } else {
        for (const j of at.reverse()) paths.push(['hooks', event, i, 'hooks', j]);
      }
    }
    if (paths.length) plan.set(event, { paths, emptied: whole === entries.length });
  }
  if (plan.size === 0) {
    return;
  }

  let text = raw;
  if (Object.keys(events).every((event) => plan.get(event)?.emptied)) {
    text = remove(text, ['hooks']);
  } else {
    for (const [event, { paths, emptied }] of plan) {
      if (emptied) {
        text = remove(text, ['hooks', event]);
      } else {
        for (const at of paths) text = remove(text, at);
      }
    }
  }
  // Through the link rather than over it: a dotfile manager's symlinked
  // settings stay a symlink. Temp file + rename, so the CLI never reads half.
  const real = await fs.realpath(file);
  const tmp = `${real}.squadron.tmp`;
  await fs.writeFile(tmp, text);
  await platform.files.replace(tmp, real);
}
