/**
 * Which row of the model list a spelling names — the join both controls make.
 *
 * Split from `models.ts` and with no runtime import, so the webview bundle can
 * take it: the pill and the menu are drawn there, and the alternative is a
 * second copy of this rule in `ui/`. Same bargain `markers.ts` makes, and the
 * same bound — a leaf, and it stays one. One type, erased (`BrandId` from
 * `model.ts`, which is declarations only).
 *
 * **The CLI's spelling stops here, with `models.ts`.** One model has three
 * names on the wire and only one of them is a flag's: everything above this
 * file compares `Model`s, not strings. A second brand still adds its case in
 * `brandForModel` for strings; a collected row carries `brand` instead.
 */

import type { BrandId, LaunchTarget } from './model';

/**
 * Which adapter a start-model id belongs to, when it belongs to one.
 *
 * Grok's ids are `grok-*` (1.0.4 `grok models` / initialize `_meta`) and the
 * observed Codex 0.151.0 catalog is `gpt-*`. A Claude alias (`opus`, `sonnet`)
 * or full Anthropic id names no brand here — the caller keeps whatever brand it
 * already had, which is `claude` by default. Guessing Claude from "not Grok or
 * Codex" would rebrand a typed id the next CLI has not listed.
 *
 * Lives here, not on the adapter registry, so `cli/spawn.ts` can refuse a
 * mismatched pair without bundling both brand adapters.
 */
export function brandForModel(model: string): 'grok' | 'codex' | undefined {
  const id = model.trim();
  if (id.startsWith('gpt-')) return 'codex';
  return id.startsWith('grok') ? 'grok' : undefined;
}

/** One model a start may name. Our shape, not the CLI's. */
export type Model = {
  /** What `--model` takes, and what the setting stores. Not always an alias:
   *  one row on 2.1.220 carries a full id with a context suffix on it. */
  value: string;
  /**
   * What a reader calls it — the row's own name, and **no window in it.**
   *
   * Not unique over a brand's list, deliberately: two entries of one model
   * carry the same name and differ by `window`. The menu draws that difference
   * beside the name rather than inside it, and a surface holding a single value
   * composes `<name> (<window>)` itself. `CatalogRow.name` is where the whole
   * of it is written down.
   */
  name: string;
  /** What the CLI says the value resolves to. */
  id: string;
  /** Stamped at collection by the producer, never inferred from `value`. */
  brand: BrandId;
  /**
   * The context window this entry runs in, in tokens — the second half of what
   * a start names, beside `value`.
   *
   * **Two entries of one row share a `value` and differ only here.** Since
   * `core/catalog.ts` flattened to one entry per (model × window), `value`
   * alone no longer names one entry: `claude-opus-5` is both the 200k start and
   * the 1M one. Every join that used to key on `value` keys on the pair.
   *
   * Carries no CLI spelling and never has. How a window is *reached* —
   * `[1m]` on the id, or `CLAUDE_CODE_DISABLE_1M_CONTEXT` on the launch line —
   * is `CatalogWindow.reach`'s to say and `core/claude/adapter.ts`'s to spell.
   * A number is a fact about the model; both of those are facts about one CLI.
   *
   * See `readings` for why this field is declared on `Model`.
   */
  window?: number;
  /**
   * Offered, and refusable on billing grounds by an account that has the model.
   *
   * The account's answer, not the catalog's: `claude-sonnet-4-6[1m]` runs, and
   * answers *"usage credits required for 1M context"* on this subscription
   * (probed 2026-08-27). That is a gate on a variant that exists, so the entry
   * stays offered and says so — the CLI's 400 lands in that session's own
   * thread, which is where a reader can act on it.
   *
   * See `readings` for why this field is declared on `Model`.
   */
  gated?: true;
  /**
   * This window cannot be reached by switching **one particular session** onto
   * it — a fact about that session's launch line, not about the model, and so
   * never on a catalog row and never on a start list. `modelsForSession`
   * (`core/adapter.ts`) stamps it per session off `Session.launchReach`;
   * `reachableFrom` (`core/catalog.ts`) is the rule, and `WindowReach`
   * (`core/model.ts`) is why a line cannot change.
   *
   * A certainty where `gated` above is a maybe, which is why an entry carrying
   * both draws as this one. See `readings` for why this field is on `Model`.
   */
  fixed?: true;
  /**
   * What a reader calls the brand above, when whoever collected the row knew.
   * `offeredModels` stamps it; a catalog row carries none, because it is a fact
   * about the brand and not about the model.
   *
   * See `readings` for why this field is declared on `Model`.
   */
  brandLabel?: string;
  /**
   * The catalog knows this row and the panel never offers it.
   *
   * Unlike every other optional above, this one is **not** here so the wire
   * can carry it — `offeredModels` drops the row before anything is pushed, so
   * `ModelView` has no counterpart and `webview/` never sees one. It is on
   * `Model` because the flatten produces `Model` and the filter reads it there.
   * What the flag means is `CatalogRow.unlisted`'s to say (`core/catalog.ts`).
   */
  unlisted?: true;
  /**
   * Every spelling a live reading of this row may arrive as, and only those
   * that name it uniquely — `resolveModel`'s join key, filled by `core/catalog.ts`.
   *
   * Optional here rather than required, and declared on `Model` rather than on
   * `CatalogRow` alone, for two reasons that both bite: `resolveModel` is handed
   * `readonly Model[]`, so it could not read the field otherwise; and the rows
   * reach the panel as `ModelView` over the wire, where a field this type does
   * not have is a field the join silently loses.
   */
  readings?: readonly string[];
  /**
   * What the flyout's separator sorts on. What the flag means is
   * `CatalogRow.legacy`'s to say (`core/catalog.ts`).
   *
   * Here for `readings`' second reason alone: the rows reach the panel as
   * `ModelView`, and the port between them hands back `Model[]`. It survives
   * today only because nothing on that path copies the objects, and the first
   * `models.map(...)` anyone writes would lose the separator with no type error
   * and no failing test.
   */
  legacy?: true;
  /** Native effort values this model accepts, strongest first. */
  efforts?: readonly { value: string; description?: string }[];
  /** The catalog's default effort for this model, and never absent where
   *  `efforts` is — `CatalogRow.defaultEffort` says what that buys. */
  defaultEffort?: string;
  /** Input modalities stated by the live catalog. */
  modalities?: readonly string[];
  /** The live account catalog's default row. */
  isDefault?: true;
};

/**
 * The suffix a context variant carries, dropped.
 *
 * `claude-opus-5[1m]` and `claude-opus-5` are the same model answering in two
 * window sizes, and the CLI states whichever it feels like: `init` keeps the
 * suffix, the `message_start` frame behind it does not (probed 2026-08-14 on
 * 2.1.220, `--model opus[1m]`). Compared with the suffix off, the two readings
 * agree; compared with it on, one of them matches no row at all.
 *
 * **A last resort, and only where it is unambiguous.** Since `core/catalog.ts`
 * a row states the spellings it answers to outright, so this is left holding a
 * suffix nobody has seen yet — worth a match on a model only one row could be,
 * and worth nothing at all when several rows survive it. See `resolveModel`.
 */
export function base(spelling: string): string {
  return spelling.replace(/\[[^\]]*\]$/, '');
}

/**
 * Which row a session is on — the one answer both controls ask for.
 *
 * A card states a *reading*: whatever the CLI last said this session runs on,
 * in whichever of its spellings. A row's `value` is a third spelling, the one
 * `--model` and `set_model` take. So `reading === value` is true only by
 * accident (`sonnet`), and every control that compared them ticked nothing for
 * a session started on `opus[1m]`.
 *
 * `pick` is what *this panel* put the session on — the alias it passed or sent,
 * `LiveState.modelPick`. It answers only where a reading has none: before the
 * first turn, and where a spelling matches two rows by base alone. **A reading
 * that names a row outright wins**, however stale that makes the pick —
 * `/model opus` typed into a session started on `opus[1m]` is exactly that, and
 * a pick that outranked it would go on claiming the 1M row for good.
 *
 * Nothing here is a fallback for the *panel's* sake: a spelling no row answers
 * to gets `undefined`, and the caller says the string verbatim rather than
 * naming a model of our own choosing.
 *
 * Three tiers, strongest first.
 *
 * 1. **`readings`** — the spellings a row declares it answers to, which since
 *    `core/catalog.ts` is the real join. It is the only tier that can match the
 *    dated snapshot a discovered session states: `claude-haiku-4-5-20251001` is
 *    in no `value` and no `id`, and it is the whole of what that card can be
 *    read from.
 * 2. **`value` / `id`** — for a row that declares no readings. `id` is a
 *    *display* spelling and deliberately per-row, so it loses to tier 1: a row
 *    that omits a shared spelling on purpose must not take it back here.
 * 3. **`base()`, and only where one candidate survives it** — or where the
 *    window names one of several. This used to answer `loose[0]`, which for a
 *    suffix no row carries is a coin flip between two rows dressed as a match.
 *    Narrowed, it still ticks the row for an unseen context suffix on a model
 *    only one row could be, and it stops guessing where it cannot know. The
 *    pick outranks it, because a pick that is one of the candidates is real
 *    information about which.
 *
 * **And a key under all three: the window.** Since `core/catalog.ts` flattened
 * to one entry per (model × window), a `value` names two entries and a
 * *reading* sometimes cannot tell them apart at all — Sonnet 5 and Fable 5
 * reach 1M plain and 200k by flag, so the CLI reports `claude-sonnet-5` either
 * way and no spelling distinguishes the two. `window` settles those, *after* a
 * pick that is already one of the candidates, because the pick is what this
 * panel actually asked for.
 *
 * Where neither a pick nor a window survives the tie in tiers 1 and 2, the
 * **first** candidate wins — the catalog writes its windows widest first, so
 * this is the answer the flat catalog gave before the restructure. A card whose
 * reading names a row is entitled to that row's name and id even when its
 * window is a guess; answering `undefined` would cost it the name too. Tier 3
 * keeps its stricter rule, because there the row itself is the guess.
 */
export function resolveModel(
  models: readonly Model[],
  reading: string | undefined,
  pick: string | undefined,
  window?: number
): Model | undefined {
  const inWindow = (rows: readonly Model[]): Model | undefined =>
    window === undefined ? undefined : rows.find((m) => m.window === window);

  const ofPick = pick === undefined ? [] : models.filter((m) => m.value === pick);
  const picked = inWindow(ofPick) ?? ofPick[0];

  const settle = (rows: readonly Model[]): Model | undefined =>
    (picked && rows.includes(picked) ? picked : undefined) ?? inWindow(rows) ?? rows[0];

  if (reading === undefined) return picked;
  const declared = models.filter((m) => m.readings?.includes(reading));
  if (declared.length) return settle(declared);
  const exact = models.filter((m) => m.value === reading || m.id === reading);
  if (exact.length) return settle(exact);
  const loose = models.filter(
    (m) => base(m.id) === base(reading) || base(m.value) === base(reading)
  );
  if (picked && loose.includes(picked)) return picked;
  return loose.length === 1 ? loose[0] : inWindow(loose);
}

export function effortFor(
  models: readonly Model[],
  model: string | undefined,
  window: number | undefined,
  current: string | undefined
): string | undefined {
  const row = resolveModel(models, model, model, window);
  if (!row?.efforts?.length) return undefined;
  return row.efforts.some((effort) => effort.value === current) ? current : row.defaultEffort;
}

/**
 * `squadron.efforts` maps model values to non-empty effort strings.
 * `effortFor` validates an effort when a model is picked.
 */
export function modelEfforts(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [model, effort] of Object.entries(raw)) {
    if (typeof effort === 'string' && effort.trim()) out[model] = effort.trim();
  }
  return out;
}

/**
 * What a new session starts on when nobody picked: the gear's setting resolved
 * against the offered rows, with its saved effort. The draft's `+` and a job
 * from Remote both start here, so the two cannot disagree about a default.
 *
 * Unset: the first current row — never `models[0]`, since a leading legacy
 * row would start on an unadvertised model. With no row there is no native
 * vocabulary to trust a stored effort against, so the start names neither
 * model nor effort and the account's own default runs.
 *
 * Set but on no row — an id typed into the footer, or one the CLI has since
 * dropped: the string is exactly what the start passes, and the CLI refuses it
 * on turn one if it is wrong. `brandForModel` places a `grok-`/`gpt-` id so a
 * typed one still reaches its own CLI.
 */
export function defaultPick(
  models: readonly Model[],
  setting: string,
  window: number | undefined,
  efforts: Readonly<Record<string, string>>
): LaunchTarget | undefined {
  if (setting === '') {
    const first = models.find((m) => !m.legacy);
    return first ? rowPick(models, first, efforts) : undefined;
  }
  // No reading, because a start has no transcript: `resolveModel`'s pick arm
  // matches the window, or the first entry of that value.
  const hit = resolveModel(models, undefined, setting, window);
  return hit
    ? rowPick(models, hit, efforts)
    : { brand: brandForModel(setting), model: setting, window };
}

/** One row as a start names it, at the effort saved for it. */
export function rowPick(
  models: readonly Model[],
  model: Model,
  efforts: Readonly<Record<string, string>>
): LaunchTarget {
  const effort = effortFor(models, model.value, model.window, efforts[model.value]);
  return {
    brand: model.brand,
    model: model.value,
    window: model.window,
    ...(effort === undefined ? {} : { effort })
  };
}

/**
 * A context window as a card spells it: `1M`, `200k`, or the raw count.
 *
 * The same formula as `ctxLabel` in `webview/dom.ts`. That module imports
 * nothing, so `core/` cannot call it; `catalog.test.ts` pins the two equal.
 */
export const windowLabel = (size: number): string =>
  size >= 900_000 ? '1M' : size >= 1000 ? Math.round(size / 1000) + 'k' : String(size);

/**
 * The model name a card prints, and the window when that name may say one.
 *
 * `contextSize` is the window the session is in and outranks the catalog. A
 * model with a single window can only be in that one. A model with two and
 * nothing observed gets the bare name: guessing would be wrong half the time.
 * A spelling no row answers is unnamed here. The caller says the reading
 * verbatim rather than this choosing a model.
 */
export function shownModel(
  models: readonly Model[],
  reading: string | undefined,
  pick: string | undefined,
  contextSize?: number
): { text: string; window?: number } | undefined {
  if ((reading === undefined || reading === '') && (pick === undefined || pick === '')) {
    return undefined;
  }
  const hit = resolveModel(models, reading, pick, contextSize);
  if (!hit) return undefined;
  const sole = models.filter((m) => m.value === hit.value);
  const window = contextSize ?? (sole.length === 1 ? hit.window : undefined);
  return {
    text: window === undefined ? hit.name : `${hit.name} (${windowLabel(window)})`,
    ...(window === undefined ? {} : { window })
  };
}
