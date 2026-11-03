# Live: every direction across three brands

## Purpose

A Claude session, a Grok session and a Codex session can message each other,
and neither the command nor the arriving turn says which CLI is on the other
end.

## Proves what `check` cannot

This is the reason the feature exists. Each CLI's own peer channel reaches only
its own brand; ours is brand-neutral by construction, and construction is
exactly what a unit test cannot check — it can only check the code it was
pointed at.

Specifically: Grok's CLI files a prompt inside `<user_query>`, which our reader
unwraps *before* classifying the wrapper. An anchored match against the raw line
would compile, pass every Claude test, and silently draw every arriving Grok
message as a turn the reader typed. Only a real Grok session writing a real
`chat_history.jsonl` proves the order is right.

## Cost

Three spawned sessions, one per brand, ~9 turns. **Needs a signed-in Grok
account and a signed-in Codex account.** Three to four minutes.

## Preconditions

- Deployed build, every window reloaded.
- `squadron.orchestrators.enabled` on.
- Grok **and Codex** signed in — check the accounts control in the panel first.
  A signed-out brand makes this scenario fail for a reason that has nothing to
  do with the verbs.
- Panel open.

## Prompt

```
You are driving a live test of Squadron across three CLI brands. Work only in
/tmp/agentsview-probe. Do not touch any repository, do not edit files elsewhere,
do not run builds.

Step 1. ~/.squadron/bin/squadron-list — note your own pid as PARENT and your
own sessionId.

Step 2. Spawn one of each brand:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand claude --name live-xbrand-claude \
    --prompt 'Live test peer. Do nothing until told. Reply OK to anything.'

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand grok --name live-xbrand-grok \
    --prompt 'Live test peer. Do nothing until told. Reply OK to anything.'

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand codex --name live-xbrand-codex \
    --prompt 'Live test peer. Do nothing until told. Reply OK to anything.'

Note all three pids: CLAUDE_PID, GROK_PID and CODEX_PID. Wait until all three
read idle.

**Do not tell the peers their own session ids.** A peer handed its id in the
briefing can pass `--caller` by hand and route around a brand that cannot name
itself, which is exactly how the 2026-09-02 defect stayed invisible. The bare
prompt above is the test.

Step 3. You (Claude) send to the Grok session:

  ~/.squadron/bin/squadron-send --pid GROK_PID \
    --text "Cross-brand test, direction one. Reply with the single word ONE."

Step 4. Now make the Grok session send back to you. Send it this instruction:

  ~/.squadron/bin/squadron-send --pid GROK_PID \
    --text "Run this exact command and report its exit code and output: ~/.squadron/bin/squadron-send --pid PARENT --text 'Cross-brand test, direction two, from the Grok side.'"

(Substitute the real PARENT number before sending.)

Step 5. Wait, then check your own transcript — or simply report whether a
message from the Grok session has arrived in this conversation, quoting it.

Step 6. Print every user turn in the Grok session's transcript. Its path is in
the list output. Say whether the text you sent in step 3 is there, and whether
the string <squadron-message appears around it.

Step 7. Now the third brand, both ways. Send to the Codex session:

  ~/.squadron/bin/squadron-send --pid CODEX_PID \
    --text "Cross-brand test, direction three. Reply with the single word THREE."

Then make it send back to you:

  ~/.squadron/bin/squadron-send --pid CODEX_PID \
    --text "Run this exact command and report its exit code and output verbatim: ~/.squadron/bin/squadron-send --pid PARENT --text 'Cross-brand test, direction four, from the Codex side.'"

Report the exit code it gives you, verbatim, whatever it is.

Step 8. List the newest six files in ~/.squadron/actions/ and print each.
```

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | Claude → Grok delivered | Grok's `chat_history.jsonl` | the step-3 text is there, wrapped, and **nested inside `<user_query>`** — that nesting is the thing the reader must cope with |
| 2 | Grok answered it | Grok's transcript | it replies `ONE` |
| 3 | Grok → Claude delivered | this session | the step-4 message arrives as a turn in *your* conversation |
| 4 | **Human:** the Grok card marks it | the dock, Grok's card | the arriving turn reads `peer` + 8 characters of PARENT's id — **not** `you`, and no raw `<squadron-message>` in the body |
| 5 | **Human:** the Claude card marks it | the dock, this session's card | same, with the Grok session's id |
| 6 | Both counted | `~/.squadron/actions/` | records for both directions, each naming the right `from` and `toPid` |
| 7 | Claude → Codex delivered and attributed | the Codex session's turns | the step-7 text arrives, wrapped, and reads `peer` + 8 characters of PARENT's id — not `you` |
| 8 | Codex → Claude delivered | this session | the step-7 return message arrives as a turn in *your* conversation, **exit 0** |
| 9 | All directions counted | `~/.squadron/actions/` | records for all four directions, each naming the right `from` and `toPid` |
| 10 | No brand word anywhere | every command above, and `squadron-list` output | neither the commands nor any row names a CLI |

Row 4 is the regression this scenario exists for. If the Grok card draws the
message as `you` with the tag visible, the classifier is matching the raw line
instead of what `userTurn` returned.

## Cleanup

```sh
~/.squadron/bin/squadron-end --pid <CLAUDE_PID>
~/.squadron/bin/squadron-end --pid <GROK_PID>
~/.squadron/bin/squadron-end --pid <CODEX_PID>
```

## Results

**The rows were renumbered on 2026-09-02** when Codex was added: old row 7 ("No
brand word anywhere") is now row 10, and 7/8/9 are new. A result below is scored
against the numbering of its own date.

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-09-16 | 2026.38.2 deployed | Claude `claude-sonnet-5`, Grok `grok-4.5`, Codex `gpt-5.6-terra` | **row 8's cause clears on all three brands**; rows 1-10 not run as written | **Not this scenario — a narrower probe of the identity seam underneath row 8**, run after `TASK_inprogress_identity_env_seam.md` moved the four variables to `core/identity.ts`. One session per brand, each running `squadron-list --mine`, then `squadron-rename` with **no `--caller` and no `--pid`**, then re-reading the board. `rename` is the load-bearing one: it takes no caller override, so it renames whichever card `ownSessionId` believes is the caller's, and a wrong answer renames somebody else's card visibly. All three renamed **their own** card and the row's `sessionId` equalled the variable their own CLI planted — Claude `99e5fef5…`/`CLAUDE_CODE_SESSION_ID`, Grok `01a0a914-c0e6…`/`GROK_SESSION_ID`+`GROK_AGENT=1`, Codex `01a0a914-c4f6…`/`CODEX_SESSION_ID`. Exit 0 throughout; the 2026-09-02 signature was exit 2. Each child also carried `SQUADRON_LINEAGE_ORIGIN=dc0cc29f…`, the spawning session's id, and **no brand resolved to it** — that variable is deliberately planted and is not in `IDENTITY_ENV`. **What this did not test:** row 8's actual Codex → Claude *send*, and the `childTransport` scrub — this window's extension host carried no identity variable at all (`ps eww` on the host and both node helpers), so there was nothing to inherit and the scrub could not fire. The scrub stays covered only by `session.test.ts`'s *hands the child no ancestor identity*, off the same table. Proving it live still needs a host booted from inside another brand's shell. |
| 2026-09-02 | 2026.36.3 deployed | Claude driver, Codex peer | rows 7, 10 pass; **row 8 FAILED**; the rest not run | **Partial, and off the C6 acceptance run rather than off this scenario as written** — that run had one Claude driver and two Codex children, and **no Grok session at all**, so rows 1-6 were not exercised on this date. Row 7: Claude → Codex arrived as `[user] from=ba720ec7-…`, wrapper stripped, and the peer answered. **Row 8 is the defect this scenario exists to find** — Codex → anything exited 2 with `cannot tell which session is asking; pass --caller <sessionId>`. `ownSessionId` (`cli/args.ts`) read only Claude's and Grok's exports; Codex 0.151.0 exports `CODEX_SESSION_ID` into its shell-tool environment and it is the durable thread id. Fixed the same day; **re-run after a deploy.** `squadron-list --mine`, `squadron-step`, `squadron-rename` and `squadron-wait` refused identically, and `rename` has no `--caller`, so it had no workaround at all. |
| 2026-08-22 | 2026.34.16 deployed | Claude + Grok | 1-4, 6-7 pass; row 5 unchecked *(old numbering: row 7 is now row 10)* | Claude peer on `--model haiku`, Grok on default. Row 1 confirmed nested inside `<user_query>`; row 4 confirmed at the panel — `peer 9c04518a`, no raw tag. Row 7 passes with a caveat: no list row carries a brand field at all, the only CLI name anywhere is inside a `transcript` path. **Defect found:** the Grok dock draws one assistant message as one turn per token. `core/grok/tee.ts:139-147` opens a new line on every `agent_message_chunk` and never concatenates — Grok's own `chat_history.jsonl` had 4 clean entries where our record had 44. `OK`/`ONE` survived only because they are one chunk each; `fixtures/fake-acp.ts` emits whole-message chunks, which is why the suite is green. |
