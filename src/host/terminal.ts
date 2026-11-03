import * as vscode from 'vscode';
import { Runner, substitute } from '../core/devservers/runners';
import * as platform from '../core/platform';

/**
 * Terminal work that only the window owning the terminal can do: the dev
 * servers this window started.
 *
 * Nothing here touches a *session's* terminal any more. It used to write to
 * one — a message as a bracketed paste, an answer as paced digits, an interrupt
 * as `\x03`, all aimed at a TUI this project neither versions nor observes — and
 * then, for a while, only to reveal it. Both went with the card for a session
 * someone typed `claude` for (row 53): every session on the board runs on a
 * pipe, and a pipe has no terminal to find.
 *
 * **A dev server is the exception, and it is not a regression.** `startServer`
 * below creates a terminal and sends it one line. That is allowed for exactly
 * the reason the session rule forbids it: a dev server is not something with a
 * conversation to hijack. It is created, it is disposed, its output is the thing
 * the reader wants, and nothing is ever typed at it after the command that
 * started it. It is never `.show()`n either — the panel is the primary UI, and a
 * reveal steals focus.
 *
 * Kept apart from `control.ts`, which stays `vscode`-free.
 */

/**
 * The dev servers this window started, so a stop can dispose the right one.
 * Keyed the way the registry is — `cwd` and runner id — and dropped when the
 * terminal closes, however it closed: a person can kill a server by closing its
 * tab, and the row must not go on offering to stop something that is gone.
 */
const serverTerminals = new Map<
  string,
  { terminal: vscode.Terminal; cwd: string; runnerId: string }
>();

// The key is joined; the parts are kept whole beside it, because a `cwd` holds
// spaces and anything else a filesystem allows — so nothing here splits a key
// back apart to recover them.
const keyOf = (cwd: string, runnerId: string) => `${platform.paths.key(cwd)}\u0000${runnerId}`;

/**
 * Starts a dev server in its own terminal. Never `.show()` — see the note at
 * the top of this file.
 *
 * `PORT` is set as well as the command carrying its flag, since the two are not
 * redundant: an unknown toolchain has no measured flag and `PORT` is all it
 * gets, while Vite ignores `PORT` entirely and needs the flag. Setting both is
 * what makes one code path serve either (measured 2026-07-26).
 */
export function startServer(
  cwd: string,
  runner: Runner,
  port: number | undefined,
  branch: string,
  app?: string
): void {
  stopServer(cwd, runner.id);
  const terminal = vscode.window.createTerminal({
    cwd,
    // The branch, because that is what tells two of these apart in a tab strip:
    // every worktree of one repo runs the same command under a different name.
    // And the app after it in a monorepo, for the same reason one step down: two
    // apps of one branch would otherwise both be `dev · main`.
    name: app ? `dev · ${branch} · ${app}` : `dev · ${branch}`,
    env: port === undefined ? {} : { PORT: String(port) }
  });
  serverTerminals.set(keyOf(cwd, runner.id), { terminal, cwd, runnerId: runner.id });
  terminal.sendText(substitute(runner.command, port), true);
}

/** Disposes one this window started. A server it never held is already stopped. */
export function stopServer(cwd: string, runnerId: string): void {
  const key = keyOf(cwd, runnerId);
  serverTerminals.get(key)?.terminal.dispose();
  serverTerminals.delete(key);
}

/** Whether this window is the one holding that server's terminal. */
export function holdsServer(cwd: string, runnerId: string): boolean {
  return serverTerminals.has(keyOf(cwd, runnerId));
}

/**
 * Every server this window still holds, for the sweep a closing window owes the
 * registry — a record left behind holds a port in every other window's picker
 * until it goes stale.
 */
export function heldServers(): { cwd: string; runnerId: string }[] {
  return [...serverTerminals.values()].map(({ cwd, runnerId }) => ({ cwd, runnerId }));
}

/**
 * A terminal closed by hand is a server stopped by hand, and the registry has to
 * hear about it from the host rather than find out by disposing something that
 * is already gone.
 */
export function watchServerTerminals(
  onClosed: (cwd: string, runnerId: string) => void
): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((closed) => {
    for (const [key, held] of serverTerminals) {
      if (held.terminal === closed) {
        serverTerminals.delete(key);
        onClosed(held.cwd, held.runnerId);
      }
    }
  });
}
