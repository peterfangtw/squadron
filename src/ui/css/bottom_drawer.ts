/**
 * The bottom drawer: the frame, its slots, and the column modes.
 * Row, flight and detail rules are css/workflows_mode.ts.
 */

export const css = /* css */ `
  /* The bar's own chrome — the handle, and what it does while the
     sheet is up — is in css/bottom_hub.ts, where the rest of #bottomhub is. It was
     here, which put four blocks about the bar eight files after the bar's own
     sheet: nothing collided, but a \`transition\` added to bottom_hub.ts would have
     been overridden from here without a word. */
  @media (prefers-reduced-motion: no-preference) {
    #bottomdrawer { transition: translate 180ms cubic-bezier(.2, .7, .3, 1),
                          display 180ms allow-discrete; }
    #bottomdrawer[hidden] { translate: 0 100%; }
    @starting-style { #bottomdrawer:not([hidden]) { translate: 0 100%; } }
  }

  /* The sheet. Its own backdrop, never #scrim — that one belongs to
     question.ts down to the click that dismisses it, and resume.ts and
     runpicker.ts both already refused to share it; #bottomdrawer-scrim names itself after
     #pscrim / #rscrim, which made the same refusal.

     22/23 and not the PRD's 20/21: #cafe is 20 (css/cafe.ts) and a portalled
     .fmenu is 20 as well (css/tickets.ts), so 20 ties with both and a tie
     resolves by document order — not something to rest a backdrop on. 22/23 is
     above the cup and still under #scrim (30), #ask (31) and #picker (33).

     **Deliberately below the ask layer, where #picker and #runsheet are above
     it.** Those two sit at 33 over backdrops at 32 because each *is* a question
     being asked; this is a list being managed, and a real question must cover
     it. Do not "fix" the inconsistency.

     translateX is absent here on purpose — the sheet is inset from both edges
     rather than centred — but it is still a stacking context by z-index, and a
     .fmenu opened on a row is portalled for the overflow of #bottomdrawer-body rather
     than for a transform. */
  #bottomdrawer-scrim { position: absolute; inset: 0; z-index: 22; background: rgba(0, 0, 0, .45); }
  /* A portalled menu outranks the sheet it was opened in.
     .fmenu.floating is moved to <body> (kit.ts, wireMenu's portal) and ranks at
     root, where css/tickets.ts gives it 20 — under #bottomdrawer-scrim (22) and #bottomdrawer
     (23). So the row's own Edit / Duplicate / Delete drew *behind* the sheet,
     invisible and unclickable, and jsdom could not see it because jsdom paints
     nothing. 25 is above the sheet and above the chick (24, css/mascot.ts),
     and still under the lightbox (26) and #scrim (30), so a pending question
     covers both. It lifts every .fmenu.floating.

     \`position: fixed; top: auto\` is the other half of this selector, and it
     was declared in css/board.ts for a model menu on a card that no longer
     exists — the specs line is a span again and the menu is the composer's now.
     One selector, one surface, one block: the only .fmenu.floating the panel
     builds is a workflow-canvas chip menu (webview/wfcanvas.ts holds the codebase's sole
     \`opensMenu(..., true)\`). The \`top: auto\` is there because the unscoped
     .fmenu in css/tickets.ts pins \`top: calc(100% + 5px)\`, and on a *fixed*
     box that 100% is the viewport rather than the wrap. Only one other menu
     hits it that way (.mnmenu, css/composer.ts); the three upward-opening ones
     reset top for the ordinary reason, because they set bottom. Taskhub H65. */
  .fmenu.floating { position: fixed; top: auto; z-index: 25; }
  #bottomdrawer { position: absolute; left: 12px; right: 12px; bottom: 0; z-index: 23;
            max-height: min(62%, 460px); display: flex; flex-direction: column;
            border-radius: 12px 12px 0 0;
            border: 1px solid var(--av-menu-border); border-bottom: 0;
            background: var(--av-menu-bg); color: var(--av-menu-fg);
            box-shadow: 0 -14px 40px rgba(0, 0, 0, .5); }
  #bottomdrawer-scrim[hidden], #bottomdrawer[hidden] { display: none; }

  /* The grab bar, so the sheet says it can be pulled shut before anyone tries. */
  #bottomdrawer .pull { flex: none; width: 34px; height: 3px; border-radius: 999px;
                  margin: 7px auto 3px; background: var(--av-fg-3); opacity: .5; }

  #bottomdrawer-head { flex: none; display: flex; align-items: center; flex-wrap: wrap; row-gap: 2px;
            gap: 9px; padding: 5px 12px 9px; border-bottom: 1px solid var(--av-border); }
  #bottomdrawer-head .ttl { font-weight: 600; font-size: var(--av-fs-lg); flex: none; }
  #bottomdrawer-head .x { flex: none; margin-left: auto; min-width: 24px; min-height: 24px; border: 0; background: none;
               color: var(--av-fg-3); cursor: pointer; font-size: var(--av-fs-md); line-height: 1; }
  #bottomdrawer-head .x:hover { color: var(--av-fg); }

  /* Two columns, one grid, two scrollers. The list column is a geometry the
     steps can never reflow: they are drawn beside it rather than inside it, so
     selecting a row moves nothing the pointer is resting on. Nothing writes a
     height here — the list is the only column with a say in how tall this is,
     and \`contain: size\` on .bddetail below is what says so.
     The tracks are custom properties so a mode resizes a column without a
     second grid. Workflows and Warm grow the list and stop the detail at 44%. */
  #bottomdrawer { --bd-list: minmax(0, 1fr); --bd-detail: minmax(0, 44%); }
  #bottomdrawer-body { min-height: 120px; padding: 6px 6px 8px; position: relative;
            display: grid; grid-template-columns: var(--bd-list) var(--bd-detail);
            gap: 8px; overflow: hidden; }
  /* \`position: relative\` is the drag's, not the layout's: the drop line is
     absolute inside this column and the rows' \`offsetTop\` is read against it,
     so the line rides the scroll instead of being repainted on every frame of
     one. */
  #bottomdrawer-body .bdlist { min-height: 0; overflow-y: auto; position: relative; }
  /* \`contain: size\` is what makes the *list* the only column with a say in how
     tall the body is. #bottomdrawer is bottom-anchored with a cap and no height, so
     below that cap its height is its content and it grows from the top edge —
     and without this a twelve-step selection would lift every row, which is the
     reflow the steps left the list to avoid, arriving in the other axis. Size
     containment drops this column's contents out of that measurement; it takes
     the row's height and scrolls inside it. The min-height above is the other
     half: on a machine with two workflows the list is 70px, and a detail column
     that short is not worth reading. */
  #bottomdrawer-body .bddetail { min-height: 0; contain: size; overflow-y: auto;
                      padding: 2px 4px 0 10px;
                      border-left: 1px solid var(--av-border); }
  /* Same tracks as #bottomdrawer-body, so the field ends where the list does. The right
     cell stays empty and the two columns still start together under it. */
  #bottomdrawer-find { flex: none; min-width: 0; display: grid;
            grid-template-columns: var(--bd-list) var(--bd-detail);
            gap: 8px; padding: 6px 6px 0; }
  #bottomdrawer-filter { grid-column: 1; width: 100%; min-width: 0; box-sizing: border-box;
              margin: 0; padding: 4px 8px; font: inherit;
              font-size: var(--av-fs-md); color: var(--av-fg);
              background: var(--av-input-bg); border: 1px solid var(--av-border);
              border-radius: 5px; }
  #bottomdrawer-foot { flex: none; display: flex; align-items: center; gap: 10px;
            padding: 7px 12px; border-top: 1px solid var(--av-border);
            font-size: var(--av-fs-md); color: var(--av-fg-3); }

  /* Remote's messengers are a short list. Cap that column and let setup take
     the width. The percentage is the cap on a narrow sheet, so the fields
     keep a column. */
  #bottomdrawer.remote { --bd-list: min(260px, 42%); --bd-detail: minmax(0, 1fr); }

  /* Size containment would clip the detail column. Column modes grow the
     frame up to the shared cap, then scroll. */
  #bottomdrawer.columns { overflow: hidden; }
  #bottomdrawer.columns #bottomdrawer-body { flex: 1 1 auto; min-height: 0; }
  #bottomdrawer.columns .bddetail { contain: none; }
  #bottomdrawer.columns .bdlist { display: flex; flex-direction: column; overflow: hidden; }
  #bottomdrawer.columns .bdlist > .column-head { flex: none; }
  #bottomdrawer.warm .sessions, #bottomdrawer.remote .messengers { flex: 1; min-height: 0; overflow-y: auto; }
  #bottomdrawer.warm .bdlist > .mrow { flex: none; border-top: 1px solid var(--av-border);
                                 border-radius: 0; padding: 10px 11px; }
  #bottomdrawer.remote .bdlist > .mrow { flex: none; border-bottom: 1px solid var(--av-border);
                                   border-radius: 0; padding: 10px 11px; }
  #bottomdrawer.remote .pinned { flex: none; border-top: 1px solid var(--av-border);
                           padding-bottom: 10px; }
  /* Keep-awake has no inner scroller: the tile and two switches are short, so
     the list column scrolls whole if the sheet is ever that low. */
  #bottomdrawer.awake .bdlist { overflow-y: auto; }
  #bottomdrawer.awake .bdlist > .mrow { flex: none; border-radius: 0; padding: 10px 11px; }
  #bottomdrawer.awake .bdlist > .mhead { flex: none; padding: 12px 11px 0; }
  #bottomdrawer.awake .bdlist > .mhead + .mrow { min-height: 32px; padding: 4px 11px; }
  /* The master switch carries the hold: state beside its name, why as its
     detail, the lease as a hairline on its foot — the cup's level, flattened.
     Tones are the card's hues. */
  #bottomdrawer.awake .bdlist > .awake-now { position: relative; padding-bottom: 14px; }
  #bottomdrawer.awake .awake-now .name { font: inherit; }
  #bottomdrawer.awake .awake-now .state { display: inline-flex; align-items: center; gap: 5px;
                    margin-left: 8px; font-weight: 400; font-size: var(--av-fs-md);
                    color: var(--av-fg-2); font-variant-numeric: tabular-nums; }
  #bottomdrawer.awake .awake-now .dot { --dot: 6px; background: var(--st, var(--av-fg-3)); }
  #bottomdrawer.awake .awake-now[data-tone="on"] { --st: var(--av-green); }
  #bottomdrawer.awake .awake-now[data-tone="held"] { --st: var(--av-orange); }
  #bottomdrawer.awake .awake-now[data-tone="held"] .state { color: var(--av-orange); }
  #bottomdrawer.awake .awake-now .left::before { content: "· "; }
  #bottomdrawer.awake .awake-now .bar { position: absolute; left: 11px; right: 11px; bottom: 4px;
                    height: 2px; border-radius: 1px; overflow: hidden;
                    background: color-mix(in srgb, var(--av-fg) 10%, transparent); }
  #bottomdrawer.awake .awake-now .bar i { display: block; height: 100%; background: var(--av-focus); }
  #bottomdrawer.awake .awake-cfg { display: grid; grid-template-columns: minmax(0, 1fr) auto;
                    gap: 3px 12px; align-items: center; padding: 7px 0;
                    border-top: 1px solid var(--av-border); font-size: var(--av-fs-md); }
  #bottomdrawer.awake .column-head + .awake-cfg { border-top: 0; }
  #bottomdrawer.awake .awake-cfg .label { display: flex; align-items: center; gap: 6px;
                    min-width: 0; font-weight: 400; }
  #bottomdrawer.awake .awake-cfg .val { grid-column: 2;
                    font-variant-numeric: tabular-nums; white-space: nowrap; }
  #bottomdrawer.awake .awake-cfg-note { margin: 10px 0 0; color: var(--av-fg-2);
                    font-size: var(--av-fs-md); line-height: 1.5; }
  /* Agents: two equal columns, the switches as Warm's rows in Keep-awake's
     own-scroll list. The master's On/Off sits beside its name, as Keep-awake's
     state does. The verbs are a read-only name/line table; the gated group
     dims and carries the refusal while Orchestration is off. */
  #bottomdrawer.agents { --bd-list: minmax(0, 1fr); --bd-detail: minmax(0, 1fr); }
  #bottomdrawer.agents .bdlist { overflow-y: auto; }
  #bottomdrawer.agents .bdlist > .mrow { flex: none; border-radius: 0; padding: 10px 11px;
                    border-top: 1px solid var(--av-border); }
  #bottomdrawer.agents .bdlist > .column-head + .mrow { border-top: 0; }
  #bottomdrawer.agents .mrow.master .t .state { margin-left: 8px; font-weight: 400;
                    font-size: var(--av-fs-md); color: var(--av-fg-2); }
  #bottomdrawer.agents .mrow.master .t .state::before { content: ""; display: inline-block;
                    width: 6px; height: 6px; border-radius: 50%; margin-right: 5px;
                    vertical-align: 1px; background: var(--av-fg-3); }
  #bottomdrawer.agents .mrow.master .t .state.on::before { background: var(--av-green); }
  #bottomdrawer.agents .group { margin: 2px 0 10px; }
  #bottomdrawer.agents .ghead { display: flex; align-items: baseline; gap: 8px; padding: 6px 0 4px;
                    font-size: var(--av-fs-md); font-weight: 600; color: var(--av-fg); }
  #bottomdrawer.agents .ghead .when { font-weight: 400; color: var(--av-fg-3); }
  #bottomdrawer.agents .verb { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px;
                    align-items: baseline; padding: 5px 0; border-top: 1px solid var(--av-border);
                    font-size: var(--av-fs-md); }
  #bottomdrawer.agents .ghead + .verb { border-top: 0; }
  #bottomdrawer.agents .verb code { font-family: var(--vscode-editor-font-family);
                    font-size: var(--av-fs-md); color: var(--av-fg); }
  #bottomdrawer.agents .verb .what { color: var(--av-fg-2); line-height: 1.45; }
  #bottomdrawer.agents .group.gated.off .verb { opacity: .45; }
  #bottomdrawer.agents .refusal { margin: 6px 0 0; padding: 7px 9px; border-radius: 6px;
                    font-size: var(--av-fs-md); line-height: 1.5; color: var(--av-fg-2);
                    background: color-mix(in srgb, var(--av-fg) 5%, transparent); }
  #bottomdrawer.agents .refusal q { color: var(--av-fg); }
  /* #bottomdrawer-foot sets display:flex, which beats the hidden attribute. */
  /* display:grid on #bottomdrawer-find beats the hidden attribute, as display:flex does on the foot. */
  #bottomdrawer-find[hidden], #bottomdrawer-foot[hidden], #bottomdrawer-note[hidden] { display: none; }
  #bottomdrawer-note { flex: 1 0 100%; padding: 0; color: var(--av-fg-2); font-size: var(--av-fs-md); }
  /* A directory name is a name. .mhead uppercases every other menu head. */
  #bottomdrawer .mhead { font-weight: 600; color: var(--av-fg-2); }
  #bottomdrawer .mhead.dir { font-size: var(--av-fs-md); font-weight: 400;
                            text-transform: none; letter-spacing: 0; padding-top: 9px; }
  /* Caps over the rows: at a row name's size a head reads as one more row.
     Both heads line up across the rule: the detail column's 2px top padding
     comes off its head's margin. */
  #bottomdrawer.columns .column-head { display: flex; align-items: baseline;
                              justify-content: space-between; gap: 12px;
                              margin: 6px 11px 4px; }
  #bottomdrawer.columns .bddetail .column-head { margin: 4px 0 4px; }
  #bottomdrawer.columns .column-title { margin: 0; font-size: var(--av-fs-sm); font-weight: 600;
                               text-transform: uppercase; letter-spacing: .08em;
                               color: var(--av-fg-2); }
  /* Right edge over what it counts. */
  #bottomdrawer.columns .column-head .summary { font-size: var(--av-fs-md); font-weight: 400; color: var(--av-fg-2);
                                       font-variant-numeric: tabular-nums; }
  #bottomdrawer.columns .column-head .summary:empty { display: none; }
  #bottomdrawer.warm .ttl-field { display: grid; grid-template-columns: minmax(0, 1fr) auto;
                            gap: 3px 12px; align-items: center; padding: 7px 0;
                            font-size: var(--av-fs-md); }
  #bottomdrawer.warm .ttl-field .label { display: flex; align-items: center; gap: 6px;
                                  min-width: 0; }
  #bottomdrawer.warm .ttl-field .bmwrap { flex: none; width: 13px; height: 13px; }
  #bottomdrawer.warm .ttl-field .bmwrap svg { display: block; width: 13px; height: 13px; }
  /* 14px of ink, 24px of target: the ::before claims the gap, the same way
     .icon does, so the row stays the height of the label. */
  #bottomdrawer .why { position: relative; flex: none; display: inline-flex;
                 align-items: center; justify-content: center;
                 width: 14px; height: 14px; margin: 0; padding: 0;
                 border: 0; background: none; color: var(--av-fg-3);
                 cursor: help; line-height: 0; }
  #bottomdrawer .why::before { content: ''; position: absolute; inset: -5px; }
  #bottomdrawer .why:hover { color: var(--av-fg); }
  #bottomdrawer.warm .ttl-field .minutes { grid-column: 2; grid-row: 1; display: inline-flex;
                                     align-items: center; gap: 5px;
                                     font-variant-numeric: tabular-nums;
                                     color: var(--av-fg); }
  /* Three digits wide: the largest bound is 480. The --av-input-* names are
     the host's --vscode-input-* under the default theme, and each Squadron
     theme's own field colours otherwise. */
  #bottomdrawer.warm .ttl-field .num { width: calc(3ch + 14px); box-sizing: border-box;
                                 padding: 2px 6px; border-radius: 4px; text-align: right;
                                 font: inherit; font-variant-numeric: tabular-nums;
                                 color: var(--av-input-fg);
                                 background: var(--av-input-bg);
                                 border: 1px solid var(--av-input-border); }
  #bottomdrawer.warm .ttl-field .num:focus { outline: 1px solid var(--av-focus);
                                       outline-offset: -1px;
                                       border-color: var(--av-focus); }
  #bottomdrawer.warm .ttl-field .unit { color: var(--av-fg-2); }
  #bottomdrawer.warm .ttl-field.buffer { border-top: 1px solid var(--av-border);
                                   margin-top: 9px; padding-top: 14px; }
  #bottomdrawer.columns .mrow { width: 100%; min-height: 48px; text-align: left; }
  #bottomdrawer.columns .mrow .txt { min-width: 0; }
  #bottomdrawer.columns .mrow :is(.t, .d) { white-space: normal;
                                                 overflow-wrap: anywhere; }
  #bottomdrawer.columns .mrow .d { font-size: var(--av-fs-md); line-height: 1.5; }
  #bottomdrawer.warm .mrow .d { font-variant-numeric: tabular-nums; }
  #bottomdrawer.columns .fnone { padding: 24px 11px; font-size: var(--av-fs-md); }
  /* Remote's messengers: the ticket filter's drilled row, the mark first and
     the link's dot before its word. The mark is drawn at the size .bdetail
     draws a brand (css/auth.ts); one not built yet goes grey with its label. */
  #bottomdrawer.remote .messengers { container: remote-messengers / inline-size; }
  #bottomdrawer.remote .mrow.pick { display: grid; grid-template-columns: 14px max-content minmax(0, 1fr);
                              gap: 4px 10px; }
  #bottomdrawer.remote .mrow.pick .t { white-space: nowrap; }
  #bottomdrawer.remote .mrow.pick .val { display: block; min-width: 0; white-space: normal;
                                   overflow-wrap: anywhere; text-align: right; line-height: 1.5; }
  #bottomdrawer.remote .mrow.pick .val .mdot { display: inline-block; vertical-align: middle; margin-right: 6px; }
  #bottomdrawer.remote .mrow.pick .val .into { display: inline-block; vertical-align: middle; margin-left: 6px; }
  @container remote-messengers (max-width: 240px) {
    #bottomdrawer.remote .mrow.pick { grid-template-columns: 14px minmax(0, 1fr); }
    #bottomdrawer.remote .mrow.pick .val { grid-column: 2; text-align: left; }
  }
  #bottomdrawer.remote .mrow.pick .bmwrap, #bottomdrawer.remote .mrow.pick .bmwrap svg {
    flex: none; display: block; width: 14px; height: 14px; }
  #bottomdrawer.remote .mrow.pick[aria-disabled="true"] .bmwrap { filter: grayscale(1); opacity: .5; }
  #bottomdrawer.remote .mdot { flex: none; width: 6px; height: 6px; border-radius: 50%;
                         box-sizing: border-box; background: var(--st, transparent); }
  #bottomdrawer.remote .mdot.pending { --st: var(--av-blue); }
  #bottomdrawer.remote .mdot.live { --st: var(--av-green); }
  #bottomdrawer.remote .mdot.fault { --st: var(--av-red); }
  #bottomdrawer.remote .mdot.off { border: 1px solid var(--av-fg-3); }
  #bottomdrawer.remote .mdot.elsewhere { border: 1px solid var(--av-fg-2); }
  #bottomdrawer.remote .mdot.unset { border: 1px solid var(--av-yellow); }
  /* What is said under the switch. The warning box is the board's orange at
     a border's weight: a caution, not a failure. */
  #bottomdrawer.remote :is(.remote-reason, .remote-refused, .remote-hint) {
    margin: 8px 11px 0; font-size: var(--av-fs-md); line-height: 1.5; overflow-wrap: anywhere; }
  #bottomdrawer.remote .remote-reason { color: var(--av-fg-2); }
  #bottomdrawer.remote .remote-refused { color: var(--av-red); }
  #bottomdrawer.remote .remote-hint { color: var(--av-fg-3); }
  #bottomdrawer.remote .remote-warn { display: flex; align-items: center; gap: 10px;
                                margin: 8px 11px 0; padding: 8px 10px; border-radius: 5px;
                                border: 1px solid color-mix(in srgb, var(--av-orange) 50%, transparent);
                                font-size: var(--av-fs-md); line-height: 1.5; }
  #bottomdrawer.remote .remote-warn .txt { flex: 1; min-width: 0; }
  #bottomdrawer.remote .remote-warn .fbtn { flex: none; }
  /* The right column: sections in Warm's .ttl-field type, each row a label,
     a value and its presses. */
  #bottomdrawer.remote .sect + .sect { margin-top: 14px; }
  #bottomdrawer.remote .column-head .lead { display: flex; align-items: center; gap: 6px; }
  #bottomdrawer.remote .field { display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
                          gap: 3px 10px; align-items: center; padding: 5px 0;
                          font-size: var(--av-fs-md); }
  #bottomdrawer.remote .field .k { display: flex; align-items: center; gap: 6px; min-width: 0;
                             overflow-wrap: anywhere; }
  #bottomdrawer.remote .field .v { color: var(--av-fg-3); }
  #bottomdrawer.remote .field .v.set { color: var(--av-fg); }
  #bottomdrawer.remote .field .acts { display: flex; gap: 6px; }
  #bottomdrawer.remote .field .fbtn { padding: 1px 8px; }
  #bottomdrawer.remote .fbtn[aria-disabled="true"] { opacity: .55; cursor: default; }
  #bottomdrawer.remote .fbtn.danger { color: var(--av-warn-border); border-color: var(--av-warn-border); }
  #bottomdrawer.remote .remote-id .k { font-family: var(--vscode-editor-font-family, monospace); }
  #bottomdrawer.remote .remote-forget { display: flex; justify-content: flex-end; gap: 6px; }
  #bottomdrawer.remote .remote-forget .ask { color: var(--av-warn-border); margin-right: auto; }
  #bottomdrawer.remote .remote-x { border: 0; background: none; color: var(--av-fg-3); cursor: pointer;
                             min-width: 24px; min-height: 24px; padding: 0; line-height: 0;
                             display: inline-grid; place-items: center; }
  #bottomdrawer.remote .remote-x:hover { color: var(--av-fg); }
  #bottomdrawer.remote .remote-allow { display: flex; gap: 8px; padding: 5px 0; }
  #bottomdrawer.remote .remote-allow input { flex: 1; min-width: 0; box-sizing: border-box;
                                       padding: 3px 7px; border-radius: 4px; font: inherit;
                                       font-size: var(--av-fs-md); color: var(--av-input-fg);
                                       background: var(--av-input-bg);
                                       border: 1px solid var(--av-input-border); }
  #bottomdrawer.remote .remote-allow input::placeholder { color: var(--av-fg-3); }
  #bottomdrawer.remote .remote-allow input:focus { outline: 1px solid var(--av-focus);
                                             outline-offset: -1px; border-color: var(--av-focus); }
  #bottomdrawer.remote .remote-failed { margin: 4px 0 0; color: var(--av-red);
                                  font-size: var(--av-fs-md); }
  /* An account or a space the messenger cannot use: the row's id struck in
     red, and why on its own line under it. */
  #bottomdrawer.remote .remote-id.bad .k { color: var(--av-red); text-decoration: line-through; }
  #bottomdrawer.remote .remote-problem { margin: 0 0 4px; color: var(--av-red);
                                   font-size: var(--av-fs-md); line-height: 1.5;
                                   overflow-wrap: anywhere; }
  #bottomdrawer.remote .remote-space .v.set { font-family: var(--vscode-editor-font-family, monospace); }
  #bottomdrawer.remote .remote-found { display: flex; align-items: center; gap: 10px; margin: 0 0 4px;
                                 font-size: var(--av-fs-md); color: var(--av-fg-2); }
  #bottomdrawer.remote .remote-found .txt { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  #bottomdrawer.remote .remote-found .fbtn { flex: none; padding: 1px 8px; }
  /* The check: one verdict row, and under a check that did not pass, the
     steps as a checklist. A step's mark is its number until the check says
     done or failed. */
  #bottomdrawer.remote .verdict .k { font-weight: 500; }
  #bottomdrawer.remote .verdict.ok .k { color: var(--av-green); }
  #bottomdrawer.remote .verdict.bad .k { color: var(--av-red); }
  #bottomdrawer.remote .verdict.warn .k { color: var(--av-orange); }
  #bottomdrawer.remote .verdict:is(.busy, .todo) .k { color: var(--av-fg-2); }
  #bottomdrawer.remote .checklist { margin: 2px 0 0 6px; padding-left: 10px;
                              border-left: 1px solid var(--av-border); }
  #bottomdrawer.remote .mk { flex: none; width: 14px; text-align: center;
                       font-variant-numeric: tabular-nums; color: var(--av-fg-3); }
  #bottomdrawer.remote .mk.st-done { color: var(--av-green); }
  #bottomdrawer.remote .mk.st-failed { color: var(--av-red); }
  #bottomdrawer.remote .gstep.st-done .stepname { color: var(--av-fg-2); }
  /* Interactions: labelled, empty, and plainly a placeholder. */
  #bottomdrawer.remote .slot { margin-top: 4px; padding: 14px 12px; border-radius: 6px;
                         border: 1px dashed var(--av-border); text-align: center;
                         color: var(--av-fg-3); font-size: var(--av-fs-md); }
  /* held and cold are the card's own cache heat (.since.warm, .since.cold in
     css/board.ts), so a row and its card never disagree about one cache. */
  #bottomdrawer .st.next { color: var(--av-fg-2); }
  #bottomdrawer .st.held { color: var(--av-orange); }
  #bottomdrawer .st.cold { color: var(--av-red); font-weight: 600; }
  #bottomdrawer .st.no, #bottomdrawer .st.quiet { color: var(--av-fg-3); }
  /* A switch that refuses: aria-disabled rather than disabled, so the row
     still takes focus and its reason is read. Only the press is dead. */
  #bottomdrawer .mrow[aria-disabled="true"] { cursor: default; }
  #bottomdrawer .mrow[aria-disabled="true"]:hover { background: none; }
  #bottomdrawer .mrow[aria-disabled="true"] .t { color: var(--av-fg-3); }
  #bottomdrawer .mrow[aria-disabled="true"] .sw { opacity: .4; }
  /* The configuration column is 44% of the board. Below this it cannot hold
     the minutes beside the name, so the figure drops under the label. */
  @container (max-width: 560px) {
    #bottomdrawer.warm .bddetail { padding-left: 8px; padding-right: 4px; }
    #bottomdrawer.warm .ttl-field { grid-template-columns: 1fr; gap: 3px; }
    #bottomdrawer.warm .ttl-field .minutes { grid-column: 1; grid-row: auto; margin-top: 3px; }
  }


  #bottomdrawer.routines { --bd-list: min(240px, 38%); --bd-detail: minmax(0, 1fr);
    font-size: var(--av-fs-md); }
  #bottomdrawer.routines .bdlist { overflow-y: auto; }
  #bottomdrawer.routines :is(.bdlist, .bddetail) > .empty { color: var(--av-fg-2); line-height: 1.5; }
  .routine-row { display: grid; grid-template-columns: minmax(0, 1fr) 24px;
    gap: 4px; padding: 9px 8px; border-radius: 6px; }
  .routine-row.sel { background: var(--av-hover); }
  .routine-row.paused .routine-select { color: var(--av-fg-3); }
  .routine-select { text-align: left; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    background: none; border: 0; color: inherit; font: inherit; cursor: pointer; }
  .routine-meta { display: block; font-size: var(--av-fs-md); line-height: 1.5; color: var(--av-fg-3); margin-top: 4px; }
  .routine-row .routine-small { min-height: 24px; justify-self: start; color: var(--av-fg-3);
    background: none; border: 0; font: inherit; cursor: pointer; }
  .routine-enable { display: flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; cursor: pointer; }
  .routine-row-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
  .routine-editor { display: flex; flex-direction: column; gap: 12px; padding: 4px 6px 12px; min-width: 0; overflow-wrap: anywhere; }
  .routine-editor input, .routine-editor select { min-height: 28px; min-width: 0; box-sizing: border-box;
    font: inherit; color: var(--av-fg); background: var(--av-input-bg); border: 1px solid var(--av-input-border); border-radius: 5px; padding: 4px 6px;
    color-scheme: dark; }
  body:is([data-theme="paper"], [data-theme="polaroid"], .vscode-light[data-theme="follow"]) .routine-editor :is(input, select) { color-scheme: light; }
  .routine-name { width: 100%; }
  .routine-input { padding: 0; }
  .routine-input .compose-editor { min-height: 90px; max-height: 190px; overflow-y: auto; }
  .routine-cadence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .routine-cadence .num { width: 72px; }
  .routine-timezone, .routine-status, .routine-save, .routine-last { color: var(--av-fg-3); font-size: var(--av-fs-md); white-space: normal; }
  .routine-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .routine-actions .routine-save { margin-left: auto; }
  .routine-actions button, .routine-association button, .routine-error button { min-height: 28px; }
  .routine-actions [data-routine-run] { color: var(--av-btn-fg, var(--vscode-button-foreground)); background: var(--vscode-button-background); }
  .routine-error { color: var(--av-red); font-size: var(--av-fs-md); display: flex; flex-wrap: wrap; gap: 8px; }
  .routine-error:empty { display: none; }
  .routine-association { font-size: var(--av-fs-md); }
  .routine-association button + button { margin-left: 8px; }
  .routine-editor [hidden] { display: none; }
  @container board (max-width: 480px) {
    #bottomdrawer.routines { --bd-list: min(160px, 34%); }
    .routine-row { padding-inline: 2px; }
    .routine-editor { padding-inline: 0; }
  }
`;
