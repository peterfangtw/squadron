/**
 * Whether anyone can see this panel, for everything that must not draw into a
 * document nobody is looking at: the board's 1 s beat, the warm cue's CSS
 * motion, and the mascot.
 */

/**
 * Whether the host says this panel is on screen. True until told otherwise: a
 * fresh document is a visible one, because `retainContextWhenHidden` means a
 * hidden panel is never rebuilt.
 *
 * The document cannot answer this for itself — see `VisibleMessage` in
 * `protocol.d.ts` for why the two halves of "nobody is looking" live on
 * opposite sides of the wire.
 */
let onScreen = true;

const watchers = new Set<() => void>();

/**
 * Two signals: panel.visible goes false behind a tab but stays true under a
 * minimized window; visibilityState does the reverse with retainContextWhenHidden.
 * The document-only gate was measured never firing behind a tab: 101s hidden,
 * with this beat still running 60 times a minute (TASK_done_panel_repaint_cost.md).
 */
export function visible(): boolean {
  return onScreen && document.visibilityState !== 'hidden';
}

/** The host's half, from its `visible` message. */
export function setOnScreen(value: boolean): void {
  onScreen = value;
  for (const watcher of watchers) watcher();
}

/** Called whenever either half changes. Returns the unsubscribe. */
export function watchVisibility(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

document.addEventListener('visibilitychange', () => {
  for (const watcher of watchers) watcher();
});
