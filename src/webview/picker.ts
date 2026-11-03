/**
 * One control for every filter and every sort the panel offers.
 *
 * A bar used to grow a bespoke pill per facet — the assignee menu and the status
 * menu were sixty lines of near-identical menu-building that had already drifted
 * apart in what a re-click meant. This takes the shape as a spec instead: what
 * the options are, whether one or many may be picked, whether they are worth
 * searching, and whether the pill also orders the list.
 *
 * It is a third layer, not a rewrite. `opensMenu` in `kit.ts` still owns the
 * popover — the toggle, the placement clamped inside the panel, the `openMenu`
 * handle the repaint guard reads — and this owns what goes in it.
 */

import { el } from './dom';
import { closeMenu, dropdownTrigger, heldOpen, menuItem, opensMenu, searchBox } from './kit';

/** Nothing, or the direction the list is ordered in. */
export type SortDir = 'asc' | 'desc' | null;

export type PickerOption = {
  /** Opaque to the picker; the caller reads it back in `onChange`. */
  id: string;
  label: string;
  /** A `dot()` variant drawn before the label, e.g. `p1` for a priority. */
  dot?: string;
  /** A dimmer second column on the row — a fact about the option, not its name.
   *  Drawn in the menu only; the pill says what was picked and nothing else. */
  sub?: string;
  /**
   * Shown, greyed, and unpickable — a port something else is already listening
   * on. Drawn rather than dropped because the gap is the information: a reader
   * needs to see that 3001 exists and is taken, not to wonder where it went.
   * `sub` is where the holder's name goes; there is no second field for it.
   */
  disabled?: boolean;
};

export type PickerSpec = {
  /** What the pill says when nothing is picked. */
  label: string;
  /** Which edge of the trigger anchors its menu. */
  align?: 'start' | 'end';
  /** Escape a scrolling container's clipping box. */
  floating?: boolean;
  /** The filter block. Omit for a pill that only sorts. */
  options?: PickerOption[];
  /** Ids picked right now. */
  value?: string[];
  /** Default `one`. `many` keeps the menu open across toggles. */
  select?: 'one' | 'many';
  /** Whether to offer a search box. Default: only past `SEARCH_ABOVE` options. */
  search?: boolean;
  /** Pill text for a multi-pick, e.g. `2 statuses`. Default `N selected`. */
  summary?: (count: number) => string;
  /**
   * The sort block. Omit for a pill that only filters. The direction labels are
   * the caller's, because `asc` is meaningless to a reader — a priority scale
   * ascends towards "least urgent", which is not what anyone would guess.
   */
  sort?: { dir: SortDir; asc: string; desc: string };
  /** Hover text for the pill. Default is its label, which is what a pill
   *  clipped to an ellipsis needs. */
  tip?: string;
  /**
   * A single action in the menu's footer, beside Clear — e.g. **New workflow…**.
   * Not an option: it never ticks and never becomes the pill's value. Author
   * entry (New) lives here so every workflow keeps one row, not attach + Edit.
   */
  footer?: { label: string; onClick: () => void };
  onChange: (next: { value: string[]; dir: SortDir }) => void;
};

/** The pill, plus the one thing a bar needs to arbitrate between several. */
export type Picker = HTMLElement & { clearSort: () => void; refresh: () => void };

/** Past this many options, a menu is worth searching without being asked.
 *  Exported for the bottom drawer, which is a list and not a menu and should
 *  still agree with every menu about when one is worth searching. */
export const SEARCH_ABOVE = 8;

/**
 * One direction of a sort. `menuItem` builds it, so a sort row and an option row
 * are the same row — the arrow keys, the hover, the picked paint and the radio
 * role all arrive already agreed rather than restated here and drifting.
 *
 * The direction glyph then rides *after* the label, the way `.sub` does on an
 * option: it says which way this row sorts whether or not the row is the chosen
 * one, so it is a fact about the option and not a mark on it — and a lead column
 * would put this block on a left edge of its own.
 */
function sortRow(glyph: string, label: string, on: boolean, onPick: () => void): HTMLElement {
  const row = menuItem(label, on, 'one', onPick);
  row.append(el('span', 'dir', glyph));
  return row;
}

export function picker(spec: PickerSpec): Picker {
  let options = spec.options ?? [];
  const many = spec.select === 'many';
  const control = dropdownTrigger(spec.label);
  const wrap = control.wrap as Picker;
  const pill = control.button;
  const arrow = el('span', 'sarr');
  pill.insertBefore(arrow, control.caret);

  // The live selection. Seeded from the spec on every rebuild of the bar, so the
  // authority is whatever the caller passed this time; mutated in place only for
  // as long as a menu is open, which is the only window in which no rebuild can
  // reach it.
  let value = [...(spec.value ?? [])];
  let dir: SortDir = spec.sort?.dir ?? null;

  const pillText = (): string => {
    if (options.length === 0 || value.length === 0) return spec.label;
    if (value.length === 1) {
      return options.find((o) => o.id === value[0])?.label ?? spec.label;
    }
    return spec.summary ? spec.summary(value.length) : `${value.length} selected`;
  };

  const relabel = (): void => {
    const text = pillText();
    arrow.textContent = dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '';
    // .nm is the shrink target for closed-pill ellipsis (bottom hub long names);
    // caret/arrow stay siblings so they never get clipped with the label.
    control.label.textContent = text;
    pill.classList.toggle('on', value.length > 0 || dir !== null);
    pill.dataset.tip = spec.tip ?? text;
  };

  const emit = (): void => {
    relabel();
    spec.onChange({ value: [...value], dir });
  };

  const menu = opensMenu(
    wrap,
    pill,
    spec.align ?? 'start',
    (body) => {
      // Built before the rows that toggle it: both blocks call `syncClear`, and a
      // Clear that only appeared on the next repaint would be a button that lied
      // for as long as the menu stayed open.
      const footRow = el('div', 'ffoot');
      const clear = el('button', 'fclear fbtn', 'Clear');
      const syncClear = (): void => {
        clear.hidden = value.length === 0 && dir === null;
        // Nothing to clear and no action to offer is an empty rule across the
        // bottom of the menu, so the whole footer goes with the last button in it.
        footRow.hidden = clear.hidden && spec.footer === undefined;
      };
      clear.onclick = () => {
        value = [];
        dir = null;
        closeMenu();
        emit();
      };

      // What the menu is, top to bottom: a search box that stays put, one block
      // that scrolls, and a footer that stays put. Only `.fscroll` is capped, so a
      // list of forty ports scrolls past a Clear that never leaves the screen —
      // which is what a menu whose whole body scrolled could not promise.
      const parts: HTMLElement[] = [];
      const scroll = el('div', 'fscroll');

      if (options.length > 0) {
        const rows = el('div', 'frows');
        const paint = (needle: string): void => {
          const hits = options.filter((o) => o.label.toLowerCase().includes(needle));
          if (hits.length === 0) {
            rows.replaceChildren(el('div', 'fnone', 'Nothing matches.'));
            return;
          }
          rows.replaceChildren(
            ...hits.map((o) => {
              const row = menuItem(
                o.label,
                value.includes(o.id),
                many ? 'many' : 'one',
                () => {
                  // A disabled row is drawn and skipped by the keyboard, and it
                  // refuses the click too: a menu is a delegated surface, and the
                  // one thing that must never happen is a pick nothing can honour.
                  if (o.disabled) return;
                  if (!many) {
                    // A re-pick of the current one clears it, the way the sort rows
                    // and the board's status tally already work.
                    value = value[0] === o.id ? [] : [o.id];
                    closeMenu();
                    emit();
                    return;
                  }
                  const on = value.includes(o.id);
                  value = on ? value.filter((v) => v !== o.id) : [...value, o.id];
                  // The menu stays open across toggles and the bar behind it is held
                  // still, so nothing else is going to repaint this row.
                  row.classList.toggle('on', !on);
                  row.setAttribute('aria-checked', String(!on));
                  syncClear();
                  emit();
                },
                o.dot
              );
              // A second column, dimmer, for a fact about the option rather than
              // its name — "4 steps". On the row only and never on the pill: the
              // pill is what a reader glances at, and it names the pick.
              if (o.sub !== undefined) row.append(el('span', 'sub', o.sub));
              if (o.disabled) {
                row.classList.add('off');
                row.setAttribute('aria-disabled', 'true');
                // Out of the arrow keys' reach as well: `kit.ts` walks `.mitem`
                // and this is one, so the traversal is told rather than filtered.
                row.setAttribute('data-skip', '');
              }
              return row;
            })
          );
        };
        paint('');

        if (spec.search ?? options.length > SEARCH_ABOVE) {
          parts.push(searchBox('Find…', paint));
        }
        scroll.append(rows);
      }

      if (spec.sort) {
        const { asc, desc } = spec.sort;
        if (options.length > 0) scroll.append(el('div', 'fsep'));
        scroll.append(el('div', 'mhead', 'Sort'));
        const wanted: { d: Exclude<SortDir, null>; glyph: string; label: string }[] = [
          { d: 'asc', glyph: '↑', label: asc },
          { d: 'desc', glyph: '↓', label: desc }
        ];
        const rows = wanted.map((w) =>
          sortRow(w.glyph, w.label, dir === w.d, () => {
            dir = dir === w.d ? null : w.d;
            rows.forEach((row, i) => {
              const on = dir === wanted[i]?.d;
              row.classList.toggle('on', on);
              row.setAttribute('aria-checked', String(on));
            });
            syncClear();
            // Deliberately no `closeMenu`: having just changed the order, the next
            // thing wanted is often the other direction.
            emit();
          })
        );
        scroll.append(...rows);
      }

      syncClear();
      parts.push(scroll);
      footRow.append(clear);

      const footer = spec.footer;
      if (footer !== undefined) {
        // The same button as Clear, at the other end of the same row: both are
        // things to do to the list rather than rows of it, and one shape for both
        // is what keeps New from reading as a workflow named "New workflow…".
        const action = el('button', 'faction fbtn', footer.label);
        action.onclick = () => {
          closeMenu();
          footer.onClick();
        };
        footRow.append(action);
      }
      parts.push(footRow);

      body.replaceChildren(...parts);
    },
    spec.floating
  );

  /**
   * Drop this pill's sort because another one claimed it. Silent on purpose —
   * the bar calls this while handling the other pill's `onChange`, and emitting
   * from here would answer a change with a change.
   */
  wrap.clearSort = (): void => {
    if (dir === null) return;
    dir = null;
    relabel();
  };

  // A persistent control can take new facts while its menu is closed without
  // replacing the trigger under a press. Open menus keep their captured options.
  wrap.refresh = (): void => {
    if (heldOpen(wrap)) return;
    options = spec.options ?? [];
    value = [...(spec.value ?? [])];
    dir = spec.sort?.dir ?? null;
    relabel();
  };

  // A picker's menu scrolls in one block of its own rather than as a whole (see
  // the fill above); the settings gear's menu, which is the other thing
  // `opensMenu` serves, keeps the plain `.fmenu` box — which its own `.smenu`
  // then uncaps, so that one does not scroll at all.
  menu.classList.add('pmenu');
  wrap.append(menu);
  relabel();
  return wrap;
}
