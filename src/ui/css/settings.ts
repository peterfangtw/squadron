export const css = /* css */ `
  :root { --settings-top: max(16px, calc(50vh - 270px)); }
  #settings {
    margin: var(--settings-top) auto auto; padding: 0;
    width: min(800px, calc(100vw - 28px)); max-width: 800px;
    height: min(570px, calc(100vh - var(--settings-top) - 16px)); max-height: none;
    box-sizing: border-box; overflow: hidden; color: var(--av-menu-fg);
    background: var(--av-card);
  }
  #settings[open] { display: flex; flex-direction: column; }
  #settings::backdrop { background: rgba(0, 0, 0, .5); backdrop-filter: var(--sheet-blur); }
  #settings .ashead, #cscrim .ashead, #mscrim .ashead { flex: none; padding: 16px 20px; min-height: 62px; box-sizing: border-box; }
  #settings .settings-symbol { display: grid; place-items: center; color: var(--av-muted); }
  #settings .settings-close {
    display: grid; place-items: center; width: 28px; height: 28px; padding: 6px;
    background: none; border: none; border-radius: 4px; color: var(--av-muted); cursor: pointer;
  }
  #settings .settings-close:hover { background: var(--av-hover); color: var(--av-fg); }
  #settings :is(button, summary):focus-visible { outline: 2px solid var(--av-focus); outline-offset: 2px; }
  #settings .settings-layout { display: flex; flex: 1; min-height: 0; }
  #settings .settings-tabs {
    width: 174px; flex: none; box-sizing: border-box; display: flex; flex-direction: column; overflow-y: auto;
    padding: 20px 12px 16px; gap: 5px; border-right: 1px solid var(--av-menu-border);
  }
  #settings .settings-tab {
    display: flex; align-items: center; gap: 10px; text-align: left; min-height: 37px;
    padding: 9px 12px; border: 1px solid transparent; border-radius: 5px;
    background: none; color: var(--av-muted); font: inherit; font-size: var(--av-fs-md); cursor: pointer;
  }
  #settings .settings-tab > span:first-child { display: grid; place-items: center; flex: none; }
  #settings .settings-tab:hover { background: var(--av-hover); color: var(--av-fg); }
  #settings .settings-tab[aria-selected="true"] {
    background: color-mix(in srgb, var(--av-focus) 12%, var(--av-card));
    border-color: color-mix(in srgb, var(--av-focus) 24%, transparent); color: var(--av-fg); font-weight: 600;
  }
  #settings .settings-tab[aria-selected="true"] svg { color: var(--av-focus); }
  /* Report, Changelog and About pin under the categories. */
  #settings .settings-tab:nth-last-child(3) { margin-top: auto; }
  #settings .settings-page {
    flex: 1; min-width: 0; box-sizing: border-box; padding: 28px 30px;
    overflow-y: auto; scrollbar-gutter: stable; font-size: var(--av-fs-md); line-height: 1.5;
  }
  #settings .settings-page[hidden] { display: none; }
  #settings :is(h1, h2) { margin: 0; font-size: var(--av-fs-lg); font-weight: 600; line-height: 1.4; text-transform: none; letter-spacing: normal; color: var(--av-fg); }
  #settings p { margin: 0; }
  #settings .settings-intro { margin: 5px 0 28px; color: var(--av-muted); }
  #settings .settings-detail { margin: 6px 0 12px; color: var(--av-muted); }
  #settings .mrow { padding: 20px 0; gap: 26px; border-radius: 0; border-bottom: 1px solid var(--av-menu-border); align-items: flex-start; }
  #settings .mrow .t { font-size: var(--av-fs-lg); font-weight: 500; }
  #settings .mrow .d { margin-top: 6px; color: var(--av-muted); font-size: var(--av-fs-md); line-height: 1.5; }
  #settings .mrow:hover { background: none; }
  #settings .mrow .tag { font-size: var(--av-fs-md); color: var(--av-muted); }
  #settings .mrow:last-child { border-bottom: none; }
  #settings .sw { margin-top: 2px; }
  #settings .dual-config {
    display: flex; margin: 16px 0 12px; border: 1px solid var(--av-input-border);
    border-radius: 6px; background: var(--av-input-bg);
  }
  #settings .dual-config .mwrap { flex: 2; min-width: 0; }
  #settings .dual-config .mwrap + .mwrap { flex: 1; border-left: 1px solid var(--av-input-border); }
  #settings .dual-config .mrow { flex-direction: column; border: none; padding: 10px 12px; gap: 6px; }
  #settings .dual-config .mrow .t { color: var(--av-muted); font-size: var(--av-fs-md); }
  #settings .dual-config .mrow .d { display: none; }
  #settings .dual-config .val { width: 100%; justify-content: space-between; color: var(--av-input-fg); }
  #settings .mrow .val .into { border: 3.5px solid transparent; border-top-color: currentColor; border-bottom: none; }
  #settings .settings-note { margin-top: 24px; padding: 14px 16px; border-radius: 5px; background: var(--av-bg); color: var(--av-muted); }
  #settings .swatches { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; padding: 0; margin-top: 20px; }
  #settings .theme-band { margin: 18px 0 0; padding: 0; font-size: var(--av-fs-sm); font-weight: 400; line-height: 1.4; letter-spacing: .08em; text-transform: uppercase; color: var(--av-fg-3); }
  #settings .theme-groups .swatches { margin-top: 8px; }
  #settings .theme-groups > .swatches:first-child { margin-top: 16px; }
  #settings .sws { width: 100%; }
  #settings .sws .hue { height: 42px; }
  #settings .sws .cap { padding: 7px 2px; font-size: var(--av-fs-md); color: var(--av-muted); }
  #settings .asfoot { flex: none; justify-content: space-between; min-height: 42px; box-sizing: border-box; padding: 10px 20px; color: var(--av-muted); font-size: var(--av-fs-md); }
  #settings .asfoot span:last-child { font-variant-numeric: tabular-nums; }
  #settings-accounts .settings-intro { margin-bottom: 0; }
  #settings .account-help { padding: 10px 0 16px; color: var(--av-muted); line-height: 1.5; }
  #settings .settings-accounts { border-top: 1px solid var(--av-menu-border); }
  #settings .acct { grid-template-columns: 26px minmax(0, 1fr) minmax(0, 220px) auto; gap: 4px 16px; padding: 14px 0; align-items: start; border-bottom: 1px solid var(--av-menu-border); border-radius: 0; }
  #settings .acct:hover { background: none; }
  #settings .acct .bmwrap, #settings .acct .bm { width: 26px; height: 26px; }
  #settings .acct .em { font-size: var(--av-fs-lg); font-weight: 500; }
  #settings .acct .pl { font-size: var(--av-fs-md); margin-top: 2px; color: var(--av-muted); }
  #settings .account-usage { grid-column: 3; grid-row: 1; display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
  #settings .acct :is(.act, .acts) { grid-column: 4; }
  #settings .acct .plan { font-size: var(--av-fs-md); height: auto; padding: 2px 5px; color: var(--av-fg); }
  #settings .acct .act { min-height: 32px; padding: 5px 10px; border: 1px solid var(--av-menu-border); color: var(--av-fg); }
  #settings .acct .act.in { background: var(--av-btn-bg); color: var(--av-btn-fg); border-color: transparent; }
  #settings .acct .act.path { background: none; color: var(--av-muted); border-color: var(--av-menu-border); }
  #settings .acct .acts { gap: 6px; }
  #settings .account-state { display: flex; align-items: center; gap: 6px; color: var(--av-muted); margin-top: 2px; font-size: var(--av-fs-md); }
  #settings .account-state::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--av-muted); }
  #settings .settings-tour { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  #settings .settings-report { display: flex; align-items: center; gap: 8px; }
  #settings :is(.settings-tab, .settings-report .b).survey-pending { position: relative; }
  #settings :is(.settings-tab, .settings-report .b).survey-pending::after {
    content: ''; position: absolute; top: 2px; right: 2px;
    width: 6px; height: 6px; border-radius: 50%; background: var(--av-red); pointer-events: none;
  }
  #settings .settings-tour .settings-detail { margin: 0; }
  #settings .settings-links { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--av-menu-border); }
  #settings .settings-link { display: flex; align-items: center; gap: 8px; width: fit-content; min-height: 28px; padding: 0; color: var(--av-link); background: none; border: none; font: inherit; cursor: pointer; }
  #settings .settings-link:hover { text-decoration: underline; text-underline-offset: 3px; }
  #settings .settings-link > span:last-child { display: grid; place-items: center; }
  #settings .release { padding: 16px 0; border-top: 1px solid var(--av-menu-border); }
  #settings .release summary { display: flex; align-items: center; gap: 10px; min-height: 28px; cursor: pointer; font-size: var(--av-fs-lg); font-weight: 500; list-style: none; }
  #settings .release summary::-webkit-details-marker { display: none; }
  #settings .release summary::after { content: ''; width: 6px; height: 6px; border: solid var(--av-muted); border-width: 0 1px 1px 0; transform: rotate(-45deg); margin-left: auto; margin-right: 4px; }
  #settings .release[open] summary::after { transform: rotate(45deg); }
  #settings .current-release { color: var(--av-muted); font-size: var(--av-fs-md); font-weight: 400; }
  #settings .release-notes { color: var(--av-muted); line-height: 1.65; padding-top: 8px; }
  #settings .release-notes ul { margin: 0; padding-left: 18px; }
  #settings .release-notes li + li { margin-top: 10px; }
  #settings .release-notes p { margin-top: 12px; }
  @media (max-width: 580px) {
    #settings { height: calc(100vh - var(--settings-top) - 16px); }
    #settings .settings-layout { flex-direction: column; }
    #settings .settings-tabs { width: 100%; flex-direction: row; overflow-x: auto; padding: 8px 12px; border-right: none; border-bottom: 1px solid var(--av-menu-border); }
    #settings .settings-tab { flex: none; padding: 6px 10px; gap: 7px; min-height: 34px; }
    #settings .settings-tab:nth-last-child(3) { margin-top: 0; }
    #settings .settings-page { padding: 22px 20px; }
    #settings .mrow .t { font-size: var(--av-fs-md); }
    #settings .swatches { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    #settings .acct { grid-template-columns: 26px minmax(0, 1fr); gap: 6px 10px; padding: 20px 0; }
    #settings .acct .account-usage, #settings .acct .act, #settings .acct .acts { grid-column: 2; grid-row: auto; justify-self: start; }
    #settings .acct .account-usage { width: min(100%, 220px); padding-top: 0; }
  }
`;
