/**
 * Which hard-break lines a selection includes, and how a quote, a code
 * block, or a list is rebuilt around that cut. `prose.ts` calls nine
 * operations from the rich command overrides, the block input rules, and
 * Shift+Enter's empty-quote exit. This module imports TipTap only.
 */

import { InputRule, isNodeActive } from '@tiptap/core';
import type { CommandProps } from '@tiptap/core';
import { Fragment, NodeRange } from '@tiptap/pm/model';
import type { NodeType, Node as PMNode, ResolvedPos, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState, Selection, Transaction } from '@tiptap/pm/state';
import { findWrapping, liftTarget } from '@tiptap/pm/transform';

/** Whether a code block made here would take a chip with it: one on a line
 *  the selection touches, since only those lines are taken. */
export function codeTakesChip(
  state: Pick<EditorState, 'doc' | 'selection'>,
  chipName: string
): boolean {
  const { from, to } = touchedLines(state.selection);
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name === chipName) found = true;
    return !found;
  });
  return found;
}

/**
 * A block format over lines, as Slack's composer has it (Quill, where every
 * line is a block). Shift+Enter is a hard break inside one paragraph, so the
 * lines the selection touches are cut out of it before `run` wraps or unwraps
 * them, and what an unwrap released is knit back into its neighbours. `each`
 * cuts every touched line apart as well: a list makes an item per line.
 *
 * `dry` is asked only when there is something to cut, and never inside a
 * list: TipTap's `can()` in a command shares its transaction, and
 * `toggleList`'s switch of list type writes to it even as a dry run.
 */
export function byLines(
  props: CommandProps,
  name: string,
  each: boolean,
  run: (props: CommandProps) => boolean,
  dry: () => boolean
): boolean {
  const { tr, dispatch, state } = props;
  if (!dispatch) return run(props);
  const active = isNodeActive(state, name);
  if (!inList(tr.selection.$from) && (!tr.selection.empty || lineCuts(tr, each).length)) {
    if (!dry()) return false;
    cutLines(tr, each);
    // TipTap's chainable state re-reads doc and selection only when its `tr`
    // is read; `wrapIn` reads the selection first and wrapped a stale range.
    void state.tr;
  }
  if (!run(props)) return false;
  if (active) knitReleased(tr);
  else knitAround(tr, name);
  return true;
}

/** The touched lines, and the selection narrowed to the text they hold. */
type Lines = { from: number; to: number; held: { from: number; to: number } };

/**
 * From the start of the first line the selection touches to the end of its
 * last, a line being a text block's run between hard breaks. The blocks are
 * `touchedBlocks`', and its rule holds for lines too: a range that ends where
 * a line starts, or starts where one ends, does not take that line.
 */
function touchedLines(selection: Selection): Lines {
  const blocks = touchedBlocks(selection);
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last) {
    const { from, to } = selection;
    return { from, to, held: { from, to } };
  }
  const { doc } = selection.$from;
  let from = Math.max(selection.from, first.pos + 1);
  let to = Math.min(selection.to, last.pos + last.node.nodeSize - 1);
  if (from < to && isBreak(doc.nodeAt(from)) && from + 1 < to) from++;
  if (from < to && isBreak(doc.resolve(to).nodeBefore) && to - 1 > from) to--;
  const start =
    (breaksIn(first)
      .filter((at) => at < from)
      .at(-1) ?? first.pos) + 1;
  const end = breaksIn(last).find((at) => at >= to) ?? last.pos + last.node.nodeSize - 1;
  return { from: start, to: end, held: { from, to } };
}

/** Where each hard break in a placed text block sits in the document. */
function breaksIn({ pos, node }: Placed): number[] {
  const breaks: number[] = [];
  node.forEach((child, offset) => {
    if (isBreak(child)) breaks.push(pos + 1 + offset);
  });
  return breaks;
}

const isBreak = (node: PMNode | null | undefined): boolean => node?.type.name === 'hardBreak';

/** The hard breaks a cut removes: the one before the first touched line and
 *  the one after the last, and with `each` every one between. */
function lineCuts(tr: Transaction, each: boolean): number[] {
  const lines = touchedLines(tr.selection);
  const cuts = [lines.from - 1, lines.to].filter((at) => isBreak(tr.doc.nodeAt(at)));
  if (each) {
    tr.doc.nodesBetween(lines.from, lines.to, (node, pos) => {
      if (isBreak(node)) cuts.push(pos);
    });
  }
  return [...new Set(cuts)].sort((a, b) => b - a);
}

/**
 * The touched lines cut out of their paragraphs. A cut splits after its
 * break and drops it, back to front so the positions still to cut hold
 * (Doist's typist cuts a list's lines the same way). A range is narrowed to
 * the text the lines hold, so a wrap takes no block either side of them.
 */
export function cutLines(tr: Transaction, each: boolean): void {
  const { held } = touchedLines(tr.selection);
  const steps = tr.mapping.maps.length;
  for (const at of lineCuts(tr, each)) tr.split(at + 1).delete(at, at + 1);
  const { empty, anchor, head } = tr.selection;
  if (empty) return;
  const cut = tr.mapping.slice(steps);
  const from = cut.map(held.from, 1);
  const to = cut.map(held.to, -1);
  tr.setSelection(
    anchor < head ? TextSelection.create(tr.doc, from, to) : TextSelection.create(tr.doc, to, from)
  );
}

/** The blocks an unwrap released, knit to each other and their neighbours
 *  where two paragraphs meet: one paragraph again, a hard break per seam. */
function knitReleased(tr: Transaction): void {
  const { $from, $to } = tr.selection;
  const depth = $from.depth - 1;
  if (depth < 0 || $from.sharedDepth($to.pos) < depth) return;
  const parent = $from.node(depth);
  const seams: number[] = [];
  for (let i = $from.index(depth); i <= $to.index(depth) + 1 && i < parent.childCount; i++) {
    if (i > 0) seams.push($from.posAtIndex(i, depth));
  }
  for (const seam of seams.reverse()) knitAt(tr, seam);
}

/** A wrap just made, joined to a neighbour of its own kind on either side. */
function knitAround(tr: Transaction, name: string): void {
  const { $from } = tr.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== name) continue;
    knitAt(tr, $from.after(depth));
    knitAt(tr, $from.before(depth));
    return;
  }
}

/** Two paragraphs meeting at `pos` become one, with a hard break where they
 *  met; two lists of one kind become one; two quotes become one, and what
 *  meets at their seam likewise. */
function knitAt(tr: Transaction, pos: number): void {
  const $pos = tr.doc.resolve(pos);
  const { nodeBefore, nodeAfter } = $pos;
  if (!nodeBefore || !nodeAfter || nodeBefore.type !== nodeAfter.type) return;
  const kind = nodeBefore.type.name;
  if (LISTS.has(kind)) {
    if (
      kind === 'orderedList' &&
      Number(nodeAfter.attrs['start'] ?? 1) !==
        Number(nodeBefore.attrs['start'] ?? 1) + nodeBefore.childCount
    )
      return;
    tr.join(pos);
    return;
  }
  if (kind !== 'paragraph' && kind !== 'blockquote') return;
  tr.join(pos);
  if (kind === 'blockquote') knitAt(tr, pos - 1);
  else tr.insert(pos - 1, nodeType(tr.doc.type.schema, 'hardBreak').create());
}

/**
 * A quote on or off the blocks a selection touches. TipTap's `toggleWrap`
 * wraps the innermost range, which in a list is the list or its item, and
 * neither can hold a quote; so a wrap goes out to the first container that
 * can, and an unwrap takes the nearest quote's own children. A list either
 * end of that range is split so only the items the selection touches move.
 */
export function toggleQuote({ tr, dispatch }: CommandProps, type: NodeType): boolean {
  const { held } = touchedLines(tr.selection);
  const { empty, anchor, head } = tr.selection;
  const selection = empty
    ? tr.selection
    : TextSelection.create(
        tr.doc,
        anchor < head ? held.from : held.to,
        anchor < head ? held.to : held.from
      );
  const { $from, $to } = selection;
  let quoted = $from.sharedDepth($to.pos);
  while (quoted > 0 && $from.node(quoted).type !== type) quoted--;
  if (quoted > 0) {
    const target = liftTarget(rangeAt(selection, quoted));
    if (target === null) return false;
    if (!dispatch) return true;
    tr.setSelection(selection);
    splitAtItems(tr, quoted);
    tr.lift(rangeAt(tr.selection, quoted), target);
    const lifted = rangeAt(tr.selection, target);
    knitAt(tr, lifted.end);
    knitAt(tr, lifted.start);
    return true;
  }
  for (let depth = $from.blockRange($to)?.depth ?? -1; depth >= 0; depth--) {
    if (!findWrapping(new NodeRange($from, $to, depth), type)) continue;
    if (!dispatch) return true;
    tr.setSelection(selection);
    splitAtItems(tr, depth);
    const range = rangeAt(tr.selection, depth);
    const wrapping = findWrapping(range, type);
    if (!wrapping) return false;
    tr.wrap(range, wrapping);
    return true;
  }
  return false;
}

/** The selection's blocks among the children of the node at `depth`. */
const rangeAt = ({ $from, $to }: Selection, depth: number): NodeRange =>
  new NodeRange($from, $to, depth);

/**
 * A list among the children at `depth` that an end of the selection sits in,
 * split at the edge of the item that end touches: the items after the last
 * one touched, then those before the first, each a list of their own. A
 * numbered list's later half starts at the number it had.
 */
function splitAtItems(tr: Transaction, depth: number): void {
  const at = depth + 1;
  const cut = ($pos: ResolvedPos, index: number): void => {
    const list = $pos.node(at);
    if (index <= 0 || index >= list.childCount) return;
    const attrs =
      list.type.name === 'orderedList'
        ? { ...list.attrs, start: Number(list.attrs['start'] ?? 1) + index }
        : list.attrs;
    tr.split($pos.posAtIndex(index, at), 1, [{ type: list.type, attrs }]);
  };
  const listed = ($pos: ResolvedPos): boolean =>
    $pos.depth > at && LISTS.has($pos.node(at).type.name);
  const { $to } = tr.selection;
  if (listed($to)) cut($to, $to.indexAfter(at));
  const { $from } = tr.selection;
  if (listed($from)) cut($from, $from.index(at));
}

type Placed = { pos: number; node: PMNode };

/**
 * The text blocks a code block takes: the caret's, or every one the range
 * touches, whole. A range that ends where a block starts (a triple click's),
 * or starts where one ends (Shift+Down from a line's end), holds none of that
 * block's text and does not take it, unless it is all the range touches.
 */
function touchedBlocks(selection: Selection): Placed[] {
  const { from, to, empty, $from } = selection;
  if (empty) return $from.parent.isTextblock ? [{ pos: $from.before(), node: $from.parent }] : [];
  const blocks: Placed[] = [];
  $from.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push({ pos, node });
    return false;
  });
  const holds = ({ pos, node }: Placed): boolean => pos + 1 < to && pos + node.nodeSize - 1 > from;
  const held = blocks.filter(holds);
  return held.length ? held : blocks.slice(0, 1);
}

/**
 * Every text block the selection touches as one code block, a line per block
 * and per hard break, in one transaction. It lands in the nearest container
 * that takes it there: an item past its first paragraph, else a quote or the
 * document, so a list it cuts through is split around it. Refused, with
 * nothing changed, when the box is read-only or an IME is composing; a chip
 * is the caller's refusal, made before the lines are cut (`codeTakesChip`).
 */
export function codeFromBlocks({ tr, dispatch, editor, view }: CommandProps): boolean {
  if (!editor.isEditable || view.composing) return false;
  const blocks = touchedBlocks(tr.selection);
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last) return false;
  const { doc } = tr;
  const { schema } = doc.type;
  const text = blocks.map(({ node }) => codeLines(node)).join('\n');
  const block = nodeType(schema, 'codeBlock').create(null, text ? schema.text(text) : null);
  const from = first.pos;
  const to = last.pos + last.node.nodeSize;
  const $from = doc.resolve(from);
  for (let depth = $from.sharedDepth(to); depth >= 0; depth--) {
    if (LISTS.has($from.node(depth).type.name)) continue;
    const placed = placeCode(doc, block, from, to, depth);
    if (!placed) continue;
    if (!dispatch) return true;
    const at = placed.start + placed.before + 1;
    tr.replaceWith(placed.start, placed.end, placed.content);
    tr.setSelection(TextSelection.create(tr.doc, at, at + text.length)).scrollIntoView();
    return true;
  }
  return false;
}

type Placement = { start: number; end: number; content: Fragment; before: number };

/**
 * `block` in place of `from`..`to` among the children of the container at
 * `depth`, with what the cut leaves of those children around it. Null where
 * the container cannot hold the result: an item's first child must be a
 * paragraph.
 */
function placeCode(
  doc: PMNode,
  block: PMNode,
  from: number,
  to: number,
  depth: number
): Placement | null {
  const { schema } = doc.type;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const start = depth === $from.depth ? from : $from.before(depth + 1);
  const end = depth === $to.depth ? to : $to.after(depth + 1);
  let before: Fragment;
  let content: Fragment;
  try {
    before = Fragment.fromArray(rejoined(doc.slice(start, from).content, schema));
    const after = rejoined(doc.slice(to, end).content, schema);
    const cut = depth < $to.depth ? $to.node(depth + 1) : null;
    content = before.addToEnd(block).append(Fragment.fromArray(numberedOn(cut, after)));
  } catch {
    return null;
  }
  const fits = $from.node(depth).canReplace($from.index(depth), $to.indexAfter(depth), content);
  return fits ? { start, end, content, before: before.size } : null;
}

/** A numbered list the block cut keeps its numbers after it: its last item
 *  says what it said before. */
function numberedOn(cut: PMNode | null, after: PMNode[]): PMNode[] {
  const [head, ...rest] = after;
  if (!cut || !head || cut.type.name !== 'orderedList' || head.type !== cut.type) return after;
  const start = Number(cut.attrs['start'] ?? 1) + cut.childCount - head.childCount;
  return [head.type.create({ ...head.attrs, start }, head.content, head.marks), ...rest];
}

/** A text block as code: its text without marks, a hard break as a newline. */
const codeLines = (block: PMNode): string =>
  block.textBetween(0, block.content.size, undefined, (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : ''
  );

/**
 * What a cut leaves of the blocks around a code block, made whole again: a
 * container the cut emptied goes, and a list is mended by `rejoinedList`.
 * Throws where what is left does not fit the schema.
 */
function rejoined(fragment: Fragment, schema: Schema): PMNode[] {
  const out: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isTextblock || node.isLeaf) {
      out.push(node);
      return;
    }
    if (LISTS.has(node.type.name)) {
      out.push(...rejoinedList(node, schema));
      return;
    }
    const content = rejoined(node.content, schema);
    if (content.length) out.push(node.type.createChecked(node.attrs, content, node.marks));
  });
  return out;
}

/**
 * A list whose items the cut may have emptied, or left without their first
 * paragraph. Such an item's
 * nested list of the same kind gives its items to this one; one of the other
 * kind stands between two runs of this list, so its numbers or bullets stay
 * its own; anything left after it is an item again, given an empty first
 * paragraph only where it does not start with one.
 */
function rejoinedList(list: PMNode, schema: Schema): PMNode[] {
  const out: PMNode[] = [];
  let items: PMNode[] = [];
  const flush = (): void => {
    if (items.length) out.push(list.type.createChecked(list.attrs, items, list.marks));
    items = [];
  };
  list.forEach((item) => {
    let content = rejoined(item.content, schema);
    while (content[0] && LISTS.has(content[0].type.name)) {
      const [nested, ...rest] = content;
      content = rest;
      if (nested.type === list.type) nested.forEach((child) => items.push(child));
      else {
        flush();
        out.push(nested);
      }
    }
    if (!content.length) return;
    const head =
      content[0]?.type.name === 'paragraph' ? [] : [nodeType(schema, 'paragraph').create()];
    items.push(item.type.createChecked(item.attrs, [...head, ...content], item.marks));
  });
  flush();
  return out;
}

const LISTS = new Set(['bulletList', 'orderedList']);

export function isListName(name: string): boolean {
  return LISTS.has(name);
}

/** A caret on a quote's line with nothing on it: the paragraph is empty, or
 *  the caret sits between a hard break and its paragraph's edge or another. */
export function onEmptyQuotedLine({ empty, $from }: Selection): boolean {
  if (!empty || $from.depth < 2 || $from.node(-1).type.name !== 'blockquote') return false;
  const { nodeBefore, nodeAfter } = $from;
  return (!nodeBefore || isBreak(nodeBefore)) && (!nodeAfter || isBreak(nodeAfter));
}

export function inList($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === 'listItem') return true;
  }
  return false;
}

/**
 * A block rule that fires only on a marker at the very start of the line. The
 * stock bullet and quote rules accept leading spaces and then drop them, so
 * typed `  - a` was sent as `- a`; the ordered-list rule already refuses them.
 */
export function atLineStart(rule: InputRule, find: InputRule['find'] = rule.find): InputRule {
  return new InputRule({
    find,
    undoable: rule.undoable,
    handler: (props) => {
      if (/^\s/.test(props.match[0])) return null;
      if (touchedLines(props.state.selection).from !== props.range.from) return null;
      const { tr } = props.state;
      if (lineCuts(tr, false).length && inList(tr.selection.$from)) return null;
      // TipTap's wrapping rule takes the whole paragraph, including hard-break neighbours.
      const steps = tr.mapping.maps.length;
      cutLines(tr, false);
      const cut = tr.mapping.slice(steps);
      const range = { from: cut.map(props.range.from), to: cut.map(props.range.to) };
      void props.state.tr;
      return rule.handler({ ...props, range });
    }
  });
}

function nodeType(schema: Schema, name: string): NonNullable<Schema['nodes'][string]> {
  const type = schema.nodes[name];
  if (!type) throw new Error(`prose schema has no ${name} node`);
  return type;
}
