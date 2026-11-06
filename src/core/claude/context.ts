/**
 * The window a session's context is a share of, so a card can state a
 * percentage off the transcript, which never states the window itself.
 *
 * The CLI's own arithmetic, read out of the binary (2.1.220): the bar shows
 * `round(total_input_tokens / context_window_size * 100)`, clamped to 0..100.
 * The numerator is the newest answer's usage — which `transcript.readStats`
 * already sums, verified equal to the dump's own figure. The denominator is the
 * only part the transcript never states.
 *
 * The statusline dump states it, but is no source to wait on: the CLI draws its
 * status bar only in a terminal of 15 rows or more (measured 2026-07-26: 44
 * busy minutes wrote no dump, and one landed a second after the pty grew to 40
 * rows). Squadron reads no dumps.
 *
 * Keyed by model id rather than by session because the size is *mostly* the
 * model's: the 1M variant is a distinct id (`claude-opus-4-8[1m]`, as the dumps
 * spell it), so the case that made two sessions differ is already two keys.
 *
 * Not always: 2.1.237's window function reads three things before the model —
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT`, the 1M beta header on the request, and
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` under `DISABLE_COMPACT`. All three are the
 * session's environment, so two sessions on one id can sit in different
 * windows. Why the store still holds one size per id: `observed` below.
 *
 * **The 1M beta header is retired, 2026-04-30**: the SDK reference's `SdkBeta`
 * no longer lists it, and the entitlement is checked against the account
 * instead. The reading above was true of 2.1.237. Two of the three still apply.
 *
 * A session that *pinned* its window does not feed this store, and one that
 * asked for nothing does. `claude/reduce.ts` holds that condition and why.
 */

import { catalogFor, windowOf } from '../catalog';
import { readJson, writeAtomicJson } from '../files';
import { modelsFile } from '../paths';

/**
 * What each id's window is, seeded with sizes as observed rather than as
 * reasoned about: every dump on the machine that wrote this — 322 of them,
 * 2026-07-26, CLI 2.1.220 — agreed on one size per id, and these are the ids
 * that appeared. `learnWindow` overwrites an entry when a session here states
 * otherwise, so the seed only has to hold until one does.
 *
 * Not the CLI's whole rule. It defaults an unfamiliar model to
 * 200k, and copying that default would print `55%` for a session sitting at
 * `11%` of a million — the same wrong answer `transcript.ts` declines to guess.
 * An id that is not here, has not been seen, and does not carry the `[1m]`
 * suffix `windowFor` reads leaves the card on its token count.
 */
const SEED: ReadonlyArray<readonly [string, number]> = [
  ['claude-opus-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-opus-4-8[1m]', 1_000_000],
  ['claude-fable-5', 1_000_000]
];

const windows = new Map<string, number>(SEED);

/**
 * The ids this window watched a session report, as against the ids it read out
 * of the store. The map itself cannot carry that distinction.
 *
 * Two sessions on one id *can* disagree about their window (header). Rare, and
 * the store has no way to hold both.
 *
 * So it holds one, and an observation outranks it locally: a card is drawn off
 * what this window watched its own sessions report, and the file answers only
 * for the ids nobody here has met.
 */
const observed = new Set<string>();

/** Where the learnt sizes are kept. A test points it at a tmpdir so no suite
 *  writes the machine's own store, and nothing puts it back. */
let store = modelsFile('claude');
let loading: Promise<void> | undefined;

/**
 * Reads what every other window has learnt, over what this one holds.
 *
 * Awaited by `discover` above its session loop, not once per process: the loop
 * asks the synchronous `windowFor` per card, so the file must be in the map
 * before the pass. A size the next window met a minute ago is what this store
 * carries. One read of a few-hundred-byte file, on a pass that already reads
 * three directories. Concurrent calls share the read in flight. No call fails
 * a pass, because `readJson` degrades a missing or unparsable file to nothing.
 *
 * A stored size lands over the seed and over what this process holds. Last
 * observation wins, whichever window made it: two windows watching the same
 * CLI agree, and one that does not is reporting a session run with
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` or a version we have not met. It converges
 * and never oscillates, because the reader takes the writer's figure.
 */
export function loadWindows(home?: string): Promise<void> {
  if (home !== undefined) {
    store = modelsFile('claude', home);
  }
  loading ??= hydrate().finally(() => {
    loading = undefined;
  });
  return loading;
}

async function hydrate(): Promise<void> {
  const onDisk = narrow(await readJson<Record<string, unknown>>(store));
  // Nothing learnt here is news to the file, so nothing here writes. Without
  // this, the first window to poll writes the file back verbatim and nudges
  // every other window into a poll.
  hydrating = true;
  for (const [id, size] of Object.entries(onDisk)) {
    // Never over an id this window watched a session report. Without this, two
    // windows holding different sizes fight: ours takes theirs, our next result
    // states ours again, `learnWindow` sees a change and writes, and theirs does
    // the same. Forever, one write and one machine-wide poll per pass each.
    if (!observed.has(id)) {
      learnWindow(id, size);
    }
  }
  hydrating = false;
  // The repair, which makes the read-merge-write below safe. Two windows can
  // still overlap (A reads, B reads, A writes, B writes the merge it computed
  // before A's), and the id A learnt is gone, with no lock to stop it. The
  // window that still holds that id notices on the next pass and puts it back.
  //
  // Free, because this pass already read the file: the comparison is in
  // memory, and it writes only when the file is missing something. Not
  // covered: a window that learns an id, loses it to that overlap, and closes
  // before its next poll. Three seconds of exposure, against one relearn.
  //
  // **An id the file has and disagrees about is not missing.** Repairing it
  // would be the storm this guard avoids: both windows would rewrite every
  // pass, and every write nudges every window on the machine into a poll.
  // Whoever wrote last settles it, and each window draws its own sessions off
  // what it observed.
  if (Object.keys(record()).some((id) => !(id in onDisk))) {
    save();
  }
}

let hydrating = false;

/**
 * Only the entries that differ from `SEED`, so a corrected seed stays
 * correctable. Otherwise a machine that once wrote this file pins every id it
 * holds at the size observed then, and beats the newer figure in the code.
 */
function record(): Record<string, number> {
  const seeded = new Map(SEED);
  const out: Record<string, number> = {};
  for (const [id, size] of windows) {
    if (seeded.get(id) !== size) {
      out[id] = size;
    }
  }
  return out;
}

/**
 * Chained rather than raced, and each write reads the file first.
 *
 * Both because the record is the **whole map**, not one entry. Two ids learnt
 * in one tick would otherwise rename in whatever order the writes finished,
 * and the loser would be the newer file. A second window writing its own map
 * over ours would drop every id ours met and theirs did not. An old session's
 * model may never report again for us to learn it back.
 *
 * So a write is a merge, skipped when the merge changes nothing. A memo of
 * what *this* process last wrote (`writeStoredUsage`'s) cannot answer that.
 * `usage.ts`'s `sameWindows` guard takes the same reading against the file,
 * for the same reason: `panel.ts` watches every `.json` under the state root,
 * so a needless write nudges every window on the machine into a poll.
 */
let writes: Promise<unknown> = Promise.resolve();

/** What a test waits on: a fire-and-forget write has no other edge. */
export function windowsWritten(): Promise<unknown> {
  return writes;
}

function same(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function save(): void {
  if (hydrating) {
    return;
  }
  // Fire-and-forget: `learnWindow` is called from a poll and from a frame
  // reducer, neither of which has anywhere to put a promise, and a size that
  // fails to land is a card back on its token count next launch.
  writes = writes.then(async () => {
    const onDisk = narrow(await readJson<Record<string, unknown>>(store));
    // Ours last: this process observed its figures, and `hydrate` already read
    // the file's into the map. A figure of theirs that still differs is an id
    // we have met since.
    const merged = { ...onDisk, ...record() };
    if (same(merged, onDisk)) {
      return;
    }
    await writeAtomicJson(store, merged);
  });
}

/** The file as sizes, dropping whatever a hand-edited or half-written one put
 *  there — the same test `learnWindow` applies, since both are reading a file
 *  we do not own the writer of. */
function narrow(stored: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, size] of Object.entries(stored ?? {})) {
    if (id && typeof size === 'number' && size > 0) {
      out[id] = size;
    }
  }
  return out;
}

/**
 * Take the size a session stated for its model (an owned session's result
 * frame, `reduce.ts`) over whatever was seeded or read before. Ignores
 * anything but a positive number, because a changed CLI writing a string here
 * would poison every card on that model, not just its own.
 */
export function learnWindow(modelId: unknown, size: unknown): void {
  // `!(size > 0)` and not `size <= 0`: NaN fails the first and passes the
  // second, and the CLI has been seen stating every field in some other shape.
  if (typeof modelId !== 'string' || !modelId || typeof size !== 'number' || !(size > 0)) {
    return;
  }
  // Marked before the unchanged-size exit, not after: a session restating what
  // we already hold is still this window having watched it, and it is what
  // keeps the store from overwriting that on some later pass.
  if (!hydrating) {
    observed.add(modelId);
  }
  if (windows.get(modelId) === size) {
    return;
  }
  windows.set(modelId, size);
  save();
}

/**
 * Forgets what sessions taught it. Tests only: the map is otherwise
 * process-lived.
 *
 * Back to the seed and not to empty, because the seed is not learned: it is
 * what a card reads before any session states a size, and a reset that
 * dropped it would leave every card on its token count.
 *
 * **Nothing here touches disk, and it does not move the store either.** A test
 * that swept the file would sweep the machine's own, because the default path
 * is the real one. A test that pointed the store at a tmpdir must keep it
 * there, or the reset hands the next `learnWindow` back to `~/.squadron`.
 * `tempHome` cannot help: `paths.ts` reads the home directory when it is first
 * imported, before any test runs.
 */
export function forgetWindows(): void {
  windows.clear();
  for (const [id, size] of SEED) {
    windows.set(id, size);
  }
  observed.clear();
  loading = undefined;
}

/**
 * The window for a model id: what some session stated if one has, the seed if
 * not, the suffix rule under that, and the catalog last.
 *
 * `[1m]` is not a guess. It is the first test the CLI's own window function
 * makes (`Nhd`, read out of 2.1.237), before the catalogue, the beta header
 * and the 200k default. So an id carrying it answers in a million whatever
 * else is known. That puts a percentage on a card for a variant nobody has
 * met, which is every 1M model the first time it ships.
 *
 * The CLI also gates the rule on `CLAUDE_CODE_DISABLE_1M_CONTEXT`, which is
 * the session's environment, not the extension host's, so not ours to read.
 * A machine that sets it gets a card one dump or one `result` frame behind,
 * since either states the real size and `learnWindow` takes it.
 */
export function windowFor(modelId: string | undefined): number | undefined {
  if (!modelId) {
    return undefined;
  }
  return windows.get(modelId) ?? (/\[1m\]/i.test(modelId) ? 1_000_000 : catalogWindow(modelId));
}

/**
 * The catalog's figure, and **only where the model runs in one window.**
 *
 * It covers a reading no other tier reaches. Three models report a dated
 * `message.model` that appears in no `modelUsage` key and no dump —
 * `claude-opus-4-5-20251101` and its Haiku and Sonnet siblings
 * (`cli_state/models.md` § *The three spellings*) — so the store learns the
 * window under `claude-opus-4-5` while every card reads `…-20251101`, and the
 * lookup misses a size the machine already knows. Observed 2026-08-29: an owned
 * Opus 4.5 session sat on `31k used` with `models.claude.json` holding
 * `"claude-opus-4-5": 200000`.
 *
 * **Last, under both tiers above.** An observation is this session's own truth
 * and a catalog row is a fact about the model, so anything measured outranks
 * this, including a `learnWindow` that contradicts it.
 *
 * **One window the reading names, reached plainly.** Both tests are
 * load-bearing.
 *
 * A reading that names entries of different sizes settles nothing:
 * `claude-sonnet-5` is the spelling for the 1M start and the 200k one alike, so
 * answering the wider would print `3%` for a session sitting at `15%`. The card
 * keeps its token count instead.
 *
 * `reach` is the subtler half. The entries a *plain* reading falls to are
 * often the 200k ones, but only some of those are what a plain launch gets:
 * `claude-opus-4-7` reaches 200k by `CLAUDE_CODE_DISABLE_1M_CONTEXT` and runs
 * at a million without it (`cli_state/models.md`), so reading 200k off that
 * entry would be wrong by five times on every ordinary session. A `plain`
 * reach says this is what the model does when nothing is asked of it, the
 * only claim an id alone supports. `suffix` and `flag` windows are reachable,
 * and reaching one puts the spelling, or the observed size, where the tiers
 * above can see it.
 *
 * Matched on `readings` alone, never `resolveModel`'s looser tiers: this is a
 * figure, and a `base()` match that is right about the *row* can still be wrong
 * about the window.
 */
function catalogWindow(modelId: string): number | undefined {
  const named = catalogFor('claude').filter((row) => row.readings?.includes(modelId));
  const hit = named[0];
  if (!hit || named.some((row) => row.window !== hit.window)) {
    return undefined;
  }
  return windowOf('claude', hit.value, hit.window)?.reach === 'plain' ? hit.window : undefined;
}
