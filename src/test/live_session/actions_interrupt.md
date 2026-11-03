# Live: `--interrupt` preempts, and reports honestly

## Purpose

`--interrupt` ends the turn in flight and makes the message the next
instruction — and whatever the interrupt does, the sender is told the truth
about whether the message was accepted.

## Proves what `check` cannot

Two things, and the second is the subtle one.

The **ordering**: `send(..., ahead)` then `sendNow()` has to land as one act. The
race it replaces — interrupt, then send — drains whatever was already held on
the interrupt's own idle edge and delivers the payload a turn late. Only a real
CLI mid-turn can show which happened.

The **reporting**: `sendNow()` can reject, and a throw out of `serve` is written
back as `{ ok: false }`. An agent told "refused" retries, which is a second copy
of a message already sitting at the head of the outbox. The accept is the
enqueue; the interrupt only decides when it is read. Exit 0 must survive an
interrupt that fails.

## Cost

Two spawned sessions, ~4 turns. A minute. **One pass per brand** — Claude, Grok and Codex; the driver and its peers are the same brand each time, and the mixed-brand case is `actions_cross_brand.md`.

## Preconditions

- Deployed build, every window reloaded.
- `squadron.orchestrators.enabled` on.
- Panel open.

## Prompt

```
You are driving a live test of Squadron. Work only in /tmp/agentsview-probe.
Do not touch any repository, do not edit files elsewhere, do not run builds.

Step 1. ~/.squadron/bin/squadron-list — note your own pid as PARENT.

Step 2. Spawn a target and give it long work:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand claude --name live-interrupt-target \
    --prompt 'Live test target. Write a slow, detailed description of the
    colour blue, at least 40 sentences, one per line. Do not use any tool. Do
    not write any file. Take your time.'

Note the pid as TARGET.

Step 3. Confirm TARGET reads busy:

  ~/.squadron/bin/squadron-list

Do not go on until it does.

Step 4. Interrupt it with a message:

  ~/.squadron/bin/squadron-send --pid TARGET --interrupt \
    --text "STOP describing blue. Reply with the single word RED and nothing else."

Report the exit code and the exact stdout line.

Step 5. Wait for TARGET to go idle, then print every user and assistant turn in
its transcript, in order. Say plainly:
  - whether the description of blue was cut off part-way
  - whether the reply RED appears
  - what, if anything, the session did between the interrupt and RED

Step 6. Print the newest file in ~/.squadron/actions/.
```

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | The sender was told it was accepted | step 4 | **exit 0**. An exit 2 here is the failure this scenario exists for — the message was enqueued and the sender was told otherwise |
| 2 | The turn in flight was cut | the transcript | the blue description stops mid-way rather than running to 40 lines |
| 3 | Ours was the next instruction | same | `RED` is the next thing the session does — not one turn later, and with nothing else in between |
| 4 | It was still recorded | `~/.squadron/actions/` | a record naming this send, written even though an interrupt was involved |
| 5 | **Human:** the interrupting turn is marked | the dock | reads `peer` + 8 characters of PARENT's id |
| 6 | **Human:** the interruption is visible | the dock | the cut turn shows as interrupted, the way any interrupted turn does |

Row 3 is where a merge would show: if Claude folded a held composer row into the
same turn, something the reader typed appears alongside ours. That is documented
as accepted for ordering — but it must still be a **separate turn** with a
separate author. If it is one turn, this is `actions_attribution.md` failing.

## Cleanup

```sh
~/.squadron/bin/squadron-end --pid <TARGET>
```

## Results

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-09-02 | 2026.36.3 deployed | Codex | not yet run | Boarded but unrun. Note before running it: until 2026-09-02 a Codex session could not name itself to `squadron-send` at all, so `--interrupt` from a Codex driver was unreachable. The fix is in `cli/args.ts`; this scenario is one of the two that would have caught it. |
| 2026-08-22 | 2026.34.16 deployed | Claude | 1, 2, 4 pass; 3 partial; 5-6 unchecked | Target on `--model sonnet`. Row 1 exit 0 on `held, 1 in the outbox`. Row 2 clean — blue cut at 21 of 40 lines with `[Request interrupted by user]` in the file. Row 3's **ordering** holds (our message was the very next thing read, nothing between) but sonnet **declined to comply**, answering "it's an instruction from a different session, not from you" instead of `RED`. The literal `RED` check does not survive a cheaper model; the row should assert the ordering, not the compliance. |

## Case 2: a command running under the interrupt

The prompt above interrupts prose, so no tool is in flight and nothing can
outlive the turn. This case interrupts a foreground shell command instead,
which is where the brands differ: Claude and Grok kill the command with the
turn, and Codex leaves it running and reports its `item/completed` under the
completed turn's id once it ends (`docs/reference/cli_state/codex/protocol.md`,
"A command outlives its turn"). Before `1f59b738` that late frame reopened a
turn nothing ended, so the card read busy forever, the queue never drained, and
Send now and Stop did nothing. No unit test can show what a real CLI does with
the command, so this case checks it.

**Cost:** one spawned session, ~3 turns, about two minutes because it waits for
the command's own end. One pass per brand; Codex is the one that matters.

**Preconditions:** as above.

### Prompt

`node -e` rather than `sleep`: a hook here refuses a bare `sleep`, and the
target then runs nothing, so the case passes on a turn with no tool in it.

```
You are driving a live test of Squadron. Work only in /tmp/agentsview-probe.
Do not touch any repository, do not edit files elsewhere, do not run builds.

Step 1. Spawn a target on the brand under test (pick the cheap model per
src/test/AGENTS.md; add --brand/--model/--effort accordingly):

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --name live-interrupt-command \
    --prompt "Live test target. Do not rename yourself or read any skill. Run
    exactly this one shell command in the foreground, not in the background,
    and wait for it: node -e 'setTimeout(()=>{},90000)'. Then reply with the
    single word: finished."

Note the pid as TARGET and the time as T0.

Step 2. Wait until the command is running: `pgrep -f "setTimeout"` prints a
pid, and ~/.squadron/bin/squadron-list reads TARGET busy. Wait 5 more seconds.

Step 3. Interrupt it:

  ~/.squadron/bin/squadron-send --pid TARGET --interrupt \
    --text "Interrupt test: stop and reply only with the word: interrupted."

Report the exit code and the exact stdout line.

Step 4. Every 5 seconds for 30 seconds, print TARGET's status and whether the
node process is still alive (`pgrep -f "setTimeout"`).

Step 5. Wait until T0 + 120 seconds, past the command's own 90-second end. Print
TARGET's status, then once it reads idle (give up after 30 seconds), send:

  ~/.squadron/bin/squadron-send --pid TARGET --text "Reply only with the word: after."

Wait up to 60 seconds for TARGET to go idle again.

Step 6. Print every user, assistant and tool entry in TARGET's transcript, in
order, with timestamps. Say plainly:
  - whether the command was cut, or ran to its end after the interrupt
  - whether any entry for the command arrived after the turn that ran it ended
  - whether `interrupted` and then `after` appear, each as its own turn
```

### Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | The sender was told it was accepted | step 3 | exit 0 |
| 2 | Ours was the next instruction | step 6 | the interrupting message is the next turn, and the model replies to it |
| 3 | Where the command went | steps 4, 6 | **record either answer** — killed within seconds (Claude, Grok), or alive until its own end with a late tool entry (Codex). Neither is a failure on its own |
| 4 | The card settles after the command's own end | step 5 | idle at T0 + 120 s. **Busy here is the bug** this case exists for |
| 5 | The queue still drains | step 5 | `after` arrives as its own turn and TARGET returns to idle |
| 6 | **Human:** the controls answer | the dock | while a later turn runs, Send now on a queued row and Stop each cut it |

### Cleanup

```sh
~/.squadron/bin/squadron-end --pid <TARGET>
```

A TARGET still busy at the end is row 4 failing. `squadron-end` refuses a
busy session, so end it from the card instead.

### Results

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-07 | 2026.39.9 deployed (0.3.13), before `1f59b738` | Codex | 1, 2 pass; 3 alive; **4 fail**; 5 unreachable | Baseline, hand-run ahead of this write-up on `gpt-6-luna` effort `low` with `sleep 180` (the hook binds only Claude). The interrupt cut the turn at 20:42:52 and `interrupted` was the next turn (20:43:28). The model ran `sleep 180` again inside that turn. Both sleeps ran to their end, and their tool entries landed at 20:45:47 and 20:45:55, after both turns had closed. The card read busy from then on, so `squadron-end` refused it. A raw app-server capture of the same order is in the protocol note above. |
| 2026-10-07 | 2026.39.9 deployed (0.3.13) | Grok | 1-5 pass; 3 killed | Baseline, hand-run on `grok-4.5`, no `--effort` (the record says `reasoning_effort: high`, the CLI's default), with `sleep 90`. Tool result "halted by the harness (user_cancel)"; process gone within 5 s; the held message ran with `prior_turn_interrupt` and got `interrupted`; idle. Row 5 not run separately, but the card went idle and took the next send. |
| 2026-10-07 | 2026.39.9 deployed (0.3.13) | Claude | 1-5 pass; 3 killed | Baseline, hand-run on `claude-sonnet-5-5` effort `low`. The first try used `sleep 120`/`sleep 90`, the hook refused both, and nothing ran, which is why the prompt uses `node -e`. With it: "Request interrupted by user for tool use", node gone within 5 s, `interrupted` as the next turn, idle. Row 5 as for Grok. |
