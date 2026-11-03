/**
 * A `Notice` as Slack posts it: Block Kit for the message, and a `text`
 * fallback for the push, which is all a phone's lock screen reads.
 *
 * One notice renders to one payload, byte for byte, every time. A settle
 * renders the notice again with its buttons swapped for the settled word, so
 * the head and body it sends through `chat.update` are the ones already
 * there.
 *
 * - Head: one `section` in `mrkdwn`, the `<@U…>` mention and the head line.
 * - Body: Slack's `markdown` block, which renders the standard markdown the
 *   agent wrote, so there is no markdown-to-`mrkdwn` converter here.
 * - Code line: `rich_text_preformatted`, which needs no escaping and which a
 *   fence in the command cannot break.
 * - Buttons: one `actions` block, on the last chunk only.
 * - Table: the caption as `markdown`, then Slack's `table` block, one a post;
 *   it replaces the body, which stays the push's source.
 *
 * Provisional (master R1): the block shapes come from Slack's Block Kit
 * reference, and M1 Step 3 checks them on a phone.
 */

import type { Button, Notice, NoticeTable, SenderId, TableCell } from '../bridge/model';
import * as wire from './wire';

/** One `chat.postMessage` worth of a notice. */
export type Chunk = { text: string; blocks: readonly Block[] };

export type Block =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'markdown'; text: string }
  | { type: 'rich_text'; elements: readonly RichText[] }
  | { type: 'actions'; elements: readonly ButtonElement[] }
  | { type: 'context'; elements: readonly { type: 'mrkdwn'; text: string }[] }
  | {
      type: 'table';
      column_settings: readonly { is_wrapped: boolean }[];
      rows: readonly (readonly Cell[])[];
    };

/** `raw_text` is never read as markup, so a name in one is only text. */
type Cell =
  | { type: 'raw_text'; text: string }
  | {
      type: 'rich_text';
      elements: readonly {
        type: 'rich_text_section';
        elements: readonly { type: 'link'; url: string; text: string }[];
      }[];
    };

type RichText = {
  type: 'rich_text_preformatted';
  elements: readonly { type: 'text'; text: string }[];
};

type ButtonElement = {
  type: 'button';
  action_id: string;
  text: { type: 'plain_text'; text: string; emoji: true };
  value: string;
  style?: 'danger';
};

/** The most body one post carries. A payload's `markdown` blocks share
 *  12,000 characters; the rest is room for the head and the code line, which
 *  each post's budget also takes out of this. */
export const CHUNK_MAX = 11_000;

/** The longest code line drawn in its own block. Longer goes into the body as
 *  a fence, which is split rather than cut. Provisional: Slack publishes no
 *  limit for a `rich_text` element, so this is the `section` text limit. */
export const CODE_MAX = 3_000;

/** A `table` block's rows, its header among them. */
const TABLE_ROWS = 100;
/** The characters a post's table cells share, a link's URL counted with its
 *  text. */
const TABLE_CHARS = 10_000;
/** The longest text one cell draws, so any one row fits a post beside the
 *  header whatever a session is named. */
const CELL_MAX = 1_000;

/** A button's `plain_text` label. */
const LABEL_MAX = 75;
/** What a push shows, roughly; the rest is in the message. */
const PUSH_MAX = 150;

export function renderNotice(notice: Notice): Chunk[] {
  const mention = mentionOf(notice.mention);
  const head = headText(mention, notice.head);
  if (notice.table !== undefined) return renderTable(notice, notice.table, head);
  const inline =
    notice.code !== undefined && notice.code.length <= CODE_MAX ? notice.code : undefined;
  const body = guardBody(withLongCode(notice.body, inline === undefined ? notice.code : undefined));
  // Each block a post shares with the body takes its length and a line.
  const budget = CHUNK_MAX - room(head) - room(inline);
  const pieces = splitBody(body, budget);
  const last = pieces.length - 1;
  return pieces.map((piece, i) => ({
    text: i === 0 ? fallbackText(notice) : pushLine(piece),
    blocks: [
      ...(i === 0 && head !== undefined ? [section(head)] : []),
      ...(piece.trim() === '' ? [] : [{ type: 'markdown' as const, text: piece }]),
      ...(i === last && inline !== undefined ? [codeBlock(inline)] : []),
      ...(i === last && notice.buttons !== undefined && notice.buttons.length > 0
        ? [actions(notice.buttons)]
        : [])
    ]
  }));
}

/**
 * A table as posts of at most `TABLE_ROWS` rows and `TABLE_CHARS` cell
 * characters, cut between rows, each under the caption and the header again,
 * so every post says what it is and when. No row is left out.
 */
function renderTable(notice: Notice, table: NoticeTable, head: string | undefined): Chunk[] {
  const header = table.columns.map((column) => tableCell(column.title));
  const parts = splitRows(
    table.rows.map((row) => row.map(tableCell)),
    weight(header)
  );
  const settings = table.columns.map((column) => ({ is_wrapped: column.wrap === true }));
  const caption: Block = { type: 'markdown', text: guardBody(table.caption) };
  const last = parts.length - 1;
  return parts.map((rows, i) => ({
    text: i === 0 ? fallbackText(notice) : escapeMrkdwn(cut(table.caption, PUSH_MAX)),
    blocks: [
      ...(i === 0 && head !== undefined ? [section(head)] : []),
      caption,
      { type: 'table' as const, column_settings: settings, rows: [header, ...rows] },
      ...(i === last && notice.buttons !== undefined && notice.buttons.length > 0
        ? [actions(notice.buttons)]
        : [])
    ]
  }));
}

/** Rows in order, grouped so each group fits a post beside the header. */
function splitRows(rows: readonly Cell[][], headerWeight: number): Cell[][][] {
  const parts: Cell[][][] = [[]];
  let used = headerWeight;
  for (const row of rows) {
    const part = parts.at(-1) ?? [];
    const w = weight(row);
    if (part.length > 0 && (part.length + 1 >= TABLE_ROWS || used + w > TABLE_CHARS)) {
      parts.push([row]);
      used = headerWeight + w;
    } else {
      part.push(row);
      used += w;
    }
  }
  return parts;
}

function weight(row: readonly Cell[]): number {
  return row.reduce((sum, cell) => sum + cellWeight(cell), 0);
}

function cellWeight(cell: Cell): number {
  if (cell.type === 'raw_text') return cell.text.length;
  const links = cell.elements.flatMap((section) => section.elements);
  return links.reduce((sum, link) => sum + link.url.length + link.text.length, 0);
}

function tableCell(cell: TableCell): Cell {
  if (typeof cell === 'string') return { type: 'raw_text', text: cut(cell, CELL_MAX) };
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [{ type: 'link', url: cell.link, text: cut(cell.text, CELL_MAX) }]
      }
    ]
  };
}

/** The notice's last chunk with its buttons replaced by the settled word. */
export function renderSettled(notice: Notice): Chunk {
  const chunk = renderNotice({ ...notice, buttons: [] }).at(-1) ?? { text: '', blocks: [] };
  if (notice.settled === undefined || notice.settled === '') {
    return chunk;
  }
  const word: Block = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: escapeMrkdwn(notice.settled) }]
  };
  return { text: chunk.text, blocks: [...chunk.blocks, word] };
}

/**
 * The push: the mention, then the head and the body's first line, cut to what
 * a lock screen shows. Escaped, since Slack reads `text` as `mrkdwn` too.
 */
function fallbackText(notice: Notice): string {
  const mention = mentionOf(notice.mention);
  const lead = notice.head ?? '';
  const line = firstLine(notice.body);
  const said = lead !== '' && line !== '' ? `${lead}: ${line}` : lead || line;
  const pushed = escapeMrkdwn(cut(said, PUSH_MAX));
  return mention === undefined ? pushed : `${mention} ${pushed}`;
}

/** `& < >`, the three characters `mrkdwn` reads as markup. Every mention,
 *  link and broadcast starts with `<`, so text escaped here is only text. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A body cut into pieces of at most `max` characters, in order, such that
 * joining them gives the body back.
 *
 * A cut falls, by preference, on a blank line outside a code fence, then at
 * the end of a line outside one, then inside a fence that is too long for one
 * piece. The last kind closes the fence at the end of its piece and opens it
 * again at the start of the next, so every piece renders on its own; those
 * two lines are the only text the split adds. A line with no break in reach is
 * cut hard. A cut in the first half of the room is taken only when nothing
 * later of any kind is there, so a piece is not short for the sake of a
 * paragraph break.
 */
export function splitBody(body: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = body;
  let reopen: Fence | undefined;
  for (;;) {
    const prefix = reopen === undefined ? '' : `${reopen.line}\n`;
    if (prefix.length + rest.length <= max) {
      pieces.push(prefix + rest);
      return pieces;
    }
    const room = Math.max(1, max - prefix.length);
    const cut = bestCut(rest, room, reopen);
    pieces.push(prefix + rest.slice(0, cut.at) + (cut.inside ? closer(cut.inside, cut.hard) : ''));
    rest = rest.slice(cut.at);
    reopen = cut.inside;
  }
}

/* Everything below is how the pieces above are made. */

type Fence = { line: string; char: '`' | '~'; length: number };

type Cut = { at: number; inside?: Fence; hard?: boolean };

/** Ranked kinds of cut; lower is better. */
const BLANK = 0;
const LINE = 1;
const IN_FENCE = 2;

function bestCut(text: string, room: number, open: Fence | undefined): Cut {
  let fence = open;
  const found: { at: number; kind: number; inside?: Fence }[] = [];
  for (let start = 0; start < text.length;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      break;
    }
    const line = text.slice(start, nl);
    fence = fenceAfter(line, fence);
    const at = nl + 1;
    const fits = fence === undefined ? at <= room : at + fence.length <= room;
    if (!fits) {
      break;
    }
    if (fence !== undefined) {
      found.push({ at, kind: IN_FENCE, inside: fence });
    } else {
      found.push({ at, kind: line.trim() === '' ? BLANK : LINE });
    }
    start = at;
  }
  const late = found.filter((cut) => cut.at >= room / 2);
  const pool = late.length > 0 ? late : found;
  const best = pool.reduce<(typeof found)[number] | undefined>(
    (pick, cut) =>
      pick === undefined || cut.kind < pick.kind || (cut.kind === pick.kind && cut.at > pick.at)
        ? cut
        : pick,
    undefined
  );
  if (best !== undefined) {
    return { at: best.at, ...(best.inside && { inside: best.inside }) };
  }
  return hardCut(text, room, fenceAt(text, room, open));
}

/** A cut mid-line, with room for a fence's closer when it is inside one. */
function hardCut(text: string, room: number, inside: Fence | undefined): Cut {
  const reserve = inside === undefined ? 0 : inside.length + 1;
  let at = Math.max(1, room - reserve);
  // Not between the halves of a surrogate pair, nor inside an entity the
  // guard wrote.
  if (/[\uD800-\uDBFF]/.test(text.charAt(at - 1))) {
    at--;
  }
  const entity = /&[a-z#0-9]{0,8}$/.exec(text.slice(Math.max(0, at - 9), at));
  if (entity !== null && at - entity[0].length > 0) {
    at -= entity[0].length;
  }
  return { at, ...(inside && { inside }), hard: true };
}

/** The fence open where a hard cut falls, reading every whole line before it. */
function fenceAt(text: string, at: number, open: Fence | undefined): Fence | undefined {
  let fence = open;
  const lines = text.slice(0, at).split('\n');
  lines.pop();
  for (const line of lines) {
    fence = fenceAfter(line, fence);
  }
  return fence;
}

/** The closer that ends a piece cut inside `fence`: on a line of its own. */
function closer(fence: Fence, hard: boolean | undefined): string {
  return `${hard ? '\n' : ''}${fence.char.repeat(fence.length)}`;
}

/** The fence open after `line`, given the one open before it (CommonMark: up
 *  to three spaces, three or more of one character; a closer is at least as
 *  long as its opener and carries nothing after it). */
function fenceAfter(line: string, open: Fence | undefined): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) {
    return open;
  }
  const run = match[1] ?? '';
  const after = match[2] ?? '';
  const char = run[0] === '~' ? '~' : '`';
  if (open !== undefined) {
    return char === open.char && run.length >= open.length && after.trim() === ''
      ? undefined
      : open;
  }
  // A backtick opener's info string may not hold a backtick.
  return char === '`' && after.includes('`') ? undefined : { line, char, length: run.length };
}

/**
 * Slack's control sequences, made text: `<` starts a mention, a broadcast or a
 * link, so it and `&` are written as entities, which markdown renders as the
 * characters. The whole body, code included: a guard that skips code has to
 * find code as CommonMark does, and a line-by-line one did not (an escaped
 * backtick, a span across a line break, a fence in a list item all left a
 * `<!channel>` raw). An entity inside code may show as written; M1 Step 3
 * probes how the block draws one.
 */
function guardBody(body: string): string {
  return body.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** `guardBody` undone, for a push that `escapeMrkdwn` escapes again. */
function unguard(text: string): string {
  return text.replace(/&(lt|amp);/g, (entity) => (entity === '&lt;' ? '<' : '&'));
}

/** A code line over `CODE_MAX`, as a fence after the body, longer than any
 *  backtick run the code holds. */
function withLongCode(body: string, code: string | undefined): string {
  if (code === undefined) {
    return body;
  }
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${body}\n\n${fence}\n${code}\n${fence}`;
}

/** `<@U…>` for a `team:user` sender, or nothing for an id that is not one. */
function mentionOf(sender: SenderId | undefined): string | undefined {
  const user = sender === undefined ? undefined : userOf(sender);
  return user === undefined ? undefined : `<@${user}>`;
}

/** The user half of a `team:user` sender id, the channel `chat.postMessage`
 *  opens a bot DM on. */
export function userOf(sender: SenderId): string | undefined {
  const parts = sender.split(':');
  const user = parts[1];
  return parts.length === 2 && user !== undefined && wire.isMember(user) ? user : undefined;
}

function headText(mention: string | undefined, head: string | undefined): string | undefined {
  const line = head === undefined || head === '' ? undefined : escapeMrkdwn(head);
  const text = [mention, line].filter((part) => part !== undefined).join(' ');
  return text === '' ? undefined : text;
}

function room(text: string | undefined): number {
  return text === undefined ? 0 : text.length + 1;
}

function section(text: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function codeBlock(code: string): Block {
  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_preformatted', elements: [{ type: 'text', text: code }] }]
  };
}

function actions(buttons: readonly Button[]): Block {
  return {
    type: 'actions',
    elements: buttons.map((button, i) => ({
      type: 'button',
      action_id: `sq.${i}`,
      text: { type: 'plain_text', text: cut(button.label, LABEL_MAX), emoji: true },
      value: button.payload,
      ...(button.tone === 'danger' && { style: 'danger' as const })
    }))
  };
}

/**
 * A later chunk's push: its first line that is not a fence marker, escaped
 * whole like the first chunk's, since `text` is read as `mrkdwn`.
 */
function pushLine(piece: string): string {
  let fence: Fence | undefined;
  for (const line of piece.split('\n')) {
    const open = fence;
    fence = fenceAfter(line, fence);
    if (fence === open && line.trim() !== '') {
      return escapeMrkdwn(cut(unguard(line).trim(), PUSH_MAX));
    }
  }
  return '';
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

/** At most `max` characters, the last an ellipsis when anything was cut. */
function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max - 1;
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) {
    end--;
  }
  return `${text.slice(0, end)}…`;
}
