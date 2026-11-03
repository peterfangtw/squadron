/**
 * A whole-number field, typed and nothing else. The interaction rules are an
 * in-house React `NumberInput`'s, cut to
 * an integer that commits on blur: its wheel, stepper, clear button, keypad
 * and thousands grouping are left out, and the wheel is refused rather than
 * defaulted off.
 *
 * `type=text`, because Chromium steps a focused `type=number` on the wheel and
 * draws spin buttons; `inputmode=numeric` still brings up the digit keyboard.
 */

import { el, imeKey } from './dom';

/** A number being typed: digits with at most one point, or nothing yet. The
 *  point stays visible while typing, since refusing it would turn "32.5" into
 *  325. Blur rounds it away. */
const SHAPE = /^\d*\.?\d*$/;

export function numInput(o: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (value: number) => void;
}): HTMLInputElement {
  const input = el('input', 'num') as HTMLInputElement;
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', o.label);
  input.value = String(o.value);
  // The figure the field stands for. An attribute, not a closure: a morph keeps
  // this node and copies only the next paint's attributes onto it, so a
  // captured value would still say the first push.
  input.dataset.value = String(o.value);

  let typed = input.value;
  input.addEventListener('focus', () => {
    typed = input.value;
  });
  // Keystrokes stay text until blur. One that leaves no number shape is undone.
  input.addEventListener('input', () => {
    if (SHAPE.test(input.value)) typed = input.value;
    else input.value = typed;
  });
  input.addEventListener('keydown', (e) => {
    if (imeKey(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      // The draft goes, and the surface the field sits in stays: the sheet's
      // own Escape listener is on the document, past this one.
      e.preventDefault();
      e.stopPropagation();
      input.value = input.dataset.value ?? '';
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    const current = Number(input.dataset.value);
    const parsed = parseFloat(input.value);
    // An emptied field is a change of mind, not a request for the minimum.
    if (Number.isNaN(parsed)) {
      input.value = String(current);
      return;
    }
    // Round before clamping, so 999.6 lands on the max rather than past it.
    const next = Math.min(o.max, Math.max(o.min, Math.round(parsed)));
    input.value = String(next);
    if (next === current) return;
    input.dataset.value = String(next);
    o.onCommit(next);
  });
  return input;
}
