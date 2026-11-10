/**
 * The one rule for comparing ticket selection tokens. The store issues them
 * (`TicketStore.identity`), the status ships one, and every selection-scoped
 * post echoes it. A leaf with no imports, so the webview bundle takes it.
 */

/** Whether two tokens name the same selection. */
export function sameToken(a: TicketSelectionToken, b: TicketSelectionToken): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.generation === b.generation &&
    a.selectionSeq === b.selectionSeq &&
    a.scopeId === b.scopeId
  );
}

/** Whether `a` was issued after `b`: a later connection generation, or a later pick in one. */
export function newer(a: TicketSelectionToken, b: TicketSelectionToken): boolean {
  return (
    a.generation > b.generation ||
    (a.generation === b.generation && a.selectionSeq > b.selectionSeq)
  );
}
