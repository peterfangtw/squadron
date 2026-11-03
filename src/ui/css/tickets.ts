/** Ticket board, shared menus/tips/settings, card arrangement and empty states. */

export const css = /* css */ `
  #tk-head { gap: 12px; font-size: var(--av-fs-md); }
  #tk-source { flex: 0 1 auto; max-width: min(43cqw, 420px); min-width: 0; }
  #tk-actions { flex: none; margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .tkrefresh-note { color: var(--av-fg-2); font-size: var(--av-fs-md); white-space: nowrap; }
  #tk-actions .refresh:disabled, .tkconnect:disabled { opacity: .5; cursor: default; }
  #tk-source .scope-wrap { max-width: 100%; }
  #tk-source .scope-button { max-width: 100%; white-space: nowrap; opacity: 1; }
  #tk-source .scope-button .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  #tk-source .tmark { flex: none; }
  #tk-source .tmark svg { width: 13px; height: 13px; display: block; }
  #tk-filter:empty { display: none; }
  #tk-filter:not(:empty) { display: flex; flex: 1; flex-wrap: nowrap; align-items: center;
             gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; padding-block: 2px; }
  #tk-filter .fwrap { flex: none; }
  #tk-filter .fpill { white-space: nowrap; }
  #tk-source .fmenu { width: 320px; }
  #tk-source .fmenu:not([hidden]) { display: flex; flex-direction: column; }
  /* The filter pills and their menus. Not a <select>: the OS draws that one and
     the theme cannot reach inside it. */
  .fwrap { position: relative; display: inline-flex; }
  /* 25 tall, and the radius follows so the capsule stays a capsule. The same
     number and the same shape as .step on the ask layer — two capsules that
     look alike across two surfaces should not stop looking alike because only
     one of them was measured. */
  .fpill { font-family: inherit; font-size: var(--av-fs-md); display: inline-flex; align-items: center;
             gap: 5px; padding: 4px 11px; border-radius: 13px; cursor: pointer; color: inherit;
             border: 1px solid var(--av-border); background: none; opacity: .72; }
  .fpill:hover { opacity: 1; }
  .fpill.on { opacity: 1; border-color: var(--av-focus);
             background: var(--av-quote-bg); }
  .fpill[aria-expanded="true"] { opacity: 1; border-color: var(--av-focus); }
  .fpill .caret { font-size: var(--av-fs-md); opacity: .55; }
  /* The left here is the pre-measure default only: the script sets it in
     pixels on every open, having clamped the menu inside the panel. */
  /* max-width caps long option labels (workflow names, ticket filters) so a
     single row cannot stretch the menu across the board. Ellipsis needs
     min-width: 0 on .nm below — flex defaults to min-width: auto, which refuses
     to shrink past content and defeats overflow: hidden. */
  .fmenu { position: absolute; top: calc(100% + 5px); left: 0; z-index: 20; min-width: 178px;
             max-width: min(320px, calc(100vw - 24px));
             max-height: 260px; overflow-y: auto; padding: 4px; border-radius: 8px;
             border: 1px solid var(--av-menu-border);
             background: var(--av-menu-bg);
             color: var(--av-menu-fg);
             box-shadow: 0 6px 20px rgba(0, 0, 0, .35); }
  .fmenu[hidden] { display: none; }
  /* A picker's menu (picker.ts) is three bands: a search box, the block that
     scrolls, and the footer. The menu itself stops scrolling — it is a column
     that clips — so the footer cannot be scrolled off the way it was when the
     whole body was the scrollport. Everything else opensMenu serves, the
     settings gear, keeps the plain rule above.

     :not([hidden]) is load-bearing, not decoration. The rule above it is a
     class plus an attribute and this is two classes, so the two tie on
     specificity and the later display: flex wins — leaving every shut picker
     menu painted as an empty bordered box under its pill. Smoke caught that
     (panel.smoke.ts), which is what a real host is for. */
  .fmenu.pmenu:not([hidden]) { display: flex; flex-direction: column; overflow: hidden;
             max-height: min(340px, calc(100vh - 24px)); }
  /* The cap on how much list is shown at once, ~8 rows, after which it scrolls.
     min-height: 0, because a flex item refuses to shrink past its content
     otherwise and the cap would be the one thing it ignored. */
  .fscroll { min-height: 0; overflow-y: auto; max-height: 216px; }
  /* The footer band: Clear at one end, the menu's one action at the other, and
     a rule above them both. flex: none, so it keeps its height while the list
     above it gives way.

     Every colour on this band is mixed from a pair the element already owns —
     menu fg into menu bg for the quiet half, button fg into button bg for the
     filled one. Nothing here reads --av-border, which is --vscode-panel-border:
     a line measured against the *board* behind the menu, and on a stock dark
     theme darker than the dropdown it would be drawn on. Nothing reads
     --av-menu-border either, which stock Dark+ sets equal to the dropdown
     background — an edge the theme declines to draw, and the button nobody
     could see that was reported on the fork. A mix cannot collapse either way.
     The seven themes are measured in docs/mockups/menu-footer-buttons.html. */
  .ffoot { flex: none; display: flex; align-items: center; gap: 6px;
             margin-top: 4px; padding-top: 5px;
             border-top: 1px solid
               color-mix(in srgb, var(--av-menu-fg) 26%, var(--av-menu-bg)); }
  .ffoot[hidden] { display: none; }
  /* One shape for both and two ranks. Both are things to do to the list rather
     than rows of it, so both are buttons of one height on one row — a link-blue
     Clear beside a bordered New read as two different kinds of control. But only
     one of them leaves the menu, and a footer with exactly one action should have
     exactly one filled thing on it: the action takes the fill the panel already
     spends on a primary elsewhere (the composer's send, the dialog CTA) and
     Clear keeps the edge alone. Painted the same weight, neither was findable.

     24px is SC 2.5.8, which 4px of padding on a 12px line box misses by two. */
  .fbtn { font-family: inherit; font-size: var(--av-fs-md);
             display: inline-flex; align-items: center; min-height: 24px;
             padding: 3px 10px; border-radius: 5px; cursor: pointer;
             color: inherit; background: none;
             border: 1px solid
               color-mix(in srgb, var(--av-menu-fg) 55%, var(--av-menu-bg)); }
  .fbtn:hover { background:
               color-mix(in srgb, var(--av-menu-fg) 12%, var(--av-menu-bg)); }
  /* An outline rather than a border swap: the border is load-bearing here, so
     moving it to --av-focus on focus would take the edge away on any theme
     whose focus colour sits near its menu. */
  .fbtn:focus-visible { outline: 2px solid var(--av-focus); outline-offset: 1px; }
  .faction { margin-left: auto; font-weight: 600;
             color: var(--av-btn-fg);
             background: var(--av-btn-bg);
             border-color:
               color-mix(in srgb, var(--av-btn-fg) 35%, var(--av-btn-bg)); }
  .faction:hover { background:
               color-mix(in srgb, var(--av-btn-fg) 14%, var(--av-btn-bg)); }
  /* Border-box, both here and on .mitem: the panel has no global rule, so a
     100% width plus this padding and border would spill out of the menu. */
  /* 10px, not 7: with the tick column gone every band in this menu states its
     text at 15px from the menu's border — 4px of menu padding, then whatever
     the band spends. Here that is a 1px input border plus 10. */
  .fsearch { display: block; width: 100%; box-sizing: border-box; font-family: inherit;
             font-size: var(--av-fs-md); padding: 4px 10px; margin-bottom: 4px; border-radius: 5px;
             outline: none;
             border: 1px solid var(--av-border);
             background: var(--av-input-bg); color: var(--av-input-fg); }
  .fsearch:focus { border-color: var(--av-focus); }
  /* 5px, not 4: .fmenu is a 260px scroller, so the extra pixel costs no
     layout at all — one fewer row visible before it scrolls. And these are the
     only stacked targets in the panel that *touch*, which is where an
     undersized target stops meaning "missed" and starts meaning "wrong one". */
  .mitem { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
             text-align: left; font-family: inherit; font-size: var(--av-fs-md); padding: 5px 11px;
             border-radius: 5px; background: none; border: none; color: inherit;
             cursor: pointer; }
  /* :focus-visible, not :focus: opening a menu focuses its first row so the
     arrow keys have somewhere to start, and under :focus that read as a row
     the cursor was already hovering. Keyboard focus still paints. */
  .mitem:hover, .mitem:focus-visible { background: var(--av-list-hover); outline: none; }
  /* Drawn, dimmed and unpickable — a port something else is listening on. The
     gap is the information: a reader needs to see that it exists and is taken,
     not to wonder where it went. The sub column beside it names the holder. */
  .mitem.off { opacity: .45; cursor: default; }
  .mitem.off:hover, .mitem.off:focus-visible { background: none; }
  .mitem .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The inherited-model row outside the model menu's scroller: at the width
     cap the rule above cuts its label, so let the band grow instead. */
  .fmenu.mmodels > .mitem .nm { white-space: normal; overflow: visible; }
  /* Which single-select row is picked, said without a lead column: the row
     itself, filled. Why there is no tick gutter is menuItem's, in
     webview/kit.ts, where the .cbox decision it trades against lives.

     A 2px accent rail was tried and dropped on taste, 2026-08-27; the six
     no-rail alternatives and what each costs are in
     docs/mockups/model-menu-refine.html §1.

     24%, not 14%: at a wash it differs from the 5%-neutral hover in strength
     alone, which is not a difference under a moving pointer. At 24% it differs
     in hue and in strength, and the picked row's own hover steps past it again.
     Shape as well as colour, still: present-vs-absent fill, not hue alone.

     :not(.off) on the hover, because a picked row that has since been taken by
     something else is still .off, and .off:hover's "stay dark" is the older and
     the stronger promise — without it this rule outranks it on class count. */
  .mitem.pick.on { background: color-mix(in srgb, var(--av-link) 24%, transparent); }
  .mitem.pick.on:not(.off):hover, .mitem.pick.on:not(.off):focus-visible {
             background: color-mix(in srgb, var(--av-link) 32%, transparent); }
  /* Windows high contrast throws away the fill — a forced background is Canvas —
     and the ✓ this replaced was text, which survived. So the pick states itself
     a second way there, in a system colour, and only there. */
  @media (forced-colors: active) {
    .mitem.pick.on { outline: 2px solid Highlight; outline-offset: -2px; }
  }
  .mitem .cbox { width: 12px; height: 12px; box-sizing: border-box; flex: none;
             border-radius: 3px; font-size: var(--av-fs-md); line-height: 10px; text-align: center;
             border: 1px solid var(--av-muted); }
  .mitem.on .cbox { border-color: var(--av-focus);
             background: var(--av-focus); color: var(--av-btn-fg); }
  .mitem.on .cbox::after { content: "✓"; }
  .fnone { font-size: var(--av-fs-md); color: var(--av-fg-3); padding: 4px 11px; }
  .fsep { height: 1px; margin: 4px 2px; background: var(--av-border); }
  /* The sort half of a picker. The arrow is the only thing a *closed* pill can
     say about an ordering, which is why it rides in the pill rather than living
     in the menu: a sort with no mark on the control is one nobody remembers
     turning on. The glyph trails its label rather than leading it, so the sort
     block starts on the same left edge as the options above it. */
  .fpill .sarr { font-size: var(--av-fs-md); color: var(--av-link); }
  .mitem .dir { flex: none; color: var(--av-fg-3); }
  .mitem.on .dir { color: var(--av-link); }
  /* Clear and the picker's footer action are both .fbtn now, styled with the
     footer band above. What stood here was a link-blue Clear and a full-width
     row carrying a plus box, under the class name .mfoot — which the settings
     menu's own bare .mfoot further down this sheet silently overpainted, both
     of them being one class. The action is .faction now and the collision is
     gone with the name: VS Code calls the pressable thing in a menu footer
     quick-input-action, and this is the same thing said in this file's
     dialect. .mfoot below means the version stamp and nothing else. */

  /* The hover tip — the panel's own, in place of the host's title attribute,
     which draws at the OS size in the OS font wherever the host feels like
     putting it. Same surface as a menu, because it is the same kind of thing: a
     layer that hangs off an anchor and belongs to nothing underneath it.

     Fixed, so webview/tip.ts places it from the anchor's own rect with no
     positioned ancestor to find; a child of body, so a bar that morphs cannot
     take it away mid-read.

     pointer-events: none is load-bearing. A tip the pointer can enter can be
     entered *off its own anchor*, which fires the mouseout that closes it,
     which puts the pointer back over the anchor — a flicker with no bottom to
     it. Nothing in this layer is ever clicked, so nothing is lost. */
  .tip { position: fixed; z-index: 60; pointer-events: none;
         max-width: 280px; padding: 5px 9px; border-radius: 6px;
         font-size: var(--av-fs-md); line-height: 1.45;
         border: 1px solid var(--av-menu-border);
         background: var(--av-menu-bg); color: var(--av-menu-fg);
         box-shadow: 0 6px 20px rgba(0, 0, 0, .35); }
  /* A phrase: as wide as the words, up to the point where a tooltip stops being
     one. Most are short and draw on one line without being told to; the ones
     that are whole sentences — a permission mode, a cwd, what a half of an
     empty group does — wrap at the 280px above instead of running off the
     panel, which is the half a title attribute never did. pre-line, so the two
     that already carry their own break keep it.

     Named phrase and not chip, which is what it used to be: the composer
     declares a top-level .chip and is joined into this sheet after this file,
     so at equal specificity every property both rules set was painted by the
     composer's — its card surface, its thumbnail's asymmetric padding, and a
     max-width of 100% in place of the 280 above. See .shotchip in css/chat.ts,
     which is the same collision and the same fix. */
  .tip.phrase { white-space: pre-line; }
  /* A readout: two columns, so the keys are scanned rather than the sentence
     read. Tabular figures for the reason the .lim readout has them — this
     counts down, and proportional digits jitter as they change. */
  .tip .rows { display: grid; grid-template-columns: auto auto; gap: 2px 12px;
         font-variant-numeric: tabular-nums; }
  .tip .rows .k { align-self: center;
         font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .05em;
         color: var(--av-fg-3); }
  .tip .rows .v { text-align: right; }
  /* The reading's own rank, carried across from the bar: the number that is red
     in .lim is red in the row explaining it. Same two classes, same colours. */
  .tip .rows .v.high { color: var(--av-orange); }
  .tip .rows .v.full { color: var(--av-red); }
  .tip .hd { margin-bottom: 3px;
         font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
         color: var(--av-fg-3); }

  /* The settings menu: the same shell as every other menu, wider, because its
     rows carry a sentence each. Both switches write a hook into
     ~/.claude/settings.json, and a tooltip is where that fact went to die. */
  .smenu { width: 268px; }
  /* The gear's own cap, which the accounts popover states for itself two files
     up — \`:not(.accts)\` is already how panel.smoke.ts spells "the gear's menu".

     \`max-height: none\` stood here from the commit that made the gear, when this
     menu was three rows and a swatch strip. At nine rows, two drill rows and a
     version stamp it runs off the bottom of a 1350px panel, and an absolute
     menu that overflows the viewport is not a scroller — it is a menu with its
     foot cut off, the theme swatches unreachable.

     **59 is measured in a real engine, not derived from #nav's 40px.** The menu
     hangs off \`.fwrap\`, not off the bar, so \`top: calc(100% + 5px)\` resolves
     against an inline wrap's own box: 43px, and #nav's height is only one of the
     things that decides it. The rest is this box's chrome, which \`max-height\`
     does not count — .fmenu is content-box (the 268px above is a content width,
     and border-box here would redraw the menu 10px narrower), so 8px of padding
     and 2px of border sit outside the cap. 43 + 10 + 6 = 59, the 6 being the
     inset every other layer keeps off the panel edge (LAYER_INSET,
     webview/dom.ts). Headless Chromium, 520px tall: the menu draws to 512 of
     520 and scrolls its full 634px of rows. Being a few px out costs a few px
     of gap and nothing else.

     Not min(70vh, 420px), which is what .smenu.accts and .fmenu.mmodels spend:
     those are lists, where scrolling is the normal state. This scrolls only
     when the window cannot hold it — at 760px tall it still does not.

     The bar is hidden because what was asked for is an invisible scroller, so
     nothing here may come to rely on its being seen. \`scrollbar-width\` and not
     ::-webkit-scrollbar, which is dead in this document (css/base.ts). It takes
     no layout either way: offsetWidth - clientWidth stays 0. */
  .smenu:not(.accts) { max-height: calc(100vh - 59px); overflow-y: auto;
             scrollbar-width: none; }
  .mhead { font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .08em;
             color: var(--av-fg-3); padding: 7px 11px 3px; }
  .mrule { height: 1px; margin: 5px 2px; background: var(--av-menu-border); opacity: .6; }
  .mrow { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;
             text-align: left; font-family: inherit; font-size: var(--av-fs-md); padding: 6px 11px;
             border-radius: 5px; background: none; border: none; color: inherit;
             cursor: pointer; }
  .mrow:hover, .mrow:focus-visible { background: var(--av-list-hover); outline: none; }
  .mrow .txt { flex: 1; min-width: 0; }
  .mrow .t { display: block; }
  .mrow .d { display: block; margin-top: 1px; line-height: 1.35;
             font-size: var(--av-fs-sm); color: var(--av-fg-3); }
  /* How finished a switch is, beside its name. Outlined rather than filled: a
     caveat on the label is not a second state of the control, and a solid chip
     here reads as loud as the switch. */
  .mrow .tag { margin-left: 6px; padding: 0 4px; border-radius: 3px;
             border: 1px solid var(--av-border); font-size: var(--av-fs-sm);
             text-transform: uppercase; letter-spacing: .06em;
             color: var(--av-fg-3); }
  /* The switch. A checkbox would be the OS's to draw, and the theme cannot
     reach inside that one — the same reason none of these menus is a <select>. */
  .sw { position: relative; flex: none; width: 26px; height: 15px; border-radius: 8px;
             background: var(--av-border); }
  .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
             border-radius: 50%; background: var(--av-fg-3); transition: transform .12s; }
  .sw.on { background: var(--av-focus); }
  .sw.on::after { transform: translateX(11px); background: var(--av-btn-fg); }

  /* A settings row whose value is picked in a menu of its own, and that menu.
     The row is an .mrow like the switches beside it — same padding, same
     sentence — and everything here is what the switch does not have.

     The wrap exists because the flyout cannot be a child of the row, which is
     a <button> and may hold no buttons of its own. */
  .mwrap { display: block; }
  .mrow .val { flex: none; display: inline-flex; align-items: center; gap: 6px;
             font-size: var(--av-fs-md); color: var(--av-fg-2); }
  /* Right-pointing, not the down-caret .fpill spends: down means a list drops
     under this control, and what happens here is a second menu beside it. */
  .mrow .val .into { width: 0; height: 0; opacity: .55; border: 3.5px solid transparent;
             border-left-color: currentColor; margin-left: 1px; }
  /* The row whose flyout is standing open. It has to stay lit while the pointer
     is somewhere else entirely, which :hover cannot say — the same job
     .fpill[aria-expanded="true"] already does for a pill, so it borrows that
     treatment rather than inventing a second one.

     Named drilled and not open: .open is spent three times in these sheets
     already (.fold.open, .tool.open, .wflow.live.open) and none of them is
     scoped. */
  .mrow.drilled { background: var(--av-list-hover); }
  .mrow.drilled .val { color: var(--av-fg); }
  .mrow.drilled .val .into { opacity: 1; }
  /* The flyout itself: an .fmenu placed by script rather than by this rule, so
     top and left are both overwritten on every open. The shadow is deeper than
     the menu it hangs off, which in the clamped placement — flyout over parent
     — is the only thing saying which of the two is in front.

     **fixed, not absolute, and that is the whole rule.** Every .fmenu sets
     overflow-y: auto so a long one scrolls, and an overflow on one axis
     clips the other — so a flyout positioned outside its parent's left edge is
     painted by nobody and clickable by nobody. It drew as a menu that opened
     onto blank board; the panel's own scenario suite could not see it, because
     jsdom clips nothing. Fixed takes it out of the parent's scroll box
     altogether, and the placement is already in viewport coordinates.

     border-box, because the clamped placement is handed the parent's *outer*
     width and .fmenu carries 4px of padding and a border on each side — so
     content-box drew the one flyout that is supposed to match its parent 10px
     wider than it, hanging off its right edge. */
  .fmenu.fly { position: fixed; box-sizing: border-box; min-width: 210px;
             box-shadow: 0 10px 30px rgba(0, 0, 0, .5); }

  /* Theme presets as swatches: the pick is a pick of colour, and colour is read
     faster than "Slate Lift" is. Each chip is its preset's own canvas against
     its own foreground, so the row is a legend for what the click will do. */
  .swatches { display: flex; flex-wrap: wrap; gap: 6px; padding: 3px 8px 6px; }
  .sws { width: 42px; padding: 0; cursor: pointer; overflow: hidden; border-radius: 5px;
             background: none; border: 1px solid var(--av-menu-border); }
  .sws .hue { display: block; height: 24px; }
  .sws .cap { display: block; padding: 2px 0 3px; text-align: center;
             font-size: var(--av-fs-sm); color: var(--av-fg-3); }
  .sws:hover { border-color: var(--av-muted); }
  .sws.on { border-color: var(--av-focus); box-shadow: 0 0 0 1px var(--av-focus); }
  .sws.on .cap { color: var(--av-fg); }
  /* Literal colours, not tokens: every swatch but "follow" has to show a preset
     the panel is not currently painted in, so there is nothing to inherit. The
     pairs are each block's own ground and the accent that theme reads as —
     which is its --av-blue on the four cool presets and its --av-focus on neon
     and the three retro ones. **The swatch is the theme's vibe, not any one
     token**: mario is a blue body with a red nose, so it previews blue, while
     its --av-focus is the nose. Reading the rule as "always --av-focus" and
     repainting these to match is a change that was made once and reverted —
     see the note on --av-focus in css/base.ts.

     Scoped under .sws rather than left as bare .c-* classes: two of these were
     silently overpainted by a same-specificity rule further down the sheet, and
     a descendant selector is what stops the next one. */
  .sws .c-follow { background: linear-gradient(135deg,
             var(--av-bg) 50%, var(--av-fg) 50%); }
  .sws .c-ink      { background: linear-gradient(135deg, #0a0a0b 58%, #4c8dff 58%); }
  .sws .c-lift     { background: linear-gradient(135deg, #1e2126 58%, #6ea8fe 58%); }
  .sws .c-paper    { background: linear-gradient(135deg, #ffffff 58%, #0a66c2 58%); }
  .sws .c-neon     { background: linear-gradient(135deg, #060809 58%, #2ee6a8 58%); }
  .sws .c-polaroid  { background: linear-gradient(135deg, #f7f4ed 58%, #e31c23 58%); }
  .sws .c-mario     { background: linear-gradient(135deg, #0b1a33 58%, #3d9eff 58%); }
  .sws .c-nightcity { background: linear-gradient(135deg, #08080c 58%, #fcee0a 58%); }
  .sws .c-arasaka   { background: linear-gradient(135deg, #0c0808 58%, #ff003c 58%); }
  .sws .c-malachite { background: linear-gradient(135deg, #082e25 58%, #7ba05b 58%); }
  /* The build, last thing in the menu and label-sized: a stamp on the panel,
     not a setting. No hover and no cursor — nothing here is pressable, and a
     row that lights up under the pointer promises otherwise. */
  .mfoot { display: flex; align-items: baseline; gap: 6px; padding: 6px 8px 4px;
             font-size: var(--av-fs-sm); color: var(--av-fg-3); }
  .mfoot .ver { margin-left: auto; font-variant-numeric: tabular-nums; }
  #tk-list { flex: 1; min-height: 0; min-width: 0; overflow: auto; display: flex;
             flex-direction: column; gap: 7px; background: var(--av-bg); }
  /* The gutter is on the children: .tkcolumns scrolls out to the board's edges,
     so padding here would clip tickets short of them. */
  #tk-list > .tkstale, #tk-list > .tk { margin-inline: var(--board-gutter); }
  /* Colour, not opacity: the connect button inside this block is a filled CTA
     and was being faded along with the sentence explaining it. */
  .tkempty { color: var(--av-fg-2); font-size: var(--av-fs-lg); margin: auto; text-align: center; padding: 0 22px;
             line-height: 1.6; display: flex; flex-direction: column; gap: 12px; align-items: center; }
  .tkconnect { font-family: inherit; font-size: var(--av-fs-md); padding: 5px 14px; border-radius: 6px;
               cursor: pointer; border: 1px solid var(--av-focus);
               background: var(--av-btn-bg); color: var(--av-btn-fg); }
  /* The way out of a filter that matched nothing. Quiet, and deliberately not
     .tkconnect: this is a correction, and a second filled button would cost the
     one place in this tab that has earned one. The surface is .tk's, shared
     rather than retyped — see there. */
  .tkclear { font-family: inherit; font-size: var(--av-fs-md); padding: 4px 13px;
             min-height: 24px; border-radius: 6px; cursor: pointer; color: var(--av-fg);
             border: 1px solid var(--av-border); }
  .tkclear:hover { border-color: var(--av-focus); }
  .tkclear:focus-visible { outline: 2px solid var(--av-focus); outline-offset: 1px; }
  .tkstale { flex: none; padding: 6px 10px; border-radius: 4px; font-size: var(--av-fs-md);
             color: var(--av-orange); background: var(--av-quote-bg); }

  /* The track owns horizontal scrolling; each column's body scrolls vertically
     so its status and count stay visible without a second rendering loop. */
  .tkcolumns { flex: 1; min-height: 0; display: flex; gap: 14px; overflow: auto;
               padding: 0 var(--board-gutter); scroll-padding-inline: var(--board-gutter); }
  .tkcolumns:focus-visible { outline: 2px solid var(--av-focus); outline-offset: -2px; }
  .tkcolumns > .lane { flex: 0 0 272px; min-width: 0; display: flex; flex-direction: column; }
  .tkcolumns > .lane.shut { flex-basis: 40px; }
  /* md: a status name is mixed case, and sm is the uppercase overline's floor.
     No top padding: the title starts where a session group's h2 does under the
     same head, and 8px + .lbody's 2px is h2's 10px to its grid. */
  .lane > .lhead { display: flex; align-items: center; gap: 7px; cursor: pointer;
             flex: none; width: 100%; padding: 0 2px 8px;
             background: var(--av-bg); font-family: inherit; font-size: var(--av-fs-md);
             border: 0; text-align: left;
             font-weight: 600;
             color: var(--av-fg-2); user-select: none; }
  .lane > .lhead:hover { color: var(--av-fg); }
  .lane > .lhead:focus-visible { outline: 2px solid var(--av-focus); outline-offset: -2px; }
  .lane > .lhead .caret { flex: none; display: inline-flex; opacity: .7; margin-left: auto; }
  .lane > .lhead .caret svg { display: block; }
  .lane > .lhead .lname { min-width: 0; overflow-wrap: anywhere; }
  .lane > .lhead .ln { flex: none; font-weight: 400; color: var(--av-fg-3);
             font-variant-numeric: tabular-nums; }
  .lane.shut > .lhead { height: fit-content; max-height: 100%;
             writing-mode: vertical-rl; text-orientation: mixed; gap: 10px;
             padding: 12px 10px; border-radius: 6px; background: var(--av-card); }
  .lane.shut > .lhead:hover { background: var(--av-list-hover); }
  .lane.shut > .lhead .caret { display: none; }
  .lane.shut > .lhead .lname { min-height: 0; white-space: nowrap; overflow: hidden;
             text-overflow: ellipsis; }
  .lane > .lbody { min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
             gap: 7px; padding: 2px 2px 7px; }
  .lane > .lbody > .tk { flex: none; overflow-wrap: anywhere; }
  .lane.shut > .lbody { display: none; }

  /* --av-rim switches off in light themes, where border and shadow separate cards. */
  .tk, .tkclear { background: linear-gradient(var(--av-rim), var(--av-rim)), var(--av-lift);
        box-shadow: inset 0 1px 0 var(--av-rim), 0 1px 3px var(--av-shadow-1); }
  .tk { border: 1px solid var(--av-border); border-radius: 8px; padding: 8px 10px;
        display: flex; flex-direction: column;
        gap: 4px; box-sizing: border-box; text-align: left;
        font: inherit; color: var(--av-fg); cursor: pointer; }
  /* --av-focus, not --av-link: .card:hover is the focus colour on the border it
     already has, and "the pointer is here" is one colour in this panel or it is
     noise. */
  .tk:hover { border-color: var(--av-focus); }
  .tk .tkid { font-size: var(--av-fs-md); color: var(--av-fg-2); display: flex; align-items: center; gap: 6px;
        font-variant-numeric: tabular-nums; }
  .tk .tktitle { font-size: var(--av-fs-lg); font-weight: 500; line-height: 1.35; }

  /* Linear's five levels, each its own dot: 0 None is hollow — no priority set,
     rather than a low one — and 1..4 fill from red down to blue. The same .dot
     box the statuses use, paint that has nothing to do with them. */
  /* The priority dot, on a card and on the menu row that filters to it. One
     selector list rather than two copies: a row that marked a priority
     differently from the card it selects would be two vocabularies for one
     thing. No priority is the hollow ring — an absence, drawn as one. */
  .tk .dot, .mitem .dot { background: none; box-shadow: inset 0 0 0 1px var(--av-muted); }
  .tk .dot.tone-urgent, .mitem .dot.tone-urgent { background: var(--av-red); box-shadow: none; }
  .tk .dot.tone-high, .mitem .dot.tone-high { background: var(--av-orange); box-shadow: none; }
  .tk .dot.tone-medium, .mitem .dot.tone-medium { background: var(--av-yellow); box-shadow: none; }
  .tk .dot.tone-low, .mitem .dot.tone-low { background: var(--av-blue); box-shadow: none; }

  .tk:focus-visible { outline: 2px solid var(--av-focus); outline-offset: -2px; }
  .tk { transition: border-color .12s ease-out; }

  /* Arranging the cards. A group's grid is positioned so its insertion bar can
     be drawn over it without joining the flow and shifting the slots it is
     aiming between. Only the group grids: a family's inner grid carries no cwd,
     and nothing is ever drawn over one. */
  .grid[data-cwd] { position: relative; }

  /* The handle. A loose card is its own; a family box is picked up by its
     header only, so a press inside a member card is that card's press. The
     header's own link keeps the pointer it had — it is somewhere to go. */
  #cards .card[draggable="true"] { cursor: grab; }
  #cards .fam[draggable="true"] > .fam-head { cursor: grab; }
  body.dragging-card #cards .card,
  body.dragging-card #cards .fam-head { cursor: grabbing; }
  #cards .fam-head button.who { cursor: pointer; }

  /* The slot being carried. Not hidden: it keeps its place until the drop, so
     nothing reflows under a gesture that is still being aimed. The cards inside
     a lifted box stay at full strength — the box is what is being moved. */
  #cards .lifted { opacity: var(--av-ghost); }
  #cards .lifted .card { opacity: 1; }

  /* Not the source group. A group is a directory and no drag can change a
     running process's cwd, so the other grids dim and their dragover never
     calls preventDefault() — the browser's own no-drop cursor explains it. */
  #cards [data-inert] { opacity: var(--av-dim); filter: saturate(.4); }
  #cards [data-inert] * { pointer-events: none; }

  /* 3px in a 10px gutter, with a lozenge at each end so the insertion line
     reads as a caret rather than a card border. Positioned against its grid. */
  .ins { position: absolute; width: 3px; border-radius: 2px; background: var(--av-focus);
         box-shadow: 0 0 0 1px var(--av-bg); pointer-events: none;
         display: none; z-index: 5; }
  .ins::before, .ins::after {
    content: ''; position: absolute; left: 50%; width: 7px; height: 7px; margin-left: -3.5px;
    border-radius: 50%; background: var(--av-focus); }
  .ins::before { top: -3px; }
  .ins::after { bottom: -3px; }
  body.dragging-card .ins.on { display: block; }

  /* A family's interior takes no card drop: the bar snaps to the box's leading
     or trailing edge, never between two members. */
  body.dragging-card #cards .fam .grid { pointer-events: none; }

  /* Option B: a bar that appears only when sessions are blocked, naming each
     as a chip that jumps to it. No chrome cost at zero waiting.

     **This is the why for the float; the other three sites point here.**
     As a row of #cards it was list content: the grid dropped 16px + its own
     height the moment a session blocked, and it scrolled away with the list —
     which is the one bar that has to still be there when the reader is three
     screens down. So: absolute against #board-body (css/shell.ts), the box
     holding what it covers, at that box's --body-pad and inset to the board
     gutter. Nothing above the body enters the offset.

     z-index 6 is the whole of the stacking argument, and it is narrower than it
     looks. Above .ins (5), which is the only z-index inside #cards. Below the
     bottom hub (12), the menus (20) and the scrims (30-33) — and 20 was the first
     answer here, which is wrong: .fmenu is also 20, and #alert is later in
     #board's stacking context, so the settings gear's own menu opened *under*
     this bar for as long as anything was blocked. */
  #alert { position: absolute; z-index: 6;
           top: var(--body-pad); left: var(--board-gutter); right: var(--board-gutter);
           display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
           max-height: 40vh; overflow-y: auto;
           padding: 8px 12px; border-radius: 6px;
           background: var(--av-warn-bg);
           border: 1px solid var(--av-warn-border);
           box-shadow: 0 4px 14px rgba(0, 0, 0, .32); }
  /* Its own display, so the attribute has to be restated — the same trap
     #nav[hidden] and #ask[hidden] already work around. */
  #alert[hidden] { display: none; }
  body.dragging-card #alert { pointer-events: none; }
  #alert .lead { display: inline-flex; align-items: center; gap: 6px; font-weight: 600;
                 font-size: var(--av-fs-lg); color: var(--av-orange);
                 font-variant-numeric: tabular-nums; }
  #alert .lead svg { display: block; }
  .schip { font-family: inherit; font-size: var(--av-fs-md); padding: 3px 9px; border-radius: 12px;
           cursor: pointer; white-space: nowrap; color: var(--av-fg);
           background: var(--av-card);
           border: 1px solid var(--av-warn-border); }
  .schip:hover { border-color: var(--av-orange); }
  .schip .why { color: var(--av-fg-3); }
  .schip.more { border-style: dashed; }
  @media (prefers-reduced-motion: no-preference) {
    #alert .lead svg { animation: breathe 2.4s ease-in-out infinite; }
    @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  }

  /* flex: none, like every sibling here. #thread is flex: 1 off a zero basis, so
     it absorbs none of the column's shrink and squashing lands on whatever is
     left with an auto one. */

  #ticket-detail { padding: var(--board-dialog-top) 16px 16px; }
  #ticket-detail .ticket-detail { max-width: 640px; max-height: 100%; display: flex;
    flex-direction: column; color: var(--av-menu-fg); }
  #ticket-detail .ashead { display: block; flex: none; padding: 12px 16px 14px; min-width: 0; }
  .td-tools { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: var(--av-fs-md); }
  /* The id, because .ashead b ties on specificity and css/auth.ts joins later. */
  #ticket-detail .td-tools b { font-size: var(--av-fs-md); font-weight: 400; color: var(--av-fg-2); }
  .td-external { border: 0; background: none; color: var(--av-link); cursor: pointer;
    min-height: 28px; font: inherit; padding: 0 4px; }
  .td-external:hover { text-decoration: underline; }
  #ticket-detail .ax { min-width: 28px; min-height: 28px; }
  /* color and display answer the bare h2 in css/shell.ts, a group heading's. */
  #ticket-detail .td-title { display: block; color: inherit; font-size: var(--av-fs-lg); font-weight: 600;
    line-height: 1.35; text-transform: none; letter-spacing: 0; margin: 10px 0 14px; max-height: 5.4em;
    overflow-y: auto; overflow-wrap: anywhere; }
  .td-fields { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 0; font-size: var(--av-fs-md); }
  .td-fields > div { display: flex; gap: 8px; min-width: 0; }
  .td-fields dt { color: var(--av-fg-2); }
  .td-fields dd { margin: 0; overflow-wrap: anywhere; }
  #ticket-detail .td-description { min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    padding: 16px; font-size: var(--av-fs-lg); line-height: 1.5; scrollbar-gutter: stable; }
  .td-description .body { max-width: 75ch; overflow-wrap: anywhere; }
  /* A ticket is a document where a chat turn is not, so .body's chat spacing
     opens up here. One heading size, because the scale tops out at the prose. */
  .td-description .body :is(p, ul, ol, pre, blockquote, table) { margin-block: 10px; }
  .td-description .body :is(h1, h2, h3, h4, h5, h6) { margin: 20px 0 6px; color: inherit; }
  .td-description .body > :first-child { margin-top: 0; }
  .td-description .body > :last-child { margin-bottom: 0; }
  .td-notice { margin: 0 0 12px; font-size: var(--av-fs-md); color: var(--av-fg-2); }
  .td-retry { min-height: 28px; padding: 4px 12px; border: 1px solid var(--av-border);
    border-radius: 4px; color: var(--av-fg); background: var(--av-card); font: inherit;
    font-size: var(--av-fs-md); cursor: pointer; }
  .td-retry:hover { border-color: var(--av-focus); }
  #ticket-detail :focus-visible { outline: 2px solid var(--av-focus); outline-offset: 2px; }
  #ticket-detail .td-title:focus-visible { outline-offset: -2px; }
  @container (max-width: 420px) {
    #ticket-detail { padding: var(--board-dialog-top) 8px 12px; }
    #ticket-detail .ashead, #ticket-detail .td-description { padding: 12px; }
  }
`;
