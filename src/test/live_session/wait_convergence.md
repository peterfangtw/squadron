# Live: a fan-out converges once

## Purpose

A session registers `squadron-wait` over two peers, ends its turn, and is
woken **exactly once** by one message naming both — whatever brand each peer is
and whichever window owns it.

## Proves what `check` cannot

Three claims, and no test in the suite can reach any of them.

**The resolver imports `vscode`.** `src/host/waits.ts` is the whole of the
feature's delivery — the triggers, the board, the send, the deadline — and it is
`vscode`-bound, so `npm run check` never executes a line of it. What the suite
proves is `core/coordination/wait.ts`'s predicate against a board a test wrote.

**"Idle is not enough" is only real against a real process table.**
`hasCommand` is set by `core/discover.ts` from the process table, never off a
frame, and `core/live.ts` writes `false` for every session it builds. A resolver
that reads the unfolded records instead of the folded board has that term
silently always-true, and **shipped that way** until review caught it — every
unit test green, because every unit test hands the predicate a board with the
flag already set. Only a peer that really backgrounds a command proves the fold
is there. That is round 2, and it is the regression this scenario exists for.

**The two channels are only distinguishable with two real windows.**
`onOwnedChange` fires off the frame for a member this window drives;
`watch.ts` deliberately drops those pids and carries only other windows'
publishes. Subscribing to one of them looks correct and resolves half the cases.

## Cost

Two spawned sessions, one per brand, ~12 turns across three rounds. **Needs a
signed-in Grok account.** Four to six minutes. Rounds 2 and 3 reuse the peers
from round 1 — do not re-spawn.

## Preconditions

- **An Extension Development Host on this worktree**, not a deployed build.
  `squadron-wait` exists only here; `npm run deploy` would ship it, but the
  point of this scenario is to run it before that. Launch with:

  ```sh
  cd /Users/me/src/squadron/.worktrees/cross_session_verbs
  npm run compile
  env -u ELECTRON_RUN_AS_NODE -u CLAUDE_CODE_CHILD_SESSION \
      -u VSCODE_PID -u VSCODE_CWD -u VSCODE_IPC_HOOK -u VSCODE_IPC_HOOK_CLI -u VSCODE_NLS_CONFIG \
    "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
    --extensionDevelopmentPath="$PWD" -n "$PWD"
  ```

  The `env -u` block is load-bearing: a leaked `ELECTRON_RUN_AS_NODE` makes the
  IDE binary run as node and reject its own flags. (`CLAUDE_CODE_CHILD_SESSION`
  used to hide the host's terminal sessions, which the board no longer draws.)

- **The driving session must be one the panel started.** Use the board's `+`, or
  spawn it. A session you typed `claude` for in a terminal has no pipe, and
  `squadron-wait` will refuse it — correctly, and that refusal is validation
  row 8 rather than a failed run.
- `squadron.orchestrators.enabled` on. Panel open. `/tmp/agentsview-probe`
  exists.
- **The EDH's shims are machine-wide.** Activating it rewrites
  `~/.squadron/bin/` from this worktree, so every window's sessions get these
  shims until the deployed extension next activates and puts its own back.

## Prompt

```
You are driving a live test of Squadron's wait verb. Work only in
/tmp/agentsview-probe. Do not touch any repository, do not edit files anywhere
else, do not run builds. Report what you observe; do not fix anything.

Step 0. Confirm the host under test is the dev one:

  ls ~/.squadron/bin/squadron-wait

If that file is missing, stop and say so — the Extension Development Host has
not activated, and nothing below will work.

Step 1. ~/.squadron/bin/squadron-list — note your own pid as PARENT.

Step 2. Spawn one peer of each brand. Each gets a question and is told to write
its answer to a file and then stop, WITHOUT messaging anybody:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand claude --name live-wait-claude \
    --prompt 'Compute 7919 * 6733. Then take the digit sum of that result, repeatedly, until one digit is left. Write exactly two lines to /tmp/agentsview-probe/answer-claude.txt: the product, then the single digit. Then stop. For this turn: run no other command, and message nobody. A later message from the session that spawned you is authorised — do what it asks.'

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand grok --name live-wait-grok \
    --prompt 'How many trailing zeros does 2026 factorial have? Write just that number to /tmp/agentsview-probe/answer-grok.txt. Then stop. For this turn: run no other command, and message nobody. A later message from the session that spawned you is authorised — do what it asks.'

Note both pids as CLAUDE_PID and GROK_PID.

Step 3. Record which window each peer landed in — the routing is by cwd, and
/tmp/agentsview-probe matches no window's folder, so either window may own them:

  cat ~/.squadron/live/CLAUDE_PID.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["session"]["windowId"])'
  cat ~/.squadron/live/GROK_PID.json   | python3 -c 'import json,sys; print(json.load(sys.stdin)["session"]["windowId"])'

Say whether those match each other and whether they match your own window. Do
not try to change it — which channel resolves the wait depends on this, and
either answer is a valid run.

Step 4. ROUND 1 — the convergence. Register one wait over both peers:

  ~/.squadron/bin/squadron-wait --pids CLAUDE_PID,GROK_PID

Quote its exact output and its exit code. Then END YOUR TURN IMMEDIATELY. Do
not poll, do not run squadron-list to check, do not sleep. Say only:
"registered, waiting" and stop talking.

Step 5. You will be woken by a message. When you are, do all of this in one
turn:
  - Quote the message you were woken by, in full and verbatim.
  - Say how many separate times you were woken since step 4. The answer must be
    one. If it was more, say so loudly — that is the failure this feature exists
    to prevent.
  - cat /tmp/agentsview-probe/answer-claude.txt
  - cat /tmp/agentsview-probe/answer-grok.txt
  - ls ~/.squadron/waits/     (expect it to be empty)
  - Print the newest file in ~/.squadron/actions/ whose "kind" is "wait".

Step 6. ROUND 2 — idle is not enough. Send the Claude peer a command to run in
its OWN background mode — the Bash tool's run_in_background, not a shell
trailing `&`, which does not produce the state this round is about:

  ~/.squadron/bin/squadron-send --pid CLAUDE_PID \
    --text "Run exactly this, in the background, and end your turn straight away without waiting for it: sleep 75 > /tmp/agentsview-probe/slept.txt 2>&1 . Use your Bash tool's background mode, not a trailing ampersand. Run nothing else."

Wait about ten seconds, then — before registering anything — quote that peer's
row:

  ~/.squadron/bin/squadron-list

This list is the only place row 10's state can be seen. The peer has ended its
turn and the sleep is still going, which is the ten seconds the round is about;
once the wait wakes you the sleep is over and the flag has already dropped.
Read hasCommand from this row and from nowhere else — ~/.squadron/live/*.json
says false for every session whatever it is doing, because the panel folds the
real value in and the file does not carry it.

Now register a wait over that peer alone:

  ~/.squadron/bin/squadron-wait --pids CLAUDE_PID

End your turn. When you are woken, say how long it took from registering, and
run ~/.squadron/bin/squadron-list once more — that second row is for the
duration, not the flag.

Step 7. ROUND 3 — a member that stops existing. The peer has to still be working
when it goes, so give it something long to do first:

  ~/.squadron/bin/squadron-send --pid GROK_PID \
    --text "Run exactly this and wait for it to finish, then report the exit code: sleep 120"

Give it about ten seconds to get going and confirm it reads busy:

  ~/.squadron/bin/squadron-list

Then register a wait over it and stop it:

  ~/.squadron/bin/squadron-wait --pids GROK_PID
  ~/.squadron/bin/squadron-end --pid GROK_PID

End your turn. When woken, quote the message verbatim.

Step 8. Report the three rounds as a table: what you registered, how long until
you were woken, how many times, and what the message said.
```

## Two ways this run passes without testing anything

Both were live: the first run of this scenario hit them, and the steps above are
worded the way they are because of it.

**A shell trailing `&` leaves `hasCommand` false.** The flag is
`shellParents.has(pid) || status === 'shell'` (`core/claude/discover.ts`), and
`shellParents` holds pids with a live *shell* child. `zsh -c 'sleep 75 &'` forks
and exits at once — the sleep reparents away from the session, so the first term
is false within a second, and only the CLI's own background mode writes the
`shell` word the second term reads. Round 2 over such a peer wakes on the turn
ending, which is indistinguishable from the regression it is looking for.

**A member that is already idle makes round 3 a no-op.** The wait is satisfiable
at the instant of registration, so it resolves `finished` before the stop lands
and the run reports a pass for a code path it never entered. The member has to
be *unfinished* when it is killed, which is what step 7's `sleep 120` buys.

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | Registration does not block | step 4 output | returns immediately, exit 0, and the sentence tells the session to end its turn |
| 2 | **One** wake for two peers | step 5 | the driver reports being woken once. Two wakes is the whole feature failing |
| 3 | The message names both members | the woken turn | both pids, each with an outcome word — `finished`, `stopped without finishing`, or `never reported` |
| 4 | **Human:** the dock draws the author | driver's card, dock | the turn's author row reads **`wait`** — not `you`, not `peer`, not the model's name — and carries **no 8-character id crumb** |
| 5 | **Human:** the body is not empty | same turn | the resolution's prose is under the label. An empty body means a turn with `text` and no `blocks` |
| 6 | The answers are right | step 5 `cat`s | Claude: `53318627` then `8`. Grok: `505` |
| 7 | The record is cleaned up and counted | `~/.squadron/waits/`, `~/.squadron/actions/` | `waits/` empty; one `actions/` row with `"kind":"wait"` whose `from` is a **window** id, not any session's |
| 8 | A driver with no pipe is refused, not hung | only if you drove from a typed `claude` | exit 2, "started by hand … no pipe to be woken on". Silence here is the bug review caught: the record would be claimed by no window and swept at a day |
| 9 | **Round 2 — idle is not enough** | step 6 timing | the wake comes **after** the 75s sleep ends, not when the peer's turn ended ~70s earlier. Woken early means the board is unfolded again and `hasCommand` is always false |
| 10 | Round 2's row agrees | step 6's **first** `squadron-list`, before the wait is registered | that peer reads `idle` with `hasCommand: true` while the sleep runs — the state the predicate must refuse. The list after the wake is too late to show it: row 9 passing means the sleep has already ended |
| 11 | **Round 3 — a dead member resolves it** | step 7 | woken within seconds of the stop, the message says that pid **stopped without finishing** rather than hanging until the 54-minute deadline, and its first line does not claim it finished. The peer must have read `busy` when it was stopped — see above |
| 12 | Which channel fired | step 3 window ids | if the peers share the driver's window, `onOwnedChange` carried it; if not, `watch.ts`'s published channel did. Record which — a run that only ever exercises one has not tested the other |
| 13 | **Human:** the resolution is drawn **once** | driver's card, dock, from the wake until the woken turn ends | exactly one turn carries the resolution's prose. A second copy below the tools of the turn it woke, authored `you` with `<squadron-wait>` visible in it, is the outbox echo failing to retire — 2026-08-22. Rows 4 and 5 read the good copy and pass either way, which is why this is a row of its own |

Row 9 is the one to run this for. Rows 4 and 5 only a person looking at the
panel can take.

## Cleanup

```sh
~/.squadron/bin/squadron-end --pid <CLAUDE_PID>
~/.squadron/bin/squadron-end --pid <GROK_PID>
rm -f /tmp/agentsview-probe/answer-claude.txt /tmp/agentsview-probe/answer-grok.txt \
      /tmp/agentsview-probe/slept.txt
rm -f ~/.squadron/waits/*.json
```

Close the Extension Development Host window. The deployed extension rewrites
`~/.squadron/bin/` on its next activation, which removes `squadron-wait`
again until this branch ships.

## Results

| Date | Build | Result | Notes |
| --- | --- | --- | --- |
| 2026-08-21 | EDH on 4f8e91f | 11 of 12; row 8 N/A (the driver had a pipe) | Row 9 held 126s and woke 8s after the sleep exited — the fold is there. Rows 4 and 5 confirmed by a person at the panel. All three sessions shared one window, so `onOwnedChange` carried it and **`watch.ts`'s published channel is still untested** (row 12). Rounds 2 and 3 were run again by hand, against the two traps above, which the steps did not avoid at the time |
| 2026-08-22 | 2026.34.16 **deployed** (not an EDH — `squadron-wait` ships now) | 1-7, 9, 10 pass; 8 N/A; **11 partial**; 12 unchanged | Peers on `--model sonnet` / Grok default; sonnet got `53318627`/`8` and `505` right. Round 1 woke once, 13s. Row 10 captured first try — `"status":"idle","hasCommand":true` while the background sleep ran. Row 9 held **73s**, so the fold is there. All three sessions shared one window again, so row 12's published channel is **still untested**. **Row 11 partial — the wording is right, the latency is not.** Step 7 is unrunnable as written: `agentsview-stop` refuses a busy session (`may only be stopped once it is idle`, exit 2, no `--force`), and that guard landed 2026-08-18, before this file's last edit. Killed the pid instead. The resolution when it came was correct — `Not all of them finished` / `27523: stopped without finishing`, `waits/` emptied, record written — but it took **339s**, against a row that wants seconds. At t+146s the member was off the board, its process dead, its `live/27523.json` stale on disk, and the wait still armed. It resolved only after I stopped five unrelated probe sessions, which is consistent with (not proof of) an event-driven resolver: a killed session emits no final frame, so nothing re-evaluates until some other board change does it. Worth a unit-level look at what re-runs the predicate. **Second defect (row 13, added after this run):** a resolved wait is drawn **twice** — once correctly as `WAIT`, then again as `YOU` with the raw `<squadron-wait>` tag visible. Read at the time as the CLI's own `user` turn reaching the dock beside ours; it is not, and both records were innocent. It is the **outbox echo**: delivery is `messages.send(wrapWait(...))`, so `LiveState.inFlight` holds the wire text, and `stillSending` matched it raw against a turn both records file unwrapped and under `role: wait` — so it never retired and sat there until the turn ended. Rows 4-5 pass on the good copy. Fixed at the seam: `core/send.ts`'s `delivered`, applied to the outbox in `ui/views.ts`. |
