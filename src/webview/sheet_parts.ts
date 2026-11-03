import { el } from './dom';

export function columnHead(key: string, title: string): HTMLElement {
  const head = el('div', 'column-head');
  head.dataset.key = key;
  head.append(el('h3', 'column-title', title));
  return head;
}
