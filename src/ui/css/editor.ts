export const css = /* css */ `
  /* Board-mode workflow editor (compose / edit).
     Sequence is the schema: badge + rail make N → N+1 legible at a squint.
     Inputs share one pad/radius language; motion is opt-in and one-shot.
     Colorize B — Focus spine: quiet --av-focus track at rest; stronger on
     focus-within. Kinship with drawer .strow.now / busy blue. Save, Delete,
     and the warn strip keep their own roles. See
     docs/mockups/workflow-editor-colorize.html. */
  /* Shell does not scroll — .webody does, with native chrome killed and a
     neutral overlay thumb (D). Thumb is --av-fg wash, not --we-accent, so it
     never fights the sequence rail. See docs/mockups/workflow-editor-scroll.html. */
  /* Density C — document at rest, form on focus. A step used to draw three
     nested filled rectangles; a seven-step workflow was 21 of them before a word
     of the author's own content, and the focus wash had to out-shout its own
     rest state. Now nothing is boxed until the pointer or the caret arrives, and
     the rail and badge do the grouping they were drawn for. Padding never
     changes between those states, so only colour moves and nothing reflows.
     See docs/mockups/workflow-editor-density.html. */
  #wfeditor {
    display: none; flex-direction: column; position: relative;
    box-sizing: border-box; height: 100%; overflow: hidden; color: var(--av-fg);
    /* Sequence chrome only — not a new brand token. */
    --we-accent: var(--av-focus);
    /* Where the badge starts inside its card, and so where the rail's segment
       starts too. Zero: the badge tops out with the name field beside it, so a
       number in the sequence marks the step rather than a row of its text —
       which is also what lets the rail begin at the badge's bottom edge and a
       drop indicator mean a slot. It was 15px, centring the badge on the name.
       One number still, because a badge that drifts off the chain is the same
       bug as a badge that drifts off its own name. */
    --we-badge-top: 0px;
  }
  #board.editing #wfeditor { display: flex; }
  #board.editing #board-head, #board.editing #board-body { display: none; }
  #wfeditor .webody {
    flex: 1; min-height: 0; overflow: auto;
    display: flex; flex-direction: column; gap: 14px;
    padding: 12px 16px 58px; box-sizing: border-box;
    /* Kill platform scrollbar; overlay .wescroll is the only chrome. */
    scrollbar-width: none;
  }
  #wfeditor .webody::-webkit-scrollbar { width: 0; height: 0; display: none; }
  #board.editing.hasbar #wfeditor .webody { padding-bottom: 58px; }

  /* Overlay scroll marker — dim neutral, not the focus spine. */
  #wfeditor .wescroll {
    position: absolute; top: 10px; right: 5px; bottom: 10px;
    width: 3px; border-radius: 99px; pointer-events: none; z-index: 2;
    background: color-mix(in srgb, var(--av-fg) 7%, transparent);
    opacity: 0;
    transition: opacity 160ms ease;
  }
  #wfeditor .wescroll[hidden] { display: none; }
  #wfeditor:hover .wescroll,
  #wfeditor:focus-within .wescroll,
  #wfeditor.is-scrolling .wescroll { opacity: 1; }
  #wfeditor .wethumb {
    position: absolute; left: 0; width: 100%; min-height: 28px;
    border-radius: 99px;
    /* Cool dim pill — readable on dark/light via --av-fg, never blue. */
    background: color-mix(in srgb, var(--av-fg) 26%, transparent);
    transition: background 120ms ease;
  }
  #wfeditor:hover .wethumb,
  #wfeditor:focus-within .wethumb {
    background: color-mix(in srgb, var(--av-fg) 40%, transparent);
  }

  @media (prefers-reduced-motion: no-preference) {
    #board.editing #wfeditor {
      animation: we-open 180ms cubic-bezier(.16, 1, .3, 1) both;
    }
    @keyframes we-open {
      from { opacity: 0; transform: translateY(4px); }
    }
  }

  #wfeditor .wehead {
    display: flex; align-items: center; gap: 10px; flex: none;
  }
  /* Nothing sits between Back and the count: the title span is gone, and the
     name field's own label says which screen this is. margin-left pushes the
     count and the two buttons right with no filler element in the middle. */
  #wfeditor .wecount {
    flex: none; margin-left: auto;
    font-size: var(--av-fs-sm); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--av-fg-3); padding: 2px 0;
  }
  #wfeditor .weback, #wfeditor .wesave, #wfeditor .wedelete {
    font: inherit; font-size: var(--av-fs-md); cursor: pointer;
    border-radius: 6px; padding: 5px 12px;
    border: 1px solid var(--av-border); background: transparent; color: var(--av-fg);
  }
  #wfeditor .weback { color: var(--av-fg-3); }
  #wfeditor .weback:hover:not(:disabled) {
    color: var(--av-fg); background: var(--av-hover);
  }
  /* Armed by an Escape over unsaved edits: the next one discards them. */
  #wfeditor .weback.armed {
    color: var(--av-red, var(--vscode-charts-red));
    border-color: color-mix(in srgb, var(--av-red, var(--vscode-charts-red)) 45%, var(--av-border));
    font-weight: 600;
  }
  #wfeditor .wesave {
    background: var(--av-btn-bg, var(--vscode-button-background, #0078d4));
    border-color: transparent;
    color: var(--av-btn-fg, var(--vscode-button-foreground, #fff));
    font-weight: 600;
  }
  #wfeditor .wesave:hover:not(:disabled) {
    filter: brightness(1.06);
  }
  #wfeditor .wesave:disabled, #wfeditor .wedelete:disabled,
  #wfeditor .weback:disabled {
    opacity: 0.5; cursor: default;
  }
  /* Left of Save on edit only — outline, not filled: destructive secondary. */
  #wfeditor .wedelete {
    color: var(--av-red, var(--vscode-charts-red));
    border-color: color-mix(in srgb, var(--av-red, var(--vscode-charts-red)) 45%, var(--av-border));
  }
  #wfeditor .wedelete:hover:not(:disabled) {
    background: color-mix(in srgb, var(--av-red, var(--vscode-charts-red)) 12%, transparent);
  }
  /* Second click is the real decision — fill so it cannot be skimmed as Save. */
  #wfeditor .wedelete.armed {
    background: color-mix(in srgb, var(--av-red, var(--vscode-charts-red)) 18%, transparent);
    font-weight: 600;
  }

  #wfeditor .wefield { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  /* The one label left on the surface, and now the only thing that names the
     screen — so --av-fg-2 (6.77:1) rather than --av-fg-3 (4.06:1, under WCAG
     for text this size). It was decorative when the title span said it too. */
  #wfeditor .welabel {
    font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--av-fg-2); font-weight: 600;
  }
  /* Ghost inputs. Transparent at rest so a form full of prose reads as prose;
     the border is declared and only decoloured, and the padding is the same in
     all three states, so the box arrives without anything moving under the
     pointer. Hover is the affordance a borderless field otherwise lacks. */
  #wfeditor .wename {
    font: inherit; font-size: var(--av-fs-lg); font-weight: 600;
    padding: 8px 10px;
  }
  /* line-height is declared, not inherited. A font shorthand set to inherit,
     followed by a font-size override, leaves it normal — a number the face
     picks — so a field's height moved with whatever face the host happened to
     be rendering, and a card's height is arithmetic rather than a guess.
     It mattered more when the badge was offset onto the name's text centre;
     the badge tops out with the field now, but the rhythm is still worth
     declaring rather than inheriting. */
  #wfeditor input {
    font: inherit; font-size: var(--av-fs-md); color: var(--av-fg);
    background: transparent;
    line-height: 1.5;
    border: 1px solid transparent;
    border-radius: 6px; padding: 6px 9px; width: 100%; box-sizing: border-box;
    transition: background 130ms ease, border-color 130ms ease, color 130ms ease;
  }
  #wfeditor input:hover:not(:disabled) {
    background: var(--av-hover);
    border-color: var(--av-input-border, var(--av-border));
  }
  #wfeditor input:focus {
    background: var(--av-input-bg, var(--vscode-input-background, #313131));
    color: var(--av-input-fg, var(--av-fg));
    outline: 1px solid var(--av-focus); outline-offset: -1px;
    border-color: var(--av-focus);
  }
  /* The workflow name is the one field with no node around it, so the box
     above is its focus. A step's fields lose to the canvas sheet, which is
     the node they sit in. */


  /* .wcscroll clips vertically, and a visible overflow-y beside its
     overflow-x: auto computes to auto, so the room a focused Add step's
     outline needs is padding rather than a change of overflow. */
  #wfeditor #wfcanvas .wcgrid { padding-bottom: 4px; }

  /* One authored moment: a newly appended step settles in.
     Only the node marked .enter animates — full rebuilds do not restage the chain. */
  @media (prefers-reduced-motion: no-preference) {
    #wfeditor .wcnode.enter {
      animation: we-step-in 220ms cubic-bezier(.16, 1, .3, 1) both;
    }
    #wfeditor .wcnode.enter .wcg {
      animation: we-badge-in 280ms cubic-bezier(.16, 1, .3, 1) both;
    }
    @keyframes we-step-in {
      from { opacity: 0; transform: translateY(6px); }
    }
    @keyframes we-badge-in {
      from { transform: scale(.72); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
  }

  #wfeditor .westrip {
    flex: none; padding: 8px 10px; border-radius: 6px;
    border: 1px solid var(--av-yellow, var(--vscode-charts-yellow));
    background: var(--av-warn-bg, var(--vscode-inputValidation-warningBackground, #352a05));
    color: var(--av-fg); font-size: var(--av-fs-md);
  }
  #wfeditor .westrip li { margin: 2px 0 2px 1.1em; }
`;
