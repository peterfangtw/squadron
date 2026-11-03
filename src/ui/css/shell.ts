/** Board/dock frames, divider and board layout. */

export const css = /* css */ `
  /* The board: the nav bar and the scrolling cards, stacked. Making
     it a box of its own is what keeps the bar honest — it is a flex item beside
     the cards, so it cannot cover them, whatever either one's height turns out to
     be. Only #cards and #tk-list scroll; #board and #dock are fixed frames around them. */
  /* Positioned so the pending-ask layer can be placed against this box and
     nothing else. #board already *is* the card column — flexbox resizes it on
     every frame of a divider drag — so a child inset from it follows the
     divider and the window with no script and no width to keep in sync. */
  /* Also the query container the nav bar reads. The bar's width is this
     column's, and this column is narrowed by the divider being dragged or the
     editor group being split —
     so a media query against the window would answer the wrong question for
     one of them. flex: 1 resolves from a 0% basis, so inline-size
     containment takes nothing away: the width was never content's to decide.
     The steps themselves are in css/nav.ts. */
  #board { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative;
           container-type: inline-size; --board-gutter: 18px; }
  /* One frame for every view: a filter head over a body. Each view puts one
     child in each and only the picked pair is shown, so switching view moves
     nothing but the content. */
  #board-head { flex: none; display: flex; align-items: center; min-height: 44px;
                padding: 6px var(--board-gutter); box-sizing: border-box; }
  #board-head > * { flex: 1; min-width: 0; display: flex; align-items: center; }
  /* Positioned for #alert, the one child floated over the others. --body-pad is
     where their content starts, and so where the bar starts too. */
  #board-body { flex: 1; min-height: 0; display: flex; flex-direction: column;
                position: relative; --body-pad: 4px; }
  #board-head > [hidden], #board-body > [hidden] { display: none; }
  /* On the scrollers, not #board-body: the bottom hub's clearance has to be
     scrolled past. The head's 44px already leaves ~9px under its pills; 4px
     more halves the gap the full 16px left between filter row and content. */
  #board-body > :not(#alert) { padding-block: var(--body-pad) 16px; }
  #cards { flex: 1; overflow-y: auto; padding-inline: var(--board-gutter); min-width: 0; }
  /* One pixel painted, eleven felt. The hit band outranks the later,
     positioned #thread, but stays under the workflow drawer (8) and ask layer
     (31). Keeping the band outside layout lets content meet the border.
     Its board half takes the last 5px of clipped tickets and any scrollbar
     at that edge; presses there resize rather than open a ticket or scroll. */
  #divider { width: 1px; flex: none; cursor: col-resize; position: relative; z-index: 4;
             background: color-mix(in srgb, var(--av-border), var(--av-fg) 15%); }
  #divider::before { content: ''; position: absolute; inset: 0 -5px; }
  #divider:hover, #divider.dragging { background: var(--av-focus); }
  /* The drag writes a pixel width; max-width also clamps it after a window
     resize. Keep z-index auto: a stacking context here would trap the drawer
     under the board's overlays. Paint containment would clip its outward box. */
  #dock { flex: none; max-width: 50%; display: flex; flex-direction: column; min-width: 0;
          position: relative; background: var(--av-lift); }
  :root { view-transition-name: none; }

  /* A repo section: its heading, its servers line and its grid as one node.
     Structural and never painted — no box, no border, no padding of its own, so
     what separates two groups on screen is still the space above the heading.
     That space is the section's now rather than the heading's, which is the
     whole visible consequence of the wrapper. */
  .repo { margin-top: 22px; }
  .repo:first-child { margin-top: 0; }
  h2 { font-size: var(--av-fs-lg); text-transform: uppercase; letter-spacing: .08em;
       color: var(--av-fg-2);
       margin: 0 0 10px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
  h2 .app { text-transform: none; letter-spacing: 0; font-weight: 400;
            color: var(--av-fg-3); }
  /* 290px wide where there is room, and never wider than half the board minus
     the gap — so the grid keeps two columns however narrow the board gets, and a
     card's title wraps to the ellipsis sooner instead of the row dropping to
     one. The percentage is of the grid, which is why the gap comes out of it. */
  .grid { display: grid; gap: 10px;
          grid-template-columns: repeat(auto-fill, minmax(min(290px, 50% - 5px), 1fr)); }
`;
