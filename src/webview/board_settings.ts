/** Settings gear, theme and model menu. */

import { brandMark } from './accounts';
import { defaultPick, effortFor, resolveModel, rowPick, shownModel } from '../core/model_names';
import { ctxLabel, el } from './dom';
import { playCue } from './sound';
import { chats, clearWantThemeIf, setWantTheme, ui, vscode } from './state';
import type { LaunchTarget } from '../core/model';
import type { ComposerContext } from '../ui/chat_state';
import { closeMenu, drillRow, menuItem, searchBox, switchRow } from './kit';
import { SEARCH_ABOVE } from './picker';

/**
 * What an empty model list means, now that nothing asks a CLI.
 *
 * It used to read "The CLI named no models", which was true when the list was
 * a `list_models` answer that had not come back. The rows are ours now
 * (`core/catalog.ts`), and the only way to none of them is the host's
 * availability filter — a brand with no binary, or one it knows is signed out.
 * So the sentence names the two things a reader can actually do something
 * about, and still names no brand: which CLI is missing is not a fact this
 * menu has.
 */
const NO_MODELS = 'No CLI here is both installed and signed in.';

/**
 * A row needs value and window because neither names it alone. Absent window
 * matches an unstated window or ticks the first entry of that value for no pick.
 */
type Ticked = { value: string; window?: number };

/**
 * What a dashed pill means, in one sentence a reader can act on.
 *
 * Names no brand and no model: this is the wording for any window an account
 * holds the model for and may still be charged to reach, and the only one we
 * have measured is `claude-sonnet-4-6[1m]`. The CLI's own answer is *"usage
 * credits required for 1M context"*; this says the same thing without quoting a
 * string another program owns.
 */
const GATED_TIP = 'Runs, but this account is asked for usage credits first';

/**
 * Name no flag or env var because a launch line is the adapter's business;
 * nothing in webview/ may spell it. State the fact: it was decided at launch
 * and only a new session can change it.
 */
const FIXED_TIP = 'Set when this session started; only a new session can change it';

//
// The model rows: a brand at a time, each brand's current models first, then a
// rule, then the ones its CLI no longer advertises.
//
// Shared by the gear's flyout and a card's model menu, which draw the same row
// and differ only in what a press does. Twelve Claude rows is past the point
// where one flat list reads, and `legacy` is the split the catalog already
// carries — so that is a `.fsep` and not a fold: a legacy model stays one press
// away, which is the whole reason the catalog can name one at all.
//
// **The brand is the outer run, and it was not always.** The rule used to cut
// across every brand at once, which put Grok's rows between the Claude
// flagships and the older Claudes — an order nobody chose, falling out of
// `offeredModels` walking brand by brand and this function then sorting the
// result on `legacy` alone. It also left one rule glyph meaning two things.
// Legacy is a fact about one CLI's own list, so it is that CLI's run it cuts.
//
// A heading only when there is more than one run and every run has a word for
// itself. A word over the only brand in a menu tells a reader nothing — which a
// card's model menu is, near enough always (`modelsForSession` filters to the
// session's brand; a brand with no adapter is left holding the whole list, and
// nothing can start one today). All-or-none because the mixed state is the
// misleading one: an unheaded run under a headed one reads as more of it.
// `.mhead` is the settings menu's and the accounts menu's section heading, so a
// reader has met it.
//
// **Grouped on `brand`, spelled from `brandLabel`.** Nothing here reads what a
// brand *is* — the rows are run together on a key this file never compares
// against a literal, and the word over the run is whatever the host stamped.
// Unlabelled rows are still run together; they are simply not announced.
//
// A headed run is a `role="group"` carrying that word, because otherwise the
// boundary is paint alone: a keyboard walk crosses from the last Claude row to
// the first Grok one and says nothing, which is the single fact the heading was
// added to state. The `.mhead` inside it is `aria-hidden` — it is the group's
// own label drawn, and read twice it is noise. Unheaded runs are not wrapped: a
// group with no name announces a boundary it cannot explain. The keyboard walk
// is unaffected either way — `levelRows` in `kit.ts` filters on the nearest
// `.fmenu`, not on being a direct child of it.
//
// **A row is a model; the pills are the control.** Shape B, locked in
// `docs/mockups/model-menu-windows.html` and measured there against the two
// alternatives. The flattened list carries one entry per (model × window), so
// this groups it back by `value` and draws one `.wp` per entry — a window is a
// property of a model rather than a second model, and the row's job is to say
// which model. What that buys is a tick a reader can read: `claude-opus-5`
// names two entries, and a menu keyed on `value` alone filled both.
//
// The row is a `<div role="presentation">` and not a `menuItem`. Two reasons,
// and the first is not a preference: `menuItem` builds a `<button>`, and a
// button inside a button is not markup a browser keeps. `presentation` rather
// than a bare div because the brand run is a `role="group"` and a group must
// own its `menuitemradio` children — a generic container between the two severs
// that, and `presentation` is exactly what collapses away.
//
// The id column went with the change. It earned itself by telling `Opus 5` from
// `Opus 5 (1M context)` apart, and the pill does that better; the space it held
// is the space the pills sit in (`css/board.ts` copies `.mitem .sub`'s column
// exactly).
//
// **A row whose entries state no window keeps the old single-control shape.**
// `ModelView.window` is optional on the wire — a typed id has none — and a row
// with nothing for a pill to say must still be pressable. That is the
// degradation this repo owes any shape it did not write, not a second design.
//
function modelItems(
  target: HTMLElement,
  models: readonly ModelView[],
  ticked: Ticked | undefined,
  press: (model: ModelView) => void
): void {
  // Resolve the tick once as resolveModel does: match the window, else the first
  // entry of that value. Entries share value, so only window distinguishes them;
  // a sole window ticks whatever was stored.
  const ofPick = ticked ? models.filter((m) => m.value === ticked.value) : [];
  const lit = ofPick.find((m) => m.window === ticked?.window) ?? ofPick[0];

  /**
   * Mark brands only when this list has several: gear offers all brands, but a
   * session's composer offers only its own and needs no distinguishing mark.
   * Count the full models list so a mark does not flicker off during search;
   * headings count hits because they name runs that must still exist.
   */
  const manyBrands = new Set(models.map((model) => model.brand)).size > 1;
  const scroll = el('div', 'fscroll');

  // Three bands, which is `picker.ts`'s shape and not a fourth kind of menu:
  // a search box that stays put, the block that scrolls, and whatever footer
  // the opener appends after this. `.mmodels` is what lifts the 260px cap the
  // shipped `.fmenu` carries — a figure sized for a menu of commands, against a
  // list that is now three brands long.
  target.classList.add('pmenu', 'mmodels');
  // `SEARCH_ABOVE` and not a number of our own: the panel already decided how
  // long a list gets before it is worth searching, and this is the list that
  // most needs the answer rather than a place to give a second one.
  //
  // **Counted in rows, which is not `models.length`.** The wire carries one
  // entry per (model x window), so Claude's eleven models arrive as twenty —
  // and a menu drawing five rows would have grown a search box for a list a
  // reader can see all of. `value` is what a row stands for, the same key
  // `byModel` groups on.
  if (new Set(models.map((model) => model.value)).size > SEARCH_ABOVE) {
    target.append(searchBox('Find a model…', paint));
  }
  target.append(scroll);
  paint('');

  /* Below here: how a needle becomes rows. Declarations rather than consts, so
     the four steps above can read in the order they happen. */

  /** Search disables the fold because asking for a named model must not hide a match. */
  function paint(needle: string): void {
    const hits = needle
      ? models.filter((model) =>
          [model.name, model.id, model.brandLabel ?? ''].some((field) =>
            field.toLowerCase().includes(needle)
          )
        )
      : models;
    scroll.replaceChildren();
    if (!hits.length) {
      // Empty offers mean an account problem; empty matches mean a typing problem.
      scroll.append(el('div', 'fnone', models.length ? 'Nothing matches.' : NO_MODELS));
      return;
    }
    // Keep first appearance because offeredModels already settled brand order.
    const brands = [...new Set(hits.map((model) => model.brand))];
    const wordFor = (brand: string): string | undefined =>
      hits.find((model) => model.brand === brand)?.brandLabel;
    const headed = brands.length > 1 && brands.every((brand) => wordFor(brand) !== undefined);
    for (const brand of brands) {
      const own = hits.filter((model) => model.brand === brand);
      let into = scroll;
      // Read the proved heading once; ?? would draw the forbidden empty accessible name.
      const word = wordFor(brand);
      if (headed && word !== undefined) {
        // Use no class: role identifies this box for tests; an unstyled class would
        // suggest a styling hook that does not exist.
        const run = el('div');
        run.setAttribute('role', 'group');
        run.setAttribute('aria-label', word);
        const heading = el('div', 'mhead', word);
        heading.setAttribute('aria-hidden', 'true');
        run.append(heading);
        scroll.append(run);
        into = run;
      }
      drawRun(own, into, needle === '');
    }
  }

  /**
   * Draw older rows hidden rather than creating them on open, so the pressed
   * control keeps focus. kit.ts levelRows skips hidden boxes, so a shut fold
   * adds no keyboard stops.
   */
  function drawRun(own: readonly ModelView[], into: HTMLElement, folding: boolean): void {
    // By model, then by legacy — in that order, because `legacy` is a fact
    // about a row and every entry of one carries the same answer.
    const rows = byModel(own);
    const current = rows.filter((entries) => !entries[0]?.legacy);
    const legacy = rows.filter((entries) => entries[0]?.legacy);
    for (const entries of current) add(entries, into);
    if (!legacy.length) return;
    if (!folding) {
      // Draw a rule only between existing groups: an empty top reads as a gap, and
      // a brand with no legacy rows should not be ruled off from the next brand.
      if (current.length) into.append(el('div', 'fsep'));
      for (const entries of legacy) add(entries, into);
      return;
    }
    // Open a fold containing the chosen model so its tick remains visible and
    // drillRow can focus it.
    let open = legacy.some((entries) => lit !== undefined && entries.includes(lit));
    const fold = el('button', 'mitem mfold');
    fold.setAttribute('role', 'menuitem');
    const twisty = el('i', 'tw');
    // Show a count because the decision is whether to look, not which name to pick;
    // the heading above already states the brand.
    fold.append(twisty, el('span', 'nm', `${legacy.length} older`));
    into.append(fold);
    const hiddenRows = legacy
      .map((entries) => add(entries, into))
      .filter((row): row is HTMLElement => row !== undefined);
    const settle = (): void => {
      fold.setAttribute('aria-expanded', String(open));
      fold.classList.toggle('on', open);
      for (const row of hiddenRows) row.hidden = !open;
    };
    settle();
    fold.onclick = () => {
      open = !open;
      settle();
    };
  }

  /** One model's row: the name, the mark, and a pill per window it runs in. */
  function add(entries: readonly ModelView[], into: HTMLElement): HTMLElement | undefined {
    const first = entries[0];
    if (!first) return undefined;
    const windows = entries.filter((m) => m.window !== undefined);
    if (!windows.length) {
      // Keep the row pressable when no pill has a window to state, as for a typed id.
      const bare = menuItem(first.name, first === lit, 'one', () => press(first));
      if (manyBrands) bare.prepend(brandMark(first.brand));
      into.append(bare);
      return bare;
    }
    // `presentation`, not a bare div: the brand run is a `role="group"` and a
    // group must own its `menuitemradio` children — a generic box between them
    // severs that, and this is what collapses away.
    const row = el('div', 'mitem wins' + (lit && entries.includes(lit) ? ' lit' : ''));
    row.setAttribute('role', 'presentation');
    // Keep the brand mark on the row because its heading may have scrolled away
    // and search often narrows a brand's run to one row.
    if (manyBrands) row.append(brandMark(first.brand));
    row.append(el('span', 'nm', first.name));
    const pills = el('span', 'wps');
    for (const model of windows) {
      const size = ctxLabel(model.window as number);
      // No exemption for the window in force, and it needs none: the stamp is
      // keyed on what the session is *running*, so the window it is in comes out
      // reachable by construction (`defaultsWide`, `core/catalog.ts`). An
      // earlier fix exempted it here, off the tick — which is an optimistic
      // pick paired with the last poll's width, so it un-dimmed on a guess
      // (review, 2026-08-29).
      //
      // Unreachable beats gated, and it is one mark rather than two:
      // `claude-sonnet-4-6[1m]` on a flagged line is both, and we know for
      // certain the switch cannot move the window where the billing gate is a
      // maybe that would never be reached to be seen.
      const pill = el(
        'button',
        'wp' + (model === lit ? ' on' : '') + (model.fixed ? ' off' : model.gated ? ' gated' : ''),
        size
      );
      pill.setAttribute('role', 'menuitemradio');
      pill.setAttribute('aria-checked', String(model === lit));
      // Dimmed is a mark a reader who cannot see dim gets nothing from, and a
      // control that does nothing must say so rather than fail quietly.
      // `aria-disabled` and not the `disabled` attribute: a disabled button
      // leaves the menu's arrow walk with a hole in it, and the row is still
      // worth arriving at to read.
      if (model.fixed) pill.setAttribute('aria-disabled', 'true');
      // A dashed border with nothing to explain it is a mark a reader cannot
      // read, which is the argument the mock makes about the plus sign it
      // rejected. `tip.ts` delegates at the document and its layer is z-index 60
      // against this menu's 20, so a portalled flyout is covered. Same for the
      // dimmed one, and for the same reason.
      if (model.fixed) pill.dataset.tip = FIXED_TIP;
      else if (model.gated) pill.dataset.tip = GATED_TIP;
      // WCAG 2.5.3, Label in Name. The row is `presentation`, so a pill
      // announced as `1M` alone names a window with no model attached — and
      // the visible text has to be a literal substring of this, or a
      // voice-control reader cannot say the thing they can see. Which rules
      // out spelling the figure out longhand.
      pill.setAttribute('aria-label', `${first.name} (${size})`);
      // A fixed control posts nothing and leaves the menu open because no pick changed.
      pill.onclick = model.fixed ? null : () => press(model);
      pills.append(pill);
    }
    row.append(pills);
    into.append(row);
    return row;
  }

  /**
   * One model's entries in catalog order (widest window first), which is the
   * order the pills draw in. Use Map rather than sort because the host already
   * settled brand order; first appearance wins inside each brand too.
   */
  function byModel(rows: readonly ModelView[]): ModelView[][] {
    const out = new Map<string, ModelView[]>();
    for (const model of rows) {
      const own = out.get(model.value);
      if (own) own.push(model);
      else out.set(model.value, [model]);
    }
    return [...out.values()];
  }
}

/**
 * Report without writing a session because a step is not one; its caller
 * owns the draft. Tick the first window because a step stores no window.
 */
export function catalogMenu(
  menu: HTMLElement,
  models: readonly ModelView[],
  current: string | undefined,
  onPick: (model: ModelView) => void
): void {
  modelItems(menu, models, current ? { value: current } : undefined, (model) => {
    closeMenu();
    onPick(model);
  });
}

/**
 * The presets the picker offers. `follow` leads and sits in neither band: it
 * tracks the editor, so it is not a light preset or a dark one. The rest keep
 * array order inside their band.
 */
export const THEMES: {
  name: ThemeName;
  label: string;
  short: string;
  band?: 'dark' | 'light';
}[] = [
  { name: 'follow', label: 'Follow host', short: 'Host' },
  { name: 'ink', label: 'Ink', short: 'Ink', band: 'dark' },
  { name: 'lift', label: 'Slate Lift', short: 'Lift', band: 'dark' },
  { name: 'paper', label: 'Paper', short: 'Paper', band: 'light' },
  { name: 'neon', label: 'Neon Terminal', short: 'Neon', band: 'dark' },
  { name: 'polaroid', label: 'Polaroid Pack', short: 'Pack', band: 'light' },
  { name: 'mario', label: 'Mario Kart', short: 'Kart', band: 'dark' },
  { name: 'nightcity', label: 'Night City', short: 'City', band: 'dark' },
  { name: 'arasaka', label: 'Arasaka', short: 'Corp', band: 'dark' },
  { name: 'malachite', label: 'Malachite', short: 'Jade', band: 'dark' }
];

/**
 * Keep theme truth on the attribute document.ts selects and read it back there;
 * a second record could disagree with the screen.
 */
export function paintTheme(next: ThemeName): void {
  if (next === 'follow') delete document.body.dataset.theme;
  else document.body.dataset.theme = next;
}

export const painted = (): ThemeName => (document.body.dataset.theme as ThemeName) ?? 'follow';

/**
 * Keep a pending pick on screen because a host echo that has not caught up
 * would flicker back.
 */
export function settleTheme(): void {
  clearWantThemeIf(ui.state.theme);
  if (!ui.wantTheme) paintTheme(ui.state.theme);
}

/** A `themeChoice` whose write did not land. A later pick is a later write. */
export function refuseTheme(theme: ThemeName): void {
  if (ui.wantTheme !== theme) return;
  setWantTheme(null);
  paintTheme(ui.state.theme);
  markSwatches(document, ui.state.theme);
}

function markSwatches(root: ParentNode, theme: string): void {
  for (const swatch of root.querySelectorAll<HTMLElement>('.sws')) {
    const on = swatch.dataset.theme === theme;
    swatch.classList.toggle('on', on);
    swatch.setAttribute('aria-checked', String(on));
    swatch.tabIndex = on ? 0 : -1;
  }
}

/**
 * Draw swatches because colour reads faster than a preset name. Paint before
 * posting for an instant switch; the host write makes it persist. Keep the
 * menu open to compare presets. Move selection by hand because the held bar
 * cannot repaint, which also makes keeping it open free.
 */
export function themeSwatches(): HTMLElement {
  const root = el('div', 'theme-groups');
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', 'Theme');
  const mark = (theme: string): void => markSwatches(root, theme);
  const grid = (themes: readonly (typeof THEMES)[number][]): HTMLElement => {
    const box = el('div', 'swatches');
    for (const t of themes) {
      const on = t.name === painted();
      const swatch = el('button', on ? 'sws on' : 'sws');
      swatch.dataset.theme = t.name;
      swatch.append(el('i', 'hue c-' + t.name), el('span', 'cap', t.short));
      swatch.dataset.tip = t.label;
      // The visible caption is a short name, and contents beat every other
      // source of an accessible name — so without this the preset is called
      // by those letters alone to a reader who cannot see the hue beside it.
      swatch.setAttribute('aria-label', t.label);
      swatch.setAttribute('role', 'radio');
      swatch.tabIndex = on ? 0 : -1;
      swatch.setAttribute('aria-checked', String(on));
      swatch.onclick = () => {
        setWantTheme(t.name);
        paintTheme(t.name);
        vscode.postMessage({ type: 'setTheme', theme: t.name });
        mark(t.name);
      };
      swatch.onkeydown = (event) => {
        const offset =
          event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? -1
              : 0;
        if (!offset) return;
        event.preventDefault();
        const rows = [...root.querySelectorAll<HTMLButtonElement>('.sws')];
        const next =
          rows[(rows.indexOf(swatch as HTMLButtonElement) + offset + rows.length) % rows.length];
        next?.click();
        next?.focus();
      };
      box.append(swatch);
    }
    return box;
  };
  root.append(grid(THEMES.filter((t) => t.band === undefined)));
  for (const band of ['dark', 'light'] as const) {
    root.append(el('h3', 'theme-band', band === 'dark' ? 'Dark' : 'Light'));
    root.append(grid(THEMES.filter((t) => t.band === band)));
  }
  return root;
}

/**
 * This is the default for starts whose own draft pick stays untouched;
 * customising one draft leaves this setting alone.
 * Show unknown ids verbatim because the next start passes exactly that string.
 * For unset values, show startingPick; use default only with no list, to avoid
 * naming a model the reader cannot see.
 */
function modelRow(onPick?: (model: ModelView | undefined) => void): HTMLElement {
  const models = ui.state.models;
  // Keep current mutable because done relabels a held row that the host cannot
  // repaint. Reopening refills the flyout, so an old value would tick the old pick
  // beside the new label.
  let current: Ticked = { value: ui.state.model, window: ui.state.contextWindow };
  /**
   * An unset fresh-profile value uses startingPick so gear and draft cannot
   * drift on separate rules. Keep the setting empty: this changes only label
   * and tick, not the model named at launch. The menu cannot write an empty pick.
   */
  const resolved = (pick: Ticked): Ticked => {
    if (pick.value !== '') return pick;
    const opening = startingPick();
    return opening?.model === undefined ? pick : { value: opening.model, window: opening.window };
  };

  /**
   * Include ctxLabel(window) because this row has no pill or card to distinguish
   * two starts sharing a model name; the shared formatter keeps row and pill equal.
   * Unknown values read verbatim for Enter an id; no list falls back to default.
   * A catalog row without a window keeps its bare name, without empty brackets.
   */
  const named = (pick: Ticked): string => {
    const sharing = models.filter((m) => m.value === pick.value);
    const hit = sharing.find((m) => m.window === pick.window) ?? sharing[0];
    if (!hit) return pick.value || 'default';
    return hit.window === undefined ? hit.name : `${hit.name} (${ctxLabel(hit.window)})`;
  };

  const set = (model: ModelView, done: (label: string) => void): void => {
    const pick: Ticked = { value: model.value, window: model.window };
    current = pick;
    // Omit an absent window because tests and host narrowing read this message;
    // absence should say no window once, not also as undefined.
    vscode.postMessage({
      type: 'setModel',
      model: pick.value,
      ...(pick.window === undefined ? {} : { window: pick.window })
    });
    done(named(resolved(pick)));
    onPick?.(model);
  };

  return drillRow({
    label: 'Default model',
    detail:
      // Share the switch's first clause: what a start passes. Then answer what a
      // reader with six cards on screen wants to know.
      'What a new session starts on, before its own pill is touched. A session already running keeps the model it is on.',
    value: named(resolved(current)),
    fill: (menu, done) => {
      // Tick resolved(current) because an unset profile's row already names the
      // starting model; a blank tick would disagree. Keep the stored setting empty.
      modelItems(menu, models, resolved(current), (model) => set(model, done));
      // No default row: picking the first current model names the account's default
      // with something to show on the card. Keep idField for uncatalogued ids; the
      // draft menu can only pick. No extra separator: this footer has its own rule,
      // and a second one would draw a line under a line.
      menu.append(
        idField((label) => {
          done(label);
          onPick?.(undefined);
        })
      );
    }
  });
}

/** One row of an effort menu: the value, and "default" when it is the model's own. */
export function effortPick(
  value: string,
  selected: boolean,
  onPick: () => void,
  markDefault: boolean
): HTMLElement {
  const row = menuItem(value, selected, 'one', onPick);
  if (markDefault) row.append(el('span', 'sub', 'default'));
  return row;
}

/** The selected default model's native effort values, ticked at the one saved
 *  for it. */
function effortRow(model: ModelView | undefined): HTMLElement | undefined {
  if (!model?.efforts?.length) return undefined;
  let selected = effortFor(
    ui.state.models,
    model.value,
    model.window,
    ui.state.efforts[model.value]
  );
  return drillRow({
    label: 'Default effort',
    detail: 'What a new or resumed session on this model starts at. Each model remembers its own.',
    value: selected ?? 'Not set',
    fill: (menu, done) => {
      for (const effort of model.efforts ?? []) {
        menu.append(
          effortPick(
            effort.value,
            effort.value === selected,
            () => {
              selected = effort.value;
              vscode.postMessage({ type: 'setEffort', model: model.value, effort: effort.value });
              done(effort.value);
            },
            effort.value === model.defaultEffort
          )
        );
      }
    }
  });
}

/**
 * The settings label resolves the same default as the shared draft state. Undefined
 * means no installed, signed-in CLI offers a row; the start names no model,
 * leaving the account's own default. The rule is `defaultPick`'s.
 */
export function startingPick(): LaunchTarget | undefined {
  return defaultPick(ui.state.models, ui.state.model, ui.state.contextWindow, ui.state.efforts);
}

/** One row of the list as a draft holds it, at the effort saved for it. */
function pickOf(model: ModelView): LaunchTarget {
  return rowPick(ui.state.models, model, ui.state.efforts);
}

/**
 * The way to a model the list does not offer: a footer button that becomes a
 * field.
 *
 * Nothing validates it, for `setModel`'s stated reason. Validating here would
 * mean deciding, in the panel, which ids the account may use.
 *
 * A button first rather than a field always: the field is the exception, and a
 * menu that opens with a text box in it reads as one that wants typing.
 */
function idField(done: (label: string) => void): HTMLElement {
  const foot = el('div', 'ffoot');
  const button = el('button', 'fbtn', 'Enter an id…');
  button.onclick = () => {
    const field = el('input', 'fsearch') as HTMLInputElement;
    field.placeholder = 'A model id';
    field.spellcheck = false;
    field.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const typed = field.value.trim();
      // Reject empty typing because the menu has no clear-setting row; an empty
      // field must not clear it by accident.
      if (!typed) return;
      e.preventDefault();
      vscode.postMessage({ type: 'setModel', model: typed });
      done(typed);
    };
    foot.replaceChildren(field);
    field.focus();
  };
  foot.append(button);
  return foot;
}

/**
 * How much context a switch would re-send cold, or nothing when the card cannot
 * count it.
 *
 * The percentage and its window when both are known, the bare token count when
 * that is all a transcript gave. Never a constant: two probes of the same
 * `cache_miss_reason: "model_changed"` read 29,364 and 27,886 tokens, because
 * what is thrown away is this conversation and not a number about the CLI.
 */
export function coldTokens(s: CardView): number | undefined {
  if (s.contextPct !== undefined && s.contextSize !== undefined) {
    return Math.round((s.contextPct / 100) * s.contextSize);
  }
  return s.contextTokens;
}

/**
 * Name ComposerContext for the control while keeping launch/next-message
 * decisions on that resolved context (bound, pick, target, canModel).
 */
export type MenuTarget = ComposerContext;

/**
 * Use the unfiltered draft model list because no launch line exists to make
 * a window unreachable, and drafts may cross brands. modelsForSession narrows
 * running sessions for that launch-line reason. No cold-cache band: a draft
 * has no conversation to re-send and cannot incur that cost.
 */
function launchMenuBody(m: HTMLElement, ctx: ComposerContext, onPicked: () => void): void {
  const cwd = ctx.identity.kind === 'draft' ? ctx.identity.cwd : ctx.cwd;
  if (cwd === undefined) return;
  const ticked: Ticked = { value: ctx.model ?? '', window: ctx.window };
  modelItems(m, ctx.models, ticked, (model) => {
    chats.setDraftPick(cwd, pickOf(model));
    chats.clearDraftReason(cwd);
    closeMenu();
    onPicked();
  });
}

/**
 * What the model menu holds, wherever it was opened from: every model the CLI
 * named, ticked at the one in force, and what a switch costs.
 *
 * **One surface opens it: the composer's pill**
 * (`docs/mockups/composer-shell.html` §3). Two did — the card's specs bit was
 * the other — and that opener went with taskhub H4(2), because a switch alone
 * does nothing and a board is where nobody is writing the turn that would spend
 * it. `board_card.ts`'s model bit is a `<span>` now, and `board_card.test.ts`
 * § *the model bit* is where that is written down.
 *
 * The caller's `s` is the whole of what an opener supplies — and `s.models`, which
 * the host stamps `fixed` on, only exists on a `ThreadView`. With one opener
 * and `ThreadView extends CardView`, the list below is the stamped one on every
 * path a reader can reach. The `CardView` fallback is what a fixture reaches,
 * and it degrades to blocking nothing.
 *
 * `onPicked` is the opener's repaint, run after the pick has been recorded and
 * the menu shut — the label above a menu is the opener's, and this file cannot
 * reach the composer's without importing the module that imports it. Required,
 * because the composer is the only surface that opens this: a pick with nothing
 * to relabel is the lag this whole path exists to remove.
 */
export function modelMenuBody(m: HTMLElement, target: MenuTarget, onPicked: () => void): void {
  if (!target.bound) {
    launchMenuBody(m, target, onPicked);
    return;
  }
  const s = target.thread;
  if (!s) return;
  const list = target.models;
  // A held window is the next message's choice; otherwise this running menu
  // reads the session, never the gear. No window ticks the model's first row.
  const running: Ticked = {
    value: target.model ?? '',
    window: target.window
  };
  // Use the gear's builder with modelsForSession's brand and fixed stamps.
  // Keep all rows: unreachable windows dim rather than disappear. A gear list
  // is stamped for no session, so none of its windows is fixed.
  modelItems(m, list, running, (model) => {
    const effort = effortFor(list, model.value, model.window, ui.state.efforts[model.value]);
    chats.chooseTarget(s.pid, {
      model: model.value,
      ...(model.window === undefined ? {} : { window: model.window }),
      ...(effort === undefined ? {} : { effort })
    });
    closeMenu();
    onPicked();
  });
  // H4(3). The card already colours a cold cache; picking a model must not
  // look free when it throws the whole prompt cache away. Drawn whether or not
  // the figure is known — the cost is true either way, and a sentence that
  // disappears when nothing can count it goes quiet in exactly the case
  // nobody knows the size of the bill.
  const cold = coldTokens(s);
  // A band, not the last row of the list: it is true of every pick above it, so
  // scrolling it out of sight was the one thing it could not afford to do.
  m.append(
    el(
      'div',
      'mwarn',
      cold === undefined
        ? 'Switching re-sends this conversation cold, at no cache discount, on the next turn.'
        : `Switching re-sends this conversation cold — about ${ctxLabel(cold)} tokens at no cache discount, on the next turn.`
    )
  );
}

/** The selected model's native effort values. */
export function effortMenuBody(m: HTMLElement, target: MenuTarget, onPicked: () => void): void {
  const session = target.thread;
  const held = target.target;
  const models = target.models;
  const model = resolveModel(models, session?.model, target.model, target.window);
  if (!model?.efforts?.length) return;
  const current = target.effort;
  for (const effort of model.efforts) {
    m.append(
      effortPick(
        effort.value,
        effort.value === current,
        () => {
          if (!target.bound && target.identity.kind === 'draft') {
            chats.setDraftPick(target.identity.cwd, { ...target.pick, effort: effort.value });
            chats.clearDraftReason(target.identity.cwd);
          } else if (session) {
            chats.chooseTarget(session.pid, { ...held, effort: effort.value });
          }
          closeMenu();
          onPicked();
        },
        effort.value === model.defaultEffort
      )
    );
  }
}

/**
 * Keep the specs model a reading: set_model takes effect on the next turn.
 * A board pick leaves the session saying the old model until something runs,
 * so the reader must go elsewhere to make it mean anything. The composer's
 * pill opens the same menu (modelMenuBody) for a reader about to send a prompt.
 * Cards state what ran.
 */
export function modelBit(specs: HTMLElement, s: CardView): void {
  const bit = el('span', 's-model');
  // Mark inside the bit and name in a span of its own, because the 180px tier
  // hides `.s-name` and not `.s-model`: which CLI this is survives the width
  // its own model id cannot. Inside rather than beside so the pair travels as
  // one bit — nothing on the row is left leading the effort's `·`.
  if (s.brand) bit.append(brandMark(s.brand));
  // Reading, then the launch pick, then the brand. Never a hardcoded
  // `claude`: a Grok start is on the board before the CLI names a model
  // (`LiveState.model` is empty until it speaks; the id we passed is
  // `modelPick`), and inventing Claude there is a flash of the wrong CLI.
  // A target held in the composer stays off this line — a pick there
  // is not a reading, and the card keeps saying what last ran until a turn
  // spends it.
  const reading = s.model || s.modelPick || s.brand;
  const named = cardModel(s);
  const name = named?.text ?? reading;
  if (name) bit.append(el('span', 's-name', name));
  specs.append(bit);
}

/** The card's model name, resolved within its own brand. */
function cardModel(s: CardView): { text: string; window?: number } | undefined {
  // Brand-narrowed: the list carries every signed-in brand's rows, and a join
  // across brands would be one CLI's spelling answering for another's.
  const rows = ui.state.models.filter((m) => s.brand === undefined || m.brand === s.brand);
  return shownModel(rows, s.model, s.modelPick, s.contextSize);
}

/** Silence and the three loudnesses, in the order a reader turns them up. */
const LEVELS = ['off', 'quiet', 'normal', 'loud'] as const satisfies readonly SoundLevel[];

/** Total over `SoundLevel`, so the row's own value needs no fallback — and a
 *  fallback here could only ever label an audible level "Off". */
const LABEL: Record<SoundLevel, string> = {
  off: 'Off',
  quiet: 'Quiet',
  normal: 'Normal',
  loud: 'Loud'
};

/**
 * Play done at the chosen level because the row cannot convey loudness;
 * waiting for a session to finish may leave the reader an hour from the gear.
 * Off plays nothing, as playCue already knows.
 */
function soundRow(): HTMLElement {
  // Held here, like the effort row's: the menu is filled once when it opens,
  // and the state echo behind the pick cannot repaint a row inside it.
  let picked = ui.state.soundLevel;
  return drillRow({
    label: 'Sound',
    detail: 'A cue when a session finishes replying, and a double knock when one blocks.',
    value: LABEL[picked],
    fill: (menu, done) => {
      for (const level of LEVELS) {
        menu.append(
          menuItem(LABEL[level], level === picked, 'one', () => {
            picked = level;
            vscode.postMessage({ type: 'setSound', level });
            playCue('done', level);
            done(LABEL[level]);
          })
        );
      }
    }
  });
}

export function generalSettings(): HTMLElement[] {
  return [
    soundRow(),
    switchRow(
      'Dev servers',
      'A chip per branch above each repo, saying what it is running and on which port. Attribution is still unreliable.',
      ui.state.devServers,
      (on) => vscode.postMessage({ type: 'setFlag', key: 'devServers', on }),
      'beta',
      'switch'
    ),
    switchRow(
      'Mascot',
      'A small chick on the board that flies to wherever something happens, and keeps still in between.',
      ui.state.mascot,
      (on) => vscode.postMessage({ type: 'setFlag', key: 'mascot', on }),
      'beta',
      'switch'
    )
  ];
}

export function agentSettings(): HTMLElement[] {
  return [
    orchestratorsRow('switch'),
    switchRow(
      'Skip permissions',
      'New sessions never ask before editing, running commands or reaching the network.',
      ui.state.skipPermissions,
      (on) => vscode.postMessage({ type: 'setFlag', key: 'skipPermissions', on }),
      undefined,
      'switch'
    ),
    switchRow(
      'Execution capture',
      'New sessions attribute file writes to tool execution. Off stops capture in sessions already running.',
      ui.state.executionCapture,
      (on) => vscode.postMessage({ type: 'setFlag', key: 'executionCapture', on }),
      'beta',
      'switch'
    )
  ];
}

export function modelDefaults(): HTMLElement {
  const pair = el('div', 'dual-config');
  const opening = startingPick();
  let effort = effortRow(resolveModel(ui.state.models, undefined, opening?.model, opening?.window));
  const model = modelRow((picked) => {
    const next = effortRow(picked);
    if (effort && next) effort.replaceWith(next);
    else if (effort) effort.remove();
    else if (next) pair.append(next);
    effort = next;
  });
  pair.append(model);
  if (effort) pair.append(effort);
  return pair;
}

/** The Orchestration switch, drawn wherever the setting is offered — the Agents
 *  drawer, and the onboarding slide that shows what it enables. */
export function orchestratorsRow(role?: 'switch'): HTMLElement {
  return switchRow(
    'Orchestration',
    'Let sessions act on each other: message, start, end, rename and warm them. Machine-wide.',
    ui.state.orchestrators,
    (on) => vscode.postMessage({ type: 'setFlag', key: 'orchestrators', on }),
    undefined,
    role
  );
}
