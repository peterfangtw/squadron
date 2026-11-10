/** Composer, ask layer, resume picker, permission dialogs, inline attach pills. */

export const css = /* css */ `
  /* The composer is one object — a box you type into, with what rides on the
     next send stacked above it — so the rhythm belongs to the container rather
     than to each child. One gap, and one rule for the empty child: a child
     paying for the space beneath it pays when it has nothing to say too, which
     is what every :not(:empty) guard here was working around. */
  #composer { flex: none; display: flex; flex-direction: column; gap: 6px;
              padding: 7px 14px 10px; }
  /* div and not *: an empty textarea has no child nodes either, and #input is
     the one box here that must survive having nothing in it. */
  #composer > div:empty { display: none; }
  #chat { container: chat / inline-size; }

  /* The box itself — the host's own .chat-input-container, on our tokens: the
     border, the radius, the background and the focus ring belong to a container
     that holds the attachments, the text and the send row, rather than to the
     textarea alone. That is the difference between one object and three stacked
     ones, and it is the whole of what the reader sees change.

     cursor:text, with the press handler in webview/composer.ts, is what makes it
     read as one input: clicking anywhere that is not a control puts the caret in
     the box.

     The radius token is guarded — it is 8px, but newer than the ^1.95.0 floor in
     engines.vscode, so the literal rides as the fallback. */
  .shell { display: flex; flex-direction: column; gap: 6px; position: relative;
           box-sizing: border-box; width: 100%; cursor: text;
           padding: 6px 6px 5px;
           border-radius: var(--vscode-cornerRadius-large, 8px);
           background: color-mix(in srgb, var(--av-fg) 6%, var(--av-lift));
           box-shadow: inset 0 1px 0 var(--av-rim), 0 1px 3px var(--av-shadow-1);
           border: 1px solid var(--av-input-border); }
  /* The fill is a step off --av-lift rather than --av-input-bg, and that swap is
     the whole of why: on a dock raised to --av-lift the host's input background
     is BELOW the surface around it on six of the nine presets — -7 on lift and
     mario, -6 on nightcity — so the box you type in would have sunk into the
     slab it sits on. Restated as a step it comes out +10 or better on every
     dark preset and -11 on the two light ones, which is the direction each
     wants. The arithmetic, per preset: docs/mockups/dock-layers.html §4.

     --ring is what the box outlines itself in when focused, and it is a custom
     property so that the state below can recolour one layer instead of
     restating three. Custom properties cascade by specificity, so .shell.queues
     (0,2,0) beats this (0,1,0) with no dependence on which is written first. */
  .shell { --ring: var(--av-focus); }
  .shell:focus-within { border-color: var(--ring);
                        box-shadow: 0 0 0 1px var(--ring), inset 0 1px 0 var(--av-rim),
                                    0 6px 16px -4px var(--av-shadow-3); }
  /* What the send button beside it wears, on the box the text is being typed
     into: amber is "staged, not gone" everywhere in this composer, and the
     reader is looking at the box rather than at the button when they decide
     whether to press Enter. Border only — a tint across the whole typing
     surface dims the text riding on it, and the box is the largest object in
     the dock, so 16% of amber over all of it is the loudest thing on screen for
     a state that is only "this send waits". The button beside it carries the
     fill.

     It takes --ring with the border, and has to: the focus ring is a shadow
     layer as well as a border now, so amber on the border alone would leave a
     queued box that is focused wearing a blue hairline immediately outside it —
     the same tie this rule settles, one layer further out. Recolouring the
     token settles both at once, and drops the ordering this rule used to need
     against :focus-within. */
  .shell.queues { --ring: var(--av-orange); border-color: var(--av-orange); }
  /* The formatting toolbar over the text, as docs/mockups/composer-formatting.html
     draws it: 28px controls, over the 24px floor SC 2.5.8 puts under a pointer
     target, and a hairline under the row so it reads as the box's chrome rather
     than as a line of the message. cursor: default, since the shell's
     text cursor would promise a caret the gaps between controls do not place. */
  .formatbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
               padding-bottom: 4px; border-bottom: 1px solid var(--av-border);
               cursor: default; }
  .formatbar .formatgroup { display: inline-flex; align-items: center; gap: 2px; flex: none; }
  .formatbar .formatgroup + .formatgroup { border-left: 1px solid var(--av-border); padding-left: 6px; }
  .formatbar .format { display: inline-flex; align-items: center; justify-content: center;
                       width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px;
                       background: none; color: var(--av-fg-3); cursor: pointer; }
  .formatbar .format:hover { color: var(--av-fg); background: var(--av-hover); }
  .formatbar .format[aria-pressed='true'] { color: var(--av-link);
    background: color-mix(in srgb, var(--av-link) 16%, transparent); }
  /* aria-disabled rather than disabled: a disabled button leaves the arrow
     walk, and Chromium sends it no mouseover, so its tip could not say why. */
  .formatbar .format[aria-disabled='true'] { opacity: .4; cursor: not-allowed;
                                             background: none; }
  .formatbar .format:focus-visible { outline: 1px solid var(--av-focus); outline-offset: -1px; }
  /* The same rule #composer carries, one level down and for the same reason: a
     child paying for the space beneath it pays when it has nothing to say. */
  .shell > div:empty { display: none; }

  /* The pending ask, as a layer over the card column rather than a block in the
     composer. The composer is the narrowest box in the panel and #dock is
     capped at half of it, so this column is never the smaller of the two — and
     the width is what a described option list and a preview actually need.

     The scrim covers the column entire, nav bar and waiting strip included.
     That is deliberate: it makes a filter menu and this layer impossible to
     have open at once, which is why neither needs a handle to arbitrate. The
     way back in is the composer's launcher, which the scrim never reaches.

     Not a token: a scrim dims whatever is behind it rather than being a colour
     the theme owns, the same reason .fmenu's shadow is a literal. */
  #scrim { position: absolute; inset: 0; z-index: 30; background: rgba(0, 0, 0, .45); }
  /* A content-box cap excludes padding and border and lets the footer cross
     the board's bottom clearance. */
  #ask { position: absolute; top: var(--board-dialog-top); left: 18px; right: 18px;
         max-height: calc(90% - var(--board-dialog-top)); box-sizing: border-box; z-index: 31;
         display: flex; flex-direction: column; overflow-x: auto;
         padding: 13px 15px; border-radius: 8px;
         border: 1px solid var(--av-menu-border);
         background: var(--av-menu-bg);
         color: var(--av-menu-fg);
         box-shadow: 0 8px 26px rgba(0, 0, 0, .45); }
  /* Both carry a display of their own, so the hidden attribute has to be
     restated — the same trap #nav[hidden], #chat[hidden] and
     .fmenu[hidden] already work around. */
  #scrim[hidden], #ask[hidden] { display: none; }
  @container (max-width: 420px) {
    #ask, #ticket-detail { --board-dialog-top: 12px; }
  }

  /* The resume picker, over the board. Its own backdrop rather than #scrim,
     which the ask layer owns down to the click that dismisses it. Narrower and
     higher than #ask: this is a list to scan, not a question to read, and it is
     opened from a slot in the grid rather than from the composer. */
  #pscrim { position: absolute; inset: 0; z-index: 32; background: rgba(0, 0, 0, .45);
    backdrop-filter: var(--sheet-blur); }
  #picker { position: absolute; top: 12%; left: 50%; transform: translateX(-50%);
            width: min(440px, calc(100% - 36px)); max-height: 70%; z-index: 33;
            display: flex; flex-direction: column; overflow: hidden;
            border-radius: 8px; border: 1px solid var(--av-menu-border);
            background: var(--av-menu-bg); color: var(--av-menu-fg);
            box-shadow: 0 14px 40px rgba(0, 0, 0, .5); }
  #pscrim[hidden], #picker[hidden] { display: none; }
  #phead { display: flex; align-items: baseline; gap: 8px; padding: 9px 11px;
           border-bottom: 1px solid var(--av-border); }
  #phead .ttl { font-weight: 600; font-size: var(--av-fs-md); }
  #phead .cw { margin-left: auto; font-size: var(--av-fs-md); color: var(--av-fg-3);
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pfilter { margin: 8px 9px 0; box-sizing: border-box; width: calc(100% - 18px);
             font-family: inherit; font-size: var(--av-fs-md); padding: 6px 8px;
             border-radius: 5px; background: var(--av-input-bg); color: var(--av-input-fg);
             border: 1px solid var(--av-input-border); }
  #pfilter:focus { outline: 1px solid var(--av-focus); }
  #plist { overflow-y: auto; padding: 6px 5px; }
  .pnote { padding: 10px 8px; font-size: var(--av-fs-md); color: var(--av-fg-3); }
  .pit { display: flex; gap: 9px; align-items: flex-start; padding: 7px 8px;
         border-radius: 6px; cursor: pointer; }
  .pit .bmwrap { flex: none; width: 13px; height: 13px; margin-top: 2px; }
  .pit .bmwrap svg { display: block; width: 13px; height: 13px; }
  .pit:hover { background: var(--av-hover); }
  /* The row the arrows rest on, which Enter takes. An outline rather than a
     background, so hover and selection can be told apart while both are on. */
  .pit.on { outline: 1px solid var(--av-focus); outline-offset: -1px; }
  .pit .bd { flex: 1; min-width: 0; }
  .pit .t { font-size: var(--av-fs-md); overflow: hidden; text-overflow: ellipsis;
            white-space: nowrap; }
  /* A prompt standing in for a title: the whole mark, so the row reads as a
     quotation before it is read at all. Nothing tags it a second time. */
  .pit .t.said { font-style: italic; color: var(--av-fg-2); }
  .pit .m { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 2px;
            font-size: var(--av-fs-md); color: var(--av-fg-3); }
  .pit .m .b { color: var(--av-fg-2); }
  /* Which checkout of the repository, when it is not the folder asked about.
     The checkout's own name, never the path to it (ui/text.ts) — a path spends
     its width on what every worktree of a repo shares. Still capped, since a
     name is as long as whoever cut it made it and this line wraps, so an
     uncapped one grows the row rather than being clipped by the column. */
  .pit .m .w { max-width: 22ch; overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; opacity: .8; }
  /* Running: pressable like any other row, and the host answers by revealing
     that card rather than by starting a second child on one transcript. */
  .pit .now { flex: none; align-self: center; font-size: var(--av-fs-sm);
              text-transform: uppercase; letter-spacing: .06em; color: var(--av-green);
              border: 1px solid var(--av-green); border-radius: 999px; padding: 1px 6px;
              opacity: .75; }
  /* The next page, last in the list so the arrows reach it like a row. */
  .pmore { padding: 7px 8px; border-radius: 6px; cursor: pointer;
           font-size: var(--av-fs-md); color: var(--av-fg-2); }
  .pmore:hover { background: var(--av-hover); }
  .pmore.on { outline: 1px solid var(--av-focus); outline-offset: -1px; }
  #pfoot { display: flex; gap: 12px; padding: 6px 11px; border-top: 1px solid var(--av-border);
           font-size: var(--av-fs-md); color: var(--av-fg-3); }
  #pfoot b { color: var(--av-fg-2); font-weight: 600; }

  /* The servers sheet, a third layer on the resume picker's terms: its own
     backdrop and the same sheet geometry. Inside it is a rail of a repo's
     worktrees beside everything the selected one can start. */
  #rscrim { position: absolute; inset: 0; z-index: 32; background: rgba(0, 0, 0, .45);
            backdrop-filter: var(--sheet-blur); }
  #runsheet { position: absolute; top: 6%; left: 50%; transform: translateX(-50%);
              width: min(660px, calc(100% - 36px)); max-height: 88%; z-index: 33;
              display: flex; flex-direction: column;
              border-radius: 8px; border: 1px solid var(--av-menu-border);
              background: var(--av-menu-bg); color: var(--av-menu-fg);
              box-shadow: 0 14px 40px rgba(0, 0, 0, .5);
              /* Not a viewport query: the board this sits over is one column of
                 a panel the reader drags, so the only width worth answering is
                 the sheet's own. Same reasoning as the card's. */
              container-type: inline-size; container-name: rsheet; }
  #rscrim[hidden], #runsheet[hidden] { display: none; }
  #rhead { display: flex; align-items: center; gap: 8px; padding: 8px 11px;
           border-bottom: 1px solid var(--av-border); }
  #rhead .ttl { font-weight: 600; font-size: var(--av-fs-md); min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #rhead .cw { flex: 0 1 auto; min-width: 0; margin-left: auto; font-size: var(--av-fs-md);
               color: var(--av-fg-3); overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; }
  #rbody { display: flex; min-height: 0; }
  .rnote { font-size: var(--av-fs-md); color: var(--av-fg-3); }

  .srail { flex: none; width: 216px; box-sizing: border-box; display: flex;
           flex-direction: column; gap: 1px; padding: 8px; overflow-y: auto;
           border-right: 1px solid var(--av-border); }
  .srail .cap { font-size: var(--av-fs-label); color: var(--av-fg-3); padding: 6px 9px 3px; }
  .srail .cap:first-child { padding-top: 0; }
  .sstarts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
           padding: 10px 12px 12px; overflow-y: auto; }
  .sshead { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 6px;
            font-size: var(--av-fs-md); }
  .sshead b { font-weight: 600; white-space: nowrap; }
  .sshead span { min-width: 0; font-size: var(--av-fs-sm); color: var(--av-fg-3);
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sstarts .rnote { padding: 0 2px 4px; }

  /* A worktree. Centred rather than baseline-aligned: the row is taller than its
     line, and a baseline group parks at the top of what it sits in. */
  .rstart { font: inherit; font-size: var(--av-fs-md); text-align: left; padding: 3px 9px;
            min-height: 28px; border-radius: 7px; cursor: pointer; border: 1px solid transparent;
            background: transparent; color: var(--av-fg-2);
            display: flex; align-items: center; gap: 6px; }
  .rstart .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .rstart:hover { background: var(--av-card); color: var(--av-fg); }
  .rstart.on { color: var(--av-fg);
               border-color: color-mix(in srgb, var(--av-blue) 42%, var(--av-border));
               background: color-mix(in srgb, var(--av-blue) 7%, var(--av-card)); }
  .rstart .np { flex: none; margin-left: auto; font-size: var(--av-fs-sm); color: var(--av-fg-3);
                font-variant-numeric: tabular-nums; }
  .rstart .np.bad { color: var(--av-red); }
  /* Worst state of a worktree, or a start's own: the chip's dot, including its
     starting arc and stopping fill. A chip is hoverable and this is not. --av-border
     disappears on the menu surface, so an idle dot takes a quieter grey ink. */
  .srv.sdot { flex: none; }
  .srv.sdot:hover { background: none; }
  .srv.sdot .dot.off { background: color-mix(in srgb, var(--av-fg-3) 45%, transparent); }

  /* One thing a worktree can start. */
  .sstart { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto auto; gap: 8px;
          align-items: center; min-height: 34px; padding: 2px; border-radius: 6px;
          font-size: var(--av-fs-md); }
  .sstart.open { padding: 2px 8px; margin: 2px -6px 0; border-radius: 7px 7px 0 0;
               background: color-mix(in srgb, var(--av-blue) 7%, var(--av-card)); }
  .sstart .nm { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
  .sstart .nm b, .sstart .nm i { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sstart .nm b { font-weight: 600; }
  .sstart .nm i { font-style: normal; font-size: var(--av-fs-sm); color: var(--av-fg-3); }
  .sstart .nm i.bad { color: var(--av-red); }
  .sstart .port { font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums;
                color: var(--av-fg-3); }
  .sstart .acts { display: flex; gap: 4px; }
  .slink { padding: 0; border: 0; background: none; cursor: pointer; font: inherit;
           color: var(--av-blue); text-decoration: underline; text-underline-offset: 3px; }
  /* Dashed for the reason a port on the way to answering is: it is a default,
     and holds nothing until Run. */
  .spick { font: inherit; font-size: var(--av-fs-md); color: var(--av-fg-2); cursor: pointer;
           padding: 1px 6px; border-radius: 5px; background: none;
           border: 1px dashed var(--av-border); }
  .spick:hover { border-color: var(--av-fg-3); color: var(--av-fg); }
  .sact { font: inherit; font-size: var(--av-fs-sm); min-height: 24px; padding: 2px 9px;
          border-radius: 5px; cursor: pointer; white-space: nowrap; color: var(--av-fg-2);
          background: var(--av-card); border: 1px solid var(--av-border); }
  .sact:hover { border-color: var(--av-fg-3); color: var(--av-fg); }
  /* The paint #send wears, on the one row whose port is being chosen. Several
     solid buttons on a sheet would each claim to be the next step. */
  .sact.go { font-weight: 600; font-size: var(--av-fs-md); padding: 3px 12px; border-radius: 6px;
             font-variant-numeric: tabular-nums; color: var(--av-btn-fg);
             background: var(--av-btn-bg); border-color: var(--av-focus); }
  .sact.go:hover { filter: brightness(1.12); }

  .sports { margin: 0 -6px 2px; padding: 4px 8px 9px; border-radius: 0 0 7px 7px;
            background: color-mix(in srgb, var(--av-blue) 7%, var(--av-card)); }
  .sports .colhead { display: flex; font-size: var(--av-fs-label); color: var(--av-fg-3);
                     padding: 0 2px 5px; }
  .sports .colhead .cnt { margin-left: auto; font-variant-numeric: tabular-nums; }
  .sports .colhead .cnt b { color: var(--av-fg-2); font-weight: 600; }

  /* Five across, so ten slots sit under one row in two lines. minmax(0, 1fr)
     rather than 1fr: a long holder would otherwise grow its track and shove the
     rest out of the sheet. */
  .rgrid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
  /* The outside tile: a grid cell's width, on a line of its own. */
  .rout { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin-top: 4px; }
  .rtype { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .rtype .rport { width: 96px; box-sizing: border-box; font: inherit; font-size: var(--av-fs-md);
                  padding: 4px 7px; border-radius: 6px; color: var(--av-fg); background: var(--av-card);
                  border: 1px solid var(--av-border); font-variant-numeric: tabular-nums; }
  /* A correction, read where the reader is typing, not hidden in a tip. */
  .rtype .rport[aria-invalid='true'] { border-color: var(--av-red); }
  .rtype .rwhy { font-size: var(--av-fs-sm); color: var(--av-red); }
  .rtile { position: relative; box-sizing: border-box; min-width: 0; min-height: 40px; padding: 3px 7px;
           border-radius: 8px; cursor: pointer; font: inherit; font-size: var(--av-fs-md);
           display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
           color: var(--av-fg-2); background: var(--av-card);
           border: 1px solid var(--av-border); font-variant-numeric: tabular-nums; }
  /* Hover stays neutral. The accent belongs to the armed tile alone — a
     transient state that outshouts a chosen one is a hierarchy bug. */
  .rtile:hover { border-color: var(--av-fg-3); color: var(--av-fg); }
  .rtile.on { color: var(--av-fg); font-weight: 600;
              border-color: color-mix(in srgb, var(--av-blue) 42%, var(--av-border));
              background: color-mix(in srgb, var(--av-blue) 7%, var(--av-card)); }
  /* The state line, and the whole reason a tile beats a menu row: a held port
     says who holds it without anyone opening a terminal. Only the states that
     are news carry a word — eight tiles saying "free" is the grid repeating
     what the absence of a mark already said. */
  .rtile .u { flex: none; font-size: var(--av-fs-sm); color: var(--av-fg-3);
              max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rtile.on .u { color: var(--av-fg); opacity: .8; }
  /* Held is the surface hatched, not a colour: red means something failed
     everywhere else in this panel, and an occupied port has not failed. */
  .rtile.busy { cursor: default; color: var(--av-fg-3); background: var(--av-menu-bg);
                border-color: var(--av-border); }
  .rtile.busy::before { content: ''; position: absolute; inset: 0; border-radius: inherit;
                        background: repeating-linear-gradient(135deg,
                          color-mix(in srgb, var(--av-fg-3) 26%, transparent) 0 4px,
                          transparent 4px 9px); }
  /* Above the hatch, on an opaque chip: the stripe phase otherwise decides the
     contrast every held glyph is read at. */
  .rtile.busy > * { position: relative; background: var(--av-menu-bg); padding: 0 3px;
                    border-radius: 3px; }
  /* Revealed on hover or focus, never removed from the tab ring: display: none
     would put the only way out of a held port beyond a keyboard, which is the
     dead end this tile exists to not be. */
  .rtile .stop { position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
                 font: inherit; font-size: var(--av-fs-sm); padding: 2px 8px; min-height: 24px;
                 border-radius: 5px; cursor: pointer; color: var(--av-fg-2);
                 background: var(--av-card); border: 1px solid var(--av-border); opacity: 0; }
  .rtile:hover .stop, .rtile .stop:focus-visible { opacity: 1; }
  /* Held tiles only: the word a free tile carries is "last", and nothing is
     about to be drawn over it. */
  .rtile.busy:hover .u, .rtile.busy:focus-within .u { opacity: 0; }
  .rtile .stop:hover { border-color: var(--av-fg-3); color: var(--av-fg); }
  /* Stopping is not free yet: the socket goes a beat after the terminal does,
     so the tile says what it is doing and stays unpickable until the sheet is
     asked again. */
  .rtile.going .u { opacity: 1; }
  .rtile.going .stop { display: none; }
  /* Refused is not held: nothing is on it, so no hatch. Dashed and quiet, a
     port the sheet will not hand out whatever the machine says. */
  .rtile.refused { cursor: default; color: var(--av-fg-3); background: transparent;
                   border-style: dashed; }
  .rtile.refused:hover { border-color: var(--av-border); color: var(--av-fg-3); }
  /* Under ~480px of sheet the rail stacks above the starts and scrolls inside a
     cap, so a long worktree list cannot push the starts off the sheet. */
  @container rsheet (max-width: 480px) {
    #rbody { flex-direction: column; overflow-y: auto; }
    .srail { width: auto; max-height: 132px; flex: none; border-right: 0;
             border-bottom: 1px solid var(--av-border); }
    .sstarts { overflow: visible; }
    /* Three across: at five a tile has no room for a port beside its Stop. */
    .rgrid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }

  /* What the composer keeps: one row naming the question, opening the layer,
     and closing it again on a second click. Constant height whatever the ask
     contains, which is what stops the composer growing until it is clipped —
     the bug this layer exists to fix. */
  #qlaunch { display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box;
             text-align: left; font-family: inherit; font-size: var(--av-fs-md);
             padding: 8px 11px; border-radius: 6px; cursor: pointer;
             color: var(--av-fg); background: var(--av-warn-bg);
             border: 1px solid var(--av-orange); }
  #qlaunch[hidden] { display: none; }
  #qlaunch .q { flex: 1; min-width: 0; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
  #qlaunch .at { flex: none; font-size: var(--av-fs-md); color: var(--av-orange); }

  /* A blocked session's AskUserQuestion, its options read from the transcript.
     Amber is "staged, not sent": a click only picks, and the one blue thing in
     the layer — the CTA — is what reaches the CLI. */
  /* Fills the layer and is the only thing in it: min-height so the block inside
     can scroll rather than push the CTA past the bottom edge, which is the
     whole failure this moved to escape. */
  #question { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 11px;
              overflow-y: auto; }
  /* Focusable so the keys can live on it, but never drawn as focused: it is the
     layer's whole body, and a ring around all of it would say nothing. */
  #question:focus { outline: none; }
  /* The two columns. Each carries its own floor rather than the block carrying
     one, so an ask with no preview is a single column that shrinks freely and
     never asks for a scrollbar it has no use for. Below the floors the block
     stops shrinking and #ask scrolls sideways — the one degradation, chosen
     over a breakpoint because the divider is dragged continuously and a layout
     that switches mode mid-drag is a layout that flickers. */
  /* One dialog per request the session is blocked on. Alone — which is every
     terminal ask, and nearly every owned one — it fills the layer and the
     column inside it scrolls, which is the layout the ask has always had. Two
     or more and each is sized by its content while #question scrolls instead:
     a dialog whose height depended on how many siblings it had would jump every
     time one of them was answered. */
  .pdlg { display: flex; flex-direction: column; gap: 11px; min-height: 0; }
  /* Shrink-proof, and that is what makes #question the scroller above rather
     than a box everything is squeezed into. The min-height: 0 a line up opts a
     dialog out of flex's automatic minimum size — needed by the only-child
     below, whose block has to scroll — and with it gone the default shrink of 1
     compresses each dialog under its own content instead of overflowing.
     Measured against the shipped sheet, a permission dialog beside a question:
     56px of box for 84px of rows at a 694px board, #question scrolling by 0,
     and the permission row drawn 17px into the question's stepper — 34px at
     579px, which is a panel at one zoom step further in. */
  #question > .pdlg { flex: none; }
  #question > .pdlg:only-child { flex: 1; }
  .pdlg + .pdlg { padding-top: 11px; border-top: 1px solid var(--av-border); }

  /* A permission prompt: what is about to be run, and the three things that can
     be done about it. No amber anywhere — nothing here stages, so there is no
     half-made state for it to mean. */
  .phead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ptool { font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
           color: var(--av-orange); opacity: .9; }
  .plabel { font-size: var(--av-fs-lg); font-weight: 600; min-width: 0;
            overflow-wrap: anywhere; }
  /* Wide and tall inputs both scroll inside their own box, like a preview does.
     The ceiling is low on purpose: this is evidence for a decision, not a file
     viewer, and the buttons under it must stay in sight. */
  .pin { font-family: var(--vscode-editor-font-family); font-size: var(--av-fs-md);
         line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
         max-height: 220px; overflow: auto; margin: 0; padding: 8px 9px;
         border-radius: 5px; background: var(--av-code-bg);
         border: 1px solid var(--av-border); }
  .prow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* Allow-once is the filled button, the same one .cta is: it is the ordinary
     answer. The other two are outlines — always-allow because it writes
     something that outlives this call, deny because it is a refusal and neither
     is an error. */
  .pallow { font-family: inherit; font-size: var(--av-fs-md); font-weight: 600; padding: 5px 14px;
            border-radius: 6px; cursor: pointer; border: 1px solid var(--av-focus);
            background: var(--av-btn-bg); color: var(--av-btn-fg); }
  .palways, .pdeny, .pdeny-go { font-family: inherit; font-size: var(--av-fs-md); padding: 5px 12px;
                     border-radius: 6px; cursor: pointer; background: none;
                     color: var(--av-fg-2); white-space: nowrap;
                     border: 1px solid var(--av-border); }
  .palways:hover, .pdeny:hover, .pdeny-go:hover { color: var(--av-fg);
                                                  border-color: var(--av-focus); }
  /* The deny opens its reason rather than deciding, so it says so while it is
     open — otherwise the row would look like a decision already taken. */
  .pdeny.on { color: var(--av-fg); border-color: var(--av-focus); }

  .qblock { flex: 1; min-height: 0; display: flex; gap: 16px; }
  .qcol { flex: 1; min-width: 280px; min-height: 0; overflow-y: auto;
          display: flex; flex-direction: column; gap: 7px; }
  .qprev-col { flex: 0 1 44%; min-width: 240px; min-height: 0;
               display: flex; flex-direction: column; gap: 6px; }
  /* Under 600px of board the two columns stop being two. Against the board's
     inline size, like the nav bar's ladder in css/nav.ts and for the same
     reason: the dock opening and the divider being dragged both narrow this
     column without the window changing.

     The floors above add up to 570px of columns inside a box that is the board
     less 36 — so below roughly here the block stopped shrinking and the layer
     panned sideways instead, which the comment above still called the one
     degradation. It is worse than a breakpoint, and not for the reason a
     breakpoint is usually refused: panning moves the CTA horizontally under a
     pointer that is dragging the divider, and the preview and the options can
     no longer be read at once anyway, which was the whole argument for two
     columns. Stacked they both stay whole.

     The floors go with it. They exist to keep two columns readable side by
     side, and there is no side by side here.

     Stacked, the preview is what yields — it is what the decision is about,
     not the decision. A share of the box rather than a pixel ceiling is what
     makes that true at every height: a fixed 160px held its size while the
     options were squeezed to 3px at a 494px board and to nothing at 410px,
     where the sample then drew 56px past the block and over the row below it.
     At 30% the preview goes 69 -> 38 -> 22px across those same boards and the
     options keep 192 -> 125 -> 83, which is a list to scroll rather than a
     line. Measured; both are scrollers, so neither loses content by shrinking. */
  @container (max-width: 600px) {
    .qblock { flex-direction: column; }
    .qcol, .qprev-col { min-width: 0; }
    .qprev-col { flex: 0 1 auto; max-height: 30%; }
  }

  .qhdr { font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
          color: var(--av-orange); opacity: .9;
          display: flex; align-items: center; gap: 7px; }
  .qhdr .cnt { margin-left: auto; letter-spacing: 0; opacity: .7; }
  .qtext { font-size: var(--av-fs-lg); font-weight: 600; }
  .qopts { display: flex; flex-direction: column; gap: 5px; }
  .qopt { display: flex; gap: 8px; align-items: flex-start; text-align: left;
          font-family: inherit; font-size: var(--av-fs-md); padding: 6px 9px; border-radius: 6px;
          cursor: pointer; color: var(--av-fg); width: 100%; box-sizing: border-box;
          background: var(--av-card);
          border: 1px solid var(--av-border); }
  .qopt .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .qopt-label { font-weight: 600; }
  .qopt-desc { color: var(--av-fg-2); line-height: 1.35; white-space: normal; }
  .qopt:hover { border-color: var(--av-focus); }
  .qopt.on { border-color: var(--av-orange);
             background: var(--av-warn-bg); }
  /* Where the arrows have put the keyboard — a highlight, not a pick, so it
     rings the row and leaves the amber border to mean staged.
     --av-fg as an inset shadow: a shadow follows the border radius where an
     outline squares it, and the foreground keeps the ring off the focus colour
     these rows already wear on hover. Inset, unlike the card's outer ring:
     this list scrolls, and a ring outside the row is a ring the scroller clips
     off at both ends. */
  .qopt.cur { box-shadow: inset 0 0 0 2px var(--av-fg); }
  /* The digit that stages this row, matching the terminal's own numbering. */
  .kbd { flex: none; width: 16px; height: 16px; border-radius: 4px; font-size: var(--av-fs-md);
         line-height: 15px; text-align: center; margin-top: 1px; opacity: .6;
         font-family: var(--vscode-editor-font-family);
         border: 1px solid var(--av-border); }
  .qopt.on .kbd { opacity: 1; border-color: var(--av-orange);
                  color: var(--av-orange); }
  /* Square = many allowed, round = one: which kind of question it is, before
     anything has been clicked. */
  .mark { flex: none; width: 13px; height: 13px; margin-top: 2px; opacity: .5;
          border: 1px solid var(--av-fg); font-size: 10px; line-height: 11px;
          text-align: center; }
  .mark.many { border-radius: 3px; }
  .mark.one { border-radius: 50%; }
  .qopt.on .mark { opacity: 1; border-color: var(--av-orange);
                   background: var(--av-orange); color: var(--av-on-orange); }
  .qopt.on .mark.many::after { content: "✓"; }
  .qopt.on .mark.one::after { content: "•"; font-size: 14px; line-height: 10px; }

  /* ---- a question already answered, replayed ----------------------------- */
  /* The shipped rows down to the mark and the digit — a record that redrew them
     would be a second drawing of the same list — with the pointer and the hover
     taken off, because none of them decides anything. */
  .qseen-cap { display: flex; align-items: center; gap: 7px; margin-bottom: 10px;
               font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
               color: var(--av-fg-3); }
  /* Through --dot rather than restating the box: .dot is the panel's one
     circle, and a second width on anything named one is a way around it. */
  .qseen-cap .dot { --dot: 6px; background: var(--av-green); }
  .qopt.seen { cursor: default; }
  /* The gutter carries the pointer for the whole width of the row it is in, so
     a record has to put it back: .qopt.seen above is the parent, and the
     child's own declaration wins over it. */
  .qopt.seen .qother-pick { cursor: default; }
  .qopt.seen:hover { background: var(--av-card); border-color: var(--av-border); }
  .qopt.seen:not(.on) { opacity: .62; }
  .qopt .answered { margin-left: auto; align-self: center; font-size: var(--av-fs-sm);
                    text-transform: uppercase; letter-spacing: .06em; color: var(--av-green); }
  /* Green, and not the shipped amber — the one shipped rule a record refuses.
     Amber in this panel means *staged and not sent*, the colour a card wears
     while it waits for a reader. A record has nothing pending in it, so an
     answer replayed in amber would say the opposite of what happened. Green is
     what the panel already spends on settled. */
  .qopt.seen.on { border-color: var(--av-green); background: transparent; }
  .qopt.seen.on .kbd { border-color: var(--av-green); color: var(--av-green); }
  .qopt.seen.on .mark { border-color: var(--av-green); background: var(--av-green);
                        color: var(--av-bg); }
  /* The reader's own words, read back rather than typed. No box, unlike the
     live row's dashed one: dashed there means *typed and not currently the
     answer*, and it only ever shows while the row is off. In a record the row
     is on and these words are the answer — the green border is the frame and
     the badge is the label, so a second box around them would say provisional.
     Wrapping for the same reason it is unboxed: this is the one thing the row
     exists to say, and .qcol scrolls in the axis that has room for it. The
     shipped overflow: hidden stays as the backstop, and anywhere is what keeps
     it from ever being reached — a pasted path or URL has no space to break at
     and would otherwise be clipped exactly as the nowrap line was. */
  .qopt.seen .qother-said { white-space: normal; overflow-wrap: anywhere;
                            padding: 0; border: none; }
  /* The note, read back rather than typed: the box becomes its words. */
  .qnote.seen { display: flex; flex-direction: column; gap: 4px; }
  .qnote-said { font-size: var(--av-fs-md); line-height: 1.5; color: var(--av-fg-2);
                padding: 6px 9px; border-radius: 5px; background: var(--av-code-bg);
                border-left: 2px solid var(--av-border); }
  /* The footer keeps the row the CTA sat in, so the box does not change height
     between the live dialog and its record. */
  .qrow.seen { display: flex; align-items: center; gap: 12px; padding-top: 10px; }
  .qclose { font: inherit; font-size: var(--av-fs-md); padding: 5px 14px; border-radius: 5px;
            cursor: pointer; border: 1px solid var(--av-input-border);
            background: transparent; color: var(--av-fg); }
  .qclose:hover { background: var(--av-hover); }

  /* One shared preview, in its own column beside the options. It used to sit
     above them, because the block hung off the bottom of the composer and a
     preview that changed height would shove the rows out from under the
     pointer picking them. A column cannot do that to a sibling column, so the
     property survives the move without the ordering that bought it. Wide and
     tall samples both scroll inside their own box. */
  .qprev-cap { font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
               color: var(--av-fg-3);
               display: flex; align-items: center; gap: 6px; }
  /* Names which option is previewed, so it carries the link colour undimmed —
     the caption around it is what recedes. */
  .qprev-cap .of { text-transform: none; letter-spacing: 0;
                   color: var(--av-link); }
  .qprev-cap .peek { text-transform: none; letter-spacing: 0; margin-left: auto; display: none;
                     color: var(--av-orange); }
  .qprev-cap .peek.show { display: inline; }
  .qprev { font-family: var(--vscode-editor-font-family); font-size: var(--av-fs-md); line-height: 1.45;
           white-space: pre; flex: 1; min-height: 0; overflow: auto; max-width: 100%;
           margin: 0; padding: 8px 9px;
           border-radius: 5px; background: var(--av-code-bg);
           border: 1px solid var(--av-border); }

  /* The stepper: one chip per question, carrying its own answered state. Wears
     the same box as .fpill, written out rather than shared: the two rules are
     260 lines apart, and a selector list that far from home costs more to read
     than the nine declarations it saves. */
  .steps { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  /* The only control on the ask layer under 24 — every option row is already
     33 to 54. One number, changed the same way .fpill was, because the two
     are the same capsule. */
  .step { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px;
          border-radius: 13px; border: 1px solid var(--av-border); background: none;
          color: var(--av-fg-3); font-family: inherit; font-size: var(--av-fs-md);
          cursor: pointer; white-space: nowrap; }
  .step.on { color: var(--av-fg); border-color: var(--av-focus);
             background: var(--av-card); }
  .step.done { color: var(--av-green);
               border-color: var(--av-green); }
  .step .g { font-family: var(--vscode-editor-font-family); }
  .steps .cnt { margin-left: auto; font-size: var(--av-fs-md); color: var(--av-fg-3); }

  .qrow { display: flex; align-items: center; gap: 12px; }
  /* The same filled button as .tkconnect, written out for the same reason .step
     is: 220 lines apart, and a reader here should not have to go and find it. */
  .cta { font-family: inherit; font-size: var(--av-fs-md); font-weight: 600; padding: 5px 14px;
         border-radius: 6px; cursor: pointer; border: 1px solid var(--av-focus);
         background: var(--av-btn-bg); color: var(--av-btn-fg); }
  .cta:disabled { opacity: .4; cursor: not-allowed; }
  /* The button is the last stop on the same walk the option rows are on, so it
     carries the same ring, inset for the same reason — the layer's own edge is
     a hand's width from the button and an outline offset past it is cut. */
  .cta.cur { box-shadow: inset 0 0 0 2px var(--av-fg); }
  .qkeys { font-size: var(--av-fs-md); color: var(--av-fg-3); }

  /* Saying something the option list does not offer — as the last row of that
     same list, which is where the CLI's own widget puts an Other row. It was a
     labelled box under the rows, and the rule that made it the answer (words
     count only where nothing is picked) had no visible form at all; the mark is
     that form. A row with a box in it cannot be a <button> — a click meant for
     the caret would press it — so the part that is a pick is a button of its
     own, and the field is its sibling. */
  .qopt.other { flex-direction: column; gap: 5px; cursor: default; }
  .qother-pick { display: flex; gap: 8px; align-items: flex-start; text-align: left;
                 width: 100%; padding: 0; border: none; background: none; cursor: pointer;
                 font-family: inherit; font-size: inherit; color: inherit; }
  /* Aligned under the label rather than with the row's edge: the digit and the
     mark are the row's own gutter, and the field is what the label introduces. */
  .qother-in { margin-left: 45px; width: calc(100% - 45px); }
  .qopt-label.dim { color: var(--av-fg-3); }
  /* What was typed, kept where its row is once a pick has taken the row: it is
     one click from being the answer again, and nothing claims it is being sent. */
  .qother-said { font-size: var(--av-fs-md); color: var(--av-fg-2); padding: 3px 7px;
                 border-radius: 4px; border: 1px dashed var(--av-input-border);
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Each box is a plain-mode editor (prose.ts): the host is the bordered field
     and grows with what is typed, and the editing root inside it takes the
     padding, so a press anywhere in the field lands in the text. */
  .qother-in, .say-in { box-sizing: border-box; line-height: 1.4;
                   max-height: calc(8lh + 14px); overflow-y: auto; cursor: text;
                   font-family: inherit; font-size: var(--av-fs-md);
                   border-radius: 4px;
                   background: var(--av-input-bg); color: var(--av-input-fg);
                   border: 1px solid var(--av-input-border); }
  .qother-in .ProseMirror, .say-in .ProseMirror, .qnote-in .ProseMirror {
                   min-height: 2lh; padding: 6px 9px; }
  .say-in { width: 100%; }
  .qother-in:focus-within, .say-in:focus-within { outline: 1px solid var(--av-focus); }
  /* Amber while it has the caret, like the row around it: what is in here is
     staged, and the CTA is still the only thing that reaches the CLI. */
  .qother-in:focus-within { border-color: var(--av-orange); }
  /* A word about the pick, under the list rather than in it: it qualifies an
     answer instead of being one, so it wears no mark, takes no digit and sits
     off the walk the rows and the CTA share. Quiet until asked for — the
     trigger is text, and the box it opens is the same box every other typed
     thing here uses. */
  /* 24px of height on a control that is one line of text: the padding is what
     WCAG 2.2 SC 2.5.8 asks for, and it is not inline in a sentence, so the
     exception that covers a link in prose does not cover this. */
  .qnote-add { align-self: flex-start; display: inline-flex; align-items: center;
               min-height: 24px; padding: 3px 6px; margin-left: -6px;
               border: none; background: none; border-radius: 4px;
               cursor: pointer; font-family: inherit; font-size: var(--av-fs-md);
               color: var(--av-fg-3); text-decoration: underline;
               text-underline-offset: 3px; }
  .qnote-add:hover { color: var(--av-fg-2); }
  /* Once open, the box is a bordered field under an option list that has
     another bordered field in it — so it says which it is. The trigger's own
     words are gone by then, and a placeholder goes as soon as anything is
     typed. */
  .qnote { display: flex; flex-direction: column; gap: 4px; }
  .qnote-cap { font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
               color: var(--av-fg-3); }
  .qnote-in { flex: 1; min-width: 0; box-sizing: border-box; line-height: 1.4;
              max-height: calc(6lh + 14px); overflow-y: auto; cursor: text;
              font-family: inherit; font-size: var(--av-fs-md);
              border-radius: 4px; background: var(--av-input-bg); color: var(--av-input-fg);
              border: 1px solid var(--av-input-border); }
  .qnote-in:focus-within { outline: 1px solid var(--av-focus); border-color: var(--av-orange); }

  /* The box and the button that sends it, one control. */
  .say { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
  .say .say-in { flex: 1; min-width: 0; }
  .qxrow { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
  .qxrow .say { flex: 1; }

  /* Talking back instead of answering: the CLI's own Chat-about-this: a tool
     denial carrying feedback rather than a cancel. It used to be a second box
     stacked under the first, identical in every way but its placeholder — so it
     is shut until it is asked for, sits under a rule of its own outside the
     block, and leads with what it does rather than with the field. Never amber
     and never blue: it stages nothing, and it answers nothing. */
  .qbail { border-top: 1px solid var(--av-border); padding-top: 10px;
           display: flex; flex-direction: column; gap: 7px; }
  /* A permission dialog opens this from its own Deny, so its shut state is
     nothing at all — and an empty box would still draw the rule above it. */
  .qbail:empty { display: none; }
  .qbail-t { align-self: flex-start; display: inline-flex; align-items: center; gap: 7px;
             font-family: inherit; font-size: var(--av-fs-md); padding: 4px 9px;
             border-radius: 6px; cursor: pointer; background: none; text-align: left;
             color: var(--av-fg-2); border: 1px dashed var(--av-border); }
  .qbail-t:hover { color: var(--av-fg); border-color: var(--av-focus); }
  .qbail-t .cv { font-family: var(--vscode-editor-font-family); opacity: .7; }
  .qbail-t .why { color: var(--av-fg-3); font-size: var(--av-fs-md); }
  .qbail-open { display: flex; flex-direction: column; gap: 6px; padding: 9px 11px;
                border-radius: 6px; background: var(--av-card);
                border: 1px solid var(--av-border);
                border-left: 3px solid var(--av-fg-3); }
  .qbail-cap { font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
               color: var(--av-fg-3); }
  .qbail-why { font-size: var(--av-fs-md); line-height: 1.5; color: var(--av-fg-2); }
  .qbail-back { align-self: flex-start; font-family: inherit; font-size: var(--av-fs-md);
                padding: 5px 10px; border-radius: 6px; cursor: pointer; background: none;
                color: var(--av-fg-3); border: 1px solid transparent; }
  .qbail-back:hover { color: var(--av-fg-2); border-color: var(--av-border); }

  /* Both outlines: neither is the ordinary way past this dialog, and neither is
     an error. Cancel recedes furthest — it ends the turn — and sits at the far
     end of the CTA row, since two exits side by side was half of why neither
     could be read. */
  .qreply { font-family: inherit; font-size: var(--av-fs-md); padding: 5px 12px;
            border-radius: 6px; cursor: pointer; background: none; white-space: nowrap;
            color: var(--av-fg-2);
            border: 1px solid var(--av-border); }
  .qreply:hover:not(:disabled) { color: var(--av-fg); border-color: var(--av-focus); }
  .qreply:disabled { opacity: .4; cursor: not-allowed; }

  /* Answered, waiting on the push that takes the dialog away. Brighter than a
     plain disabled control, because the two say opposite things: dim is "not
     yet", this is "gone, and on its way".

     Last of the dialog's rules, and that is the whole of how it wins. Every
     control it lands on — the CTA, the permission row's three, both reason
     boxes — carries a one-class :disabled rule of its own at exactly this
     specificity, so whichever is written later paints. Written earlier, it lost
     to .qreply:disabled above and the ask's sent reply wore the dim "not yet"
     look this rule exists to replace. Keep it after the last of them. */
  button.away:disabled { opacity: .75; cursor: progress; }

  /* A decision that went nowhere, said under the controls it just handed back.
     Red because it is the one line here that reports a failure, and quiet
     because the dialog above it is what the reader acts on next. */
  .qfail { font-size: var(--av-fs-md); color: var(--av-red); }
  .qcancel { font-family: inherit; font-size: var(--av-fs-md); padding: 5px 10px;
             border-radius: 6px; cursor: pointer; background: none; white-space: nowrap;
             color: var(--av-fg-3); border: 1px solid transparent; }
  .qcancel:hover { color: var(--av-fg-2); border-color: var(--av-border); }
  .qrow .qcancel { margin-left: auto; }
  #blocked { font-size: var(--av-fs-md); opacity: .75; color: var(--av-orange); }
  /*
   * Workflow slot (#wattach): Attach, armed chip, or live observe. Armed and
   * live share .wflow (same box); mode is tint + lead + trail. Never full-bleed
   * strip (fought the held queue).
   *
   * Exclusive only while the run is **working**: a finished chip keeps its box
   * and Attach comes back beside it, so the row can hold two and wraps rather
   * than clipping. The × beside the chip and the confirm it opens are below.
   */
  #wattach { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  #wattach:empty { display: none; }

  /* button reset: live chip is a real control (drawer toggle) sharing .wflow.
     Family and weight only — the font shorthand also reset the size, and being the
     more specific selector it beat .wflow's own, so the live chip drew at the
     body's 14px while the armed one beside it drew at 12. */
  button.wflow { font-family: inherit; font-weight: inherit;
                 text-align: left; cursor: pointer; }
  .wflow { display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
           box-sizing: border-box; min-width: 0; min-height: 28px;
           padding: 0 8px 0 6px; border-radius: 6px; font-size: var(--av-fs-md);
           color: var(--av-fg-2); background: var(--av-card);
           border: 1px solid var(--av-border); user-select: none; }
  /* The gem is 6px in a box only wide enough to hold it: a 24px lead put nine
     blank pixels between the caret and the dot and nine more before the verb,
     which read as a gap in the middle of one phrase. The 24 hit target belongs
     to the trail controls, which are pressed; this one is paint. */
  .wflow .lead { flex: none; width: 12px; height: 24px;
                 display: inline-flex; align-items: center; justify-content: center; }
  .wflow .lead .gem { width: 6px; height: 6px; border-radius: 50%;
                      background: var(--st, var(--av-border)); }
  .wflow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
               min-width: 0; max-width: 260px; }
  .wflow .meta { flex: none; color: var(--av-fg-3); font-variant-numeric: tabular-nums; }
  .wflow .verb { font-weight: 600; flex: none; color: var(--av-fg); }
  /* Shrinkable, not fixed: a step label is the longest thing on the chip and
     the last one on it, so at 110px fixed it was clipped by its own cap while
     the composer beside it was half empty. Wide cap plus a shrink lets the
     chip's own max-width do the clamping, and the ellipsis land inside it. */
  .wflow .sname { flex: 0 1 auto; min-width: 0; max-width: 240px;
                  overflow: hidden; text-overflow: ellipsis;
                  white-space: nowrap; color: var(--av-fg-3); font-size: var(--av-fs-sm);
                  font-weight: 500; }
  .wflow .sname::before { content: '·'; margin-right: 5px; color: var(--av-fg-3);
                          font-weight: 400; }
  .wflow .sname.working { color: var(--av-fg); }
  .wflow .sname.done { color: var(--av-green); }

  /* The four states, ghosted. Each was a tint of its hue mixed into the card
     under a border mixed with --av-border, and the amber one was what sent the
     whole recipe back for another look: it dimmed the text riding on it and
     came out muddy rather than warm.

     Two things changed. The mix is gone — accent border, accent gem, accent
     verb, and nothing between the words and what is behind them. And the fill
     is transparent rather than --av-card, which is not the same thing here:
     #wattach sits on the dock, which paints --av-bg, so "no tint" written as
     --av-card was still a faint box. A ghost removes the box.

     The border stops being mixed with --av-border too. A 42–48% mix of an
     accent measured 2.00–3.22:1 against its neighbours in every palette, under
     SC 1.4.11's 3:1 — the boundary was the part of this chip that least
     carried its own state. At full strength it is 4.66–10.99:1.

     What it costs: no mass. The four states are four outlines that differ by
     hue alone, so at the edge of vision a waiting chip no longer has a shape
     of its own. Seven treatments, measured in six palettes, and why this one:
     docs/mockups/amber-states.html §5–6. */
  .wflow:is(.running, .paused, .waiting, .done) {
    color: var(--av-fg); background: transparent; border-color: var(--st); }
  .wflow:is(.running, .paused, .waiting, .done) .verb { color: var(--st); }
  .wflow.running { --st: var(--av-blue); }
  .wflow.paused { --st: var(--av-fg-3); }
  .wflow.waiting { --st: var(--av-orange); }
  .wflow.done { --st: var(--av-green); }
  .wflow.waiting .lead .gem { animation: wflow-pulse 1.1s ease-in-out infinite; }
  @keyframes wflow-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) {
    .wflow.waiting .lead .gem { animation: none; }
  }

  /* The live chip's × is a **sibling** of the chip, not a trail control inside
     it: the chip is the button that opens the drawer, and a button nested in a
     button is broken out by the parser. It borrows .drop's box so the two ×s in
     this slot are the same size and the same 24 hit target. */
  #wattach .wcancel { opacity: .5; }
  #wattach .wcancel:hover { opacity: 1; color: var(--av-red); }

  /* The confirm, standing where the chip was — the bottom drawer's shape, on one row.
     .wask is paint only; the two buttons beside it are what is pressed. */
  #wattach .wask { display: inline-flex; align-items: center; gap: 5px;
                   min-width: 0; max-width: 100%; min-height: 28px;
                   font-size: var(--av-fs-md); color: var(--av-fg); }
  /* --av-warn-border rather than --av-red: it is what the sheet's own delete
     confirm spends, and what makes the two read as one gesture. */
  #wattach .wask .q { flex: none; font-weight: 600; color: var(--av-warn-border); }
  /* Its own, because .wflow's version is scoped to the chip box this replaces. */
  #wattach .wask .nm { overflow: hidden; text-overflow: ellipsis;
                       white-space: nowrap; min-width: 0; max-width: 200px; }
  #wattach .wask .sname { flex: 0 1 auto; min-width: 0; max-width: 200px;
                          overflow: hidden; text-overflow: ellipsis;
                          white-space: nowrap; color: var(--av-fg-3);
                          font-size: var(--av-fs-sm); font-weight: 500; }
  #wattach .wask .sname::before { content: '·'; margin-right: 5px;
                                  color: var(--av-fg-3); font-weight: 400; }
  #wattach .wask .sname.working { color: var(--av-fg); }
  #wattach .wask .sname.done { color: var(--av-green); }
  /* Both answers are real buttons, and the destructive one wears the colour. */
  #wattach .act.fbtn { flex: none; padding: 3px 10px; font-size: var(--av-fs-md); }
  #wattach .act.fbtn.danger { color: var(--av-warn-border);
                              border-color: var(--av-warn-border); }

  /* Trail / lead controls — 24 hit targets (armed peek, Edit, Retry, ×). */
  #wattach .peek, #wattach .drop, #wattach .wedit, #wattach .wretry {
    cursor: pointer; opacity: .6; padding: 0; background: none; border: 0;
    color: inherit; font: inherit; border-radius: 4px;
    min-width: 24px; min-height: 24px;
    display: inline-flex; align-items: center; justify-content: center; flex: none;
  }
  #wattach .wedit { opacity: .55; padding: 0 5px; min-width: 0;
                    font-size: var(--av-fs-sm); }
  #wattach .peek:hover, #wattach .drop:hover, #wattach .wedit:hover,
  #wattach .wretry:hover {
    opacity: 1; background: var(--av-hover);
  }
  #wattach .wedit:hover { color: var(--av-link); }
  /* Retry / Continue sits between the chip and the ×, and is the offer rather
     than the ending — so it is the one outlined button in the slot, at full
     contrast, where its neighbours are dimmed glyphs. */
  #wattach .wretry { opacity: 1; padding: 0 9px; min-width: 0;
                     font-size: var(--av-fs-sm); font-weight: 600;
                     color: var(--av-fg); border: 1px solid var(--av-border);
                     border-radius: 6px; }
  #wattach .wretry:hover { color: var(--av-link); border-color: var(--av-link); }

  #wattach .wsteps { flex-basis: 100%; margin: 0; padding: 2px 0 0 22px;
                     font-size: var(--av-fs-md); color: var(--av-fg-2); }
  #wattach .wstep { line-height: 1.5; }
  /* Composer is the panel bottom — menu opens upward (same trap as #bottomhub). */
  #wattach .fmenu { top: auto; bottom: calc(100% + 6px); }
  /* One line at rest, growing with the text to ten, then scrolling.
     field-sizing sizes the box to its content and the two bounds clamp that,
     so no script measures anything. Ten leaves the thread the larger share
     while a long draft is typed. .shell owns the border, the background, the
     radius and the ring; what is left here is the growth and the colour of
     the text. */
  /* The prose editor's host (webview/composer.ts): it grows with what is typed
     up to the ceiling and scrolls past it, and the editing root inside takes
     the floor and the padding, so a press anywhere in the box lands in the
     text. */
  #input { width: 100%; box-sizing: border-box; line-height: 1.4;
           max-height: calc(10lh); overflow-y: auto; cursor: text;
           font-family: inherit; font-size: var(--av-fs-lg);
           background: none; color: var(--av-input-fg); border: 0;
           position: relative; z-index: 1; }
  #input .ProseMirror { min-height: 1lh; padding: 1px 3px; }
  #input.empty .ProseMirror pre { background: none; border-color: transparent; padding: 0; }
  #input .pchip { display: inline-block; box-sizing: border-box; max-width: 100%;
                 white-space: normal; overflow-wrap: anywhere; vertical-align: bottom; }
  /* The shell rings instead. Two rings, one inside the other, is the box-in-box
     this change exists to remove. */
  #input .ProseMirror:focus { outline: none; }
  /* The at-mention menu. Fixed and parked on <body> (see ensureMenu in
     webview/composer.ts), so it is placed in script rather than here — this
     only says what it looks like. No backticks in this file: it is one template
     literal, and a stray pair ends it. */
  /* top: auto is load-bearing, not tidying. .fmenu (css/tickets.ts) sets
     top: calc(100% + 5px) unscoped and this file cascades after it, so position
     is overridden and top is not — and on a fixed box 100% is the viewport, so
     top lands a screen-height below the fold. place() then writes bottom
     inline, the box is over-constrained with height: auto, and Chromium solves
     the height down to the padding: a menu 8px tall, below the window. Every
     other fixed .fmenu here says the same word for the same reason —
     .fmenu.floating (css/board.ts), #wattach, #hintrow, #bottomhub. */
  .mnmenu {
    position: fixed; top: auto; z-index: 40;
    min-width: 200px; max-width: 340px; max-height: 40vh;
    overflow-y: auto; padding: 4px;
  }
  .mnrow {
    display: flex; align-items: baseline; gap: 8px;
    width: 100%; box-sizing: border-box;
    padding: 4px 8px; border: 0; border-radius: 4px;
    background: none; color: var(--av-fg);
    font: inherit; text-align: left; cursor: pointer;
  }
  /* Wraps rather than ellipsing. The menu is fixed and shrinks to fit, so a
     nowrap name is its min-content width: a long skill name ran the menu off
     the panel's right edge (smoke, 2026-10-06). */
  .mnrow .nm { flex: 1; min-width: 0; }
  /* Window and brand for a model, status and pid for a session, a count for a
     kind: what tells two rows of one name apart, kept to the right. */
  .mnrow .meta { color: var(--av-muted); font-size: 0.9em; white-space: nowrap; }
  /* A ticket: its number whole, then its title on the rest of the one line.
     The menu's max-width is what cuts it. */
  .mnrow.titled .nm { flex: none; white-space: nowrap; }
  .mnrow.titled .meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* A row that opens a further step: a kind's list, or a model's efforts. */
  .mnrow .go { color: var(--av-muted); }
  /* Which kind a row is, in its pill's colour, drawn only when the menu holds
     more than one kind. */
  .mnrow .k { width: 7px; height: 7px; border-radius: 2px; flex: none; align-self: center; }
  .mnrow .k.model { background: var(--av-fg-3); }
  .mnrow .k.skill { background: var(--av-green); }
  .mnrow .k.ticket { background: var(--av-link); }
  .mnrow .k.session { background: var(--av-yellow); }
  /* A billing-gated window: the model picker's dashed ring (.wp.gated in
     css/board.ts), on the window it names, and still pickable. */
  .mnrow.gated .meta { border: 1px dashed var(--av-border); border-radius: 4px; padding: 0 4px; }
  .mnhead {
    padding: 6px 8px 2px; color: var(--av-muted); font-size: 0.85em;
    text-transform: uppercase; letter-spacing: .05em;
  }
  .mnhead:first-child { padding-top: 2px; }
  /* The narrowed list's breadcrumb, read as words rather than a section label. */
  .mncrumb { text-transform: none; letter-spacing: 0; font-size: 0.9em; }
  /* .on is the row Enter takes, and the whole highlight — the pointer sets it
     too (webview/composer.ts). No :hover beside it: with both, arrowing away
     from a parked pointer lit two rows. */
  .mnrow.on, .mnrow:focus-visible { background: var(--av-hover); }
  /* Says the menu cannot promise every row loads. Dimmed and last, because it
     is a caveat on the list rather than an item in it. */
  .mnfoot {
    padding: 6px 8px 2px; margin-top: 2px;
    border-top: 1px solid var(--av-border);
    color: var(--av-muted); font-size: 0.9em;
  }
  /* The hint sits over the empty box, outside the formatted document. */
  .inputwrap { position: relative; display: flex; }
  .hintghost { display: none; position: absolute; z-index: 2;
               top: 1px; left: 4px; right: 4px;
               pointer-events: none; font-size: var(--av-fs-md); line-height: 1.4;
               color: var(--av-fg-3);
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #input.empty ~ .hintghost { display: flex; flex-direction: row; align-items: baseline;
                              justify-content: space-between; gap: 8px; }
  .hintlabel { line-height: calc(1.4 * var(--av-fs-lg)); }
  .hintkeys { display: flex; align-items: center; gap: 4px; }
  /* A composer that cannot send says so in its placeholder, and an instruction
     about Enter under that would describe a key that does nothing. */
  #input[aria-disabled="true"] ~ .hintghost { opacity: .5; }
  #input[aria-disabled="true"] ~ .hintghost .hintkeys { display: none; }
  #input[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
  /* The hint and the button that does what it describes, one row. The hint
     takes the slack so the button stays pinned to the right edge however the
     middle span is rewritten — and it is rewritten on every push. */
  /* Controls left, Send right, and the auto margin is on the CLIP rather than on
     the hint. Put it on the hint and the row's layout depends on the hint having
     something to say — with the instruction moved to the ghost line the hint is
     empty most of the time, and nothing would push Send off the clip. This way
     Send is pinned whatever the middle is doing, and the hint lands beside it
     when there is a queue to report. */
  /* Centred, not bottom-aligned: the clip, the hint and Send are three
     different heights, and flex-end sat the hint's text on the button's bottom
     edge rather than across its middle. */
  #hintrow { display: flex; align-items: center; gap: 8px; margin-top: 2px; min-width: 0; }
  /* The controls hold the left, and the auto margin is the CLUSTER's rather
     than any one control's — the clip carried it until the model pill joined
     the row, at which point Send would have slid in beside the pill whenever a
     session had no model to state. Same invariant, one node up. */
  #ctools { display: flex; align-items: center; gap: 4px; flex: 1 1 0;
            min-width: 0; margin-right: auto; }
  #ctools .fwrap:has(.model) { flex: 0 1 auto; min-width: 0; max-width: 130px; }
  #ctools .model { min-width: 0; width: 100%; }
  #ctools .fwrap:has(.effort), #fattach { flex-shrink: 0; }
  /* The clip is a .icon like the dock head's four, and disabled the same way
     #send is: a session that cannot be sent to cannot be handed a path either. */
  #fattach:disabled { opacity: .25; cursor: not-allowed; background: none;
                      box-shadow: none; }
  /* The model in force, as mockups/composer-shell.html §3 draws it: the pill
     kit.ts already builds, at this row's scale, and capped so a long name
     ellipsises rather than pushing the hint out. */
  #composer .fpill { color: var(--av-fg-3); opacity: 1; }
  #composer .fpill:hover, #composer .fpill:focus-visible,
  #composer .fpill[aria-expanded='true'] { color: var(--av-fg); }
  #hintrow .fpill { min-height: 24px; padding: 0 6px 0 8px; gap: 4px;
                    border-radius: 6px; max-width: 130px; }
  #hintrow .fpill .nm { overflow: hidden; text-overflow: ellipsis;
                        white-space: nowrap; min-width: 0; }
  #hintrow .fpill:disabled { cursor: default; opacity: .72; color: var(--av-fg-3); }
  /* Composer is the panel bottom — menu opens upward, same trap as #wattach
     above and #bottomhub over the board. */
  #hintrow .fmenu { top: auto; bottom: calc(100% + 6px); }
  /* The same filled button .cta and .pallow are, written out for the reason
     they are written out from each other: it is a long way from either, and the
     three are the panel's one "this is the ordinary thing to press". A 28px
     square, the host's send glyph, above the 24px floor SC 2.5.8 puts under
     anything a pointer must hit. */
  #send { flex: none; white-space: nowrap; margin-left: auto;
          font-family: inherit; font-size: var(--av-fs-md); font-weight: 600;
          width: 28px; height: 28px; min-height: 0; padding: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 6px; cursor: pointer;
          border: 1px solid var(--av-focus);
          background: var(--av-btn-bg); color: var(--av-btn-fg); }
  #send:hover:not(:disabled) { filter: brightness(1.12); }
  /* The press lands on the button, never on the glyph inside it. */
  #send > * { pointer-events: none; }
  #send:disabled { opacity: .4; cursor: not-allowed; filter: none; }
  @container chat (max-width: 359px) {
    #composer { padding-inline: 10px; }
    #hintrow { gap: 6px; }
  }
  @container chat (max-width: 279px) {
    #hintrow { flex-wrap: wrap; row-gap: 8px; }
    #ctools { flex: 1 1 100%; flex-wrap: wrap; }
  }
  /* Enter would queue rather than send, which the hint beside it already says.
     Amber is that word's colour everywhere else in the composer — staged, not
     gone — so the button wears it rather than claiming to do something the
     session is not about to do.

     Ghosted, the way the workflow chip beside it is: the fill drops entirely
     and the amber does all three jobs — border, label, and the word. 16% of
     amber over --av-card was two wrongs at once. It separated from the box it
     sits in by 1.02:1, which is no separation at all, and being a fill it put
     a surface between the label and the reader for a state that is only "this
     send waits". Border-and-label measures 4.55–10.42:1 across the palettes.

     transparent, not --av-card: this button sits inside .shell, which paints
     a fill mixed from --av-fg and --av-lift, so a card-coloured "no fill" would
     still be a box. The brightness hover above lands on the text and the border, which is what
     a ghost's hover should be. */
  #send.queues { border-color: var(--av-orange); color: var(--av-orange);
                 background: transparent; }

  /* The permission mode, in the tool row after model and effort. Not a
     control: the transcript stated it. Skipping permissions is the warning,
     in the same colour the card's footer gives the same fact. */
  #ctools .mode { flex: none; display: inline-flex; align-items: center; gap: 4px;
                  min-height: 24px; padding: 0 6px; border-radius: 6px;
                  font-size: var(--av-fs-md); color: var(--av-fg-3); white-space: nowrap; }
  #ctools .mode .g { font-size: var(--av-fs-sm); }
  #ctools .mode.bypass { color: var(--av-orange); }

`;
