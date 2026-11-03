import * as vscode from 'vscode';
import { asTyped } from '../ui/text';

/**
 * Markdown for the chat dock, rendered by the host's own preview engine
 * (`markdown-language-features`). Its output already carries `hljs-*` spans,
 * so syntax colouring costs nothing but a stylesheet — no bundled renderer.
 *
 * A host without that engine falls back to escaped plain text: the dock loses
 * formatting, never content.
 */

const COMMAND = 'markdown.api.render';

/**
 * The same turns re-render on every poll, and rendering is pure. Unbounded:
 * only the last hundred turns of a session are ever read, so it grows with
 * turns actually looked at. Module-scoped, so it outlives any one panel —
 * closing and reopening reuses it, and only the extension host going down
 * clears it.
 *
 * That bound is what `remember` exists to protect. A message still being
 * written is a different string every poll — a hundred of them across a turn
 * that runs five minutes, none ever asked for twice — so it would grow this map
 * with the clock rather than with the conversation, and never hit.
 */
const cache = new Map<string, string>();

/**
 * Calling the command is also how it is tested for: it is an activation event
 * and not a contributed command, so it is absent from `getCommands` until the
 * engine wakes — and asking first would answer "no" on a cold panel and leave
 * the dock in plain text for the rest of the session.
 */
export async function render(text: string, remember = true): Promise<string> {
  const hit = remember ? cache.get(text) : undefined;
  if (hit !== undefined) {
    return hit;
  }

  let html: string;
  try {
    // Leading newline: the engine strips YAML front matter, so a turn opening
    // with `---` would lose everything up to its closing `---`. Off position 0
    // there is no front matter to find, and a blank first line renders as
    // nothing.
    html = (await vscode.commands.executeCommand<string>(COMMAND, `\n${text}`)) || asTyped(text);
  } catch {
    html = asTyped(text);
  }

  if (remember) {
    cache.set(text, html);
  }
  return html;
}
