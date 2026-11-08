/**
 * `rich` preserves markdown in the formatting set. `plain` preserves literal
 * characters and newlines for CLI answer fields. Mode is fixed at mount.
 * `TASK_done_prose_input.md`: Key Decisions, and Notes "Proof A" for
 * workarounds measured on tiptap-markdown 0.9.0 and TipTap 3.30.5.
 */

import { createDocument, Editor, Extension, InputRule, isNodeActive, Node } from '@tiptap/core';
import type {
  AnyExtension,
  CommandProps,
  EditorOptions,
  JSONContent,
  SingleCommands
} from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold, starInputRegex as boldStar } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { backtickInputRegex, CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Italic, starInputRegex as italicStar } from '@tiptap/extension-italic';
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { Text } from '@tiptap/extension-text';
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history';
import { DOMParser, DOMSerializer, Fragment, Slice } from '@tiptap/pm/model';
import type { Node as PMNode, ResolvedPos, Schema } from '@tiptap/pm/model';
import {
  AllSelection,
  EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection
} from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Markdown } from 'tiptap-markdown';
import { imeKey } from './dom';
import * as mentionClipboard from './mention_clipboard';
import { findMentions, pillPresentation, mentionOf } from './mention_text';
import type { MentionKind } from './mention_text';
import type { MentionChange, MentionSpot, MentionTarget } from './mentions';
import { WORD } from './skilltext';
import * as blocks from './prose_blocks';
import type { Format } from '../ui/format_controls';
import * as localPath from '../ui/local_path';

export type ProseMode = 'rich' | 'plain';

/** The editor's document as plain data (ProseMirror JSON): what a caller
 *  keeps as its local record, since raw delivery cannot be read back. */
export type ProseSnapshot = JSONContent;

/** What a chip stands for: a mention, or an attachment the box holds by id. */
export type ChipKind = MentionKind | 'image' | 'file';

/** What a formatting control can apply, in the composer toolbar's order. */
export const FORMATS = [
  'bold',
  'italic',
  'strike',
  'bulletList',
  'orderedList',
  'blockquote',
  'code',
  'codeBlock'
] as const;

export type ProseFormat = Format;

/** Why a format cannot be applied now. `chip`: a code block would lose a chip
 *  in the blocks it takes. `context`: the schema refuses it at the selection,
 *  as a mark inside a code block. */
export type FormatBlock = 'plain' | 'readOnly' | 'chip' | 'context';

export type FormatState = { active: boolean; blocked: FormatBlock | null };

export type ProseFormats = Readonly<Record<ProseFormat, FormatState>>;

export interface ProseOptions {
  /** Fixed at mount: the two modes are two schemas. */
  mode: ProseMode;
  placeholder?: string;
  /** The editor root's accessible name. */
  label?: string;
  readOnly?: boolean;
  /** After every change the reader makes. Not after `importMarkdown` or
   *  `restore`: the caller already knows what it put there. */
  onChange?: () => void;
  /** Sees keys before the editor's own keymap; `true` keeps them.
   *  Not called for IME keys or Escape; Escape belongs to the surface. */
  onKey?: (event: KeyboardEvent) => boolean;
  /** Rich mode: the skills whose phrase becomes a chip once it is complete. */
  skills?: readonly string[];
  /** Rich mode: a session chip's card name, when the box can say it. */
  sessionName?: (pid: number) => string | undefined;
  /** When `formats()` would answer differently: a caret move, an edit, a
   *  restore or import, an option change. Not when nothing it reports moved. */
  onFormat?: (formats: ProseFormats) => void;
}

export type ProseUpdate = Partial<Omit<ProseOptions, 'mode'>>;

export interface Prose {
  /** The delivery text: in rich mode markdown, raw where the reader typed it;
   *  in plain mode the characters. */
  value(): string;
  snapshot(): ProseSnapshot;
  /** Installs the snapshot as a new editor state, so Undo cannot reach what
   *  was there before. `false`, and the document untouched, when the snapshot
   *  does not fit this editor's schema (the other mode's, or malformed): what
   *  to do about it is the caller's, which owns the record. */
  restore(snapshot: ProseSnapshot, options: { history: 'fresh' }): boolean;
  /** Rich mode parses `md`; plain mode takes it literally. A fresh history
   *  either way. */
  importMarkdown(md: string): void;
  /** At the caret, replacing a selection. Where the caret's block holds text
   *  only (a code block), in a new paragraph after it. Set apart: a space
   *  before it where it would touch a word, and one after it, in the same Undo
   *  step. Rich mode only. */
  insertChip(kind: ChipKind, expansion: string, attachmentId?: string): void;
  /** What the `@` menu reads and writes through (`mentions.ts`). */
  readonly selection: MentionTarget;
  /** Each format at the selection: whether it is on, and what stops it. */
  formats(): ProseFormats;
  /** Toggles one format at the selection, as one Undo step. `false`, and the
   *  document untouched, when `formats()` says it is blocked or an IME is
   *  composing. A code block takes every text block the selection touches. */
  format(format: ProseFormat): boolean;
  focus(): void;
  /** Same editor, same node, same history: only the options change. Every
   *  chip's label is drawn again, so a renamed card's chip follows it. */
  update(options: ProseUpdate): void;
  /** Idempotent. Every other method throws after it, by name, so a closure
   *  that outlived its owner says so instead of failing somewhere inside. */
  destroy(): void;
}

/**
 * What the host element carries for tests, which run the bundle as a separate
 * module instance: the instance, plus the two verbs that need the view.
 */
export type ProseHook = Prose & {
  /** Literal text through the editor's text-input path, so input rules run,
   *  as a keystroke's would. One line: a newline is a key, not a character. */
  type(text: string): void;
  select(from: number, to?: number): void;
};

type ProseHost = HTMLElement & { prose?: ProseHook };

export function createProse(host: HTMLElement, options: ProseOptions): Prose {
  let current: ProseOptions = { ...options };
  const read = (): ProseOptions => current;
  const { mode } = options;
  const editor: Editor = new Editor({
    element: host,
    extensions: mode === 'rich' ? richExtensions(read) : plainExtensions(read),
    editable: !options.readOnly,
    // The panel's stylesheet carries the rules TipTap would inject (ui/css/prose.ts).
    injectCSS: false,
    // Paste rules run markdown-shaped regexes over pasted text: `_x_` turned
    // italic, which breaks "plain text is inserted literally".
    enablePasteRules: false,
    editorProps: {
      ...editorProps(mode, read),
      ...(mode === 'rich'
        ? {
            clipboardTextSerializer: (slice: Slice) =>
              markdownStorage(editor).serializer.serialize(clipboardContent(slice.content))
          }
        : {})
    },
    // Plain mode's copy: one newline between lines, not a blank line.
    coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: '\n' } }
  });
  host.dataset.prose = mode;
  host.classList.add('prose');
  editor.on('update', () => current.onChange?.());

  // Compared as JSON, so a caller hears a change and not every keystroke.
  let saidFormats = '';
  const sayFormats = (): void => {
    if (!current.onFormat || editor.isDestroyed) return;
    const formats = formatsOf(editor, mode);
    const said = JSON.stringify(formats);
    if (said === saidFormats) return;
    saidFormats = said;
    current.onFormat(formats);
  };
  editor.on('transaction', sayFormats);

  // A new state is no transaction, so it says its formats itself.
  const install = (given: PMNode): void => {
    const { view } = editor;
    const doc = numbered(given);
    view.updateState(
      EditorState.create({ doc, plugins: view.state.plugins, selection: Selection.atEnd(doc) })
    );
    sayFormats();
  };

  const live = (): Editor => {
    if (editor.isDestroyed) throw new Error('prose: used after destroy');
    return editor;
  };

  const prose: Prose = {
    value: () => (mode === 'rich' ? markdownOf(live()) : plainText(live().state.doc)),
    snapshot: () => live().getJSON(),
    restore: (snapshot) => {
      const { schema } = live();
      let doc: PMNode;
      try {
        doc = schema.nodeFromJSON(snapshot);
        doc.check();
      } catch {
        return false;
      }
      install(doc);
      return true;
    },
    importMarkdown: (md) =>
      install(
        mode === 'rich'
          ? createDocument(markdownStorage(live()).parser.parse(md), editor.schema)
          : plainDoc(live().schema, md)
      ),
    insertChip: (kind, expansion, attachmentId) =>
      insertChip(live().view, { kind, expansion, attachmentId: attachmentId ?? null }),
    selection: selectionOf(editor),
    formats: () => formatsOf(live(), mode),
    format: (format) => {
      const ed = live();
      if (formatBlock(ed, mode, format) !== null || ed.view.composing) return false;
      // Code-block replacement otherwise joins the typing it replaces in one Undo event.
      ed.view.dispatch(closeHistory(ed.state.tr));
      return applyFormat(ed.commands, format);
    },
    // The view's own focus, which is synchronous; TipTap's command waits a frame.
    focus: () => live().view.focus(),
    update: (changes) => {
      live();
      const was = current;
      current = { ...current, ...changes };
      // Avoid redrawing unchanged options when a caller updates on every push.
      if (
        was.readOnly !== current.readOnly ||
        was.placeholder !== current.placeholder ||
        was.label !== current.label
      ) {
        editor.setOptions({ editable: !current.readOnly });
      }
      for (const chip of chipViews(editor)) chip.relabel();
      if (was.onFormat !== current.onFormat) saidFormats = '';
      sayFormats();
    },
    destroy: () => {
      if (editor.isDestroyed) return;
      editor.destroy();
      delete (host as ProseHost).prose;
      host.classList.remove('prose');
      delete host.dataset.prose;
    }
  };
  (host as ProseHost).prose = { ...prose, type: (text) => typeText(editor, text), select };
  return prose;

  function select(from: number, to = from): void {
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  }
}

function formatsOf(editor: Editor, mode: ProseMode): ProseFormats {
  const formats = {} as Record<ProseFormat, FormatState>;
  for (const format of FORMATS) {
    formats[format] = {
      active: mode === 'rich' && editor.isActive(format),
      blocked: formatBlock(editor, mode, format)
    };
  }
  return formats;
}

function formatBlock(editor: Editor, mode: ProseMode, format: ProseFormat): FormatBlock | null {
  if (mode === 'plain') return 'plain';
  if (!editor.isEditable) return 'readOnly';
  if (
    format === 'codeBlock' &&
    !editor.isActive('codeBlock') &&
    blocks.codeTakesChip(editor.state, CHIP)
  ) {
    return 'chip';
  }
  return applyFormat(editor.can(), format) ? null : 'context';
}

/** The command each format toggles, run for real or as a dry run (`can()`). */
function applyFormat(commands: SingleCommands, format: ProseFormat): boolean {
  switch (format) {
    case 'bold':
      return commands.toggleBold();
    case 'italic':
      return commands.toggleItalic();
    case 'strike':
      return commands.toggleStrike();
    case 'bulletList':
      return commands.toggleBulletList();
    case 'orderedList':
      return commands.toggleOrderedList();
    case 'blockquote':
      return commands.toggleBlockquote();
    case 'code':
      return commands.toggleCode();
    case 'codeBlock':
      return commands.toggleCodeBlock();
  }
}

function insertChip(view: EditorView, attrs: ChipAttrs): void {
  const { state } = view;
  const type = state.schema.nodes[CHIP];
  if (!type) throw new Error('prose: plain mode has no chips');
  const chip = type.create(attrs);
  const paragraph = nodeType(state.schema, 'paragraph');
  const then = (tr: Transaction): Transaction => tr.insertText(' ');
  if (acceptsChip(state)) {
    const tr = state.tr;
    const { $from } = state.selection;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, OBJECT);
    if (before && !/\s$/.test(before)) tr.insertText(' ');
    view.dispatch(then(tr.replaceSelectionWith(chip, false)));
    return;
  }
  if (!state.selection.$from.parent.isTextblock) {
    const tr = state.tr.replaceSelectionWith(paragraph.create(null, chip), false);
    view.dispatch(
      then(
        tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(state.selection.to)), -1))
      )
    );
    return;
  }
  const after = state.selection.$to.after();
  const tr = state.tr.insert(after, paragraph.create(null, chip));
  view.dispatch(then(tr.setSelection(TextSelection.create(tr.doc, after + 2))));
}

function selectionOf(editor: Editor): MentionTarget {
  return {
    node: editor.view.dom,
    caret: () => {
      const { selection } = editor.state;
      return selection.empty ? selection.from : null;
    },
    caretLine: () => {
      const { selection } = editor.state;
      if (!selection.empty) return null;
      // Side -1, the character before: with the menu open that is the `@`, a
      // query letter or the pill awaiting its effort, so on the caret's line
      // even at a soft wrap, where side 1 measures the next line's first.
      const { top, bottom } = editor.view.coordsAtPos(selection.from, -1);
      return { top, bottom };
    },
    text: (from, to) => editor.state.doc.textBetween(from, to, '\n', '\uFFFC'),
    spot: () => spotAt(editor.state),
    onChange: (listener: (change: MentionChange) => void) => {
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) listener('edit');
        else if (transaction.selectionSet) listener('move');
      });
      editor.view.dom.addEventListener('compositionstart', () => listener('compose'));
    },
    picked: (at = editor.state.selection.from) => {
      const { selection, doc } = editor.state;
      if (!selection.empty || at < 0 || at > doc.content.size) return null;
      const chipBefore = (pos: number): PMNode | null => {
        const before = doc.resolve(pos).nodeBefore;
        return before?.type.name === CHIP ? before : null;
      };
      const $at = doc.resolve(at);
      const spaced = $at.parentOffset > 0 && doc.textBetween(at - 1, at) === ' ';
      return chipBefore(at) ?? (spaced ? chipBefore(at - 1) : null);
    },
    accepts: () => acceptsChip(editor.state),
    // A new Undo step, so what follows it at once (a pick's chip) is undone
    // with it and the typing before stays.
    replace: (from, to, text) => {
      const { view } = editor;
      const tr = closeHistory(view.state.tr.insertText(text, from, to));
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + text.length)));
    }
  };
}

/**
 * The `@` run around the caret, bounded by whitespace on both sides rather than
 * by the caret, as the textarea's is. A chip and a line break end it too, and
 * code has none, a span still open included: there `@` is a character.
 */
function spotAt(state: EditorState): MentionSpot | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const block = $from.parent;
  if (block.type.spec.code || $from.marks().some((mark) => mark.type.spec.code)) return null;
  const text = inlineText(block);
  const caret = $from.parentOffset;
  const at = text.slice(0, caret).lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(text.charAt(at - 1)))) return null;
  const start = $from.start();
  const code = state.schema.marks['code'];
  const inCode = code && state.doc.rangeHasMark(start + at, start + at + 1, code);
  if (inCode || inOpenCode(state, start + at)) return null;
  let end = caret;
  while (end < text.length && !/[\s\uFFFC]/.test(text.charAt(end))) end += 1;
  const query = text.slice(at + 1, end);
  if (/[\s\uFFFC]/.test(query)) return null;
  return { at: start + at, end: start + end, query };
}

function acceptsChip(state: EditorState): boolean {
  const type = state.schema.nodes[CHIP];
  const { $from } = state.selection;
  return type !== undefined && $from.parent.canReplaceWith($from.index(), $from.index(), type);
}

function editorProps(
  mode: ProseMode,
  read: () => ProseOptions
): NonNullable<EditorOptions['editorProps']> {
  return {
    // Direct props run before every plugin, which is what puts the caller's
    // key hook ahead of the keymaps.
    handleKeyDown: (_view, event) => read().onKey?.(event) ?? false,
    handleDOMEvents: {
      paste: (view, event) => pasteText(view, event, mode),
      // ProseMirror skips a composition it saw start; one it did not would reach
      // the keymap, whose Enter splits the block and prevents the commit.
      // `true` ends ProseMirror's handling without preventing the default.
      // ProseMirror's captureKeyDown prevents Escape (keyCode 27) even with no
      // keymap binding. Leave it to the surface's dismissal or interrupt handler.
      keydown: (_view, event) => imeKey(event) || event.key === 'Escape'
    },
    transformPastedHTML: (html) =>
      mode === 'rich' ? mentionClipboard.restoreClipboardMentions(html) : html,
    clipboardTextParser: (text, $context, _plain, view) =>
      mode === 'rich'
        ? richTextSlice(view.state.schema, text, $context)
        : plainTextSlice(view.state.schema, text),
    transformPasted: (slice) => new Slice(tighten(slice.content), slice.openStart, slice.openEnd)
  };
}

/**
 * VS Code's own copy flavour. Measured 2026-10-06 on stock VS Code 1.140.0: a
 * copy carries `text/plain`, `text/html` (a `<div>` per line), this, and
 * `application/vnd.code.copymetadata`. Its HTML read as HTML is a paragraph
 * per line, so every newline would be sent doubled.
 */
const CODE_EDITOR_FLAVOUR = 'vscode-editor-data';

/**
 * Takes the clipboard's plain text instead of its HTML, in plain mode always
 * and in rich mode when a code editor wrote it. `false` leaves the paste to
 * ProseMirror, which reads HTML into the schema — also what happens when there
 * is no plain text to take.
 *
 * Paste only: a drag from a code editor goes through ProseMirror's drop
 * handler and is still read as HTML (Step 4, a known gap).
 */
function pasteText(view: EditorView, event: ClipboardEvent, mode: ProseMode): boolean {
  const data = event.clipboardData;
  if (!view.editable || !data) return false;
  if (mode === 'rich' && !Array.from(data.types).includes(CODE_EDITOR_FLAVOUR)) return false;
  const text = data.getData('text/plain');
  if (!text) return false;
  event.preventDefault();
  view.pasteText(text, event);
  return true;
}

/**
 * Plain text, inserted literally: one paragraph, a hard break per newline, in
 * the marks at the caret. ProseMirror's own parser splits on runs of
 * newlines, which made `a\n\n\nb` two paragraphs. A code block never gets
 * here; ProseMirror inserts the bytes there itself.
 */
function richTextSlice(schema: Schema, text: string, $context: ResolvedPos): Slice {
  const marks = $context.marks();
  const inline: PMNode[] = [];
  lines(text).forEach((line, i) => {
    if (i > 0) inline.push(nodeType(schema, 'hardBreak').create());
    if (line) inline.push(schema.text(line, marks));
  });
  return new Slice(Fragment.from(nodeType(schema, 'paragraph').create(null, inline)), 1, 1);
}

function plainTextSlice(schema: Schema, text: string): Slice {
  return new Slice(plainDoc(schema, text).content, 1, 1);
}

/**
 * A pasted list whose every item is one paragraph, perhaps with nested lists,
 * is tight, so it is sent as `- a\n- b`. Every rich editor's clipboard wraps
 * an item's text in a `<p>`, which tiptap-markdown reads as loose and sends
 * with a blank line between items. A list loaded from markdown keeps what it
 * said: this runs on paste only.
 */
function tighten(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    if (child.isLeaf) {
      out.push(child);
      return;
    }
    const content = tighten(child.content);
    out.push(
      blocks.isListName(child.type.name) && oneParagraphEach(child)
        ? child.type.create({ ...child.attrs, tight: true }, content, child.marks)
        : child.copy(content)
    );
  });
  return Fragment.fromArray(out);
}

function oneParagraphEach(list: PMNode): boolean {
  let one = true;
  list.forEach((item) => {
    let paragraphs = 0;
    item.forEach((block) => {
      if (block.type.name === 'paragraph') paragraphs++;
      else if (!blocks.isListName(block.type.name)) one = false;
    });
    if (paragraphs > 1) one = false;
  });
  return one;
}

function richExtensions(read: () => ProseOptions): AnyExtension[] {
  return [
    Document,
    Paragraph,
    RawText,
    RawHardBreak,
    Chip.configure({ read }),
    starOnly(Bold, boldStar),
    starOnly(Italic, italicStar),
    Strike.extend({
      addInputRules() {
        return (this.parent?.() ?? []).map(guard);
      }
    }),
    Code,
    CodeBlock.extend({
      // A tilde fence is sent as a backtick one; only the spelling that
      // round-trips makes a block.
      addInputRules() {
        return (this.parent?.() ?? []).filter((rule) => rule.find === backtickInputRegex);
      },
      // Its one plugin fences every paste that carries `vscode-editor-data`,
      // a single copied word included, in its language. A code editor's paste
      // is its plain text instead (`pasteText`).
      addProseMirrorPlugins() {
        return [];
      },
      // TipTap's own converts each block apart, and drops a chip.
      // Mod-Alt-C reaches this one too.
      addCommands() {
        return {
          ...this.parent?.(),
          toggleCodeBlock: () => (props: CommandProps) =>
            blocks.byLines(
              props,
              this.name,
              false,
              (p) =>
                isNodeActive(p.state, this.name)
                  ? p.commands.setNode('paragraph')
                  : !blocks.codeTakesChip(p.state, CHIP) && blocks.codeFromBlocks(p),
              () => props.can().toggleCodeBlock()
            )
        };
      }
    }),
    Blockquote.extend({
      addInputRules() {
        return (this.parent?.() ?? []).map((rule) => blocks.atLineStart(rule));
      },
      addCommands() {
        return {
          ...this.parent?.(),
          toggleBlockquote: () => (props: CommandProps) =>
            blocks.byLines(
              props,
              this.name,
              false,
              (p) => blocks.toggleQuote(p, this.type),
              () => props.can().toggleBlockquote()
            )
        };
      }
    }),
    BulletList.extend({
      // `* ` and `+ ` would be sent as `- `; only the dash makes a list.
      addInputRules() {
        return (this.parent?.() ?? []).map((rule) => blocks.atLineStart(rule, /(-) $/));
      },
      addStorage() {
        return { markdown: { serialize: bulletList } };
      },
      addCommands() {
        const parent = this.parent?.();
        return {
          ...parent,
          toggleBulletList: () => (props: CommandProps) =>
            blocks.byLines(
              props,
              this.name,
              true,
              (p) => parent?.toggleBulletList?.()(p) ?? false,
              () => props.can().toggleBulletList()
            )
        };
      }
    }),
    OrderedList.extend({
      addCommands() {
        const parent = this.parent?.();
        return {
          ...parent,
          toggleOrderedList: () => (props: CommandProps) =>
            blocks.byLines(
              props,
              this.name,
              true,
              (p) => parent?.toggleOrderedList?.()(p) ?? false,
              () => props.can().toggleOrderedList()
            )
        };
      }
    }),
    ListItem,
    ListKeymap,
    UndoRedo,
    Dropcursor,
    Gapcursor,
    placeholder(read),
    ConstrainedParser,
    Aria.configure({ read }),
    HostKeys,
    Markdown.configure({
      html: false,
      breaks: true,
      linkify: false,
      tightLists: true,
      transformPastedText: false,
      transformCopiedText: true
    })
  ];
}

type ListState = MarkdownState & {
  renderList(node: PMNode, delim: string, first: (index: number) => string): void;
};

/**
 * A bullet list directly after another one takes the other marker, `*`:
 * CommonMark joins two runs of one bullet into one list whatever blank lines
 * part them, so two lists sent with dashes come back as one.
 */
function bulletList(state: ListState, node: PMNode, parent: PMNode, index: number): void {
  let run = 0;
  while (index - run > 0 && parent.child(index - run - 1).type === node.type) run++;
  const marker = run % 2 ? '* ' : '- ';
  state.renderList(node, '  ', () => marker);
}

function plainExtensions(read: () => ProseOptions): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    UndoRedo,
    placeholder(read),
    Aria.configure({ read }),
    HostKeys,
    Extension.create({
      name: 'plainShiftEnter',
      addKeyboardShortcuts() {
        return { 'Shift-Enter': () => this.editor.commands.splitBlock() };
      }
    })
  ];
}

const placeholder = (read: () => ProseOptions): AnyExtension =>
  Placeholder.configure({ placeholder: () => read().placeholder ?? '' });

/** The editor root's role and name. A plugin rather than an editor prop, so
 *  the label is re-read on every view update. */
const Aria = Extension.create<{ read: () => ProseOptions }>({
  name: 'proseAria',
  addOptions() {
    return { read: () => ({ mode: 'rich' }) };
  },
  addProseMirrorPlugins() {
    const { read } = this.options;
    return [
      new Plugin({
        key: new PluginKey('proseAria'),
        props: {
          attributes: () => {
            const { label } = read();
            return { 'aria-multiline': 'true', ...(label ? { 'aria-label': label } : {}) };
          }
        }
      })
    ];
  }
});

/**
 * Undo, Redo and Select All are the editor's keymap, and kept from the host.
 * VS Code's webview frame posts every keydown that reaches its window to the
 * workbench, which runs its own Undo, Redo or Select All as an `execCommand`
 * back in this frame. Measured 2026-10-07 on stock VS Code 1.140.0: the
 * editor's Redo of ` third`, then the native redo of the typed `d`, made
 * `thirdd`; a Select All arriving after ⌘A had already emptied the box took
 * the words typed since. Copy, cut and paste still bubble: that same command is
 * how they reach a webview at all.
 *
 * Keyed on `keyCode`, as the frame is (`isUndoRedo`), so a layout where ⌘Z is
 * `я` is kept too; Ctrl as well as Cmd, as there. The frame also prevented the
 * browser's own undo and redo, whose stack holds the typing it inserted
 * natively. ProseMirror prevents a bare Mod-Z or Mod-Y itself, but not
 * Shift+Mod-Z with nothing left to redo, so that falls to us — after the
 * keymap, since ProseMirror skips its own handling of a key already prevented.
 */
const HostKeys = Extension.create({
  name: 'proseHostKeys',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('proseHostKeys'),
        // Registered after the view's own keydown listener, so it runs after it.
        view: (editorView) => {
          const keep = (event: KeyboardEvent): void => {
            const code = shimKey(event);
            if (!code) return;
            event.stopPropagation();
            if (code !== SELECT_ALL) event.preventDefault();
          };
          editorView.dom.addEventListener('keydown', keep);
          return { destroy: () => editorView.dom.removeEventListener('keydown', keep) };
        }
      })
    ];
  }
});

const SELECT_ALL = 65;

/** Z, Y or A under Cmd or Ctrl (AltGr excluded): the key's code, or 0. */
const shimKey = (event: KeyboardEvent): number =>
  (event.metaKey || event.ctrlKey) && !event.altKey && [90, 89, SELECT_ALL].includes(event.keyCode)
    ? event.keyCode
    : 0;

/** What tiptap-markdown hands a node serializer; `write` is unescaped. */
type MarkdownState = { write(content?: string): void };

/**
 * The bytes, written as they are. prosemirror-markdown 1.13.8's `text(t,
 * false)` still escapes a `!` when the next text call starts with `[`, so
 * `Hi!` before an image chip would be sent as `Hi\![Image #1]`. `write()`
 * puts the block prefix (`> `, a list's indent) before each line.
 */
function writeRaw(state: MarkdownState, text: string): void {
  const all = text.split('\n');
  all.forEach((line, i) => state.write(i < all.length - 1 ? `${line}\n` : line));
}

const CHIP = 'chip';

/** U+FFFC, the object replacement character: a chip in a textblock's text. */
const OBJECT = '\uFFFC';

type ChipAttrs = { kind: ChipKind; expansion: string; attachmentId: string | null };

/** Inline offsets match document positions: chips use `OBJECT`, hard breaks use newline. */
const inlineText = (block: PMNode): string =>
  block.textBetween(0, block.content.size, undefined, (leaf) =>
    leaf.type.name === CHIP ? OBJECT : '\n'
  );

/**
 * A mention or an attachment, atomic: one Backspace removes it, its label is
 * what the reader sees, and its expansion is what is sent. The label is
 * derived from the expansion on every draw, never stored, so a snapshot holds only what a send needs.
 */
const Chip = Node.create<{ read: () => ProseOptions }>({
  name: CHIP,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { read: () => ({ mode: 'rich' }) };
  },
  addAttributes() {
    return {
      kind: { default: 'skill', rendered: false },
      expansion: { default: '', rendered: false },
      attachmentId: { default: null, rendered: false }
    };
  },
  // Never read back from HTML: a pasted chip, ours or another editor's, is its
  // text, and forms only by the rule typed text does.
  parseHTML: () => [],
  renderHTML({ node }) {
    const attrs = node.attrs as ChipAttrs;
    return [
      'span',
      { class: `pchip ${attrs.kind}`, contenteditable: 'false' },
      chipLabel(attrs, this.options.read())
    ];
  },
  renderText: ({ node }) => (node.attrs as ChipAttrs).expansion,
  // Drawn by a view of its own so its label can be drawn again without the
  // node changing: a session chip names its card, and a card is renamed under
  // a chip already in the box (`Prose.update`).
  addNodeView() {
    const { read } = this.options;
    const views = (this.storage as ChipStorage).views;
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.contentEditable = 'false';
      let shown = node;
      // Relabel runs on every push. Avoid writing unchanged labels.
      const draw = (): void => {
        const attrs = shown.attrs as ChipAttrs;
        const cls = `pchip ${attrs.kind}`;
        const label = chipLabel(attrs, read());
        if (dom.className !== cls) dom.className = cls;
        if (dom.textContent !== label) dom.textContent = label;
      };
      draw();
      const chip: ChipView = {
        dom,
        update: (next) => {
          if (next.type !== shown.type) return false;
          shown = next;
          draw();
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => views.delete(chip),
        relabel: draw
      };
      views.add(chip);
      return chip;
    };
  },
  addStorage() {
    return {
      views: new Set<ChipView>(),
      markdown: {
        serialize: (state: MarkdownState, node: PMNode) =>
          writeRaw(state, (node.attrs as ChipAttrs).expansion)
      }
    };
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => removeChip(this.editor.view, -1),
      Delete: () => removeChip(this.editor.view, 1)
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('proseChipClipboard'),
        props: { clipboardSerializer: clipboardSerializer(this.editor.schema) }
      }),
      formation(this.options.read),
      numbering()
    ];
  }
});

type ChipView = {
  dom: HTMLElement;
  update(node: PMNode): boolean;
  ignoreMutation(): boolean;
  destroy(): void;
  relabel(): void;
};

type ChipStorage = { views: Set<ChipView> };

const chipViews = (editor: Editor): Set<ChipView> =>
  (editor.storage as unknown as { chip?: ChipStorage }).chip?.views ?? new Set();

function chipLabel(attrs: ChipAttrs, options: ProseOptions): string {
  const { kind, expansion } = attrs;
  if (kind === 'image') return expansion;
  if (kind === 'file') return `@${localPath.pathLeaf(expansion)}`;
  const hit = mentionOf(expansion);
  return hit ? pillPresentation(hit, options.sessionName).label : expansion;
}

/**
 * The chip beside an empty caret, whole. A browser's own Backspace over an
 * uneditable inline varies by engine; this one is the editor's.
 */
function removeChip(view: EditorView, side: -1 | 1): boolean {
  const { selection } = view.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const chip = side < 0 ? $from.nodeBefore : $from.nodeAfter;
  if (chip?.type.name !== CHIP) return false;
  const from = side < 0 ? $from.pos - chip.nodeSize : $from.pos;
  // Its own Undo step, so one Undo brings back exactly the chip.
  view.dispatch(closeHistory(view.state.tr.delete(from, from + chip.nodeSize)));
  return true;
}

/**
 * Copy and cut preserve existing mention expansions. Tickets use a normal
 * link outside Squadron and validated HTML metadata for an internal paste.
 */
function clipboardSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  return new DOMSerializer(
    {
      ...base.nodes,
      [CHIP]: (node) =>
        mentionClipboard.clipboardLink((node.attrs as ChipAttrs).expansion) ?? [
          'span',
          (node.attrs as ChipAttrs).expansion
        ]
    },
    base.marks
  );
}

function clipboardContent(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.type.name === CHIP) {
      const attrs = node.attrs as ChipAttrs;
      const hit = mentionOf(attrs.expansion);
      nodes.push(
        hit?.kind === 'ticket'
          ? node.type.create({ ...attrs, expansion: hit.url }, null, node.marks)
          : node
      );
    } else nodes.push(node.isLeaf ? node : node.copy(clipboardContent(node.content)));
  });
  return Fragment.fromArray(nodes);
}

/**
 * Each image chip says the number its place in the document gives it, which
 * is the one its send gives it (`capture`), so deleting an earlier image
 * renumbers the ones after it. Appended to every
 * change, an Undo's included, and so part of that change's Undo step.
 */
const numbering = (): Plugin =>
  new Plugin({
    key: new PluginKey('proseImageNumbers'),
    appendTransaction: (trs, _old, state) =>
      trs.some((tr) => tr.docChanged) ? renumber(state) : null
  });

function renumber(state: EditorState): Transaction | null {
  let n = 0;
  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    const attrs = node.attrs as ChipAttrs;
    if (node.type.name !== CHIP || attrs.kind !== 'image') return;
    const expansion = `[Image #${++n}]`;
    if (attrs.expansion !== expansion) {
      tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, { ...attrs, expansion });
    }
  });
  return tr;
}

/** A document with its image chips numbered, for a new state: a restore or a
 *  merge installs one with no transaction for `numbering` to follow. */
const numbered = (doc: PMNode): PMNode => renumber(EditorState.create({ doc }))?.doc ?? doc;

type Span = { from: number; to: number };

type Formable = Span & { kind: MentionKind; expansion: string };

const formationKey = new PluginKey<Span[]>('proseChipFormation');

/**
 * Text becomes a chip once it is complete, in a transaction of its own, so
 * Undo straight after gives the text back. Complete: a session reference at
 * its `]`, a model expansion at its `)`, a skill phrase once a non-word
 * character (`WORD`) follows it. Never in code, never while an IME is
 * composing (it forms at the composition's end), never on import or restore,
 * which make no transaction.
 *
 * The plugin's state is the spans held as text: what an Undo turned back into
 * text, so the reader's Undo is not undone by the next keystroke, and what a
 * new state (an import, a restore) already held. Each stays text until it is
 * edited.
 */
function formation(read: () => ProseOptions): Plugin<Span[]> {
  let view: EditorView | undefined;
  const skills = (): readonly string[] => read().skills ?? [];
  return new Plugin<Span[]>({
    key: formationKey,
    state: {
      init: (_config, state) => spansOf(mentionsIn(state, [whole(state.doc)], skills())),
      apply: (tr, quiet, _old, state) => {
        const kept = quiet.flatMap((span) => {
          const held = heldThrough(tr, span);
          return held ? [held] : [];
        });
        if (!isHistoryTransaction(tr)) return kept;
        return [...kept, ...spansOf(formable(state, touched([tr]), skills()))];
      }
    },
    appendTransaction: (trs, _old, state) => {
      if (!view || view.composing) return null;
      if (!trs.some((tr) => tr.docChanged) || trs.some(isHistoryTransaction)) return null;
      return formChips(state, touched(trs), skills());
    },
    view: (editorView) => {
      view = editorView;
      // A microtask after ProseMirror's own handler, which registered first,
      // clears `composing` and queues its flush of what the composition left
      // in the DOM: a dispatch before that flush would redraw under it.
      const settle = (): void =>
        queueMicrotask(() => {
          if (editorView.isDestroyed) return;
          const { state } = editorView;
          const tr = formChips(state, [state.selection], skills());
          if (tr) editorView.dispatch(tr);
        });
      editorView.dom.addEventListener('compositionend', settle);
      return { destroy: () => editorView.dom.removeEventListener('compositionend', settle) };
    }
  });
}

/** Edits inside a held span release it even at equal length. Typing beside either edge does not. */
function heldThrough(tr: Transaction, span: Span): Span | undefined {
  let { from, to } = span;
  for (const map of tr.mapping.maps) {
    let edited = false;
    map.forEach((start, end) => {
      if (start < to && end > from) edited = true;
    });
    if (edited) return undefined;
    from = map.map(from, 1);
    to = map.map(to, -1);
  }
  return { from, to };
}

function formChips(
  state: EditorState,
  spans: Span[],
  skills: readonly string[],
  imported = false
): Transaction | null {
  const quiet = formationKey.getState(state) ?? [];
  const due = formable(state, spans, skills, imported).filter(
    (hit) => !quiet.some((span) => span.from === hit.from && span.to === hit.to)
  );
  if (!due.length) return null;
  const type = nodeType(state.schema, CHIP);
  const tr = state.tr;
  for (const hit of due.sort((a, b) => b.from - a.from)) {
    const marks = state.doc.resolve(hit.from + 1).marks();
    const attrs: ChipAttrs = { kind: hit.kind, expansion: hit.expansion, attachmentId: null };
    tr.replaceWith(hit.from, hit.to, type.create(attrs, null, marks));
  }
  return closeHistory(tr);
}

/**
 * Imported text forms its chips once, before any history holds it, so no
 * Undo turns them back (orchestrator decision). No caret is typing in it,
 * so a phrase that ends its block is complete, and a lone backtick opens
 * no code span.
 */
function formAll(doc: PMNode, skills: readonly string[]): PMNode {
  const state = EditorState.create({ doc, selection: new AllSelection(doc) });
  return formChips(state, [whole(doc)], skills, true)?.doc ?? doc;
}

const formable = (
  state: EditorState,
  spans: readonly Span[],
  skills: readonly string[],
  imported = false
): Formable[] => mentionsIn(state, spans, skills, imported).filter((hit) => hit.closed);

/** Every mention in the textblocks `spans` touch, outside code, and whether
 *  it is complete. `imported`: nobody is typing, so an unmatched backtick is
 *  a character rather than a code span still open (`inOpenCode`). */
function mentionsIn(
  state: EditorState,
  spans: readonly Span[],
  skills: readonly string[],
  imported = false
): (Formable & { closed: boolean })[] {
  const { doc } = state;
  const code = state.schema.marks['code'];
  const out: (Formable & { closed: boolean })[] = [];
  const { $head } = state.selection;
  for (const [start, block] of textblocks(doc, spans)) {
    if (block.type.spec.code) continue;
    const text = inlineText(block);
    // Leaving the block completes a skill phrase, as Enter or Shift+Enter does.
    const left = !$head.parent.isTextblock || $head.start() !== start;
    for (const hit of findMentions(text, skills)) {
      const end = hit.at + hit.text.length;
      const closed =
        hit.kind !== 'skill' || (end < text.length ? !WORD.test(text.charAt(end)) : left);
      if (hit.text.includes(OBJECT)) continue;
      const from = start + hit.at;
      const to = start + end;
      if (code && doc.rangeHasMark(from, to, code)) continue;
      if (!imported && inOpenCode(state, from)) continue;
      out.push({ from, to, kind: hit.kind, expansion: hit.text, closed });
    }
  }
  return out;
}

const whole = (doc: PMNode): Span => ({ from: 0, to: doc.content.size });

const spansOf = (hits: readonly Formable[]): Span[] => hits.map(({ from, to }) => ({ from, to }));

function textblocks(doc: PMNode, spans: readonly Span[]): Map<number, PMNode> {
  const blocks = new Map<number, PMNode>();
  const size = doc.content.size;
  for (const span of spans) {
    const from = Math.min(span.from, size);
    const to = Math.min(Math.max(span.to, from), size);
    for (const $pos of [doc.resolve(from), doc.resolve(to)]) {
      if ($pos.parent.isTextblock) blocks.set($pos.start(), $pos.parent);
    }
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      blocks.set(pos + 1, node);
      return false;
    });
  }
  return blocks;
}

function touched(trs: readonly Transaction[]): Span[] {
  const spans: Span[] = [];
  trs.forEach((tr, i) => {
    tr.mapping.maps.forEach((map, j) => {
      map.forEach((_oldFrom, _oldTo, from, to) => {
        let span = {
          from: tr.mapping.slice(j + 1).map(from, -1),
          to: tr.mapping.slice(j + 1).map(to, 1)
        };
        for (const later of trs.slice(i + 1)) {
          span = { from: later.mapping.map(span.from, -1), to: later.mapping.map(span.to, 1) };
        }
        spans.push(span);
      });
    });
  });
  return spans;
}

const RawText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize: (state: MarkdownState, node: PMNode) => writeRaw(state, node.text ?? '')
      }
    };
  }
});

/**
 * Every hard break is a newline the reader typed or pasted: a bare `\n`, not
 * CommonMark's backslash break. Shift+Enter makes one only in a plain
 * paragraph; in a list or a code block it is the editor's own Enter, and on
 * an empty line of a quote it leaves the quote.
 * HardBreak's Mod-Enter binding is not kept, so Mod-Enter is the core
 * keymap's: it leaves a code block and does nothing elsewhere. A caller that
 * sends on it claims it in `onKey` first.
 */
const RawHardBreak = HardBreak.extend({
  addStorage() {
    return { markdown: { serialize: (state: MarkdownState) => writeRaw(state, '\n') } };
  },
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': () => {
        const { commands, state } = this.editor;
        const { $from } = state.selection;
        if ($from.parent.type.spec.code) return commands.newlineInCode();
        if (blocks.inList($from)) {
          const emptyItem =
            state.selection.empty &&
            $from.parent.content.size === 0 &&
            $from.node(-1).type.name === 'listItem';
          return commands.first(({ commands: c }) => [
            () => c.splitListItem('listItem'),
            () => emptyItem && c.liftListItem('listItem'),
            // What the core keymap's Enter runs once the list item's declines:
            // a range across items, or a block nested inside one.
            () => c.newlineInCode(),
            () => c.createParagraphNear(),
            () => c.liftEmptyBlock(),
            () => c.splitBlock()
          ]);
        }
        // Quill's 'blockquote empty enter', on Shift since Enter sends.
        if (blocks.onEmptyQuotedLine(state.selection)) {
          return this.editor
            .chain()
            .command(({ tr }) => (blocks.cutLines(tr, false), true))
            .lift('blockquote')
            .run();
        }
        return commands.setHardBreak();
      }
    };
  }
});

/**
 * Constructs with no node keep their source: their markdown-it rule is off,
 * so they parse as text. `link` is here because there is no link node, and
 * with only `image` off, `![alt](url)` lost its source to a link. Indented
 * code stays on: it loads as a code block and is sent as a fence.
 */
const OFF = [
  'heading',
  'lheading',
  'table',
  'hr',
  'reference',
  'html_block',
  'image',
  'link',
  'autolink',
  'html_inline',
  'entity'
];

const ConstrainedParser = Extension.create({
  name: 'proseMarkdownRules',
  addStorage() {
    return {
      markdown: { parse: { setup: (md: { disable(rules: string[]): void }) => md.disable(OFF) } }
    };
  }
});

/** The star rule only: `_x_` would be sent as `*x*`. */
function starOnly(mark: typeof Bold | typeof Italic, star: RegExp): AnyExtension {
  return mark.extend({
    addInputRules() {
      return (this.parent?.() ?? []).filter((rule) => rule.find === star).map(guard);
    }
  });
}

/**
 * A mark rule that holds back where typed text would not be sent as typed:
 * inside a code span still open (typed `` `a *b* c` `` lost its stars), and
 * where the markers are not flanking (`2 * 3 * 4` turned italic and was sent
 * as `2 *3* 4`).
 */
function guard(rule: InputRule): InputRule {
  return new InputRule({
    find: rule.find,
    undoable: rule.undoable,
    handler: (props) => {
      const inner = props.match[2] ?? '';
      if (/^\s|\s$/.test(inner) || inOpenCode(props.state, props.range.from)) return null;
      return rule.handler(props);
    }
  });
}

/**
 * An odd number of backticks before `from` in its textblock, outside text that
 * is already code: a code span is still open there. A closed span's own
 * backticks (the middle one of ``a`b``) are its content, not markers.
 */
function inOpenCode(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from);
  let ticks = 0;
  $from.parent.forEach((child, offset) => {
    if (offset >= $from.parentOffset || !child.isText) return;
    if (child.marks.some((mark) => mark.type.name === 'code')) return;
    ticks += (child.text ?? '').slice(0, $from.parentOffset - offset).split('`').length - 1;
  });
  return ticks % 2 === 1;
}

type MarkdownStorage = {
  getMarkdown(): string;
  parser: { parse(md: string): string };
  serializer: { serialize(doc: PMNode | Fragment): string };
};

const markdownStorage = (editor: Editor): MarkdownStorage =>
  (editor.storage as unknown as { markdown: MarkdownStorage }).markdown;

const markdownOf = (editor: Editor): string => markdownStorage(editor).getMarkdown();

/**
 * tiptap-markdown builds its parser on an editor, so one is kept with
 * `element: null` and never mounted — a row is not an editor. Measured in
 * Proof A (`TASK_done_prose_input.md`).
 */
let deliveryEditor: Editor | undefined;

function unmounted(): Editor {
  if (!deliveryEditor || deliveryEditor.isDestroyed) {
    deliveryEditor = new Editor({
      element: null,
      content: '',
      extensions: richExtensions(() => ({ mode: 'rich' })),
      injectCSS: false,
      enablePasteRules: false
    });
  }
  return deliveryEditor;
}

/**
 * A rich snapshot's delivery text, as `value()` would read it mounted: what a
 * send puts on the wire once its image chips are numbered (`capture`). Throws
 * on a snapshot that does not fit the rich schema.
 */
export function deliveryOf(snapshot: ProseSnapshot): string {
  const editor = unmounted();
  const doc = editor.schema.nodeFromJSON(snapshot);
  doc.check();
  return markdownStorage(editor).serializer.serialize(doc);
}

/** Markdown as a rich snapshot, parsed as `importMarkdown` parses it: for a
 *  caller appending blocks to a record rather than to a mounted editor. Every
 *  mention it names is a chip, formed once (`formAll`). */
export function markdownDoc(
  md: string,
  skills: readonly string[] = []
): ProseSnapshot & {
  type: 'doc';
  content: ProseSnapshot[];
} {
  const editor = unmounted();
  const parsed = createDocument(markdownStorage(editor).parser.parse(md), editor.schema);
  const doc = formAll(parsed, skills);
  const content: ProseSnapshot[] = [];
  doc.forEach((block) => content.push(block.toJSON() as ProseSnapshot));
  return { type: 'doc', content };
}

/**
 * A delivery string as HTML: the rich parser, then ProseMirror's DOM
 * serializer. No view. Not `createDocument`, as `markdownDoc` uses: its
 * `elementFromString` drops whitespace-only text, a blank code block's newline.
 */
export function proseHtml(md: string): string {
  const editor = unmounted();
  const html = markdownStorage(editor).parser.parse(md);
  const host = document.createElement('div');
  host.innerHTML = html;
  const doc = DOMParser.fromSchema(editor.schema).parse(host);
  const fragment = DOMSerializer.fromSchema(editor.schema).serializeFragment(doc.content);
  const out = document.createElement('div');
  out.append(fragment);
  return out.innerHTML;
}

const lines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

function plainDoc(schema: Schema, text: string): PMNode {
  const paragraph = nodeType(schema, 'paragraph');
  return nodeType(schema, 'doc').create(
    null,
    lines(text).map((line) => paragraph.create(null, line ? schema.text(line) : null))
  );
}

function plainText(doc: PMNode): string {
  const out: string[] = [];
  doc.forEach((paragraph) => out.push(paragraph.textContent));
  return out.join('\n');
}

function nodeType(schema: Schema, name: string): NonNullable<Schema['nodes'][string]> {
  const type = schema.nodes[name];
  if (!type) throw new Error(`prose schema has no ${name} node`);
  return type;
}

function typeText(editor: Editor, text: string): void {
  if (text.includes('\n')) throw new Error('type() takes one line; a newline is a key');
  for (const ch of text) {
    const { view } = editor;
    if (!view.editable) return;
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(ch, from, to);
    if (!view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert))) {
      view.dispatch(insert());
    }
  }
}

/** Tests cannot import the bundle's module instance. Mount through this and read the host's `prose`. */
Object.assign(globalThis, { squadronProse: { create: createProse, markdownDoc } });
