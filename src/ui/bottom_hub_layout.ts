/** How many leading options fit beside More; the primary entry always stays. */
export function visibleOptions(
  widths: readonly number[],
  available: number,
  moreWidth: number,
  gap: number
): number {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total + Math.max(0, widths.length - 1) * gap <= available) return widths.length;
  let used = moreWidth;
  let visible = 0;
  for (const width of widths) {
    if (used + gap + width > available) break;
    used += gap + width;
    visible++;
  }
  return Math.min(widths.length, Math.max(1, visible));
}
