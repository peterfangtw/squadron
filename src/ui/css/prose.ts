/** The prose input (webview/prose.ts), wherever a box mounts it. */

export const css = /* css */ `
  /* The prose input's own sheet. TipTap's injected style is off (injectCSS:
     false), so the first block is ProseMirror's required CSS, as TipTap 3.30.5
     ships it, with the gap cursor painted off our foreground instead of black.
     A surface that mounts the editor sizes and borders its host; nothing here
     does. */
  .prose .ProseMirror { position: relative; outline: none;
    word-wrap: break-word; white-space: pre-wrap; white-space: break-spaces;
    -webkit-font-variant-ligatures: none; font-variant-ligatures: none;
    font-feature-settings: "liga" 0; }
  .prose .ProseMirror [contenteditable="false"] { white-space: normal; }
  .prose .ProseMirror [contenteditable="false"] [contenteditable="true"] { white-space: pre-wrap; }
  .prose .ProseMirror pre { white-space: pre-wrap; }
  .prose img.ProseMirror-separator { display: inline !important; border: none !important;
    margin: 0 !important; width: 0 !important; height: 0 !important; }
  .prose .ProseMirror-gapcursor { display: none; pointer-events: none; position: absolute; margin: 0; }
  .prose .ProseMirror-gapcursor::after { content: ""; display: block; position: absolute;
    top: -2px; width: 20px; border-top: 1px solid var(--av-fg);
    animation: prose-gapcursor 1.1s steps(2, start) infinite; }
  @keyframes prose-gapcursor { to { visibility: hidden; } }
  .prose .ProseMirror-focused .ProseMirror-gapcursor { display: block; }
  .prose .ProseMirror-hideselection *::selection { background: transparent; }
  .prose .ProseMirror-hideselection * { caret-color: transparent; }

  /* The placeholder rides the empty first paragraph as data-placeholder
     (TipTap's Placeholder), at the panel's placeholder rank (base.ts). */
  .prose .is-editor-empty:first-child::before { content: attr(data-placeholder);
    float: left; height: 0; pointer-events: none; color: var(--av-fg-3); }

  /* Plain mode is a paragraph per line, so a paragraph has no margin. */
  .prose p { margin: 0; }

  /* Rich mode draws the formatting set the way a turn's body does
     (chat.ts, .body), so what is typed looks like what the dock shows once
     it is sent. A paragraph break is a blank line in the markdown, so it gets
     a gap; a list item's own paragraph does not. */
  .prose[data-prose="rich"] :is(ul, ol, pre, blockquote) { margin: 0; }
  .prose[data-prose="rich"] :is(.ProseMirror, blockquote) > * + * { margin-top: 6px; }
  .prose[data-prose="rich"] :is(ul, ol) { padding-left: 20px; }
  .prose[data-prose="rich"] li { margin: 2px 0; }
  .prose[data-prose="rich"] blockquote { position: relative; margin-left: 0; margin-right: 0;
    padding-left: 12px; background: none; }
  .prose[data-prose="rich"] blockquote::before { content: ''; position: absolute; left: 0;
    top: 0; bottom: 0; width: 4px; border-radius: 2px; background: var(--av-fg-3); }
  .prose[data-prose="rich"] code { font-family: var(--vscode-editor-font-family);
    font-size: var(--av-fs-lg); color: var(--av-code-fg); background: none; padding: 0; }
  .prose[data-prose="rich"] pre { background: var(--av-code-bg); border-radius: 4px;
    border: 1px solid var(--av-border); padding: 8px 10px; }
  .prose[data-prose="rich"] pre code { color: var(--av-fg); }

  /* A chip: one atom showing its label, in the colour its kind wears as a
     .sref in the dock (chat.ts). */
  .prose .pchip { padding: 0 4px; border-radius: 4px; white-space: nowrap;
    background: color-mix(in srgb, var(--av-link) 24%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-link) 60%, transparent); }
  .prose .pchip.image { background: color-mix(in srgb, var(--av-purple) 24%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-purple) 60%, transparent); }
  /* A skill is not a file and must not read as one: a file chip stands for a
     path the session will open, a skill chip for instructions it will load. */
  .prose .pchip.skill { background: color-mix(in srgb, var(--av-green) 24%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-green) 60%, transparent); }
  .prose .pchip.session { background: color-mix(in srgb, var(--av-yellow) 24%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-yellow) 60%, transparent); }
  /* A model, in the grey of the composer's own model control and no accent:
     blue, purple, green and yellow each already name a kind of chip, and
     --av-orange equals --av-yellow in mario, so an orange one would read as a
     session there. */
  .prose .pchip.model { background: color-mix(in srgb, var(--av-fg-3) 18%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-fg-3) 50%, transparent); }
  .prose .pchip.ProseMirror-selectednode { outline: 1px solid var(--av-focus); }
`;
