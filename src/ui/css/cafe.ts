/** The café: a floating cup of coffee holding the machine awake. */

export const css = /* css */ `
  /* The cup floats over the board rather than sitting in a row. #board is
     already position: relative (see shell.ts), so this needs no new stacking
     context of its own.

     z-index 20 puts it over the board and over the bottom hub (12), and under
     #scrim (30), #ask (31) and #picker (33). A permission dialog must never be
     covered by the coffee — it is the one thing on this board a reader is
     actually blocked on.

     Bottom-left by default, and moved from there by a translate the script
     writes: the corner is the anchor, so a resized window keeps the cup near
     the same edge rather than near the same absolute point. */
  #cafe {
    position: absolute;
    left: 14px;
    bottom: 14px;
    width: 68px;
    height: 68px;
    z-index: 20;
    cursor: grab;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    /* Only the cup takes the pointer, not the box around it — a square hit
       target this size in the corner of the board would swallow clicks meant
       for whatever card is behind it. */
    pointer-events: none;
  }
  /* The pot hangs above and left of the cup, at negative coordinates in the
     same 128 grid, so the drawing has to be allowed out of its own box. The
     box itself stays 68x68 — the clamp measures the element, and a taller one
     would reinterpret every position a reader has already dragged the cup to. */
  #cafe svg { width: 100%; height: 100%; display: block; pointer-events: auto; overflow: visible; }
  /* Paint that hangs outside the box must not take the pointer with it. Without
     this, the pot swallows clicks on whatever card is behind where it hangs —
     which shows up only as "cards near the corner sometimes ignore me". */
  #cafe .kettle, #cafe .stream { pointer-events: none; }
  #cafe.dragging { cursor: grabbing; }
  /* Nothing transitions while a pointer is driving it: a smoothed drag lags the
     finger, which reads as the cup being heavy rather than as motion design. */
  #cafe.dragging .liquid { transition: none; }

  /* ── the fluid, lifted from docs/mockups/coffee-cup/cafe-tapered.html ──────
     --fill is the coffee left, 0..1. --top is the surface y at full and --range
     is how far it falls to empty; both are geometry of this drawing and belong
     with it rather than in the script. */
  #cafe .liquid {
    transform: translateY(calc((var(--top) + (1 - var(--fill, 0)) * var(--range)) * 1px));
    transition: transform .5s linear;
  }
  #cafe .drift { animation: cafe-drift 3.4s linear infinite; }
  #cafe .drift.slow { animation-duration: 5.6s; }
  @keyframes cafe-drift { to { transform: translateX(-34px); } }

  /* Steam is the top half of a lease — STEAMING in webview/cafe.ts. It goes
     out with five minutes to run, so the cup fading is the reader's warning
     rather than a second telling of the level they can already see. */
  #cafe .steam { opacity: 0; transition: opacity .5s; }
  #cafe.hot .steam { opacity: .72; }
  /* Gated on .hot, not on the opacity above it: an animation under an
     opacity: 0 parent goes on ticking, and this one is two SVG paths with a
     fill-box transform, which is a main-thread re-raster every frame for a
     wisp nobody can see. Half of every lease, plus all the time the panel is
     open over a machine holding nothing. */
  #cafe .steam path { transform-box: fill-box; transform-origin: bottom; }
  #cafe.hot .steam path { animation: cafe-rise 3.6s ease-in-out infinite; }
  #cafe.hot .steam path:nth-child(2) { animation-delay: 1.1s; }
  @keyframes cafe-rise {
    0%   { transform: translateY(3px) scaleY(.94); opacity: .25; }
    45%  { opacity: .9; }
    100% { transform: translateY(-5px) scaleY(1.06); opacity: 0; }
  }

  /* ── the pour ─────────────────────────────────────────────────────────────
     A refill has no duration on the wire: the keeper pours a fresh lease in one
     step, and the level jumps from nearly empty to full between two pushes. The
     pot is drawn for it anyway, because the jump is the one moment in a
     nine-minute cycle when the machine does something, and a level
     that moved while nobody was looking reports it to nobody. So the panel
     stretches the refill over five seconds and pours it: the pot leans in, the
     stream lands, the level climbs under it, and the pot goes.

     Everything about the pot's own motion is in webview/pot.ts, in a spring
     rather than in a transition — the shading and the stream both need the
     angle as a number. What is here is what a class can say. */
  #cafe .kettle, #cafe .stream { opacity: 0; transition: opacity .35s; }
  #cafe.pouring .kettle, #cafe.pouring .stream { opacity: 1; }
  /* The level climbs over the pour rather than before it, so the coffee is
     still rising while it is being poured and settles just as the pot leaves. */
  #cafe.pouring .liquid { transition: transform 4.5s linear; }
  #cafe.pouring .drift { animation-duration: 1.5s; }
  #cafe.pouring .drift.slow { animation-duration: 2.4s; }
  /* Rings where the stream lands, and only there — a surface that pulsed on its
     own would be a cup reporting nothing. */
  #cafe .rip { transform-box: fill-box; transform-origin: center; opacity: 0; }
  #cafe.pouring .rip { animation: cafe-rip 1s ease-out infinite; }
  #cafe.pouring .rip:nth-child(2) { animation-delay: .33s; }
  #cafe.pouring .rip:nth-child(3) { animation-delay: .66s; }
  @keyframes cafe-rip {
    0%   { transform: scale(.25); opacity: .8; }
    100% { transform: scale(1.9); opacity: 0; }
  }
  /* Gated for the same reason as .rip beside it, and it matters more: a
     stroke-dashoffset cannot be composited, so an ungated half-second cycle
     is style recalc and paint on the main thread for all nine and a half
     minutes the pot is not there. */
  #cafe.pouring .streaks { animation: cafe-streaks .5s linear infinite; }
  /* 22 pot units, which is what pot.ts scales its dash pattern by. */
  @keyframes cafe-streaks { to { stroke-dashoffset: -46; } }

  @media (prefers-reduced-motion: reduce) {
    /* Each selector matches the one that set the animation, class for class: a
       media query adds no specificity, so a bare #cafe .rip here loses to the
       #cafe.pouring .rip above it and the ripples keep going. */
    #cafe .drift, #cafe.hot .steam path, #cafe.pouring .rip,
    #cafe.pouring .streaks { animation: none; }
    #cafe .liquid, #cafe.pouring .liquid { transition: none; }
    /* No pot at all, and no JS branch on it: the class goes on either way and
       the stylesheet declines to draw it. The level still moves, which is the
       whole of what a refill has to say. */
    #cafe .kettle, #cafe .stream { display: none; }
  }
`;
