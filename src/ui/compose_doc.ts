/**
 * A compose box's document as plain data: the editor's snapshot, which is the
 * local record of what the reader wrote. Structurally ProseMirror's JSON, so
 * `webview/prose.ts`' snapshot passes for one, without `ui/` importing TipTap.
 */
export type ComposeMark = { type: string; attrs?: Record<string, unknown> };

export type ComposeNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: ComposeNode[];
  marks?: ComposeMark[];
  text?: string;
};

export type ComposeDoc = ComposeNode & { type: 'doc'; content: ComposeNode[] };

/**
 * What a chip's attachment id names: an image's bytes, which the document
 * cannot hold. A file chip carries its path as its expansion and pools nothing.
 */
export type Attachment = { kind: 'image'; image: ComposerImage };

/**
 * Every attachment an owner's box has held since its history was last reset,
 * by id. A deleted chip's entry stays so Undo can bring it back; nothing reads
 * the pool to decide what is attached or sent.
 */
export type AttachmentPool = Readonly<Record<string, Attachment>>;

/** What a send captures from one traversal of the document. */
export type Captured = {
  /** The document with each image chip numbered in order, for the delivery. */
  wire: ComposeDoc;
  /** The wire images, in the order their `[Image #n]` numbers say. */
  images: ComposerImage[];
  /** The pool entries the document names, and no others. */
  attachments: AttachmentPool;
};

const CHIP = 'chip';
const PARAGRAPH = 'paragraph';

/** True when a document, or any node of one, holds no text but whitespace
 *  and no chip. */
export const blank = (root: ComposeNode): boolean => {
  for (const node of walk(root)) {
    if (node.type === CHIP) return false;
    if (node.text !== undefined && node.text.trim() !== '') return false;
  }
  return true;
};

export function showComposeHint(doc: ComposeDoc): boolean {
  return (
    blank(doc) && doc.content.every((node) => node.type === PARAGRAPH || node.type === 'codeBlock')
  );
}

/** Structural equality: two documents that deliver the same text can differ. */
export function sameDoc(a: ComposeDoc | undefined, b: ComposeDoc | undefined): boolean {
  return same(a, b);
}

/**
 * `from`'s blocks after `into`'s, neither block opened to the other: a quote,
 * a list or a fence ending `into` stays closed, where joining the two as
 * strings carried `from`'s first line inside it. A paragraph at the seam that
 * `blank` would call empty goes, so an empty box takes `from` whole.
 */
export function appendBlocks(
  into: ComposeDoc | undefined,
  from: ComposeDoc | undefined
): ComposeDoc | undefined {
  if (!into || !from) return into ?? from;
  const head = [...into.content];
  while (head.length && blankParagraph(head[head.length - 1])) head.pop();
  const tail = [...from.content];
  while (tail.length && blankParagraph(tail[0])) tail.shift();
  const content = [...head, ...tail];
  return { type: 'doc', content: content.length ? content : [{ type: PARAGRAPH }] };
}

/**
 * One traversal: each image chip numbered in document order, its bytes taken
 * from the pool as a wire image and kept for a refusal to restore. An image
 * chip whose bytes are not pooled is dropped from the wire rather than sent as
 * a marker with no image.
 */
export function capture(doc: ComposeDoc, pool: AttachmentPool): Captured {
  const images: ComposerImage[] = [];
  const attachments: Record<string, Attachment> = {};
  const visit = (node: ComposeNode): ComposeNode[] => {
    const id = attachmentOf(node);
    if (node.type === CHIP && node.attrs?.kind === 'image') {
      const entry = id === undefined ? undefined : pool[id];
      if (id === undefined || !entry) return [];
      attachments[id] = entry;
      images.push(entry.image);
      return [{ ...node, attrs: { ...node.attrs, expansion: `[Image #${images.length}]` } }];
    }
    return node.content ? [{ ...node, content: node.content.flatMap(visit) }] : [node];
  };
  return { wire: { type: 'doc', content: doc.content.flatMap(visit) }, images, attachments };
}

/** The attachment ids the document's chips name. */
export function attachmentIds(doc: ComposeDoc): Set<string> {
  const ids = new Set<string>();
  for (const node of walk(doc)) {
    const id = attachmentOf(node);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

function* walk(node: ComposeNode): Generator<ComposeNode> {
  yield node;
  for (const child of node.content ?? []) yield* walk(child);
}

const attachmentOf = (node: ComposeNode): string | undefined => {
  const id = node.attrs?.attachmentId;
  return node.type === CHIP && typeof id === 'string' ? id : undefined;
};

const blankParagraph = (node: ComposeNode | undefined): boolean =>
  node?.type === PARAGRAPH && blank(node);

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => same(item, b[i]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && same(left[key], right[key]))
  );
};
