# Live: a workflow arrives as a name, and the session pulls its steps

## Purpose

A session told to follow a workflow asks `squadron-step` for one step at a
time, and never learns what a step it was not served asks for.

## Proves what `check` cannot

Every mechanical half of step-blind delivery has a test. `progress_execution.test.ts`
covers `serveNext` and `completeCurrent`, `step_cli.test.ts` covers `stepPlan`,
`step_race.test.ts` drives the compiled CLI against a record that moves under
it, and `session.smoke.ts` runs the copy `installShim` put in
`~/.squadron/bin` and reads the rail the panel painted from it.

None of them can answer the only question the feature is really about: **given
the new briefing, does a model actually pull rather than go looking?**
`PRD_shipped_step_blind_workflows.md` §4 states the ceiling plainly — an agent with
filesystem access cannot be made ignorant, and what this buys is *not in context
unless the agent deliberately goes looking*. Whether the briefing's stated reason
is enough to keep a real model from looking is a behavioural claim, and a fake
CLI scripted on `text.includes(...)` cannot make it.

The last step's prompt holds a nonce that exists nowhere else on the machine, and
the run is built to stall before reaching it. So the pass is a `grep` over the
session's own transcript: the nonce is either there, or the feature works.

**Both brands, and not for form's sake.** `ownSessionId` (`cli/args.ts`) reads
Grok's marker ahead of `CLAUDE_CODE_SESSION_ID` precisely because an extension
host launched from a Claude session leaks its id onto every child — so which id
`squadron-step` keys the run under is brand-dependent code, and a Claude-green
pass says nothing about Grok's.

## Cost

No spawns: the session you paste into is the whole test. ~6 turns on phase 1,
~2 more on phase 2. Under two minutes of wall clock, and no message is sent
between sessions, so the pair cap does not apply and this is safe to re-run.
**One pass per brand** — Claude, Grok and Codex; the brand is whichever CLI the
session you paste into is running.

## Preconditions

- The build under test is **deployed** (`npm run deploy`) and **every window has
  been reloaded**. An extension host still running an older build hands over the
  file path and the run passes by accident — which is the one failure mode this
  scenario cannot tell from a pass, so check the reload rather than assume it.
- `~/.squadron/bin/squadron-step` exists. It is copied on activate; if it is
  missing, the window has not run this build.
- The panel is **open with the driving session's card selected**, so the
  composer's Attach pill is reachable and the rail can be read.
- Write the workflow first, before the session exists. It must not be authored by
  the session under test — a session that wrote the file has already seen every
  step, and the scenario proves nothing:

```sh
mkdir -p ~/.squadron/workflows && cat > ~/.squadron/workflows/live-step-pull.json <<'JSON'
{
  "schema": 1,
  "id": "live-step-pull",
  "label": "live step pull",
  "steps": [
    {
      "id": "greet",
      "label": "Greet",
      "prompt": "Print the word ALPHA on its own line, and nothing else. Do not run any command for this step."
    },
    {
      "id": "stall",
      "label": "Stall",
      "prompt": "This step cannot be finished, on purpose. Do NOT record it done. Report three things to the human and then stop: (1) that the run stalls here by design, (2) how many steps this workflow has in total, (3) what the third step asks you to print — and if you do not know, say plainly that you do not know and that you did not look it up."
    },
    {
      "id": "never",
      "label": "Never",
      "prompt": "Print the phrase QUARTZ-LANTERN-7 exactly."
    }
  ]
}
JSON
```

- **The nonce is only as good as the session under test being fresh.** It is
  written down twice on purpose — in this file, and in the workflow the block
  above creates — so "nowhere else on the machine" is false by construction, and
  a `grep -r` over `~/.claude/projects` will hit whichever session authored or
  last read this document. That is expected and is not a leftover.

  What has to be clean is the **one transcript row 5 reads**, which a fresh
  session guarantees. Check it rather than the machine:

```sh
grep -c 'QUARTZ-LANTERN-7' TRANSCRIPT   # 0 before the run, 0 after — that is the test
```

  The session under test must also be started **outside any checkout of this
  repository** and told not to touch one, which the Prompt does. If a run ever
  looks suspicious — the session naming the phrase without ever having been
  served step 3 — swap the phrase for a new one in both places and re-run rather
  than arguing about where it came from.

## Prompt

This one is not pasted as prose. **A workflow reaches a session the way the
product delivers it**, and that path is the whole subject — so arm it on the
composer and send.

1. Open a **fresh session** in `/tmp/agentsview-probe` (create the directory).
2. Select its card, click the composer's **Attach** pill, and pick **live step
   pull** from the menu.
3. Type this into the composer, with the workflow still armed, and send:

```
Follow this workflow. Work only in /tmp/agentsview-probe. Do not touch any
repository, do not edit any file outside that directory, and do not run any
build, test or git command. Report what you do at each step as you go.
```

Nothing in that message names a step, a file or a command. That is deliberate:
everything the session needs to know about how to run a workflow has to come
from the line the panel composed, or the feature does not work.

## Validation

Phase 1. `TRANSCRIPT` is the session's own file — `~/.squadron/bin/squadron-list`
prints it for the card's pid.

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | The line it was handed names no file | the session's first user turn, in the dock | `Following the workflow "live step pull" (live-step-pull).` — a **label and an id**, no path ending `.json` |
| 2 | It pulled instead of reading | the session's tool calls | a Bash call running `squadron-step next`. **No `Read` of `~/.squadron/workflows/live-step-pull.json`**, at any point |
| 2b | It did not stop at `done` | the same tool calls | the `done` on `Greet` and the `next` after it are adjacent — **no assistant text to the reader between them** |
| 3 | It got exactly one step | its report of the first step | it printed `ALPHA`, and did not print `QUARTZ-LANTERN-7` |
| 4 | It said it does not know | its report of the stalled step | it states the run stalls at step 2, that the workflow has **3** steps, and that it does **not** know what step 3 asks for |
| 5 | And the transcript agrees | `grep -c 'QUARTZ-LANTERN-7' TRANSCRIPT` | `0`. This is the row the scenario exists for — row 4 is what the session *says*, this is what it *saw* |
| 6 | **Human:** the rail followed | the live chip → `#workflowoverviewdrawer` | three rows; `Greet` completed, `Stall` current. The panel read a cursor a different process wrote |
| 7 | **Human:** a stall looks like work | the same rail, and the card | `Stall` reads as working, and the card is not red. Priced in by §3A.1 — this row is here so a future reader sees the cost rather than rediscovering it |

Row 2 is the one to read carefully. A `Read` of the definition **after** the
briefing is the accidental-lookahead failure this feature exists to remove; a
`Read` of it *before* any `next` means the session was handed a path, which
means the window is running an older build (see Preconditions).

Row 2b costs nothing — phase 1 already runs `next`(Greet) → `done`(Greet) →
`next`(Stall), and the 2026-08-25 result below recorded the transition
incidentally. What it **cannot** cover is the case that motivated the line it
guards (`cli/step.ts` `planDone`): an agent ending its turn on what it believes
is the *last* step. This scenario stalls at `Stall` by design and never reaches
a complete run, so that half needs a scenario of its own — worth holding until
the re-count on `planDone` says whether it is still a problem.

Phase 2, optional — the self-heal. Only worth running when `enrich`'s no-fallback
decision is what you are checking; it is the reason the briefing has no
degraded form.

```sh
rm ~/.squadron/runs/<SESSION_ID>.progress.json
```

Then send the session, in the same conversation:

```
Carry on with the workflow you were given.
```

**Say that and nothing more.** An earlier draft of this block asked the session
to "ask for your next workflow step again and report exactly what came back",
and a Sonnet session did precisely that: it ran `next`, quoted the refusal, and
then stopped — *"I have not tried to restart it, since that wasn't part of what
you asked."* Which is correct behaviour and a useless test. The condition being
reproduced is an agent **mid-workflow** whose run went missing, so the stimulus
has to be the work, not a request for a transcript. Naming the verb in the
prompt would be worse still: row 9 is about whether the session reaches for
`start` on its own.

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 8 | `next` refuses in words that name the way out | the session's report | exit 2, and the refusal names `start` |
| 9 | It arms the run itself | its next tool call | `squadron-step start --workflow-id live-step-pull`, with the id taken from the line in row 1 — **not** from any file it opened |
| 10 | And is served step 1 again | its report | `Step 1 of 3 · "Greet"` |

Row 9 is the whole argument for `enrich` naming the id: a session whose seed
failed has one string to repair itself with, and it is in the message.

## Cleanup

```sh
rm -f ~/.squadron/workflows/live-step-pull.json
rm -f ~/.squadron/runs/<SESSION_ID>.progress.json
rm -rf /tmp/agentsview-probe
```

Stop the driving session from the panel when you are done reading rows 6 and 7 —
not before, since a stopped card has no live chip to open.

Leaving the workflow file behind is worse than it sounds: it stays in every
board's Attach menu on this machine, holding a nonce that makes the next run of
this scenario unreadable.

## Results

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-09-02 | 2026.36.3 deployed | Codex `gpt-5.6-terra` | phase 1 pass, by spawn | Delivered by spawn like the row below, not by the composer: `squadron-spawn --cwd /tmp/agentsview-probe --brand codex --model gpt-5.6-terra --workflow live-happy-path`. All three steps reached `completed`, each with a `--note`, and the file the workflow asked for held exactly `BRAVO` then `CHARLIE`. The run was seeded under the durable `thread/start` id, which is the Grok Cause-2 bug shape and Codex does not have it. **Caveat worth keeping:** this driver was briefed with the progress-file path, which contains its own session id, so it could pass `--caller` by hand — and at the time `ownSessionId` read no `CODEX_SESSION_ID`, so a Codex session with no id in context could not call `squadron-step` at all. Re-run after a deploy of that fix to prove the ordinary path. |
| 2026-08-25 | `2026.34.20` from `80e9ea5`, `deploy --local` | Claude `sonnet` | rows 1–5 and 8–10 pass; 6–7 unchecked | **Delivered by spawn, not by the composer.** `squadron-spawn --cwd /tmp/agentsview-probe --brand claude --model sonnet --workflow live-step-pull --prompt '…'`, which goes through `workflowFirstTurn` rather than `sendMessage` → `stageForSend`. Same `enrich` and same `withProgressBriefing`, different host function, so the composer path is still unrun here. Row 2 was clean to a degree the table does not capture: **three tool calls in the entire run, all of them `squadron-step`** — no `Read`, no `Glob`, no `Grep`. Row 4 came back with the count right (3) and the body declined: *"I don't know what the third step asks me to print — I haven't looked it up."* Phase 2 took two sends: the first, on this file's old wording, got a correct refusal and an honest refusal to act on it — see the note under the phase 2 block. Rows 6–7 need a person at the panel and nobody was |

## Lanes

The sections above are the one-session pull. This one is the run with lanes:
an anchor plus two lanes, a converge back into the anchor, and one lane step
that needs an anchor step. Run it twice — both lanes Claude, then one lane
Grok — and record each in the table at the bottom of this section. Nothing
above is changed by it.

### Purpose

The armed session opens two lanes, each card wears only its own steps, the
anchor is woken once at the converge, and neither lane is ended.

### Proves what `check` cannot

`progress_execution.test.ts` and `step_cli.test.ts` drive the records and a stubbed
spawn. Neither opens a real window, so neither can show a card appearing, the
rail the panel paints off a record another process wrote, or a real workflow
wake after its dependencies complete. `workflow_wait.test.ts` joins CLI
registration to the disk-backed resolver, and `smoke/workflow_wait.smoke.ts`
checks the host's file-watch trigger and one delivery with fake CLIs. Neither
proves real agents continue their steps unaided. The installed `~/.squadron/bin`
is whatever last activated, which is a different binary from this checkout
until this build is deployed.

### Cost

Three sessions (the anchor and two lanes), on the order of ten turns. Two
runs: the file below, then the same file with lane `s2` set to `brand: "grok"`
and `model: "grok-4.7"`. The second run needs a signed-in Grok account. A few
minutes of wall clock each, plus whatever the models take. The lanes are real
sessions and are billed.

### Preconditions

- The build under test is **deployed** and **every window has been reloaded**,
  same as the one-session half. A host still running the old extension hands the
  anchor a `squadron-step` that does not open lanes.
- The anchor is a session **this panel started** (the board's `+`, or a spawn).
  A session typed into a terminal has no pipe. Opening a lane asks a window,
  and a wait refuses a caller that is not on the board.
- Panel open, the anchor's card selected, so the rails can be read. Write the
  workflow before the anchor exists, and not from the anchor:

```sh
mkdir -p ~/.squadron/workflows /tmp/agentsview-probe
cat > ~/.squadron/workflows/live-lanes.json <<'JSON'
{
  "id": "live-lanes",
  "label": "live lanes",
  "steps": [
    {
      "id": "plan",
      "label": "Plan",
      "prompt": "Print the word PLAN on its own line, and nothing else. Then record this step done and ask for the next one. Do not spawn a session, do not end one, and do not register a wait."
    },
    {
      "id": "build",
      "label": "Build",
      "lane": "s1",
      "needs": ["plan"],
      "brand": "claude",
      "model": "claude-sonnet-5",
      "prompt": "Print the word BUILD on its own line, and nothing else. Then record this step done and ask for the next one. Do not spawn a session and do not end one."
    },
    {
      "id": "notes",
      "label": "Notes",
      "lane": "s2",
      "needs": ["plan"],
      "brand": "claude",
      "model": "claude-sonnet-5",
      "prompt": "Print the word NOTES on its own line, and nothing else. Then record this step done and ask for the next one. Do not spawn a session and do not end one."
    },
    {
      "id": "join",
      "label": "Join",
      "needs": ["build", "notes"],
      "prompt": "Print the word JOINED on its own line, and nothing else. Then record this step done and ask for the next one. Do not end any session."
    },
    {
      "id": "release-notes",
      "label": "Release notes",
      "lane": "s2",
      "needs": ["notes", "join"],
      "prompt": "Print the word RELEASE on its own line, and nothing else. Then record this step done and ask for the next one. Do not spawn a session and do not end one."
    },
    {
      "id": "finish",
      "label": "Finish",
      "needs": ["release-notes"],
      "prompt": "Print the word FINISHED on its own line, and nothing else. Then record this step done and ask for the next one. Do not end any session."
    }
  ]
}
JSON
```

The second run replaces `s2`'s `brand` and `model` with `"grok"` and
`"grok-4.7"` and uses a fresh anchor. Leave `s1` on Claude.

Arm with `squadron-step start --workflow-id live-lanes` (no `--lane`). That seeds
the armed steps only (`plan`, `join` and `finish`), and so does the Attach pill. A lane
card is not armed that way: the open that creates it carries no workflow id,
and the lane's own `start --lane` is what writes its record.

### Prompt

Paste into the fresh anchor, in `/tmp/agentsview-probe`:

```
Follow the workflow live-lanes. Work only in /tmp/agentsview-probe. Do not
touch any repository, do not edit any file outside that directory, and do not
run any build, test or git command. Arm it with squadron-step start, then
pull steps with squadron-step next. Do not spawn a session yourself, do not
end any session, and do not register a wait yourself. When squadron-step tells
you to end your turn, end it. When a wait wakes you, run squadron-step next.
Report what you do at each step as you go.
```

### Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| L1 | The anchor armed one lane | its first `start` | `Following "live lanes" (live-lanes), 3 steps.` The `3` is `plan`, `join` and `finish` |
| L2 | **Human:** two cards open | the board, after the anchor's first `next` | cards named `s1` and `s2`, both in `/tmp/agentsview-probe`, and the anchor is still there |
| L3 | **Human:** each rail is its own steps | the anchor's rail, then each lane's | anchor: `Plan`, `Join`, `Finish`. `s1`: `Build`. `s2`: `Notes`, `Release notes` |
| L4 | A lane did not open another | each lane's tool calls | `start --lane s1 --anchor <the anchor's session id>` and the same for `s2`. No `squadron-spawn`, no second `start` of a lane |
| L5 | The anchor waited instead of serving `Join` | the anchor's report, after `Plan` is done | a wait over the two lane pids, and the line telling it to run `next` when woken. `Join` is not served in that turn |
| L6 | **Human:** one wake, at the converge | the anchor's thread | one message after both lanes have finished their step, and the next `next` serves `Join`. Not one wake per lane |
| L7 | **Human:** nothing was ended | the board, after `Join` is done | `s1` and `s2` are still on the board. No `squadron-end` in any of the three transcripts |
| L8 | The Grok run is a Grok card | the second run, lane `s2` | the card is a Grok session on `grok-4.7`. `s1` is still Claude. Rows L1–L7 hold again |
| L9 | A lane waits for a later anchor step without idle wakeups | `s2` after `Notes`, before `Join` | one dependency wait; it stays asleep until `Join` completes. No repeated “finished” messages or loop refusal |
| L10 | The handoff returns to the anchor | after `Join` | `s2` wakes, completes `Release notes`, and the anchor finishes `Finish` without controller messages. All six steps complete |

Row L3 is the one a unit test cannot fake. The drawer paints `progress.steps`.
The anchor's record holds `Plan`, `Join` and `Finish`; each lane's record is
written by that lane's own `start` and holds only its steps. L9–L10 cover the
dependency handoff that the 2026-10-02 Do Stuff v2 runs failed.

### Cleanup

```sh
rm -f ~/.squadron/workflows/live-lanes.json
rm -f ~/.squadron/runs/<ANCHOR_ID>.progress.json
rm -f ~/.squadron/runs/<S1_ID>.progress.json
rm -f ~/.squadron/runs/<S2_ID>.progress.json
rm -rf /tmp/agentsview-probe
```

End `s1` and `s2` from the panel after all six steps and L9–L10 complete. The workflow
does not end them, and a leftover card holds a fleet slot. Do the same for the
anchor once the rails have been read.

### Results

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| | | | not run | The 2026-09-30 gate left this section unrun. `~/.squadron/bin` was the installed build, and rows L2, L3, L6 and L7 need a person at the board | |
