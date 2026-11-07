/** The board's list nav bar: tally, filter, usage, settings gear. */

export const css = /* css */ `
  /* The board's nav bar. The controls used to be two pills at the foot of the
     cards, which is a place nobody scrolls to; giving them a strip of their own
     only moved the homelessness, so the strip earns its height by carrying the
     tally of what is below it.

     A row of #board, not a sticky child of #cards: chrome that is its own box
     cannot be made to overlap what it heads. A flex-none bar against a flex-1
     board is the whole of the arrangement.

     The 40px is the outer edge, border included. Measured 2026-10-06 on the
     running panel: a chip centered in the content box sat on that box's
     center, and about 4px of the box sat above the editor tab seam, so the
     row read high in the navy left on screen. padding-top is that cover.
     */
  #nav { flex: none; display: flex; align-items: center; gap: 2px;
         height: 40px; box-sizing: border-box; padding: 4px var(--board-gutter) 0; }
  #nav[hidden] { display: none; }

  .board-views { display: flex; align-self: stretch; gap: 4px; margin-right: auto; }
  .board-view { display: flex; align-items: center; gap: 6px; padding: 0 8px;
                border: 0; border-bottom: 2px solid transparent; background: none;
                font: inherit; font-size: var(--av-fs-md); color: var(--av-fg-2); cursor: pointer; }
  .board-view:hover { color: var(--av-fg); background: var(--av-hover); }
  .board-view.on { color: var(--av-fg); border-bottom-color: var(--av-focus); }
  .board-view:focus-visible { outline: 2px solid var(--av-focus); outline-offset: -2px; }
  .board-view:disabled { cursor: default; }
  .board-view .tb { font-variant-numeric: tabular-nums; font-size: var(--av-fs-md);
                    padding: 0 6px; border-radius: 9px; background: var(--av-badge-bg); color: var(--av-badge-fg); }
  .board-view .tb.warn { background: var(--av-orange); color: var(--av-on-orange); }
  #status-filter .tot { font-variant-numeric: tabular-nums; color: var(--av-fg-2); }
  #status-menu .mitem .dot { background: var(--st, var(--av-border)); box-shadow: none; }

  /* What a filter that matches nothing says, in place of the groups. */
  #filtered-empty { color: var(--av-fg-3); padding: 26px 0; }

  /* The plan's usage, at the head of the actions row: a readout, not a control,
     so it takes no hover and no button padding — the rule after it is what
     separates it from the things that can be clicked. Tabular figures because
     this repaints every second and proportional digits jitter as they change. */
  .lim { font-size: var(--av-fs-md); color: var(--av-fg-3); white-space: nowrap;
         font-variant-numeric: tabular-nums; padding: 4px 3px; }
  /* Accounts control: same slot becomes a button (usage or Log in). */
  button.lim {
    font: inherit; font-size: var(--av-fs-md); color: var(--av-fg-3);
    white-space: nowrap; font-variant-numeric: tabular-nums;
    padding: 4px 8px; border-radius: 5px; border: none; background: none;
    cursor: pointer; display: inline-flex; align-items: center;
  }
  button.lim:hover, button.lim[aria-expanded="true"] {
    background: var(--av-hover); color: var(--av-fg-2);
  }
  button.lim.login {
    font-weight: 600; color: var(--av-btn-fg); background: var(--av-btn-bg);
    padding: 4px 11px;
  }
  button.lim.login:hover { filter: brightness(1.08); background: var(--av-btn-bg); color: var(--av-btn-fg); }
  /* Mark + 5h none · wk 100%. 13px sits in the 24px hit target. */
  button.lim .bmwrap { width: 13px; height: 13px; margin-right: 6px; flex: none; }
  button.lim .bmwrap .bm, button.lim .bmwrap svg { width: 13px; height: 13px; display: block; }
  /* The label off the figure by more than the space in its text, and the figure
     in a slot wide enough for every reading it can hold: tabular figures hold a
     digit's width, not a reading's, so 9% -> 10% still shoved the separator and
     the week along with it.
     The widest is "100%", not "none" — measured 2026-08-18 in the panel, where
     4.2ch sat "-", "none" and "42%" all on 31.74px and "100%" overflowed to
     33.78px. Three tabular digits are 3ch by definition and "%" measured 1.47ch
     there; 4.7ch carries that sum with room for a font whose percent sign runs
     wider, which is the term this cannot read off the box model. */
  .lim .k { padding-right: 2px; }
  .lim .v { color: var(--av-fg-2); display: inline-block; min-width: 4.7ch; }
  .lim .v.high { color: var(--av-orange); }
  .lim .v.full { color: var(--av-red); }
  /* Brand swap: one face flips out over the top, the next in from above.
     rotateY read as a side hinge on this wide chip. Perspective and overflow
     stay on the stage inside the button — not on .limwrap — so the accounts
     menu, absolute under that wrap, is not a 3D child of the flight.
     90px, not 220: the chip is one line (~24px) and the longer camera
     flattened this hinge. */
  .limstage { display: grid; justify-items: start; align-items: center;
              perspective: 90px; overflow: hidden; }
  .limface { grid-area: 1 / 1; display: inline-flex; align-items: center;
             white-space: nowrap; backface-visibility: hidden;
             transform-origin: 50% 50%; }
  @media (prefers-reduced-motion: no-preference) {
    .limstage { transition: width 340ms cubic-bezier(.2, .7, .25, 1); }
    .limface.out { pointer-events: none;
                   animation: lim-flip-out 180ms cubic-bezier(.2, .7, .25, 1) forwards; }
    .limface.in { animation: lim-flip-in 180ms cubic-bezier(.2, .7, .25, 1) 160ms both; }
    @keyframes lim-flip-out { from { transform: rotateX(0deg); } to { transform: rotateX(-90deg); } }
    @keyframes lim-flip-in { from { transform: rotateX(90deg); } to { transform: rotateX(0deg); } }
  }

  /* Accounts popover (opened from lim). Accounts-only — no Board / Theme.
     No fixed row count: the identity is row 1 and each window stacks under it.
     Spanning 2 centered the action on the identity plus the first window and
     left the week line outside it, and the span moved with the window count.

     z-index 25: the menu is a .fmenu, whose 20 loses to the chick (24) because
     #board is not a stacking context. 25 is the portalled menu's rank
     (css/bottom_drawer.ts): over the chick, under the lightbox (26). */
  .smenu.accts { z-index: 25; width: 316px; max-height: min(70vh, 420px); overflow: auto; }

  .acct {
    display: grid;
    grid-template-columns: 25px 1fr auto;
    column-gap: 9px; row-gap: 3px;
    padding: 8px; border-radius: 5px; align-items: center;
  }
  .acct:hover { background: var(--av-list-hover); }
  .acct .bmwrap { grid-row: 1; align-self: start; margin-top: 1px; width: 25px; height: 25px; }
  .acct .bmwrap .bm, .acct .bmwrap svg { width: 25px; height: 25px; display: block; }
  .acct .bmwrap.muted { opacity: .55; }
  /* Grok dual mark: white on dark UI, #0A0A0A on light (file names = mark colour). */
  .bm.gr .on-light { display: none; }
  .bm.gr .on-dark { display: block; }
  body[data-theme="paper"] .bm.gr .on-dark,
  body[data-theme="polaroid"] .bm.gr .on-dark { display: none; }
  body[data-theme="paper"] .bm.gr .on-light,
  body[data-theme="polaroid"] .bm.gr .on-light { display: block; }
  @media (prefers-color-scheme: light) {
    body:not([data-theme]) .bm.gr .on-dark { display: none; }
    body:not([data-theme]) .bm.gr .on-light { display: block; }
  }
  /* Codex mark follows panel foreground. */
  .bm.cx { color: var(--av-fg); }
  .acct .id { grid-column: 2; grid-row: 1; min-width: 0; }
  /* The clip is on .t, not on .em. It was on .em with the plan chip inline
     inside it, so a label past ~24 characters — measured: a 21-character email
     and a Max 20x chip need 196px of a 201.6px track — put the badge under the
     ellipsis and erased it whole rather than shortening it. The label is the
     half still recognisable from its first 20 characters; half a badge is not. */
  .acct .em { font-size: var(--av-fs-md); display: flex; align-items: center; min-width: 0; }
  .acct .em .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct .em.muted { color: var(--av-fg-3); }
  .acct .pl {
    font-size: var(--av-fs-sm); color: var(--av-fg-3); margin-top: 1px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* One line per window, and the first three tracks are fixed so the figures
     line up down the popover rather than per row. Measured against this
     stylesheet in a real engine, the line is 208px: at a 46px track the reset
     column is 95px, and the widest thing until() can put in it — resets 23h
     59m, an hours-and-minutes window just under a day — measures 84.8px. 10px
     of headroom, where a 52px track left 4px. Anything longer still ellipsises
     rather than widening the popover, which is what the zero min-width buys.

     Not the card's segmented strip: that one is a context window, read in a
     different moment, and one bar drawn two ways would be read as one fact —
     which is also why this one is \`.wb\` and that one \`.card .bar\`. */
  .acct .win {
    /* 16px holds every short on the wire today - 30d, the widest, measures
       15px. A window named for its duration in minutes does not: 720m measures
       22.8px, eats the gap and strikes the track, still legible. Clipping it
       reads 7… in the 16px an ellipsis leaves, and an auto column sizes per
       line - each .win is its own grid - and unaligns the tracks down the row.
       Overflowing is the least of the three. */
    grid-column: 2; display: grid; grid-template-columns: 16px 46px 30px 1fr;
    align-items: center; column-gap: 7px;
    font-size: var(--av-fs-sm); font-variant-numeric: tabular-nums; color: var(--av-fg-3);
  }
  /* The track is named \`.wb\` and not \`.bar\` because it shipped as \`.bar\`
     and took css/board.ts's bare \`.bar\` with it — the card's context bar,
     twenty grid columns wide. The fill then resolved its percentage against one
     twentieth of the 46px track above: measured, a 61% fill painted 0.234px
     where a block track paints 28.05px, so every reading came out sub-pixel and
     the popover drew tracks that all looked alike. The name is the fix, and
     this is the one copy of why.

     \`display\` is belt-and-braces, not that fix: a span in the grid above is
     blockified already, and \`display: grid\` is block-level too, so it was
     never blockification that failed. It is stated so the track keeps its box
     if \`.acct .win\` ever stops being a grid — height does not apply to an
     inline box — and so 0,3,0 outranks any later unscoped \`.wb\`. */
  .acct .win .wb { display: block; height: 3px; border-radius: 2px;
                   background: var(--av-hover); overflow: hidden; }
  .acct .win .wb i { display: block; height: 100%; border-radius: 2px; background: var(--av-fg-2); }
  .acct .win .wb i.high { background: var(--av-orange); }
  .acct .win .wb i.full { background: var(--av-red); }
  .acct .win .wv { color: var(--av-fg-2); text-align: right; }
  .acct .win .wv.high { color: var(--av-orange); }
  .acct .win .wv.full { color: var(--av-red); }
  /* No figure, so no track either — the words take the cells the track would
     have spanned, and start where a track would have. All three of them only
     when nothing follows: a window out of a rollover has no number and a reset
     time both, and the reset keeps the last cell it is aligned in. */
  .acct .win .wv.bare {
    grid-column: 2 / span 3; text-align: left; color: var(--av-fg-3);
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .acct .win .wv.bare:not(:last-child) { grid-column: 2 / span 2; }
  .acct .win .wl {
    text-align: right; opacity: .8;
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* The min-height/min-width pair is WCAG 2.2 SC 2.5.8, and it is here because a
     browser said so: the line box plus 3px of padding measured 19px tall at the
     old 11px, which src/test/smoke/mcp.smoke.ts fails on. jsdom lays nothing
     out, so no other layer could have caught it. The type is the button step
     now; the 24px floor stays, and it covers every act — Sign out measured the
     same 19px. The action sits on row 1, with the name, rather than spanning a
     window count. */
  .acct .act {
    grid-column: 3; grid-row: 1; align-self: start;
    font: inherit; font-size: var(--av-fs-md); border: none; background: none; cursor: pointer;
    padding: 3px 6px; border-radius: 4px; color: var(--av-fg-3); white-space: nowrap;
    min-height: 24px; min-width: 24px;
  }
  .acct .act:hover { background: var(--av-hover); color: var(--av-fg); }
  .acct .act.out:hover { color: var(--av-red); }
  .acct .act.in { color: var(--av-link); }
  .acct .act.soon { cursor: default; opacity: .55; }
  /* A not-installed row has two acts. Bare, both claim column 3 of row 1 and
     sit on top of each other; the wrapper takes the cell instead. */
  .acct .acts { grid-column: 3; grid-row: 1; align-self: start; display: flex; gap: 2px; }
  /* sm is the badge floor — 9px sits under it. line-height locks that step
     into the 14px chip, onboarding's 1.45 included. No text-transform: it
     would print Ultra as ULTRA. The flex: none is the other half of the
     rule above — a chip that shrinks is a chip that clips. */
  .acct .plan {
    display: inline-flex; align-items: center; flex: none; padding: 0 5px; height: 14px;
    border-radius: 3px; font-size: var(--av-fs-sm); line-height: 14px; font-weight: 600; letter-spacing: .04em;
    background: #a97cf526; color: var(--av-purple);
    margin-left: 6px; vertical-align: 1px;
  }

  .bm.ln .on-light { display: none; }
  .bm.ln .on-dark { display: block; }
  body[data-theme="paper"] .bm.ln .on-dark,
  body[data-theme="polaroid"] .bm.ln .on-dark { display: none; }
  body[data-theme="paper"] .bm.ln .on-light,
  body[data-theme="polaroid"] .bm.ln .on-light { display: block; }
  body.vscode-light:not([data-theme]) .bm.ln .on-dark,
  body.vscode-high-contrast-light:not([data-theme]) .bm.ln .on-dark { display: none; }
  body.vscode-light:not([data-theme]) .bm.ln .on-light,
  body.vscode-high-contrast-light:not([data-theme]) .bm.ln .on-light { display: block; }

  /* MCP footer on the accounts popover. .mfoot is already the settings
     version-stamp, so this one is named apart. */
  .smenu.accts .mcpfoot { margin: 4px 2px 2px; }
  .smenu.accts .mcpgo {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 9px; border-radius: 5px; cursor: pointer;
  }
  .smenu.accts .mcpgo:hover { background: var(--av-list-hover); }
  .smenu.accts .mcpgo .k {
    font-size: var(--av-fs-sm); letter-spacing: .08em; text-transform: uppercase; color: var(--av-fg-3);
  }
  .smenu.accts .mcpgo .v { font-size: var(--av-fs-md); color: var(--av-fg-2); }
  .smenu.accts .mcpgo.needs .v { color: var(--av-orange); }

  /* The auth sheets, the dock's signed-out CTA and their three button ranks
     were here, and are css/auth.ts now — a sheet is not a nav bar, and a
     hundred lines of one made this file's rung in the cascade load-bearing for
     a surface it never named. The accounts *popover* above stays: that one
     really does hang off a control on this bar. */

  /* The machine gauge, before the plan readout and shaped like it: same size,
     same colour, same tabular figures, same two late thresholds. What it adds
     is a face, because "is this laptop the thing that is slow" is a question
     answered by a glance and not by reading a number.

     A tachometer, which is to say a half-dial — the bar is 40px with no
     vertical padding, so 16px of face is what there is, and a full circle in
     that space is a dot. A needle, where this drew twelve lit ticks first: what
     a dial buys over the number beside it is an angle, read without being
     parsed, and ticks quantise it away — 6% and 12% were the same one tick. The
     face is chrome under it, printed and unchanging, redline included, so a
     reading is against a scale rather than against nothing. The needle moves
     directly to each reading rather than tweening between them. */
  .mach { display: inline-flex; align-items: center; gap: 6px;
          font-size: var(--av-fs-md); color: var(--av-fg-3); white-space: nowrap;
          font-variant-numeric: tabular-nums; padding: 4px 3px; }
  /* The memory face is a second .mach, so the load's rules stay about one
     number. #nav-actions sets a 2px gap for controls that sit shoulder to
     shoulder; two gauges read as one instrument at that distance and as two
     unrelated readouts much past this, which is the 12px the placement mockup
     drew between them. */
  .mach + .mach { margin-left: 10px; }
  .mach .v { color: var(--av-fg-2); }
  .mach .v.high { color: var(--av-orange); }
  .mach .v.full { color: var(--av-red); }
  .mach .dial { display: block; flex: none; }
  /* Which face this is. Overline treatment, at the size that is its floor: two
     dials side by side are otherwise told apart by a % against a G, which is a
     unit being parsed where a word is read. It stays at the muted rank — a
     label on an instrument must never outweigh the reading. */
  .mach .k { flex: none; font-size: var(--av-fs-sm); letter-spacing: .08em;
             color: var(--av-fg-3); }
  /* The printed face: the arc and its quarters, at the weight a printed scale
     has, and both under the needle rather than beside it. */
  .mach .arc { fill: none; stroke: var(--av-border); stroke-width: 1; opacity: .55; }
  .mach .tick { stroke: var(--av-border); stroke-width: 1.3; }
  /* The redline, printed whatever the reading is — the way a car prints one on
     the dial rather than deciding it per reading. */
  .mach .red { fill: none; stroke: var(--av-red); stroke-width: 2; opacity: .34;
               stroke-linecap: butt; }
  /* The needle, and the pivot it turns on: punched out of the card rather than
     filled, so the hub reads as a bearing and not as a dot. The reading is the
     only thing on the face that carries rank colour. */
  .mach .needle { fill: var(--av-fg); stroke: var(--av-fg); stroke-width: .5;
                  stroke-linejoin: round; }
  .mach .needle.high { fill: var(--av-orange); stroke: var(--av-orange); }
  .mach .needle.full { fill: var(--av-red); stroke: var(--av-red); }
  .mach .hub { fill: var(--av-card); stroke: var(--av-fg-3); stroke-width: 1; }

  /* A reading still being fetched, kept apart from "-", which is an answer of
     nothing. Drawn in docs/mockups/nav-loading-states.html, chosen row B + C:
     a dash runs the dial's arc, and a placeholder breathes in the slot the
     value lands in, so nothing beside it moves when the value arrives. Labels
     never wait.

     The placeholder's widths are the slots': in .lim it sits inside .v, whose
     4.7ch min-width above is the slot; on a dial it is "00%" (3ch tabular); on
     the tickets opener two digits. */
  .bone { display: inline-block; height: 7px; border-radius: 3.5px; vertical-align: middle;
          background: var(--av-fg-3); opacity: .28; }
  .mach .v .bone { width: 3ch; }
  .lim .v .bone { width: 3.4ch; }
  .lim.wait > .bone { width: 5ch; }
  .lim .bmwrap .bone { display: block; width: 13px; height: 13px; border-radius: 50%; }
  .board-view .bone { width: 2ch; }
  /* Not a button until it is one: before the first auth poll there is no menu
     to open, so the waiting chip is the plain span, laid out as the button
     will be. */
  span.lim.wait { display: inline-flex; align-items: center; padding: 4px 8px; }
  span.lim.wait .bmwrap { width: 13px; height: 13px; margin-right: 6px; flex: none; }
  /* Invisible unless it moves, so reduced motion draws a still face and still
     placeholders rather than a dash parked somewhere on the arc. 35.5 extends
     beyond the half-arc's length (pi x 11), so the dash leaves at the redline end. */
  .mach .scan { fill: none; stroke: var(--av-fg-2); stroke-width: 1.6; stroke-linecap: round;
                stroke-dasharray: 5 40; stroke-dashoffset: 5; opacity: 0; }
  @media (prefers-reduced-motion: no-preference) {
    /* One period for both, so the bar beats as one rather than as several
       clocks. A placeholder that appears later starts its own phase. */
    .mach .scan { animation: nav-scan 1.6s ease-in-out infinite; }
    .bone { animation: nav-breathe 1.6s ease-in-out infinite; }
    @keyframes nav-scan {
      0% { stroke-dashoffset: 5; opacity: 0; }
      15% { opacity: .9; }
      85% { opacity: .9; }
      100% { stroke-dashoffset: -35.5; opacity: 0; }
    }
    @keyframes nav-breathe { 0%, 100% { opacity: .28; } 50% { opacity: .6; } }
  }

  /* The right-hand end, in reading order: what the panel reports, then the one
     button for what it is set to. Quiet toolbar buttons rather than pills,
     which is what the rest of the host's view headers look like. */
  /* flex: none against the tally's margin-right: auto: the actions are the
     end of the bar and never the thing that gives ground, so what runs out of
     room is the tally beside them and not the gear. */
  #nav-actions { flex: none; display: flex; align-items: center; gap: 2px; }
  #nav-actions .vr { width: 1px; height: 15px; margin: 0 5px;
                     background: var(--av-border); }
  /* The settings gear. Square and icon-sized, because it is the only control in
     this bar with no label — the three it replaced spent ~300px saying what
     they were, in a panel that is often 400px wide. */
  .gear { width: 24px; height: 24px; margin-left: 4px; flex: none; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
          border: none; border-radius: 5px; background: none;
          color: var(--av-fg); opacity: .68; }
  .gear:hover, .gear[aria-expanded="true"] { opacity: 1; background: var(--av-hover); }
  .gear.survey-pending { position: relative; opacity: 1; }
  .gear.survey-pending::after {
    content: ''; position: absolute; top: 2px; right: 2px;
    width: 6px; height: 6px; border-radius: 50%; background: var(--av-red); pointer-events: none;
  }

  /* Container queries follow the board, which the dock and divider narrow
     independently of the window. Filter labels remain visible at every width. */
  /* The two markers. A dial with its figure beside it is still the only thing
     in the bar shaped like a dial, so the word is the cheapest 72px here. */
  @container (max-width: 800px) {
    .mach .k { display: none; }
  }
  /* The figures. What is left is the angle, which is the part of a gauge that
     is read rather than parsed — and the tip carries the number. */
  @container (max-width: 700px) {
    .mach .v { display: none; }
    .mach { gap: 0; }
  }
  /* Half the plan readout. The week is the window that ends an evening; the
     5h one refills while you watch it, and its tip still counts both down. */
  @container (max-width: 600px) {
    .lim .w5 { display: none; }
  }
  /* Both dials. "Is this laptop the thing that is slow" is a question worth a
     glance and not worth the filter. */
  @container (max-width: 480px) {
    .mach, .vr.machv { display: none; }
  }
  /* The plan readout. Past here the bar is the three controls and nothing
     else, which is the floor: everything still on it is a thing to press.
     button.lim (accounts) sets display:inline-flex at (0,1,1); a bare .lim
     hide loses to it. #nav-actions .lim is (1,1,0) and covers span and button. */
  @container (max-width: 380px) {
    #nav-actions .lim, .vr.usagev { display: none; }
  }

`;
