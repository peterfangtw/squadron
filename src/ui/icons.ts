/**
 * Lucide icons (ISC, lucide.dev), inlined as path data.
 *
 * The panel is a webview with no bundler and a CSP that blocks every external
 * host, so the React package and any CDN are both out. For a handful of icons,
 * copying the paths is cheaper than a dependency plus a copy step. If this
 * grows past a dozen, switch to `lucide-static` and ship the SVGs as assets.
 */
const PATHS = {
  x: ['M18 6 6 18', 'm6 6 12 12'],
  sliders: [
    'M4 7h3m4 0h9M4 17h9m4 0h3',
    'M9 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
    'M15 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4'
  ],
  terminal: [
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2',
    'm7 9 3 3-3 3m6 0h4'
  ],
  users: [
    'M9 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    'M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2'
  ],
  cpu: [
    'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2',
    'M9 9h6v6H9zM9 3v3m6-3v3m3 3h3m-3 6h3M9 18v3m6-3v3M3 9h3m-3 6h3'
  ],
  palette: [
    'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h3a3 3 0 0 0 3-3 9 9 0 0 0-9-7Z',
    'M7.5 9h.01M11 6.5h.01M15.5 8h.01'
  ],
  notes: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z', 'M14 3v6h6M8 13h8m-8 4h6'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v6m0-10v.01'],
  // Lucide `flag`. The Report tab, distinct from `notes` (Changelog) and `info` (About).
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  external: ['M14 3h7v7m0-7L10 14m0-10H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5'],
  enter: ['M20 4v7a4 4 0 0 1-4 4H4', 'm9 10-5 5 5 5'],
  plus: ['M5 12h14', 'M12 5v14'],
  arrowLeftToLine: ['M3 19V5', 'm9 6-6 6 6 6', 'M6 12h15'],
  // Lucide `trash-2`: removes a wire, where a × read as close.
  trash: [
    'M10 11v6',
    'M14 11v6',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M3 6h18',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
  ],
  // Lucide `pencil` and `copy`: a workflow row's Edit and Duplicate.
  pencil: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4'
  ],
  copy: [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'
  ],
  stop: ['M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.77.04'],
  // The CLI's own stop-the-turn affordance, and distinct from `stop` above,
  // which ends the session.
  square: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2'],
  // Circle drawn as two half-arcs, since the helper emits <path> only.
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7v5l3 2'],
  // The two chain links every browser and editor already spells "copy a
  // reference to this thing", which is why it is that glyph and not a clipboard.
  link: [
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'
  ],
  // The clip every message box on the machine already spells "attach a file".
  paperclip: [
    'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'
  ],
  // A file the turn wrote, by what kind of file it is. Lucide `image` and
  // `code-xml`, both re-cut as paths — the helper below emits <path> only, so
  // `image`'s rect and circle are drawn rather than borrowed.
  image: [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2',
    'M9 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
    'm21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21'
  ],
  code: ['m18 16 4-4-4-4', 'm6 8-4 4 4 4', 'm14.5 4-5 16'],
  // The composer's formatting toolbar: lucide `bold`, `italic`,
  // `strikethrough`, `list`, `list-ordered`, `text-quote` and `square-code`;
  // inline code is `code` above.
  bold: ['M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8'],
  italic: ['M19 4h-9', 'M14 20H5', 'M15 4 9 20'],
  strike: ['M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', 'M4 12h16'],
  bulletList: ['M3 12h.01', 'M3 18h.01', 'M3 6h.01', 'M8 12h13', 'M8 18h13', 'M8 6h13'],
  orderedList: [
    'M10 12h11',
    'M10 18h11',
    'M10 6h11',
    'M4 10h2',
    'M4 6h1v4',
    'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'
  ],
  blockquote: ['M17 6H3', 'M21 12H8', 'M21 18H8', 'M3 12v6'],
  codeBlock: [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2',
    'm10 9-3 3 3 3',
    'm14 15 3-3-3-3'
  ],
  // Not lucide's — it has no markdown glyph, and the one every renderer on the
  // machine draws is the two letters in a box. Cut for 13px: the letters stand
  // 8 of 24 units tall so their strokes still separate at that size, which is
  // also why the box is the flat rectangle rather than `image`'s rounded one.
  md: [
    'M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1',
    'M5 16V8l3.25 4L11.5 8v8',
    'M14 16V8h2a4 4 0 0 1 0 8h-2'
  ],
  refresh: [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
    'M8 16H3v5'
  ],
  keyRound: [
    'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z',
    'M16.5 7a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1'
  ],
  // The warm control's mark: a cache kept alight.
  flame: [
    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z'
  ],
  // The gear's centre circle is a path too, since the helper emits <path> only.
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'
  ],
  // Lucide `arrow-up`. The composer's send button; the verb is its accessible name.
  arrowUp: ['m5 12 7-7 7 7', 'M12 19V5']
  // Left unannotated on purpose: the key type is the icon list, so a name that
  // does not exist is a build error rather than a blank square.
};

type IconName = keyof typeof PATHS;

/** Inline SVG markup, sized in ems so it tracks the surrounding text. */
export function icon(name: IconName, size = 14): string {
  const paths = PATHS[name].map((d) => `<path d="${d}"/>`).join('');
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

/**
 * Which glyph a written file wears, or nothing when its extension says nothing
 * — the caller keeps its own plain outline for that, so an unknown kind reads
 * as a file rather than as a wrong guess about one.
 *
 * Extension only. The bytes are on the host's disk and the pill is drawn in the
 * webview from a path the CLI wrote, so a sniff would be a round trip per pill
 * per turn to correct the handful of files that lie about their name.
 */
const KINDS: Record<string, IconName> = {};
for (const [name, exts] of Object.entries({
  code:
    'ts tsx js jsx mjs cjs json jsonc py rb rs go java kt swift c h cpp hpp cc cs php ' +
    'sh bash zsh fish sql html css scss sass less vue svelte astro toml yml yaml xml ' +
    'lua pl r scala dart ex exs gradle mjsx tsv graphql proto',
  image: 'png jpg jpeg gif webp svg bmp ico avif heic tiff',
  md: 'md markdown mdx'
})) {
  for (const ext of exts.split(' ')) KINDS[ext] = name as IconName;
}

export function iconForFile(path: string): IconName | null {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return (dot > 0 && KINDS[base.slice(dot + 1).toLowerCase()]) || null;
}
