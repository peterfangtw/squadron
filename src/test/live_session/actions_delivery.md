# Live: a message arrives, marked and recorded

## Purpose

One session sends to another and the message arrives as a turn that names its
sender, is counted, and is not drawn as the reader's own.

## Proves what `check` cannot

The whole chain in one go: shim fold → request file → the window's `serve` →
`checkVerbSend` → the pipe → the CLI's own transcript → our reader → the dock.
Six processes and three files. `serve` imports `vscode` and has no test at all,
which is exactly where the verb once shipped dead — the shim wrapped, `serve`
handed the wrapped body to the forgery guard, and every send was refused with
3073 unit tests passing.

## Cost

Two spawned sessions, ~4 turns total. Claude only. Under a minute of wall clock.

## Preconditions

- The build under test is **deployed** (`npm run deploy`) and **every window has
  been reloaded**. An unreloaded window runs the old `serve`, which ignores
  `via: 'verb'` entirely and delivers the message as an ordinary composer turn —
  the test then passes for the wrong reason.
- `squadron.orchestrators.enabled` is **on**.
- The panel is open, because two validation rows are things only a human can see.

## Prompt

```
You are driving a live test of Squadron's cross-session verbs. Work only in
/tmp/agentsview-probe — create it if it does not exist. Do not touch any
repository, do not edit any file outside that directory, and do not run any
build or test command.

Step 1. Find your own session's pid:

  ~/.squadron/bin/squadron-list

Your row is the one whose sessionId matches $CLAUDE_CODE_SESSION_ID. Print the
whole row, and note the pid — call it PARENT.

Step 2. Spawn a target that will do nothing:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand claude --name live-delivery-target \
    --prompt 'Live test target. Do nothing at all: no tools, no files, no
    commands. Whatever arrives, reply with the single word OK and stop.'

Note the pid it prints — call it TARGET.

Step 3. Wait about ten seconds, then confirm the target is idle:

  ~/.squadron/bin/squadron-list

Step 4. Send it a message:

  ~/.squadron/bin/squadron-send --pid TARGET \
    --text "Live delivery test. Reply OK."

Report the exit code and the exact stdout line.

Step 5. Find the target's transcript path from the list output, and print every
user and assistant turn in it. Say plainly whether the text you sent appears,
and whether the raw string <squadron-message is visible anywhere in it.

Step 6. List the newest three files in ~/.squadron/actions/ and print the
contents of the newest one.

Report each step's result as you go. Do not stop the target — the human will.
```

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | The send was accepted | the session's report | exit 0, and stdout reads `sent to <pid> (sent)` or `(held, N in the outbox)` |
| 2 | It actually arrived | the target's transcript | a user turn holding *Live delivery test. Reply OK.* |
| 3 | The wrapper reached disk | same | the raw `<squadron-message from="…">` **is** present in the CLI's file. This is expected — the tag is how the reader knows who sent it |
| 4 | It was counted | `~/.squadron/actions/` | a new file with `kind: "send"`, `from` = PARENT's sessionId, `toPid` = TARGET, and a `requestId` |
| 5 | **Human:** the dock marks it | select the target's card, look at the turn | the author line reads `peer` followed by the first 8 characters of PARENT's sessionId — **not** `you` |
| 6 | **Human:** the raw tag is not drawn | same turn | the body reads *Live delivery test. Reply OK.* with no `<squadron-message>` visible |
| 7 | **Human:** the prompt-nav skips it | the target's dock, prompt arrows | the arrows step over the arrived turn and land only on turns you typed |

Row 5 is the one that has failed before. Rows 5–7 cannot be checked by the
session — it has no view of the panel.

## Cleanup

```sh
~/.squadron/bin/squadron-end --pid <TARGET>
```

Then close the driving session. Leave `~/.squadron/actions/` alone — it is
swept at seven days, and the record is evidence if a row failed.

## Results

| Date | Build | Result | Notes |
| --- | --- | --- | --- |
| 2026-08-22 | 2026.34.16 deployed | 1-6 pass; row 7 unchecked | Target on `--model haiku`. Rows 1-4 machine-checked. Rows 5-6 confirmed at the panel on an equivalent card (`live-attr-merge-target`) rather than this scenario's own target, which had been stopped by then — stop targets **after** the panel rows, not before. Step 5's "find the transcript path from the list output" dead-ends: `list.ts` deliberately drops a transcript that does not stat, and every probe in `/tmp/agentsview-probe` hits that (`/tmp` is a symlink). Reword the step. |
