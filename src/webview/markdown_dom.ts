import DOMPurify from 'dompurify';
import * as fileLinks from '../ui/file_link';

let allowLocalFiles = false;
const turnPurifier = DOMPurify(window);
turnPurifier.addHook('uponSanitizeAttribute', (node, data) => {
  if (!allowLocalFiles || node.nodeName !== 'A' || data.attrName !== 'href') return;
  const target = fileLinks.fileLink(data.attrValue, '/');
  if (!target) return;
  // Only the local-file parser can override URI filtering. Preserve spelling:
  // rewriting a drive or authority as a relative URL loses its root.
  data.forceKeepAttr = true;
});

/**
 * A turn's markup, sanitized before it reaches the document. The engine passes
 * raw HTML through and a turn is model output, so this is hostile input by
 * default, and the guarantee is DOMPurify's allowlist: what it does not name
 * does not survive, so a tag or an attribute nobody here thought of is refused
 * rather than waited for. That is the whole reason this is not a hand-rolled
 * strip — the last one walked the parsed tree's descendants, which never
 * reaches a `<template>`'s content, and no patch to a denylist fixes that
 * class of thing.
 *
 * `style` and `form` are forbidden *on top of* that allowlist, because
 * DOMPurify permits both by default and this panel wants neither. The style
 * strip is a product choice rather than a security one: a turn could reskin or
 * cover the panel, and the cost is the alignment a markdown table asks for,
 * which is a fair trade since the dock sets its own.
 *
 * `form` needs its contents forbidden as well: removing a tag hoists its
 * children unless the tag says otherwise, and `input` and `button` are both
 * allowed, so the form would go and its controls would stay. The denylist took
 * the subtree — and the dock draws its own dialogs in this same stream, so a
 * turn that can leave a control standing can draw one the reader might answer.
 *
 * `data-*` is refused too, and that one is about this panel rather than about
 * HTML: `board.ts` and `tickets.ts` delegate every handler off a container and
 * read `data-act` and `data-pid` off whatever the press landed on, and `kit.ts`
 * keys its morphs by `data-key`. DOMPurify allows data attributes by default,
 * so a turn carrying `data-act="close" data-pid=N` is a forged instruction the
 * day anything delegating or morphing reaches `#thread`. Nothing here spends a
 * data attribute of its own, so the refusal costs nothing and does not wait for
 * that day to arrive.
 *
 * `title` is refused for H23's reason rather than for any of the above. The
 * panel stopped writing native tooltips and draws its own — but DOMPurify
 * allows `title` by default, and `[x](url "hover")` is ordinary markdown, so a
 * turn could pop the host's slow unthemed one right beside ours in the same
 * column. The invariant is about what the dock *draws*, not only about what
 * this codebase writes, and the source guard in `webview.test.ts` can never see
 * this half of it — the offending string is in a model's output, not in a file.
 * What it costs is the hover text on a markdown link and an `<abbr>`, which is
 * nothing that has ever appeared in a turn.
 *
 * The CSP is unchanged and still doing its own job — `document.ts` serves this
 * webview under a nonce, which is what stops a smuggled image from reaching
 * the network. This is the layer above it, not a replacement for it.
 */
export function sanitized(html: string, localFiles = false): DocumentFragment {
  allowLocalFiles = localFiles;
  return turnPurifier.sanitize(html, {
    FORBID_TAGS: localFiles
      ? ['style', 'form']
      : ['style', 'form', 'button', 'input', 'textarea', 'select', 'iframe'],
    ADD_FORBID_CONTENTS: ['form'],
    FORBID_ATTR: localFiles ? ['style', 'title'] : ['style', 'title', 'id', 'name', 'tabindex'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true
  });
}
