/**
 * An http(s) URL the host may hand to `openExternal`, or nothing.
 *
 * `vscode.env.openExternal` honours `command:` and `vscode:` (and any other
 * scheme the IDE has registered). The three wire verbs that round-trip a URL
 * through the webview — `openTicket`, `openServer`, `openLoginUrl` — all have
 * to refuse those, and a parse that throws is a refuse, not a crash. One body,
 * so the two polarities and the unwrapped parses cannot drift apart again.
 *
 * WHATWG `URL`, not `vscode.Uri.parse`: this module is vscode-free, and a
 * throw is how an unparseable string is refused.
 */
export function webUri(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url;
}
