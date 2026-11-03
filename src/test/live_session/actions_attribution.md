# Live: a peer's message merges, and each message keeps its own author

## Purpose

When a message arrives while the target already has something queued, the drain
takes both in one turn — one wake reading everything held, rather than N wakes
reading one each. What must survive that merge is each author: the peer's words
under the peer, the human's under `you`, and neither under the other's name.

## Proves what `check` cannot

The outbox merge is a pure function and is tested; what each CLI does with the
prompt it produced is not, and cannot be. Since 2026-10-04 a merged delivery
goes on the wire as one content block per message (`segments` in `core/live.ts`)
and is recorded as one turn per message (`sentTurns` in
`core/coordination/send.ts`), so each message is unwrapped on its own words.
The probes that justified it are in `TASK_*_peer_message_blocks.md`; this is
the scenario that proves a real CLI still answers the merged prompt having read
every message, and that the dock files each under its author. A legacy record
written before that date still holds one joined turn, and `unwrapMessage`
refusing a body that carries a tag is still what keeps that turn from naming
the wrong sender.

## Cost

Two spawned sessions, ~5 turns. Two or three minutes, most of it waiting for a
turn to be long enough to queue behind. **One pass per brand** — Claude, Grok
and Codex.

## Preconditions

- Deployed build, every window reloaded.
- `squadron.orchestrators.enabled` on.
- The panel open — the decisive check is what the dock draws.

## Prompt

```
You are driving a live test of Squadron. Work only in /tmp/agentsview-probe.
Do not touch any repository, do not edit files elsewhere, do not run builds.

Step 1. Run ~/.squadron/bin/squadron-list and note your own pid (your row is
the one whose sessionId matches $CLAUDE_CODE_SESSION_ID). Call it PARENT.

Step 2. Spawn a target and immediately give it slow work, so it is busy when the
message lands:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand claude --name live-attribution-target \
    --prompt 'Live test target. Count slowly from 1 to 40, writing each number
    on its own line, one short sentence about each. Do not use any tool. Do not
    write any file.'

Note the pid — call it TARGET.

Step 3. Confirm it is busy:

  ~/.squadron/bin/squadron-list

Do not go on until TARGET reads busy.

Step 4. While it is still busy, send it a message:

  ~/.squadron/bin/squadron-send --pid TARGET \
    --text "PEER MESSAGE ONE: this came from another session."

Report the exact stdout. It should say the message is held.

Step 5. Ask the human to type this into that card's composer in the panel, and
wait for them to confirm they have:

  HUMAN MESSAGE: this one I typed myself.

Step 6. Wait until the list shows TARGET idle again. This may take a minute.

Step 7. Print every user and assistant turn in TARGET's transcript, in order.
For each user turn, say whether it holds the peer message, the human message, or
both, and quote the first 80 characters exactly.
```

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | The message was held, not refused | the session's report of step 4 | exit 0, stdout says `held, N in the outbox` |
| 2 | One delivery, both messages | the transcript printout | *PEER MESSAGE ONE* and *HUMAN MESSAGE* are two consecutive user turns, in the order they were queued, with one reply after both that shows the model read both |
| 3 | No envelope on screen | the dock | neither turn shows `<squadron-message` |
| 4 | **The regression:** each author kept | the dock | the peer's turn reads `peer` + 8 characters of PARENT's id; the human's reads `you` — never the human's words under PARENT, never the peer's under `you` |
| 5 | **Human:** a peer message that merges with nothing keeps its badge | the dock | send a second peer message to the now-idle target: it drains alone, and that turn reads `peer` + 8 characters of PARENT's id |
| 6 | **Human:** the arrows behave | prompt-nav | the arrows land on the human's turn and step over both peer turns |

Row 4 is the regression. If one turn holds both messages with tags visible, the
delivery went out joined — check `segments` in `core/live.ts` and the brand's
wire builder. If the reply answers only one message, the two drained apart and
a wall has come back — check `walls()` in `core/live.ts`.

## Variant worth running once a quarter

Repeat with **two** peer messages sent back to back in step 4 (from the same
session, before the human types anything), then a converged wait if one is
handy. Each must be its own turn: two `peer` turns and a `wait`, never one turn
holding every wrapper. Run it once per brand — Grok writes a prompt of several
blocks as one disk chunk each, and that is the path its record recovers from.

## Cleanup

```sh
~/.squadron/bin/squadron-end --pid <TARGET>
```

## Results

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-04 | — | all three | not yet run | Rows 2-4 and 6 rewritten for per-message blocks: the merged delivery is now one turn per message, each under its author. Every run below predates it and speaks to the joined turn. |
| 2026-09-02 | 2026.36.3 deployed | Codex | attribution confirmed, merge unrun | Partial, off the C6 acceptance run rather than off this scenario. A message sent Claude → Codex arrived in the Codex record as `[user] from=ba720ec7-…` with the wrapper stripped — so `delivered()` reaches this brand correctly through `linesForItem`. What is **not** covered is the merge: nothing kept the Codex peer busy long enough for two sends to queue together, which is the half this file exists for. |
| 2026-08-22 | 2026.34.16 deployed | Claude | 1-5 pass; 6-7 unchecked | Ran the **variant** (two peer messages back to back), not the human-typed flow. Target on `--model sonnet`. First attempt did not test the merge at all — sonnet finished 1-40 in ~10s and the two sends drained one at a time (`held, 1` twice). Needed a 300-item list to keep it busy; then both queued together (`held, 2 in the outbox`) and drained as **two separate user turns, one wrapper each**. Greedy-match regression is not back. Note for the scenario: state the busy-work has to outlast two sends, or the run passes without entering the merge. |
| 2026-08-26 | — | Claude | not yet run | Row numbering and expectations rewritten for the dropped wall: the peer message now merges, and what is checked is that the merged turn is attributed to nobody. The 2026-08-22 run above passed the *old* rows 2-3 (two separate turns) and is superseded — it does not speak to the rows above it. |
