/**
 * The auth sheets — login, sign-out, and the MCP matrix — and the dock's
 * signed-out CTA.
 *
 * These lived in `css/nav.ts` until this file existed, because the control that
 * opens them (`button.lim`) is on the nav bar. That is where the *trigger* is,
 * not where the surface is: `TASK_done_popover_placement.md` puts `#ascrim` in
 * the same row as `resume`, `runpicker` and `bottom_drawer` — "Sheets. Not popovers."
 * Every other sheet on the board has a file or a section of its own, and a
 * hundred lines of sheet chrome sitting in the nav bar's stylesheet made this
 * file's position in the cascade load-bearing for a surface it did not name.
 * The accounts *popover* (`.smenu.accts`, `.acct`) stays in `nav.ts`, because
 * that one really is a menu hanging off a bar control.
 *
 * Joined straight after `css/composer.ts`, which is where the other two
 * scrim-plus-sheet pairs live (`#pscrim`/`#picker`, `#rscrim`/`#runsheet`) —
 * same rung, same neighbourhood, so the three read together.
 */

export const css = /* css */ `
  /* Auth sheets (login / sign-out) over the board.

     z-index 32 puts this on the rung the other two sheet backdrops already
     share, and it was 12. Twelve was under the café (20, css/cafe.ts) and under
     a portalled .fmenu (25, css/bottom_drawer.ts), so the coffee cup drew over the
     login sheet and stayed draggable across it; and it *tied* #bottomhub (12,
     css/bottom_hub.ts), which resolved by document order alone — #ascrim is created
     lazily on first login, so it happened to land later and happened to win.
     css/bottom_drawer.ts says in bold that a backdrop is not a thing to rest on
     document order.

     32 rather than 22: this sheet is a question being asked — paste this code,
     confirm this sign-out — which is the distinction css/bottom_drawer.ts draws when
     it explains why #picker and #runsheet sit above the ask layer and the
     bottom drawer sits below it. Three backdrops now share 32, and that is the
     pattern #pscrim and #rscrim already set: only one of them is ever up.

     The sheet is a child of the scrim rather than its sibling, so it needs no
     second rung of its own — unlike #picker and #runsheet, which are siblings
     of theirs and carry 33.

     #gscrim is Remote's guide (webview/remote_sheet.ts). It opens from the
     bottom drawer (23) and sits over it on this rung, so the drawer it came
     from stays drawn behind it. */
  .sheet-scrim {
    position: absolute; inset: 0; z-index: 32;
    background: #00000059; display: flex; align-items: flex-start; justify-content: center;
    padding: 28px 16px;
  }
  .sheet-scrim[data-scope="panel"] { background: transparent; }
  /* On a pseudo-element: backdrop-filter on the scrim would make it the
     containing block for any fixed element inside its sheet. */
  .sheet-scrim::before { content: ''; position: absolute; inset: 0; z-index: -1;
    pointer-events: none; backdrop-filter: var(--sheet-blur); }
  .sheet-scrim[data-scope="panel"]::before { position: fixed; background: #00000059; }
  .sheet-scrim[hidden] { display: none; }
  .sheet-scrim[data-position="panel"] { position: fixed; }
  .asheet {
    width: 100%; max-width: 360px; background: var(--av-menu-bg);
    border: 1px solid var(--av-menu-border); border-radius: 7px;
    box-shadow: 0 10px 34px #000b; overflow: hidden;
  }
  .asheet.wide { max-width: 520px; }
  .ashead {
    display: flex; align-items: center; gap: 9px; padding: 11px 13px 9px;
    border-bottom: 1px solid var(--av-menu-border);
  }
  .ashead b { font-size: var(--av-fs-lg); font-weight: 600; flex: 1; }
  .ashead .bmwrap { width: 19px; height: 19px; }
  .ashead .bmwrap svg { width: 19px; height: 19px; display: block; }
  .asbody { padding: 13px; }
  .asfoot {
    display: flex; gap: 7px; align-items: center; justify-content: flex-end;
    padding: 10px 13px; border-top: 1px solid var(--av-menu-border);
  }
  .asfoot:empty, .asfoot[hidden] { display: none; }
  #cscrim, #mscrim { padding: var(--settings-top) 16px 16px; }
  #cscrim .asheet, #mscrim .asheet {
    box-sizing: border-box; max-height: 100%; display: flex; flex-direction: column; color: var(--av-menu-fg);
  }
  #mscrim .ashead { flex: none; }
  #mscrim .asbody { min-height: 0; }
  #cscrim .ashead, #cscrim .asfoot, #cscrim .ax { flex-shrink: 0; }
  #cscrim .ashead b { overflow-wrap: anywhere; }
  #cscrim .asbody { overflow-y: auto; white-space: pre-line; overflow-wrap: anywhere; line-height: 1.5; }
  #cscrim .asfoot { flex-wrap: wrap; }
  #cscrim button:focus-visible { outline: 2px solid var(--av-focus); outline-offset: 2px; }
  /* Onboarding (webview/onboarding.ts; design: docs/mockups/onboarding.html).
     520px, the wide sheet's width, so a screenshot is worth showing. Every
     size below is a --av-fs-* step. */
  /* Top-anchored, not the modal's own centring: the pages differ by ~180px, and
     centred, the header jumped on every Next. Anchored where the tallest page
     would centre — slide 2 with its skill row, 537px measured headless. */
  #onboarding {
    --ob-top: max(16px, calc(50vh - 270px));
    margin: var(--ob-top) auto auto;
    box-sizing: border-box; width: min(520px, calc(100vw - 28px));
    max-height: calc(100vh - var(--ob-top) - 16px); overflow-y: auto;
    padding: 0; color: var(--av-menu-fg);
  }
  #onboarding::backdrop { background: rgba(0, 0, 0, .5); backdrop-filter: var(--sheet-blur); }
  #onboarding .asbody { line-height: 1.45; }
  #onboarding .asbody p { margin: 0 0 10px; }
  #onboarding .obstep {
    font-size: var(--av-fs-sm); color: var(--av-fg-3);
    text-transform: uppercase; letter-spacing: .06em;
  }
  #onboarding .oblist {
    border: 1px solid var(--av-menu-border); border-radius: 6px; padding: 2px; margin: 12px 0 8px;
  }
  #onboarding .oblist .acct + .acct { border-top: 1px solid var(--av-menu-border); border-radius: 0; }
  #onboarding .acct .act.ready,
  #onboarding .acct .act.ready:hover {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--av-green); background: none; cursor: default;
  }
  #onboarding .acct .act.ready::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--av-green);
  }
  /* The skill row shares the switch's box and type, and is read, not pressed.
     Installed is a tick in the switch's on-colour, input.check's shape; the other
     two stay in the muted ink so a missing skill never outshouts a present one. */
  #onboarding .obskill { cursor: default; border-top: 1px solid var(--av-menu-border); border-radius: 0; }
  #onboarding .obskill:hover { background: none; }
  #onboarding .skmarks { display: flex; gap: 12px; flex: none; font-size: var(--av-fs-sm); }
  #onboarding .sk { display: inline-flex; align-items: center; gap: 5px; }
  #onboarding .sk::before { content: ''; box-sizing: border-box; flex: none; }
  #onboarding .sk.installed::before {
    width: 9px; height: 5px; margin: -3px 1px 0;
    border: solid var(--av-focus); border-width: 0 0 2px 2px; transform: rotate(-45deg);
  }
  #onboarding .sk.missing, #onboarding .sk.foreign { color: var(--av-fg-3); }
  #onboarding .sk.missing::before { width: 9px; height: 9px; border: 1.5px solid var(--av-fg-3); border-radius: 50%; }
  #onboarding .sk.foreign::before { width: 9px; border-top: 1.5px solid var(--av-fg-3); }
  #onboarding .obleft { margin-right: auto; }
  #onboarding .obshot { margin: 0; border-bottom: 1px solid var(--av-menu-border); background: var(--av-bg); }
  #onboarding .obshot img { display: block; width: 100%; aspect-ratio: 2080 / 1137; }
  #onboarding .obdots { display: flex; gap: 5px; }
  #onboarding .obdots i { width: 6px; height: 6px; border-radius: 50%; background: var(--av-fg-3); opacity: .45; }
  #onboarding .obdots i.on { background: var(--av-blue); opacity: 1; }
  /* md, not sm: sm is the overline step, and this is a sentence someone has to
     read before ticking it. */
  #onboarding .setup-check {
    display: flex; align-items: flex-start; gap: 8px; padding: 8px 0;
    cursor: pointer; font-size: var(--av-fs-md);
  }
  #onboarding .b:disabled { opacity: .45; cursor: default; }

  /* The checkbox. A native one is the OS's to draw and the theme cannot reach
     inside it — the reason css/tickets.ts gives for the switch. Still a real
     <input> under appearance: none, so keyboard, label click and :checked are
     the browser's. Not .cbox: that is the menus' span checkbox. The border is
     the accent even when off — in input chrome the box all but vanished on the
     dark presets. The tick is --av-on-blue, not the switch knob's --av-btn-fg:
     neon's --av-btn-fg on its --av-focus is mint on mint, and a 1.5px stroke
     needs the contrast a filled disc does not. */
  input.check {
    appearance: none; flex: none; width: 14px; height: 14px; margin: 1px 0 0;
    display: grid; place-items: center; cursor: pointer;
    border: 1px solid var(--av-focus); border-radius: 3px;
    background: var(--av-input-bg); transition: background .12s, border-color .12s;
  }
  input.check::after {
    content: ''; width: 7px; height: 3.5px; margin-top: -2px;
    border: solid var(--av-on-blue); border-width: 0 0 1.5px 1.5px;
    transform: rotate(-45deg) scale(.4); opacity: 0; transition: transform .12s, opacity .12s;
  }
  input.check:checked { background: var(--av-focus); }
  input.check:checked::after { opacity: 1; transform: rotate(-45deg) scale(1); }
  label:hover > input.check:not(:checked):not(:disabled) {
    background: color-mix(in srgb, var(--av-focus) 18%, var(--av-input-bg));
  }
  input.check:focus-visible { outline: 1px solid var(--av-focus); outline-offset: 2px; }
  input.check:disabled { opacity: .45; cursor: default; border-color: var(--av-input-border); }
  .asheet.wide .asbody { padding: 10px 11px 12px; max-height: min(70vh, 520px); overflow: auto; }
  .ashint { font-size: var(--av-fs-sm); color: var(--av-fg-3); padding: 0 2px 8px; line-height: 1.45; }
  /* Remote's guide: the steps at the body's size, then what an app made by
     hand must be set to, as label and value. Copy and the create page sit
     left in the foot, Done right. */
  #gscrim .asbody { font-size: var(--av-fs-md); line-height: 1.5; }
  #gscrim ol { margin: 0; padding-left: 20px; }
  #gscrim ol li + li { margin-top: 8px; }
  #gscrim .ashint { padding: 14px 2px 6px; text-transform: uppercase; letter-spacing: .08em; }
  #gscrim dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 14px; margin: 0; }
  #gscrim dt { color: var(--av-fg-3); }
  #gscrim dd { margin: 0; align-self: center; overflow-wrap: anywhere;
               font-family: var(--vscode-editor-font-family, monospace); font-size: var(--av-fs-sm); }
  #gscrim .asfoot { justify-content: space-between; }
  #gscrim .asfoot .grp { display: flex; gap: 7px; }
  #mscrim .mchead, #mscrim .srow {
    display: grid;
    grid-template-columns: minmax(155px, 1.6fr) repeat(var(--mcp-brands, 3), minmax(82px, 1fr));
  }
  #mscrim .mchead {
    min-height: 28px; align-items: center; color: var(--av-fg-3);
    border-bottom: 1px solid var(--av-menu-border);
  }
  #mscrim .mcsrv {
    padding-left: 5px; font-size: 9.5px; text-transform: uppercase; letter-spacing: .07em;
  }
  #mscrim .mcbrand {
    min-width: 0; display: flex; align-items: center; justify-content: center; gap: 5px;
    font-size: var(--av-fs-sm);
  }
  #mscrim .mcbrand .bmwrap, #mscrim .mcbrand .bmwrap svg {
    width: 14px; height: 14px; display: block;
  }
  #mscrim .srow { min-height: 49px; border-bottom: 1px solid #ffffff0a; }
  #mscrim .srow:last-child { border-bottom: none; }
  #mscrim .sidentity {
    min-width: 0; display: flex; align-items: center; gap: 7px; padding: 6px 5px;
  }
  #mscrim .srow .mark {
    width: 18px; height: 18px; display: grid; place-items: center; flex: none;
  }
  #mscrim .srow .mark svg, #mscrim .srow .mcpmark, #mscrim .srow .mcpmark svg {
    width: 18px; height: 18px; display: block;
  }
  #mscrim .smeta { min-width: 0; }
  #mscrim .srow .who {
    font-size: var(--av-fs-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #mscrim .srow .host {
    font-size: var(--av-fs-sm); color: var(--av-fg-3); margin-top: 1px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* The sheet cut into repo sections (mockups/mcp-by-repo.html, direction A).

     A section head is a button, so it is one tab stop — and it sets its own
     26px floor, because the 24px one .bcell .ba carries is scoped under
     .bcell and does not reach up here. */
  .racc { display: flex; flex-direction: column; }
  .rsec + .rsec { border-top: 1px solid var(--av-menu-border); margin-top: 4px; padding-top: 4px; }
  .rhead {
    display: flex; align-items: center; gap: 7px; width: 100%; font: inherit;
    background: none; border: none; cursor: pointer; color: var(--av-fg);
    padding: 4px 6px; border-radius: 6px; min-height: 30px; text-align: left;
  }
  .rhead:hover:not(:disabled) { background: var(--av-hover); }
  /* Pinned open by a login in flight — the Cancel button under it has to stay
     reachable, so the head says it cannot act rather than acting silently. */
  .rhead:disabled { cursor: default; }
  .rname {
    max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: var(--av-fs-md); font-weight: 600; letter-spacing: .01em;
  }
  /* The dot is the reason a shut section is worth shutting: it answers "is
     anything in here broken" without opening it. Colours are the board's own
     status hues, not new ones. */
  .rdot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--av-green); }
  .rdot.needs { background: var(--av-orange); }
  .rdot.none { background: var(--av-fg-3); opacity: .45; }
  .rcount { margin-left: auto; font-size: var(--av-fs-sm); color: var(--av-fg-3); }
  .rchev { color: var(--av-fg-3); font-size: 13px; }
  @media (prefers-reduced-motion: no-preference) {
    .rchev { transition: transform .12s ease-out; }
    .bcell.busy .bs::before { animation: mcp-spin .8s linear infinite; }
  }
  @keyframes mcp-spin { to { transform: rotate(360deg); } }
  .rsec.open .rchev { transform: rotate(90deg); }
  .rpath {
    min-width: 0; font-size: var(--av-fs-sm); color: var(--av-fg-3);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rbody { display: none; }
  .rsec.open .rbody { display: block; }
  .rempty {
    font-size: var(--av-fs-sm); color: var(--av-fg-3);
    padding: 6px 6px 10px 20px; line-height: 1.5;
  }

  /* Scope rides on the host line, which is where the row already spends its
     small type. A chip rather than a word: two values, always the same two,
     so shape is faster to read than prose. */
  .scope {
    display: inline-block; margin-left: 6px; font-size: 9.5px; line-height: 1.5;
    text-transform: uppercase; letter-spacing: .06em; padding: 0 4px;
    border-radius: 3px; vertical-align: 1px;
    background: #ffffff10; color: var(--av-fg-3);
  }
  /* Only project earns a colour: it is the one that is tracked in git, so it is
     the one where adding a server changes what everyone who clones gets. */
  .scope.project { background: #4c8dff1f; color: #8fb6ff; }
  .shrd {
    margin-left: 6px; font-size: 9.5px; color: var(--av-fg-3);
    border-bottom: 1px dotted var(--av-menu-border); cursor: help;
  }

  .bcell {
    min-width: 0; min-height: 48px; padding: 5px 4px;
    border-left: 1px solid #ffffff0a; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 2px;
  }
  .mcpfailure { color: var(--av-red); }
  .bcell.needs { background: #e5a54b0d; }
  .bcell.busy { background: #4c8dff0d; }
  .bcell.error, .bcell.broken { background: #f0555f0a; }
  .bcell .bmwrap, .bcell .bn { display: none; }
  .bcell .bs {
    display: flex; align-items: center; gap: 5px; min-width: 0;
    font-size: var(--av-fs-sm); color: var(--av-fg-3); white-space: nowrap;
  }
  .bcell:not(.absent) .bs::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%; flex: none;
    background: var(--av-green);
  }
  .bcell.needs .bs::before { background: var(--av-orange); }
  .bcell.busy .bs::before {
    width: 8px; height: 8px; box-sizing: border-box; background: none;
    border: 1.5px solid var(--av-blue); border-right-color: transparent;
  }
  .bcell.error .bs::before, .bcell.broken .bs::before { background: var(--av-red); }
  .bcell.pending .bs::before, .bcell.unknown .bs::before { background: var(--av-fg-3); }
  .bcell.absent { color: var(--av-fg-3); opacity: .45; }
  .bcell .ba {
    min-height: 24px; min-width: 24px; padding: 2px 5px; border: none; border-radius: 4px;
    background: none; color: var(--av-fg-3); cursor: pointer; font: inherit; font-size: 10px;
  }
  .bcell .ba:hover:not(:disabled) { background: var(--av-hover); color: var(--av-fg); }
  .bcell .ba:disabled { cursor: default; color: var(--av-fg-3); }
  .bcell .ba:focus-visible, .rhead:focus-visible { outline: 1px solid var(--av-focus); outline-offset: 1px; }
  .bcell .ba.fix { color: var(--av-orange); }
  .bcell .ba.fix:hover:not(:disabled) { background: #e5a54b1a; color: var(--av-orange); }
  .bcell .ba.out:hover:not(:disabled) { color: var(--av-red); }
  .bcell .ba.out.arm { color: var(--av-red); }
  .bcell .said {
    padding: 2px 5px; color: var(--av-fg-3); font-size: 10px; white-space: nowrap;
  }
  .sdetails {
    grid-column: 1 / -1; padding: 5px; border-top: 1px solid #ffffff0a;
  }
  .bdetail {
    display: grid; grid-template-columns: 14px auto minmax(0, 1fr);
    align-items: start; gap: 6px; color: var(--av-fg-3); font-size: var(--av-fs-sm);
  }
  .bdetail + .bdetail { margin-top: 4px; }
  .bdetail .bmwrap, .bdetail .bmwrap svg { width: 14px; height: 14px; display: block; }
  .bdetail .bdbrand { color: var(--av-fg-2); }
  .bdetail .bdstack { display: grid; gap: 4px; min-width: 0; }
  .bdetail .wait { color: var(--av-blue); }
  .bdetail .why { min-width: 0; line-height: 1.4; }
  .bdetail .mcpurl {
    min-width: 0; padding: 0;
  }
  .ax {
    width: 24px; height: 24px; border-radius: 4px; border: none; cursor: pointer;
    background: none; color: var(--av-fg-3); font: inherit;
  }
  .ax:hover { background: var(--av-hover); color: var(--av-fg); }
  .astep { display: flex; gap: 10px; padding: 6px 0; }
  .astep .k {
    width: 17px; height: 17px; border-radius: 50%; flex: none; font-size: 9.5px;
    display: grid; place-items: center; margin-top: 1px; background: #ffffff17;
    color: var(--av-fg-3); font-weight: 600;
  }
  .astep.now .k { background: var(--av-blue); color: #fff; }
  .astep.done .k { background: var(--av-green); color: #04210c; }
  .astep .ad { flex: 1; min-width: 0; font-size: var(--av-fs-md); }
  .aurl {
    display: flex; gap: 6px; align-items: center; background: var(--av-code-bg);
    border: 1px solid var(--av-input-border); border-radius: 5px;
    padding: 6px 6px 6px 9px; margin: 4px 0 2px;
  }
  .aurl span {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: var(--av-fg-3);
  }
  input.acode {
    width: 100%; font: inherit; font-family: ui-monospace, Menlo, monospace;
    font-size: var(--av-fs-md); padding: 7px 9px; border-radius: 5px;
    background: var(--av-input-bg); color: var(--av-input-fg);
    border: 1px solid var(--av-input-border); box-sizing: border-box; margin-top: 4px;
  }
  .ucode {
    display: flex; gap: 6px; align-items: center;
    padding: 6px 6px 6px 9px; border-radius: 5px; margin-top: 4px;
    background: var(--av-code-bg); border: 1px solid var(--av-input-border);
  }
  .ucode span {
    flex: 1; min-width: 0; font-family: ui-monospace, Menlo, monospace;
    font-size: 18px; letter-spacing: .12em; color: var(--av-fg);
  }
  .aerr { font-size: var(--av-fs-sm); color: var(--av-red); margin-top: 8px; }
  .alead { font-size: var(--av-fs-md); color: var(--av-fg-2); }
  .alead b { color: var(--av-fg); }
  .ablast { border: 1px solid var(--av-menu-border); border-radius: 5px; margin: 9px 0 2px; overflow: hidden; }
  .ablast > div { display: flex; align-items: center; gap: 8px; padding: 6px 9px; font-size: var(--av-fs-md); }
  .ablast > div + div { border-top: 1px solid var(--av-menu-border); }
  .ablast .amore { color: var(--av-fg-3); }
  .atag {
    font-size: 9px; text-transform: uppercase; letter-spacing: .04em; padding: 0 4px;
    height: 13px; border-radius: 3px; display: inline-flex; align-items: center;
    background: #ffffff17; color: var(--av-fg-3); margin-left: 6px;
  }
  .akeep {
    border: 1px dashed var(--av-menu-border); border-radius: 5px; padding: 7px 9px;
    margin-top: 9px; font-size: var(--av-fs-sm); color: var(--av-fg-3);
  }

  /* The three button ranks, and every one of them is written under its parent.
     They were \`.b.pri\`, \`.b.sec\`, \`.b.dgr\` at the top level: a one-letter
     class declared unscoped in the middle of a twelve-file cascade, which any
     later \`.b\`-anything would have taken silently. The parents below are
     the whole of where a \`.b\` is built (webview/accounts.ts — .asfoot, .aurl,
     .ucode, .login-cta; webview/settings.ts — .settings-tour, .settings-report),
     so :is() costs
     one selector and closes it. **Build a \`.b\` under another parent and name it here**, or it paints
     as a bare UA button — which is how .ucode's Copy first shipped.

     Scoping rather than renaming: the class is written in four places in
     accounts.ts, and the hazard is the *top level*, not the two letters. */
  :is(.asfoot, .aurl, .ucode, .login-cta, .settings-tour, .settings-report) .b {
    font: inherit; font-size: var(--av-fs-md); cursor: pointer; min-height: 24px;
    padding: 4px 11px; border-radius: 5px; border: 1px solid transparent;
    background: none; color: inherit;
  }
  :is(.asfoot, .aurl, .ucode, .login-cta, .settings-tour, .settings-report) .b.pri {
    background: var(--av-btn-bg); color: var(--av-btn-fg); font-weight: 500;
  }
  :is(.asfoot, .aurl, .ucode, .login-cta, .settings-tour, .settings-report) .b.sec { border-color: var(--av-input-border); }
  :is(.asfoot, .aurl, .ucode, .login-cta, .settings-tour, .settings-report) .b.sec:hover { background: var(--av-hover); }
  :is(.asfoot, .aurl, .ucode, .login-cta, .settings-tour, .settings-report) .b.dgr { border-color: #f4585b55; color: var(--av-red); }
  :is(.asfoot, .aurl, .ucode, .login-cta, .settings-tour, .settings-report) .b.dgr:hover { background: #f4585b1a; }

  /* Dock login CTA (pipe session, signed out). */
  .login-cta {
    display: flex; align-items: flex-start; gap: 10px;
    background: var(--av-input-bg); border: 1px solid var(--av-input-border);
    border-radius: 7px; padding: 11px 12px; margin: 8px 0;
  }
  .login-cta .t { flex: 1; min-width: 0; }
  .login-cta .t b { display: block; font-size: var(--av-fs-md); font-weight: 600; margin-bottom: 2px; }
  .login-cta .t span { font-size: var(--av-fs-sm); color: var(--av-fg-3); line-height: 1.4; }
  .login-cta .bmwrap { width: 19px; height: 19px; flex: none; }
  .login-cta .bmwrap svg { width: 19px; height: 19px; display: block; }
`;
