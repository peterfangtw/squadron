import * as web from '../core/web';
import { el } from './dom';
import * as mentions from './mention_text';
import { findCard } from './board_card';
import { openTicketReference } from './ticket_details';

export function mentionPill(hit: mentions.MentionHit): HTMLElement {
  const view = mentions.pillPresentation(hit, (pid) => findCard(pid)?.card.name);
  const pill = el(hit.kind === 'ticket' ? 'button' : 'span', `sref ${view.className}`, view.label);
  pill.dataset.tip =
    hit.kind === 'session' ? hit.transcript : hit.kind === 'ticket' ? hit.url : hit.text;
  if (hit.kind === 'ticket') {
    (pill as HTMLButtonElement).type = 'button';
    pill.setAttribute('aria-label', `Open ticket ${hit.identifier}`);
    pill.onclick = (event) => {
      event.stopPropagation();
      openTicketReference(hit.text);
    };
  }
  return pill;
}

/** Markdown may decode a link's label and leave trailing URL punctuation
 * outside its anchor. Recover the complete validated token before recognition. */
export function restoreTicketText(root: HTMLElement): void {
  for (const link of root.querySelectorAll('a[href]')) {
    if (link.closest('code, pre')) continue;
    const before = link.previousSibling;
    const after = link.nextSibling;
    if (before?.nodeType !== Node.TEXT_NODE || after?.nodeType !== Node.TEXT_NODE) continue;
    const leading = before.textContent ?? '';
    const trailing = after.textContent ?? '';
    const prefix = /@ticket\[[^[\]\s]{1,128}\]\[$/u.exec(leading)?.[0];
    const suffix = /^([^[\]\s]{0,8192})\]/u.exec(trailing);
    const url = link.getAttribute('href');
    if (!prefix || !suffix || !url || !sameLinkTarget(link.textContent ?? '', url)) continue;
    const reference = prefix + url + (suffix[1] ?? '') + ']';
    if (mentions.mentionOf(reference)?.kind !== 'ticket') continue;
    before.textContent = leading.slice(0, -prefix.length) + reference;
    after.textContent = trailing.slice(suffix[0].length);
    link.remove();
  }
  root.normalize();
}

function sameLinkTarget(displayed: string, href: string): boolean {
  const visible = web.webUri(displayed);
  const target = web.webUri(href);
  if (!visible || !target) return false;
  try {
    return decodeURI(visible.href) === decodeURI(target.href);
  } catch {
    return visible.href === target.href;
  }
}
