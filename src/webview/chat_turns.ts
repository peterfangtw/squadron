import * as echoCandidates from '../ui/echo_candidates';
/** Keyed turn construction, sanitized content and outbox reconciliation. */
import { sanitized } from './markdown_dom';
import { $, ago, el, q } from './dom';
import type { ChatIdentity, SendInput, SentEcho } from '../ui/chat_state';
import { chats, fetched, opened, setThreadKeys, thread, ui, vscode } from './state';
import { findCard } from './board_card';
import { openReplay, recordKey } from './question';
import { focusBox, renderMention, retryHeld, setBox } from './composer';
import { renderActive } from './chat';
import { icon, iconForFile } from '../ui/icons';
import { withoutImageMarkers } from '../core/markers';
import { refLabel } from '../core/session_ref';
import * as tokens from '../core/tokens';
import { isMidTurn } from '../core/model';
import { pipeLoginCta, signedOutFor } from './accounts';
import { openLightbox } from './lightbox';
import { findMentions } from './mention_text';
import { mentionPill, restoreTicketText } from './mention_pill';
import { proseHtml } from './prose';
import * as fileLinks from '../ui/file_link';

function body(html: string, cwd: string): HTMLElement {
  const node = el('div', 'body');
  node.append(sanitized(html, true));
  copyFences(node);
  // Skills pill on the reader's prose (`proseBody`), not on engine HTML.
  pillMentions(node, false);
  node.onclick = (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    const href = link?.getAttribute('href');
    const target = href ? fileLinks.fileLink(href, cwd) : undefined;
    if (!target) return;
    event.preventDefault();
    vscode.postMessage({ type: 'openFile', ...target });
  };
  return node;
}

/**
 * The control is a sibling of `pre`, added after the allowlist. Inside the
 * block it would scroll off with a long line, and its label would be copied
 * with the code.
 */
function copyFences(root: HTMLElement): void {
  for (const pre of root.querySelectorAll('pre')) {
    const fence = el('div', 'fence');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-live', 'polite');
    copy.onclick = (event) => {
      event.stopPropagation();
      const text = pre.textContent ?? '';
      void navigator.clipboard?.writeText(text).then(
        () => {
          copy.textContent = 'Copied';
          window.setTimeout(() => {
            if (copy.isConnected) copy.textContent = 'Copy';
          }, 1200);
        },
        () => undefined
      );
    };
    pre.replaceWith(fence);
    fence.append(copy, pre);
  }
}

/**
 * Every `@squadron[pid][path]` and model pick in a turn's prose, and in the
 * reader's own turns every skill named the way a composer pill expands, drawn
 * as pills. Code keeps them as written, since there it is quoted rather than
 * meant. An assistant naming a skill is talking about it, not loading it, so
 * that stays prose; a `(squadron-spawn --brand …)` parenthesis is never prose,
 * so a model pick is a pill whoever wrote it.
 */
function pillMentions(root: HTMLElement, mine: boolean): void {
  restoreTicketText(root);
  const skills = mine ? (chats.thread()?.skills ?? []) : [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (
      findMentions(n.textContent ?? '', skills).length &&
      !n.parentElement?.closest('code, pre')
    ) {
      found.push(n as Text);
    }
  }
  for (const node of found) {
    const text = node.textContent ?? '';
    const hits = findMentions(text, skills).filter(
      (hit) => hit.kind !== 'ticket' || !node.parentElement?.closest('a, button')
    );
    node.replaceWith(...tokens.splice(text, hits, mentionPill));
  }
}

/**
 * What a turn's pills say, for its key, so a card that arrives or renames — or
 * a skill list that lands after the turn was drawn — redraws them. JSON because
 * a card name may hold the comma a join would use.
 */
function mentionsKey(...texts: string[]): string {
  const skills = chats.thread()?.skills ?? [];
  return JSON.stringify(
    texts.flatMap((text) =>
      findMentions(text, skills).map((hit) =>
        hit.kind === 'session' ? sessionLabel(hit.pid) : hit.text
      )
    )
  );
}

export function sessionLabel(pid: number): string {
  return refLabel(pid, findCard(pid)?.card.name);
}

/** Reuse the existing turn when its key agrees, without building another node. */
export type Turn = { key: string; make: () => HTMLElement };

/**
 * Use the same parser for pending and settled reader prose, so delivery does
 * not change its appearance. A paste without words is legal: its caller draws
 * the image count instead of an empty rail.
 *
 * Do not use `body()`: file links and fence Copy belong to engine HTML.
 */
function delivery(text: string): DocumentFragment {
  const fragment = sanitized(proseHtml(text), true);
  const root = document.createElement('div');
  root.append(fragment);
  pillMentions(root, true);
  const out = document.createDocumentFragment();
  out.append(...root.childNodes);
  return out;
}

function proseBody(text: string): HTMLElement {
  const node = el('div', 'body');
  if (text) node.append(delivery(text));
  return node;
}

function rawTurn(cls: string, who: string, text: string): HTMLElement {
  const turn = el('div', cls);
  turn.append(el('div', 'who', who), proseBody(text));
  return turn;
}

/** Share the draft and thread echo's drawing so the first send keeps its shape. */
export function pendingTurn(delivered: string): HTMLElement {
  return rawTurn('turn user sending', 'you', delivered);
}

export function heldTurn(
  held: Readonly<SendInput>,
  identity: ChatIdentity,
  reason?: string
): HTMLElement {
  const turn = rawTurn('turn user send-failed', 'you · not sent', heldBody(held));
  const actions = el('div', 'actions');
  const retry = el('button', 'fbtn', 'Retry');
  retry.dataset.act = 'retry-held';
  retry.onclick = () => retryHeld();
  const dismiss = el('button', 'fbtn', 'Dismiss');
  dismiss.dataset.act = 'dismiss-held';
  dismiss.onclick = () => {
    chats.dismissHeld(identity);
    renderActive();
  };
  actions.append(retry, dismiss);
  if (reason) turn.append(el('div', 'qfail', reason));
  turn.append(actions);
  return turn;
}

function heldBody(held: Readonly<SendInput>): string {
  const parts: string[] = [];
  const delivered = held.delivered.trim();
  if (delivered) parts.push(delivered);
  if (held.workflowId) {
    const label =
      (ui.state.workflows ?? []).find((workflow) => workflow.id === held.workflowId)?.label ??
      held.workflowId;
    parts.push(label);
  }
  for (const image of held.images) parts.push(image.name);
  return parts.join('\n');
}

/**
 * Share authorship between a settled turn and its outbox row so they agree.
 * A reader's outbox row has no `role` and cannot be `cli` or the assistant.
 * `wait` names the feature the agent typed, not a surface of ours.
 * This is the ternary `core/coordination/send.ts` means when it says a
 * resolution carries no `from`.
 */
function authorLabel(x: { role?: string; from?: string }, assistant: string): string {
  return x.from
    ? 'peer'
    : !x.role || x.role === 'user'
      ? 'you'
      : x.role === 'cli' || x.role === 'warm'
        ? 'cli'
        : x.role === 'wait'
          ? 'wait'
          : assistant;
}

/** Match the settled turn's rail. `.turn.queued` paints its own amber over it. */
function outboxClass(row: QueuedView): string {
  return row.from ? 'user peer' : row.role === 'wait' ? 'wait' : 'user';
}

function outboxAttr(who: HTMLElement, row: QueuedView): void {
  if (row.from) {
    who.append(el('span', 'attr', row.from.slice(0, 8)));
  }
}

/**
 * Share the drawing before and after the drain writes a row, so delivery does
 * not change its appearance. Reader and peer messages use `proseBody` here
 * and when settled, without engine HTML's fence Copy or file links.
 * The key's kind follows the rule in `renderTurns`.
 */
function sentTurn(kind: string, row: QueuedView): Turn {
  return {
    key: `${kind}|${row.id}|${row.text}|${row.images ?? 0}|${mentionsKey(row.text)}`,
    make: () => {
      const turn = rawTurn(`turn ${outboxClass(row)} sending`, authorLabel(row, ''), row.text);
      outboxAttr(q(turn, '.who'), row);
      // A paste with no prose is a legal send, and its row would otherwise be
      // an empty bubble — the same thing the held row says, said the same way.
      if (row.images) {
        q(turn, '.body').append(
          el('div', 'qshots', `${row.images} image${row.images > 1 ? 's' : ''}`)
        );
      }
      return turn;
    }
  };
}

/**
 * Name where the earlier turns remain, because opening mid-conversation can
 * otherwise read as lost history. Name no surface of ours (`src/AGENTS.md`).
 */
export const ELIDED =
  'Earlier turns are not shown here — only the end of this session’s transcript is read. The file on disk has all of it.';

/**
 * What stands above a thread the panel read out of the CLI's own transcript
 * instead of out of what it watched arrive.
 *
 * Said because the difference is visible and otherwise unexplainable: that file
 * is a format nobody contracted, and a turn can come back out of it shaped
 * slightly wrong. Absent for every conversation the panel witnessed whole,
 * which is the ordinary case.
 *
 * Names no surface of ours, the same rule `ELIDED` follows — "this session",
 * never which box the reader is looking at.
 */
const SOURCED =
  'This conversation is reconstructed from the transcript on disk, so some turns may not read exactly as they happened.';

/**
 * A half-hour break rarely fell inside the capped transcript's visible tail.
 * Fifteen minutes is the shortest stop a reader would call one.
 */
const GAP_MS = 15 * 60_000;

/** Whether the thread stopped between these two turns: a quarter of an hour
 *  apart, or on two different days however few minutes that was. A day boundary
 *  forces one because "yesterday" is a break in the work whatever the clock
 *  says. */
const broken = (last: number, next: number): boolean =>
  next - last >= GAP_MS || new Date(last).toDateString() !== new Date(next).toDateString();

/**
 * Include the day because a bare clock reading far back names an unknown day.
 * Use the reader's locale for a clock reading, unlike `ago()`'s duration.
 */
function stamped(at: number, now: number): string {
  const on = new Date(at);
  const clock = on.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // Calendar days apart, not milliseconds: 23:50 and 00:10 are ten minutes and
  // two days' worth of names, and the name is the whole point of the prefix.
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - new Date(on).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  return `${on.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock}`;
}

/**
 * A turn's own clock reading, for its author row — the other half of the
 * divider above. The divider says where the conversation stopped; this says
 * when one turn was, which is the question a reader has only about the turn
 * they are looking at. So it is invisible at rest and appears on hover, which
 * is what Slack and Discord both fall back to: free when unasked, exact when
 * asked. No day prefix — the divider is where a day is named, and a stamp on
 * every row that repeated it would be the rail of near-identical digits design
 * A was rejected for.
 *
 * The full date rides on `data-tip` rather than on a `title`, which is now what
 * every explanation in the panel does — this was the first one, and H23 was the
 * pass that brought the rest over.
 */
function clockSpan(at: number): HTMLElement {
  const on = new Date(at);
  const span = el('span', 'at', on.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  span.dataset.tip = on.toLocaleString();
  return span;
}

/**
 * The images a turn carried, each a chip that opens on click.
 *
 * Built entirely from `opened` and `fetched`, so it draws the same thing whether
 * a reader just clicked or a repaint rebuilt the turn underneath them — which
 * is the only reason an open image survives the poll.
 */
function shots(pid: number, images: ImageRef[]): HTMLElement {
  const wrap = el('div', 'shots');
  for (const image of images) {
    const got = fetched.get(image.id);
    const open = opened.has(image.id);
    const shot = el('div', 'shot' + (got?.reason ? ' dead' : ''));
    // `chip` belongs to the composer's attachment and conflicts with this style.
    const chip = el('button', 'shotchip');
    chip.append(glyph('image'));
    chip.append(
      el(
        'span',
        '',
        got?.reason === 'gone'
          ? 'image not on disk any more'
          : got?.reason === 'tooLarge'
            ? 'image too large to preview'
            : open && !got
              ? 'loading image…'
              : size(image)
      )
    );
    // A dead chip has nothing behind it, so it stops being a control.
    if (!got?.reason) {
      chip.onclick = () => openShot(pid, image.id);
    }
    shot.append(chip);
    if (open && got?.dataUrl) {
      const img = el('img') as HTMLImageElement;
      const src = got.dataUrl;
      img.src = src;
      img.alt = size(image);
      img.tabIndex = 0;
      const show = () => openLightbox({ src, alt: img.alt, caption: size(image), origin: img });
      img.onclick = show;
      img.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        show();
      };
      shot.append(img);
    }
    // Offered the moment there is nothing more to show inline: either the
    // thumbnail is up and full size is the next thing wanted, or it never will
    // be and the editor is all that is left.
    if ((open && got?.dataUrl) || got?.reason === 'tooLarge') {
      const full = el('button', 'full', 'open in editor');
      full.onclick = () => vscode.postMessage({ type: 'openImage', pid, id: image.id });
      shot.append(full);
    }
    wrap.append(shot);
  }
  return wrap;
}

/**
 * `icons.ts` supplies constant markup, so `innerHTML` never contains session
 * output. The caller's icon name is checked by this bundle's types.
 */
function glyph(name: ReturnType<typeof iconForFile>): HTMLElement {
  const span = el('span', 'glyph');
  if (name) {
    span.classList.add('gmark');
    span.innerHTML = icon(name, 13);
  }
  return span;
}

/**
 * Draw the basename because a directory consumes the identifying text in a
 * 400px column. The tooltip's absolute path distinguishes equal basenames.
 *
 * No cap and no slice. A turn writes one file 77.6% of the time and more than
 * five once in 150; the row wraps, so the worst turn ever seen is a few short
 * rows rather than a `+N more` branch to build, style and explain.
 *
 * `short` is the marker: a path this turn changed is missing from the row
 * because another session was writing in the same folder. It hangs off no pill
 * because the contested path is not drawn at all, and it names no surface of
 * ours, per `src/AGENTS.md`. Why an omission rather than a badge, and why it is
 * not raised for a neighbour merely being awake: `Attributed.concurrent`
 * (`core/checkpoint.ts`).
 */
function pills(
  files: readonly string[],
  sizes?: Record<string, Written>,
  short?: true,
  base?: string
): HTMLElement {
  const row = el('div', 'files');
  for (const file of files) {
    const pill = el('div', 'wpill');
    pill.dataset.tip = file;
    // Split by hand rather than through a path module: this half of the bundle
    // is the browser's, and both separators are one character.
    pill.append(glyph(iconForFile(file)), el('span', null, file.split(/[/\\]/).pop() ?? file));
    pill.onclick = () => vscode.postMessage({ type: 'openFile', path: file });
    if (sizes) {
      pill.append(counts(file, sizes[file], base));
    }
    row.append(pill);
  }
  if (short) {
    const note = el('div', 'wshort', 'list may be short');
    note.dataset.tip =
      'Another session was writing in this folder while this ran, so files it changed too are left out.';
    row.append(note);
  }
  return row;
}

/**
 * Where a diff editor stops being worth opening, in lines changed.
 *
 * Measured rather than guessed at, because the plan's premise was not: the
 * largest generated artifact this repo writes is `mockups/ask-zoom-probe.html`
 * at 5,035 lines / 297 KB, not the 1–2 MB the row was scoped against. So this
 * sits ~4× above anything actually written here — no real file loses its diff,
 * and a runaway write still does.
 */
const MAX_DIFF_LINES = 20000;

/**
 * Include counts in the key: another edit hidden in a fold can change them
 * without changing its paths, label or hidden count, leaving stale numbers.
 */
function sizeKey(sizes: Record<string, Written> | undefined): string {
  return sizes
    ? Object.entries(sizes)
        .map(([file, n]) => `${file}:${n.add}/${n.del}`)
        .join(',')
    : '';
}

/**
 * Counts answer how large a change was when its prose does not.
 * Keep `openFile` on the pill so its glyph and padding remain controls.
 *
 * Absent `sizes` means no measurement was attempted. A path missing from an
 * existing `sizes` means `core/transcript.ts` could not read that write's input.
 */
function counts(file: string, written: Written | undefined, base?: string): HTMLElement {
  const num = el('span', 'wnum');
  const since = base ? 'Diff since this turn started' : 'Diff since HEAD';
  if (written) {
    num.append(el('span', 'add', `+${written.add}`), el('span', 'del', `−${written.del}`));
    num.dataset.tip = `${since} — ${written.add} added, ${written.del} removed`;
  } else {
    num.append(el('span', 'unk', '±?'));
    num.dataset.tip = `${since} — this write’s size could not be read`;
  }

  // A magnitude worth reading is still a bad diff tab past some size, so the
  // counts are drawn and the click is withheld. Only a measured write can trip
  // it: `±?` is a size nobody knows, and withholding on a guess would take the
  // diff away from exactly the write that most needs one.
  //
  // **This bounds the turn's write, not the diff behind it**, and the two come
  // apart both ways: a one-line `Edit` into a 2 MB generated file keeps its
  // click, and a fold — whose counts `fold.ts` sums across every turn it hides
  // — can pass the ceiling on thirty small edits to one file whose delta
  // against HEAD is tiny. Deliberate: the number withheld on is the number the
  // reader is looking at, so the refusal matches the pill rather than a size
  // only the host can see. The alternative is a `stat` per pill per poll.
  if (written && written.add + written.del > MAX_DIFF_LINES) {
    num.classList.add('flat');
    num.dataset.tip = `${written.add} added, ${written.del} removed — too large to diff here`;
    return num;
  }

  num.onclick = (e) => {
    // The pill's own handler opens the file; without this both fire and the
    // reader gets an editor tab they did not ask for behind the diff.
    e.stopPropagation();
    vscode.postMessage(
      base ? { type: 'openDiff', path: file, base } : { type: 'openDiff', path: file }
    );
  };
  return num;
}

/**
 * One tool call, as a row.
 *
 * Every string here is plain text and goes in as `textContent`: the summary,
 * the path and the output are a tool's, not the model's prose, and putting
 * them through the markdown engine would hand a tool result the one surface
 * `body()` exists to guard. The tip is the unshortened form — the same trade
 * `pills()` makes between a basename and its path.
 *
 * The output arrives already cut to 180 characters (`core/transcript.ts`), so
 * nothing here truncates: a row that did its own cutting would be a second
 * opinion about the same number.
 *
 * It also arrives shut, and the head is what opens it — a caret only where
 * there is something behind it, so a call still running offers nothing to
 * click. The output is in the DOM either way and hidden in CSS: the row is
 * rebuilt whenever the call returns, and a reader who opened it should not have
 * to find it again.
 */
function toolRow(call: ToolView, key: string): HTMLElement {
  const open = ui.selected !== null && chats.isOpen(ui.selected, 'row', key);
  const row = el('div', 'tool' + (call.failed ? ' failed' : '') + (open ? ' open' : ''));
  const head = el('div', 'thead');
  head.append(el('span', 'glyph'), el('span', 'what', call.summary));
  if (call.detail) head.append(el('span', 'detail', call.detail));
  if (call.title) head.dataset.tip = call.title;
  row.append(head);
  // What was asked, as one pill per question wearing that question's own
  // header. The row is named after the tool and the output behind its caret is
  // the CLI's sentence written for the model — so this is the only thing here
  // that says what the reader was actually asked.
  if (call.ask) {
    // A file pill's shape, wearing a filled mark rather than the hollow page
    // outline — a question must not read as a file at a glance.
    const asked = el('div', 'files');
    call.ask.questions.forEach((qq, at) => {
      const pill = el('button', 'wpill askpill');
      pill.append(el('span', 'glyph'), el('span', null, qq.header ?? 'Q' + (at + 1)));
      pill.dataset.tip = qq.question;
      pill.onclick = () => {
        const active = chats.thread();
        if (active && call.ask) openReplay(active.pid, call.ask, at);
      };
      asked.append(pill);
    });
    row.append(asked);
  }
  if (call.output) {
    head.append(el('span', 'caret'));
    head.onclick = () => {
      if (ui.selected !== null) chats.fold(ui.selected, 'row', key, !open);
      renderActive();
    };
    row.append(el('div', 'out', call.output));
  }
  return row;
}

/**
 * Which row this is, for the set that remembers it was opened. The turn's own
 * stamp and the block's place in it: a call that returns rewrites the block and
 * leaves both alone.
 *
 * An unstamped turn falls back to its position, the way a fold's key does — an
 * open row there shuts when the thread grows under it, which is the cost of a
 * turn the CLI wrote down without a time.
 */
const rowKey = (stamp: number | undefined, turn: number, at: number): string =>
  `r|${stamp ?? `x${turn}`}|${at}`;

/**
 * Use `ago()` so fold durations share the card's vocabulary.
 * Keep the row open or shut so the reader can close it again.
 * Attach handlers directly, as `shots()` and `pills()` do: nothing delegates
 * off `#thread` or morphs it, so sanitized turns cannot forge instructions.
 */
function foldTurn(fold: FoldView): Turn {
  const open = ui.selected !== null && chats.isOpen(ui.selected, 'fold', fold.key);
  const took = fold.ms === undefined ? '' : ' ' + ago(fold.ms);
  const label = fold.stopped
    ? took
      ? `You stopped after${took}`
      : 'You stopped this response'
    : took
      ? `Worked for${took}`
      : 'Worked';
  return {
    key: `f|${fold.key}|${open ? 1 : 0}|${fold.hides.length}|${label}|${fold.files?.join(',') ?? ''}|${sizeKey(fold.sizes)}${fold.concurrent ? '|short' : ''}${fold.base ? `|${fold.base}` : ''}`,
    make: () => {
      const row = el('div', 'fold' + (open ? ' open' : ''));
      const button = el('button', 'foldbtn');
      button.append(el('span', 'caret'), el('span', 'what', label));
      // A count of one is a count of nothing: the row already stands for
      // exactly one thing, and "1 step" is longer than saying nothing.
      if (fold.hides.length > 1) {
        button.append(el('span', 'steps', `${fold.hides.length} steps`));
      }
      button.onclick = () => {
        if (ui.selected !== null) chats.fold(ui.selected, 'fold', fold.key, !open);
        renderActive();
      };
      row.append(button);
      // What the fold took with it. Shut only: the turns it hides draw their
      // own pills the moment it opens, and the same file named twice in one
      // thread reads as two writes.
      if (!open && (fold.files?.length || fold.concurrent)) {
        row.append(pills(fold.files ?? [], fold.sizes, fold.concurrent, fold.base));
      }
      return row;
    }
  };
}

/** A block's share of its turn's key: everything a repaint would have to
 *  notice. A call that has since returned is a different block, and so is one
 *  the reader has since opened — for the reason `shotKey` folds `opened` in. */
function blockKey(block: BlockView, key: string): string {
  if ('prose' in block) return `p|${block.prose}`;
  return 'html' in block
    ? `h|${block.summarized ? 's|' : ''}${block.html}`
    : `t|${block.summary}|${block.detail ?? ''}|${block.output ?? ''}|${block.failed ? 1 : 0}|${
        ui.selected !== null && chats.isOpen(ui.selected, 'row', key) ? 1 : 0
        // The record too: a row whose summary and output have not moved would
        // otherwise keep pills closed over the old one, and every pill would
        // open the question it was first built for. Through the layer's own
        // key, since a pill hands that layer exactly what this row is holding —
        // two spellings of "everything a record draws" is two of them to get
        // wrong.
      }|${block.ask ? recordKey(block.ask) : ''}`;
}

/**
 * A ref's share of its turn's key. Everything `shots` draws from goes in, and
 * has to: a turn is only rebuilt when its key moves, so a ref whose key ignored
 * `opened` would leave the chip a reader just clicked exactly as it was. The
 * flip side is what makes this worth doing — a poll that changes nothing leaves
 * the key alone, and an open image is never rebuilt out from under the reader.
 */
function shotKey(image: ImageRef): string {
  const got = fetched.get(image.id);
  const fetchState = got?.reason ?? (got?.dataUrl ? 'ok' : got ? 'empty' : '-');
  return `${image.id}:${opened.has(image.id) ? 1 : 0}:${fetchState}`;
}

function size(image: ImageRef): string {
  return image.w && image.h ? `image · ${image.w} × ${image.h}` : 'image';
}

/**
 * Open one, asking for its bytes the first time only — `fetched` is keyed by a
 * ref that outlives any repaint, so a second open is free and a reopened image
 * costs nothing.
 */
function openShot(pid: number, id: string): void {
  opened.add(id);
  if (!fetched.has(id)) {
    vscode.postMessage({ type: 'image', pid, id });
  }
  renderActive();
}

export function takeImage(msg: ImageDataMessage): void {
  fetched.set(msg.id, { dataUrl: msg.dataUrl, reason: msg.reason });
  renderActive();
}

/**
 * How long an unacknowledged message is echoed for. The host reads a tail of
 * the transcript, so a reply long enough to fill it leaves the message itself
 * outside what any later poll can report — waiting for it to come back is
 * waiting forever, and the dock sat on a spinner under a finished session.
 * Generous, because while the CLI is actually working the status says so and
 * the grace never applies: it only decides how long an idle session is given to
 * account for a message before the dock stops claiming one is owed.
 */
const ECHO_GRACE_MS = 15_000;

/**
 * Whether `said` is the message `sent`, loose in the three ways a message
 * changes on its way to the transcript: an attachment is delivered as its path
 * on a line of its own after the words, so a prefix rather than an equality; a
 * turn is trimmed at both edges where a send trims only its end; and the drain
 * merges the outbox, renumbering the image markers it carried.
 *
 * `ui/views.ts` asks the same of the host's own echo, and adds the bound this
 * one gets from `echo.at` instead.
 */
function sameWords(sent: string, said: string): boolean {
  const words = withoutImageMarkers(sent).trim();
  const settled = withoutImageMarkers(said).trim();
  return settled === words || settled.startsWith(words + '\n');
}

type EchoCandidate = echoCandidates.EchoCandidate;

function echoMatches(echo: Readonly<SentEcho>, candidate: EchoCandidate): boolean {
  const has = (text: string): boolean => sameWords(echo.delivered, text);
  // A slash command never lands as a turn — the CLI writes scaffolding and an
  // expanded body, and the reader sees a chip. Left out, the echo of a sent
  // `/simplify` would sit under that chip until the grace ran out and then
  // vanish, taking the only sign the reader asked with it. Built-ins are marked
  // the same way (`core/transcript.ts`), which is what settles `/model` and
  // `/clear` — the second of which prints nothing at all, so its chip is the
  // only thing an echo could ever match.
  //
  // The name alone, because the CLI writes the arguments in an entry of their
  // own: `/model haiku` is marked `model`, and comparing the message whole would
  // settle the bare command and hang every command that takes a word.
  const named = echo.delivered.trim().split(/\s+/)[0];
  return candidate.skill !== undefined
    ? named === '/' + candidate.skill
    : candidate.text !== undefined && has(candidate.text);
}

/**
 * The held outbox block: amber rail, rows with Dismiss, subheader with Send now.
 * Pinned to the composer divider via CSS (`margin-top: auto` on `.outbox`).
 */
function queueBlock(t: ThreadView, items: QueuedView[]): HTMLElement {
  const block = el('div', 'outbox');
  for (const item of items) {
    const turn = el('div', `turn ${outboxClass(item)} queued`);
    const who = el('div', 'who');
    // Only when it is not the reader's. A held row they typed is already
    // labelled by the block it sits in, and "you" over every one of them is
    // noise; an author they did not write is the whole of what this says.
    if (item.from || item.role) {
      who.append(el('span', 'qwho', authorLabel(item, '')));
      outboxAttr(who, item);
    }
    who.append(el('span', 'tag', 'queued'));
    const dismiss = el('button', 'qact') as HTMLButtonElement;
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = (e) => {
      e.stopPropagation();
      chats.setSendNowConfirm(t.pid, false);
      vscode.postMessage({
        type: 'dismissQueued',
        pid: t.pid,
        startedAt: t.startedAt,
        id: item.id
      });
    };
    const acts = el('span', 'qacts');
    acts.append(dismiss);
    who.append(acts);
    turn.append(who);
    const bodyEl = el('div', 'body');
    if (item.text) bodyEl.append(delivery(item.text));
    // A paste with no prose is a legal send, so a row can have nothing to
    // quote. Say what it is carrying rather than drawing an empty rail.
    if (item.images) {
      bodyEl.append(el('div', 'qshots', `${item.images} image${item.images > 1 ? 's' : ''}`));
    }
    turn.append(bodyEl);
    block.append(turn);
  }
  const bar = el('div', 'qbar');
  const n = items.length;
  const confirming = chats.session(t.pid)?.sendNowConfirm === true;
  if (confirming) {
    bar.classList.add('conf');
    const lbl = el('span', 'lbl');
    lbl.innerHTML =
      n === 1 ? '<b>Stop turn &amp; send?</b>' : `<b>Stop turn &amp; send all ${n}?</b>`;
    bar.append(lbl);
    const acts = el('span', 'acts');
    const go = el('button', 'qact go') as HTMLButtonElement;
    go.type = 'button';
    go.textContent = 'Confirm';
    go.onclick = (e) => {
      e.stopPropagation();
      chats.setSendNowConfirm(t.pid, false);
      vscode.postMessage({ type: 'sendNow', pid: t.pid, startedAt: t.startedAt });
    };
    const cancel = el('button', 'qact') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.onclick = (e) => {
      e.stopPropagation();
      chats.setSendNowConfirm(t.pid, false);
      renderActive();
    };
    acts.append(go, cancel);
    bar.append(acts);
  } else {
    // An idle row here is behind a wall and waits for the next idle edge,
    // after the turn the drain just released.
    const when = t.status === 'waiting' ? 'after you answer' : 'send when idle';
    const lbl = el('span', 'lbl');
    lbl.innerHTML = `<b>${n} held</b> · ${when}`;
    bar.append(lbl);
    // Send now only while something is still running or blocked — an idle drain
    // already writes the whole outbox as one turn, with nothing to interrupt.
    if (isMidTurn(t.status)) {
      const acts = el('span', 'acts');
      const send = el('button', 'qact danger') as HTMLButtonElement;
      send.type = 'button';
      send.textContent = 'Send now';
      send.onclick = (e) => {
        e.stopPropagation();
        chats.setSendNowConfirm(t.pid, true);
        renderActive();
      };
      acts.append(send);
      bar.append(acts);
    }
  }
  block.append(bar);
  return block;
}

/**
 * Whether to stop echoing the message typed here: the CLI has taken it — as a
 * turn, or onto the queue behind the current one, and either way the real thing
 * is on screen — or it is idle and has had its grace.
 *
 * Taken is `sameWords`, which is also why `echo.delivered` is what the host says it
 * *delivered* (`sendResult`) and not what was typed here: a mention is enriched
 * host-side and the workflow line goes *above* the subject, so the typed text
 * is a suffix of the turn and no prefix match could ever reach it. Anything
 * that grows a message before it reaches the CLI belongs on that side of the
 * wire for the same reason.
 */
/** Retire local echoes before building the rows that replace them. */
function reconcileEchoes(t: ThreadView): void {
  const session = chats.session(t.pid);
  const candidates = echoCandidates.candidates(t);
  chats.syncEchoCandidates(
    t.pid,
    t.startedAt,
    candidates.map((candidate) => candidate.key)
  );
  for (const echo of session?.pending ?? []) {
    const matching = candidates
      .filter((candidate) => echoMatches(echo, candidate))
      .map((candidate) => candidate.key);
    const reconciled = chats.reconcileEcho(t.pid, t.startedAt, echo.operationId, matching);
    if (!reconciled && t.status !== 'busy' && Date.now() - echo.at > ECHO_GRACE_MS) {
      chats.expireEcho(t.pid, t.startedAt, echo.operationId);
    }
  }
}

export function renderTurns(
  t: ThreadView,
  rises: (turn: HTMLElement, pid: number) => void
): Turn[] {
  reconcileEchoes(t);
  if (t.fullHistory)
    t = { ...t, exchanges: t.fullHistory.exchanges, folds: t.fullHistory.folds, truncated: false };
  const turns: Turn[] = [];
  // See ELIDED for why the cut notice names the transcript on disk.
  if (t.truncated && !t.historyAvailable) {
    turns.push({ key: 'c', make: () => el('div', 'elided', ELIDED) });
  }
  // Under the cut notice, since that one is about turns older than these.
  // Gated because a note is a turn: standing alone it would take the place of
  // the empty notice below and spend the arrival on a thread holding nothing.
  // `reconstructed` in `core/adapter.ts` is what keeps that off the wire; this
  // is the dock declining to draw a note it could not justify anyway.
  if (t.fallback && (t.truncated || t.exchanges.length)) {
    // `src`, not `s`: a queued row's key is `s|<text>`, and a bare `s` beside it
    // is one edit away from a collision the morph would answer by dropping a node.
    turns.push({ key: 'src', make: () => el('div', 'sourced', SOURCED) });
  }
  // See foldTurn for why an open fold keeps its row.
  const folded = new Map<number, FoldView>();
  const behind = new Set<number>();
  for (const fold of t.folds ?? []) {
    folded.set(fold.at, fold);
    if (!chats.isOpen(t.pid, 'fold', fold.key)) {
      for (const i of fold.hides) behind.add(i);
    }
  }
  // A key carries everything its turn renders, so a turn that grew mid-stream
  // is a different turn and gets rebuilt. The kind leads it, so a queued
  // message and an echo of the same text cannot be taken for one another.
  //
  // `written` is the last turn that carried a stamp, so a divider measures
  // across the markers between two turns: a skill chip and an interrupt are
  // things that happened to the conversation, and neither is written down with
  // a time of its own.
  const now = Date.now();
  let written: number | undefined;
  turns.push(
    ...t.exchanges.flatMap((x, at): Turn[] => {
      const fold = folded.get(at);
      const rows: Turn[] = fold ? [foldTurn(fold)] : [];
      const hidden = behind.has(at) && !fold;
      const when = 'mark' in x ? undefined : x.at;
      // Where the conversation stopped and restarted, which is the one thing
      // the thread cannot otherwise say: a five-minute exchange and one spread
      // over two days render identically. Only the gap is stamped — every turn
      // stamped is a rail of near-identical digits, and `mockups/
      // chat-turn-timestamp.html` surveys the five apps that agree.
      //
      // Keyed on the stamp itself and on nothing derived from the clock, or the
      // 3s repaint would rebuild the divider under a reader every time.
      if (when !== undefined && written !== undefined && !hidden && broken(written, when)) {
        rows.unshift({ key: `g|${when}`, make: () => el('div', 'gap', stamped(when, now)) });
      }
      if (when !== undefined) written = when;
      if (behind.has(at)) {
        return rows;
      }
      return [...rows, oneTurn(t, x, at, rises)];
    })
  );

  for (const pending of chats.session(t.pid)?.pending ?? []) {
    turns.push({
      key: `s|${pending.operationId}|${pending.delivered}|${mentionsKey(pending.delivered)}`,
      make: () => {
        const turn = pendingTurn(pending.delivered);
        turn.dataset.operationId = pending.operationId;
        return turn;
      }
    });
  }
  const pendingHeld = chats.heldFor({ kind: 'session', pid: t.pid, startedAt: t.startedAt });
  if (pendingHeld) {
    const shown = heldBody(pendingHeld);
    turns.push({
      key: `held|${pendingHeld.at}|${shown}|${mentionsKey(shown)}`,
      make: () =>
        heldTurn(
          pendingHeld,
          { kind: 'session', pid: t.pid, startedAt: t.startedAt },
          chats.session(t.pid)?.refusal
        )
    });
  }
  for (const failed of chats.session(t.pid)?.failed ?? []) {
    turns.push({
      key: `failed|${failed.operationId}|${failed.reason}|${failed.delivered}|${mentionsKey(failed.delivered)}`,
      make: () => {
        const turn = rawTurn('turn user send-failed', 'you · not sent', failed.delivered);
        const actions = el('div', 'actions');
        const restore = el('button', 'fbtn', 'Restore');
        restore.onclick = () => {
          if (!chats.recoverFailed(t.pid, failed.operationId)) {
            $('blocked').textContent = 'Clear the composer before restoring this message.';
            return;
          }
          setBox();
          renderMention();
          renderActive();
          focusBox();
        };
        const dismiss = el('button', 'fbtn', 'Dismiss');
        dismiss.onclick = () => {
          chats.dismissFailed(t.pid, failed.operationId);
          renderActive();
        };
        actions.append(restore, dismiss);
        turn.append(el('div', 'qfail', failed.reason), actions);
        return turn;
      }
    });
  }
  /**
   * The outbox, and whether the drain is provably working on it.
   *
   * `status` alone is not that question, though it looks like it: `statusOf`
   * and `canDrain` do agree (`core/live.ts`), so idle means the *agent* is not
   * holding the outbox — but it does not follow that everything in it is on its
   * way. `mergeQueued` stops at the first entry that `walls` — a command the
   * host flagged, which is the only kind left — so a drain releases the run in
   * front of the wall and leaves the rest. `dequeueHead` does not set
   * `running` either, so between our write and the CLI's first frame the state
   * is idle with the *next* turn's messages still queued. Both windows draw a
   * message as sent that will wait out a whole turn.
   *
   * So the three terms, and each one is load-bearing: the agent is not holding
   * it, nothing has been released ahead of it, and it is the only row — which
   * is what the merge already guarantees for an outbox with no wall in it.
   * Anything else keeps the block, which is what this thread drew before and
   * is never wrong in the direction that matters.
   */
  const held = t.queued ?? [];
  const queues = isMidTurn(t.status);
  const [only] = held;
  const draining = !queues && !t.sending && held.length === 1 && only !== undefined;
  // The same bubble for the same message one step further along: the host has
  // written it and the transcript has yet to say so. Nothing guards against the
  // local echo above drawing it twice, because `reconcileEchoes` has already retired
  // that echo against this — an idle send is drained within a beat of being
  // enqueued, so both authors describe one message and only the host's outlives
  // it. Within, not *at*: a drain waits on its turn checkpoint's baseline before
  // it releases the turn (`core/checkpoint.ts`), 43ms warm and 566ms cold, and
  // a state push landing inside that window is what `held` below draws.
  const inflight = t.sending;
  for (const row of inflight ?? []) {
    turns.push(sentTurn('i', row));
  }
  // A second row is behind a wall, rather than another message going out now.
  if (draining && only) {
    turns.push(sentTurn('h', only));
  }
  // Dots mean a reply is owed and no streaming row is drawing it yet.
  if (
    !t.exchanges.some((x) => 'streaming' in x && x.streaming) &&
    (t.status === 'busy' || (chats.session(t.pid)?.pending.length ?? 0) > 0 || inflight || draining)
  ) {
    turns.push({
      key: 'w',
      make: () => {
        const turn = el('div', 'turn assistant');
        turn.append(el('div', 'who', t.who));
        const dots = el('div', 'working');
        dots.append(el('i'), el('i'), el('i'));
        turn.append(dots);
        return turn;
      }
    });
  }
  // Held outbox: one block at the end of the turn list, pinned to the composer
  // divider by CSS. Confirm is per selected session and dies with the block —
  // not merely with an empty queue. A confirm that outlived a block still
  // holding rows would come back armed once the next turn opened, asking "Stop
  // turn & send all N?" about a turn nobody had it in front of when they
  // pressed. `composer.ts` states the same rule for the arming slot.
  const agentHolds = held.length > 0 && !draining;
  if (!agentHolds || !chats.session(t.pid)?.sendNowConfirm) {
    chats.setSendNowConfirm(t.pid, false);
  }
  if (agentHolds) {
    const conf = chats.session(t.pid)?.sendNowConfirm ? '1' : '0';
    const key = `outbox|${conf}|${held.map((i) => `${i.id}:${i.images ?? 0}:${i.text}`).join('|')}|${t.status}|${mentionsKey(...held.map((i) => i.text))}`;
    turns.push({ key, make: () => queueBlock(t, held) });
  }
  // Proactive signed-out CTA (H53), for a session this window drives — the only
  // kind with somewhere to put the answer. One another window drives is told
  // nothing here: its own window raises the same CTA on the same account.
  if (t.owned && signedOutFor(t.brand)) {
    turns.push({
      key: 'auth-cta',
      make: () => pipeLoginCta(t.brand)
    });
  }
  return turns;
}

/** What started a turn nobody prompted: a background command or a background
 *  agent ending. Its status is the CLI's word, said as the dock says it. */
function triggerWords(x: MarkerView): string {
  const what = x.trigger === 'agent' ? 'agent' : 'command';
  const how =
    x.status === 'completed'
      ? 'finished'
      : x.status === 'failed'
        ? 'failed'
        : x.status === 'stopped'
          ? 'stopped'
          : 'ended';
  return `background ${what} ${how}`;
}

function oneTurn(
  view: ThreadView,
  x: ExchangeView,
  at: number,
  rises: (turn: HTMLElement, pid: number) => void
): Turn {
  if ('mark' in x) {
    // The prompt bar walks `.turn.user`, so a marker must not wear that class.
    return {
      key: `m|${x.mark}|${x.skill ?? ''}|${x.by ?? ''}|${x.trigger ?? ''}|${x.status ?? ''}|${x.at ?? ''}`,
      make: () => {
        if (x.mark === 'break') {
          return el('div', 'break', 'interrupted');
        }
        if (x.mark === 'trigger') {
          return el('div', 'trigger', triggerWords(x));
        }
        // A skill the reader typed is the only trace of their asking: the
        // command and the body it expanded to are both scaffolding, so
        // without this the thread would show the answer to nothing.
        const mine = x.by === 'you';
        const turn = el('div', 'turn skill' + (mine ? ' mine' : ''));
        if (mine) turn.append(el('div', 'who', 'you'));
        turn.append(el('div', 'cmd', mine ? '/' + (x.skill ?? '') : 'skill · ' + (x.skill ?? '')));
        return turn;
      }
    };
  }
  // The skill a turn ran under is on every turn of the run, so showing it
  // where it changes says the same thing once instead of fifteen times.
  const before = view.exchanges[at - 1];
  const after = view.exchanges[at + 1];
  const cut = x.cut && !(after && 'mark' in after && after.mark === 'break');
  const tag = x.skill && (!before || 'mark' in before || before.skill !== x.skill) ? x.skill : '';
  return {
    // `local` is in the key as well as the class: two `cli` turns whose words
    // match are still two different things, and a morph that reused one for
    // the other would draw an alarm as a readout or the reverse.
    // Checkpoint pills can change while blocks stay identical: a heredoc write,
    // a path returned when a neighbour finishes, or a baseline that arrives
    // after the pill is drawn must change the key too. The fold key carries
    // `base` for the same reason.
    key: `x|${view.liveCwd ?? view.fullCwd}|${x.at ?? ''}|${x.role}${x.local ? '.local' : ''}|${x.streaming ? 'live' : ''}|${cut ? 'cut' : ''}|${x.from ?? ''}|${tag}|${x.blocks
      .map((block, i) => blockKey(block, rowKey(x.at, at, i)))
      .join('|')}|${x.images?.map(shotKey).join(',') ?? ''}|${
      x.files?.join(',') ?? ''
    }|${sizeKey(x.sizes)}${x.concurrent ? '|short' : ''}|${mentionsKey(
      ...x.blocks.flatMap((block) =>
        'html' in block ? [block.html] : 'prose' in block ? [block.prose] : []
      )
    )}${x.base ? `|${x.base}` : ''}`,
    make: () => {
      // A slash command's own answer keeps the `cli` author — it is the CLI
      // talking either way — and is drawn as a readout rather than an alarm.
      // `peer` beside the role rather than instead of it: the author really
      // is a user turn, and every rule about one still applies — it is only
      // the reader's *own* that this is not.
      const turn = el(
        'div',
        'turn ' +
          x.role +
          (x.local ? ' local' : '') +
          (x.from ? ' peer' : '') +
          (x.streaming ? ' live' : '')
      );
      const who = el('div', 'who', authorLabel(x, view.who));
      // Enough of a sessionId to match against what `squadron-list` printed,
      // and short enough to leave the line to the clock. Paint, like `tag`.
      if (x.from) who.append(el('span', 'attr', x.from.slice(0, 8)));
      if (tag) who.append(el('span', 'attr', tag));
      // A turn the CLI never stamped says nothing rather than saying now:
      // `at` is the CLI's own reading, and this repaints every 3s.
      if (x.at !== undefined) who.append(clockSpan(x.at));
      turn.append(who);
      // In the order the turn wrote them: a run of prose, then whatever it
      // ran, then the next run. The interleaving is the whole reason this
      // is a list rather than one blob of markup with a footer.
      for (const [i, block] of x.blocks.entries()) {
        if ('prose' in block) {
          if (block.prose) turn.append(proseBody(block.prose));
        } else if ('html' in block) {
          if (block.html) turn.append(body(block.html, view.liveCwd ?? view.fullCwd));
          // The CLI's own terminal marks narration the same way.
          if (block.html && block.summarized) turn.append(el('div', 'summarized', 'summarized'));
        } else {
          turn.append(toolRow(block, rowKey(x.at, at, i)));
        }
      }
      if (x.images) turn.append(shots(view.pid, x.images));
      if (x.files?.length || x.concurrent) {
        turn.append(pills(x.files ?? [], x.sizes, x.concurrent, x.base));
      }
      if (cut) turn.append(el('div', 'cut', 'cut off'));
      if (x.role !== 'user' && x.blocks.some((b) => 'html' in b && b.html)) {
        rises(turn, view.pid);
      }
      return turn;
    }
  };
}

/**
 * Keep the unchanged head to avoid repeated parsing, lost selections and cost
 * growing with the thread. A new session, edited turn or notice rebuilds from
 * the first differing index through the same path.
 */
export function paint(turns: Turn[]): boolean {
  let same = 0;
  while (
    same < ui.threadKeys.length &&
    same < turns.length &&
    ui.threadKeys[same] === turns[same]?.key
  ) {
    same++;
  }
  // Whether any turn was taken away or put on, which is the only thing that
  // moves an offset — and the whole of what `fitRoom` needs re-measuring for.
  const moved = same < thread.childElementCount || same < turns.length;
  for (let i = thread.childElementCount - 1; i >= same; i--) {
    thread.children[i]?.remove();
  }
  for (const turn of turns.slice(same)) {
    thread.append(turn.make());
  }
  setThreadKeys(turns.map((turn) => turn.key));
  return moved;
}
