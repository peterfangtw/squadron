/**
 * The shared formatting toolbar: one control per format over one prose
 * editor. What a control applies, whether it is on and what stops it are the
 * editor's (`Prose.formats`). One tab stop, walked by the arrows, Home and End.
 */

import { FORMATS } from './prose';
import * as formatting from '../ui/format_controls';
import type { FormatBlock, Prose, ProseFormat, ProseFormats } from './prose';

export type Formatbar = { paint(formats: ProseFormats): void };

/** A control's tip: its label, or why it is refused. */
export type FormatTip = (label: string, blocked: FormatBlock | null) => string;

export function attachFormatbar(
  bar: HTMLElement,
  prose: Pick<Prose, 'format' | 'focus'>,
  options: { formats?: readonly ProseFormat[]; tip?: FormatTip } = {}
): Formatbar {
  bar.classList.add('formatbar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Text formatting');
  if (options.formats) bar.innerHTML = formatting.formatControls(options.formats);
  const tip = options.tip ?? formatTip;
  const controls = [...bar.querySelectorAll<HTMLButtonElement>('button[data-format]')];

  // A press anywhere on the bar, its gaps included, would move focus and take
  // the selection it is for with it.
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const control = e.target instanceof Element ? e.target.closest('button') : null;
    const format = control ? formatOf(control) : undefined;
    if (!control || !format || control.getAttribute('aria-disabled') === 'true') return;
    prose.format(format);
    // A key's press leaves focus on the control; the reader goes on typing.
    prose.focus();
  });
  bar.addEventListener('keydown', (e) => {
    const at = controls.indexOf(e.target as HTMLButtonElement);
    const next = at < 0 ? undefined : step(e.key, at, controls.length);
    if (next === undefined) return;
    e.preventDefault();
    controls.forEach((control, i) => (control.tabIndex = i === next ? 0 : -1));
    controls[next]?.focus();
  });

  return {
    paint: (formats) => {
      for (const control of controls) {
        const format = formatOf(control);
        if (!format) continue;
        const { active, blocked } = formats[format];
        control.setAttribute('aria-pressed', String(active));
        if (blocked) control.setAttribute('aria-disabled', 'true');
        else control.removeAttribute('aria-disabled');
        control.dataset.tip = tip(control.getAttribute('aria-label') ?? '', blocked);
      }
    }
  };
}

const formatOf = (control: HTMLElement): ProseFormat | undefined =>
  FORMATS.find((format) => format === control.dataset.format);

/** Where a key moves the tab stop, wrapping at either end. */
function step(key: string, at: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowLeft':
      return (at - 1 + count) % count;
    case 'ArrowRight':
      return (at + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

function formatTip(label: string, blocked: FormatBlock | null): string {
  return blocked === 'chip' ? `${label}: a code block cannot hold a mention or attachment` : label;
}
