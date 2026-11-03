/** The chick: the mascot over the board (`webview/mascot.ts`). */

export const css = /* css */ `
  /* One 48px box on its own layer, placed by transform only, so travel is
     the compositor's and costs the board no layout or repaint. Absolute in
     #board, which is position: relative.

     z-index 24: over the cards, the bar (12), the sheet's backdrop (22) and
     the sheet (23), so it can perch on an open sheet. Under the popovers at
     25 — a portalled .fmenu.floating and the accounts popover — and under
     the lightbox (26/27) and every dialog (#scrim 30 and up), so it never
     covers a menu or a question. 25 would tie with those menus and resolve
     by document order. */
  #mascot { position: absolute; left: 0; top: 0; z-index: 24;
            width: 48px; height: 48px; cursor: pointer;
            will-change: transform; }
  #mascot canvas { display: block; width: 48px; height: 48px;
                   image-rendering: pixelated; }
  /* Facing is a mirror of the same frames, not more art. */
  #mascot.left canvas { transform: scaleX(-1); }

  /* The tones, one probe each: the webview reads each probe's computed colour
     and paints the frames with it, so every preset repaints the chick. Copied
     from docs/mockups/lib/pixel.mjs's toneCss; the letters are its tones. */
  #mascot .tones { display: none; }
  /* A porcelain body on every preset: --av-fg drew it near-black on the light
     ones. The accent goes on the wings, bulb and belly light instead. */
  #mascot .t-w { color: #f5f5f7; }
  #mascot .t-v { color: #d9dbe0; }
  #mascot .t-g { color: var(--av-focus); }
  #mascot .t-d { color: color-mix(in srgb, var(--av-focus) 55%, #333); }
  #mascot .t-o { color: color-mix(in srgb, var(--av-red) 55%, var(--av-yellow)); }
  #mascot .t-e { color: #16161a; }
  #mascot .t-q { color: color-mix(in srgb, var(--av-fg) 25%, #fff); }
  #mascot .t-i { color: color-mix(in srgb, var(--av-yellow) 60%, var(--av-red)); }
  #mascot .t-t { color: var(--av-focus); }
  #mascot .t-y { color: var(--av-yellow); }
  #mascot .t-p { color: color-mix(in srgb, var(--av-red) 45%, var(--av-fg)); }
  #mascot .t-k { color: color-mix(in srgb, var(--av-focus) 22%, #141416); }
  /* The floor shadow; painted at a quarter alpha by the webview. */
  #mascot .t-h { color: var(--av-fg-3); }
`;
