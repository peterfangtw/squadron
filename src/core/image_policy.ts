/**
 * The CLI checks an image's extension, then silently drops bytes it cannot
 * decode. Refuse unsupported media rather than renaming it and hoping.
 * Observed CLI behavior: docs/reference/cli_state/claude/retired.md.
 */
export const FORMATS = [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp']
] as const;

export const MAX_BYTES = 10 * 1024 * 1024;
