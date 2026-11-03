/** The bottom hub over the board. */

export const css = /* css */ `
  /* The bottom hub. Absolute over #cards, since #board is already
     position: relative — never a row, which would resize the board on every
     state change and re-slot the grid. z-index 12 keeps it under #scrim (30),
     #ask (31) and #picker (33), so a pending question still covers the column
     entire.

     One oval, one row, and one size: the bar arms nothing and carries no run
     state, so its width changes only when a person changes it. That is what
     makes centring safe — a bar whose width tracked a live readout could not be
     centred without sliding sideways every 3s and dragging its own menu with it.

     No overflow: hidden. The menu opens upward out of this box, and a clip here
     is what silently eats it. */
  #bottomhub { position: absolute; left: 50%; transform: translateX(-50%);
            bottom: 14px; z-index: 12;
            width: max-content; max-width: calc(100% - 36px); box-sizing: border-box;
            display: flex; align-items: center; gap: 9px;
            padding: 5px 11px 5px 14px; border-radius: 999px;
            border: 1px solid var(--av-menu-border);
            background: var(--av-menu-bg); color: var(--av-menu-fg);
            box-shadow: 0 6px 20px rgba(0, 0, 0, .35); }
  /* Padding on the scroller, never a height on #board: the board's width is what
     the grid measures its columns from, and a row that resized it would re-slot
     the cards every time the bar came or went. */
  #board.hasbar #board-body > :not(#alert) { padding-bottom: 58px; }
  /* No status hue and no --st: the colours were the run's, and the run is not
     reported here. The border is the menu border in every state this bar has. */
  /* Shrink, do not grow: short names keep the capsule tight; long ones yield
     to max-width on #bottomhub instead of pushing Edit/on past the board edge.
     min-width: 0 is what lets a flex child actually go below content width. */
  #bottomhub .fwrap { flex: 0 1 auto; min-width: 0; max-width: 100%; }
  #bottomhub .fpill { max-width: 100%; min-width: 0; overflow: hidden; }
  #bottomhub .fpill .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                       min-width: 0; flex: 1 1 auto; }
  #bottomhub .fpill .caret, #bottomhub .fpill .sarr { flex: none; }
  /* Upward, and only here. Every other menu in the panel hangs off a control near
     the top of its column and opens downward; this one sits just off the bottom of
     the board, where downward is off-screen. The top: auto has to go with it, or
     the rule the shared .fmenu sets would win and the menu would try to be in two
     places at once.

     The offset is measured from the pill, not from the capsule around it, so it
     has to clear the bar itself: 8px of air plus the 6px of bar above the pill —
     5px of padding and a 1px border. At the 6px a gap alone would suggest, the
     menu sits flush against the capsule's edge. Change #bottomhub's padding and this
     number changes with it.

     Depth rather than hue. The accent border this rule used to carry read as
     *selected*, which a menu standing open is not — and it spent the one colour
     the checked row inside the menu needs. So the menu leaves the canvas by the
     three means a theme cannot mistake: a surface a shade over --av-menu-bg, a
     shadow deep enough to seat it, and a lit top edge. The mix is toward white
     and so is a no-op on a light preset, where the menu is already the lightest
     surface there is and the shadow is what carries it.

     Every offset is negative, because this is the one menu that opens upward:
     the light is still above it. */
  #bottomhub .fmenu { top: auto; bottom: calc(100% + 14px);
                   background: color-mix(in srgb, var(--av-menu-bg) 93%, #fff);
                   box-shadow: 0 -14px 34px rgba(0, 0, 0, .5),
                               0 -2px 6px rgba(0, 0, 0, .4),
                               inset 0 1px 0 rgba(255, 255, 255, .07); }
  /* 250ms, not the 130 a menu this small suggests: at that speed the scale
     lands before the eye has found the box and reads as a flicker rather than
     as a rise. */
  @media (prefers-reduced-motion: no-preference) {
    #bottomhub .fmenu { animation: rbpop 250ms cubic-bezier(.2, .8, .3, 1) both;
                     transform-origin: bottom left; }
    @keyframes rbpop { from { opacity: 0; transform: scale(.96) translateY(4px); } }
    /* Paired with the sheet's own rise, which is declared in css/bottom_drawer.ts
       beside the sheet it moves. This half is the bar's and belongs here. */
    #bottomhub { transition: opacity 140ms ease; }
    #board.drawer-open #bottomhub { transition: opacity 140ms ease, visibility 140ms; }
  }

  /* What the bar carries: one word per board-wide surface. Workflows opens
     the sheet and Warm opens that sheet's other mode. The count is the one
     figure here; tabular numerals keep a changing digit from sliding the
     word beside it. */
  #bottomhub .wmore, #bottomhub .hpill { flex: none; min-height: 24px; display: inline-flex;
                   align-items: center; justify-content: center; padding: 0 10px;
                   border-radius: 999px; border: 1px solid transparent; cursor: pointer;
                   background: none; color: var(--av-fg); font-family: inherit;
                   font-size: var(--av-fs-md); white-space: nowrap; }
  #bottomhub .wmore:hover { border-color: var(--av-focus); }
  #bottomhub .bottomhub-row { display: flex; align-items: center; gap: inherit;
                       min-width: 0; max-width: 100%; }
  #bottomhub .bottomhub-row > :first-child { flex: 0 1 auto; min-width: 0;
                                     overflow: hidden; text-overflow: ellipsis; }
  #bottomhub .bottomhub-row.measuring > :first-child { flex: none; }
  #bottomhub .more { gap: 7px; }
  #bottomhub .more .dot { --dot: 6px; box-sizing: border-box; background: var(--st, transparent); }
  #bottomhub .more .dot:is(.live, .on) { --st: var(--av-green); }
  #bottomhub .more .dot.held { --st: var(--av-orange); }
  #bottomhub .more .dot.pending { --st: var(--av-blue); }
  #bottomhub .more .dot.fault { --st: var(--av-red); }
  #bottomhub .more .dot.elsewhere { background: none; border: 1px solid var(--av-fg-2); }
  #bottomhub .bottomhub-overflow { position: absolute; bottom: 100%; display: flex;
                           flex-direction: column; align-items: center; gap: 8px;
                           width: max-content; max-width: calc(100vw - 36px);
                           padding: 8px; overflow-y: auto; scrollbar-width: thin; }
  #bottomhub .bottomhub-overflow[hidden], #bottomhub .more[hidden] { display: none; }
  #bottomhub .bottomhub-overflow[inert] { pointer-events: none; }
  #bottomhub .bottomhub-overflow > button { min-height: 32px; padding: 0 14px;
                                    border-color: var(--av-menu-border);
                                    background: var(--av-menu-bg); transform-origin: center bottom;
                                    box-shadow: 0 4px 12px #0005; }
  #bottomhub .bottomhub-overflow > button:not([aria-disabled="true"]):hover {
    background: var(--av-list-hover); }

  #bottomhub .warm-tab { gap: 5px; }
  #bottomhub .hpill[aria-expanded="true"] {
    background: var(--av-list-hover); border-color: var(--av-menu-border); }
  /* Remote's dot: the card's own status hues (css/board.ts), so every preset
     already has them. Transparent while off rather than absent, so a tone
     arriving does not widen the bar. Another window holding Remote is a ring:
     on for the machine, not drivable from here. */
  #bottomhub .remote-tab { gap: 6px; }
  #bottomhub .remote-tab .dot { --dot: 6px; box-sizing: border-box;
                             background: var(--st, transparent); }
  #bottomhub .remote-tab .dot.pending { --st: var(--av-blue); }
  #bottomhub .remote-tab .dot.live { --st: var(--av-green); }
  #bottomhub .remote-tab .dot.fault { --st: var(--av-red); }
  #bottomhub .remote-tab .dot.elsewhere { background: none; border: 1px solid var(--av-fg-2); }
  /* Keep-awake's dot, the same way: held is green, refused while wanted is
     the waiting hue, quiet is transparent. */
  #bottomhub .awake-tab { gap: 6px; }
  #bottomhub .awake-tab .dot { --dot: 6px; background: var(--st, transparent); }
  #bottomhub .awake-tab .dot.on { --st: var(--av-green); }
  #bottomhub .awake-tab .dot.held { --st: var(--av-orange); }
  /* Agents' dot: green while Orchestration is on, transparent while off. */
  #bottomhub .agents-tab { gap: 6px; }
  #bottomhub .agents-tab .dot { --dot: 6px; background: var(--st, transparent); }
  #bottomhub .agents-tab .dot.on { --st: var(--av-green); }
  @media (prefers-reduced-motion: no-preference) {
    #bottomhub .remote-tab .dot.pending { animation: rdpulse 1.6s ease-in-out infinite; }
    @keyframes rdpulse { 50% { opacity: .35; } }
  }
  body.warm-paused #bottomhub .remote-tab .dot.pending { animation-play-state: paused; }
  #bottomhub .warm-tab .num { font-size: var(--av-fs-sm); color: var(--av-fg-2);
                           font-variant-numeric: tabular-nums; min-width: 10px; }
  /* A surface not built yet: in place, so the bar keeps its width, and quiet. */
  #bottomhub .hpill[aria-disabled="true"] { color: var(--av-fg-3); cursor: default; }
  #board.drawer-open #bottomhub .wmore { color: var(--av-fg); }
  /* While the sheet is up the bar is *what rose*, not a second control above
     it: it fades and yields, and the sheet's pull handle is where it went.

     \`visibility: hidden\` and not \`opacity: 0\` alone. A transparent element
     is still in the tab order, so the handle went on being reachable by
     keyboard while the sheet it opens was already up — invisible, focusable,
     and its Enter landing on a control nobody could see. Visibility takes it
     out of the tree for both the pointer and the caret, which is also why there
     is no \`pointer-events: none\` here any more: it said half of what this
     says.

     Transitioned alongside the fade so it still yields rather than blinking —
     visibility flips at the far end going out, and at once coming back, which
     is exactly the order these two want. Coming back is untransitioned, not
     transitioned: a visibility transition starts at its old value, so the
     sheet's close would hand focus to a word still hidden, and Chromium drops
     it on body. The transitions are in the reduced-motion block above. */
  #board.drawer-open #bottomhub { opacity: 0; visibility: hidden; }

  /* The arm switch (.rsw) and the bar's quiet Edit (#bottomhub .bedit) were
     here, and both are gone. Their rules went with them rather than being
     left for a class name somebody reuses. Edit is behind every row's own
     menu, in css/bottom_drawer.ts. */
  .mitem .sub { margin-left: auto; padding-left: 10px; flex: none;
                color: var(--av-fg-3); font-size: var(--av-fs-sm); }
`;
