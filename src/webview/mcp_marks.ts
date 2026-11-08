/**
 * Brand marks for the MCP servers we recognise, keyed by the host of the url —
 * and Linear's once more for the tickets opener and the tickets dock's head,
 * which are the same vendor reached over its own API rather than over MCP.
 *
 * **The host, never the name.** A server's name is whatever the reader typed
 * into `~/.claude.json` — `slack`, `slack-work`, `work` — while the url is the
 * vendor's own. `mcp.linear.app` and `mcp.slack.com` are the two observed in a
 * real config; anything else keeps the bare dot, which is what an MCP server
 * with no brand to draw has always been.
 *
 * Inlined for the same reason `accounts.ts` inlines the CLI marks: the panel's
 * CSP is `img-src data:` with no host for extension media, so nothing under
 * `media/` can be read at runtime. **Every path below is a copy of a file
 * there** — `logo_slack.svg`, `logo_linear_{light,dark}.svg`, which
 * `package.json`'s `files` leaves out of the VSIX. Re-copy rather than editing
 * a `d=` here, or the file that documents the mark stops describing what
 * ships.
 */

import { el } from './dom';

/**
 * media/logo_slack.svg. Fixed colours both themes — the mark is one Slack
 * publishes for light and dark alike. Cropped viewBox: the source pads the
 * glyph to 270 square, which at 21px leaves it half the size of every other
 * mark in the popover. Exported for the messenger list (`messenger_marks.ts`),
 * so the one copy of the path stays here.
 */
export const SLACK_MARK =
  `<svg class="bm sl" viewBox="68 68 134 134" aria-hidden="true">` +
  `<path fill="#E01E5A" d="M99.4,151.2c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9h12.9V151.2z"/>` +
  `<path fill="#E01E5A" d="M105.9,151.2c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9v32.3c0,7.1-5.8,12.9-12.9,12.9s-12.9-5.8-12.9-12.9V151.2z"/>` +
  `<path fill="#36C5F0" d="M118.8,99.4c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9v12.9H118.8z"/>` +
  `<path fill="#36C5F0" d="M118.8,105.9c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9H86.5c-7.1,0-12.9-5.8-12.9-12.9s5.8-12.9,12.9-12.9H118.8z"/>` +
  `<path fill="#2EB67D" d="M170.6,118.8c0-7.1,5.8-12.9,12.9-12.9c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9h-12.9V118.8z"/>` +
  `<path fill="#2EB67D" d="M164.1,118.8c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9V86.5c0-7.1,5.8-12.9,12.9-12.9c7.1,0,12.9,5.8,12.9,12.9V118.8z"/>` +
  `<path fill="#ECB22E" d="M151.2,170.6c7.1,0,12.9,5.8,12.9,12.9c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9v-12.9H151.2z"/>` +
  `<path fill="#ECB22E" d="M151.2,164.1c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9h32.3c7.1,0,12.9,5.8,12.9,12.9c0,7.1-5.8,12.9-12.9,12.9H151.2z"/>` +
  `</svg>`;

/**
 * media/logo_linear_{light,dark}.svg — one path, two brand fills, and the file
 * name is the mark colour, exactly as the Grok pair is. Dual groups rather than
 * `currentColor`: `#222326` is the hex Linear ships, and `--av-fg` is not it.
 */
const LINEAR_PATH =
  'M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z';
const LINEAR_MARK =
  `<svg class="bm ln" viewBox="0 0 100 100" aria-hidden="true">` +
  `<path class="on-dark" fill="#fff" d="${LINEAR_PATH}"/>` +
  `<path class="on-light" fill="#222326" d="${LINEAR_PATH}"/>` +
  `</svg>`;

/** Longest suffix wins nothing here — one entry per vendor, matched whole. */
const MARKS: Record<string, string> = {
  'mcp.slack.com': SLACK_MARK,
  'mcp.linear.app': LINEAR_MARK
};

/**
 * The mark for a server's host, or nothing — the row then draws the dot alone,
 * which is every server we do not have an asset for.
 */
export function mcpMark(host: string): HTMLElement | undefined {
  const svg = MARKS[host.toLowerCase()];
  if (!svg) return undefined;
  // Its own wrapper class, not the accounts rows' `.bmwrap`: that one is sized
  // and grid-placed as a direct child of `.acct`, and this sits one level in.
  const wrap = el('span', 'mcpmark');
  wrap.innerHTML = svg;
  return wrap;
}

/** Linear's mark for the tickets surfaces, which no host keys. */
export function linearMark(): HTMLElement {
  const wrap = el('span', 'tmark');
  wrap.innerHTML = LINEAR_MARK;
  return wrap;
}

export function githubMark(): HTMLElement {
  const wrap = el('span', 'tmark');
  wrap.innerHTML =
    '<svg aria-hidden="true" fill="currentColor" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg>';
  return wrap;
}
