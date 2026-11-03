/** Observational workflow overview drawer — placement E, outward over the board. */

export const css = /* css */ `
  /* Run observe drawer (surfaces Phase C). Lives in the dock DOM and paints
     one column left of the thread: absolute inside #threadwrap with
     right: 100%, so top/bottom track the thread (composer stays free) and the
     right edge abuts the divider without measuring. Width is the mock 470px
     clamped to 45vw (viewport — not panel/dock width) so a narrow window
     still leaves board. z-index 8: above board cards, below ask/permission
     layers on #board (#scrim 30+, #ask 31). Opaque — clicks do not pass
     through to cards. */
  #workflowoverviewdrawer { position: absolute; top: 0; bottom: 0; right: 100%;
               width: min(470px, 45vw); z-index: 8;
               display: flex; flex-direction: column; overflow: hidden;
               background: var(--av-menu-bg); color: var(--av-menu-fg);
               border: 1px solid var(--av-menu-border); border-right: none;
               border-radius: 8px 0 0 8px;
               box-shadow: -10px 0 30px rgba(0, 0, 0, .5); }
  #workflowoverviewdrawer[hidden] { display: none; }
  /* The ticket sheet alone leaves the dock live, so the rail can be opened while
     it is up, and the rail outranks it then. Only for that long: a standing rank
     over 32 would paint over #ask, and showAsk closes this sheet first. */
  #board:has(> #ticket-detail:not([hidden])) ~ #dock #workflowoverviewdrawer { z-index: 33; }
  @media (prefers-reduced-motion: no-preference) {
    /* Slides both ways (taskhub H37). The hidden attribute is the open flag
       every other rule here reads, and the webview sets it the instant the
       reader presses — so a shut had nothing left on screen to animate: an
       entry keyframe and a cut. A transition instead, with display in it:
       allow-discrete holds the box at flex for the 160ms and drops it to none
       on the last frame, so the exit is the entry reversed and no script waits
       for it. The starting-style block is the entry's first frame — a node
       arriving from display: none has no previous value to interpolate from. */
    #workflowoverviewdrawer { transition: opacity 160ms cubic-bezier(.2,.7,.25,1),
                             transform 160ms cubic-bezier(.2,.7,.25,1),
                             display 160ms allow-discrete; }
    #workflowoverviewdrawer[hidden] { opacity: 0; transform: translateX(8px); }
    @starting-style {
      #workflowoverviewdrawer:not([hidden]) { opacity: 0; transform: translateX(8px); }
    }
  }

  .rdhead { flex: none; display: flex; align-items: center; gap: 8px;
            padding: 9px 12px; border-bottom: 1px solid var(--av-border);
            font-size: var(--av-fs-md); }
  /* Geometry is shared .dot (board.ts); only colour is scoped here. */
  .rdhead .dot { background: var(--st, var(--av-border)); }
  .rdhead.running { --st: var(--av-blue); }
  .rdhead.done { --st: var(--av-green); }
  .rdhead.failed { --st: var(--av-red); }
  .rdhead .lbl { font-weight: 600; font-size: var(--av-fs-lg); min-width: 0;
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rdhead .x { margin-left: auto; font-family: inherit; font-size: var(--av-fs-md);
               padding: 3px 8px; border-radius: 5px; cursor: pointer; background: none;
               border: 1px solid transparent; color: var(--av-fg-3); flex: none; }
  .rdhead .x:hover { color: var(--av-fg-2); border-color: var(--av-border); }

  .rdsteps { list-style: none; margin: 0; overflow-y: auto; padding: 6px 0;
             flex: 1; min-height: 0; }

  /* Gutter for the marker so every label lines up. */
  .strow { display: grid; grid-template-columns: 22px 1fr; gap: 0 8px;
           padding: 8px 12px 8px 10px; border-left: 3px solid transparent; }
  .strow + .strow { border-top: 1px solid var(--av-border); }
  .strow > :not(.smark) { grid-column: 2; }
  .strow.now { border-left-color: var(--av-blue);
               background: color-mix(in srgb, var(--av-blue) 8%, transparent); }
  .smark { grid-row: 1 / -1; grid-column: 1; justify-self: center; margin-top: 2px;
           width: 13px; height: 13px; box-sizing: border-box; border-radius: 50%;
           border: 1px solid var(--av-fg-3); font-size: 9px; line-height: 11px;
           text-align: center; color: var(--av-fg-3); }
  .strow.done .smark { border-color: var(--av-green); background: var(--av-green);
                       color: var(--av-bg); }
  .strow.now .smark { border-color: var(--av-blue); box-shadow: 0 0 0 2px
                      color-mix(in srgb, var(--av-blue) 28%, transparent); }
  .strow.failed .smark { border-color: var(--av-red); color: var(--av-red);
                         font-weight: 700; }
  .strow.todo .smark, .strow.unknown .smark { border-style: dashed; }
  .sline { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .slabel { font-size: var(--av-fs-lg); font-weight: 600; min-width: 0;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strow.todo .slabel, .strow.unknown .slabel { font-weight: 400; color: var(--av-fg-2); }
  .sstate { flex: none; font-size: var(--av-fs-sm); text-transform: uppercase;
            letter-spacing: .06em; color: var(--av-fg-3); }
  .strow.done .sstate { color: var(--av-green); }
  .strow.now .sstate { color: var(--av-blue); }
  .strow.failed .sstate { color: var(--av-red); font-weight: 600; }
  /* No line-clamp: it removes the overflow that scroll retention needs, and
     session.smoke.ts parks a reader mid-rail on a tall note to prove it.
     NOTE_MAX bounds the CLI path instead. */
  .snote { margin-top: 4px; font-size: var(--av-fs-md); color: var(--av-fg-2);
           white-space: pre-wrap; overflow-wrap: anywhere; }

  /* Live chip is the open control when FOLLOWING. */
  #wattach .wflow.live { cursor: pointer; }
  #wattach .wflow.live:hover { filter: brightness(1.06); }
  #wattach .wflow.live .caret { width: 0; height: 0; flex: none; opacity: .6;
                                border-left: 4px solid currentColor;
                                border-top: 3.5px solid transparent;
                                border-bottom: 3.5px solid transparent;
                                transform: rotate(180deg); }
  #wattach .wflow.live.open .caret { transform: none; }
`;
