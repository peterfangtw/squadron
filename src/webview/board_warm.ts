import { cards } from './state';

const observed = new Set<Element>();
let observer: IntersectionObserver | undefined;

/** Keep viewport state through both board paints and the rename ticker's morph. */
export function carry(from: HTMLElement, to: HTMLElement): boolean {
  if (to.classList.contains('warming') && from.classList.contains('warm-visible')) {
    to.classList.add('warm-visible');
  }
  return true;
}

/** Observe only live warm cues; a finished or removed card releases its observer. */
export function sync(): void {
  const active = new Set(cards.querySelectorAll('.card.warming'));
  for (const node of observed) {
    if (active.has(node)) continue;
    observer?.unobserve(node);
    node.classList.remove('warm-visible');
    observed.delete(node);
  }
  if (!active.size) return;
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (observed.has(entry.target)) {
            entry.target.classList.toggle('warm-visible', entry.isIntersecting);
          }
        }
      },
      { root: cards }
    );
  }
  for (const node of active) {
    if (observed.has(node)) continue;
    observed.add(node);
    observer.observe(node);
  }
}
