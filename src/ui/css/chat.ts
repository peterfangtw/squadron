/** Dock chat: head, prompt bar, thread, turns, markdown, folds. */

export const css = /* css */ `
  #chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }

  /* No session selected. Hidden rather than cleared: a head written empty is
     still a head — its padding, its border and four buttons wired to
     ui.selected — and every field added to it later would have to remember to
     clear itself too. One class takes the whole row out of the flow and cannot
     go stale. docs/mockups/chat-empty.html is the comp. */
  #chat.empty > #chat-head,
  #chat.empty > #chat-needs,
  #chat.empty > #prompt-bar,
  #chat.empty > #composer { display: none; }
  /* Grid rather than an auto margin, and safe center rather than plain center:
     a centred overflow in a scroller is clipped at the start edge and cannot be
     scrolled back to, so a dock shorter than the block would lose its top. */
  #chat.empty:not(.starting) #thread { display: grid; align-content: safe center;
                        grid-template-columns: minmax(0, 1fr); justify-items: center;
                        padding: 24px 20px; }
  .vacant { display: grid; justify-items: center; gap: 8px; min-width: 0;
            width: 100%; max-width: 34ch; overflow-wrap: anywhere; text-align: center; }
  .vacant h3 { margin: 0; font-size: var(--av-fs-lg); font-weight: 600;
               color: var(--av-fg-2); }
  .vacant p { margin: 0; font-size: var(--av-fs-md); color: var(--av-fg-3);
              line-height: 1.5; }

  /* ── the empty chat as a launcher ────────────────────────────────────────
     The second class, over \`empty\`. \`empty\` is the tab having no session;
     \`start\` is that tab offering to begin one, and the whole difference is
     that the composer comes back. Two classes beat the shipped one-class rule
     on specificity, so the order of the two in this sheet decides nothing —
     which is what keeps this block deletable.
     docs/mockups/chat-start.html is the comp; three of its six rules are not
     here, and they are the ones for a folder pill the draft does not have —
     New stays a per-group slot, so the folder is decided by the press rather
     than picked in the box. Its \`#cstatus .more\` went with them. */
  #chat.empty.start > #composer,
  #chat.empty.loading > #composer { display: flex; }

  /* ── the start in flight ─────────────────────────────────────────────────
     The third class, over \`empty\`: the draft drawn as the session it is
     becoming. The first prompt stays at the top while startup feedback occupies
     the space below it. docs/mockups/dock-startup-controls.html is the comp. */
  #chat.empty.starting > #composer { display: flex; }
  #chat-startup { flex: 1; display: flex; justify-content: center; align-items: safe center;
                  padding: 24px 20px; }
  #chat-startup[hidden] { display: none; }
  #chat-startup .start-note { display: flex; flex-direction: column; align-items: center;
                             gap: 16px; min-width: 0; max-width: 34ch;
                             color: var(--av-fg-3); text-align: center; overflow-wrap: anywhere; }
  #chat-startup .startup-actions { justify-content: center; }
  /* Absolute centering would overlap a long first prompt. */
  #threadwrap:has(> #chat-startup:not([hidden])) { overflow-y: auto; }
  #threadwrap:has(> #chat-startup:not([hidden])) #thread { flex: none; overflow: visible; }
  /* The pick is made; a model pill or an Attach changed now would describe a
     start already on its way. */
  #chat.starting #composer .shell { pointer-events: none; }
  #chat.starting #send { display: inline-flex; align-items: center; gap: 6px; }
  #chat.starting #send .spinner { width: 10px; height: 10px; }
  /* The press, as motion (\`fly\` in webview/chat.ts). What the script moves
     is lifted to <body> for its flight, and 2 keeps it over the thread and
     under the divider (4) — docs/reference/z_index.md. */
  .aloft { position: fixed; margin: 0; pointer-events: none; z-index: 2; }
  /* The first reply rises under the prompt; \`rise\` is spent by its first turn. */
  @media (prefers-reduced-motion: no-preference) {
    .turn.rise { animation: first-reply 260ms cubic-bezier(.2, .8, .2, 1); }
  }
  @keyframes first-reply { from { transform: translateY(6px); opacity: 0; } }
  /* Why a start did not happen. The one place a reader can learn it: the
     host's own warning is a notification, and those are muted here. */
  .vacant .why { color: var(--av-orange); }

  #chat-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 14px;
               border-bottom: 1px solid var(--av-border); }
  #chat-head.starting { display: none; }
  #chat-head .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                     white-space: nowrap; }
  /* Editable, and saying so only on approach: a name that looked like a field
     at rest would read as one more control in a head that already has four. */
  #chat-head .name[role="button"] { cursor: text; border-radius: 3px;
                                    padding: 1px 4px; margin: -1px -4px; }
  #chat-head .name[role="button"]:hover { background: var(--av-hover); }
  /* The box it becomes: the same box, so the words do not move when it opens. */
  #chat-head input.name { font: inherit; color: inherit; padding: 1px 4px; margin: -1px -4px;
                          border: 1px solid var(--av-focus); border-radius: 3px;
                          background: var(--av-input-bg); }
  #chat-head input.name:focus { outline: none; }
  /* The same number the card leads with, on the dock that replaced the card in
     your attention: how stale this session is, and whether resuming it is cheap. */
  #chat-head .since { font-size: var(--av-fs-md); }
  #chat-needs:not(:empty) { flex: none; margin: 10px 14px 0; padding: 8px 10px; border-radius: 4px;
                            font-size: var(--av-fs-md); white-space: pre-wrap; overflow-wrap: anywhere;
                            max-height: 7em; overflow-y: auto;
                            color: var(--av-orange);
                            background: var(--av-quote-bg); }
  /* What you asked for, kept on screen after it scrolls off: the prompt the
     visible replies belong to, and the two arrows that walk the ones before it.
     A row above the thread rather than a layer over it — the thread is the only
     scroller in the dock, so a floating bar would need a clipping box of its own
     and every scroll comparison would carry its height. */
  /* No fill of its own: the panel has two elevations and a card's is not one to
     spend on chrome — on the darker themes it made this read as a session card
     that had wandered into the dock. Its border and the blue rule are enough to
     make it a row. */
  /* 4px of vertical padding, not 6: the bar was spending 12px around a 20px
     control, and the two arrows want it more than the bar does. Same 32px tall
     either way — see .nav below. */
  #prompt-bar { flex: none; display: flex; align-items: center; gap: 8px;
                padding: 4px 8px 4px 14px; border-bottom: 1px solid var(--av-border); }
  #prompt-bar[hidden] { display: none; }
  /* The rule a user turn wears, so the bar reads as one of them rather than as
     chrome that happens to quote one. */
  #prompt-bar .tag { flex: none; font-size: var(--av-fs-sm); text-transform: uppercase;
                     letter-spacing: .06em; padding-left: 7px;
                     color: var(--av-blue); border-left: 2px solid var(--av-blue); }
  #prompt-bar .txt { flex: 1; min-width: 0; font-size: var(--av-fs-md);
                     overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #prompt-bar .count { flex: none; font-size: var(--av-fs-sm); color: var(--av-fg-3);
                       font-family: var(--vscode-editor-font-family);
                       font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* 24 square, taken out of the bar's own padding rather than added to the
     dock — an honest box instead of an invisible one, which is what the two
     controls that walk the conversation deserve. The 8px of extra width is
     absorbed by .txt, which is flex: 1; min-width: 0. */
  #prompt-bar .nav { flex: none; width: 24px; height: 24px; padding: 0; line-height: 1;
                     display: inline-flex; align-items: center; justify-content: center;
                     font-family: inherit; font-size: var(--av-fs-md); cursor: pointer;
                     border: none; border-radius: 4px; background: none;
                     color: var(--av-fg); opacity: .7; }
  #prompt-bar .nav:hover:not(:disabled) { opacity: 1; background: var(--av-hover); }
  #prompt-bar .nav:disabled { opacity: .22; cursor: default; }
  /* Amber for a prompt that is not the last thing you asked: blue must keep
     meaning "this is current", or the bar is worse than no bar. */
  #prompt-bar.past .tag { color: var(--av-orange); border-left-color: var(--av-orange); }
  #prompt-bar.past .count { color: var(--av-orange); }
  /* Past the oldest turn that was read: a statement, not a prompt. */
  #prompt-bar.head .tag { color: var(--av-fg-3); border-left-color: var(--av-border); }
  #prompt-bar.head .txt { color: var(--av-fg-3); font-style: italic; }

  /* Box the observe drawer is positioned against (placement E). flex:1 lives
     here so #thread remains the only scroller and the drawer ends at the
     composer seam without covering chat head. */
  #threadwrap { position: relative; flex: 1; min-height: 0; display: flex;
                flex-direction: column; overflow: visible; }
  /* Positioned so a turn's offsetTop is its offset within this scroller, which
     is what the bar measures against. Nothing else about the layout changes.

     --room is the trailing space the prompt bar's arrows need: a prompt can be
     lifted to the top only while its offsetTop is inside
     scrollHeight - clientHeight, and the newest ones are not — nothing follows
     them but their own replies. \`fitRoom\` (webview/chat.ts) measures the
     shortfall and writes it here; it is 0 for every thread whose newest reply
     fills the view, which is every long one. Padding rather than a child,
     because \`paint\` deletes every child past the turn list.

     Nothing puts a reader in it: \`endTop\` is the end of the content, and that
     is where the pin, the restore and the down arrow all aim. One who scrolls
     there themselves stays until a turn lands below them — \`repin\` decides
     that, and it is what makes the room somewhere to stand rather than
     somewhere to be bounced out of a poll later.

     It does not contend with .outbox's margin-top: auto further down this
     sheet. That margin parks the block on the composer divider by absorbing
     free space, and a thread with free space is one that does not overflow —
     which is the one case the room is always 0 for. */
  #thread { position: relative; flex: 1; min-height: 0; overflow-y: auto;
            padding: 12px 14px calc(12px + var(--room, 0px));
            display: flex; flex-direction: column; gap: 14px; }
  /* Chromium draws an auto ring around this scroller after ArrowDown or a
     keyboard-driven refocus (measured 2026-10-27). */
  #thread:focus { outline: none; }
  .turn { display: flex; flex-direction: column; gap: 4px; }
  .history-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 8px 12px; color: var(--av-fg-3); font-size: var(--av-fs-md); }
  .history-nav span { margin-right: auto; }
  .history-nav button { min-height: 28px; padding: 3px 8px; border-radius: 3px;
    color: var(--av-fg); background: var(--av-card); border: 1px solid var(--av-border); cursor: pointer; }
  .history-nav button:hover { background: var(--av-hover); }
  .history-nav button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .history-note { display: flex; align-items: center; gap: 8px;
                  color: var(--av-fg-3); font-size: var(--av-fs-md); }
  @media (prefers-reduced-motion: reduce) {
    .history-note .spinner { animation: none; }
  }
  /* For the length of a divider drag only. A width change re-wraps every turn
     in the thread, and a drag does that per frame: 2470 ms of layout (duration,
     over 300 frames) on a 400-prompt thread, headless Chromium against this
     stylesheet — what was left after the script half was gated (\`dockDrag\`,
     webview/chat.ts). Off-screen turns keep the height they last had instead,
     and the same drag costs 108 ms. The 140px is only for a turn never yet on
     screen; \`auto\` supplies the real height for every turn the reader has
     passed.
     Not permanent, because it makes every offset in the thread a guess by
     however much of it has never been on screen, and three readings depend on
     those offsets: the prompt bar, the place a returning reader is put, and the
     pin. All three wait for the mouse to come up, and the reader is held by
     element anchor meanwhile — \`grip\` in webview/chat.ts. Nothing reads a
     guess. */
  #thread.resizing .turn { content-visibility: auto; contain-intrinsic-size: auto 140px; }
  .who { font-size: var(--av-fs-sm); text-transform: uppercase; letter-spacing: .06em;
         color: var(--av-fg-3); }
  .turn.user .body { border-left: 2px solid var(--av-blue); padding-left: 9px; }
  /* The body rule kept a raw typed string. The row is formatted prose, so a paragraph takes pre-wrap from the p rule below. */
  .turn.send-failed .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  /* A message another session sent is a user turn the reader did not write, so
     it keeps the rule and changes its colour rather than losing it: the shape
     still says "somebody spoke here", and the hue says it was not you. Purple
     is what the .attr span beside it already uses for an attribution. */
  .turn.user.peer .body { border-left-color: var(--av-purple); }
  /* A wait converging is nobody's turn, and it takes the peer's purple: a peer
     and a machine are not the same thing, but against the reader they are one
     category — not you, and not human. Written out rather than overriding a
     colour, because \`wait\` is a role of its own and inherits no rule above.
     The label stays muted like a peer's: the hue lives on the rail. */
  .turn.wait .body { border-left: 2px solid var(--av-purple); padding-left: 9px; }
  /* A settled turn's work, behind one line. Sits where the first hidden turn
     would have, and reads as a statement with a control in it rather than as a
     turn: no author, no body, and the same muted register as the tool rows it
     is standing in front of. */
  /* Wraps, because the files the fold took with it trail the label on the same
     line: one write is the common turn and sits beside "Worked for 12s", and a
     twenty-write run breaks onto its own lines rather than pushing the label
     out of the column. */
  .fold { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  /* The row is alone on its line under the thread's 14px gap, which is dead
     space, so a ::before claims 3px of it top and bottom: 19 -> 25. Vertical
     only — the 8px to the first .wpill beside it belongs to the pill, and
     two overlapping targets are worse than one small one. */
  .foldbtn { display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
             font-family: inherit; font-size: var(--av-fs-md); color: var(--av-fg-3);
             background: none; border: none; padding: 2px 0; position: relative; }
  .foldbtn::before { content: ''; position: absolute; inset: -3px 0; }
  .foldbtn:hover { color: var(--av-fg-2); background: var(--av-hover);
                   border-radius: 3px; box-shadow: 0 0 0 3px var(--av-hover); }
  .foldbtn .steps { opacity: .7; }
  .foldbtn .steps::before { content: '· '; }
  /* A triangle, turned down once the turn is open — the one place this panel
     spends a caret, and it points at what it controls. */
  .foldbtn .caret { width: 0; height: 0; flex: none;
                    border-left: 4px solid currentColor;
                    border-top: 3.5px solid transparent;
                    border-bottom: 3.5px solid transparent; }
  .fold.open .caret { transform: rotate(90deg); }

  /* One tool call, between the runs of prose it sat between. Quiet by
     construction: a turn is what was said, and these are the machinery under
     it, so nothing here competes with the body text for the eye. The output is
     the CLI's own bytes, so it takes the editor's font and keeps its newlines
     — already cut to 180 characters on the host side. */
  .tool { display: flex; flex-direction: column; gap: 3px;
          font-size: var(--av-fs-md); color: var(--av-fg-3);
          font-family: var(--vscode-editor-font-family); }
  .thead { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .thead .what { flex: none; }
  .thead .detail { color: var(--av-fg-2); overflow: hidden; text-overflow: ellipsis;
                   white-space: nowrap; }
  .tool .glyph { width: 5px; height: 5px; flex: none; align-self: center;
                 border-radius: 50%; background: var(--av-fg-3); }
  /* Shut by default: the row is the one line, and the bytes behind it are what
     a reader asks for. Only a call that returned something wears the caret, so
     the handle and the thing it opens arrive together — and it is the same
     triangle the fold spends, pointing the same way. */
  .tool .out { display: none; white-space: pre-wrap; overflow-wrap: anywhere; opacity: .8;
               border-left: 2px solid var(--av-border); padding-left: 8px;
               margin-left: 2px; }
  .tool.open .out { display: block; }
  /* The whole row was already the target; only its 18.6px height ever failed.
     A ::before claims 4px of the thread's own 14px gap above and below and 6px
     sideways into its padding: 18.6 -> 26.6, and nothing moves. Four rather
     than the three that would arithmetically do, because the drawn height is a
     line box and lands on .6 of a pixel — three leaves this a rounding error
     under the floor rather than over it.

     The fill is the other half of it, and not about pixels: a control 432px
     wide that answers a pointer by tinting four words does not read as
     pressable at all. */
  .thead:has(.caret) { cursor: pointer; position: relative; }
  .thead:has(.caret)::before { content: ''; position: absolute; inset: -4px -6px; }
  .thead:has(.caret):hover .what { color: var(--av-fg-2); }
  .thead:has(.caret):hover { background: var(--av-hover); border-radius: 3px;
                             box-shadow: 0 0 0 3px var(--av-hover); }
  .thead .caret { width: 0; height: 0; flex: none; margin-left: auto; align-self: center;
                  opacity: .55; border-left: 4px solid currentColor;
                  border-top: 3.5px solid transparent;
                  border-bottom: 3.5px solid transparent; }
  .tool.open .caret { transform: rotate(90deg); }
  /* A call the result called an error. The dot carries it rather than the
     whole row: a failure is a fact about the call, and colouring the text
     would make a routine non-zero exit read as an alarm. */
  .tool.failed .glyph { background: var(--av-red); }
  .tool.failed .out { border-left-color: var(--av-red); }

  /* An image the turn carried. Collapsed to a chip, because a screenshot is
     wide and this column is not: at the dock's usual width a faithful preview
     costs more vertical than the turn it belongs to, and most of the time the
     reader wants the words. Opening one is a click, and the bytes are only
     fetched then — the thread itself carries none. */
  .shots { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin-top: 6px; }
  .shot { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; max-width: 100%; }
  /* .shotchip, not .chip. This rule and the composer's attachment chip were
     both called .chip at the top level of this stylesheet, and the composer's
     is declared second — so for as long as they shared a name, every property
     both set was painted by the other one and every edit here had a coin-flip
     chance of doing nothing. Renamed rather than re-cascaded: two rules that
     are not the same control should not answer to the same selector.

     4px of vertical padding rather than 3, which is what takes the target past
     24 now that it is this rule the chip is actually wearing. */
  .shotchip { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
              font-size: var(--av-fs-md); font-family: inherit; color: var(--av-fg-3);
              background: var(--av-quote-bg); border: 1px solid var(--av-border);
              border-radius: 4px; padding: 4px 8px; }
  .shotchip:hover { color: var(--av-fg); border-color: var(--av-focus); }
  /* Nothing to open: a pruned file, or one too big to inline at all. Dashed and
     unhovered, so it reads as a statement rather than a control. */
  .shot.dead .shotchip { border-style: dashed; cursor: default; }
  .shot.dead .shotchip:hover { color: var(--av-fg-3); border-color: var(--av-border); }
  .shotchip .glyph { width: 11px; height: 9px; border: 1px solid currentColor;
                     border-radius: 1.5px; flex: none; opacity: .85; }
  .shot img { display: block; max-width: 100%; max-height: 190px; object-fit: contain;
              object-position: left top; border: 1px solid var(--av-border);
              border-radius: 4px; background: var(--av-quote-bg); cursor: zoom-in; }
  /* The second verb, and the only one left when the image is too big to show:
     190px is a thumbnail, and an editor tab is where a screenshot is legible.

     Scoped to .shot, and that is a fix rather than tidying: full is also the
     rank a reading past 90% wears, so an unscoped rule here was underlining the
     nav bar's usage percentage — a number nobody can click, dressed as a link.
     Same trap as .mrow and .chip above; this sheet has no scoping, and a class
     name taken twice is the later rule painting the earlier one's element. */
  .shot .full { align-self: flex-start; cursor: pointer; font-family: inherit;
          font-size: var(--av-fs-md); color: var(--av-fg-3); background: none;
          border: none; padding: 0; text-decoration: underline; }
  .shot .full:hover { color: var(--av-fg); }

  /* A file the turn wrote, as something to open. Geometry copied from .chip
     above rather than sharing its class: .chip is declared twice in this
     document and the composer's copy wins the cascade, which is the same trap
     the skill chip had to step around (see .cmd's note below). The pair still
     has to read as one family — an image and a file are both attachments of a
     turn — so the copy is deliberate and should move when .chip moves.
     The accent is --av-link and it is spent on the glyph alone: blue means
     busy, orange waiting, purple a command session and green context headroom,
     so the one token left that says "clickable" and no state carries it, and
     carries it in the smallest place that still reads.
     The w is for written, and the name is not .fpill because that one is the
     nav and tickets filter pill, declared above. A chip wearing it inherited
     that rule's opacity of .72 and its hover — a second dimming on top of the
     --av-fg-2 this sets, and a
     standing invitation for a filter-pill rule to restyle a file chip. Same
     trap as .chip above, one block later. */
  .files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
  /* 24 tall by the floor rather than by its padding: this opens a file, and at
     3px around a 12px line box it was drawing 22. The row it sits on already
     wraps, so a pill two pixels taller costs nothing but the two pixels. */
  .wpill { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
           min-height: 24px; box-sizing: border-box;
           font-size: var(--av-fs-md); font-family: var(--vscode-editor-font-family);
           color: var(--av-fg-2); background: var(--av-quote-bg);
           border: 1px solid var(--av-border); border-radius: 4px; padding: 3px 8px; }
  .wpill:hover { color: var(--av-fg); border-color: var(--av-focus); }
  /* A session named in prose (core/session_ref.ts). */
  .sref { padding: 0 4px; border-radius: 4px; white-space: nowrap;
          background: color-mix(in srgb, var(--av-yellow) 24%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-yellow) 60%, transparent); }
  /* A skill named in the reader's own turn, in the composer's skill green. */
  .sref.skill { background: color-mix(in srgb, var(--av-green) 24%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-green) 60%, transparent); }
  /* A model pick, in .pchip.model's grey (css/prose.ts says why no accent). */
  .sref.model { background: color-mix(in srgb, var(--av-fg-3) 18%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-fg-3) 50%, transparent); }
  button.sref.ticket { border: 0; font: inherit; color: var(--av-link); cursor: pointer;
    background: color-mix(in srgb, var(--av-link) 24%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--av-link) 60%, transparent); }
  button.sref.ticket:hover { text-decoration: underline; }
  /* The marker: a path this turn changed is missing from the row beside it.
     Deliberately quiet and deliberately not a pill — it opens nothing, and a
     solid border at .wpill's weight would read as one more file. Dashed and
     --av-fg-3, which is what the counts inside a pill already use for "read
     this, do not aim at it". */
  .wshort { display: inline-flex; align-items: center; min-height: 24px;
            box-sizing: border-box; font-size: var(--av-fs-sm);
            color: var(--av-fg-3); border: 1px dashed var(--av-border);
            border-radius: 4px; padding: 3px 8px; }
  .wpill .glyph { width: 11px; height: 9px; border: 1px solid var(--av-link);
                  border-radius: 1.5px; flex: none; }
  /* What the file is, when its name says: a picture, source, or markdown, at
     the 13px the head's own controls are drawn at — so the two families of
     glyph in this dock are one size. The outline above stays for every other
     extension, because a wrong guess about a file's kind is worse than the
     shape that guesses nothing.
     Declared after both chips and named .gmark rather than .mark: the composer
     declares a bare, unscoped .mark for the question checkbox, and this sheet
     has no scoping — see the collisions .chip and .full above were renamed out
     of. Border and box drop together; the svg brings its own size. */
  .glyph.gmark { width: auto; height: auto; border: none; border-radius: 0;
                 display: flex; }
  .wpill .glyph.gmark { color: var(--av-link); }
  /* How much of the file the turn wrote, and the pill's second target: this
     opens the diff where the pill around it opens the file. A border rather
     than a gap, because two rounded boxes 6px apart read as two files — it is
     one file with two things to do to it.
     Padded to the pill's own 3px 8px so the whole segment is the target rather
     than the digits: it is the smaller half and the one a pointer misses.
     The margin pulls the divider out to the pill's edges, which 3px of pill
     padding would otherwise inset it from. */
  .wnum { display: inline-flex; align-items: center; gap: 5px; align-self: stretch;
          margin: -3px -8px -3px 2px; padding: 3px 8px;
          border-left: 1px solid var(--av-border);
          font-size: var(--av-fs-sm); font-variant-numeric: tabular-nums;
          color: var(--av-fg-3); }
  /* The colour here is inherited by .unk only — the signed pair below sets its
     own hue and keeps it hovered, so the wash is what says target for those. */
  .wnum:hover { background: var(--av-hover); color: var(--av-fg); }
  /* Counts too large to diff: still read, no longer a target of their own. Only
     the hover is dropped — the segment keeps .wpill's pointer because the click
     still reaches the pill under it and still opens the file. A default cursor
     here would say dead over a region that does something. */
  .wnum.flat:hover { background: none; color: var(--av-fg-3); }
  /* Green and red, at full token strength. Shipped monochrome first, on the
     argument that --av-green is context headroom and --av-red a failed call a
     few rows up this same column; the first read of a real pill was "why is
     this not green and red", so the diff convention wins the collision it was
     being protected from. A dimmed pair was comped
     (docs/mockups/change-size.html §5) and rejected: it buys separation from
     the status tokens by being weaker than them, which is a third register to
     learn for a distinction the reader was never confused by.
     .unk stays muted — ±? is an absence, not a direction. */
  .wnum .add { color: var(--av-green); }
  .wnum .del { color: var(--av-red); }
  .wnum .unk { color: inherit; }
  /* A question already answered, on the row that asked it. The pill's own shape
     — it opens something, like a file pill does — wearing a filled round mark
     rather than the hollow page outline, so a question does not read as a file
     at a glance. A button rather than a div, because there is nothing to open
     in the editor and everything to answer to a keyboard. */
  .askpill { font-family: var(--vscode-editor-font-family); }
  .askpill .glyph { width: 9px; height: 9px; border-radius: 50%;
                    border-color: var(--av-blue); background: var(--av-blue); }

  /* Where the turns this dock never read would be: a rule with the reason on
     it, quiet enough to read as the thread's edge rather than as a turn.
     .break — a request the reader cut short — is the same statement about the
     conversation and shares the shape, but never the class: cut() tests the
     first child for "elided" to decide whether history went unread, and a break
     wearing it would say turns were lost that never existed. */
  .elided, .break, .trigger, .sourced { font-size: var(--av-fs-md); color: var(--av-fg-3); text-align: center;
            border-top: 1px dashed var(--av-border); padding-top: 10px; }
  /* Its own class for the reason .break has one: cut() reads the first child for
     "elided", and this note can stand there when nothing was cut. */
  .sourced { font-size: var(--av-fs-sm); }
  /* Uppercased where .elided is a sentence: this one is a state the session
     passed through, and reads as punctuation between two turns. */
  .break { text-transform: uppercase; letter-spacing: .06em; font-size: var(--av-fs-sm); }
  /* Why a turn nobody prompted began, standing above it in .break's shape. */
  .trigger { text-transform: uppercase; letter-spacing: .06em; font-size: var(--av-fs-sm); }

  /* Where the conversation stopped and restarted. The same statement between
     two turns as .break, and deliberately not its shape: a rule that runs
     through the words rather than over them, because this one is read while
     scrolling past and .break is read where the reader stopped. Its own class
     for the reason .break has one — cut() reads the first child. */
  .gap { display: flex; align-items: center; gap: 9px; margin: -3px 0;
         font-size: var(--av-fs-sm); color: var(--av-fg-3);
         text-transform: uppercase; letter-spacing: .06em; }
  .gap::before, .gap::after { content: ''; flex: 1; height: 1px; background: var(--av-border); }

  /* A skill that loaded, collapsed to its name. Reuses .cmd from the card's
     status row — the outlined purple chip that already means "a thing running
     here, named" — rather than .chip, which is declared twice in this
     document and whose composer copy wins the cascade. */
  .turn.skill { align-items: flex-start; }
  .turn.skill .cmd { font-family: var(--vscode-editor-font-family); }
  /* One the reader typed: their voice, so it wears the blue a prompt wears
     rather than the purple that means the session reached for this itself. */
  .turn.skill.mine .cmd { border-color: var(--av-blue); color: var(--av-blue); }

  /* A turn the CLI wrote where the model's would be. It did write it, so it
     keeps an author and a body — the rail turns red instead. */
  .turn.cli .who { color: var(--av-red); }
  .turn.cli .body { border-left: 2px solid var(--av-red); padding-left: 9px;
                    color: var(--av-fg-2); }

  /* A slash command's own answer: the same author, and not an alarm. Red is
     what the rule above spends to say something went wrong, and a /context the
     reader asked for would be read that way in it.

     So the rail goes entirely — a panel does not need one — and the body
     becomes a surface instead: the blockquote token, bordered, pressed into the
     page.

     The surface is a token; the shadow is not, and deliberately. An inset
     shadow only reads as pressed in if it is *darker than the thing it is cast
     on*, and that is true in every preset — a recess is dark whether the page
     is. Mixing it from --av-bg was the obvious move and is wrong: on paper
     --av-bg (#f2f3f5) is lighter than --av-quote-bg (#eceef1), so the glow came
     out light on a darker surface and embossed instead. --av-fg inverts the
     same fault onto the dark presets. Black is the only end that is down in all
     five, and on ink it is nearly invisible against an already-dark surface,
     which is the right amount of nothing.

     A cache-warming ping is the same readout: the CLI's upkeep, not an alarm. */
  .turn.cli.local .who, .turn.warm .who { color: var(--av-fg-3); }
  .turn.cli.local .body, .turn.warm .body { border-left: none; padding: 8px 10px;
                          border-radius: 4px; background: var(--av-quote-bg);
                          border: 1px solid var(--av-border);
                          box-shadow: inset 0 1px 8px
                            color-mix(in srgb, #000 18%, transparent); }

  /* The skill a turn ran under, beside its author. Said where it changes, so a
     long run under one skill is tagged at its start. */
  .who .attr { margin-left: 6px; color: var(--av-purple); opacity: .85;
               text-transform: none; letter-spacing: 0;
               font-family: var(--vscode-editor-font-family); }

  /* When this turn was, at the far end of its author row. Nothing at rest, so
     the thread keeps the shape the divider gives it and gains no rail of
     digits; the reading appears under the pointer, where the question is being
     asked. Baseline, because the row mixes two sizes. */
  .turn .who { display: flex; align-items: baseline; }
  .turn .who .at { margin-left: auto; opacity: 0; transition: opacity .1s ease;
                   font-variant-numeric: tabular-nums; letter-spacing: 0; }
  .turn:hover .who .at { opacity: 1; }

  /* A message shown before the transcript has caught up with it. */
  .turn.sending .body { opacity: .5; }
  /* Queued behind the current turn: muted, and amber-dashed to read as pending. */
  .turn.queued .who { color: var(--av-orange); opacity: .8;
                      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .turn.queued .who :is(.tag, .qwho) { flex: none; }
  /* The amber is the pill's — it says "pending". An author beside it in the
     same colour reads as a second pill, which is the one thing this row already
     has. Muted, like the author line on the turn this is standing in for. */
  .turn.queued .who .qwho { color: var(--av-fg-3); }
  .turn.queued .body { opacity: .6; border-left-style: dashed;
                       border-left-color: var(--av-orange); }
  /*
   * Held outbox block (roadmap #31). Amber rail only, no fill. Sits at the
   * bottom of #thread via margin-top: auto so short chats park it on the
   * composer divider. Subheader under the rows: count + Send now.
   *
   * Not .qblock: the ask layer already owns that name (flex: 1 on a row of
   * columns, further down this sheet), and the later rule won the cascade —
   * the outbox grew into the free space on a short thread and shrank below its
   * own content on a long one, cutting the rail short and spilling the
   * subheader onto the composer divider.
   */
  .outbox { display: flex; flex-direction: column; gap: 12px;
            padding: 0 0 0 10px; border-left: 2px solid var(--av-orange);
            margin-top: auto; flex: none; }
  .outbox .turn.queued { gap: 3px; }
  /* What a held row carries when it carries no words: an image-only paste is a
     legal send, and the count is all this side has — the bytes never leave the
     window that holds the pipe. */
  .qshots { font-size: var(--av-fs-sm); color: var(--av-fg-3); font-style: italic; }
  .qacts { display: inline-flex; align-items: center; gap: 4px; margin-left: auto;
           text-transform: none; letter-spacing: 0; }
  /* The one control here that grows for real, and the one that had to. ×
     throws a queued message away at 16.4 x 17.5, and its neighbours in .qbar
     sat 2px apart — so an invisible ::before would have put two overlapping
     targets side by side, which turns a miss into a wrong hit. Padding
     instead, a 24px floor so a bare glyph clears sideways too, and the gaps
     widened to 4px to keep the grown targets apart. Costs 8px on a queued
     turn's overline row, which is the only price on this list that lands on a
     row the thread repeats — and queued turns are transient. */
  /* The floor is stated on both axes now. The width alone left these 23 tall —
     a 10px caption in a 12px line box plus 5px either side lands one pixel
     under, which is the kind of miss only a measurement finds. */
  .qact { font: inherit; font-size: var(--av-fs-sm); color: var(--av-fg-3);
          background: none; border: none; padding: 5px 7px; border-radius: 4px;
          min-width: 24px; min-height: 24px; box-sizing: border-box;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer; text-transform: none; letter-spacing: 0; }
  .qact:hover { color: var(--av-fg); background: var(--av-hover); }
  /* Both keep the amber label and give the amber wash back. These are text
     buttons in a row two items long, and .qact:hover above already says "you
     are on this" in the host's own hue-free way — a 14/18% tint under a label
     of the same colour was the hover restating the label, at the cost of
     dimming it: measured 4.33:1 on Dark Modern and 3.67:1 on paper, both under
     4.5. On --av-hover the same label is 5.15–10.92:1. Same reason the send
     button and the workflow chip stopped being filled.

     Neither needs a :hover of its own to hold its colour. Both are one class
     heavier than .qact and both are declared after .qact:hover, so at equal
     specificity they already win the colour — which is why the pair that used
     to restate it is gone rather than left as a guard. */
  .qact.danger { color: var(--av-orange); }
  .qact.go { color: var(--av-orange); font-weight: 600; }
  .qbar { display: flex; align-items: center; gap: 8px; padding: 2px 0 0;
          font-size: 11px; color: var(--av-fg-3); }
  .qbar .lbl { flex: 1; min-width: 0; }
  .qbar .lbl b { color: var(--av-orange); font-weight: 600; }
  .qbar .acts { display: inline-flex; align-items: center; gap: 4px; flex: none; }
  .qbar.conf .lbl, .qbar.conf .lbl b { color: var(--av-orange); }
  /* Being written right now, for a session the panel drives: full strength,
     because these are real words, with a caret to say more is coming. */
  .turn.live .body::after { content: '▌'; opacity: .6;
                            animation: blink 1.2s ease-in-out infinite; }
  .working { display: flex; gap: 4px; align-items: center; height: 12px; opacity: .55; }
  .working i { width: 4px; height: 4px; border-radius: 50%; background: currentColor;
               animation: blink 1.2s ease-in-out infinite; }
  .working i:nth-child(2) { animation-delay: .2s; }
  .working i:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }

  /* A turn is rendered markdown, so the dock has to style block elements it
     did not write. Kept tight: a chat turn is not a document, and the default
     margins would space it like one. */
  .body { overflow-wrap: anywhere; }
  /* Muted notices below summarized or interrupted prose. */
  .summarized, .cut { margin-top: 2px; font-size: .85em; opacity: .5; }
  .summarized::before, .cut::before { content: '· '; }
  .body > :first-child { margin-top: 0; }
  .body > :last-child { margin-bottom: 0; }
  .body p, .body ul, .body ol, .body pre, .body blockquote, .body table { margin: 6px 0; }
  /* A newline inside a paragraph is a soft break to the engine, which emits it
     as a newline and leaves the rest to CSS — and CSS collapses it. In a
     document that is right. Here the paragraph is something a person typed
     into a chat box and pressed enter inside, and without this the message
     changes shape under them the moment a transcript paragraph replaces what
     was on screen. The echo is the prose parser's HTML, which turns a typed
     newline into a hard break; the transcript engine still emits the newline
     inside p and leaves it to this rule. Only p gets it: li, and the list and
     quote wrappers, hold newlines between their child blocks, which preserved
     would draw as blank lines. */
  .body p { white-space: pre-wrap; }
  .body h1, .body h2, .body h3, .body h4, .body h5, .body h6 {
        margin: 11px 0 4px; font-size: 1em; font-weight: 600; opacity: 1;
        text-transform: none; letter-spacing: 0; display: block; }
  .body ul, .body ol { padding-left: 20px; }
  .body li { margin: 2px 0; }
  .body a { color: var(--av-link); }
  .body hr { border: none; border-top: 1px solid var(--av-border); }
  .body img { max-width: 100%; }
  /* A quote is Slack's: a rounded bar, the text at full strength. The host's
     webview stylesheet fills every blockquote with
     --vscode-textBlockQuote-background, so the fill is cleared. */
  .body blockquote { position: relative; margin-left: 0; padding-left: 12px; background: none; }
  .body blockquote::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0;
                             width: 4px; border-radius: 2px; background: var(--av-fg-3); }
  /* Auto table layout sizes a column between its min-content and max-content
     widths, and overflow-wrap: anywhere above counts in that min — it puts
     every column's floor at one glyph. Auto-layout then believes a header
     like Prod fits in a character, hands the space to whichever column holds
     prose, and shreds the rest into Pr/od, Sta/tus, 3/6. break-word still
     breaks a token too long to fit on its own, but is excluded from intrinsic
     sizing, so the floor is the longest word again. A header never breaks at
     all: the label is the column's identity, and these are short.

     That floor can still be wider than the dock — one long path is enough —
     and #thread scrolls on y, which computes x to auto, so the whole thread
     would pan. The table is its own scroller instead, as GitHub's markdown does
     it: a block capped at the turn's width, holding the table box inside. */
  .body table { display: block; width: max-content; max-width: 100%; overflow-x: auto;
                border-collapse: collapse; }
  .body th, .body td { border: 1px solid var(--av-border); padding: 3px 7px;
                       text-align: left; overflow-wrap: break-word; }
  .body th { white-space: nowrap; }
  /* No plate behind an inline span: the mono face and the colour are already
     two signals, and the tint only added a third that fought the line's
     rhythm. The plate stays on the fenced block below, which is a surface.

     background and padding are named rather than left out because the host's
     own webview stylesheet sets both on code, and it sits in an @layer — which
     a rule here outranks only for the properties it actually declares. */
  .body code { font-family: var(--vscode-editor-font-family); font-size: var(--av-fs-lg);
               color: var(--av-code-fg); background: none; padding: 0; }
  .body pre { background: var(--av-code-bg); border-radius: 4px;
              border: 1px solid var(--av-border); padding: 8px 10px;
              overflow-x: auto; }
  /* The strip is the control's, so the first line is not under it. */
  .body .fence { position: relative; margin: 6px 0; }
  .body .fence pre { margin: 0; padding-top: 32px; }
  .body .fence > .copy {
    position: absolute; z-index: 1; top: 4px; right: 6px;
    box-sizing: border-box; min-height: 24px; padding: 0 8px;
    border: 1px solid var(--av-border); border-radius: 4px;
    background: var(--av-card); color: var(--av-fg-2);
    font: inherit; font-size: var(--av-fs-sm); cursor: pointer;
  }
  .body .fence > .copy:hover { background: var(--av-hover); color: var(--av-fg); }
  /* A fenced block is already a surface, and hljs already colours what is in it
     — the inline tint would only fight the tokens for the untokenised text. */
  .body pre code { white-space: pre; color: var(--av-fg); }
  /* The fallback when no engine rendered the turn: text, kept as it was typed. */
  .body .raw { white-space: pre-wrap; }

  /* The engine's hljs spans — the four that carry most of a code block's
     colour, with everything else left to inherit. Which four values these are
     is settled up in the token layer: the host's light class used to override
     these rules, but a preset has to be able to outrank the host's class, and a
     token it also declares is how it does. */
  .hljs-keyword, .hljs-literal, .hljs-name, .hljs-selector-tag,
  .hljs-built_in, .hljs-type { color: var(--av-hl-keyword); }
  .hljs-string { color: var(--av-hl-string); }
  .hljs-comment, .hljs-quote { color: var(--av-hl-comment); font-style: italic; }
  .hljs-number { color: var(--av-hl-number); }

`;
