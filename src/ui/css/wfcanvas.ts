/**
 * The session-lane canvas — workflow v2's authoring surface, UI only.
 *
 * **Every rule is scoped under `#wfcanvas` and every class is `wc`-prefixed.**
 * The sheet is one global cascade joined in `ui/document.ts` and a later bare
 * rule wins, so nothing here may land bare: `.phead` is live at
 * `ui/css/composer.ts` (the permission dialog's head) and `.g` is live in
 * `board_card.ts`, `chat.ts` and `question.ts`. The mock's names were both.
 * Three classes the canvas draws are not `wc`: the grip's `.wegrip` and
 * Remove's `.werm`, which kept the editor's names its tests select by, and the
 * chip's `.fwrap`, which is `kit.ts`'s and styled in `css/tickets.ts`.
 *
 * Colours and sizes are the panel's own tokens, taken from
 * `docs/mockups/workflow-v2-directions.css` — which was authored in the panel's
 * vocabulary precisely so a direction that wins moves here without a colour or
 * a size being renegotiated.
 */

export const css = /* css */ `
  /* Hidden until the editor is open. Inside the editor the body is already
     the scroller and already has the padding, so height:100% would nest a
     second scroll around a column that is only as tall as its nodes. */
  #wfcanvas {
    display: none; position: relative; box-sizing: border-box;
    height: 100%; overflow: auto; color: var(--av-fg);
    padding: 14px 16px 20px;
  }
  #board.editing #wfcanvas {
    display: block; height: auto; overflow: visible; padding: 0;
  }

  /* The scroller, and the answer to the one objection that killed session
     columns: four lanes is 1254px against the board's 720 and nothing is
     dropped to make them fit. Scrolling is the cost being accepted, not a cost
     being hidden. */
  #wfcanvas .wcscroll {
    overflow-x: auto; overflow-y: hidden;
    /* The wires SVG is absolutely positioned against .wcpipe, so the scroller
       has to be the thing that clips — a scrollbar on .wcpipe sits under it. */
    padding-bottom: 2px;
  }
  #wfcanvas .wcscroll::-webkit-scrollbar { height: 8px; }
  #wfcanvas .wcscroll::-webkit-scrollbar-thumb {
    border-radius: 4px;
    background: color-mix(in srgb, var(--av-fg-3) 30%, transparent);
  }

  #wfcanvas .wcpipe {
    position: relative;
    /* A lane is legible below about 190px and stops being a node below about
       170px, so the track is the floor and the strip overflows rather than the
       node getting narrower. Measured at the dock, where it matters. 382 is
       the user's call on the canvas, 2026-09-30: 196, half again, then 30%. */
    --wc-lane-w: 382px;
    --wc-lane-gap: 26px;
    min-width: calc(var(--wc-cols) * var(--wc-lane-w)
                    + (var(--wc-cols) - 1) * var(--wc-lane-gap));
    /* Right padding is the graph channel, reserved rather than borrowed: a long
       edge runs down it, and at dock width a node fills its lane, so without
       the reservation that edge passes through every node between its ends.
       Left keeps a divider, which sits in the gap, from being clipped by
       .wcscroll. */
    padding: 0 22px 8px 10px;
  }

  /* The lattice is a real state, not a texture: it is what makes a derived
     position legible as derived, so it is drawn on the 16px rhythm the rest of
     the panel is spaced on. */
  #wfcanvas .wclattice {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right,
        color-mix(in srgb, var(--av-fg) 4%, transparent) 1px, transparent 1px),
      linear-gradient(to bottom,
        color-mix(in srgb, var(--av-fg) 4%, transparent) 1px, transparent 1px);
    background-size: 16px 16px;
    -webkit-mask-image: radial-gradient(115% 105% at 50% 45%, #000 62%, transparent 100%);
    mask-image: radial-gradient(115% 105% at 50% 45%, #000 62%, transparent 100%);
  }

  /* No z-index: one here made the grid a layer over svg.wcwires, and its empty
     box took every click aimed at a wire. Without it the wires stack over the
     empty cells, and what the grid draws stacks over the wires (below). */
  #wfcanvas .wcgrid {
    position: relative; display: grid;
    grid-template-columns: repeat(var(--wc-cols), var(--wc-lane-w));
    grid-auto-rows: min-content;
    column-gap: var(--wc-lane-gap);
    /* 34px between rows and not 16: the elbow sits midway down the gap, so the
       gap is the whole budget an edge has to change columns in. Under about
       30px the two 7px corners meet and the rail reads as a diagonal. */
    row-gap: 34px;
    align-items: start;
  }

  /* One hairline in the middle of each gap, full height. --wc-after is the
     1-based gap. Lane 382 plus gap 26 is 408, and half the gap is 13. */
  #wfcanvas .wcdiv {
    position: absolute; top: 0; bottom: 0; width: 1px; z-index: 0;
    background: var(--av-border);
    left: calc(10px + var(--wc-after) * (var(--wc-lane-w) + var(--wc-lane-gap)) - var(--wc-lane-gap) / 2);
  }

  /* Every lane named on row 1, whatever depth its first step sits at.
     14px on top is #wfcanvas's own top padding. The editor zeroes that
     padding — .webody already pads — and the head then sits on .wcscroll's
     clip. */
  #wfcanvas .wchd {
    grid-row: 1; align-self: end; min-width: 0; padding: 14px 2px 7px;
    border-bottom: 2px solid var(--av-border);
    display: flex; align-items: baseline; gap: 6px;
  }
  #wfcanvas .wchd b, #wfcanvas .wchd button.name {
    font-size: 13px; font-weight: 600; color: var(--av-fg); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; padding: 1px 3px; margin: 0 -3px;
    border-radius: 4px; border: 0; background: none; font-family: inherit;
    text-align: left; cursor: pointer;
  }
  /* The target is 24px. The negative margin keeps it out of the header's layout. */
  #wfcanvas .wchd button.name {
    box-sizing: border-box; min-width: 24px; min-height: 24px;
    padding-block: 4px; margin-block: -3px;
  }
  #wfcanvas .wchd span { font-size: 10px; color: var(--av-fg-3); white-space: nowrap; }
  #wfcanvas .wchd.armed { border-bottom-color: color-mix(in srgb, var(--av-focus) 70%, var(--av-border)); }
  #wfcanvas .wchd.armed b { color: color-mix(in srgb, var(--av-focus) 35%, var(--av-fg)); }
  #wfcanvas .wchd input.name {
    font-size: 13px; font-weight: 600; min-width: 110px; border-radius: 4px;
    border: 0; background: var(--av-input-bg); color: var(--av-fg);
    outline: 1px solid var(--av-focus); font-family: inherit; padding: 1px 3px;
  }

  /* Over svg.wcwires, so a hit band reaching onto a card never takes its port. */
  #wfcanvas .wcnode, #wfcanvas .wchd, #wfcanvas .wcghost, #wfcanvas .wcaddstep {
    position: relative; z-index: 2;
  }
  /* A step-sized tile where a new session's first step would sit. */
  #wfcanvas .wcghost {
    min-height: 108px; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center;
    border: 1px dashed var(--av-border); border-radius: 8px;
  }
  /* An empty row of a column: nothing until a carried card is over it. */
  #wfcanvas .wccell {
    min-height: 108px; box-sizing: border-box;
    border: 1px dashed transparent; border-radius: 8px;
  }
  #wfcanvas .wccell.target { border-color: var(--av-focus); }
  #wfcanvas .wcaddstep.target { outline: 1px dashed var(--av-focus); outline-offset: 2px; }
  #wfcanvas .wcadd {
    display: inline-flex; align-items: center; gap: 5px; min-height: 26px;
    padding: 2px 10px; border-radius: 6px; border: 1px dashed var(--av-input-border);
    background: transparent; color: var(--av-fg-2); font-size: 12px; white-space: nowrap;
    cursor: pointer;
  }
  #wfcanvas .wcadd:hover { color: var(--av-fg); border-color: var(--av-focus); }

  /* A column's Add step: its own cell on the row after the lane's last step,
     so a card that grows pushes it down. Quiet until pointed at, like a task board's
     "+ New task" — the dashed cap is what says a step does not exist yet. */
  #wfcanvas .wcaddstep {
    align-self: start; display: flex; align-items: center; gap: 8px;
    width: 100%; min-height: 28px; box-sizing: border-box; padding: 0 11px;
    border: 1px dashed transparent; border-radius: 6px; background: transparent;
    font: inherit; font-size: var(--av-fs-sm); color: var(--av-fg-2); cursor: pointer;
  }
  #wfcanvas .wcaddstep .cap {
    width: 18px; height: 18px; border-radius: 50%; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; line-height: 1;
    border: 1.5px dashed color-mix(in srgb, var(--av-focus) 48%, var(--av-fg-3));
    color: color-mix(in srgb, var(--av-focus) 70%, var(--av-fg-3));
  }
  #wfcanvas .wcaddstep b { font-weight: 600; white-space: nowrap; }
  #wfcanvas .wcaddstep:hover {
    color: var(--av-fg);
    border-color: color-mix(in srgb, var(--av-focus) 40%, var(--av-border));
  }
  #wfcanvas .wcaddstep:focus-visible { outline: 1px solid var(--av-focus); outline-offset: 2px; }
  #wfcanvas .wcaddstep:disabled { opacity: .4; cursor: default; }

  #wfcanvas .wcport {
    position: absolute; left: 50%; bottom: -12px; width: 24px; height: 24px; margin-left: -12px;
    display: flex; align-items: center; justify-content: center; z-index: 3;
  }
  #wfcanvas .wcport i {
    width: 9px; height: 9px; border-radius: 50%; background: var(--av-card);
    border: 1.5px solid var(--av-focus);
  }
  #wfcanvas .wcnode.target {
    border-color: var(--av-focus);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--av-focus) 45%, transparent);
  }
  /* Not .tip: that one is dismissed on pointerdown, and a drag is one.
     Anchored on #wfcanvas: a class root loses to #wfeditor. */
  #wfcanvas .wctip { position: fixed; z-index: 60; pointer-events: none;
    max-width: 280px; padding: 5px 9px; border-radius: 6px;
    font-size: var(--av-fs-md); line-height: 1.45;
    border: 1px solid var(--av-menu-border);
    background: var(--av-menu-bg); color: var(--av-menu-fg);
    box-shadow: 0 6px 20px rgba(0, 0, 0, .35); }
  #wfcanvas .wcnode.refuse { opacity: .38; }
  #wfcanvas .wcnode.refuse::after {
    content: "would loop"; position: absolute; right: 8px; bottom: 6px;
    font-size: 10px; color: var(--av-red); font-style: italic;
  }
  /* Not on a loop: the drag adds skip only when the step is not upstream.
     Same red. The card is already at 38% opacity, so the muted grey does not read. */
  #wfcanvas .wcnode.refuse.skip::after {
    content: "skips " attr(data-skips);
    color: var(--av-red);
  }
  #wfcanvas .wcnode.refuse.starts::after { content: "starts the run"; }
  #wfcanvas .wirex {
    position: absolute; z-index: 5; width: 24px; height: 24px; margin: -12px 0 0 -12px;
    border-radius: 50%; background: var(--av-card); border: 1px solid var(--av-focus);
    color: var(--av-fg); display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 8px var(--av-shadow-2); cursor: pointer;
  }
  #wfcanvas .wirex:hover { color: var(--av-red); }

  #wfcanvas .wcwhy {
    flex: 1 0 100%; font-size: 11px; line-height: 1.4; color: var(--av-fg-2);
    border-left: 2px solid var(--av-warn-border); padding: 2px 0 2px 8px;
  }
  #wfcanvas .wcfoot {
    display: flex; gap: 6px; margin-top: 10px; align-items: center;
    justify-content: flex-end;
  }

  /* ── the node ─────────────────────────────────────────────────────── */
  #wfcanvas .wcnode {
    position: relative;
    /* The lane is the thing with a width here, so the node fills its track. */
    width: auto;
    border-radius: 8px;
    padding: 9px 11px 10px;
    box-sizing: border-box;
    background: var(--av-card);
    border: 1px solid var(--av-border);
    box-shadow: 0 1px 2px var(--av-shadow-1);
    cursor: pointer;
    /* A flex/grid item's automatic minimum is its min-content, and one nowrap
       clamp inside it is enough to make that wider than the lane it sits in —
       the node then overflows its own track rather than the clamp ellipsing. */
    min-width: 0;
  }
  /* A session's step with no wire into it cannot start: dashed, like the tile. */
  #wfcanvas .wcnode.waiting { border-style: dashed; }
  #wfcanvas .wcwait { font-size: 11px; color: var(--av-fg-3); margin-top: 4px; }
  /* Twice the closed face's old height, and the prompt fills it (.wcdesc). */
  #wfcanvas .wcnode:not(.editing) { min-height: 108px; }
  #wfcanvas .wcnode:hover {
    border-color: color-mix(in srgb, var(--av-focus) 40%, var(--av-border));
    box-shadow: 0 2px 6px var(--av-shadow-2);
  }
  #wfcanvas .wcnode.editing {
    cursor: default;
    border-color: color-mix(in srgb, var(--av-focus) 55%, var(--av-border));
    box-shadow: 0 4px 14px var(--av-shadow-2);
  }
  /* The left padding is the grip's: it is absolute so it takes no grid
     cell, and the head indents so the badge clears it. */
  #wfcanvas .wchead {
    display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px;
    padding-left: 16px;
  }
  /* Classed rather than a child-of-.wchead span selector, which also matches
     the glyph — the glyph is a span and a direct child, so the looser rule gave
     it the title's line-height and 3px of padding and pushed it off the row. */
  #wfcanvas .wcname {
    font-size: var(--av-fs-md); font-weight: 600; color: var(--av-fg);
    line-height: 1.3; padding-top: 3px; min-width: 0;
  }
  #wfcanvas .wcname.empty { font-weight: 400; font-style: italic; color: var(--av-fg-3); }
  #wfcanvas .wcdesc {
    font-size: var(--av-fs-md); line-height: 1.4; color: var(--av-fg-3);
    /* Four lines: the height a closed tile has room for at 108px, so a lane
       reads without opening its cards. */
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Open, in place. The name is a real input; the prompt is the prose editor
     (webview/prose.ts) every box that takes prose shares, which draws a named
     skill, model or session as a chip. */
  #wfcanvas .wctitle, #wfcanvas .wcbody {
    width: 100%; box-sizing: border-box;
    background: var(--av-input-bg); color: var(--av-input-fg);
    border: 1px solid var(--av-input-border); border-radius: 5px;
    font-family: inherit; padding: 4px 6px;
  }
  #wfcanvas .wctitle {
    font-size: var(--av-fs-md); font-weight: 600; min-width: 0;
  }
  /* The padding is the editing root's and not the host's, so a press anywhere
     in the field lands in the text, as in the dialog boxes. */
  #wfcanvas .wcbody {
    font-size: var(--av-fs-md); line-height: 1.4;
    margin-top: 2px; padding: 0;
  }
  /* The prompt is prose the author wrote for a session to read, which is what
     #input in the composer already is: the UI face, grown to its content and
     bounded in line-heights. Mono in this panel means a machine wrote it — a
     tool's output, a path, a key — and a step prompt is none of those. Five
     lines empty: at two, an open step read as a one-line field for a prompt
     that is usually a paragraph (the user's call, 2026-10-01). */
  #wfcanvas .wcbody .ProseMirror {
    padding: 4px 6px; min-height: 5lh; max-height: 14lh; overflow-y: auto;
  }
  #wfcanvas .wctitle:focus, #wfcanvas .wcbody:focus-within {
    outline: 1px solid var(--av-focus); outline-offset: -1px;
  }
  #wfcanvas .wcdone {
    margin-top: 8px; padding: 3px 10px; border-radius: 5px;
    border: 1px solid var(--av-border); background: var(--av-btn-bg);
    color: var(--av-btn-fg); font: inherit; font-size: var(--av-fs-md); cursor: pointer;
    min-height: 24px; box-sizing: border-box;
  }
  /* Beside Done, in the open step's foot. Same box as .wcdone so the pair
     shares a baseline; outline, the way Delete sits beside Save. */
  #wfcanvas .wcfoot .werm {
    flex: none;
    margin-top: 8px; padding: 3px 10px;
    border-radius: 5px;
    border: 1px solid color-mix(in srgb, var(--av-red, var(--vscode-charts-red)) 45%, var(--av-border));
    background: transparent;
    color: var(--av-red, var(--vscode-charts-red));
    font: inherit; font-size: var(--av-fs-md); line-height: normal;
    cursor: pointer;
    min-height: 24px; box-sizing: border-box;
  }
  #wfcanvas .wcfoot .werm:hover:not(:disabled) {
    background: color-mix(in srgb, var(--av-red, var(--vscode-charts-red)) 12%, transparent);
  }
  #wfcanvas .wcfoot .werm:disabled { cursor: default; opacity: 0.5; }

  /* The reorder grip (R1), left of the badge. Three bars read as a handle at
     14px. Quiet until the node is hovered or has focus, so a form full of
     text stays a form. */
  #wfcanvas .wegrip {
    position: absolute;
    left: 6px; top: 10px; z-index: 2;
    width: 14px; height: 18px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 2px;
    color: var(--av-fg-3); opacity: 0;
    cursor: grab;
    transition: opacity 120ms ease, color 120ms ease;
  }
  /* The bars are 14x18; what a pointer gets is 24x24 (WCAG 2.2 SC 2.5.8).
     An overlay rather than a bigger box, so the node does not move. */
  #wfcanvas .wegrip::before {
    content: "";
    position: absolute;
    left: -5px; right: -5px; top: -3px; bottom: -3px;
  }
  #wfcanvas .wegrip i {
    display: block; width: 10px; height: 1.5px;
    background: currentColor; border-radius: 1px;
  }
  /* Descendant selectors, all three, so they tie on specificity and source
     order decides: hovering the node raises the grip, hovering the grip itself
     raises it further, and a locked form shows none of it. Written flat the
     node rule outranks the other two and wins both. */
  #wfcanvas .wcnode:hover .wegrip,
  #wfcanvas .wcnode:focus-within .wegrip { opacity: 0.55; }
  #wfcanvas .wcnode .wegrip:hover { opacity: 1; color: var(--av-fg-2); }
  #wfcanvas .wcnode .wegrip:active { cursor: grabbing; }
  /* Invisible is not enough: the 24x24 overlay still takes a hover, and tip.ts
     is delegated on [data-tip] with no idea the form is locked — so a saving
     form would explain a gesture it refuses. */
  #wfcanvas .wcnode .wegrip[draggable="false"] {
    opacity: 0; cursor: default; pointer-events: none;
  }

  /* The node being carried stays in place and dims — the lit row says where
     it goes. One rule, because the badge is inside the node it dims with. */
  #wfcanvas .wcnode.lifted { opacity: 0.45; }
  /* Nothing under the pointer may swallow a drop aimed at the list — which is
     the fields, and only them.

     The grip is the drag's own source. Taking the pointer off it the instant
     dragging-step is set wedges Chromium: the drag starts and then no dragover,
     no drop and no dragend ever arrives, so a grip can be pressed and never
     released. It is invisible to jsdom, which has no hit testing to lose — the
     smoke case is what holds it. */
  body.dragging-step #wfcanvas .wcnode input,
  body.dragging-step #wfcanvas .wcnode .wcbody { pointer-events: none; }
  /* A wire's hit band stacks over .wcgrid's gaps, and the reorder's dragover
     and drop are bound on .wcgrid: taken by the band, they never arrive. */
  body.dragging-step #wfcanvas .wcwires path.wchit { pointer-events: none; }

  /* The model chip, on the node that opens a lane and on no other. The armed
     session's lane never draws one: the workflow was armed in a session that
     already has a model, so there is nothing there to choose. */
  #wfcanvas .wcmodel { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 5px; }
  #wfcanvas .wcchip {
    display: inline-flex; align-items: center; gap: 5px;
    /* 24px floor, not the chip's natural ~21px: WCAG 2.2 SC 2.5.8 is in scope
       (PRD §6), and the node's own click-to-open is the other target on this
       box — so the chip has to clear it on size as well as on stopPropagation.
       Both axes: a one-word effort is shorter than it is tall. */
    min-width: 24px; min-height: 24px;
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid var(--av-border);
    background: var(--av-bg);
    font: var(--av-fs-sm) / 1.5 var(--vscode-editor-font-family);
    color: var(--av-fg-3);
    white-space: nowrap; cursor: pointer;
  }
  #wfcanvas .wcchip:hover {
    border-color: color-mix(in srgb, var(--av-focus) 45%, var(--av-border));
  }
  /* Nothing stated in the file, so the chip is dashed: a solid one would
     claim the file holds the value. An unstated model says to pick one; an
     unstated effort shows the model's own default. */
  #wfcanvas .wcchip.inherit { border-style: dashed; font-style: italic; }
  /* The effort is the CLI's own word, so it takes the editor face. No mark. */
  #wfcanvas .wcchip.effort { font-family: var(--vscode-editor-font-family); }

  /* ── the glyph ────────────────────────────────────────────────────────
     One disc. --wc-st is the state colour and stays the focus mix while
     authoring, which is what makes an unrun graph monochrome. */
  #wfcanvas .wcg {
    --wc-st: var(--av-focus);
    position: relative; flex: none;
    width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
  }
  #wfcanvas .wcg i {
    position: absolute; inset: 0; border-radius: 50%;
    background: color-mix(in srgb, var(--wc-st) 10%, var(--av-card));
    border: 1px solid color-mix(in srgb, var(--wc-st) 42%, var(--av-border));
  }
  #wfcanvas .wcg b {
    position: relative; z-index: 1;
    font-size: 11px; font-weight: 700; line-height: 1;
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--wc-st) 70%, var(--av-fg));
  }

  /* ── the wires ────────────────────────────────────────────────────────
     Orthogonal rails and no beziers: an edge whose corners are right angles can
     be routed from two measured rectangles with no layout engine, which is the
     whole reason no coordinate is ever authored. Drawn by ui/wfroute.ts from
     real DOM rects, so a rule that changes a node's size moves its wires. */
  #wfcanvas .wcwires {
    position: absolute; inset: 0; overflow: visible; pointer-events: none;
  }
  #wfcanvas .wcwires path {
    fill: none; stroke-width: 1.5;
    stroke: color-mix(in srgb, var(--av-focus) 34%, var(--av-border));
    stroke-linecap: round; stroke-linejoin: round;
  }
  /* Selected, or under the pointer. The hit band is drawn right after the
     stroke it covers, so a hover on it lights that one. */
  #wfcanvas .wcwires path.sel,
  #wfcanvas .wcwires path:has(+ path.wchit:hover) { stroke: var(--av-focus); stroke-width: 2.5; }
  #wfcanvas .wcwires path.wchit {
    pointer-events: stroke; stroke: transparent; cursor: pointer;
  }
  #wfcanvas .wcwires path.wcarrowhead {
    fill: color-mix(in srgb, var(--av-focus) 34%, var(--av-border)); stroke: none;
  }
  #wfcanvas .wcwires path.wcrubber { stroke: var(--av-focus); stroke-dasharray: 4 3; }
`;
