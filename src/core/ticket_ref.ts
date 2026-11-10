import * as web from './web';

export type TicketRef = { identifier: string; url: string };

export function ticketRef(identifier: string, url: string): string | undefined {
  if (!/^[^[\]\s\p{Cc}]{1,128}$/u.test(identifier)) return undefined;
  const target = web.webUri(url);
  if (!target || target.username || target.password || /[\s\p{Cc}]/u.test(url)) return undefined;
  const encoded = target.href.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  return encoded.length <= 8192 ? `@ticket[${identifier}][${encoded}]` : undefined;
}

/**
 * The number a person says a ticket by, off any source's identifier: Linear's
 * `ENG-42` as it is, GitHub's `acme/acme-web#42` as `#42`. An identifier in
 * neither shape is returned whole.
 */
export function ticketNumber(identifier: string): string {
  return /(?:[A-Za-z][A-Za-z0-9]*-\d+|#\d+)$/.exec(identifier)?.[0] ?? identifier;
}

const REF = /@ticket\[([^[\]\s]{1,128})\]\[([^[\]\s]{1,8192})\]/gu;

export function findTickets(text: string): (TicketRef & { at: number; text: string })[] {
  return [...text.matchAll(REF)].flatMap((match) => {
    const identifier = match[1] ?? '';
    const url = match[2] ?? '';
    return ticketRef(identifier, url) ? [{ at: match.index, text: match[0], identifier, url }] : [];
  });
}
