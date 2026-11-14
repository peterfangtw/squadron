import * as formatting from './format_controls';
import { icon } from './icons';

export function composeInputMarkup(prefix = '', label = 'Message this session…'): string {
  const markup = `      <div class="shell">
        <!-- Formatting for the selection (webview/formatbar.ts), grouped as
             docs/mockups/composer-formatting.html draws it: marks, blocks,
             code. One tab stop; the arrows walk it. -->
        <div id="formatbar" class="formatbar compose-formatbar" role="toolbar" aria-label="Text formatting">${formatting.formatControls()}</div>
        <!-- Workflow slot: exclusive Attach | armed chip | live observe (.wflow). -->
        <div id="wattach" class="compose-workflow"></div>
        <!-- The hint is outside the editor so formatting never applies to it.
             The box's emptiness gates its following sibling. -->
        <div class="inputwrap">
          <div id="input" class="empty compose-editor" placeholder="Message this session…"></div>
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
        <div id="hintrow" class="compose-footer">
          <!-- In this row and not beside the box: it is disabled with the hint
               and the send button when the selected session takes no input,
               which is the same reason those two are here.

               The cluster holds the auto margin rather than the clip, so Send
               stays pinned to the right whatever is in it — the model pill is
               webview/composer.ts's and comes and goes with the session.
               mockups/composer-shell.html §3 states the same rule about the
               hint: put the margin on something optional and the row's layout
               depends on that thing existing. -->
          <span id="ctools" class="compose-tools">
            <button class="icon compose-attach" id="fattach" data-tip="Attach a file" aria-label="Attach a file" >${icon('paperclip', 13)}</button>
          </span>
          <!-- No sentence between the controls. The instruction went to the
               ghost line inside the box, and the two facts that stayed behind
               were both said better one row up: chat.ts's queueBlock is pinned
               to the composer divider and states the held count and when it
               drains itself, and the Escape named a key for #chat-interrupt,
               which is a visible button on the same predicate. So the row is a
               clip, the model pill and Send. -->
          <button id="send" aria-label="Send" class="compose-send">${icon('arrowUp', 15)}</button>
        </div>
      </div>`;
  return markup
    .replace(/id="([^"]+)"/g, (_match, id: string) => `id="${prefix}${id}"`)
    .replaceAll('Message this session…', label);
}
