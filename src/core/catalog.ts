/**
 * Maintained model metadata the panel cannot obtain honestly at runtime.
 *
 * For Claude and Grok this is the complete offered catalog, written down here
 * rather than asked. This replaces Claude's `list_models` control request on
 * the runtime path. That
 * request answers with a *subset* of what the installed CLI will actually run —
 * the measurement, dated and versioned, is `cli_state/models.md` § *The gap:
 * listed ⊂ runnable*. It also answers in the CLI's spellings rather than ours,
 * which is how `claude-haiku-4-5-20251001` came to sit in the flyout beside
 * `claude-opus-5`. Both lines of a row are ours now: `name` above, `id` below.
 *
 * **Its own leaf, and it stays one.** `import type` from `model_names.ts` and
 * nothing else. `CatalogRow` no longer *extends* `Model` — it is the authoring
 * shape, one model carrying the windows it runs in, and `catalogFor` flattens
 * it to one `Model` per (row × window). The type-only import is still all this
 * needs, because the flatten *produces* `Model` rather than deriving from it,
 * and a value import back the other way would be a cycle either way. Nothing
 * here spawns a child or reads a file, which is what lets the flyout be full on
 * the first paint instead of after the first poll.
 *
 * **Nothing here *composes* a CLI spelling.** A row states a model and the
 * windows it has, in tokens; `CatalogWindow.reach` says *how* a window is
 * reached and `core/claude/adapter.ts` and `core/claude/session.ts` are the two
 * places that turn that into `[1m]` or `CLAUDE_CODE_DISABLE_1M_CONTEXT`.
 *
 * `[1m]` does appear below, seven times, and only ever inside `readings` — which
 * is not a spelling of ours but a record of what the CLI *says back*
 * (`init.model` keeps the suffix). That is the distinction the rule is really
 * about, and the release grep is written to it: no composed `[1m]` outside
 * `core/claude/`.
 * That is the brand seam the root `AGENTS.md` draws: a CLI's spelling of
 * anything, wire or disk, stays in the module owning that boundary. It is also
 * what lets Grok be `grok-4.6` with a 500k window rather than a special case.
 *
 * **Exact spellings, never patterns.** A prefix rule on `claude-opus-5` eats
 * `claude-opus-5[1m]`, which is the one distinction two rows are kept for. A
 * new dated snapshot is one more string, added by hand.
 *
 * Codex is the deliberate hybrid: its account-dependent `model/list` decides
 * which rows are visible and supplies live capabilities, while `CODEX_MODELS`
 * authors those known rows in the same shape as Claude and Grok. Nothing in
 * this file is parsed by the webview; `core/codex/models.ts` joins the live
 * facts onto the flattened catalog entries, which already ride the typed
 * `ModelView` protocol. A live id not authored here is still kept, without a
 * window pill, until it is probed.
 *
 * **Order, every brand alike.** Newest version first; where two rows share a
 * version, by model name — the family's rank, strongest first, not the
 * alphabet. So Opus 5.5 sits above Fable 5.1, but Fable 5 above Opus 5; and
 * Sol 6.1, Terra 6.1, Astra 6, Luna 6, then Sol 5.6. Current rows and Older
 * rows each follow it within their own block, since `legacy` sinks a row below
 * every current one whatever its version. The first current row is also what a
 * new draft opens on. A row that breaks the rule says why beside it.
 *
 * Provenance, and the checklist for adding model metadata:
 * `docs/reference/cli_state/models.md`. The rows are proved to still *run* by
 * `src/test/live_session/model_catalog.md` before a release; nothing here is
 * checked by `npm run check`, which has no CLI binary.
 */

import type { BrandId, WindowReach } from './model';
import type { Model } from './model_names';

/**
 * One model, in the panel's own words.
 *
 * The three spellings are three because the CLI states three, and no single key
 * joins them (probed 2026-08-27, 2.1.241):
 *
 * - `value` is what `--model` takes and what the setting stores.
 * - `id` is what the row *displays* under its name. Per-row, not canonical:
 *   both Opus 5 rows resolve to `claude-opus-5`, and printing that under both
 *   would draw two rows a reader cannot tell apart.
 * - `readings` is the set of spellings a live reading may arrive as — and only
 *   those that identify this row *uniquely*, not every spelling it can produce.
 *   A `[1m]` launch reports the unsuffixed id on `assistant.message.model`,
 *   which its plain sibling reports too, so that shared spelling belongs to the
 *   plain row alone.
 *
 * **Which cards this joins, precisely.** An *owned* session states a raw id:
 * `core/live.ts` carries what the frames said through to `Session.model`
 * verbatim, so this is where `readings` earns itself. Three rows below report a
 * dated spelling on `message.model` that appears in no `value` and no `id`. Two
 * of them are new — they had no row at all before. The third, Haiku, ticked
 * *because* the old CLI-shaped row happened to carry the dated spelling as its
 * `id`; moving `id` to the clean form is the display fix this file exists for,
 * and `readings` is what stops that fix breaking a tick that already worked.
 *
 * **A `[1m]` row is reachable from a reading, and that is not obvious.**
 * `message.model` drops the suffix, but `init.model` keeps it (probed
 * 2026-08-27 on 2.1.241, in protocol mode — under a one-shot `--print` it was
 * `null` then and states the suffix on 2.1.280), `init` leads every turn, and
 * `reduce.ts`'s `sameModel` keeps the
 * longer held spelling when the bases match. So `LiveState.model` stays
 * `claude-opus-5[1m]` and ticks the 1M row on every turn. **That tick depends
 * on `sameModel`** — the one load-bearing rule outside this file.
 *
 * A *discovered* session does not, and never did. `core/claude/discover.ts`
 * stores `modelName(message.model)` off the transcript — "Haiku 4.5", not an
 * id, and it matches no row here. That is unchanged by this file and
 * not worth a fourth tier: `modelName` erases the `[1m]` suffix too, so both
 * Opus rows produce one string and a name-keyed join would be ambiguous for
 * exactly the pairs these rows are kept apart for. Such a card still reads
 * correctly — `modelInForce` falls back to what the session said.
 */

/** One window a model runs in, and what it takes to get there. */
export interface CatalogWindow {
  /**
   * Tokens, as `result.modelUsage[].contextWindow` states it.
   *
   * Nothing here is guessable, which is the whole reason it is written down.
   * The name does not carry it — 4.7 is a million and 4.6 is two hundred
   * thousand — and the CLI's own fallback for an unfamiliar model is 200k,
   * which `claude/context.ts` declines to copy because it would print `55%`
   * for a session sitting at `11%` of a million.
   *
   * **Measured per (model, window) pair, never per model.** A suffixed value
   * is its own reading: probed 2026-08-27 on 2.1.241, `claude-opus-4-6` states
   * 200k and `claude-opus-4-6[1m]` states a million, so this field is what
   * tells the two apart and a shared figure would be wrong for one of them.
   *
   * **What the figure is, exactly: what this account ran.** The same probe met
   * three refusals — `claude-haiku-4-5[1m]` and `claude-opus-4-5[1m]` answer
   * *"the long context beta is not yet available for this subscription"*, and
   * `claude-sonnet-4-6[1m]` answers *"usage credits required for 1M context"*,
   * a billing gate rather than a missing model. So a row states the window its
   * value **has**, and which of them an account may reach is the account's
   * answer, delivered as a 400 in that session's own thread. A plain value's
   * figure is the softer half of that: read on a subscription that carries the
   * beta, and a machine without it would read the same value smaller.
   */
  tokens: number;
  /** How to ask for it. `core/claude/adapter.ts` turns this into a launch line. */
  reach: WindowReach;
  /**
   * The spellings that name *this window* rather than the row, when there are
   * any — a `suffix` window's `[1m]` form, which `init.model` reports back and
   * `message.model` does not.
   *
   * Absent is the common case and means "the row's readings answer for this
   * entry too". **Two entries of one row can therefore share a reading, and
   * that is not a bug to derive away:** Sonnet 5 and Fable 5 reach 1M plain and
   * 200k by flag, so neither window carries a suffix and the CLI reports
   * `claude-sonnet-5` whichever window the session is in. No reading can tell
   * them apart, because the flag does not change the id. Which window a session
   * is in is the *pick*'s to say, and `resolveModel` takes it as a second key.
   */
  readings?: readonly string[];
  /**
   * Offered, and refusable on billing grounds by an account that has the model.
   *
   * `claude-sonnet-4-6[1m]` answers *"usage credits required for 1M context"*
   * (probed 2026-08-27) — a gate, not a missing model, which is why the entry
   * stays in the list rather than being deleted. The catalog states what a
   * model has; the account decides what it may reach.
   */
  gated?: true;
}

/**
 * Author one row with its windows. catalogFor flattens it for callers.
 * Adding metadata: docs/reference/cli_state/models.md.
 */
export interface CatalogRow {
  /** What `--model` takes, raw — `claude-opus-5`, `grok-4.6`. Never carries a
   *  window: two entries of this row differ by `CatalogWindow.tokens` alone. */
  value: string;
  /**
   * `<Model Name> <Ver>`, without a brand or context size. Grok shares its brand
   * and model name. The menu draws window pills beside the name, so a size
   * here would name another control.
   * Surfaces showing one value add ctxLabel locally: a size here would give
   * their window label two sources that could disagree.
   */
  name: string;
  /** What the row *displays* under its name. Per-row rather than canonical. */
  id: string;
  /** Stamped here, never inferred from `value`. */
  brand: BrandId;
  /** Every spelling that names this row and no other. Always includes `value`.
   *  A spelling that names one *window* of it goes on that window instead. */
  readings: readonly string[];
  /** Places the row under Older. Claude uses the rows `list_models` trails
   *  after its picker's own (absence from it, before 2.1.284), plus Haiku 4.5
   *  by choice; Grok keeps prior generations there; Codex uses the
   *  maintained version cutoff documented on CODEX_MODELS. */
  legacy?: true;
  /**
   * Keep the row for sessions arriving via squadron-spawn or CLI defaults, so
   * joins can still supply its name and window. offeredModels drops it from
   * the menu before it reaches the wire, unlike gated or fixed rows.
   * See grok-4.7-build-fast for why its row is unlisted.
   */
  unlisted?: true;
  /** Native effort values verified for this exact row, **strongest first** —
   *  which is the menu's order, and the reverse of how most CLIs state theirs. */
  efforts?: Model['efforts'];
  /**
   * What a start opens at. **Never absent beside `efforts`**, and one of them:
   * a row that leaves it out sends no `--effort` at all, so the session runs at
   * whatever the installed binary defaults to that day. Native where the brand
   * states a default and ours where it does not, per brand in
   * `cli_state/models.md` § *Efforts*. `catalog.test.ts` holds both halves.
   */
  defaultEffort?: string;
  /**
   * Widest first and never empty. If several entries match a reading with no
   * pick, resolveModel answers the first. Keep the flat catalog's widest answer.
   */
  windows: readonly CatalogWindow[];
}

// Strongest first, as every brand's list on this panel is — `list_models`
// states the same five weakest-first.
const CLAUDE_EFFORTS = [
  { value: 'max' },
  { value: 'xhigh' },
  { value: 'high' },
  { value: 'medium' },
  { value: 'low' }
] as const;

/**
 * Claude's opening efforts, and they are ours rather than a reading:
 * `list_models` carries `supportedEffortLevels` and nothing beside it, and
 * `init` reports `effort: null` on every frame, so there is nothing to observe
 * until somebody sets one. Opus and Fable open at `medium`, every other Claude
 * row that takes an effort at `high` — user's call, 2026-10-19.
 */
const CLAUDE_DEFAULT_EFFORT = 'high';
const CLAUDE_OPUS_FABLE_EFFORT = 'medium';

/**
 * Claude's rows.
 *
 * Every one probed 2026-08-27 on 2.1.241, macOS, with
 * `claude --print --output-format stream-json --verbose --model <value> "hi"`;
 * `contextWindow` and the canonical id are read from `result.modelUsage`, and
 * the reading from the first `assistant` frame's `message.model`.
 *
 * Three of them report a *dated* `message.model` that no other field mentions
 * — haiku-4-5, opus-4-5 and sonnet-4-5 — which is the whole reason `readings`
 * is a set rather than one string.
 *
 * Fable 5.1 was added the same way, 2026-09-02 on 2.1.258, and Fable 5 was
 * demoted in the same sitting: `list_models` swapped one for the other while
 * both still run. `docs/reference/cli_state/models.md` § *A model arriving,
 * watched* has the readings and the version floor the CLI refuses below.
 *
 * Opus 5.5 arrived the same way, 2026-09-23 on 2.1.280, demoting Opus 5 in the
 * same sitting — the same swap, watched a second time. Sonnet 5.5 arrived on
 * 2.1.284, 2026-09-29, demoting Sonnet 5 — but that release lists the older
 * models too, so what demotes a row changed; see Older below.
 */
export const CLAUDE_MODELS: readonly CatalogRow[] = [
  {
    value: 'claude-opus-5-5',
    name: 'Opus 5.5',
    id: 'claude-opus-5-5',
    brand: 'claude',
    // Probed 2026-09-23 on 2.1.280: plain and `[1m]` both state 1,000,000, so
    // the suffix buys no window and earns no row — `cli_state/models.md`
    // § *Opus 5.5*. It sits in `readings` because the drift check cannot see
    // this row without it; that section says why.
    readings: ['claude-opus-5-5', 'claude-opus-5-5[1m]'],
    efforts: CLAUDE_EFFORTS,
    defaultEffort: CLAUDE_OPUS_FABLE_EFFORT,
    windows: [
      { tokens: 1_000_000, reach: 'plain' },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-sonnet-5-5',
    name: 'Sonnet 5.5',
    id: 'claude-sonnet-5-5',
    brand: 'claude',
    // Opus 5.5's shape, probed 2026-09-29 on 2.1.284: `[1m]` states the same
    // million as the bare id, and sits in `readings` for the drift check.
    readings: ['claude-sonnet-5-5', 'claude-sonnet-5-5[1m]'],
    efforts: CLAUDE_EFFORTS,
    defaultEffort: CLAUDE_DEFAULT_EFFORT,
    windows: [
      { tokens: 1_000_000, reach: 'plain' },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-haiku-5-5',
    name: 'Haiku 5.5',
    id: 'claude-haiku-5-5',
    brand: 'claude',
    // Probed 2026-10-08 on 2.1.294: bare and `[1m]` both reach 1M; the
    // disable-1M setting pins 200k. `cli_state/models.md` § *Haiku 5.5*.
    readings: ['claude-haiku-5-5', 'claude-haiku-5-5[1m]'],
    efforts: CLAUDE_EFFORTS,
    defaultEffort: CLAUDE_DEFAULT_EFFORT,
    windows: [
      { tokens: 1_000_000, reach: 'plain' },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-fable-5-1',
    name: 'Fable 5.1',
    id: 'claude-fable-5-1',
    brand: 'claude',
    readings: ['claude-fable-5-1'],
    efforts: CLAUDE_EFFORTS,
    defaultEffort: CLAUDE_OPUS_FABLE_EFFORT,
    windows: [
      { tokens: 1_000_000, reach: 'plain' },
      { tokens: 200_000, reach: 'flag' }
    ]
  },

  // Below here: Older. Runnable, and — Haiku 4.5 aside — not among the rows
  // `list_models` leads with. Until 2.1.284 that meant absent from it: Fable 5
  // demoted on 2.1.258 the day 5.1 took its place in the picker, Opus 5 on
  // 2.1.280 the day 5.5 did, the rest probed on 2.1.241 and found already gone.
  // 2.1.284 lists all of them again, after `haiku` and with nothing marking the
  // split, so Sonnet 5 — demoted the day Sonnet 5.5 arrived — was demoted by
  // hand, and the drift check's "advertised again" bucket is now expected.
  // `cli_state/models.md` § *Sonnet 5.5*.

  // Legacy since 2026-09-02, and the first row to *become* legacy while this
  // catalog watched. 2.1.257 added Fable 5.1 and 2.1.258's `list_models`
  // answers with it in Fable 5's place — no row for `claude-fable-5` in any
  // spelling — while `--model claude-fable-5` still runs and still reports a
  // million. Exactly the gap this file exists to hold open, arriving for once
  // with a before and an after rather than as an archaeological finding.
  {
    value: 'claude-fable-5',
    name: 'Fable 5',
    id: 'claude-fable-5',
    brand: 'claude',
    readings: ['claude-fable-5'],
    legacy: true,
    windows: [
      { tokens: 1_000_000, reach: 'plain' },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-opus-5',
    name: 'Opus 5',
    id: 'claude-opus-5',
    brand: 'claude',
    readings: ['claude-opus-5'],
    efforts: CLAUDE_EFFORTS,
    defaultEffort: CLAUDE_OPUS_FABLE_EFFORT,
    legacy: true,
    windows: [
      {
        tokens: 1_000_000,
        reach: 'suffix',
        readings: ['claude-opus-5[1m]']
      },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-sonnet-5',
    name: 'Sonnet 5',
    id: 'claude-sonnet-5',
    brand: 'claude',
    readings: ['claude-sonnet-5'],
    efforts: CLAUDE_EFFORTS,
    defaultEffort: CLAUDE_DEFAULT_EFFORT,
    legacy: true,
    windows: [
      { tokens: 1_000_000, reach: 'plain' },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-opus-4-8',
    name: 'Opus 4.8',
    id: 'claude-opus-4-8',
    brand: 'claude',
    readings: ['claude-opus-4-8'],
    legacy: true,
    windows: [
      {
        tokens: 1_000_000,
        reach: 'suffix',
        readings: ['claude-opus-4-8[1m]']
      },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-opus-4-7',
    name: 'Opus 4.7',
    id: 'claude-opus-4-7',
    brand: 'claude',
    readings: ['claude-opus-4-7'],
    legacy: true,
    windows: [
      {
        tokens: 1_000_000,
        reach: 'suffix',
        readings: ['claude-opus-4-7[1m]']
      },
      { tokens: 200_000, reach: 'flag' }
    ]
  },
  {
    value: 'claude-opus-4-6',
    name: 'Opus 4.6',
    id: 'claude-opus-4-6',
    brand: 'claude',
    readings: ['claude-opus-4-6'],
    legacy: true,
    windows: [
      {
        tokens: 1_000_000,
        reach: 'suffix',
        readings: ['claude-opus-4-6[1m]']
      },
      { tokens: 200_000, reach: 'plain' }
    ]
  },
  {
    value: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    id: 'claude-sonnet-4-6',
    brand: 'claude',
    readings: ['claude-sonnet-4-6'],
    legacy: true,
    windows: [
      {
        tokens: 1_000_000,
        reach: 'suffix',
        readings: ['claude-sonnet-4-6[1m]'],
        gated: true
      },
      { tokens: 200_000, reach: 'plain' }
    ]
  },
  {
    value: 'claude-opus-4-5',
    name: 'Opus 4.5',
    id: 'claude-opus-4-5',
    brand: 'claude',
    readings: ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
    legacy: true,
    windows: [{ tokens: 200_000, reach: 'plain' }]
  },
  {
    value: 'claude-sonnet-4-5',
    name: 'Sonnet 4.5',
    id: 'claude-sonnet-4-5',
    brand: 'claude',
    readings: ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
    legacy: true,
    windows: [
      {
        tokens: 1_000_000,
        reach: 'suffix',
        readings: ['claude-sonnet-4-5[1m]']
      },
      { tokens: 200_000, reach: 'plain' }
    ]
  },
  // Still listed by `list_models`; under Older by choice rather than the CLI's
  // (asked 2026-09-27).
  {
    value: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    id: 'claude-haiku-4-5',
    brand: 'claude',
    readings: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    legacy: true,
    windows: [{ tokens: 200_000, reach: 'plain' }]
  }
];

/**
 * Grok's rows, moved here from `grok/adapter.ts` with the sitting that took
 * them: **observed 2026-08-15, CLI 1.0.4**, `grok models` and initialize
 * `_meta`. Re-checked 2026-08-27 on 1.0.5 and 2026-09-02 on 1.0.13 — the same
 * two models, same default, both times.
 *
 * **Re-checked 2026-09-22 on 1.0.40, and the list moved.** `grok models` names
 * four: `grok-4.7` (the default now, displacing 4.6), `grok-4.7-build-fast`
 * — *"Fast variant. 2x the price."*, the CLI's own words, which is a billing
 * fact this file does not otherwise record — then 4.6 and 4.5, neither retired.
 * The two new rows were typed from the handshake below; `models.mjs grok` was
 * re-run after and agreed, which is the check it is for rather than the source.
 *
 * `readings` is `[value]` for each, and that is the whole truth rather than a
 * placeholder: this CLI's id, flag spelling and reading coincide, so there is
 * no third spelling to carry. Step 9's generator is what will keep that honest.
 *
 * **The window and the efforts are stated per model, and `grok models` states
 * neither.** The handshake does. One disposable
 * `grok agent --no-leader --always-approve stdio` child, no prompt sent,
 * 2026-09-22 on 1.0.40, read **500,000 for all four rows** and the effort lists
 * below — 4.7 and 4.7-build-fast take xhigh, 4.5 still does not, and every row
 * marks `high` `default: true`. Which keys those came off, and the 610-dir
 * `signals.json` correlation that bought 4.6's and 4.5's figures before the
 * handshake stated them: `cli_state/models.md` § *Grok*. The two agree.
 *
 * **Not adjustable by a flag, and the config key is not what it looks like.**
 * `grok --help` on 1.0.5 offers no context or compaction option.
 * `~/.grok/config.toml` takes a `[model."grok-4.6"] context_window`, but the
 * CLI's own docs call it the auto-compaction trigger — lowering it compacts
 * earlier, raising it past 500k only compacts late, and the API still cuts off
 * at the real limit. So a machine that sets it desyncs this figure without
 * changing what the model will hold, and there is no source that reports the
 * effective value per session.
 */
export const GROK_MODELS: readonly CatalogRow[] = [
  {
    value: 'grok-4.7',
    name: 'Grok 4.7',
    id: 'grok-4.7',
    brand: 'grok',
    readings: ['grok-4.7'],
    efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    defaultEffort: 'high',
    windows: [{ tokens: 500_000, reach: 'plain' }]
  },
  {
    // `name` is the CLI's own, off `availableModels[].name` (1.0.40) — the one
    // row here whose name is not its value in title case.
    //
    // **`unlisted` because the CLI calls it "Fast variant. 2x the price." and
    // no surface of ours can say so.** Offered, it would sit one press under
    // the default with nothing to mark the difference; `ModelView` has no field
    // for a price and inventing one is a protocol change, not a catalog edit.
    // So the row is kept for what it knows — the name, the window, the efforts,
    // and the reading a session that does arrive on it joins by — and the
    // flyout never puts it in front of anyone. User's call, 2026-09-22.
    value: 'grok-4.7-build-fast',
    name: 'Grok 4.7 Fast',
    id: 'grok-4.7-build-fast',
    brand: 'grok',
    unlisted: true,
    readings: ['grok-4.7-build-fast'],
    efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    defaultEffort: 'high',
    windows: [{ tokens: 500_000, reach: 'plain' }]
  },
  {
    value: 'grok-4.6',
    name: 'Grok 4.6',
    id: 'grok-4.6',
    brand: 'grok',
    legacy: true,
    readings: ['grok-4.6'],
    efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    defaultEffort: 'high',
    windows: [{ tokens: 500_000, reach: 'plain' }]
  },
  {
    value: 'grok-4.5',
    name: 'Grok 4.5',
    id: 'grok-4.5',
    brand: 'grok',
    legacy: true,
    readings: ['grok-4.5'],
    efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
    defaultEffort: 'high',
    windows: [{ tokens: 500_000, reach: 'plain' }]
  }
];

/**
 * Codex's known rows, in the same authoring shape as Claude and Grok.
 *
 * Unlike Claude and Grok, Codex keeps account-specific availability live:
 * visibility, efforts, modalities, and defaults still come from `model/list`.
 * Display names come from these rows, falling back to `model/list` for unknown
 * models. `core/codex/models.ts` uses that response to select and
 * enrich these rows; an unseen live id stays selectable and simply has no pill
 * until it is probed.
 *
 * Tokens are the runtime budget, shared by the picker, selection and card.
 * Observed 2026-08-31 on CLI 0.151.0: `modelContextWindow` was 258400 / 121600,
 * 95% of the declared 272000 / 128000 capacity. The declared capacity and API
 * maximum are evidence, not separate selection or display values.
 *
 * GPT-6 Sol and Luna added 2026-09-23 on CLI 0.155.1: `codex debug models`
 * states the same 272000 / 872000 pair as every GPT-6 and GPT-5.6 row. Their
 * ephemeral corroborating turn is **still owed** — the account was over its
 * usage limit that day and every turn failed `usageLimitExceeded` before a
 * `thread/tokenUsage/updated` arrived. Run it and record the budget in
 * `cli_state/models.md` § *Codex*.
 *
 * GPT-6.1 Sol added 2026-09-30 on CLI 0.159.2 (0.158.0 does not list it):
 * the same 272000 / 872000 pair, and one ephemeral turn read 258400.
 * Its 2026-10-15 account cache (CLI 0.162.1) now declares 500000 / 872000,
 * with `effective_context_window_percent: 95`; other GPT-6 rows remain 272000.
 * The shared runtime window below is therefore 475000, not 500000.
 *
 * Terra 6.1 added 2026-10-27: the account cache declares 500000 tokens at
 * 95% effective context, giving the same 475000 budget as Sol 6.1.
 * `cli_state/models.md` § *Codex* records the cache evidence.
 *
 * Since 2026-09-30 the user's Older cutoff is below GPT-6.1 Sol for Sol, and
 * below GPT-6 for Astra and Luna, which have no 6.1 yet. This grouping
 * is independent of CLI retirement; the observed `upgrade` fields remain
 * recorded in `cli_state/codex/usage.md` § *Deprecation is a field*.
 */
export const CODEX_MODELS: readonly CatalogRow[] = [
  {
    value: 'gpt-6.1-sol',
    name: 'Sol 6.1',
    id: 'gpt-6.1-sol',
    brand: 'codex',
    readings: ['gpt-6.1-sol'],
    windows: [{ tokens: 475_000, reach: 'plain' }]
  },
  {
    value: 'gpt-6.1-terra',
    name: 'Terra 6.1',
    id: 'gpt-6.1-terra',
    brand: 'codex',
    readings: ['gpt-6.1-terra'],
    windows: [{ tokens: 475_000, reach: 'plain' }]
  },
  {
    value: 'gpt-6-astra',
    name: 'Astra 6',
    id: 'gpt-6-astra',
    brand: 'codex',
    readings: ['gpt-6-astra'],
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-6-luna',
    name: 'Luna 6',
    id: 'gpt-6-luna',
    brand: 'codex',
    readings: ['gpt-6-luna'],
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-6-sol',
    name: 'Sol 6',
    id: 'gpt-6-sol',
    brand: 'codex',
    readings: ['gpt-6-sol'],
    legacy: true,
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-5.6-sol',
    name: 'Sol 5.6',
    id: 'gpt-5.6-sol',
    brand: 'codex',
    readings: ['gpt-5.6-sol'],
    legacy: true,
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-5.6-terra',
    name: 'Terra 5.6',
    id: 'gpt-5.6-terra',
    brand: 'codex',
    readings: ['gpt-5.6-terra'],
    legacy: true,
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-5.6-luna',
    name: 'Luna 5.6',
    id: 'gpt-5.6-luna',
    brand: 'codex',
    readings: ['gpt-5.6-luna'],
    legacy: true,
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-5.5',
    name: 'GPT-5.5',
    id: 'gpt-5.5',
    brand: 'codex',
    readings: ['gpt-5.5'],
    legacy: true,
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-5.4',
    name: 'GPT-5.4',
    id: 'gpt-5.4',
    brand: 'codex',
    readings: ['gpt-5.4'],
    // `upgrade` names gpt-5.6-terra, 2026-08-31T19:00:00Z.
    legacy: true,
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-5.4-mini',
    name: 'Mini 5.4',
    id: 'gpt-5.4-mini',
    brand: 'codex',
    readings: ['gpt-5.4-mini'],
    // `upgrade` names gpt-5.6-luna, 2026-08-31T19:00:00Z.
    legacy: true,
    windows: [{ tokens: 258_400, reach: 'plain' }]
  },
  {
    value: 'gpt-5.3-codex-spark',
    name: 'Spark 5.3',
    id: 'gpt-5.3-codex-spark',
    brand: 'codex',
    readings: ['gpt-5.3-codex-spark'],
    legacy: true,
    windows: [{ tokens: 121_600, reach: 'plain' }]
  }
];

/** Every brand's rows, by the id the registry knows it as. A brand with no
 *  entry offers nothing, which is what an unsupported CLI should offer. */
const BY_BRAND: Readonly<Record<string, readonly CatalogRow[]>> = {
  claude: CLAUDE_MODELS,
  grok: GROK_MODELS,
  codex: CODEX_MODELS
};

/**
 * One (row × window) as the rest of the panel sees it.
 *
 * `value`, `id` and `name` are the row's, verbatim — no window is composed into
 * any of them. The first two because they are raw CLI spellings and the window
 * is ours; `name` because the menu draws the windows as pills beside it, so
 * every window of a model shows the same name. What tells two entries of one
 * row apart is `window`, and the two surfaces that hold a single value spell it
 * with `ctxLabel` where they draw it.
 *
 * `readings` is the window's own where it states any, else the row's. That
 * derives most of the uniqueness `model_catalog.md` used to keep by hand: a
 * `suffix` window claims its `[1m]` spelling and the row keeps the shared
 * unsuffixed one. It does **not** derive uniqueness per entry, and cannot —
 * see `CatalogWindow.readings`.
 */
function flatten(rows: readonly CatalogRow[]): readonly Model[] {
  return rows.flatMap((row) =>
    row.windows.map((w) => ({
      value: row.value,
      id: row.id,
      name: row.name,
      brand: row.brand,
      readings: w.readings ?? row.readings,
      window: w.tokens,
      // Omit unset fields: promote's {...twin, ...record} lets a present
      // undefined value overwrite a real one on the left.
      ...(row.legacy ? { legacy: row.legacy } : {}),
      ...(row.unlisted ? { unlisted: row.unlisted } : {}),
      ...(row.efforts ? { efforts: row.efforts } : {}),
      ...(row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
      ...(w.gated ? { gated: w.gated } : {})
    }))
  );
}

/**
 * Preserve array identity across polls. offeredModels spreads these shared
 * objects rather than mutating them, and catalog.test.ts asserts the identity.
 */
const FLAT: Readonly<Record<string, readonly Model[]>> = {
  claude: flatten(CLAUDE_MODELS),
  grok: flatten(GROK_MODELS),
  codex: flatten(CODEX_MODELS)
};

export function catalogFor(brand: BrandId): readonly Model[] {
  return FLAT[brand] ?? [];
}

/**
 * A window a caller stated, as tokens, or nothing.
 *
 * What it guards is a setting: `squadron.contextWindow` is declared
 * `["number", "null"]` with a `null` default, and that null is the whole reason
 * this exists — `config.get<number>(…)` types one away without removing it, and
 * a `null` reaching `windowOf` misses every window by luck rather than by a
 * guard anyone can point at. Anything that is not a positive number is "no
 * window named", which is what a start with none has always meant.
 */
export function windowTokens(raw: unknown): number | undefined {
  return typeof raw === 'number' && raw > 0 ? raw : undefined;
}

/**
 * The share of a window a token count is, the way the CLI rounds it.
 *
 * Brand-free because two paths fill the same field from different evidence:
 * Claude's reducer divides a transcript reading by a learnt window, Codex's
 * `usage` event states both halves itself. One rounding rule, or the same
 * session reads two percentages depending on which half of the tree saw it.
 */
export function contextPercent(tokens: number, size: number): number {
  return Math.min(100, Math.round((tokens / size) * 100));
}

/**
 * The window a (brand, id, tokens) triple came from — the only way back from a
 * flattened entry to how its window is *reached*.
 *
 * Lives here because this is the file that knows the pair, and it is
 * `vscode`-free so `core/claude/adapter.ts` can call it on the launch path.
 *
 * Both halves are nullable because "no window named" is the ordinary case, not
 * an error: a typed id, a stored setting from before this shipped, a session
 * started with neither. Every caller reads `undefined` as "launch it plain, as
 * today".
 */
function rowOf(brand: BrandId, id: string | undefined): CatalogRow | undefined {
  return (BY_BRAND[brand] ?? []).find((r) => r.value === id);
}

export function windowOf(
  brand: BrandId,
  id: string | undefined,
  tokens: number | undefined
): CatalogWindow | undefined {
  return rowOf(brand, id)?.windows.find((w) => w.tokens === tokens);
}

/**
 * Whether a session whose **launch line** reached its window by `from` can be
 * switched onto this (brand, id, tokens) pair.
 *
 * A line cannot change, which is `WindowReach`'s to say (`core/model.ts`), so
 * every window the flag decides is decided already. `from` is
 * `LiveState.launchReach` / `Session.launchReach`.
 *
 * Two callers, and that is the whole point of the function: `setModel`
 * (`core/claude/session.ts`) decides what to spell, and `modelsForSession`
 * (`core/adapter.ts`) stamps `fixed` on the dock's menu. Two implementations of
 * one rule disagree eventually; there is one.
 *
 * **It keys on the resulting width, not on `reach` alone.** A flagged line pins
 * the *narrow end* of a row whatever the id spells — measured, and the two
 * readings that force it are `claude-opus-5[1m]` held to 200k and
 * `claude-sonnet-5`, whose 1M needs no suffix, held to 200k as well
 * (`TASK_done_window_fixed.md` § *Observed data*). A pure `reach` test
 * over-blocks in both directions: `claude-opus-4-6`'s `plain` 200k really is
 * reachable from a flagged line, and Haiku 4.5's only window really is
 * reachable from a 1M one.
 *
 * Permissive where it cannot know, twice over: an unknown `from` answers `true`
 * for everything, and so does a pair no row states — a typed id has no window
 * to contradict. A dead control is better than a live one wrongly removed.
 *
 * What it is **not** about is the account. Which windows a plan may reach is
 * not observable from here and arrives as a 400 in that session's own thread;
 * `CatalogWindow.gated` is that, and is a separate mark. This answers only "can
 * this session's own line carry it", which is a fact we own.
 */
/**
 * Whether this account is granted the **wide** window when a line asks plainly
 * — read off what a session is observably running, never off a plan name.
 *
 * The question the pills really turn on. A row with two windows has one the
 * account gets by default and one it does not: on a subscription carrying the
 * 1M beta, `claude-opus-5` runs at a million and 200k needs the flag; on one
 * without it, the same line runs at 200k and the million is refused. Which of
 * the two an account is on decides every pill on that row, in *opposite*
 * directions — so a rule that ignores it dims a working control on one of them.
 *
 * **Observed, because the alternative is a plan table.** The CLI does name a
 * plan (`AccountBrandFacts.plan`, "Max"), and matching that string is what this
 * refuses: it is another program's marketing copy, it says nothing about the
 * beta directly, and it does not survive a tier being renamed or added. What a
 * session *ran at* is a measurement, and it is already on the card.
 *
 * Three answers, and the third is common. `true` — the session sits in its
 * row's widest window with no flag on the line, so the account is granted it.
 * `false` — it sits in the narrowest **and that window is reached by the flag**,
 * so landing there without one means the account defaults narrow. `undefined` —
 * anything else, and it blocks nothing:
 *
 * - a flagged line, which pinned the window itself and so witnesses nothing;
 * - a one-window row, which has no default to reveal;
 * - a narrow window reached `plain` (`claude-opus-4-6`), where sitting in it is
 *   the row's own doing and not the account's;
 * - a session that has not run a turn and asked for nothing, which has stated
 *   no width yet.
 */
export function defaultsWide(
  brand: BrandId,
  model: string | undefined,
  running: number | undefined,
  from: WindowReach | undefined
): boolean | undefined {
  if (from === 'flag' || running === undefined) return undefined;
  const row = rowOf(brand, model);
  if (!row || row.windows.length < 2) return undefined;
  const tokens = row.windows.map((w) => w.tokens);
  if (running === Math.max(...tokens)) return true;
  const narrowest = row.windows.find((w) => w.tokens === Math.min(...tokens));
  return running === narrowest?.tokens && narrowest?.reach === 'flag' ? false : undefined;
}

export function reachableFrom(
  brand: BrandId,
  id: string | undefined,
  tokens: number | undefined,
  from: WindowReach | undefined,
  wide?: boolean
): boolean {
  if (from === undefined) return true;
  const row = rowOf(brand, id);
  const window = row?.windows.find((w) => w.tokens === tokens);
  if (!row || !window) return true;
  const narrowest = Math.min(...row.windows.map((w) => w.tokens));
  // A flagged line and a narrow-defaulting account come to the same thing: the
  // narrow end, and nothing else. One pins it, the other is simply never
  // offered the wide one.
  if (from === 'flag' || wide === false) return window.tokens === narrowest;
  // Granted the wide window, so the only thing out of reach is a window that
  // needs the flag this line does not carry.
  if (wide) return window.reach !== 'flag';
  // No evidence either way — block nothing. A dead control is better than a
  // live one wrongly removed, and this resolves as soon as a turn states a
  // width.
  return true;
}
