# Live: every catalog row still runs

## Purpose

Every row in `src/core/catalog.ts` names a model the installed CLI will actually
start a session on. A row that has stopped running is found here and nowhere
else.

## Proves what `check` cannot

This scenario is the `verified` attribute we chose not to write down.

The catalog reaches models the CLI does not advertise — the measured gap is in
[`docs/reference/cli_state/models.md`](../../../docs/reference/cli_state/models.md)
§ *The gap: listed ⊂ runnable*. That reach is the whole point, and it is also
the risk: `list_models` no
longer gates anything, so nothing in the product will ever notice a row going
bad. `npm run models:claude` compares the two lists, but by construction it
cannot speak for the unlisted rows — they are absent from the CLI's answer when
they work *and* when they do not.

The failure is quiet, which is why it needs a person. An id the binary does not
recognise is not refused: per `docs/reference/cli_state/models.md` it prints a
notice and then silently compacts the session at 200k, so a stale row costs a
reader three quarters of a 1M context window without ever erroring.

**A pass proves a row runs. It does not harvest spellings.** If a CLI update
changes what `assistant.message.model` reports, every row here still starts and
the *tick* is what breaks — silently, in the flyout. That is a catalog edit, and
Step 2 of this scenario is what catches it.

## Cost

One turn per catalog row — sixteen today, twelve Claude and four Grok — plus one
stream-json read per brand. Real tokens on the cheapest possible prompt.
**Needs a signed-in account per brand.** Three to five minutes.

Read `src/core/catalog.ts` for the current row count before starting; this file
does not list the rows, on purpose. A checked-in list of models in a file about
checking the list of models is the second copy that eventually disagrees.

## Preconditions

- Both CLIs on `PATH` and signed in — check the accounts control in the panel.
  A signed-out brand fails every one of its rows for a reason that has nothing
  to do with the catalog.
- No deployed build needed. This drives the CLIs directly, not the panel.
- Note the CLI versions before you start: `claude --version`, `grok --version`.
  A reading with no version beside it cannot be re-checked, only re-measured.

## Prompt

```
You are checking that every model Squadron offers still runs. Work only in
/tmp/agentsview-probe (create it). Do not touch any repository, do not edit
files, do not run builds.

Step 1. Read src/core/catalog.ts in the Squadron repo and list every row's
`value`, `brand`, and each of its `windows` (`tokens`, `label`, `reach`). Do not
skip rows marked `legacy` — those are exactly the ones nothing else can check.

  **One row is one model now, carrying N windows**, and the pair (value, window)
  is what a start names. Probe per *pair*, not per row.

Step 2. For each Claude (row × window), run one turn. The command depends on
that window's `reach`, which is the whole of what this step checks:

  reach: plain    claude --print --output-format json --model '<value>' hi
  reach: suffix   claude --print --output-format json --model '<value>[1m]' hi
  reach: flag     claude --print --output-format json --model '<value>' \
                    --settings '{"env":{"CLAUDE_CODE_DISABLE_1M_CONTEXT":"1"}}' hi

  Quote the value: a `[1m]` suffix is a glob in most shells. Read
  `result.modelUsage` and record, per pair:
    - whether it ran at all
    - `canonicalModel`
    - `contextWindow`

  Compare `contextWindow` against that window's own `tokens`.

  **This does prove something now, which it did not before.** The catalog's
  window used to be a record nothing read; since 2026-08-28 it is composed onto
  the launch line and an owned card is sized by it. So a mismatch here is a
  gauge that is currently wrong, not just a stale note — and a `reach` that no
  longer reaches is a session started in a window nobody asked for.

  A `gated` window may answer *"usage credits required"* on an account without
  them. That is a pass, not a failure: record which account you ran as.

Step 3. For each Grok row, run one turn on that model and record whether it ran.
Include a row marked `unlisted` — the panel does not offer it, and it is still a
row this repo claims runs, which is the only thing this scenario checks.

Step 4. Take the readings the tick is joined on, once per brand rather than per
row — this is what a discovered session states, and no other step shows it:

  claude --print --output-format stream-json --verbose --model '<value>' hi

  Read the first `assistant` frame's `message.model`. Do this for at least the
  rows whose `readings` carry a dated spelling. If any reports something absent
  from that row's `readings`, say so loudly: the row will still start a session
  and its card will tick the wrong row, or none.

Step 5. Start one session from the panel on a `reach: flag` pair — Sonnet 5.5 at
200k is the clearest, since the flag is its only route there. Check three
things, none of which any earlier step covers:

  - the card reads `of 200k` **before** the first turn, and still does after;
  - `ps` shows a plain `--model` and a `--settings` carrying the var;
  - `~/.squadron/models.claude.json` is **unchanged** — a pinned session must
    not teach the machine's store, or every discovered card on that model is
    drawn against the wrong window.

Step 6. Report a table: value, window, reach, ran (yes/no), canonicalModel,
contextWindow, window matches the row (yes/no), and message.model where you took
it. Name the CLI versions you ran against. Do not edit the catalog — report
only.
```

## What to do with a failure

- **A row that no longer runs:** delete it from `src/core/catalog.ts`, and
  record the date and CLI version it stopped running in
  `docs/reference/cli_state/models.md`. Do not leave it marked `legacy` instead
  — `legacy` means "runs but is not advertised", and using it for "does not run"
  puts a dead model one press away in the flyout.
- **A window whose size moved:** correct that window's `tokens` and date the
  reading. This is no longer the quiet one: the figure sizes an owned card's
  context bar and rides the launch line, so a stale one is a percentage drawn
  against a window the session is not in.
- **A `reach` that no longer reaches** — a `flag` pair that came back 1M, or a
  `suffix` pair the CLI refused: fix the `reach`, or drop the window if the CLI
  has no route to it any more. Offering a window that cannot be reached is worse
  than not offering it, because the start succeeds and the card states a size
  the session does not have.
- **A `message.model` absent from `readings`:** add the spelling to that row's
  `readings`, keeping the uniqueness rule — a spelling two rows would both claim
  belongs to neither by default, so re-read the rule in the catalog's header
  before adding it. Exact strings only, never a prefix or a pattern.
- **A whole brand failing:** check it is signed in before touching a single row.

Every edit above lands with a dated, versioned line in
`docs/reference/cli_state/models.md`. A row changed with no reading behind it is
the thing this arrangement exists to prevent.
