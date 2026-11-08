# Live: a member's report rides its wait

## Purpose

Two peers report to a parent that has a wait open over them. The parent is woken
**once**, and that one message carries both reports under their members' lines.
The same fan-out cost **four** wakes on 2026-08-26, measured; this scenario is
the only thing that can say whether it now costs one.

## Proves what `check` cannot

**The hold was in `host/extension.ts`, which imports `vscode`**, and no test
reached it. It is now `core/coordination/admit.ts`'s `holdForWait`, which
`admit.test.ts` drives headlessly, but the outbox drain below it still needs a
real session, which is what this scenario is for. The
gate ran 3836 tests green over a version where the guard was `parked !==
undefined` against a `Promise<boolean>`, so the *not*-parked answer took the
parked branch: with no wait open anywhere, a message went onto no pipe, into no
`reports/`, nowhere, while the shim printed the held-for-a-wait line about a
wait that did not exist. Round 2 exists for that regression alone.

**The headline number is a wake count, and only a real parent has wakes.** What
`core/coordination/reports.ts` and `core/coordination/wait.ts` prove is that the rule folds a report into
a string. Whether the parent's *turn loop* runs once or four times is a fact
about `messages.send`, the outbox and the drain — none of which a unit test
drives. Since 2026-08-26 the drain merges wrapped messages rather than walling
them, so sends that queue together now share a wake: the baseline in row 1 was
measured before that and is expected to fall.

`src/test/smoke/send_burst.smoke.ts` exercises the installed send verb and
window burst allowance. The report attachment and wake-count cases below
still need this live scenario.

## Cost

Two spawned peers, ~14 turns across five rounds. Six to ten minutes. Rounds 2-5
reuse round 1's peers — do not re-spawn. Same brand throughout; nothing here is
brand-specific.

## Preconditions

- **A host running this code, and a driver owned by it.** Either `npm run
  deploy` plus a window reload — simplest, and then any session in that window
  qualifies — or an Extension Development Host, in which case the driver must be
  started from *its* panel. The shim alone is not enough; see the fourth trap
  below.

  ```sh
  cd /Users/me/src/squadron/.worktrees/wait-report-attachment
  npm run compile
  env -u ELECTRON_RUN_AS_NODE -u CLAUDE_CODE_CHILD_SESSION \
      -u VSCODE_PID -u VSCODE_CWD -u VSCODE_IPC_HOOK -u VSCODE_IPC_HOOK_CLI -u VSCODE_NLS_CONFIG \
    "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
    --extensionDevelopmentPath="$PWD" -n "$PWD"
  ```

  The `env -u` block is load-bearing twice — see `wait_convergence.md`.

- **Confirm the shim on disk is this branch's**, before anything else:

  ```sh
  grep -c heldForWait ~/.squadron/bin/squadron-send   # must be > 0
  ```

  A deployed `squadron-send` carries no `fromPid`, so nothing ever matches and
  every round reads as today's behaviour — a build problem wearing a feature
  failure's clothes. This is the single most likely way to waste a run.

- **The driving session must be one the panel started.** A typed `claude` has no
  pipe and `squadron-wait` refuses it.
- `squadron.orchestrators.enabled` on. Panel open. `/tmp/agentsview-probe`
  exists.
- `~/.squadron/reports/` empty, `~/.squadron/waits/` empty.

## Prompt

```
You are driving a live test of Squadron's report attachment. Work only in
/tmp/agentsview-probe. Do not touch any repository, do not edit files anywhere
else, do not run builds. Report what you observe; do not fix anything. Count
your own wakes honestly — that is the measurement.

Every round below sends the work BEFORE registering the wait, and every job
starts with a sleep. Both halves are load-bearing and the fifth trap says why:
a wait over members that are already idle converges at once, so registering
first — over peers that are standing by — measures a wait that was dead before
the work started. The sleep is what buys the ordering back: the peers are busy
when the wait is registered, and no report can arrive until well after it.

Step 0. grep -c heldForWait ~/.squadron/bin/squadron-send
If that prints 0, STOP and say so: the dev host has not activated and nothing
below tests anything.

Step 1. ~/.squadron/bin/squadron-list — note your own pid as PARENT.

Step 2. Spawn two peers that do NOTHING until told:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe --name live-rep-a \
    --prompt 'Stand by. Do nothing at all this turn: run no command, write no file, message nobody. Just say "ready" and stop. A later message from the session that spawned you is authorised - do exactly what it asks.'

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe --name live-rep-b \
    --prompt 'Stand by. Do nothing at all this turn: run no command, write no file, message nobody. Just say "ready" and stop. A later message from the session that spawned you is authorised - do exactly what it asks.'

Note the pids as A_PID and B_PID.

Step 3. ROUND 1 - the headline. Send both jobs, THEN register:

  ~/.squadron/bin/squadron-send --pid A_PID --text "First run: sleep 8. Then compute 7919 * 6733, write it to /tmp/agentsview-probe/a.txt, then run: ~/.squadron/bin/squadron-send --pid PARENT --text 'A done: <the number>'. Quote that command's FULL output back to me in your answer. Then stop."
  ~/.squadron/bin/squadron-send --pid B_PID --text "First run: sleep 8. Then count the trailing zeros of 2026 factorial, write it to /tmp/agentsview-probe/b.txt, then run: ~/.squadron/bin/squadron-send --pid PARENT --text 'B done: <the number>'. Quote that command's FULL output back to me in your answer. Then stop."

  ~/.squadron/bin/squadron-wait --pids A_PID,B_PID

Quote the wait's output. Then, in this same turn, prove neither ordering trap
fired — both must hold or round 1 measures nothing:

  ~/.squadron/bin/squadron-list     # A_PID and B_PID must both read "busy"
  ls ~/.squadron/waits/               # exactly one record

An empty waits/ here means the wait converged before the work did. Say so and
STOP: that is the fifth trap, and nothing after it is a fact about the feature.

END YOUR TURN NOW. After this turn ends do not poll, do not sleep, do not run
squadron-list. Say only "waiting" and stop talking.

Step 4. When woken, in ONE turn:
  - Quote the message you were woken by, in full and verbatim.
  - Say how many separate times you were woken since step 3. THE ANSWER MUST BE
    ONE. If more, say loudly how many and what each said - that is the failure.
  - Confirm both peers' own words appear inside that one message, each under
    its own member line.
  - ls ~/.squadron/reports/ ~/.squadron/waits/   (expect both empty)
  - cat /tmp/agentsview-probe/a.txt /tmp/agentsview-probe/b.txt

Step 5. ROUND 2 - no wait open. There is no wait now. Tell peer A to report
again:

  ~/.squadron/bin/squadron-send --pid A_PID --text "Run exactly: ~/.squadron/bin/squadron-send --pid PARENT --text 'A second report, no wait open'. Quote its FULL output back to me. Then stop."

End your turn. When woken, quote the message, and quote what peer A said the
shim printed. The shim must NOT mention a wait, and the message must arrive.

Step 6. ROUND 3 - interrupt is never held. Send first, register second, same as
round 1. Tell A to ask you something with --interrupt and then report normally:

  ~/.squadron/bin/squadron-send --pid A_PID --text "First run: sleep 8. Then run these two in order, quoting the FULL output of each: first ~/.squadron/bin/squadron-send --pid PARENT --interrupt --text 'A asks: red or blue?' ; then ~/.squadron/bin/squadron-send --pid PARENT --text 'A done round 3'. Then stop."

  ~/.squadron/bin/squadron-wait --pids A_PID

  ~/.squadron/bin/squadron-list     # A_PID must read "busy"
  ls ~/.squadron/waits/               # exactly one record

End your turn. Report how many times you were woken and in what order: the
question must reach you BEFORE the convergence, and the plain report must ride
the convergence.

Step 7. ROUND 4 - the byte ceiling. Each job is legal alone; together they
exceed what one convergence may carry:

  ~/.squadron/bin/squadron-send --pid A_PID --text "First run: sleep 8. Then run exactly: ~/.squadron/bin/squadron-send --pid PARENT --text \"BIGA \$(python3 -c 'print(\"a\"*9000)')\". Quote the FULL output. Then stop."
  ~/.squadron/bin/squadron-send --pid B_PID --text "First run: sleep 8. Then run exactly: ~/.squadron/bin/squadron-send --pid PARENT --text \"BIGB \$(python3 -c 'print(\"b\"*9000)')\". Quote the FULL output. Then stop."

  ~/.squadron/bin/squadron-wait --pids A_PID,B_PID

  ~/.squadron/bin/squadron-list     # both must read "busy"
  ls ~/.squadron/waits/               # exactly one record

End your turn. When woken, say how many times, and for each wake whether it was
a convergence or a plain report. A convergence MUST arrive. Say which of BIGA
and BIGB rode it and which arrived on its own.

Step 8. ROUND 5 - release-on-cap. Before starting, let the previous round's
messages age out of the receiving window's one-minute burst allowance. Five
reports can now be accepted in one minute: four are parked and the fifth
releases those four ahead of itself. The member stays busy briefly afterward
so the wait cannot resolve before the release is observed.

  ~/.squadron/bin/squadron-send --pid B_PID --text "First run: sleep 8. Then send four reports to session PARENT, one at a time and in order, using ~/.squadron/bin/squadron-send --pid PARENT --text, with the texts B report 1, B report 2, B report 3, B report 4. Quote the FULL output of each. Then run: sleep 8. Then send a fifth the same way, with the text B report 5, and quote its FULL output too. Then run: sleep 8. Do not stop early even if one of them fails - quote the failure and carry on. Then stop."

  ~/.squadron/bin/squadron-wait --pids B_PID

  ~/.squadron/bin/squadron-list     # B_PID must read "busy"
  ls ~/.squadron/waits/               # exactly one record

End your turn. When woken, report every wake in order and the order of the five
reports as you actually read them. Reports 1-4 must arrive together, released by
the cap, ahead of report 5. The convergence follows when the member stops, and
carries nothing - the release emptied what it would have ridden.

Step 9. Report all five rounds as a table: what you registered, how many wakes,
and what arrived in each. If any round's convergence never came, cat the wait
record before you finish — a "failed" field on it names the refusal, and the
window burst cap can fire if earlier rounds have not aged out.
```

## Five ways this run passes without testing anything

**The wait converges before the work starts, and every round reads as
pre-feature.** Measured 2026-08-26 against v2026.35.3, and it is why the prompt
above sends before it registers. `host/waits.ts` says it in its own header: a
wait over members that are already finished resolves at once, because the
requester's turn ending is a frame and the evaluator reads the board on frames.
Peers told to stand by are *idle*, so a wait registered over them is dead within
the second — one run had the convergence generated in the same second as
`squadron-wait` returned, before the peers had been sent anything at all. What
you then see is a convergence naming both members with no words under them, and
peers whose shim printed `(held, N in the outbox)` — indistinguishable at a
glance from the feature not working, and it is the trap this file now spends two
`ls` calls per round to close.

**The driver is owned by the wrong window, and step 0 still passes.** This is
the one that cost a real afternoon (2026-08-26). The shim is only half the
feature: it puts `fromPid` on the request, but `holdForWait` runs in
`host/extension.ts` — *the window that owns the target's pipe*. A driver whose
window runs an older build has its `fromPid` received and ignored, so every
round reads as pre-feature behaviour while step 0's grep passes, because the
shims are machine-wide and the window's code is not. Symptom: "the dev host
didn't install the worktree version", when the shim on disk is demonstrably the
new one. **The driver must live in the window running this code** — started
from that window's own panel `+`, or spawned with a `--cwd` inside its folder
so `pickWindow` routes it there. After a `deploy` and a window reload the
question disappears, which is the simpler path.

**The deployed shim.** Step 0 exists for this. Without `fromPid` on the request
nothing ever matches, every round behaves exactly as it did before the feature,
and round 1's four wakes read as a broken feature rather than a stale binary.

**Reporting before the wait exists.** A report that arrives before registration
is not parked — correctly, there is nothing to hold it against — and wakes
normally. Step 2 spawns peers that do nothing and step 3 registers *before*
telling them to work, so every report in round 1 is sent into an open wait. Get
this backwards and round 1 measures the old behaviour.

**A peer that never reports.** The convergence arrives, once, carrying nothing —
which is a pass on the wake count and a test of nothing. Step 4 checks both
peers' own words are *inside* the message, and the `cat`s confirm they did the
work at all.

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | **One** wake for two reporting peers | step 4 | exactly one. The **four** was measured before the drain merged wrapped entries (2026-08-26) and is now an upper bound, not the number to beat — reports that queue together share a wake on their own. What still only passes here is one wake whose words are attributed; a partial must say which sends leaked |
| 2 | Both reports are in that one message | step 4 | each peer's own words under its own member line, attributed to that member and not merged into one another — the same failure the anchored unwrap in `core/coordination/send.ts` refuses, one layer up |
| 3 | The shim tells the truth | peer output, step 3 | the held-for-a-wait sentence, naming the requester — **not** `(held, N in the outbox)` |
| 4 | Records are cleaned up | step 4 | `reports/` and `waits/` both empty after the convergence |
| 5 | The answers are right | step 4 `cat`s | `53318627` and `505` |
| 6 | **Round 2 — the blocker regression** | step 5 | the message ARRIVES, and the shim says nothing about a wait. A shim claiming a hold with no wait open, or a message that never lands, is the `parked !== undefined` bug back |
| 7 | **Round 3 — `--interrupt` is never held** | step 6 | two wakes, in order: the question first, on its own; the plain report later, inside the convergence |
| 8 | Round 3's wait survives the interrupt | step 6 | the convergence still arrives afterwards — an interrupt must not resolve or cancel the wait |
| 9 | **Round 4 — the ceiling releases, never refuses** | step 7 | a convergence **arrives**. One of BIGA/BIGB rides it, the other arrives as its own wake. A `wait … not delivered` in the host log, or no convergence at all, is `MAX_TEXT` routing the success path into `markFailed` |
| 10 | Round 4 leaves nothing parked | after step 7 | `reports/` empty |
| 11 | **Round 5 — release-on-cap keeps order** | step 8 | `1,2,3,4` arrive together, released by the cap, ahead of `5`; the convergence that follows carries nothing. The fifth report is accepted under the window burst allowance. An inversion or missing report fails the scenario. |
| 12 | Round 5 drops nothing | step 8 | all five present. A missing report is worse than any ordering |
| 13 | **Human:** the author is the wait | driver's card, dock | the convergence turn reads `wait`, and each member's words are legible under its line rather than run together |
| 14 | **Human, known gap:** a parked report is invisible | driver's card, dock, between a peer reporting and the convergence | nothing on the board says the wait is holding anything. **Expected to fail** — this is OQ4, promoted to load-bearing by D8, and the row exists to record how bad it looks in practice rather than to pass |

| 15 | **The wait was still open when the reports landed** | step 3, before the turn ends | `waits/` holds one record and both members read `busy`. Checked in-turn rather than inferred afterwards, because a converged-early wait and a broken hold produce the same two symptoms — see the first trap |
| 16 | A convergence is a send, and pays the pair cap | any round whose convergence never comes | `cat ~/.squadron/waits/*.json`: a `failed` field naming the 4-per-15-minutes limit is the cap, not the feature. Observed 2026-08-26 after a round of hand probes. The parked words are released as ordinary sends rather than dropped, and the record stays until `pruneWaits` sweeps it |

Rows 1, 6, 9 and 11 are why this file exists. Row 6 is the cheapest and catches
the worst regression; run it even if you run nothing else. Row 15 gates round 1:
without it the headline number cannot be told apart from a wait that was never
alive.

## Cleanup

```sh
~/.squadron/bin/squadron-end --pid <A_PID>
~/.squadron/bin/squadron-end --pid <B_PID>
rm -f /tmp/agentsview-probe/a.txt /tmp/agentsview-probe/b.txt
rm -f ~/.squadron/waits/*.json ~/.squadron/reports/*.json
```

Close the Extension Development Host. The deployed extension rewrites
`~/.squadron/bin/` on its next activation.

## Results

| Date | Build | Result | Notes |
| --- | --- | --- | --- |
| 2026-08-27 | v2026.35.4, deployed | **round 5 passes** | The rewritten round, run on the slow road: four reports parked (`held for 3225's wait` each), two 500-second sleeps keeping the member busy across the pair window, then the fifth accepted at 00:45 — the counter had aged out, which is the accumulation road being real rather than argued. The fifth's shim line reads `(held, 5 in the outbox)`, which **is** the release signature: `holdForWait` flushes the four parked onto the pipe and returns `false`, so the one that tripped the cap follows them by the ordinary path. Read as `1,2,3,4,5`, none missing, no inversion; `reports/` empty and the convergence carrying nothing. Rows 11 and 12 both pass. One wake for all five, since the drain merges — five before that change |
| 2026-08-26 | v2026.35.4, deployed | **cross-brand round 1 passes** | A `grok-4.5` parent, two `claude-sonnet-5` peers. **1 wake**, both peers' words under their own member lines, both shims printing the held-for-a-wait line, `reports/` and `waits/` empty after, `53318627` and `505` on disk. Covers what the Claude-only run could not: `cli/wait.ts` resolving a Grok session's own pid as `requesterPid`, and a convergence delivered through Grok's `tryDrain` — the drain the 2026-08-26 merge change rewrote. Incidentally cross-*window* too: `pickWindow` put the peers in another window while the parent stayed here, and the hold still fired, since it runs in the window owning the target's pipe |
| 2026-08-26 | v2026.35.4, deployed | **rounds 1-4 pass, round 5 partial** | Round 1: **1 wake** for two reporting peers, both sets of words under their own member lines, both shims printing the held-for-a-wait line. Round 2: message arrived, no wait mentioned. Round 3: two wakes in order, question alone then report on the convergence. Round 4: convergence arrived carrying one 9 000-char report with the other released as its own send — and the two reached the parent in **one** wake, since the drain now merges. Round 5: four parked reports rode the convergence as `1,2,3,4`; the fifth was refused by `PAIR_MAX`, because the round sent all five in one breath and the release is only reachable across a pair window — the round has since been rewritten, and row 11 says why. Rows 13-14 not checked |
| 2026-08-26 | v2026.35.3, deployed | **void — round 1 only, ordering trap** | The wait was registered over two idle peers and converged before the work was sent, so both reports took the ordinary path: **3 wakes**, convergence carrying nothing. Not a feature failure. The hold itself was then proven by hand against the same build — request on the wire carried `fromPid`, reply carried `heldForWait`, the shim printed the held-for-a-wait line, and the convergence rendered the parked words indented under their member line. The prompt above was rewritten off this run; rounds 2-5 never ran |
| 2026-08-26 | pre-feature build | **baseline** | **4 wakes** for two reporting peers, measured in this repo's main window before the hold existed. The number every row above is against |
