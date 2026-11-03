# Live-session tests

Prompts a human hands to a **fresh session**, which then drives the product for
real: spawning peers, messaging them, reading what came back. Nothing here is
run by `npm run check` or by `npm run test:smoke`, and nothing here should ever
be made to.

## Why these exist

`check` proves a function; `test:smoke` proves the panel stands up in a real
host. Neither can prove that a chain of processes agrees with itself.

The two worst defects in the cross-session verbs were both invisible to 3073
unit tests **and** to the smoke barrel:

- `serve` handed the shim's already-wrapped message to `checkSend`, whose
  forgery guard fired on our own wrapper. Every send would have been refused.
  Both halves had tests; their composition had none, because `serve` imports
  `vscode`.
- The outbox merge joined two held messages with a blank line, so the transcript
  reader saw one message and filed the second sender's words under the first
  sender's name.

Both are one process agreeing with a second process about a file a third process
wrote. That is what these test.

## When to run them

**Not often** — they cost real tokens: every scenario spawns sessions and each
spawned turn is billed. Once a week, and before a production release
(`npm run publish`). A scenario states its cost at the top so you can pick.

**On every supported CLI, not only Claude.** The weekly and pre-release run is
once per brand this build actually drives — `BRANDS` in `src/core/adapter.ts`,
**Claude, Grok and Codex**. A Claude-green pass with the others untested is the
same class of miss these tests exist for: each CLI writes a different file, and
the unit suite plus the fake CLIs share one reader's shape.
`actions_cross_brand.md` and `wait_convergence.md` already mix brands; those
*are* the cross-brand run, not a thing to duplicate as Claude-only.
`turn_checkpoints.md` is the one exception, and it says so at the top: the
feature it drives is constructed in `core/claude/session.ts` and nowhere else,
so there is no Grok or Codex pass to take — only a gap to record.

**Codex boarded on 2026-09-02, and the run that boarded it found two defects no
unit test or smoke scenario could see** — both of them quiet failures rather
than loud ones, which is why daily use had not surfaced either. A Codex session
could not name itself to any verb (`ownSessionId` read no `CODEX_SESSION_ID`, so
`send`, `list --mine`, `step`, `rename`, `end` and `wait` all refused it — every
verb that takes a caller), and a Codex card
carried no transcript reference (`copyRef` copied the empty string and reported
success). Both are recorded in
`docs/tasks/TASK_done_codex_orchestration.md`. The lesson for whoever runs
these next: **the smaller model on a bare prompt is the better probe.** A strong
model handed its own session id in the briefing worked around the first defect
without mentioning it, and only the peer with no id in context hit the wall.

They are also **not a gate**. A red scenario is a conversation, not a blocked
merge — though a red one in `actions_delivery.md` means the feature does not
work at all, so treat that one as a gate in practice.

## How to run one

1. Read the scenario's **Preconditions**. Most need a build that is actually
   deployed — `npm run deploy` and then a **reload of every window**, or the
   extension host is still running the old code and you are testing nothing.
   One does not: `wait_convergence.md` drives a verb that has not shipped, so it
   wants an Extension Development Host on the branch instead. Its preconditions
   say so and carry the launch line.
2. Open a **fresh session** in a scratch directory. Not one holding work: these
   spawn peers, send messages, and stop things.
3. Paste the scenario's **Prompt** block verbatim. It is written to be
   self-contained — a fresh session has none of this context.
   `workflow_step_pull.md` is the one that asks for more than a paste: what it
   tests is how a workflow is *delivered*, so the block goes in the composer with
   the workflow armed on the Attach pill. Its Prompt section says so.
4. Check the **Validation** table yourself. Some rows only a human can check:
   what the dock draws, whether the prompt-nav arrows step onto a turn. The
   session cannot see the panel.
5. Run the **Cleanup** block. A left-over spawned session holds a fleet slot
   (15 machine-wide) and keeps costing.
6. Record the result at the bottom of the file, **including the brand**. A pass
   on Claude is not a pass on Grok.

A prompt that hardcodes `--brand claude` is the first pass, not the only one.
Swap the brand and drive from a **fresh session of that CLI** too. The driver
has to be the same brand as the peers it spawns — a Claude session spawning
Grok peers is the cross-brand files, not a Grok pass of `actions_delivery.md`.

## Writing one

Every file has the same eight sections, in this order:

| Section | What goes in it |
| --- | --- |
| **Purpose** | The one claim this makes. One sentence |
| **Proves what `check` cannot** | Why this is worth tokens. If you cannot answer it, write a unit test instead |
| **Cost** | Sessions spawned, roughly how many turns, whether it already mixes brands (the rest still want a pass per CLI) |
| **Preconditions** | Deployed build, settings, flags, a quiet board — anything false here makes the result meaningless |
| **Prompt** | A fenced block, pasted verbatim into a fresh session. Absolute paths, no repo assumptions, and an explicit *do not touch anything else* |
| **Validation** | A table: what to check, where to look, what a pass looks like. Mark the rows only a human can see |
| **Cleanup** | Exact commands. Never "stop the sessions you made" |
| **Results** | One line per run: date, build, brand, pass/fail, what broke |

Two rules the scenarios here follow, both learned the hard way:

- **Target throwaways, never live work.** Send into a probe session in
  `/tmp/agentsview-probe`, not into a session someone is using. A message wakes
  a session and costs it a full context re-send.
- **Mind the pair cap on a re-run.** Four messages one way to one session in 15
  minutes is refused. Re-running a delivery scenario inside that window will
  fail on the cap and look like a bug. Either wait it out, spawn a new target,
  or pass `--force` — which does **not** lift the pair cap, so waiting is the
  only real answer.

## The scenarios

| File | What it drives |
| --- | --- |
| `actions_delivery.md` | A message goes A→B and arrives marked, recorded, and attributed |
| `actions_attribution.md` | A held row and an arriving message stay two turns with two authors |
| `actions_interrupt.md` | `--interrupt` makes a message the next instruction, and reports honestly; case 2 interrupts a running command and checks the card settles after it |
| `actions_guardrails.md` | The refusals that only a real board can produce |
| `actions_cross_brand.md` | Claude→Grok and Grok→Claude, both directions |
| `wait_convergence.md` | A fan-out over two brands wakes its parent **once** |
| `prose_images.md` | A reply that names a picture draws it, on both brands |
| `turn_checkpoints.md` | A turn draws what the tree says it wrote, and says so short when a neighbour was writing too |
| `execution_windows.md` | Scoped native capture and retained fallback across Claude, Grok and Codex |
| `workflow_step_pull.md` | A workflow arrives as a name, and the session pulls its steps rather than reading the file. The Lanes section is the run with lanes: two cards, each its own steps, one wake at the converge, nothing ended |
| `model_catalog.md` | Every row in `core/catalog.ts` still starts a session, at the window it claims |
