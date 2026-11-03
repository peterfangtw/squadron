/**
 * Every theme the panel can paint. A leaf so the picker and the folder store
 * name the same set without either importing the other.
 */
export const THEME_NAMES = [
  'follow',
  'ink',
  'lift',
  'paper',
  'neon',
  'polaroid',
  'mario',
  'nightcity',
  'arasaka',
  'malachite'
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value);
}
