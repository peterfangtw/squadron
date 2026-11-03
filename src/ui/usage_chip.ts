/**
 * Which usage slots to paint, and which signed-in account the chip shows.
 * vscode-free so pin and freeze can be tested without a panel.
 */

/**
 * The windows to paint, in the order the reading states them.
 *
 * There is no policy left here. A brand says which windows it has and what to
 * call them, and a window with no `pct` draws a dash — so a slot that used to be
 * "this brand has no 5h limit" is now simply a window the brand never listed,
 * and a brand that adds one is a longer array rather than a new case.
 */
export function usageSlots(usage: UsageView | undefined): UsageWindow[] {
  return usage?.windows ?? [];
}

export type UsageAccount = { brand: string; state: string };

/**
 * Which signed-in row the chip paints. A turn-end pin wins until the next one.
 * Frozen holds `currentBrand` so a hover or open menu does not swap under the
 * pointer. No pin yet is the first signed-in row.
 */
export function pickUsageAccount<T extends UsageAccount>(
  rows: readonly T[],
  opts: {
    pin?: string;
    frozen?: boolean;
    currentBrand?: string;
  } = {}
): T | undefined {
  const live = rows.filter((row) => row.state === 'signed_in');
  const want = opts.frozen ? opts.currentBrand : opts.pin;
  return live.find((row) => row.brand === want) ?? live[0];
}
