import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GROK_MODELS,
  catalogFor,
  defaultsWide,
  reachableFrom,
  windowOf,
  type CatalogRow
} from '../../core/catalog';
import type { BrandId } from '../../core/model';
import type { Model } from '../../core/model_names';
import { resolveModel, windowLabel } from '../../core/model_names';
import { ctxLabel } from '../../webview/dom';

/**
 * The catalog's own invariants, asserted over whatever rows a brand declares.
 *
 * These are not style rules. `resolveModel` joins a live reading to a row by
 * walking `readings`, and it is handed every brand's rows at once
 * (`ui/panel_bag.ts`, over `bag.state.models`) — so a spelling two rows both
 * claim is a tick that lands on whichever was written first, which is the coin
 * flip this whole task exists to remove.
 */
function rowInvariants(rows: readonly CatalogRow[], what: string): void {
  it(`${what}: no reading is claimed by two rows`, () => {
    const owner = new Map<string, string>();
    for (const row of rows) {
      for (const reading of row.readings) {
        const held = owner.get(reading);
        assert.equal(held, undefined, `${reading} is claimed by both ${held} and ${row.value}`);
        owner.set(reading, row.value);
      }
    }
  });

  /** Probed 2026-08-27 on 2.1.241: `--model claude-haiku-4-5` reports the flag
   *  spelling back, so the flag is itself a reading a session can arrive in. */
  it(`${what}: every row's value is one of its own readings`, () => {
    for (const row of rows) {
      assert.ok(row.readings.includes(row.value), `${row.value} is not in its own readings`);
    }
  });

  it(`${what}: every row states at least one window, and states it fully`, () => {
    for (const row of rows) {
      assert.ok(row.windows.length > 0, `${row.value} states no window`);
      for (const w of row.windows) {
        assert.ok(w.tokens > 0, `${row.value} states a window of ${w.tokens} tokens`);
      }
    }
  });

  /**
   * Windows run widest first, and `CatalogRow.windows` says why it matters:
   * where a reading matches several entries of a row and no pick tells them
   * apart, `resolveModel` answers the first one. Sonnet 5 read 1,000,000 before
   * the restructure, and this is what keeps it reading 1,000,000 after.
   */
  it(`${what}: a row's windows are widest first`, () => {
    for (const row of rows) {
      const sizes = row.windows.map((w) => w.tokens);
      assert.deepEqual(
        sizes,
        [...sizes].sort((a, b) => b - a),
        `${row.value} is out of order`
      );
      assert.equal(new Set(sizes).size, sizes.length, `${row.value} states one size twice`);
    }
  });

  /**
   * **At most one `plain` window per row**, which is the derivable half of the
   * rule the task file wrote as "no flagship row states a `plain` window".
   *
   * That wording could not be asserted: which models give the *account's*
   * window for a bare `--model` is measured, not derived — `claude-opus-5`
   * plain is 1M on Max and 200k on Pro, while `claude-opus-4-6` plain is
   * 200,000 on every account. Nothing in a row distinguishes them. What *is*
   * derivable is the logic of the word: `plain` means "what you get with no
   * spelling", and there is only one such thing per model. A row that offered
   * two would be claiming a bare `--model` reaches two different windows.
   */
  it(`${what}: no row offers two plain windows`, () => {
    for (const row of rows) {
      const plain = row.windows.filter((w) => w.reach === 'plain');
      assert.ok(plain.length <= 1, `${row.value} offers ${plain.length} plain windows`);
    }
  });

  /**
   * A `flag` is `CLAUDE_CODE_DISABLE_1M_CONTEXT`, which only ever holds a model
   * *down*; a `suffix` is `[1m]`, which only ever reaches *up* — the CLI has no
   * `[200k]` counterpart (probed 2026-08-27). So either on a row's only window
   * is a spelling that cannot do anything.
   */
  it(`${what}: a flag narrows and a suffix widens, against another window`, () => {
    for (const row of rows) {
      for (const w of row.windows) {
        const others = row.windows.filter((o) => o !== w);
        if (w.reach === 'flag') {
          assert.ok(
            others.some((o) => o.tokens > w.tokens),
            `${row.value} reaches ${w.tokens} by flag with nothing wider to be held down from`
          );
        }
        if (w.reach === 'suffix') {
          assert.ok(
            others.some((o) => o.tokens < w.tokens),
            `${row.value} reaches ${w.tokens} by suffix with nothing narrower to widen from`
          );
        }
      }
    }
  });

  /**
   * The two rules `CatalogRow.efforts` and `CatalogRow.defaultEffort` state,
   * held here because a row breaks either one silently: the menu draws the
   * array in its own order, and a missing default reaches the reader as a start
   * whose effort nobody here chose.
   *
   * **The ladder ranks the values these brands happen to share, and a value it
   * does not name is left unranked rather than failed.** `core/model.ts` is
   * explicit that effort is native to a brand with no common scale across them,
   * so a future CLI's vocabulary is not this file's to refuse — its own row
   * assertion below is what pins its order.
   */
  const LADDER = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low'];
  it(`${what}: a row's efforts run strongest first, under a default of its own`, () => {
    for (const row of rows) {
      if (!row.efforts) {
        assert.equal(
          row.defaultEffort,
          undefined,
          `${row.value} defaults an effort it cannot take`
        );
        continue;
      }
      const ranks = row.efforts
        .map((effort) => LADDER.indexOf(effort.value))
        .filter((rank) => rank !== -1);
      assert.deepEqual(
        ranks,
        [...ranks].sort((a, b) => a - b),
        `${row.value}: efforts ascend`
      );
      assert.ok(
        row.efforts.some((effort) => effort.value === row.defaultEffort),
        `${row.value} states no default effort among its own`
      );
    }
  });
}

/**
 * The same file's invariants, one level down — over what `catalogFor` hands
 * back rather than over what a row author wrote.
 *
 * `resolveModel` joins a live reading against *these*, and it is handed every
 * brand's at once (`ui/panel_bag.ts`, over `bag.state.models`).
 */
function entryInvariants(entries: readonly Model[], what: string): void {
  it(`${what}: no two entries share a value and a window`, () => {
    const seen = new Set<string>();
    for (const m of entries) {
      const key = `${m.value}@${m.window}`;
      assert.ok(!seen.has(key), `two entries carry --model ${m.value} at ${m.window}`);
      seen.add(key);
    }
  });

  /**
   * **Two entries of one model share a name, and that is the shape now.**
   *
   * This asserted the opposite until shape B: the name carried `(1M)`, so a
   * duplicate label meant two rows a reader could not choose between. B draws
   * one row per model with a pill per window, so the name is the *model's* and
   * the pill is what differs — a name that varied inside a row would put two
   * spellings on one row's label.
   *
   * The rule that replaces it is the one above, on (`value`, `window`): that
   * is what a menu keys on, and it is what still cannot repeat.
   */
  it(`${what}: every entry of one value reads the same name`, () => {
    const named = new Map<string, string>();
    for (const m of entries) {
      const first = named.get(m.value);
      if (first === undefined) named.set(m.value, m.name);
      else assert.equal(m.name, first, `${m.value} reads "${first}" and "${m.name}"`);
    }
  });

  it(`${what}: every entry states a window`, () => {
    for (const m of entries) {
      assert.ok((m.window ?? 0) > 0, `${m.value} reached the panel with no window`);
    }
  });
}

/**
 * Within one brand, the legacy entries come last — what the flyout's separator
 * sorts on. Deliberately not asserted over two brands concatenated: that list
 * legitimately runs Claude's legacy entries above Grok's current ones, and the
 * menu groups by brand before it draws a rule.
 */
function ordering(entries: readonly Model[], what: string): void {
  it(`${what}: legacy entries come after current ones`, () => {
    const first = entries.findIndex((m) => m.legacy);
    if (first === -1) return;
    assert.ok(
      entries.slice(first).every((m) => m.legacy),
      'a current entry sits below a legacy one'
    );
  });
}

describe('model catalog', () => {
  rowInvariants(CLAUDE_MODELS, 'claude');
  rowInvariants(GROK_MODELS, 'grok');
  rowInvariants(CODEX_MODELS, 'codex');
  // Across brands too, and not for tidiness: the panel is handed every brand's
  // rows in one array (`StateMessage.models`), so a spelling two brands both
  // claim is the same coin flip as one two rows within a brand claim.
  //
  // **Readings uniqueness lives at the row level and stays there.** Asserting
  // it per flattened entry would fail on correct data: Sonnet 5 and Fable 5
  // reach 1M plain and 200k by flag, so neither window states readings of its
  // own and both entries inherit the row's. No reading can tell those apart,
  // because the flag does not change the id the CLI reports back.
  rowInvariants([...CLAUDE_MODELS, ...GROK_MODELS, ...CODEX_MODELS], 'every brand at once');

  entryInvariants(catalogFor('claude'), 'claude, flattened');
  entryInvariants(catalogFor('grok'), 'grok, flattened');
  entryInvariants(catalogFor('codex'), 'codex, flattened');
  entryInvariants(
    [...catalogFor('claude'), ...catalogFor('grok'), ...catalogFor('codex')],
    'every brand, flattened'
  );
  // Claude alone: Grok states no legacy row, so the same call over its entries
  // returns before it asserts anything.
  ordering(catalogFor('claude'), 'claude, flattened');

  /**
   * The count is load-bearing rather than decorative: `legacy` is what Step 8's
   * separator sorts on, and all but one are rows a `list_models` does not
   * answer with while the CLI still runs them. Fable 5 and Opus 5 were each
   * watched falling out of the list as their successor arrived; the six Opus
   * and Sonnet 4.x rows were probed 2026-08-27 on 2.1.241 and found already
   * gone (`docs/reference/cli_state/models.md`). Haiku 4.5 is the one the CLI
   * still lists, put under Older by choice. Since 2.1.284 the list names every
   * row here again, after its picker's own, so Sonnet 5 is the first demoted
   * by hand rather than by watching it go.
   */
  it('stamps legacy on the ten rows kept under Older', () => {
    const legacy = CLAUDE_MODELS.filter((row) => row.legacy);
    assert.equal(legacy.length, 10);
    assert.deepEqual(
      legacy.map((row) => row.value),
      [
        // Demoted 2026-09-02 on 2.1.258, which lists Fable 5.1 in its place.
        // The first row here watched falling out rather than found already
        // out — and it still runs, which is the whole claim `legacy` makes.
        'claude-fable-5',
        // Demoted 2026-09-23 on 2.1.280, which lists Opus 5.5 in its place —
        // the same swap as Fable's, watched a second time.
        'claude-opus-5',
        // Demoted 2026-09-29 on 2.1.284 by hand: that release still lists it,
        // after the picker's own rows, and lists Sonnet 5.5 as `sonnet`.
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        // Still listed; Older by choice, 2026-09-27.
        'claude-haiku-4-5'
      ]
    );
    // Fewer rows than entries, because each row carries its windows. The flag
    // is per model, so the count that matters downstream is the flattened one —
    // eighteen entries, which is what the flyout's separator actually cuts.
    assert.equal(catalogFor('claude').filter((m) => m.legacy).length, 18);
  });

  /**
   * The pair the two-row decision is for. They share a canonical id and a
   * window; what differs is what a caller *requests*, which is why collapsing
   * them would leave workflow v2 with no way to ask for 1M.
   */
  it('flattens Opus 5 into two entries, told apart by window alone', () => {
    const both = catalogFor('claude').filter((m) => m.value === 'claude-opus-5');
    assert.equal(both.length, 2);
    // One `--model` spelling, two windows. Before the flatten these were two
    // rows with two different values, one of them carrying `[1m]` — a CLI
    // spelling sitting in a field meant to be raw.
    assert.deepEqual(
      both.map((m) => m.window),
      [1_000_000, 200_000]
    );
    for (const m of both) assert.equal(m.id, 'claude-opus-5');

    // Probed: a `[1m]` launch's `message.model` is the *unsuffixed* spelling,
    // so the shared reading has to belong to exactly one entry. It goes to the
    // 200k one, and the 1M entry takes the suffixed spelling alone — which is
    // what `init.model` reports and what keeps the tick on the right window.
    const [wide, narrow] = both;
    assert.deepEqual(wide?.readings, ['claude-opus-5[1m]']);
    assert.deepEqual(narrow?.readings, ['claude-opus-5']);
  });

  /**
   * The pair the derivation cannot split, asserted so it is a decision on the
   * record rather than a surprise. Sonnet 5 reaches 1M plain and 200k by flag,
   * so neither window carries a spelling of its own and both entries answer to
   * `claude-sonnet-5`. `resolveModel` breaks the tie on the window, or on
   * order — never on the reading, which cannot know.
   */
  it('leaves Sonnet 5 and both Fables with two entries sharing one reading', () => {
    for (const value of ['claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1']) {
      const both = catalogFor('claude').filter((m) => m.value === value);
      assert.equal(both.length, 2, `${value} did not flatten to two`);
      assert.deepEqual(both[0]?.readings, [value]);
      assert.deepEqual(both[1]?.readings, [value]);
      assert.notEqual(both[0]?.window, both[1]?.window);
    }
  });

  /** The dated spellings are the reason `readings` exists at all: this is the
   *  only spelling a discovered Haiku session ever states. */
  it('carries the dated spellings a live reading arrives in', () => {
    const haiku = CLAUDE_MODELS.find((row) => row.value === 'claude-haiku-4-5');
    assert.ok(haiku?.readings.includes('claude-haiku-4-5-20251001'));
    const sonnet = CLAUDE_MODELS.find((row) => row.value === 'claude-sonnet-4-5');
    assert.ok(sonnet?.readings.includes('claude-sonnet-4-5-20250929'));
    const opus = CLAUDE_MODELS.find((row) => row.value === 'claude-opus-4-5');
    assert.ok(opus?.readings.includes('claude-opus-4-5-20251101'));
  });

  it('joins Haiku 5.5 readings to its observed windows', () => {
    const models = catalogFor('claude');
    for (const reading of ['claude-haiku-5-5', 'claude-haiku-5-5[1m]']) {
      const wide = resolveModel(models, reading, undefined);
      assert.equal(wide?.value, 'claude-haiku-5-5');
      assert.equal(wide?.window, 1_000_000);
      assert.equal(wide?.legacy, undefined);
      assert.equal(resolveModel(models, reading, undefined, 200_000)?.window, 200_000);
    }
    assert.equal(windowOf('claude', 'claude-haiku-5-5', 1_000_000)?.reach, 'plain');
    assert.equal(windowOf('claude', 'claude-haiku-5-5', 200_000)?.reach, 'flag');
  });

  it('answers each brand with its own entries, stamped with that brand', () => {
    // No longer `=== CLAUDE_MODELS`: `catalogFor` hands back the flattened
    // list, and one authored row becomes one entry per window it states.
    assert.equal(
      catalogFor('claude').length,
      CLAUDE_MODELS.reduce((n, row) => n + row.windows.length, 0)
    );
    assert.equal(
      catalogFor('grok').length,
      GROK_MODELS.reduce((n, row) => n + row.windows.length, 0)
    );
    assert.equal(
      catalogFor('codex').length,
      CODEX_MODELS.reduce((n, row) => n + row.windows.length, 0)
    );
    for (const row of catalogFor('claude')) {
      assert.equal(row.brand, 'claude');
    }
    for (const row of catalogFor('grok')) {
      assert.equal(row.brand, 'grok');
    }
    for (const row of catalogFor('codex')) {
      assert.equal(row.brand, 'codex');
    }
  });

  /** Grok's ids, flag spellings and readings coincide, 1.0.4 through 1.0.40 —
   *  so its rows are the case where one string does the work of three, and the
   *  invariants above still have to hold over them. */
  it('gives Grok rows their own value as their only reading', () => {
    for (const row of GROK_MODELS) {
      assert.deepEqual(row.readings, [row.value]);
      assert.equal(row.id, row.value);
    }
  });

  /**
   * The flatten must carry `unlisted` through, or the filter in `offeredModels`
   * has nothing to read and the row is offered after all. Asserted over the
   * flattened entries rather than the authored row, because that is the side
   * the filter runs on.
   */
  it('flattens an unlisted row without offering to hide it', () => {
    const fast = catalogFor('grok').filter((m) => m.value === 'grok-4.7-build-fast');
    assert.equal(fast.length, 1);
    assert.equal(fast[0]?.unlisted, true);
    // Every other row states nothing rather than `unlisted: false` — the
    // present-and-undefined key `flatten` spreads around, for the reason its
    // own comment gives.
    for (const m of catalogFor('grok')) {
      if (m.value !== 'grok-4.7-build-fast') assert.ok(!('unlisted' in m), m.value);
    }
  });

  it('carries only verified effort metadata, strongest first', () => {
    const claude = Object.fromEntries(CLAUDE_MODELS.map((row) => [row.value, row]));
    const five = ['max', 'xhigh', 'high', 'medium', 'low'].map((value) => ({ value }));
    // Defaults are ours rather than a reading: this CLI states none anywhere,
    // and the alternative is a start whose effort is the binary's business.
    for (const [value, effort] of [
      ['claude-opus-5-5', 'medium'],
      ['claude-sonnet-5-5', 'high'],
      ['claude-haiku-5-5', 'high'],
      ['claude-fable-5-2', 'medium'],
      ['claude-fable-5-1', 'medium'],
      ['claude-opus-5', 'medium'],
      ['claude-sonnet-5', 'high']
    ] as const) {
      assert.deepEqual(claude[value]?.efforts, five);
      assert.equal(claude[value]?.defaultEffort, effort, value);
    }
    assert.ok(!('efforts' in (claude['claude-haiku-4-5'] ?? {})));

    // Keyed by value rather than by position: the CLI has put a new model at
    // the top of its list once already (`grok-4.7`, 1.0.40), and an index here
    // would have moved 4.5's narrowing onto whatever arrived next.
    const grok = Object.fromEntries(GROK_MODELS.map((row) => [row.value, row]));
    const four = ['xhigh', 'high', 'medium', 'low'].map((value) => ({ value }));
    for (const value of ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']) {
      assert.deepEqual(grok[value]?.efforts, four);
    }
    // 4.5 alone has no `xhigh`, and the CLI states that narrowing itself —
    // `reasoningEfforts` per model on the handshake, re-read on 1.0.40. Spelled
    // out rather than sliced off `four`: a value added above `xhigh` one day
    // would otherwise rewrite what 4.5 is asserted to be, silently.
    assert.deepEqual(grok['grok-4.5']?.efforts, [
      { value: 'high' },
      { value: 'medium' },
      { value: 'low' }
    ]);
    for (const row of GROK_MODELS) assert.equal(row.defaultEffort, 'high');

    for (const row of CODEX_MODELS) {
      assert.ok(!('efforts' in row), `${row.value} carries static efforts`);
      assert.ok(!('defaultEffort' in row), `${row.value} carries a static default effort`);
    }
  });

  it('spreads stated effort metadata onto every window without minting absent keys', () => {
    for (const value of ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']) {
      const row = CLAUDE_MODELS.find((candidate) => candidate.value === value);
      assert.ok(row?.efforts);
      for (const model of catalogFor('claude').filter((candidate) => candidate.value === value)) {
        assert.equal(model.efforts, row.efforts);
      }
    }
    for (const model of [
      ...catalogFor('claude').filter((row) => row.value === 'claude-haiku-4-5'),
      ...catalogFor('codex')
    ]) {
      assert.ok(!('efforts' in model), `${model.value} carries efforts: undefined`);
      assert.ok(!('defaultEffort' in model), `${model.value} carries defaultEffort: undefined`);
    }
  });
});

/**
 * The join, over the real rows.
 *
 * **The tick is the assertion that catches a wrong key, not the sub-line.** A
 * row can display correctly and still match nothing, so these drive
 * `resolveModel` over `CLAUDE_MODELS` rather than over a literal written to
 * suit it.
 */
describe('a live reading against the catalog', () => {
  it('ticks exactly one row for the dated spelling a Haiku session states', () => {
    // Started on the clean flag, reports the dated snapshot back: the case the
    // old id-and-value join could not answer at all.
    const hit = resolveModel(catalogFor('claude'), 'claude-haiku-4-5-20251001', 'claude-haiku-4-5');
    assert.equal(hit?.value, 'claude-haiku-4-5');
    const claiming = catalogFor('claude').filter((m) =>
      m.readings?.includes('claude-haiku-4-5-20251001')
    );
    assert.equal(claiming.length, 1);
  });

  it('resolves the two Opus 5 entries apart, on the window', () => {
    const wide = resolveModel(catalogFor('claude'), 'claude-opus-5[1m]', undefined);
    const plain = resolveModel(catalogFor('claude'), 'claude-opus-5', undefined);
    // Same `value` now — the reading is what tells them apart, and it can here
    // because Opus 5 reaches 1M by suffix.
    assert.equal(wide?.value, 'claude-opus-5');
    assert.equal(plain?.value, 'claude-opus-5');
    assert.equal(wide?.window, 1_000_000);
    assert.equal(plain?.window, 200_000);
    assert.notEqual(wide, plain);
  });

  /** The same shape one tier down, and the reason both Opus 4.8 rows are kept:
   *  what differs is the request, which `modelPick` is the only witness to. */
  it('lets a reading beat the pick, even a pick naming the 1M row', () => {
    const picked = resolveModel(catalogFor('claude'), 'claude-opus-4-8', 'claude-opus-4-8[1m]');
    // The reading names the plain row outright, and a reading that names a row
    // wins over the pick — the cost the task file states, asserted rather than
    // assumed.
    assert.equal(picked?.value, 'claude-opus-4-8');
  });

  it('still answers nothing for a spelling no row carries', () => {
    assert.equal(resolveModel(catalogFor('claude'), 'claude-tiny-1', undefined), undefined);
  });
});

/**
 * What `catalogFor` hands back, pinned.
 *
 * A caller handed `readonly Model[]` cannot tell a row authored flat from one
 * authored as a model with N windows — this is what holds that true. Not
 * frozen: a deliberate change edits this one literal, an accidental one is a
 * failure. What must never move silently is `id`, `brand` and `legacy`.
 *
 * The two Sonnet 5 lines and each Fable's pair are the ones to read twice —
 * same `value`, same `readings`, different `window`. `CatalogWindow.readings`
 * says why that cannot be otherwise.
 *
 * Fable 5 and Haiku 4.5 sit below Fable 5.1 because they are `legacy`, and
 * `ordering` above holds every legacy entry below every current one.
 */
type Snapshot = readonly [
  value: string,
  window: number,
  name: string,
  readings: readonly string[],
  legacy?: true
];

const CLAUDE_TODAY: readonly Snapshot[] = [
  // Both entries carry the suffixed spelling, because the row does and neither
  // window overrides it — `cli_state/models.md` § *Opus 5.5*.
  ['claude-opus-5-5', 1_000_000, 'Opus 5.5', ['claude-opus-5-5', 'claude-opus-5-5[1m]']],
  ['claude-opus-5-5', 200_000, 'Opus 5.5', ['claude-opus-5-5', 'claude-opus-5-5[1m]']],
  ['claude-sonnet-5-5', 1_000_000, 'Sonnet 5.5', ['claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']],
  ['claude-sonnet-5-5', 200_000, 'Sonnet 5.5', ['claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']],
  ['claude-haiku-5-5', 1_000_000, 'Haiku 5.5', ['claude-haiku-5-5', 'claude-haiku-5-5[1m]']],
  ['claude-haiku-5-5', 200_000, 'Haiku 5.5', ['claude-haiku-5-5', 'claude-haiku-5-5[1m]']],
  // Opus 5.5's shape, not Fable 5.1's: `[1m]` survives into the usage key, so
  // it is a reading — `cli_state/models.md` § *Fable 5.2*.
  ['claude-fable-5-2', 1_000_000, 'Fable 5.2', ['claude-fable-5-2', 'claude-fable-5-2[1m]']],
  ['claude-fable-5-2', 200_000, 'Fable 5.2', ['claude-fable-5-2', 'claude-fable-5-2[1m]']],
  ['claude-fable-5-1', 1_000_000, 'Fable 5.1', ['claude-fable-5-1']],
  ['claude-fable-5-1', 200_000, 'Fable 5.1', ['claude-fable-5-1']],
  ['claude-fable-5', 1_000_000, 'Fable 5', ['claude-fable-5'], true],
  ['claude-fable-5', 200_000, 'Fable 5', ['claude-fable-5'], true],
  ['claude-opus-5', 1_000_000, 'Opus 5', ['claude-opus-5[1m]'], true],
  ['claude-opus-5', 200_000, 'Opus 5', ['claude-opus-5'], true],
  ['claude-sonnet-5', 1_000_000, 'Sonnet 5', ['claude-sonnet-5'], true],
  ['claude-sonnet-5', 200_000, 'Sonnet 5', ['claude-sonnet-5'], true],
  ['claude-opus-4-8', 1_000_000, 'Opus 4.8', ['claude-opus-4-8[1m]'], true],
  ['claude-opus-4-8', 200_000, 'Opus 4.8', ['claude-opus-4-8'], true],
  ['claude-opus-4-7', 1_000_000, 'Opus 4.7', ['claude-opus-4-7[1m]'], true],
  ['claude-opus-4-7', 200_000, 'Opus 4.7', ['claude-opus-4-7'], true],
  ['claude-opus-4-6', 1_000_000, 'Opus 4.6', ['claude-opus-4-6[1m]'], true],
  ['claude-opus-4-6', 200_000, 'Opus 4.6', ['claude-opus-4-6'], true],
  ['claude-sonnet-4-6', 1_000_000, 'Sonnet 4.6', ['claude-sonnet-4-6[1m]'], true],
  ['claude-sonnet-4-6', 200_000, 'Sonnet 4.6', ['claude-sonnet-4-6'], true],
  ['claude-opus-4-5', 200_000, 'Opus 4.5', ['claude-opus-4-5', 'claude-opus-4-5-20251101'], true],
  ['claude-sonnet-4-5', 1_000_000, 'Sonnet 4.5', ['claude-sonnet-4-5[1m]'], true],
  [
    'claude-sonnet-4-5',
    200_000,
    'Sonnet 4.5',
    ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
    true
  ],
  [
    'claude-haiku-4-5',
    200_000,
    'Haiku 4.5',
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    true
  ]
];

const GROK_TODAY: readonly Snapshot[] = [
  ['grok-4.7', 500_000, 'Grok 4.7', ['grok-4.7']],
  ['grok-4.7-build-fast', 500_000, 'Grok 4.7 Fast', ['grok-4.7-build-fast']],
  ['grok-4.6', 500_000, 'Grok 4.6', ['grok-4.6'], true],
  ['grok-4.5', 500_000, 'Grok 4.5', ['grok-4.5'], true]
];

const CODEX_TODAY: readonly Snapshot[] = [
  ['gpt-6.1-sol', 475_000, 'Sol 6.1', ['gpt-6.1-sol']],
  ['gpt-6.1-terra', 475_000, 'Terra 6.1', ['gpt-6.1-terra']],
  ['gpt-6-astra', 258_400, 'Astra 6', ['gpt-6-astra']],
  ['gpt-6-luna', 258_400, 'Luna 6', ['gpt-6-luna']],
  // Older since 2026-09-30, behind Sol 6.1 — still lists and runs.
  ['gpt-6-sol', 258_400, 'Sol 6', ['gpt-6-sol'], true],
  // Older since 2026-09-23, by the reader's cutoff rather than the CLI's — all
  // three still list and run.
  ['gpt-5.6-sol', 258_400, 'Sol 5.6', ['gpt-5.6-sol'], true],
  ['gpt-5.6-terra', 258_400, 'Terra 5.6', ['gpt-5.6-terra'], true],
  ['gpt-5.6-luna', 258_400, 'Luna 5.6', ['gpt-5.6-luna'], true],
  ['gpt-5.5', 258_400, 'GPT-5.5', ['gpt-5.5'], true],
  // Legacy since 2026-09-02, on the CLI's own `upgrade` field — `catalog.ts`.
  ['gpt-5.4', 258_400, 'GPT-5.4', ['gpt-5.4'], true],
  ['gpt-5.4-mini', 258_400, 'Mini 5.4', ['gpt-5.4-mini'], true],
  ['gpt-5.3-codex-spark', 121_600, 'Spark 5.3', ['gpt-5.3-codex-spark'], true]
];

describe('what the catalog offers, pinned', () => {
  const check = (brand: BrandId, want: readonly Snapshot[]): void => {
    it(`${brand}: the offered list is what it was`, () => {
      assert.deepEqual(
        catalogFor(brand).map((m) => [
          m.value,
          m.window,
          m.name,
          m.readings ?? [],
          ...(m.legacy ? [true] : [])
        ]),
        want.map((row) => [...row])
      );
    });
  };

  check('claude', CLAUDE_TODAY);
  check('grok', GROK_TODAY);
  check('codex', CODEX_TODAY);

  /** The flatten must not mint a fresh array per call: `catalogFor` runs on
   *  every poll in every window, and `offeredModels` spreads each row after. */
  it('hands back the same array every call', () => {
    assert.equal(catalogFor('claude'), catalogFor('claude'));
    assert.equal(catalogFor('grok'), catalogFor('grok'));
    assert.equal(catalogFor('codex'), catalogFor('codex'));
  });
});

/**
 * The way back from a flattened entry to the window it came from.
 *
 * `core/claude/adapter.ts` calls this on the launch path to decide whether the
 * line needs `[1m]`, `--settings`, or neither — so a pair that does not round
 * trip is a session started in a window nobody asked for.
 */
describe('windowOf', () => {
  it('round-trips every pair the flatten produced', () => {
    for (const brand of ['claude', 'grok'] as const) {
      for (const m of catalogFor(brand)) {
        const w = windowOf(brand, m.value, m.window);
        assert.ok(w, `${m.value} at ${m.window} does not round trip`);
        assert.equal(w.tokens, m.window);
      }
    }
  });

  it('answers nothing for a pair no row states', () => {
    // A typed id — "Enter an id…" is still the way to an uncatalogued model,
    // and it has no window by construction.
    assert.equal(windowOf('claude', 'claude-tiny-1', 200_000), undefined);
    // A real model at a window it does not have: Haiku has no 1M.
    assert.equal(windowOf('claude', 'claude-haiku-4-5', 1_000_000), undefined);
    // And the brand seam holds: a Grok id is not in Claude's rows.
    assert.equal(windowOf('claude', 'grok-4.6', 500_000), undefined);
  });

  /**
   * The ordinary case, not an error: a stored setting from before this shipped,
   * or a session started with no window at all. Callers read it as "plain".
   *
   * **Kept deliberately after a review called it vacuous.** It is true today
   * for free — `.find` on a `number` field never matches `undefined` — and that
   * is the reason to pin it rather than not to. Every no-window path in the
   * product hangs off this answer: `launch()` says nothing extra, `set_model`
   * sends the id plain, `host/sessions.ts` drops the pair. A later refactor
   * that defaulted a missing window to the row's first would satisfy every
   * other test in this file and silently pin every session that never asked.
   */
  it('answers nothing when no window was asked for', () => {
    assert.equal(windowOf('claude', 'claude-opus-5', undefined), undefined);
    assert.equal(windowOf('claude', undefined, 200_000), undefined);
  });

  it('tells the two windows of one row apart', () => {
    assert.equal(windowOf('claude', 'claude-opus-5', 1_000_000)?.reach, 'suffix');
    assert.equal(windowOf('claude', 'claude-opus-5', 200_000)?.reach, 'flag');
    // Sonnet 5 is the other shape: 1M is what a bare `--model` gives, and the
    // narrow window is the one that needs saying.
    assert.equal(windowOf('claude', 'claude-sonnet-5', 1_000_000)?.reach, 'plain');
    assert.equal(windowOf('claude', 'claude-sonnet-5', 200_000)?.reach, 'flag');
    // Opus 4.6 is 200k natively and reaches 1M by suffix — the third class.
    assert.equal(windowOf('claude', 'claude-opus-4-6', 200_000)?.reach, 'plain');
    assert.equal(windowOf('claude', 'claude-opus-4-6', 1_000_000)?.reach, 'suffix');
  });

  it('carries the billing gate on the window that has it', () => {
    assert.equal(windowOf('claude', 'claude-sonnet-4-6', 1_000_000)?.gated, true);
    assert.equal(windowOf('claude', 'claude-sonnet-4-6', 200_000)?.gated, undefined);
  });

  /**
   * And it survives the flatten, which is what the menu reads.
   *
   * `gated` reaches the panel as a field on `ModelView`, so a flatten that
   * dropped it would leave the pill drawn like any other and the reader meeting
   * the refusal only as a 400 in a thread. Absent, not present-and-undefined:
   * `promote`'s `{...twin, ...record}` erased every Grok card's "of 500k" on
   * exactly that distinction once.
   */
  it('hands the gate on through catalogFor', () => {
    const flat = catalogFor('claude');
    const gated = flat.filter((m) => m.gated);
    assert.deepEqual(
      gated.map((m) => [m.value, m.window]),
      [['claude-sonnet-4-6', 1_000_000]]
    );
    for (const m of flat) {
      if (!m.gated) assert.ok(!('gated' in m), `${m.value} carries gated: undefined`);
    }
  });
});

/**
 * The window as a join key — what `value` alone can no longer answer.
 *
 * Sonnet 5 is the case that forced this: both its entries answer to
 * `claude-sonnet-5`, because the flag does not change the id the CLI reports.
 */
describe('resolving an entry when the reading cannot tell them apart', () => {
  const claude = catalogFor('claude');

  it('takes the window when one is given', () => {
    assert.equal(resolveModel(claude, 'claude-sonnet-5', undefined, 200_000)?.window, 200_000);
    assert.equal(resolveModel(claude, 'claude-sonnet-5', undefined, 1_000_000)?.window, 1_000_000);
  });

  /** Not `undefined`: the card is still entitled to the row's name and id. The
   *  catalog writes windows widest first, so this is the figure the flat
   *  catalog gave for Sonnet 5 before the restructure. */
  it('falls to the first entry when nothing tells them apart', () => {
    const hit = resolveModel(claude, 'claude-sonnet-5', undefined);
    assert.equal(hit?.value, 'claude-sonnet-5');
    assert.equal(hit?.window, 1_000_000);
    assert.equal(hit?.name, 'Sonnet 5');
  });

  it('lets the pick and the window agree on one entry', () => {
    const hit = resolveModel(claude, 'claude-sonnet-5', 'claude-sonnet-5', 200_000);
    assert.equal(hit?.window, 200_000);
  });

  /** A reading that names one entry outright still wins: Opus 5 reaches 1M by
   *  suffix, so `init.model` says which window it is in and no window is
   *  needed to know. */
  it('still lets a suffixed reading name its own entry with no window given', () => {
    assert.equal(resolveModel(claude, 'claude-opus-5[1m]', undefined)?.window, 1_000_000);
    assert.equal(resolveModel(claude, 'claude-opus-5', undefined)?.window, 200_000);
  });
});

/**
 * A name on the wire carries no window.
 *
 * The pair a menu draws is `name` plus a pill off `window`, so a name that
 * spelled its own size would put the figure on screen twice and let the two
 * disagree. Asserted over the shipped list rather than argued: the failure
 * this catches is a row authored `Opus 5 (1M)` by hand, which reads fine in a
 * diff and draws `Opus 5 (1M)  [200k][1M]` in the flyout.
 *
 * `ctxLabel` spells a window in the webview. `windowLabel` is that formula in
 * `core/`, because `webview/dom.ts` imports nothing and cannot be called from
 * there. The card's model name and a notice head both use `windowLabel`. The
 * two spellings are pinned equal on every shipped window.
 */
describe('the name a row goes by', () => {
  it('states no window, for any brand', () => {
    for (const brand of ['claude', 'grok'] as const) {
      for (const row of catalogFor(brand)) {
        assert.ok(!/[()]/.test(row.name), `${row.value} names its own window: ${row.name}`);
      }
    }
  });

  it('is the same for every window of one model', () => {
    const byValue = new Map<string, Set<string>>();
    for (const row of catalogFor('claude')) {
      (byValue.get(row.value) ?? byValue.set(row.value, new Set()).get(row.value)!).add(row.name);
    }
    // Opus 5 is the case worth naming: two entries, one name, told apart by the
    // pill and by nothing in the string.
    assert.deepEqual([...(byValue.get('claude-opus-5') ?? [])], ['Opus 5']);
    for (const [value, names] of byValue) {
      assert.equal(names.size, 1, `${value} draws ${names.size} different names`);
    }
  });

  it('is what a surface with one value composes from', () => {
    const opus = catalogFor('claude').find(
      (m) => m.value === 'claude-opus-5' && m.window === 200_000
    );
    assert.ok(opus?.window !== undefined);
    assert.equal(`${opus.name} (${ctxLabel(opus.window)})`, 'Opus 5 (200k)');
  });

  it('spells a window the same way the card does', () => {
    for (const brand of ['claude', 'grok', 'codex'] as const) {
      for (const row of catalogFor(brand)) {
        if (row.window === undefined) continue;
        assert.equal(windowLabel(row.window), ctxLabel(row.window), `${row.value} ${row.window}`);
      }
    }
  });
});

/**
 * Which of the two accounts this is, read off what a session is running.
 *
 * The pills point in opposite directions on the two, so this decides every one
 * of them. It is observed rather than asked: the CLI does name a plan, and
 * matching that string would be a plan table in our code — another program's
 * marketing copy, silent about the beta itself, and wrong the day a tier is
 * renamed. What a session ran at is a measurement.
 */
describe('defaultsWide', () => {
  const at = (model: string, running?: number, from: 'plain' | 'suffix' | 'flag' = 'plain') =>
    defaultsWide('claude', model, running, from);

  it('reads a session sitting in its row’s widest window as granted it', () => {
    assert.equal(at('claude-opus-5', 1_000_000), true);
    assert.equal(at('claude-sonnet-5', 1_000_000), true);
    // The suffix is how it got there, and it still witnesses the grant: the
    // account could have refused `[1m]` and did not.
    assert.equal(at('claude-opus-5', 1_000_000, 'suffix'), true);
  });

  /** Landing in a window the catalog says needs the flag, on a line that
   *  carries none, is the account defaulting there — the narrow plan. */
  it('reads a flag-reached window on an unflagged line as the narrow plan', () => {
    assert.equal(at('claude-opus-5', 200_000), false);
    assert.equal(at('claude-sonnet-5', 200_000), false);
  });

  it('says nothing when the line pinned the window itself', () => {
    // The flag put it there, so the run witnesses the flag and not the account.
    assert.equal(at('claude-opus-5', 200_000, 'flag'), undefined);
  });

  /**
   * And nothing for a narrow window the row reaches `plain`. Opus 4.6 runs at
   * 200k on a bare id whatever the account is, so sitting there says nothing
   * about the beta — the case a cruder rule would read as the narrow plan and
   * then dim the million on an account that has it.
   */
  it('says nothing when the narrow window needed no flag anyway', () => {
    assert.equal(at('claude-opus-4-6', 200_000), undefined);
    assert.equal(at('claude-sonnet-4-5', 200_000), undefined);
  });

  it('says nothing for a row with one window, or a model it does not know', () => {
    assert.equal(at('claude-haiku-4-5', 200_000), undefined);
    assert.equal(at('grok-4.6', 500_000), undefined);
    assert.equal(at('claude-tiny-1', 200_000), undefined);
    assert.equal(defaultsWide('claude', undefined, 200_000, 'plain'), undefined);
  });

  it('says nothing before a width has been stated', () => {
    assert.equal(at('claude-opus-5', undefined), undefined);
  });

  /** A width that matches neither end of the row settles nothing either. */
  it('says nothing for a width the row does not state', () => {
    assert.equal(at('claude-opus-5', 500_000), undefined);
  });
});

/**
 * Which windows a *running* session can still be moved onto.
 *
 * Not a question about the model — the catalog already answers that — but about
 * the line the session was launched on. `--settings` is composed once, at spawn,
 * so whether `CLAUDE_CODE_DISABLE_1M_CONTEXT` is on that line is fixed for the
 * session's life. Every case below is the flag being present or absent.
 *
 * The figures are measured, not reasoned: probed 2026-08-29 on CLI 2.1.241
 * through the exact `--settings` path `core/claude/adapter.ts` composes, reading
 * `result.modelUsage[].contextWindow` (`TASK_done_window_fixed.md` §
 * *Observed data*). The two readings that shape the rule are that a flagged line
 * holds `claude-opus-5[1m]` to 200k, and holds `claude-sonnet-5` — whose 1M
 * needs no suffix at all — to 200k too.
 */
describe('reachableFrom', () => {
  const from = (reach: 'plain' | 'suffix' | 'flag' | undefined, wide?: boolean) =>
    function (value: string, tokens: number): boolean {
      return reachableFrom('claude', value, tokens, reach, wide);
    };

  describe('no flag on the line, on an account granted the wide window', () => {
    for (const reach of ['plain', 'suffix'] as const) {
      const can = from(reach, true);
      it(`${reach}: refuses every window only the flag reaches`, () => {
        assert.equal(can('claude-opus-5', 200_000), false);
        assert.equal(can('claude-sonnet-5', 200_000), false);
        assert.equal(can('claude-fable-5', 200_000), false);
      });

      it(`${reach}: allows a suffix window and a plain one alike`, () => {
        assert.equal(can('claude-opus-5', 1_000_000), true);
        assert.equal(can('claude-sonnet-5', 1_000_000), true);
        assert.equal(can('claude-opus-4-6', 200_000), true);
      });
    }

    /**
     * The case a naive "anything but this session's own window" rule blocks.
     * Haiku 4.5 has one window and it is 200k reached plain, so a session
     * sitting at 1M can go there — and blocking it would take the cheap model
     * out of the menu entirely, which is the failure `setModel`'s own rule was
     * rewritten for.
     */
    it('allows Haiku’s only window from a 1M line', () => {
      assert.equal(from('suffix', true)('claude-haiku-4-5', 200_000), true);
    });
  });

  /**
   * The other account, and the pills point the other way on it. Without the 1M
   * beta a bare `claude-opus-5` runs at 200k — so that window is reachable, and
   * the million is what this session can never get to. Blocking it is the same
   * promise as blocking 200k on the wide account: a press never moves a reader
   * to a width they did not pick.
   */
  describe('no flag on the line, on an account that defaults narrow', () => {
    const can = from('plain', false);

    it('allows the narrow window the flag would otherwise be needed for', () => {
      assert.equal(can('claude-opus-5', 200_000), true);
      assert.equal(can('claude-sonnet-5', 200_000), true);
    });

    it('refuses the wide window, suffix and plain alike', () => {
      // The suffix would 400, and the plain wide window is simply never given.
      assert.equal(can('claude-opus-5', 1_000_000), false);
      assert.equal(can('claude-sonnet-5', 1_000_000), false);
    });

    it('leaves a one-window row alone', () => {
      assert.equal(can('claude-haiku-4-5', 200_000), true);
    });
  });

  describe('the flag is on the line, and it pins the narrow end', () => {
    // The flag outranks the account either way, so the evidence is not consulted.
    const can = from('flag', true);

    it('refuses a wide window however the id spells it', () => {
      // Suffix and plain both, because the flag outranks each — measured.
      assert.equal(can('claude-opus-5', 1_000_000), false);
      assert.equal(can('claude-sonnet-5', 1_000_000), false);
      assert.equal(can('claude-opus-4-6', 1_000_000), false);
    });

    it('allows the narrow window, whichever reach the row states for it', () => {
      assert.equal(can('claude-opus-5', 200_000), true);
      assert.equal(can('claude-sonnet-5', 200_000), true);
    });

    /**
     * The case a pure `reach` comparison blocks. Opus 4.6 reaches 200k `plain`
     * — its narrow window needs no flag — and a flagged line lands there just
     * the same. "Only `flag` windows are reachable from a flagged line" would
     * have dimmed a pill that works.
     */
    it('allows a plain narrow window on a flagged line', () => {
      assert.equal(can('claude-opus-4-6', 200_000), true);
      assert.equal(can('claude-sonnet-4-5', 200_000), true);
    });

    it('allows a one-window row, which is narrowest by having no rival', () => {
      assert.equal(can('claude-haiku-4-5', 200_000), true);
      assert.equal(can('claude-opus-4-5', 200_000), true);
    });

    /** Unreachable beats gated: we know the switch cannot move the window,
     *  where the billing gate is a maybe that would never be reached. */
    it('refuses a gated wide window too, and says so as unreachable', () => {
      assert.equal(can('claude-sonnet-4-6', 1_000_000), false);
    });
  });

  describe('what we cannot speak for, we do not block', () => {
    it('allows everything when the launch line is unknown', () => {
      // A discovered session, one launched before the window rode the line, and
      // a window publishing an older record. Every pill stays pickable.
      const can = from(undefined, true);
      assert.equal(can('claude-opus-5', 200_000), true);
      assert.equal(can('claude-opus-5', 1_000_000), true);
      assert.equal(can('claude-sonnet-5', 200_000), true);
    });

    it('allows a pair no row states — a typed id has no window to contradict', () => {
      assert.equal(reachableFrom('claude', 'claude-tiny-1', 200_000, 'flag'), true);
      assert.equal(reachableFrom('claude', 'claude-haiku-4-5', 1_000_000, 'flag'), true);
      assert.equal(reachableFrom('claude', undefined, 200_000, 'flag'), true);
      assert.equal(reachableFrom('claude', 'claude-opus-5', undefined, 'flag'), true);
    });

    /**
     * And **allows everything when the account has not shown its hand**, which
     * is the case that keeps a narrow-plan reader out of trouble. The catalog
     * says Opus 5 reaches 200k by the flag; that is true on a subscription
     * carrying the 1M beta and false on one without, and until a turn states a
     * width we cannot tell which we are on. Dimming on the catalog alone would
     * take a working pill off half the accounts there are.
     */
    it('allows everything until a width has been observed', () => {
      const can = from('plain', undefined);
      assert.equal(can('claude-opus-5', 200_000), true);
      assert.equal(can('claude-opus-5', 1_000_000), true);
    });
  });

  /** Grok's single window is `plain`, so it comes out always-reachable with no
   *  brand check anywhere. The rule is written in the catalog's vocabulary and
   *  a second brand needs no case in it. */
  it('leaves a brand whose one window is plain alone', () => {
    for (const reach of ['plain', 'suffix', 'flag', undefined] as const) {
      for (const wide of [true, false, undefined]) {
        assert.equal(reachableFrom('grok', 'grok-4.6', 500_000, reach, wide), true, `${reach}`);
      }
    }
  });
});

import { contextPercent } from '../../core/catalog';
describe('contextPercent', () => {
  it('rounds the way the CLI rounds, so a derived card matches a dumped one', () => {
    // The pair read off one live session at one instant: the dump said 16%.
    assert.equal(contextPercent(156004, 1_000_000), 16);
    // And the pair the transcript comment records: 109989 of a million is 11%.
    assert.equal(contextPercent(109989, 1_000_000), 11);
  });

  it('holds inside 0..100 for a session that has overrun its window', () => {
    // Compaction means a count above the window is a moment, not an error —
    // the bar has nowhere past full to go, and neither has the card.
    assert.equal(contextPercent(1_400_000, 1_000_000), 100);
    assert.equal(contextPercent(0, 1_000_000), 0);
  });
});
