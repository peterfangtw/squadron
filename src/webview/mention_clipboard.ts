import * as mentions from './mention_text';

const ATTRIBUTE = 'data-squadron-mention';

export function clipboardLink(expansion: string): HTMLElement | undefined {
  const hit = mentions.mentionOf(expansion);
  if (!hit || mentions.MENTIONS[hit.kind].clipboard !== 'link' || hit.kind !== 'ticket')
    return undefined;
  const link = document.createElement('a');
  link.href = hit.url;
  link.textContent = hit.identifier;
  link.setAttribute(ATTRIBUTE, expansion);
  return link;
}

/** Clipboard metadata is input, not authority: only a complete reference
 * agreeing with its visible link can become a mention. Code stays literal. */
export function restoreClipboardMentions(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const link of template.content.querySelectorAll(`a[${ATTRIBUTE}]`)) {
    const expansion = link.getAttribute(ATTRIBUTE) ?? '';
    const hit = mentions.mentionOf(expansion);
    if (
      hit?.kind === 'ticket' &&
      !link.closest('code, pre') &&
      link.getAttribute('href') === hit.url &&
      link.textContent === hit.identifier
    )
      link.replaceWith(document.createTextNode(expansion));
  }
  return template.innerHTML;
}

export async function copyMention(expansion: string): Promise<void> {
  const link = clipboardLink(expansion);
  const hit = mentions.mentionOf(expansion);
  if (!link || hit?.kind !== 'ticket') throw new Error('Cannot copy this ticket.');
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('Rich copy is unavailable. Open the ticket to copy its link.');
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([hit.url], { type: 'text/plain' }),
      'text/html': new Blob([link.outerHTML], { type: 'text/html' })
    })
  ]);
}
