# Live: window send burst protection

## Purpose

Verify that the CLI and host agree on ten accepted messages per rolling minute
in the receiving IDE window, and that queued messages merge into one turn.

## Cost and preconditions

One target session using the routine model/effort policy in `src/test/AGENTS.md`.
Use a fresh stock VS Code development host with the current build and
`squadron.orchestrators.enabled` on. Start with no recent send, answer or wait
records for this window. A second stock host is optional for window isolation.

## Procedure

1. Spawn a target in a scratch directory and keep its pid. Tell it to hold a
   long-running terminal command so it remains busy during the burst.
2. Send ten short, numbered messages inside one minute. Each must exit 0,
   including the fifth to the same target. Inspect `~/.squadron/actions/`: each
   accepted action must name the target's `windowId`.
3. Send an eleventh, then repeat with `--force`. Both must exit 2 and
   name this IDE window, the last minute and the limit of 10. Neither writes an
   accepted action.
4. If a second host is available, send to its target while the first host's
   allowance is exhausted. That send must succeed.
5. After the first host's oldest accepted action is at least 60 seconds old,
   send again. It must succeed. Confirm queued messages reach the target in
   order in a merged turn, rather than requiring one turn per message.
6. Opportunistically send to an idle target past its prompt-cache deadline, and
   to one with a full context window, with the burst clear. Only the stale
   target must exit 2 with `Pass --force`, naming the context a wake would
   re-send, then be accepted with `--force`. The high-context target must be
   accepted without `--force`; its agent manages compaction.
7. Verify an unknown pid, a missing caller and a forged attribution wrapper
   still refuse; missing required flags exit 1. Turning orchestrators off must
   still refuse in the host. Restore the switch afterward.

## Cleanup

End the idle target with `~/.squadron/bin/squadron-end --pid <TARGET>` and close
the development hosts. Do not edit real action records to reset the allowance.

## Historical results for the superseded policy

| Date | Build | Result | Notes |
| --- | --- | --- | --- |
| 2026-08-22 | 2026.34.16 deployed | 1-8 pass; stale case not run | Target on `--model haiku`. Row 2 refused by the shim in 0.075s — no round trip. Rows 5-6: cap names the count and the window, and `--force` did not lift it. Row 8: exactly four records, and the four refusals wrote none. Row 7 run by editing `settings.json` and restoring it, verified back on with a subsequent exit-0 send. **Missing row:** a second, undocumented guard refuses at **5 sends/minute globally**, separate from the 4-per-pair/15-min cap — it fired mid-run and cost a minute. Add it to the table. |
