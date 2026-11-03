/**
 * The keeper's figures: how long one `caffeinate` lease runs, when it refills,
 * when a working session stops counting, and the battery it stops at.
 *
 * **Here because both halves need them and neither may import the other's.** The
 * keeper decides by them (`core/awake.ts`, which re-exports them as its own) and
 * the Keep-awake drawer states them (`ui/awake_rows.ts`) — but `core/awake.ts`
 * reads the filesystem, so the bundle cannot take it, and `src/AGENTS.md` keeps
 * `core/markers.ts` as the only `core/` file the bundle imports. A leaf in `ui/`
 * with no imports of its own is what both sides can reach, the way `ui/flyout.ts`
 * and `ui/chat_state.ts` already are.
 *
 * `LEASE_MS` was briefly a field on the wire instead. That is one constant
 * marshalled to itself: the host's half and the webview's half ship in one VSIX
 * built from one tree, so there is no version they could disagree across. What a
 * *foreign* window's hold record was written against is a different question,
 * and the answer to that one is the clamp in `cupFill`, not this.
 */

/**
 * One coffee in ms, the `-t` handed to `caffeinate`. It is how long one hold
 * lasts, and the ceiling on how long the machine stays awake after this
 * extension stops. Raising it weakens the second without improving the first,
 * since a working session drinks again.
 */
export const LEASE_MS = 10 * 60_000;

/**
 * How early the refill timer fires. The new child must be up while the old one
 * still holds, or the assertion drops and the machine may take that moment to
 * sleep. A minute is that overlap: `drink` leaves the old `-t` running, so two
 * assertions stack until the previous child exits on its own.
 */
export const REFILL_MARGIN_MS = 60_000;

/**
 * How long a session may send nothing and still count as working.
 * `busy` is only a claim. The CLI sends nothing between `tool_use` and the
 * result, and a test suite runs past 10 min. A bound is still needed so a
 * hung session cannot hold forever.
 */
export const SILENCE_MS = 60 * 60_000;

/**
 * Below this, on battery, nothing is worth keeping the machine awake for,
 * because a laptop flattened overnight in a bag is worse than the sleep
 * prevented. Charge alone does not fire it: see `decide` in `core/awake.ts`.
 */
export const BATTERY_FLOOR_PCT = 20;
