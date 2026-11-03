# Live: a turn draws what the tree says it wrote

## Purpose

A turn that writes only by shell draws a pill per file with real counts, and
where a neighbour was writing the same file it draws neither the pill nor a
guess — it says **list may be short**.

## Proves what `check` cannot

The chain is five processes agreeing about a tree none of them owns alone, and
no unit test can hold more than one end of it: the extension host captures a
`write-tree` before it releases the turn → the CLI's child writes by `sed`,
heredoc and redirect, naming none of it in any frame → the host captures again
at the idle edge and diffs → a line lands in `~/.squadron/checkpoints/` → a
*different window's* dock reads that line and subtracts.

`checkpoint.test.ts` drives `capture`/`changesBetween`/`attribute` against a
real temp repo, so the rules have tests. What has none:

- **Rule 1's ordering.** The baseline has to win the race against the turn's
  first write. A capture that lands late puts that write in its own baseline and
  subtracts it back out — the pill silently disappears and every test still
  passes. Only a real CLI child writing at real speed can lose that race.
- **The store as a multi-writer file.** `appendWindow` is `O_APPEND` from two
  extension hosts at once; the unit suite writes it from one process.
- **The gate at read time.** `attribute` runs when the dock builds the thread,
  against whatever neighbours have finished writing by then. Nothing but two
  live sessions produces a real overlap.
- **Everything past `TurnChanges`.** `core/claude/session.ts:796` folds the
  diff onto the record chain, `webview/chat.ts:363` draws the row, and both
  ends of that are `vscode`-side.

**This scenario is Claude-only, and that is the finding, not an omission.**
`TurnCheckpoints` is constructed in `core/claude/session.ts` and nowhere else,
so a Grok or Codex card draws no checkpoint pill from any tool — and a Grok
neighbour writes no window line, so it is invisible to the subtraction the same
way a terminal session is. Do not "fix" this run by swapping the brand; record
it and see `TASK_done_write_pill_coverage_claude.md`'s *Non-Claude brands*.

## Cost

Five spawned peers plus the driver, one turn each, ~2 min of wall clock. Part B
adds one more peer and one send. Peer 5 is marked optional below — dropping it
costs the not-a-repo row and nothing else.

No sends in Part A, so the pair cap does not apply and it is safe to re-run
immediately. Part B sends once.

## Preconditions

- The build under test is **deployed** (`npm run deploy`) and **every window
  reloaded**. The feature merged at `7414070`; an unreloaded host draws no
  checkpoint pills at all and every row fails for the wrong reason.
- `squadron.orchestrators.enabled` is **on** — the driver spawns peers.
- The panel is **open**. Every row but the last two is something only a person
  looking at the dock can check; the sessions cannot see the panel.
- **Run the setup block below first.** The probe trees have to be repositories
  before anything is spawned into them, because a session's first baseline is
  taken when it starts.

```sh
rm -rf /private/tmp/agentsview-ckpt-{probe,head,commit,plain}
mkdir -p /private/tmp/agentsview-ckpt-{probe,head,commit,plain}/ignored
for d in probe head commit; do
  r=/private/tmp/agentsview-ckpt-$d
  printf 'ignored/\n' > $r/.gitignore
  printf 'one\ntwo\nthree\n' > $r/seed.txt
  git -C $r init -q
  git -C $r add -A
  git -C $r -c user.email=probe@local -c user.name=probe commit -qm seed
  printf 'four\n' >> $r/seed.txt
  git -C $r add -A
  git -C $r -c user.email=probe@local -c user.name=probe commit -qm second
done
git -C /private/tmp/agentsview-ckpt-head log --oneline   # must print two commits
```

Spelled out rather than aliased because the human shell here is **zsh**, which
does not word-split an unquoted `$GIT_WITH_FLAGS` the way bash does — an alias
variable fails with `command not found: git -c ...` and leaves the repos with no
commits, which reads downstream as rule 3 withholding.

`/private/tmp/agentsview-ckpt-plain` stays a plain directory on purpose — that
is peer 5's whole case.

**Canonical paths, and never `/tmp`.** `/tmp` is a symlink to `/private/tmp` on
macOS, and `locate()` (`core/git.ts:213`) walks up with `path.dirname` and never
resolves one — so `/tmp/x` and `/private/tmp/x` are two different `treeRoot`s
for one tree. A session spawned with the symlinked spelling baselines against
`/tmp/x`, the CLI's `init` then settles `live.cwd` to the realpath, and at the
turn's end `close()` compares the two spellings, finds them different and
returns before it captures (`core/checkpoint.ts:828`). That first turn silently
draws no checkpoint pill; every turn after it is fine, because both ends are
canonical by then. Measured 2026-08-24 — a `/tmp` spawn drew nothing, and a
`/private/tmp` spawn of the same tree with the same shell-only write drew
`iota.txt`. It is a real if narrow product defect (*Not the scenario's bug*
below); here it is a precondition, because a scenario that trips it tests
nothing.

## Prompt

Paste into a fresh **Claude** session whose cwd is
`/private/tmp/agentsview-ckpt-probe`, or spawn one there:

```sh
~/.squadron/bin/squadron-spawn --cwd /private/tmp/agentsview-ckpt-probe \
  --brand claude --model sonnet --name live-ckpt-driver --prompt '<the block below>'
```

```
You are driving a live test of how Squadron attributes a turn's file writes.
Everything happens under /private/tmp/agentsview-ckpt-*. Do not touch any repository
outside /tmp, do not edit any file outside those four directories, and do not
run any build, test, lint or format command. Do this all in one turn — the turn
boundary is what is being measured, so do not stop to ask anything.

This machine is macOS: in-place sed is `sed -i '' ...` with the empty argument.

Step 1 — write four files, three of them by shell, and print what you did.

  cat > /private/tmp/agentsview-ckpt-probe/alpha.py <<'EOF'
  def blorp(n):
      return [n * i for i in range(12)]
  EOF

  printf 'gibberish one\ngibberish two\n' > /private/tmp/agentsview-ckpt-probe/beta.txt
  sed -i '' 's/two/TWO/' /private/tmp/agentsview-ckpt-probe/seed.txt
  printf 'not tracked\n' > /private/tmp/agentsview-ckpt-probe/ignored/secret.txt

Then use your **Write tool** — not the shell — to create
/private/tmp/agentsview-ckpt-probe/gamma.md with three lines of any nonsense.

Print `wc -l` for alpha.py, beta.txt, seed.txt and gamma.md.

Step 2 — spawn the contested pair. Both write the SAME file, and the waits are
there so the two turns are still running at the same time. Never `sleep`: this
harness blocks a foreground `sleep`, the model re-runs it with
`run_in_background`, and **a backgrounded wait ends the turn**. Measured
2026-08-24 — a peer told to `sleep` split into three turns, wrote its files in
the second, and checkpointed none of them. `python3 -c 'import time; time.sleep(n)'` is not `sleep`, runs in the foreground, and holds the turn open.
Run these two commands one after the other with no gap:

  ~/.squadron/bin/squadron-spawn --cwd /private/tmp/agentsview-ckpt-probe \
    --brand claude --model sonnet --name live-ckpt-p1 \
    --prompt "Do exactly this in one turn, nothing else. Run: python3 -c 'import time; time.sleep(20)'. Then
    append a line to /private/tmp/agentsview-ckpt-probe/shared.txt with a heredoc:
    cat >> /private/tmp/agentsview-ckpt-probe/shared.txt <<EOF
    p1 was here
    EOF
    Then: printf 'p1 only\n' > /private/tmp/agentsview-ckpt-probe/p1.txt
    Then run: python3 -c 'import time; time.sleep(25)'. Then reply with the word done. Do not read or write
    anything else, and do not run git."

  ~/.squadron/bin/squadron-spawn --cwd /private/tmp/agentsview-ckpt-probe \
    --brand claude --model sonnet --name live-ckpt-p2 \
    --prompt "Do exactly this in one turn, nothing else. Run: python3 -c 'import time; time.sleep(25)'. Then
    append a line to /private/tmp/agentsview-ckpt-probe/shared.txt with a heredoc:
    cat >> /private/tmp/agentsview-ckpt-probe/shared.txt <<EOF
    p2 was here
    EOF
    Then: printf 'p2 only\n' > /private/tmp/agentsview-ckpt-probe/p2.txt
    Then run: python3 -c 'import time; time.sleep(20)'. Then reply with the word done. Do not read or write
    anything else, and do not run git."

Step 3 — spawn the peer that moves HEAD, in its own repository so it disturbs
nobody:

  ~/.squadron/bin/squadron-spawn --cwd /private/tmp/agentsview-ckpt-head \
    --brand claude --model sonnet --name live-ckpt-head \
    --prompt "Do exactly this in one turn, nothing else. First:
    printf 'delta gibberish\n' > /private/tmp/agentsview-ckpt-head/delta.txt
    Then run: git -C /private/tmp/agentsview-ckpt-head reset --soft HEAD~1
    Then reply with the word done."

Step 4 — spawn the peer that commits, also in its own repository:

  ~/.squadron/bin/squadron-spawn --cwd /private/tmp/agentsview-ckpt-commit \
    --brand claude --model sonnet --name live-ckpt-commit \
    --prompt "Do exactly this in one turn, nothing else. First:
    printf 'epsilon gibberish\nsecond line\n' > /private/tmp/agentsview-ckpt-commit/epsilon.txt
    Then run: git -C /private/tmp/agentsview-ckpt-commit add -A && git -C
    /private/tmp/agentsview-ckpt-commit -c user.email=probe@local -c user.name=probe
    commit -qm probe
    Then reply with the word done."

Step 5 — print the pid and name of every peer you spawned, one per line, so the
human can find the cards and stop them later. Then stop. Do not wait for them,
do not message them, and do not stop them yourself.
```

**Four spawns and no more, which is why peer 5 is not in the prompt** — and the
budget is shared with you, which is the part that bites. `BURST_MAX` is 5 spawns per
minute (`core/coordination/guards.ts`), and on 2026-08-24 two spawns issued from the shell
moments earlier ate it: the driver's fourth peer was refused with *5 sessions
were spawned in the last minute; the limit is 5*, and the commit case silently
never ran. So spawn the not-a-repository peer **after** the driver reports its
peers, not before — or wait the minute out:

```sh
~/.squadron/bin/squadron-spawn --cwd /private/tmp/agentsview-ckpt-plain \
  --brand claude --model sonnet --name live-ckpt-plain \
  --prompt 'Do exactly this in one turn, nothing else. Run: printf "zeta gibberish\n" > /private/tmp/agentsview-ckpt-plain/zeta.txt   Then reply with the word done.'
```


The prompt is that prescriptive on purpose. A model left to choose reaches for
its Write tool, and a Write tool call draws a pill through the frame path that
has worked since `TASK_done_change_size.md` — so a vague instruction passes this
scenario without testing any of it.

## Validation

Read the driver's report for the `wc -l` numbers, then select each card and read
the pill row at the end of its assistant turn. Rows 1–15 can be settled from the
transcripts and the window files; **16 and 17 need a person at the panel**,
because a click is the whole of what they check.

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | A heredoc write draws a pill | driver card, its turn | a pill named `alpha.py` |
| 2 | A redirect write draws a pill | same | a pill named `beta.txt` |
| 3 | An in-place `sed` draws a pill | same | a pill named `seed.txt`, counts `+1 −1` |
| 4 | The frame path still works | same | a pill named `gamma.md` |
| 5 | Counts come off the tree | same | `alpha.py` reads `+N −0` where N is the `wc -l` the driver printed |
| 6 | A `.gitignore`d write stays invisible | same | **no** pill for `secret.txt` — the named blind spot, not a bug |
| 7 | No marker where nothing was taken | same | **no** "list may be short" under the driver's turn |
| 8 | A contested path is omitted | `live-ckpt-p1` card | **no** `shared.txt` pill |
| 9 | …on both sides of the contest | `live-ckpt-p2` card | **no** `shared.txt` pill |
| 10 | The marker draws instead | both p1 and p2 | "list may be short" at the end of the pill row, on both |
| 11 | Its tooltip names the reason | hover the marker | "Another session was writing in this folder while this ran…" |
| 12 | Nothing survives a real contest | p1, then p2 | **no pills on either**, only the marker — see *A tree window is a union* below. `p1.txt` on p1's card is a **fail**, not a pass |
| 13 | Rule 3: HEAD moved, so withhold | `live-ckpt-head` card | **no** pills at all, and **no** marker — a rewrite is silence, not a subtraction |
| 14 | Rule 3: a commit is not a rewrite | `live-ckpt-commit` card | `epsilon.txt` still draws, `+2 −0` |
| 15 | Not a repository, so silence | `live-ckpt-plain` card | no pills. Skip if step 5 was skipped |
| 16 | The counts open a diff | click the counts on `alpha.py` | a diff editor, empty left side |
| 17 | The pill opens the file | click the body of `beta.txt` | that file in an editor tab |

### A tree window is a union, so a real contest takes everything

Rule 2 is written per path — *a contested path is omitted and the rest still
draw* — and on frame-named writes that is what it does. It does not survive the
mechanism that shipped. A window is a **tree diff**, so a turn sees every change
the tree took while it ran, its neighbour's included: measured 2026-08-24, two
peers writing one shared file plus one private file each produced two windows
naming *the same three paths*, `q1.txt`, `q2.txt` and `shared2.txt`, differing
by 0.4s in start.

```
31f7fe91  56.6s  ['q1.txt', 'q2.txt', 'shared2.txt']
d114fe9f  56.0s  ['q1.txt', 'q2.txt', 'shared2.txt']
```

Subtraction is then total in both directions, and both turns draw no pill and
the marker. That is the honest answer — a missing pill beats one naming a file
the turn never wrote — but it is a stronger claim than the plan's, and it means
*What shipped* in `TASK_done_write_pill_coverage_claude.md` needs a line: when a
neighbour genuinely writes inside your window there is no *rest* to draw. The
per-path refinement still earns its place, on the far commoner case where the
windows overlap but the writes do not — the driver's turn here overlapped both
peers and kept all four of its pills, because neither peer wrote until after it
had finished.

**If rows 8–12 fail, check the overlap before filing anything.** The two turns
have to have been running at the same time, and a peer that answered instantly
never contested anything:

```sh
cat ~/.squadron/checkpoints/agentsview-ckpt-probe-*.jsonl | python3 -m json.tool --json-lines
```

Two lines whose `start`/`end` intervals intersect and whose `paths` both hold
`shared.txt` is what rows 8–12 are reading. If they do not intersect, the sleeps
lost to a fast model — re-run with larger ones rather than recording a fail.

### Not the scenario's bug

The symlink under *Preconditions* is a product defect rather than a scenario
one, and is filed as **H90**.

## Part B — an interrupted turn keeps what it wrote

One more peer and one send. Rule 1 cuts an end capture at the `running` edge,
which an interrupt reaches, so a turn stopped halfway should still draw the
files it had written by then.

```sh
~/.squadron/bin/squadron-spawn --cwd /private/tmp/agentsview-ckpt-probe \
  --brand claude --model sonnet --name live-ckpt-cut \
  --prompt "Do exactly this in one turn, nothing else. First: printf 'cut me\n' > /private/tmp/agentsview-ckpt-probe/eta.txt
  Then run: sleep 120. Then reply with the word done."
```

Wait until the card shows the write has happened, then cut it:

```sh
~/.squadron/bin/squadron-send --pid <CUT> --interrupt --text 'stop and say nothing else'
```

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| B1 | The cut turn draws its write | `live-ckpt-cut` card, the interrupted turn | a pill named `eta.txt` |
| B2 | The interrupt did not strand the baseline | the same card's next turn | the next turn draws only what *it* wrote, not `eta.txt` again |

## Cleanup

Stop the peers **after** the panel rows — a stopped card cannot be inspected.

```sh
for p in <P1> <P2> <HEAD> <COMMIT> <PLAIN> <CUT> <DRIVER>; do
  ~/.squadron/bin/squadron-end --pid $p
done
rm -rf /private/tmp/agentsview-ckpt-{probe,head,commit,plain}
rm -f ~/.squadron/checkpoints/agentsview-ckpt-*.jsonl
```

The last line matters on a re-run: a stale window file from an earlier run names
`shared.txt` with old timestamps, and while `attribute` only subtracts on real
overlap, a leftover file makes the diagnostic above unreadable.

## Results

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-08-24 | 2026.34.20 deployed | Claude `sonnet` | **void — the scenario's own paths were wrong** | First run used `/tmp/agentsview-ckpt-*`. All five peers drew nothing, which read as a broken feature; it was the symlink under *Preconditions*. Re-run below |
| 2026-08-24 | 2026.34.20 deployed | Claude `sonnet` | the symlink, isolated | Two spawns, one tree, one shell-only write each, differing only in the spelling of `--cwd`. `/tmp/…` first turn: no `ck` note, no window line. `/private/tmp/…` first turn: a `ck` note naming `iota.txt`. A spawned session's first turn checkpoints fine; the path spelling was the whole of it |
| 2026-08-24 | 2026.34.20 deployed | Claude `sonnet` | rows 1–6 pass, 13–15 pass, 8–12 re-run, 7 fails, 16–17 unchecked | Canonical re-run. Driver window is exactly `alpha.py, beta.txt, gamma.md, seed.txt` with `ignored/secret.txt` absent — heredoc, redirect, `sed -i` and the frame path all land, and `.gitignore` holds. Rule 3 both ways: `head` carries `"moves":["reset"]` with the shas apart → silence; `commit` carries `"moves":["commit"]` and keeps `epsilon.txt`. The plain directory produced no window file at all. Rows 16–17 need a person at the panel |
| 2026-08-24 | 2026.34.20 deployed | Claude `sonnet` | **row 7 fails, and it is a real defect** | p1's window claims `p1.txt, p2.txt, shared.txt` — two of them p2's writes — with **no** marker, because p2's only window is empty and there was nothing to subtract. p2 had been told to `sleep`; the harness backgrounded it, that ended its turn, and the turn that actually wrote both files produced no `ck` note and no window line at all. So a turn that goes uncheckpointed does not merely lose its own pills: its writes are absorbed by whichever neighbour was running, silently and with no marker. Fixed the scenario's waits; the defect stands |
| 2026-08-24 | 2026.34.20 deployed | Claude `sonnet` | **Part B not run** | B1 and B2 were never reached; the run ended after Part A. The interrupted turn is the one item of the task's Step 9 carrying no evidence |
| 2026-08-24 | 2026.34.20 deployed | Claude `sonnet` | rows 8–11 pass, row 12 was wrong | Contested pair re-run as `q1`/`q2` with foreground `python3 -c 'import time; time.sleep(n)'`. Both stayed in one turn, both windows named all three paths, so subtraction is total both ways: no pills, marker on both. Row 12 rewritten — see *A tree window is a union* |
