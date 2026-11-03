/**
 * Workflow rows, the new-workflow tile, the detail column's steps, and the flight.
 *
 * Pasted from `docs/mockups/workflow-sheet.html` §8, with one correction the
 * mock carries: `.wsrow.flying` is 34 there, which would paint a row in flight
 * over `#ask` (31) and `#picker` (33) — the opposite of what S6 promises. It is
 * 22 here, and the flying row is appended inside `#bottomdrawer` rather than beside
 * it.
 */

export const css = /* css */ `
  /* Authoring, in the list's own geometry — the vocabulary the editor's
     \`+ Add step\` already speaks. Sticky to the column's bottom edge, so a list
     long enough to scroll never scrolls this out of reach, which is the one
     thing an in-list add gets wrong everywhere else. Opaque, because rows pass
     under it. */
  #bottomdrawer-body .wsnew { position: sticky; bottom: 0; z-index: 1; display: flex; align-items: center;
                   gap: 9px; width: 100%; box-sizing: border-box; margin-top: 2px;
                   padding: 7px 8px; border-radius: 6px; font: inherit;
                   font-size: var(--av-fs-md); text-align: left; cursor: pointer;
                   color: var(--av-fg-3); background: var(--av-menu-bg);
                   border: 1px dashed color-mix(in srgb, var(--av-menu-fg) 30%, var(--av-menu-bg)); }
  #bottomdrawer-body .wsnew .plus { flex: none; width: 14px; text-align: center; }
  /* \`--av-list-hover\` is a wash. The \`background\` shorthand would replace the
     fill with it, and the row stuck under this tile would read through. */
  #bottomdrawer-body .wsnew:hover { color: var(--av-fg); border-style: solid;
                         border-color: var(--av-focus);
                         background-image: linear-gradient(var(--av-list-hover), var(--av-list-hover)); }
  #bottomdrawer-body .wsnew:focus-visible { outline: 2px solid var(--av-focus); outline-offset: 1px; }
  .bddetail .dh { margin: 4px 0 6px; font-size: var(--av-fs-lg); font-weight: 500; display: flex;
                  align-items: baseline; gap: 8px; }
  .bddetail .dh span { color: var(--av-fg-3); font-size: var(--av-fs-md); }
  .bddetail .dnone { margin: 6px 0 0; color: var(--av-fg-3);
                     font-size: var(--av-fs-md); }
  /* The selected row. Same tint as hover, so the two never disagree about
     which row the detail column is about. */
  .wsrow.sel { background: var(--av-list-hover); }
  /* One row per workflow. A press selects it; a hold picks it up. The grip is
     the surface that never needs the hold — the family-head pattern the
     editor's step drag already uses, rather than grab-anywhere. */
  .wsrow { display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box;
           padding: 7px 8px; border-radius: 6px; border: 1px solid transparent;
           background: none; color: inherit; font: inherit; text-align: left;
           cursor: pointer; }
  .wsrow:hover, .wsrow:focus-visible { background: var(--av-list-hover); outline: none; }
  .wsrow:focus-visible { border-color: var(--av-focus); }
  /* \`touch-action: none\` on the grip alone, never on the row: the row's own
     vertical pan is how a touch scrolls this list, and taking it would trade a
     scroll for a drag. The grip is the one surface where a pan is always a
     lift. */
  .wsrow .wsgrip { flex: none; width: 14px; height: 18px; position: relative;
                   display: flex; flex-direction: column; justify-content: center; gap: 3px;
                   opacity: 0; cursor: grab; touch-action: none; }
  .wsrow:hover .wsgrip, .wsrow:focus-within .wsgrip { opacity: .55; }
  .wsrow .wsgrip:hover { opacity: 1; }
  .wsrow .wsgrip i { display: block; height: 1.5px; width: 10px; border-radius: 1px;
                     background: currentColor; }
  /* 24x24 to a pointer without the row paying for it — the overlay .wegrip
     takes in the workflow editor (WCAG 2.2 SC 2.5.8). */
  .wsrow .wsgrip::before { content: ''; position: absolute; inset: -3px -5px; }
  .wsrow .nm { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; font-size: var(--av-fs-md); }
  .wsrow .meta { flex: none; color: var(--av-fg-3); font-size: var(--av-fs-md);
                 font-variant-numeric: tabular-nums; }
  .wsrow .sp { flex: 1 1 auto; }
  .wsrow .act { flex: none; min-width: 24px; min-height: 24px; display: inline-flex;
                align-items: center; justify-content: center; border: 0; background: none;
                color: var(--av-fg-3); cursor: pointer; border-radius: 5px;
                font-size: var(--av-fs-md); opacity: 0; }
  .wsrow:hover .act, .wsrow:focus-within .act { opacity: 1; }
  .wsrow .act:hover { color: var(--av-fg); background: var(--av-list-hover); }
  .wsrow .act.del:hover { color: var(--av-warn-border); }
  /* The delete confirm, asked on the row it is about and in place of that row's
     three controls. Its buttons carry .act so the hover-reveal selector above
     does not have to know about them — and then unset the opacity, because a
     question that only appears under the pointer is not one. */
  .wsrow.confirming { cursor: default; background: var(--av-list-hover); }
  .wsrow.confirming .ask { flex: none; color: var(--av-warn-border);
                           font-size: var(--av-fs-md); }
  /* The border is restated because .wsrow .act zeroes it and outranks .fbtn —
     a two-class selector is what puts the edge back on. */
  .wsrow .act.fbtn { opacity: 1; min-width: 0; font-size: var(--av-fs-md);
                     color: inherit; padding: 3px 10px;
                     border: 1px solid
                       color-mix(in srgb, var(--av-menu-fg) 55%, var(--av-menu-bg)); }
  .wsrow .act.fbtn.danger { color: var(--av-warn-border);
                            border-color: var(--av-warn-border); }
  /* The row under a pending confirm already wears the hover tint, so the plain
     .act:hover rule would give the buttons no feedback at all. */
  .wsrow .act.fbtn:hover { background:
                             color-mix(in srgb, var(--av-menu-fg) 12%, var(--av-menu-bg)); }

  /* The flight. Copies the board's own vocabulary rather than its code:
     .lifted on the source, one absolute drop line moved on pointermove, a body
     class while it runs. 22 and not the mock's 34 — a row in flight must stay
     under the ask layer like the sheet it came out of (S6). */
  .wsrow.lifted { opacity: var(--av-ghost); }
  .wsrow.flying { position: fixed; z-index: 22; pointer-events: none;
                  background: var(--av-menu-bg); border-color: var(--av-focus);
                  box-shadow: 0 8px 24px rgba(0, 0, 0, .45); }
  .wsins { position: absolute; left: 10px; right: 10px; height: 2px; border-radius: 2px;
           background: var(--av-focus); opacity: 0; pointer-events: none; }
  .wsins.on { opacity: 1; }
  /* A flight outlives the pointer leaving the row it started on, so the cursor
     and the selection guard are stated on the body for as long as it runs. */
  body.dragging-wf { cursor: grabbing; user-select: none; }
  body.dragging-wf .wsrow, body.dragging-wf .wsrow .wsgrip { cursor: grabbing; }
  /* Every control on every row, while something is in the air: a flight ends on
     a release, and a release over a control must not also press it. */
  body.dragging-wf .wsrow .act, body.dragging-wf .wsnew { pointer-events: none; }

  /* The steps, the composer chip's own list, in the detail column. Its own
     rules rather than the chip's: .wsteps in css/composer.ts is scoped to
     #wattach, and widening that selector would restyle the chip from here. */
  .bddetail .wssteps { margin: 0; padding: 0 0 0 20px;
                       color: var(--av-fg-3); font-size: var(--av-fs-md); }
  .wssteps .wstep { line-height: 1.5; }
`;
