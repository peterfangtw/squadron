/** Session cards, families, group grids, add slots, card chrome. */

export const css = /* css */ `
  /* The ruler: the board's column count, measured off a grid nothing is ever
     placed in, because a grid holding a family box can report one column too
     many. It has no items, so it has no rows and no height already — this rule
     is here so that stays true if .grid ever grows a min-height. */
  .grid.ruler { height: 0; }

  /* A family: as many columns of the group's grid as it has cards, holding a
     grid of its own that divides that width back into the same number — so a
     card inside a container is sized like a loose one, and a family of one is a
     box around one card rather than around a card and an empty slot.
     --span is min(members, columns), set by family(); the column count is the
     board's one measured number, and 2 is its floor. The default of 1 is what a
     box gets if the property ever goes missing: too narrow, never too wide, and
     a span past the explicit grid would have the grid invent implicit columns
     and resize every loose card in the group.
     A rectangle, span columns by as many rows as the cards need: an
     under-filled last row is enclosed, not cut away.
     align-self, because a box narrower than the row would otherwise be
     stretched to whatever stands beside it — emptiness along the bottom that
     no card is even waiting to fill.
     Always open: there is no collapsed state to style, and none to lose to the
     repaint that replaces these nodes every second. */
  .fam { grid-column: span var(--span, 1); align-self: start;
         border: 1px solid var(--av-border); border-radius: 12px;
         background: var(--av-hover); padding-bottom: 10px; }
  .fam-head { display: flex; align-items: center; gap: 6px;
              padding: 7px 12px; margin-bottom: 10px;
              border-bottom: 1px solid var(--av-border);
              font-size: var(--av-fs-md); color: var(--av-fg-2); }
  .fam-head .g { flex: none; opacity: var(--av-dim); }
  .fam-head .k { flex: none; color: var(--av-fg-3); }
  .fam-head .who { min-width: 0; font: inherit; font-weight: 600; color: var(--av-fg);
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* A control only where there is somewhere to go: when the parent's own card
     heads this box it is the next thing under the header, and a link to it
     would be a link to here. */
  .fam-head button.who { padding: 0; border: none; background: none; cursor: pointer;
                         color: var(--av-link); }
  .fam-head button.who:hover { text-decoration: underline; }
  .fam-head .where { flex: none; color: var(--av-fg-3); }
  .fam-head .n { margin-left: auto; flex: none; white-space: nowrap; color: var(--av-fg-3); }
  .fam-head .warn { color: var(--av-orange); }
  /* Explicit, not auto-fill: the cells have to be the ones the span was
     computed from, or the box's own idea of its columns and the group's could
     disagree. The width works out the same either way — the box is 22px
     narrower than the columns it spans, which is what the auto-fill rule's own
     50% - 5px already resolved against.
     20px between cards inside a box against 10px outside one, because the step
     below is inset 10px from the cards on either side of it — the same air the
     box's padding gives every other edge, and a 10px gap has only 5px to give
     each. The cost is that a card in a box is a few pixels off the column its
     loose neighbours are in, which the box's own padding already made true. */
  .fam .grid { padding: 0 10px; gap: 20px;
               grid-template-columns: repeat(var(--span, 1), 1fr); }
  /* The card the header names. Weight, not hue: the card's left edge is already
     spending colour on the status, and a family colour would be a second thing
     to learn that fights the presets. */
  .fam .card.is-parent { border-color: var(--av-fg-3); }

  /* A dot: a circle that holds its size in a flex row, and nothing about what
     it stands for. Three callers mean three different things by one — a card's
     status, the tally's status, a ticket's priority — so the shared part stops
     at the box. Whoever uses it paints it.
     Size rides --dot and defaults to 7px, so a caller wanting another size sets
     the property rather than restating the geometry. Set it on the dot or on
     anything above it; both inherit the same way. */
  .dot { flex: none; width: var(--dot, 7px); height: var(--dot, 7px); border-radius: 50%; }

  /* 8px against the family box's 12px: a card sits inside one, and the inner
     radius reading tighter than the outer is what keeps the two from looking
     like the same corner drawn twice. */
  .card { border: 1px solid var(--av-border); border-radius: 8px;
          padding: 10px 12px 10px 13px; position: relative; overflow: hidden;
          background: var(--av-card); display: flex; flex-direction: column;
          gap: 6px; cursor: pointer; user-select: none;
          /* Density is a function of this box's own track width — the board's
             auto-fill already lands cards well under 290px when it keeps two
             columns. container-type, not a viewport media query, so a family
             member, a loose card and a board re-slot all agree.
             The axis is a variable because the height tier at the foot of this
             file needs the block one, and asking for it has a cost: see there.
             Default and every board today: inline-size, unchanged. */
          container-type: var(--card-axis, inline-size); container-name: card; }
  /* Hover is the quiet half of the same mark the selected card wears: the
     focus colour on the border it already has, and nothing else. Flat against
     the selected card's ring and glow, so the two read as degrees of one thing
     — the pointer is here, this one is being read — rather than as two colours
     to tell apart. */
  .card:hover { border-color: var(--av-focus); }
  /* The status colour, declared once and spent four times over: the rail below,
     the dot beside the name, the word at the end of that row, and the nav bar's
     tally dot, which wears the same colour for the same status and used to name
     all three again. Idle sets nothing by itself, so each of them falls back on
     its own — unless one of the facets below speaks for it. */
  .card.busy, #status-menu .dot.busy { --st: var(--av-blue); }
  .card.waiting, #status-menu .dot.waiting { --st: var(--av-orange); }
  /* Three facets of idle, not three more statuses — the card keeps its .idle
     class and everything keyed on it. They are hues all the same: "finished",
     "stopped short" and "could not run" are the idles worth telling apart at a
     glance, and the word identifies which facet speaks.
     Failed takes the red no other card state wears: its turn did not happen.
     Stalled shares waiting's orange knowingly. Both mean a session is not
     moving and one of them wants a person; the word beside the dot says which,
     and a sixth hue on this board would cost more than the collision does. */
  .card.done, #status-menu .dot.done { --st: var(--av-green); }
  .card.stalled, #status-menu .dot.stalled { --st: var(--av-orange); }
  .card.failed, #status-menu .dot.failed { --st: var(--av-red); }
  /* Not a status: the tally's command count, which cuts across the three
     above. It keeps the purple the shell status used to paint a card in. */
  #status-menu .dot.command { --st: var(--av-purple); }
  /* The servers section, between a group's heading and its grid. Same status
     hues as a card, spent on the row's dot: up is done's green, starting is
     busy's blue, failed is red, exited and not-running are the border grey a
     card falls back on. No new palette — this is the same vocabulary the board
     already speaks, and docs/design_tokens/status_colors.html is its record. */
  /* One line of live servers. It wraps rather than truncating: a server missing
     here is a port with nothing saying what holds it. */
  .servers { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 4px;
             margin: 0 0 12px; }
  /* The heading's way to every worktree, at the group's far edge. h2 sets the
     caps and the tracking; a control reads in the board's body type. */
  .sdoor { margin-left: auto; padding: 2px 8px; border: 0; border-radius: 11px; cursor: pointer;
           background: none; color: var(--av-fg-2); font: inherit; font-size: var(--av-fs-md);
           font-weight: 400; letter-spacing: 0; text-transform: none; white-space: nowrap; }
  .sdoor:hover { background: var(--av-hover); }
  .sdoor .n { margin-left: 4px; color: var(--av-fg-3); }
  /* .srv, not .chip: the composer declares a top-level .chip and joins after
     this file, so the shared name would take its 26px thumbnail row over this
     one. The same trap .shotchip and .srunner are named out of — docs/AGENTS.md
     §2c collisions. */
  .srv { display: inline-flex; align-items: center; border-radius: 11px;
          font-size: var(--av-fs-md); color: var(--av-fg-3); }
  .srv:hover { background: var(--av-hover); }
  .srv .cbody { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px;
                 font: inherit; color: inherit; background: none; border: 0;
                 border-radius: 11px; }
  .srv button.cbody { cursor: pointer; }
  /* Positioned because the two states that are going somewhere draw inside it:
     the arc that closes while a port is waited on, and the fill that closes
     inward while one is given up. */
  .srv .dot { background: var(--st, var(--av-border)); position: relative; }
  .srv .dot.up { --st: var(--av-green); }
  .srv .dot.starting { --st: var(--av-blue); }
  .srv .dot.failed { --st: var(--av-red); }
  /* Green, because a listener is a server that is up and the reader is asking
     the same question of it as of ours. Hollow, because we know it by observing
     the port rather than from a record of our own — a filled dot is a state we
     author. It read grey until it could be stopped, which said stopped about a
     port that was serving. */
  .srv .dot.alien { background: none; box-shadow: inset 0 0 0 1.5px var(--av-green); }
  .srv .br { font-weight: 600; overflow: hidden; text-overflow: ellipsis;
              white-space: nowrap; max-width: 22ch; }
  /* Running is the state worth reading at a glance, so it is the one that gets
     full-strength ink. Everything else is a port map, read on purpose. */
  .srv.up, .srv.starting, .srv.alien { color: var(--av-fg); }
  .srv .p { font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums;
             color: var(--av-fg-3); }
  .srv.up .p { color: var(--av-blue); }
  /* The port on its way to answering, or being given up.

     Four background gradients rather than border-style: dashed, because a
     border has no offset to animate and this box is a track. It used to be
     three renderings with a cut between each — dashed box, then plain grey
     while starting, then blue and underlined — and it is one object changing
     material instead. */
  .srv.starting .p, .srv.stopping .p {
    --track: var(--av-border); border-radius: 4px; padding: 0 4px;
    background-repeat: no-repeat;
    background-size: 100% 1px, 100% 1px, 1px 100%, 1px 100%;
    background-position: 0 0, 0 100%, 0 0, 100% 0;
    background-image:
      repeating-linear-gradient(90deg, var(--track) 0 3px, transparent 3px 6px),
      repeating-linear-gradient(90deg, var(--track) 0 3px, transparent 3px 6px),
      repeating-linear-gradient(0deg, var(--track) 0 3px, transparent 3px 6px),
      repeating-linear-gradient(0deg, var(--track) 0 3px, transparent 3px 6px); }
  /* Lit, in the colour of the state the chip is heading into. */
  .srv.starting .p { --track: var(--av-blue); }
  .srv.stopping .p { --track: var(--av-fg-3); }
  /* The underline is a bar rather than text-decoration, so arrival has
     something to draw and a stop has something to retract. It costs the
     decoration's ink-skipping, which four tabular digits never use. */
  .srv.up .p, .srv.stopping .p { position: relative; }
  /* Never on an observed port, in either state: an alien one is deliberately
     unadorned — the underline says "press this" and there is nothing there to
     press — so a stop aimed at a listener has no underline to retract and must
     not draw one to do it with. */
  .srv.up .p::after, .srv.stopping .p:not(.alien)::after {
    content: ''; position: absolute; bottom: -2px; height: 1px;
    background: currentColor; transform-origin: left; }
  .srv.up .p::after { left: 0; right: 0; }
  /* Inset by the track's own padding, and already retracted at rest — a reader
     with motion off gets the cut rather than a stale underline sitting under a
     box that has come back. */
  .srv.stopping .p:not(.alien)::after { left: 4px; right: 4px; background: var(--av-fg-3);
                                         transform: scaleX(0); transform-origin: right; }
  /* A listener being signalled takes the track like everything else, so its own
     solid box steps aside rather than framing the dashes running inside it. */
  .srv.stopping .p.alien { border-color: transparent; }
  /* Observed, not ours. Unadorned where one of ours is blue and underlined — the underline says "press this",
     and there is nothing here to press. */
  .srv .p.alien { border: 1px solid var(--av-border); border-radius: 4px; padding: 0 4px;
                   color: var(--av-fg-2); }
  .srv .s { font-size: var(--av-fs-sm); color: var(--av-fg-3); }
  .srv .s.bad { color: var(--av-red); }
  /* The destructive act, and the only one that is not where the pointer was
     already going. Revealed on the chip it belongs to and no other, so a line
     of six branches carries one ✕ at a time and none at rest. Focus reveals it
     too: a control a keyboard can reach and an eye cannot is worse than none. */
  .srv .x { opacity: 0; width: 16px; height: 16px; margin-right: 3px; padding: 0;
             display: inline-grid; place-items: center; font: inherit;
             font-size: var(--av-fs-sm); line-height: 1; border: 0; border-radius: 5px;
             background: none; color: var(--av-fg-3); cursor: pointer; }
  .srv:hover .x, .srv .x:focus-visible { opacity: 1; }
  .srv .x:hover { background: color-mix(in srgb, var(--av-red) 16%, transparent);
                   color: var(--av-red); }
  /* A stopping chip used to lose its ✕ outright. It keeps the node for the
     length of the swallow instead — as a span, so there is nothing to focus and
     nothing to press — and is invisible at rest, so the hover rule above cannot
     bring a dead control back. SWALLOW_MS in webview/board_servers.ts is what
     puts it there and what takes it away; this rule is what makes the leftover
     harmless if a repaint is late. */
  .srv.stopping .x { opacity: 0; pointer-events: none; }

  /* Starting is an arc closing a ring; stopping is a fill closing inward on
     nothing. Two states that used to share one opacity pulse with each other
     and with the card grid, so a chip coming up and a chip going away were told
     apart by a word and by nothing a glance catches.

     The ring under the arc is the dot keeping a shape while the arc is behind
     it — 28% of the blue: present, and not a second dot. */
  .srv .dot.starting { background: none;
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--st) 28%, transparent); }
  /* A head with a tail over the third of the ring behind it: that reads as a
     direction, where a hard segment reads as a shape rotating. */
  .srv .dot.starting::after {
    content: ''; position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(from -90deg, var(--st) 0deg,
      color-mix(in srgb, var(--st) 55%, transparent) 60deg,
      transparent 120deg 360deg);
    mask: radial-gradient(closest-side, transparent 46%, #000 54%); }
  .srv.stopping .dot { background: none;
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--av-fg-3) 70%, transparent); }
  .srv.stopping .dot::after {
    content: ''; position: absolute; inset: 1px; border-radius: 50%;
    background: var(--av-fg-3); transform: scale(0); }

  @media (prefers-reduced-motion: no-preference) {
    /* Clockwise while the port is waited on, backwards and slower while it is
       given up. Same track, opposite directions — the difference a reader
       should not have to read a word for. */
    .srv.starting .p { animation: srv-march 900ms linear infinite; }
    .srv.stopping .p { animation: srv-march 1500ms linear infinite reverse; }
    .srv.up .p::after { animation: srv-draw 220ms cubic-bezier(.16, 1, .3, 1); }
    /* Exits are faster than entrances. */
    .srv.stopping .p:not(.alien)::after { animation: srv-undraw 160ms ease-in; }
    /* One shot on the digits, on the frame the port answers. Nothing animated
       here is a layout property: a chip that changed width on arrival would
       rewrap every chip to its right. */
    .srv.up .p { animation: srv-land 420ms cubic-bezier(.16, 1, .3, 1); }
    .srv .dot.starting::after { animation: srv-arc 900ms linear infinite; }
    .srv.up .dot { animation: srv-arrive 300ms cubic-bezier(.16, 1, .3, 1); }
    .srv.up .dot::before { content: ''; position: absolute; inset: 0; border-radius: 50%;
                            animation: srv-flare 420ms cubic-bezier(.16, 1, .3, 1) forwards; }
    .srv.stopping .dot::after { animation: srv-close 320ms ease-in; }
    /* Once, and then it stops. A failure that keeps moving is a failure nobody
       keeps reading. */
    .srv.failed .dot { animation: srv-shake 240ms ease-in-out; }
    /* The press, answered in the frame it lands: the ✕ goes into the dot that
       is about to close. Feedback, not a transition — past ~150ms a click's own
       acknowledgement reads as latency. */
    .srv.stopping .x { animation: srv-swallow 140ms ease-in; }
    /* Nothing above loops once a chip is up: a running server is a state, and a
       board of six of them animates nothing at all. */
  }
  @keyframes srv-march { to { background-position: 6px 0, -6px 100%, 0 -6px, 100% 6px; } }
  @keyframes srv-draw { from { transform: scaleX(0); } }
  @keyframes srv-undraw { from { transform: scaleX(1); } }
  @keyframes srv-land {
    0% { text-shadow: 0 0 0 transparent; }
    35% { text-shadow: 0 0 7px color-mix(in srgb, var(--av-blue) 75%, transparent); }
    100% { text-shadow: 0 0 0 transparent; } }
  @keyframes srv-arc { to { transform: rotate(1turn); } }
  @keyframes srv-arrive { from { transform: scale(.3); } }
  @keyframes srv-flare {
    from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--av-green) 70%, transparent); }
    to { box-shadow: 0 0 0 5px transparent; } }
  @keyframes srv-close { from { transform: scale(1); } }
  @keyframes srv-shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-1.5px); }
    75% { transform: translateX(1.5px); } }
  @keyframes srv-swallow {
    from { opacity: 1; transform: none; }
    to { opacity: 0; transform: translateX(-14px) scale(.2); } }

  /* Selected: a ring of --av-focus and a glow of it. The ring is drawn as a
     shadow rather than as an outline so that it follows the border radius, and
     the glow is what separates this from a hover: the card above wears the
     same colour flat on its border, this one wears it twice over and lit. The
     blur is kept under the grid's 10px gap so a selected card does not wash
     the one beside it.
     The drop target below is the same colour, dashed, and lasts only as long
     as something is being dragged — shape, not hue, is what tells them apart. */
  .card.selected { border-color: color-mix(in srgb, var(--av-focus) 45%, var(--av-border));
                   outline: none;
                   box-shadow: 0 0 0 2px var(--av-focus),
                               0 0 7px color-mix(in srgb, var(--av-focus) 35%, transparent); }
  /* The card being read is not also the card being dimmed. */

  /* Dotted, background-less and centred, so both read as a slot rather than a
     session sitting among the real ones. The starting card is the add-card mid
     flight — same shape, so the grid does not shift when one becomes the other. */
  .card.add, .card.starting { border-style: dashed; background: none;
              align-items: center; justify-content: center; flex-direction: row;
              gap: 6px; min-height: 74px; font-size: var(--av-fs-lg); }
  .card.add { opacity: var(--av-dim); padding: 0; gap: 0; }
  .card.add:hover { opacity: 1; }
  .card.add svg { display: block; }
  /* Two halves of one slot: carry a conversation on (left), or begin one
     (right). Side by side inside the same card, so the slot keeps a card's
     width and a single card's height — the board measures its columns off a
     card, and neither half is allowed to change that. */
  .card.add .half { flex: 1; align-self: stretch; display: flex; align-items: center;
              justify-content: center; gap: 6px; cursor: pointer; min-width: 0; }
  .card.add .half:hover { background: var(--av-hover); }
  .card.add .half:first-child { border-radius: 7px 0 0 7px; }
  .card.add .half + .half { border-left: 1px dashed var(--av-border);
              border-radius: 0 7px 7px 0; }
  /* A draft is being written for this folder, and this slot is the whole of
     what the board says about one — there is no card until the send, so a slot
     that looked like every other slot would leave an unsent prompt with nothing
     pointing at it. Up out of the resting dim, and the New half solid, so the
     pair reads as *something is here* rather than as a hover that stuck.
     Its own colour rather than the selected ring: the reader is not looking at
     a session, and a slot wearing the selected mark for one that does not exist
     is the thing a pid-only selection exists to keep unrepresentable. */
  .card.add.drafting { opacity: 1; border-style: solid;
              border-color: color-mix(in srgb, var(--av-link) 45%, var(--av-border)); }
  .card.add.drafting .half[data-act="open"] {
              background: color-mix(in srgb, var(--av-link) 12%, transparent);
              border-radius: 0 7px 7px 0; }
  /* One start per group at a time: dimmer than the resting slot, and not
     hovering back up, so the card reads as unavailable rather than shy. */
  .card.add.busy, .card.add.busy:hover { opacity: var(--av-ghost); }
  .card.add.busy .half[data-act="resume"] { pointer-events: none; }

  .card.starting { opacity: var(--av-dim); cursor: default; gap: 8px; }
  .card.resuming { opacity: 1; flex-direction: column; align-items: stretch; }
  .resume-title { font-weight: 600; overflow-wrap: anywhere; }
  .resume-state { display: flex; align-items: center; gap: 8px;
                  color: var(--av-fg-3); font-size: var(--av-fs-md); overflow-wrap: anywhere; }
  .resuming.refused .resume-state { color: var(--av-orange); }
  .startup-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .startup-actions button { font: inherit; font-size: var(--av-fs-md); min-height: 24px;
                           padding: 3px 8px; color: var(--av-fg-2); background: none;
                           border: 1px solid var(--av-border); border-radius: 4px;
                           cursor: pointer; }
  .startup-actions button:hover { color: var(--av-fg); background: var(--av-hover); }
  .startup-actions button:focus-visible { outline: 1px solid var(--av-focus); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    .card.resuming .spinner { animation: none; }
  }
  /* Going, not gone: dimmer than a settled card and still selectable, because
     the dock's transcript is worth reading right up to the moment the card
     leaves. Only the interrupt is taken away, and the markup takes it — this is
     the dimming, not the guard. */
  .card.closing { opacity: var(--av-dim); }
  /* failed's red: the one thing asked of it did not happen. */
  .card.endstuck { --st: var(--av-red); }
  /* Sized to the dot it stands in for, not to the starting card's spinner: the
     head row is laid out around a 7px dot, and dropping a 13px one into it
     would grow the row and reflow the card at the moment it is clicked. */
  .head .spinner { width: var(--dot, 7px); height: var(--dot, 7px); border-width: 1.5px; }
  .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%;
             border: 2px solid var(--av-border);
             border-top-color: var(--av-link);
             animation: spin 700ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Keep actions together so a narrow card wraps the whole set instead of clipping End. */
  .head { display: flex; align-items: center; gap: 8px; }
  .head .icon:first-of-type { margin-left: auto; }
  .card .head { flex-wrap: wrap; }
  .header-state, .header-actions { display: flex; align-items: center; gap: 6px; flex: none; }
  .header-actions { margin-left: auto; }
  .header-actions .icon:first-of-type { margin-left: 0; }
  /* Two lines, then the ellipsis — and where the first line breaks is the
     browser's business, so the title uses whatever width the card happens to
     have. The clamp puts the ellipsis on the last word that fits; the min-height
     beside it is what makes a one-line title still cost two.
     Measured in the IDE's Chromium against the real panel document, five cards
     from bare to fully loaded: 142px each at card widths 237-348px, name row
     36px (--av-fs-lg 14px x 1.3 x 2 = 36.4). Two lines at every width, since no
     width tier touches this. Without the min-height a retitle moves the card and
     every card in its grid row. line-height is stated rather than left at
     'normal', because the reservation is two of them and 'normal' is a number
     the font chooses. Headless Chromium reads that same card 145, with no rule
     it uses changed between: the 3px is the instrument, not drift, and the
     height tier at the foot of this file is set from the lower of the pair. */
  /* Stated, not inherited: this is the largest text on the board, and it used
     to be whatever the body happened to carry — so the scale described every
     line on a card except the one a reader looks at first. */
  .name { font-size: var(--av-fs-lg); font-weight: 600;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .name { overflow-wrap: anywhere; white-space: normal;
                display: -webkit-box; -webkit-box-orient: vertical;
                -webkit-line-clamp: 2; line-clamp: 2;
                line-height: 1.3; min-height: 2.6em; }
  /* EXPERIMENT (typography-m2): Overline is 10/500 — the weight is half of what
     makes it read as a chip at that size. Was unweighted, with 600 on .waiting
     alone; that override is gone below, since a weight every pill carries can no
     longer be what marks one of them out. */
  .pill { flex: none; font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .05em;
          font-weight: 600;
          padding: 2px 7px; border-radius: 10px;
          background: var(--av-badge-bg); color: var(--av-badge-fg); }
  /* On a card the state is already the rail and the dot, so the word beside them
     is a caption, not a third badge: no fill, coloured only where the state is
     worth colouring. The dock's pill is the last filled one and stays that way —
     there is one of it, and it is a heading rather than something to scan. */
  .card .pill { padding: 0; background: none; color: var(--st, inherit); }
  #chat-head.busy .pill { background: var(--av-blue); color: var(--av-on-blue); }
  #chat-head:is(.waiting, .stalled) .pill { background: var(--av-orange); color: var(--av-on-orange); }
  #chat-head.done .pill { background: var(--av-green); color: var(--av-on-green); }
  #chat-head.failed .pill { background: var(--av-red); color: var(--av-on-red); }

  /* The status dot: the rail's colour again, leading the strip. Paint only —
     the box is .dot's. Still scoped to .card, and the tally's dot named beside
     it, because a ticket's priority dot is also a .dot and means something
     else: sharing the circle is not sharing the meaning. */
  .card .dot, #status-menu .dot { background: var(--st, var(--av-border)); }
  /* Only the two states that are going somewhere breathe, waiting the faster of
     them: motion in the grid should mean "this one wants you", not "still here". */
  @media (prefers-reduced-motion: no-preference) {
    .card.attention .dot { animation: pulse var(--pulse-period) ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  }

  /* Eighteen pixels of ink, twenty-six of target. The padding stays at 3px —
     growing it would move the header rows these sit in — and a transparent
     ::before at inset -4px claims the gap around the glyph instead. The dock
     head and the card head both space these 8px apart, so 18 + 8 = 26 and five
     targets abut without ever overlapping. The hover fill grows with a spread
     shadow rather than a bigger box: an outer shadow paints behind the glyph,
     so what lights up under the pointer is the target and not a smaller lie
     about it. WCAG 2.2 SC 2.5.8 wants 24. */
  .icon { flex: none; background: none; border: none; color: inherit; opacity: .5;
          cursor: pointer; line-height: 0; padding: 3px; border-radius: 4px;
          position: relative; }
  .icon::before { content: ''; position: absolute; inset: -4px; }
  .icon:hover { opacity: 1; background: var(--av-hover); border-radius: 6px;
                box-shadow: 0 0 0 4px var(--av-hover); }
  .card .icon[data-act="warm"][aria-pressed="true"] { opacity: 1; color: var(--av-orange); }
  .card .icon[data-act="warm"][aria-pressed="true"] svg {
    fill: color-mix(in srgb, var(--av-orange) 28%, transparent); }

  /* The chrome step, not the body one: this row is model, effort, context and
     the idle time, and at 14px it needs 292px in the 278 a 305px card gives it
     — so the time at its far end was clipped away by the card's own overflow on
     every session reporting a percentage. 12px fits it whole. */
  .specs { display: flex; gap: 6px; align-items: center; font-size: var(--av-fs-md);
           color: var(--av-fg-2);
           white-space: nowrap; overflow: hidden; }
  .specs .sep { color: var(--av-fg-3); }
  .strip-reading .ctx-held { color: var(--av-fg-3); margin-left: 2px; }
  /* The model bit is a span on every card. It was a button that opened the
     model menu, and the hit-target, caret and hover rules that made a control
     out of a line of specs went with it: a pick from a board buys nothing until
     a turn runs, so the menu is the composer's now — where a reader is writing
     the turn that would carry it. */
  /* The brand mark, inside that span and ahead of the name — the 180px tier
     hides \`.s-name\`, so the mark stays and the model id it belongs to goes:
     which CLI a card is running is one glyph, and the narrowest card can still
     afford it. Sized because an inline <svg> carrying a viewBox and no width
     lays out at the SVG default of 300x150; the nav sizes its copy the same way
     (css/nav.ts, .acct .bmwrap). Nothing here reaches .s-model or .s-name from
     an ancestor: such a rule would outrank the tier's own \`display: none\`. */
  .specs .bmwrap { display: inline-block; margin-right: 4px; vertical-align: -1px; }
  .specs .bmwrap svg { display: block; width: 11px; height: 11px; }
  /* The model is what yields when the row is longer than the card. Its length
     is the CLI's — core/models.ts asks \`list_models\` — so nothing here bounds
     it, and .specs being a nowrap flex row with hidden overflow meant the last
     item fell off instead: .since, the one field saying how old the card is,
     gone with no ellipsis. Measured at 320px (an ordinary two-up card, below no
     container query) the row wanted 299px of 293 on claude-haiku-4-5-20251001.
     min-width:0 is what lets a flex item shrink under its content at all.
     Written at (0,1,0) on purpose — see above. */
  .s-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* .fmenu.floating was declared here — \`position: fixed; top: auto\` — for
     that model menu, because a .card hides its overflow and so does .specs. It
     is in css/bottom_drawer.ts now, beside the z-index the same selector already had
     there, since the row menu on the bottom drawer is the only floating menu
     the panel builds today. What stays on this side is the listener the rule
     needed: webview/board_actions.ts closes any open menu when #cards scrolls,
     because a menu placed once from its anchor's rect is stale the moment the
     anchor moves. */
  /* What a switch costs, under the list. Warning colour rather than muted: it
     is the one line in this menu the reader is not expected to already know,
     so the cost remains visible before a switch.

     Unqualified: .mwarn is the model menu's line and only ever that. The menu
     was opened from two places — the card's specs bit, where it floated, and
     the composer's pill, where it does not — and the card's opener has since
     gone (taskhub H4(2)). Left unqualified anyway: a selector per opener is how
     two surfaces come to disagree about the same sentence, and the card's is
     the kind of control that comes back. */
  /* ===== the model menu's window pills (shape B) =====

     Locked as docs/mockups/model-menu-windows.html, combination g4 + p3, and
     every figure below is measured on that page rather than chosen here.

     **Unscoped: nothing else in the panel draws a .wp, so a scope buys
     nothing.**

     What used to be here: .mmodels .mitem .sub, which stopped a 26-character
     id squeezing "Haiku 4.5" down to "Ha…". There is no id column left — the
     pills took it — so the rule went with it. */

  /* The .sub's column, exactly: whatever the row's right-hand side is for, it
     is one thing at a time. Copied from .mitem .sub in css/bottom_hub.ts, which
     is what makes "the same column" a fact rather than a claim.

     align-items, explicitly: without it a pill inside a <button> row stretches
     to the row's content box and comes out 10px taller than the same pill in a
     <div> row. Measured. */
  .wps { margin-left: auto; padding-left: 10px; flex: none;
         display: flex; align-items: center; gap: 4px; }
  /* min-height 24px is SC 2.5.8's floor, and the number is not chosen here:
     .fbtn in css/tickets.ts already carries it, and a pressable pill is that
     same box rather than a second answer to the same question.

     min-width 46px so every pill is one width whatever it reads — 1M and
     200k in a column that does not ripple. box-sizing stated rather than
     inherited: the shipped sheet gives a <button> one and a <span> keeps
     content-box, so the same min-height drew a paint-only pill 10px taller and
     charged a whole mockup variant 200px for a markup difference. Measured,
     twice.

     Rejected on the mock: g3's segmented pair, which reads as a toggle group
     and loses the gap; g6's -5px reach, which overlapped the row above. */
  .wp { font-family: inherit; font-size: var(--av-fs-sm); line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
        box-sizing: border-box; position: relative;
        min-height: 24px; min-width: 46px;
        padding: 4px 7px; border-radius: 4px; cursor: pointer;
        border: 1px solid var(--av-border); background: none; color: var(--av-fg-3); }
  /* The target, claimed past the paint: 46x27 against SC 2.5.8's 24. The 4px
     gap between two pills is left alone deliberately — a pointer landing in it
     hits nothing, and a click that does nothing beats one that picks the other
     window. Note for anyone measuring this: getBoundingClientRect does not
     include a pseudo-element that overflows its host, so a rect reads the paint
     and not the target (see session.smoke.ts). */
  .wp::before { content: ''; position: absolute; inset: -3px -1px; }
  .wp:not(.on):not(.off):hover { border-color: color-mix(in srgb, var(--av-fg) 35%, transparent);
              color: var(--av-fg-2); }
  /* The window in force, in the same fill the picked row has worn since
     3cbe387, and the row it sits on at 10% of it — one vocabulary for "this
     one", at two scales. */
  .wp.on { background: color-mix(in srgb, var(--av-link) 24%, transparent);
           border-color: color-mix(in srgb, var(--av-link) 45%, transparent);
           color: var(--av-fg); }
  /* Offered and refusable: dashed, not dimmed. .off promises drawn-dimmed-and-
     unpickable and this window is pickable — the refusal is a 400 in that
     session's own thread, which is where a reader can act on it. The border is
     the whole of the mark, so the tip that explains it is not optional
     (board_settings.ts). */
  .wp.gated { border-style: dashed; }
  /* Unreachable: this session's own launch line cannot carry this window,
     whatever the id spells — its settings were composed at spawn. Dimmed and
     unpickable, which is what .off has promised since css/tickets.ts, and its
     own rule because that one is .mitem-scoped and this is not a .mitem. The
     two stay separate decisions rather than one widened selector.

     Over .gated where an entry is both: unreachable is a certainty and the
     billing gate is a maybe that would never be reached, so board_settings.ts
     draws one mark and not two. */
  /* .off takes no hover, and neither does .on — which is not a new rule but the
     old cascade written down. .wp:hover and .wp.on are both (0,2,0) and .on came
     later, so hover never repainted the in-force pill; adding :not(.off) alone
     lifted hover to (0,3,0) and it started winning. Matching neither keeps the
     paint where it was and says so (review, 2026-08-29). */
  .wp.off { opacity: .45; cursor: default; }
  /* The row is a label, not a control, and must not look like one: it gives up
     the hover and the cursor it inherits from .mitem. 3px of padding, against
     the shipped row's 5px — the pill is the target now, so the row is no longer
     spending height on being one. */
  .mitem.wins { cursor: default; padding-top: 3px; padding-bottom: 3px; }
  .mitem.wins:hover { background: none; }
  .mitem.wins.lit { background: color-mix(in srgb, var(--av-link) 10%, transparent); }
  /* Which CLI a row is, beside its name. Sized off .specs .bmwrap above rather
     than chosen again: the specs line is the other place a mark rides a line of
     text, and two answers to how big a brand mark is is one too many. */
  .mitem .bmwrap { flex: none; width: 13px; height: 13px; }
  .mitem .bmwrap svg { display: block; width: 13px; height: 13px; }

  /* ===== the fold: one row standing for a brand's older models =====

     A row and not a heading, because it is pressed. It keeps .mitem's box, so
     it is a stop on the arrow walk and a 24px target without a second opinion
     about either; only the twisty and the quieter colour are its own. */
  .mfold { color: var(--av-fg-3); }
  .mfold:hover { color: var(--av-fg-2); }
  .mfold .tw { flex: none; width: 0; height: 0; margin-left: 1px; opacity: .7;
               border: 4px solid transparent; border-left-color: currentColor; }
  /* Rotated rather than swapped for a second glyph: one triangle, one state,
     and the transform is what says the two are the same thing. */
  .mfold.on .tw { rotate: 90deg; }
  @media (prefers-reduced-motion: no-preference) {
    .mfold .tw { transition: rotate 120ms ease; }
  }
  /* A folded row is hidden in place — .mitem declares display: flex, which beats
     the [hidden] attribute's UA display: none, so hiding one without this rule
     hides nothing at all. Same trap .fmenu.pmenu:not([hidden]) records in
     css/tickets.ts. */
  .mitem[hidden] { display: none; }

  /* The model menu's own cap. min(70vh, 420px) is .smenu.accts's figure
     (css/nav.ts) and not a new one: that popover is the panel's other list-
     holding menu, and .fmenu's 260px is sized for a menu of commands — at three
     brands this list draws a fifth of itself inside it. Measured against the
     alternatives in docs/mockups/model-picker-scale.html.

     The scroller then takes whatever the bands leave, rather than .fscroll's
     216px: that figure is a filter pill's, sized for about eight options.

     **Four classes and a :not, because it has to beat .fmenu.pmenu:not([hidden])**
     — that rule states min(340px, 100vh - 24px), it is (0,3,0), and css/tickets.ts
     is cascaded after this file either way. Drawn at 340 the menu shows seven
     rows of twenty, which is the number this change exists to move. Measured in
     a real engine against the shipped sheet; jsdom resolves no cascade at all,
     so nothing in the unit suite could have said which rule won.

     **What a host was asked, 2026-09-02** (ui_test_scenarios.md step 5, whose
     answer belongs beside the rule rather than in a commit message nobody
     re-reads). A taller flyout flips upward sooner — placeFlyout compares
     row.top + height against the viewport — so the risk this cap carries is
     placement, not height. panel.smoke.ts already holds both placement cases,
     beside the menu and dropped under its row, and both pass at 420 with two
     brands offered. No new smoke case: it would launch a host to re-ask a
     question two existing cases put to it. The 420 itself was measured off the
     rendered box, not asserted. */
  .fmenu.pmenu.mmodels:not([hidden]) { max-height: min(70vh, 420px); }
  .fmenu.mmodels .fscroll { flex: 1 1 auto; max-height: none; }
  /* The inherited-model choice sits outside the scroller. Its label's wrap is
     in css/tickets.ts, after the generic .nm rule it overrides. */
  .fmenu.mmodels > .mitem { flex: none; }
  /* The composer's cold-cache line is a band of the menu, not the last row of
     its list: it is true of every pick above it, so it must not scroll away.
     Its rule is the band's, drawn the way .ffoot draws its own. */
  .fmenu.mmodels .mwarn { flex: none; margin-top: 4px; padding-top: 7px;
       border-top: 1px solid color-mix(in srgb, var(--av-menu-fg) 26%, var(--av-menu-bg)); }
  /* Both marks are color-mix, which Windows high contrast throws away for a
     forced Canvas — so without this the menu says nothing there about which
     window is in force. css/tickets.ts gives .mitem.pick.on the same treatment
     for the same reason. */
  @media (forced-colors: active) {
    .wp.on { outline: 2px solid Highlight; outline-offset: -2px; }
    .mitem.wins.lit { outline: 1px solid Highlight; outline-offset: -1px; }
  }
  /* .wp.gated needs no forced-colors clause: border-style is not a colour, so
     high contrast keeps the dash where it throws the fills away. Stated because
     the absence otherwise reads as an oversight beside the two above. */
  .mwarn {
    padding: 6px 10px 8px; max-width: 240px; white-space: normal;
    font-size: var(--av-fs-md); line-height: 1.45; color: var(--av-orange); }
  /* The running-command chip, in the status row after the state word. Outlined
     rather than filled: the state is what the card is about, and a second solid
     badge beside the pill would read as a competing state. Keeps the purple
     the shell status used to paint a whole card in, so nothing is unlearned. */
  .cmd { flex: none; font-size: var(--av-fs-md); line-height: 1.6; padding: 0 6px;
         border-radius: 9px; white-space: nowrap;
         border: 1px solid var(--av-purple); color: var(--av-purple); }
  .card .cmd { display: inline-flex; align-items: center; justify-content: center;
               width: 22px; height: 22px; box-sizing: border-box; padding: 0; }
  /* The idle time lives at the end of the specs row, not on a row of its own.
     Muted while the cache is warm — it is one number among several — and lit
     as the cache deadline comes up. */
  .since { color: var(--av-fg-3); white-space: nowrap; }
  .specs .since { margin-left: auto; padding-left: 6px; }
  .since.warm { color: var(--av-orange); }
  .since.cold { color: color-mix(in srgb, var(--av-blue) 60%, var(--av-fg-3)); font-weight: 600; }
  .empty { color: var(--av-fg-3); }

  /* The card's footer: where the session is. The auto top margin is what pins
     it to the bottom edge — the card is a flex column that the grid stretches
     to its row's height, so that margin takes up whatever slack the row has.
     Everything above the strip comes and goes with the session, so a strip that
     merely followed the content would sit at a different height on every card;
     this way the gap above it varies and the strips stay level.
     The negative margins reach back through the card's padding, so the strip is
     full-bleed and its rule reads as the card's own edge. The min-height is what
     keeps an empty one the same height as a full one. */
  .foot { margin: auto -12px -10px -13px; padding: 4px 12px 5px 13px; min-height: 25px;
          position: relative; isolation: isolate;
          --ctx: var(--av-green);
          border-top: 1px solid var(--av-border); background: var(--av-hover);
          display: flex; align-items: center; gap: 6px; overflow: hidden; }
  .foot.mid { --ctx: var(--av-yellow); }
  .foot.full { --ctx: var(--av-red); }
  .foot .strip-fill { position: absolute; z-index: -1; inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--ctx) 22%, transparent);
    border-right: 1px solid var(--ctx); }
  .strip-reading { margin-left: auto; flex: none; white-space: nowrap;
    font-size: var(--av-fs-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
  .strip-reading .capacity { color: var(--av-fg-2); }
  /* Only an in-flight ping animates; visibility and the viewport pause it. */
  :is(.card.warm-on, .card.warming) .foot {
    --warm-copper: color-mix(in srgb, var(--av-orange) 65%, #a64b1d);
    --warm-amber: color-mix(in srgb, var(--av-orange) 70%, #e9943a);
    --warm-hot: color-mix(in srgb, var(--av-orange) 35%, #f7c768); }
  :is(.card.warm-on, .card.warming) .foot::after { content: ''; position: absolute;
    bottom: 0; left: 0; width: 100%; height: 2px; pointer-events: none;
    background: linear-gradient(90deg, var(--warm-copper), var(--warm-amber) 15%,
      var(--warm-hot) 35%, var(--warm-amber) 55%, var(--warm-copper) 70%,
      var(--warm-hot) 90%, var(--warm-copper));
    background-size: 200% 100%; }
  .card.warming .foot::after { animation: molten-strip 4.8s ease-in-out infinite alternate paused; }
  .card.warming.warm-visible .foot::after { animation-play-state: running; }
  body.warm-paused .card.warming .foot::after { animation-play-state: paused; }
  @keyframes molten-strip {
    from { background-position: 0% 0; opacity: .8; }
    to { background-position: 100% 0; opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .card.warming .foot::after { animation: none; }
  }
  .foot .br { flex: 0 1 auto; }
  .br { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: var(--av-fs-md);
        color: var(--av-fg-2); font-family: var(--vscode-editor-font-family); }
  .br .g { flex: none; }
  /* Without a minimum of 0 the name stays as wide as its text and paints over
     the context reading beside it. */
  .br .n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* A worktree reads as weight, not as hue: the card already spends purple on
     the command chip, and one colour with two meanings is a colour with none. */
  .br.wt { color: var(--av-fg); font-weight: 600; }

  .mode { margin-left: 0; min-width: 0; overflow: hidden; white-space: nowrap; flex: none; display: inline-flex; align-items: baseline; gap: 5px;
          font-size: var(--av-fs-md); color: var(--av-fg-3); }
  .mode > span:last-child { overflow: hidden; text-overflow: ellipsis; }
  .mode .g { font-family: var(--vscode-editor-font-family); letter-spacing: -.08em; }
  .mode.bypass { color: var(--av-orange); }
  .specs .mode { color: var(--av-fg-2); }
  .specs .mode.bypass { color: var(--av-orange); }
  .specs .mode .g { display: none; line-height: 1; }

  /* Card density: hide secondary chrome below two container breakpoints,
     rather than squeezing every element until overflow clips it. Markup is
     unchanged — board.ts already emits every part; these are display:none
     lists keyed on the classes card() puts on the specs bits and the foot.
     See docs/mockups/session-card-compact.html. */

  /* Snug ≤ 240px: drop effort and abbreviate bypass to its glyph. */
  @container card (max-width: 240px) {
    .s-effort, .s-sep-effort { display: none; }
    .specs .mode.bypass { position: relative; }
    .specs .mode.bypass .g { display: inline; }
    .specs .mode.bypass > span:last-child { position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  }

  /* Compact ≤ 180px: the model id goes
     (since alone is enough in specs) while its brand mark stays — .s-name, not
     .s-model, for that reason; bypass keeps its glyph. Context bar stays. All action icons
     stay. Foot min-height stays so row strips stay level.

     **A width tier takes nothing away from the card's height.** This one clamped
     the name to one line until the block tier below existed to do it — 124px
     instead of 142 — and it cost the title where the title could least afford
     it: at 165px a line holds about 18 characters, so one line truncates more
     here than one line does at 305px. */
  @container card (max-width: 180px) {
    .s-name, .mode:not(.bypass), .s-sep-mode { display: none; }
    .head { gap: 6px; }
  }

  /* The add slot, once a half can no longer hold an icon beside its word.
     "Resume" at 14px system UI — the panel font, not the editor font — is
     52px; the icon is 14 and the gap 6, so the row needs 72px. Half of a
     160px content box is about 80, the last width that row still has air.
     Below it the icon stacks over the word. 14 + 4 + one line is about 36,
     inside the slot's 74px, so this tier takes nothing off the card's
     height and the two halves stay side by side. The span is clipped to the
     half: a flex item's min-content size would otherwise paint the word
     across the divider. */
  @container card (max-width: 160px) {
    .card.add .half { flex-direction: column; gap: 4px; }
    .card.add .half span { min-width: 0; max-width: 100%; overflow: hidden; }
  }

  /* The stacked word's own floor. A half of a 130px content box is about
     65px, and 52px of "Resume" with 6px aside is all that holds — a wider
     face is already against the edges. Below it the word would clip
     against the divider, so it goes and the icon stays. The tip on the
     half still names which one it is. */
  @container card (max-width: 130px) {
    .card.add .half span { display: none; }
  }

  /* Short: the only tier keyed on the block axis. A caller
     that hands its cards a definite height — a group box sizing its members —
     sets \`--card-axis: size\` in the same rule that sets the box, and the card
     reflows off the height it was given rather than off a class it wears.

     Size containment is why that opt-in exists: \`container-type: size\` stops
     the card's own contents from setting its height, so a card asked a block
     question it was never given a height for collapses to nothing.
     Rejected: width alone, which cannot see a 348x96 box; a size container
     above the card, which needs the same definite height and an element
     board_card.ts does not emit; size containment with a px min-height floor,
     which writes the full card's height into the stylesheet for good.

     Measured in headless Chromium (Playwright 1228) against this stylesheet
     with Dark Modern's host variables, cards at 180-348px wide, bare to fully
     loaded — border box, then the content box a container query reads:
       full     145px / 123.4   — 148 / 125.6 with the ⌘ chip in the head
       short     96px /  74.2   — 98 / 76.4 with the chip
     Two rows and not three: every card the panel sizes for itself is the full
     one, whatever its width.
     The threshold is 120 and not 123 because the IDE reads that same full card
     3px shorter — 142, so 120.4 of content, recorded on \`.card .name\` above.
     The lower of the two is the only value at which a box sized to a full card
     cannot fall to this tier on either instrument; the cost is that a box
     between them keeps the full card and clips a pixel or two of it. Under 96
     the short card clips, on the overflow .card already hides.

     This query stands alone and is never folded into the width one with \`or\`:
     a condition naming a block feature is not evaluated against an inline-size
     container at all, so \`(max-width: 180px) or (height < 120px)\` stops firing
     at 180px entirely. Measured in the same browser.

     The age goes with .specs — half-height.html keeps it by moving .since into
     the head, and that node is board_card.ts's to move. */
  @container card (height < 120px) {
    .specs { display: none; }
    .card .name { -webkit-line-clamp: 1; line-clamp: 1;
                  white-space: nowrap; display: block; min-height: 1.3em; }
  }

`;
