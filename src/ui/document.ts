import * as fs from 'fs';
import * as path from 'path';
import type { ThemeName } from '../core/theme_names';
import { icon } from './icons';
import * as formatting from './format_controls';
import { css as baseCss } from './css/base';
import { css as shellCss } from './css/shell';
import { css as boardCss } from './css/board';
import { css as navCss } from './css/nav';
import { css as ticketsCss } from './css/tickets';
import { css as chatCss } from './css/chat';
import { css as composerCss } from './css/composer';
import { css as authCss } from './css/auth';
import * as settings from './css/settings';
import { css as bottomHubCss } from './css/bottom_hub';
import { css as editorCss } from './css/editor';
import { css as wfcanvasCss } from './css/wfcanvas';
import { css as drawerCss } from './css/workflow_overview_drawer';
import { css as bottomDrawerCss } from './css/bottom_drawer';
import { css as workflowsModeCss } from './css/workflows_mode';
import { css as lightboxCss } from './css/lightbox';
import { css as mascotCss } from './css/mascot';
import { css as cafeCss } from './css/cafe';
import { css as watermarkCss } from './css/watermark';
import { css as proseCss } from './css/prose';

/**
 * The panel's document: markup, stylesheet assembly, and the inlined script.
 * Kept apart from `panel.ts` so that file is behaviour only.
 *
 * CSS is split by surface under `ui/css/` so board/chat/tickets paint can
 * change without fighting one 2k-line sheet. **Concatenation order is the
 * cascade and is load-bearing** — do not reorder `panelStylesheet()` without
 * checking specificity. Each part is a contiguous slice of the original sheet.
 */

const ICONS: WebviewIcons = {
  terminal: icon('terminal'),
  flame: icon('flame'),
  stop: icon('stop'),
  interrupt: icon('square', 12),
  plus: icon('plus', 14),
  clock: icon('clock', 13),
  link: icon('link'),
  refresh: icon('refresh', 14),
  arrowLeftToLine: icon('arrowLeftToLine', 14),
  keyRound: icon('keyRound', 14),
  settings: icon('settings', 14),
  x: icon('x'),
  // Beside a 12px TTL label. The glyph is the whole control; the tip says which
  // reading the minutes come from.
  info: icon('info', 12)
};

/**
 * The webview's script, compiled from `src/webview` and inlined rather than
 * served: the CSP admits scripts by nonce only, and an inline one needs no
 * `localResourceRoots` and no extension uri threaded down to here.
 *
 * Two paths, because this file runs from two trees: tsc emits it to `out/ui/`
 * for the tests, with the bundle a sibling directory over at `out/webview/`;
 * esbuild folds it into `dist/extension.js`, whose `__dirname` is `dist/`
 * itself, with the bundle in a child directory. First hit wins.
 *
 * A missing bundle means the build never ran esbuild. Say so in the panel —
 * a webview that silently does nothing looks like a broken extension.
 */
function webviewScript(): string {
  const candidates = [
    path.join(__dirname, '..', 'webview', 'main.js'),
    path.join(__dirname, 'webview', 'main.js')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return `document.getElementById('cards').textContent =
      'The webview script is missing — run npm run compile.';`;
}

/**
 * Full stylesheet in cascade order. Also what design-token lift scripts
 * should treat as the shipped sheet (`docs/design_tokens/lib/lift.mjs`).
 */
export function panelStylesheet(): string {
  return [
    baseCss,
    shellCss,
    watermarkCss,
    // A component, not a surface: ahead of every surface that mounts it, so a
    // host's own rule wins a tie.
    proseCss,
    boardCss,
    navCss,
    ticketsCss,
    chatCss,
    composerCss,
    // Straight after the composer, because that is where the other two
    // scrim-plus-sheet pairs are declared (#pscrim/#picker, #rscrim/#runsheet)
    // and the auth sheet is the third of them.
    authCss,
    settings.css,
    bottomHubCss,
    editorCss,
    // After the editor, whose surface it will eventually replace: both draw
    // over #board's cards, and this one's rules are all #wfcanvas-scoped so the
    // order between them does not matter.
    wfcanvasCss,
    drawerCss,
    // After the bar's own sheet and the drawer: it layers above both.
    bottomDrawerCss,
    // Row rules stay ahead of the chick and the lightbox.
    workflowsModeCss,
    // The chick perches on the sheet, so it follows it here as on the ladder.
    mascotCss,
    // Above the bottom drawer in the cascade as well as on the ladder. The cup
    // stays last because nothing below it needs to override anything it sets.
    lightboxCss,
    cafeCss
  ].join('\n');
}

/**
 * `version` is the extension's own, and rides the document rather than the
 * state push: it cannot change while a panel is open, so a field on every
 * push would be the same string re-sent every three seconds. The settings
 * menu reads it back off the body. Absent, it is the empty string and the menu
 * shows no version line — which is what the CSS-only tests pass.
 *
 * `media` is where the onboarding screenshots are served from — the host's
 * `asWebviewUri` of `media/onboarding` and the `cspSource` that admits it.
 * Absent, the CSP admits `data:` images only and the slides draw no picture.
 */
export function panelDocument(
  version = '',
  media?: { base: string; cspSource: string },
  theme: ThemeName = 'follow'
): string {
  const nonce = Math.random().toString(36).slice(2);
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; img-src data:${media ? ' ' + media.cspSource : ''};
               script-src 'nonce-${nonce}';">
<style>
${panelStylesheet()}
</style>
</head>
<body data-version="${version}"${media ? ` data-media="${media.base}"` : ''}${theme === 'follow' ? '' : ` data-theme="${theme}"`}>
<div id="board">
  <div id="nav" hidden></div>
  <!-- One filter head over one body; each view puts a child in both, and
       only the picked view's pair is shown (webview/board_nav.ts). -->
  <div id="board-head">
    <div id="sessions-head"></div>
    <div id="tk-head" hidden>
      <div id="tk-source"></div>
      <div id="tk-filter"></div>
      <div id="tk-actions"></div>
    </div>
  </div>
  <div id="board-body">
    <div id="cards" class="empty" aria-busy="true">Loading sessions…</div>
    <div id="tk-list" hidden></div>
    <!-- The waiting bar: floated over the content, not a row of it. Why, and
         what its z-index has to clear, is at the #alert rule in
         css/tickets.ts. -->
    <div id="alert" hidden></div>
  </div>
  <div id="wfeditor" hidden></div>
  <!-- The lane canvas. The editor moves this node into itself while it is
       open and puts it back here on close. The fixture message mounts it in
       place; nothing in the palette posts that message. -->
  <div id="wfcanvas" hidden></div>
  <div id="scrim" hidden></div>
  <div id="ask" hidden><div id="question" tabindex="-1"></div></div>
  <div id="pscrim" hidden></div>
  <div id="picker" hidden>
    <div id="phead"><span class="ttl">Resume a conversation</span><span class="cw"></span></div>
    <input id="pfilter" type="text" placeholder="Filter by what it was about…">
    <div id="plist"></div>
    <div id="pfoot"><span><b>&#8629;</b> resume</span><span><b>&#8593;&#8595;</b> pick</span><span><b>Esc</b> cancel</span></div>
  </div>
  <div id="rscrim" hidden></div>
  <!-- tabindex="-1" so the sheet can hold focus itself. Escape and Enter are
       listened for on it, and it has states with no focusable node in them at
       all — the wait for the bind tests is one — where a reader who could not
       focus the sheet could not press Escape either. -->
  <div id="runsheet" tabindex="-1" hidden>
    <div id="rhead"><span class="ttl"></span><span class="cw"></span></div>
    <div id="rbody"></div>
  </div>
  <!-- The bottom drawer and its own backdrop. Never #scrim, which belongs to
       question.ts down to the click that dismisses it; #bottomdrawer-scrim names itself
       after #pscrim / #rscrim, which made the same refusal. Last in #board so
       document order agrees with the ladder in css/bottom_drawer.ts. -->
  <div id="bottomdrawer-scrim" hidden></div>
  <div id="bottomdrawer" hidden>
    <div class="pull"></div>
    <div id="bottomdrawer-head"><span class="ttl">Workflows</span><button class="x" id="bottomdrawer-close" aria-label="Close" data-tip="Close">&#10005;</button><div id="bottomdrawer-note" class="wnote" hidden></div></div>
    <div id="bottomdrawer-find" hidden><input id="bottomdrawer-filter" type="text" placeholder="Filter workflows…" hidden></div>
    <!-- Two columns, both always drawn: the list, and the steps of whichever
         row is selected. The detail column holds a hint when none is, rather
         than appearing and disappearing — a column that came and went would
         move the list under the pointer, which is the reflow the steps left
         the list to avoid. -->
    <div id="bottomdrawer-body"><div class="bdlist"></div><div class="bddetail"></div></div>
    <div id="bottomdrawer-foot"></div>
  </div>
  <div id="lscrim" hidden></div>
  <!-- The image sits in a box of its own, and #lightbox is the region around it.
       That split is what makes a click outside the image mean close: the frame
       covers #lscrim completely (27 over 26), so the backdrop it looks like it
       has is never the thing a pointer reaches. -->
  <div id="lightbox" tabindex="-1" hidden>
    <div class="lmodal">
      <button class="close" aria-label="Close image" data-tip="Close image">&#10005;</button>
      <img alt="">
      <div class="caption"></div>
    </div>
  </div>
</div>
<dialog id="settings" class="asheet wide" aria-labelledby="settings-title"></dialog>
<dialog id="onboarding" class="asheet wide" aria-label="Welcome to Squadron"></dialog>
<div id="divider"></div>
<div id="dock">
  <div id="chat">
    <div id="chat-head">
      <!-- Two nodes, one slot: the name as drawn, and the box it becomes while
           being typed. An input that is always there would have to be written
           on every poll and skipped while focused; swapping means the poll
           writes the span it can see and leaves the box alone. -->
      <span class="name"></span>
      <input id="chat-rename" class="name" hidden maxlength="120" aria-label="Session name">
      <span class="since"></span>
      <span class="pill"></span>
      <!-- data-tip and aria-label, never title: these three are the same acts the
           card offers, drawn by kit.ts's iconEl, and a title here would pop the
           host's tooltip two inches from the panel's own. The label is on both
           attributes because a glyph-only button has no other accessible name
           (taskhub H23). -->
      <button class="icon" id="chat-link" data-tip="Copy a reference to this session" aria-label="Copy a reference to this session">${icon('link')}</button>
      <button class="icon" id="chat-interrupt" data-tip="Interrupt turn" aria-label="Interrupt turn">${icon('square', 12)}</button>
      <button class="icon" id="chat-stop" data-tip="End session" aria-label="End session">${icon('stop')}</button>
      <button class="icon" id="chat-dismiss" data-tip="Close chat" aria-label="Close chat">${icon('x')}</button>
    </div>
    <div id="chat-needs"></div>
    <div id="prompt-bar" hidden>
      <span class="tag"></span>
      <span class="txt"></span>
      <span class="count"></span>
      <button class="nav up" data-tip="Previous message" aria-label="Previous message">&#8593;</button>
      <button class="nav dn" data-tip="Next message" aria-label="Next message">&#8595;</button>
    </div>
    <!-- threadwrap owns the drawer's absolute box: right:100% is the dock's
         left edge, top/bottom track the thread so head + composer stay free
         (placement E — outward over the board). -->
    <div id="threadwrap">
      <!-- VS Code restores the last focused element before native Copy. Let a
           message selection hold focus instead of returning to the composer. -->
      <div id="thread" tabindex="-1"></div>
      <div id="chat-startup" hidden><div class="start-note"></div></div>
      <div id="workflowoverviewdrawer" hidden></div>
    </div>
    <div id="composer">
      <button id="qlaunch" hidden></button>
      <div id="blocked"></div>
      <!-- One box, not three stacked ones: the attachments, the text and the row
           that sends it share a border, the way the host's own chat composer
           does — .chat-input-container in the workbench stylesheet. The launcher
           and the refusal line stay outside it, neither being part of the
           message being written, and so does the read-only door, which replaces
           the box rather than sitting in it.

           This is also what settles the objection this markup used to carry:
           nesting the send button in the box was rejected for costing a
           right-hand gutter on every line of text. The host does not nest it
           over the text; it puts it on a row under the text, inside the same
           border, so the gutter never arises. docs/mockups/composer-shell.html
           is the comp, with the host's own rule quoted beside each of ours. -->
      <div class="shell">
        <!-- Formatting for the selection (webview/formatbar.ts), grouped as
             docs/mockups/composer-formatting.html draws it: marks, blocks,
             code. One tab stop; the arrows walk it. -->
        <div id="formatbar" class="formatbar" role="toolbar" aria-label="Text formatting">${formatting.formatControls()}</div>
        <!-- Workflow slot: exclusive Attach | armed chip | live observe (.wflow). -->
        <div id="wattach"></div>
        <!-- The hint is outside the editor so formatting never applies to it.
             The box's emptiness gates its following sibling. -->
        <div class="inputwrap">
          <div id="input" class="empty" placeholder="Message this session…"></div>
          <div class="hintghost" aria-hidden="true">
            <span class="hintlabel">Message this session…</span>
            <div class="hintkeys">${icon('enter', 12)}<span> send · &#8679;&#8629; newline</span></div>
          </div>
        </div>
        <!-- The controls, and the button they sit beside. What is left on this
             row is state: the instruction moved to the ghost line above, but a
             held queue is something happening to the session rather than
             something learned once, and a reader who has to click into the box
             to find it will not find it. -->
        <div id="hintrow">
          <!-- In this row and not beside the box: it is disabled with the hint
               and the send button when the selected session takes no input,
               which is the same reason those two are here.

               The cluster holds the auto margin rather than the clip, so Send
               stays pinned to the right whatever is in it — the model pill is
               webview/composer.ts's and comes and goes with the session.
               mockups/composer-shell.html §3 states the same rule about the
               hint: put the margin on something optional and the row's layout
               depends on that thing existing. -->
          <span id="ctools">
            <button class="icon" id="fattach" data-tip="Attach a file" aria-label="Attach a file">${icon('paperclip', 13)}</button>
          </span>
          <!-- No sentence between the controls. The instruction went to the
               ghost line inside the box, and the two facts that stayed behind
               were both said better one row up: chat.ts's queueBlock is pinned
               to the composer divider and states the held count and when it
               drains itself, and the Escape named a key for #chat-interrupt,
               which is a visible button on the same predicate. So the row is a
               clip, the model pill and Send. -->
          <button id="send" aria-label="Send">${icon('arrowUp', 15)}</button>
        </div>
      </div>
    </div>
  </div>
</div>
<!-- The icons the script draws, handed over as data: the markup lives in
     icons.ts and the script is a separate compilation unit. -->
<script nonce="${nonce}">const ICONS = ${JSON.stringify(ICONS)};</script>
<script nonce="${nonce}">${webviewScript()}</script>
</body>
</html>`;
}
