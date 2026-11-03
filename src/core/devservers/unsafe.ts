/**
 * Whether a port is one a dev server should never be offered on, and why.
 *
 * A leaf with no imports, because the webview bundle takes it: the servers
 * sheet's tiles and typed field, and `ui/server_sheet.ts`'s default, all decide
 * by it, and the webview may import only leaf `core`. The host does not enforce
 * it — `runServerHere` boots what it is sent.
 *
 * Advice about a number, never a fact about this machine: a port that passes
 * here still faces the bind test (`ports.ts`), and is asked after this.
 */

/**
 * Ports a browser refuses with `ERR_UNSAFE_PORT`, above the root floor — every
 * other entry upstream is below 1024. A server boots and probes green on one
 * and cannot be opened. Checked 2026-11-03 against the Fetch spec's bad-port
 * table, Firefox's `gBadPortList` and Chromium's `kRestrictedPorts`. Chromium
 * omits 4190 and 6679; the spec and Firefox refuse them, so both are here.
 *
 * AirPlay Receiver's 5000 and 7000 are absent on purpose: they are taken only
 * while that feature is on, and a port actually held fails the bind test.
 */
const BROWSER_REFUSED = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080
]);

/** Binding below it needs root. */
const ROOT_CEILING = 1024;
/** The ephemeral range: the kernel hands these out, so a pick races it. The
 *  same floor as `ui/server_views.ts`'s `EPHEMERAL_FLOOR`. */
const EPHEMERAL_FLOOR = 49152;

/** The reason, in the words the sheet prints, or `undefined` for a port that
 *  passes. Range and integer checks are the caller's. */
export function unsafePort(port: number): string | undefined {
  if (port < ROOT_CEILING) return 'needs root';
  if (port >= EPHEMERAL_FLOOR) return 'the OS hands these out';
  if (BROWSER_REFUSED.has(port)) return 'browsers refuse it';
  return undefined;
}
