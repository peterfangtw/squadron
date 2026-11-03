/** Panel colour tokens, theme presets, and the body ground. First in the cascade. */

export const css = /* css */ `
  /* The panel's colour layer. Every token defaults to the host value it stands
     in for, so a body with no data-theme — "follow" — is the panel as it has
     always looked. A preset overrides these and nothing else, which is why the
     rules below name no --vscode- colour directly: one indirection is what
     lets the whole panel be re-coloured from one block.

     The three font *faces* are deliberately not in here: type is not a preset's
     to recolour. Neither is the scale below it, which a preset cannot reach —
     see the exemption in theme.test.ts. */
  :root {
    --av-dim: .55;
    --av-ghost: .35;
    --pulse-period: 1.5s;
    --board-dialog-top: 28px;
    /* The type scale: three sizes, from Material 2's. It replaced five names
       over four em fractions that differed by 2% and read as one size with a
       wobble — and where a step had no job, the name had no meaning either.
         lg 14  Body2, and the largest thing the panel draws. What is being
                read: a card's title, a question, a ticket, a group heading.
         md 12  Caption. What a surface says about itself, and every button.
         sm 10  Overline. Uppercase, letter-spaced captions and badges only —
                a floor, since that treatment stops being legible below it.
       Beware the old spelling: md used to be 14 and is now 12, so a rule
       copied out of a pre-rename commit lands one step too large.

       Absolute px, which is how the M2 scale is stated — so unlike the em
       fractions these replaced, the panel no longer grows with a reader who
       has scaled their editor up. That is a real loss and not yet paid back;
       rem off a stated root is the way back if it turns out to matter. */
    --av-fs-sm: 10px;
    --av-fs-md: 12px;
    --av-fs-lg: 14px;

    /* Behind the sheets, settings and onboarding. Never #scrim: the board stays
       readable under a dialog, whose session is one of several still running. */
    --sheet-blur: blur(4px);

    --av-bg: var(--vscode-editor-background);
    --av-card: var(--vscode-editorWidget-background);
    --av-border: var(--vscode-panel-border);
    --av-fg: var(--vscode-foreground);
    --av-muted: var(--vscode-descriptionForeground);
    /* The two dimmer ranks of body text. These used to be opacity on --av-fg,
       at nine values between .5 and .85 that no preset could reach and that dimmed
       the element rather than its text — an icon, a border and a badge fill all
       faded with the sentence they sat in. As colour they dim only what is being
       read, and a preset can tune them.
       Still opacity where the dimming is a *state* — hover, selection, disabled,
       the pulse — because those animate and toggle, which a colour cannot. */
    --av-fg-2: color-mix(in srgb, var(--av-fg) 78%, transparent);
    --av-fg-3: color-mix(in srgb, var(--av-fg) 55%, transparent);
    /* Elevation, which this panel has never had a vocabulary for: --av-bg is the
       ground, --av-card the one step up, and every shadow in the stylesheet was
       a hand-typed rgba(0,0,0,.35) no preset could reach. Two of the presets are
       light, where a black shadow under a white card is the wrong shadow rather
       than a weaker one. Spec: docs/mockups/dock-layers.delta.css.

       The raised surface is stated as a STEP rather than borrowed as a value:
       3.5% of the theme's own foreground mixed into its card. On a dark preset
       that is light going in, on a light one it is dark, and either way it
       moves — which --av-card cannot promise, because on "follow" it answers to
       whatever theme the reader installed and Dark Modern puts it one value off
       the ground (#202020 against #1f1f1f). The step per preset, computed:
       docs/mockups/dock-layers.html §4. */
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);   /* contact — 1-2px, no blur to speak of */
    --av-shadow-2: rgba(0, 0, 0, .40);   /* cast — a plane over another plane */
    --av-shadow-3: rgba(0, 0, 0, .55);   /* floating — over both of the above */
    /* One hairline of the light's own colour along a raised box's top edge is
       what makes it read as lit from above rather than as a rectangle with a
       border — the cheapest depth cue there is. */
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: var(--vscode-charts-blue);
    /* Not --vscode-charts-orange, which is the one chart colour that is not a
       colour: it registers as an alias of minimap.findMatchHighlight, which
       aliases editor.findMatchHighlightBackground, whose default is #EA5C0055
       — a 33%-alpha find highlight, in both the dark and the light stock
       themes, and overridden by neither. Every mix of it was therefore a third
       of what it said (16% of amber came out 5.3% at α .89, so the surface was
       see-through) and every label in it was unreadable: .qact.go measured
       1.58:1 on Dark Modern. The warning border is the host's own opaque
       amber, and is already the exact value all four presets spell here.
       Measured, and the 50 sites that spend this token:
       docs/mockups/amber-token-scope.html. */
    --av-orange: var(--vscode-inputValidation-warningBorder, var(--vscode-charts-orange));
    --av-purple: var(--vscode-charts-purple);
    --av-green: var(--vscode-charts-green);
    --av-red: var(--vscode-charts-red);
    --av-yellow: var(--vscode-charts-yellow);
    /* **--av-focus is the same blue as --av-blue in ink, lift and paper, and
       that is deliberate. Do not "fix" it by recolouring a preset.**

       Written here because it has now been found twice as a bug and acted on
       twice. The reading is correct as far as it goes: a selected card wears
       this as a 2px ring and a glow, a *busy* card wears --av-blue on its rail,
       dot and state word, and in those three presets the two hexes are equal —
       so a selected idle card and a running one are one colour.

       The trade was made knowingly (1860284). Selection used to be --av-fg,
       which no status wears and which separates perfectly; it is white on the
       dark presets and near-black on paper, and that is precisely the problem —
       a ring the same neutral in every theme is a ring that kills what makes
       each theme look like itself. So the hue went back to the preset's own
       accent and **shape** was given the separating job instead: hover is a
       flat border, selected is the ring plus a 7px glow (blur kept under the
       grid's 10px gap so a lit card does not wash its neighbour), drop is
       dashed. A residual hue collision is the accepted cost of eight presets
       that read as eight themes.

       theme.test.ts therefore asserts the *shapes* and has no assertion that
       this token differs from --av-blue. There was one once, against --av-fg;
       it was deleted with the change above, which is what made this look
       unguarded rather than decided. If the collision ever does need answering,
       answer it in shape or in the glow — not by repainting a theme. */
    --av-focus: var(--vscode-focusBorder);
    --av-link: var(--vscode-textLink-foreground);
    --av-badge-bg: var(--vscode-badge-background);
    --av-badge-fg: var(--vscode-badge-foreground);
    --av-hover: var(--vscode-toolbar-hoverBackground);
    --av-list-hover: var(--vscode-list-hoverBackground, var(--vscode-textBlockQuote-background));
    --av-input-bg: var(--vscode-input-background);
    --av-input-fg: var(--vscode-input-foreground);
    --av-input-border: var(--vscode-input-border, var(--vscode-panel-border));
    --av-menu-bg: var(--vscode-dropdown-background);
    --av-menu-fg: var(--vscode-dropdown-foreground);
    --av-menu-border: var(--vscode-dropdown-border, var(--vscode-panel-border));
    --av-quote-bg: var(--vscode-textBlockQuote-background);
    --av-code-bg: var(--vscode-textCodeBlock-background);
    /* Inline code carries a colour of its own. Left to inherit, it is the
       body's white on a tint a few percent off the background, which reads as
       emphasis at best — the span has to be findable mid-sentence. Fenced
       blocks opt back out below: there hljs is doing the colouring. */
    --av-code-fg: var(--vscode-textPreformat-foreground, var(--av-hl-string));
    --av-btn-bg: var(--vscode-button-background);
    --av-btn-fg: var(--vscode-button-foreground);
    --av-warn-bg: var(--vscode-inputValidation-warningBackground);
    --av-warn-border: var(--vscode-inputValidation-warningBorder, var(--vscode-charts-orange));
    /* Text that lands *on* a filled accent, where the accent's own contrast
       decides the answer and the theme's foreground has no say. */
    --av-on-blue: #fff;
    --av-on-orange: #000;
    --av-on-purple: #fff;
    --av-on-green: #000;
    --av-on-red: #000;
    /* The four hljs tokens that carry most of a code block's colour. Dark
       values here, light ones on the host's own class below; a preset overrides
       both, which is why these are tokens rather than the rules they feed. */
    --av-hl-keyword: #569cd6;
    --av-hl-string: #d69d85;
    --av-hl-comment: #57a64a;
    --av-hl-number: #b8d7a3;
  }
  .vscode-light {
    /* The warning border above is #B89500 on a light host too — a pale ochre
       that measures 2.71:1 on the light card, so it can carry neither a
       boundary nor the labels this token is spent on. Same colour at 65% of
       every channel: one k, three channels, the hue unmoved, and the first
       step down its own ramp that clears 4.5:1 on the darkest surface an amber
       label is read on here (the outbox hover wash).

       And that amber carries white, not black — the departure the paper preset
       already makes and says so in its own comment. Left at #000 the three
       filled amber badges (.dtab .tb.warn, #chat-head.waiting .pill,
       .qopt.on .mark) measure 3.73:1.

       --av-warn-border takes the same step, and had to: it resolves through the
       same --vscode-inputValidation-warningBorder and is the *same colour* as
       --av-orange in all nine places either is declared. Fixing one and not the
       other split a single amber in two on a light host and left the six sites
       that spend warn-border as a *label* rather than a boundary — the two in
       css/composer.ts and four in css/bottom_drawer.ts — on the 2.71:1 value this
       comment already calls unreadable. The two tokens want collapsing into
       one; that edit reaches css/composer.ts, so it is a follow-up rather than
       this line. */
    --av-orange: #7d6500;
    --av-warn-border: #7d6500;
    --av-on-orange: #fff;
    /* Stock light charts green (#388A34): white is 4.33:1, black 4.85:1. */
    --av-on-green: #000;
    --av-on-red: #fff;
    --av-hl-keyword: #0000ff;
    --av-hl-string: #a31515;
    --av-hl-comment: #008000;
    --av-hl-number: inherit;
    /* The ninth case the delta's §4 table has no row for, and it fails as the
       two light presets do — why, on paper below. Not covered by theme.test.ts
       either: that loop reads body[data-theme=…] only, so a light host under
       "follow" would have taken a black cast under a white slab unguarded. */
    --av-lift: var(--av-card);
    --av-shadow-1: rgba(38, 34, 28, .10);
    --av-shadow-2: rgba(38, 34, 28, .16);
    --av-shadow-3: rgba(38, 34, 28, .24);
    --av-rim: transparent;
  }

  .vscode-high-contrast-light {
    /* Stock hcLight charts green/red are dark fills, unlike the dark host. */
    --av-on-green: #fff;
    --av-on-red: #fff;
  }

  /* The presets. Each declares the whole set — a token left out would resolve
     to the host's value and leave one surface, usually a menu or the composer,
     the wrong colour in an otherwise themed panel. A test in theme.test.ts is
     what keeps that honest.

     Selected on the body rather than the root because :root is where the host
     writes its own variables, and these have to win over .vscode-light. The
     host's defaults sit in an @layer, so no rule here needs to outweigh them. */

  /* Ink: the canvas drops to near-black so the card becomes a step of light,
     rather than the same grey with a border drawn round it. */
  body[data-theme="ink"] {
    --av-bg: #0a0a0b;
    --av-card: #151517;
    --av-border: #2a2a2f;
    --av-fg: #ededf0;
    --av-muted: #8b8b94;
    --av-fg-2: #b9b9c2;
    --av-fg-3: #8a8a93;
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);
    --av-shadow-2: rgba(0, 0, 0, .40);
    --av-shadow-3: rgba(0, 0, 0, .55);
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: #4c8dff;
    --av-orange: #e5a54b;
    --av-purple: #a97cf5;
    --av-green: #40c463;
    --av-red: #f0555f;
    --av-yellow: #e3c05c;
    --av-focus: #4c8dff;
    --av-link: #6aa8ff;
    --av-badge-bg: #2f2f35;
    --av-badge-fg: #ededf0;
    --av-hover: #ffffff14;
    --av-list-hover: #ffffff0f;
    --av-input-bg: #111113;
    --av-input-fg: #ededf0;
    --av-input-border: #33333a;
    --av-menu-bg: #17171a;
    --av-menu-fg: #ededf0;
    --av-menu-border: #33333a;
    --av-quote-bg: #17171b;
    --av-code-bg: #ffffff0f;
    --av-code-fg: #e8a87c;
    --av-btn-bg: #2563eb;
    --av-btn-fg: #ffffff;
    --av-warn-bg: #2b1f08;
    --av-warn-border: #e5a54b;
    --av-on-blue: #ffffff;
    --av-on-orange: #000000;
    --av-on-purple: #ffffff;
    --av-on-green: #000;
    --av-on-red: #000;
    --av-hl-keyword: #6aa8ff;
    --av-hl-string: #e0a57a;
    --av-hl-comment: #6a9955;
    --av-hl-number: #b5cea8;
  }

  /* Slate Lift: the host's own kind of grey, with the card raised far enough
     above the canvas to be seen without leaning on its border. */
  body[data-theme="lift"] {
    --av-bg: #121316;
    --av-card: #1e2126;
    --av-border: #343841;
    --av-fg: #f1f2f5;
    --av-muted: #969ba6;
    --av-fg-2: #c2c5cc;
    --av-fg-3: #91959e;
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);
    --av-shadow-2: rgba(0, 0, 0, .40);
    --av-shadow-3: rgba(0, 0, 0, .55);
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: #6ea8fe;
    --av-orange: #f0a94c;
    --av-purple: #b892f8;
    --av-green: #4ec97a;
    --av-red: #ff6b73;
    --av-yellow: #e8c76a;
    --av-focus: #6ea8fe;
    --av-link: #8ab8ff;
    --av-badge-bg: #333842;
    --av-badge-fg: #f1f2f5;
    --av-hover: #ffffff12;
    --av-list-hover: #ffffff0d;
    --av-input-bg: #181a1e;
    --av-input-fg: #f1f2f5;
    --av-input-border: #3c414c;
    --av-menu-bg: #21242a;
    --av-menu-fg: #f1f2f5;
    --av-menu-border: #3c414c;
    --av-quote-bg: #1b1e23;
    --av-code-bg: #ffffff10;
    --av-code-fg: #efae87;
    --av-btn-bg: #3b6fd4;
    --av-btn-fg: #ffffff;
    --av-warn-bg: #33260d;
    --av-warn-border: #f0a94c;
    /* Pale accents, so what sits on them is the dark end, not the light one. */
    --av-on-blue: #0b0d10;
    --av-on-orange: #000000;
    --av-on-purple: #140f1f;
    --av-on-green: #000;
    --av-on-red: #000;
    --av-hl-keyword: #7cb0ff;
    --av-hl-string: #e2a582;
    --av-hl-comment: #7aa870;
    --av-hl-number: #bcd6a3;
  }

  /* Paper: a light panel. The accents are re-picked rather than reused — the
     host's chart colours are tuned for a dark background and several of them
     do not clear 4.5:1 on white. */
  body[data-theme="paper"] {
    --av-bg: #f2f3f5;
    --av-card: #ffffff;
    --av-border: #d8dade;
    --av-fg: #1b1d21;
    --av-muted: #5b6068;
    /* Not the dark presets' ranks inverted, and not a percentage of --av-fg:
       these are read on white, where the same fade that clears 4.5:1 on a dark
       canvas lands near 3:1. Measured against --av-card, the lighter of the two
       surfaces they sit on: 8.5:1 and 4.8:1. */
    --av-fg-2: #4a4d54;
    --av-fg-3: #6e727a;
    /* A shadow on white is a warm grey at low alpha, not black at lower alpha:
       black on white goes to a dead neutral that reads as dirt. And there is
       nothing above this preset's #ffffff card to mix toward — 3.5% of a
       near-black foreground would send the raised surface DOWN, past the ground
       it is meant to be above — so the card is the lift here, and the step up
       from the board's own #f2f3f5 is a real 12. The rim inverts on white and is
       switched off rather than moved. */
    --av-lift: var(--av-card);
    --av-shadow-1: rgba(38, 34, 28, .10);
    --av-shadow-2: rgba(38, 34, 28, .16);
    --av-shadow-3: rgba(38, 34, 28, .24);
    --av-rim: transparent;
    --av-blue: #0a66c2;
    --av-orange: #a55a00;
    --av-purple: #7127c9;
    --av-green: #0f7b3d;
    --av-red: #c01d2e;
    --av-yellow: #8a6d00;
    --av-focus: #0a66c2;
    --av-link: #0a66c2;
    --av-badge-bg: #1b1d21;
    --av-badge-fg: #ffffff;
    --av-hover: #0000000d;
    --av-list-hover: #00000012;
    --av-input-bg: #ffffff;
    --av-input-fg: #1b1d21;
    --av-input-border: #c9ccd2;
    --av-menu-bg: #ffffff;
    --av-menu-fg: #1b1d21;
    --av-menu-border: #c9ccd2;
    --av-quote-bg: #eceef1;
    --av-code-bg: #00000010;
    --av-code-fg: #a51e57;
    --av-btn-bg: #0a66c2;
    --av-btn-fg: #ffffff;
    --av-warn-bg: #fdf1dc;
    --av-warn-border: #a55a00;
    /* Every accent here is dark enough to carry white — including the amber,
       which is the one place this preset departs from the others. */
    --av-on-blue: #ffffff;
    --av-on-orange: #ffffff;
    --av-on-purple: #ffffff;
    --av-on-green: #fff;
    --av-on-red: #fff;
    --av-hl-keyword: #0000ff;
    --av-hl-string: #a31515;
    --av-hl-comment: #008000;
    --av-hl-number: #098658;
  }

  /* Neon Terminal: near-black with cyan for the running state and mint for a
     healthy context bar. Two greens on one card would be two meanings in one
     colour, so the mint stays on the bar and the rail takes the cyan. */
  body[data-theme="neon"] {
    --av-bg: #060809;
    --av-card: #0e1315;
    --av-border: #1d2b2a;
    --av-fg: #d9f3e9;
    --av-muted: #6f8f88;
    --av-fg-2: #a9c6bd;
    --av-fg-3: #7d9a92;
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);
    --av-shadow-2: rgba(0, 0, 0, .40);
    --av-shadow-3: rgba(0, 0, 0, .55);
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: #4ddfff;
    --av-orange: #ffb02e;
    --av-purple: #b48cff;
    --av-green: #2ee6a8;
    --av-red: #ff5f6d;
    --av-yellow: #ffd83d;
    --av-focus: #2ee6a8;
    --av-link: #4ddfff;
    --av-badge-bg: #12312a;
    --av-badge-fg: #6ff0c4;
    --av-hover: #2ee6a81a;
    --av-list-hover: #2ee6a814;
    --av-input-bg: #0b1113;
    --av-input-fg: #d9f3e9;
    --av-input-border: #23342f;
    --av-menu-bg: #0c1214;
    --av-menu-fg: #d9f3e9;
    --av-menu-border: #23342f;
    --av-quote-bg: #0f1a19;
    --av-code-bg: #2ee6a814;
    --av-code-fg: #6ff0c4;
    --av-btn-bg: #0f3d33;
    --av-btn-fg: #7ff5cd;
    --av-warn-bg: #2a1f06;
    --av-warn-border: #ffb02e;
    --av-on-blue: #041014;
    --av-on-orange: #000000;
    --av-on-purple: #100a1f;
    --av-on-green: #000;
    --av-on-red: #000;
    --av-hl-keyword: #4ddfff;
    --av-hl-string: #ffb02e;
    --av-hl-comment: #4f7f6f;
    --av-hl-number: #2ee6a8;
  }

  /* Polaroid Pack: the film box — warm cream canvas, white card, red shutter
     on the CTA and focus ring. Accents re-picked dark enough for 4.5:1 on
     white, same discipline as Paper. Spec: docs/mockups/theme_presets_retro.html;
     catalogue: docs/design_tokens/theme_presets.html. */
  body[data-theme="polaroid"] {
    --av-bg: #f7f4ed;
    --av-card: #ffffff;
    --av-border: #d8d2c6;
    --av-fg: #1a1a1c;
    --av-muted: #5c5850;
    --av-fg-2: #4a463e;
    --av-fg-3: #6e6a62;
    /* The other light preset — why these are warm grey and why the card is the
       lift, once, on paper above. */
    --av-lift: var(--av-card);
    --av-shadow-1: rgba(38, 34, 28, .10);
    --av-shadow-2: rgba(38, 34, 28, .16);
    --av-shadow-3: rgba(38, 34, 28, .24);
    --av-rim: transparent;
    --av-blue: #2a5fc9;
    --av-orange: #c46a00;
    --av-purple: #6b3fb0;
    --av-green: #1f7a45;
    --av-red: #c41820;
    --av-yellow: #8a6d00;
    --av-focus: #e31c23;
    --av-link: #2a5fc9;
    --av-badge-bg: #1a1a1c;
    --av-badge-fg: #ffffff;
    --av-hover: #0000000c;
    --av-list-hover: #00000012;
    --av-input-bg: #ffffff;
    --av-input-fg: #1a1a1c;
    --av-input-border: #c9c2b4;
    --av-menu-bg: #ffffff;
    --av-menu-fg: #1a1a1c;
    --av-menu-border: #c9c2b4;
    --av-quote-bg: #efebe1;
    --av-code-bg: #0000000e;
    --av-code-fg: #a51e57;
    --av-btn-bg: #e31c23;
    --av-btn-fg: #ffffff;
    --av-warn-bg: #fdf1dc;
    --av-warn-border: #c46a00;
    --av-on-blue: #ffffff;
    --av-on-orange: #ffffff;
    --av-on-purple: #ffffff;
    --av-on-green: #fff;
    --av-on-red: #fff;
    --av-hl-keyword: #2a5fc9;
    --av-hl-string: #a31515;
    --av-hl-comment: #1f7a45;
    --av-hl-number: #c46a00;
  }

  /* Mario Kart: blue body as canvas, red nose/hat as focus and CTA, yellow
     wheels as waiting. BUSY stays a lighter sky blue so the rail still reads
     against the navy card. Spec: docs/mockups/theme_presets_retro.html;
     catalogue: docs/design_tokens/theme_presets.html. */
  body[data-theme="mario"] {
    --av-bg: #0b1a33;
    --av-card: #122848;
    --av-border: #27406a;
    --av-fg: #f4f7fc;
    --av-muted: #7a92b0;
    --av-fg-2: #b8c8dc;
    --av-fg-3: #7e94b0;
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);
    --av-shadow-2: rgba(0, 0, 0, .40);
    --av-shadow-3: rgba(0, 0, 0, .55);
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: #3d9eff;
    --av-orange: #f5c518;
    --av-purple: #b07cf5;
    --av-green: #3ecf7a;
    --av-red: #e52521;
    --av-yellow: #f5c518;
    --av-focus: #e52521;
    --av-link: #5eb6ff;
    --av-badge-bg: #1a3560;
    --av-badge-fg: #f4f7fc;
    --av-hover: #ffffff12;
    --av-list-hover: #ffffff0d;
    --av-input-bg: #0e203c;
    --av-input-fg: #f4f7fc;
    --av-input-border: #2f4f7a;
    --av-menu-bg: #152e50;
    --av-menu-fg: #f4f7fc;
    --av-menu-border: #2f4f7a;
    --av-quote-bg: #152e50;
    --av-code-bg: #ffffff10;
    --av-code-fg: #f5c518;
    --av-btn-bg: #e52521;
    --av-btn-fg: #ffffff;
    --av-warn-bg: #3a2a0a;
    --av-warn-border: #f5c518;
    --av-on-blue: #061018;
    --av-on-orange: #000000;
    --av-on-purple: #100a1f;
    --av-on-green: #000;
    --av-on-red: #000;
    --av-hl-keyword: #5eb6ff;
    --av-hl-string: #f5c518;
    --av-hl-comment: #3ecf7a;
    --av-hl-number: #3d9eff;
  }

  /* Night City (Cyberpunk 2077): black chassis, brand yellow on focus/CTA,
     cyan TECH as busy. Status accents are capped at OKLCH chroma 0.20, the
     Mario/Polaroid ceiling, and hover washes are white: the sRGB-edge neon and
     a yellow film on every hovered row read as cellophane. Spec: docs/mockups/theme_presets_cyberpunk.html;
     catalogue: docs/design_tokens/theme_presets.html. */
  body[data-theme="nightcity"] {
    --av-bg: #08080c;
    --av-card: #12121a;
    --av-border: #2c2c3a;
    --av-fg: #f2efe6;
    --av-muted: #9a9488;
    --av-fg-2: #c8c2b4;
    --av-fg-3: #8a8478;
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);
    --av-shadow-2: rgba(0, 0, 0, .40);
    --av-shadow-3: rgba(0, 0, 0, .55);
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: #00d4ff;
    --av-orange: #ff9f1a;
    --av-purple: #b964e7;
    --av-green: #6ef983;
    --av-red: #ea4650;
    --av-yellow: #fcee0a;
    --av-focus: #fcee0a;
    --av-link: #00e8ff;
    --av-badge-bg: #2a2408;
    --av-badge-fg: #fcee0a;
    --av-hover: #ffffff12;
    --av-list-hover: #ffffff0d;
    --av-input-bg: #0c0c12;
    --av-input-fg: #f2efe6;
    --av-input-border: #3a3a4a;
    --av-menu-bg: #14141c;
    --av-menu-fg: #f2efe6;
    --av-menu-border: #3a3a4a;
    --av-quote-bg: #14141c;
    --av-code-bg: #ffffff10;
    --av-code-fg: #fcee0a;
    --av-btn-bg: #fcee0a;
    --av-btn-fg: #0a0a0c;
    --av-warn-bg: #2a1a06;
    --av-warn-border: #ff9f1a;
    --av-on-blue: #041018;
    --av-on-orange: #000000;
    --av-on-purple: #100a1f;
    --av-on-green: #000;
    --av-on-red: #000;
    --av-hl-keyword: #00e8ff;
    --av-hl-string: #fcee0a;
    --av-hl-comment: #6ef983;
    --av-hl-number: #00d4ff;
  }

  /* Arasaka (Cyberpunk 2077): near-black corp chassis, red shutter on
     focus/CTA, sky blue busy. The greys keep a third of their red tint and the
     status accents and washes follow Night City's rule; the full tint, mixed
     into the card lift, read as cellophane. Comparison:
     docs/mockups/theme_saturation_cyberpunk.html. Spec: docs/mockups/theme_presets_cyberpunk.html;
     catalogue: docs/design_tokens/theme_presets.html. */
  body[data-theme="arasaka"] {
    --av-bg: #0a0909;
    --av-card: #131111;
    --av-border: #302727;
    --av-fg: #edeaea;
    --av-muted: #908888;
    --av-fg-2: #bfb8b7;
    --av-fg-3: #7e7575;
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);
    --av-shadow-2: rgba(0, 0, 0, .40);
    --av-shadow-3: rgba(0, 0, 0, .55);
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: #4db8ff;
    --av-orange: #ff9f1a;
    --av-purple: #b964e7;
    --av-green: #3ecf7a;
    --av-red: #ea4650;
    --av-yellow: #f0c040;
    --av-focus: #ff003c;
    --av-link: #ff6b8a;
    --av-badge-bg: #201717;
    --av-badge-fg: #ff8aa0;
    --av-hover: #ffffff12;
    --av-list-hover: #ffffff0d;
    --av-input-bg: #0e0d0d;
    --av-input-fg: #edeaea;
    --av-input-border: #3d3131;
    --av-menu-bg: #161212;
    --av-menu-fg: #edeaea;
    --av-menu-border: #3d3131;
    --av-quote-bg: #161212;
    --av-code-bg: #ffffff10;
    --av-code-fg: #ff8aa0;
    --av-btn-bg: #ff003c;
    --av-btn-fg: #ffffff;
    --av-warn-bg: #2a1408;
    --av-warn-border: #ff9f1a;
    --av-on-blue: #061018;
    --av-on-orange: #000000;
    --av-on-purple: #100a1f;
    --av-on-green: #000;
    --av-on-red: #000;
    --av-hl-keyword: #4db8ff;
    --av-hl-string: #ff6b8a;
    --av-hl-comment: #3ecf7a;
    --av-hl-number: #ff9f1a;
  }

  /* Malachite: an emerald card on a deeper emerald ground, cream type, moss on
     the focus ring. The only preset whose canvas is a saturated colour rather
     than a near-black or a near-white, and the elevation step is real for once
     (1.48:1 between ground and card, where Ink's is 1.15).

     Everything here is in the green band and there is no fourth green to escape
     into: the moss ring reads 3.3:1 on the card — enough for a ring, never for
     text, and it carries none — and sits 1.7:1 from the context bar's own
     green. Mint for the bar was measured and rejected: it lands 1.1:1 from the
     teal rail, which is a worse collision on a card that is always running. The
     rail is teal for the same reason Neon's is cyan — two greens on one card
     would be two meanings in one colour.

     Cream (#f4f1eb) rather than a grey-white is the palette's own fourth hex,
     and it is what stops the surface reading as a terminal. Spec:
     docs/mockups/theme_presets_emerald.html; catalogue:
     docs/design_tokens/theme_presets.html. */
  body[data-theme="malachite"] {
    --av-bg: #082e25;
    --av-card: #0d4c3c;
    --av-border: #2d5a4a;
    --av-fg: #f4f1eb;
    --av-muted: #a7b8aa;
    --av-fg-2: #cfd6c8;
    --av-fg-3: #a3b4a6;
    --av-lift: color-mix(in srgb, var(--av-fg) 3.5%, var(--av-card));
    --av-shadow-1: rgba(0, 0, 0, .28);
    --av-shadow-2: rgba(0, 0, 0, .40);
    --av-shadow-3: rgba(0, 0, 0, .55);
    --av-rim: rgba(255, 255, 255, .055);
    --av-blue: #4fc7c0;
    --av-orange: #e0a353;
    --av-purple: #b58ce0;
    --av-green: #8fd694;
    --av-red: #ef6a63;
    --av-yellow: #e8c96a;
    --av-focus: #7ba05b;
    --av-link: #b9d99a;
    --av-badge-bg: #0b3a2e;
    --av-badge-fg: #cfe3b8;
    --av-hover: #7ba05b1c;
    --av-list-hover: #7ba05b14;
    --av-input-bg: #062720;
    --av-input-fg: #f4f1eb;
    --av-input-border: #35674f;
    --av-menu-bg: #0a3a2e;
    --av-menu-fg: #f4f1eb;
    --av-menu-border: #35674f;
    --av-quote-bg: #0b3a2e;
    --av-code-bg: #f4f1eb12;
    --av-code-fg: #cfe3b8;
    --av-btn-bg: #7ba05b;
    --av-btn-fg: #08231b;
    --av-warn-bg: #33260f;
    --av-warn-border: #e0a353;
    /* Pale accents, so what sits on them is the dark end. */
    --av-on-blue: #04201e;
    --av-on-orange: #000000;
    --av-on-purple: #170f22;
    --av-on-green: #000;
    --av-on-red: #000;
    --av-hl-keyword: #4fc7c0;
    --av-hl-string: #e0a353;
    --av-hl-comment: #8fb59f;
    --av-hl-number: #b9d99a;
  }

  html, body { height: 100%; }
  /* The host's own default stylesheet leaves the body transparent — what looks
     like the panel's canvas is the workbench showing through the iframe. Under
     "follow" this rule paints the same colour it was showing; without it, a
     preset would re-colour every card and leave the canvas behind them alone. */
  /* EXPERIMENT (typography-m2): Body2, stated rather than inherited from the
     host — see the scale in :root. Restore var(--vscode-font-size) to undo. */
  /* padding:0 overrides the host's own body { padding: 0 20px } — the
     workbench injects it into every webview, and it showed as a strip of
     workbench either side of the board. */
  /* The scrollbar is the last host colour a preset could not reach. The
     workbench injects
     \`@layer vscode-default { html { scrollbar-color: var(--vscode-scrollbarSlider-background)
     var(--vscode-editor-background) } }\` into every webview, and it inherits —
     so every scroller in the panel wore the host's grey thumb on a strip of the
     host's *editor* background, which is not the colour any of them sits on.
     Stated here for the same reason \`background\` above is: one indirection, and
     the preset decides.

     The track is a mix of the reader's own foreground rather than a colour,
     because it is a strip drawn over whatever ground the scroller happens to
     sit on — the dock, a sheet and the board are three, and the host's single
     value was the board's. At 6% of --av-fg it darkens on a dark preset and
     lightens on a light one, so one declaration is a lane on all three; a hex
     would have needed a per-preset override and the two light presets would
     have taken a black lane under a white slab. Drawn against the five other
     directions, in every preset, on both grounds:
     docs/mockups/scrollbar-lane.html. What that page rules out is worth as
     much as what it picks — a --av-shadow-1 groove is invisible on every dark
     preset, and the accent at full strength joins a conversation the selection
     ring and a busy card's rail are already having.

     Shipped bare (track \`transparent\`) for one commit. It is correct on every
     ground for the reason a hole is: a thumb with nothing to sit in.

     Measured in the host's own Chromium (Electron 42 / Chromium 148, macOS),
     with a real wheel and a page-level pixel read:
     - This costs no layout. \`offsetWidth - clientWidth\` stays 0, so the bar is
       still the platform overlay and the divider band's assertion in
       panel.smoke.ts still holds.
     - There is no state selector to go with it. The bar's thin→thick swap on
       hover and drag is the platform's, and \`scrollbar-color\` has one thumb
       value for both — so the accent is what the reader sees either way.
     - **\`::-webkit-scrollbar\` is dead in this document, and was before this
       line.** Chromium ignores every scrollbar pseudo-element on an element
       whose \`scrollbar-color\` is not \`auto\`, and the host's rule above already
       made that true of every scroller here. Probed at four treatments: with
       the property set the webkit rules paint nothing; with \`scrollbar-color:
       auto\` restored on the element they paint immediately. So
       \`#wfcanvas .wcscroll\`'s 8px + thumb tint (css/wfcanvas.ts) has never
       been what that bar looks like. Reach for this property, not that one. */
  body { font-family: var(--vscode-font-family); font-size: var(--av-fs-lg);
         color: var(--av-fg); background: var(--av-bg);
         scrollbar-color: color-mix(in srgb, var(--av-focus) 50%, transparent)
                          color-mix(in srgb, var(--av-fg) 6%, transparent);
         margin: 0; padding: 0; display: flex; overflow: hidden; }

  /* Ghost text is the third rank, everywhere. Every hint the panel writes as an
     element already is — .hintghost in the composer, .ashint, #bottomdrawer-foot .hint —
     and until this rule the placeholders were not: they were the host
     Chromium's default, which is the field's own colour at an opacity no preset
     can reach, and the one sheet that did state a colour (#wfeditor, whose
     fields have no labels) put them at --av-fg-2 for the contrast — 6.77:1 on
     --av-bg against --av-fg-3's 4.06:1. At the body rank a placeholder reads as
     something already typed, which is what a label-shaped one has to not do.
     Element-level, so any id-scoped rule still outranks it. */
  input::placeholder, textarea::placeholder { color: var(--av-fg-3); }

`;
