# thread-trace

Real wire traces for `thread_trace.test.ts`, cut from the probes of
`docs/tasks/TASK_done_in_memory_thread.md` (raw evidence was kept under
`/tmp/squadron-probe/`, untracked).

| File | Probe | CLI | Turn |
| --- | --- | --- | --- |
| `claude.jsonl` | Step 1, 2026-10-06 | Claude 2.1.289, Sonnet 5.5 low | text, `Bash`, text |
| `codex.jsonl` | Step 1, 2026-10-06 | Codex 0.160.0, Luna low | `commentary`, a command, `final_answer` |
| `grok.jsonl` | Step 1, 2026-10-06 | Grok 1.0.46, Grok 4.7 low | prose, `run_terminal_command`, prose |
| `grok-cancel.jsonl` | Step 2, 2026-10-08 | Grok 1.0.46, Grok 4.7 low | prose cut by `session/cancel`; one chunk after `turn_completed` |

One row per line: `{t, sent}` is what the probe wrote, `{t, line}` what the CLI
wrote on stdout, `{t, wrote, line}` what the CLI wrote to its own file `wrote`.
`t` is milliseconds from the probe's start. Order is the wire's.

Cut, by the script kept beside the raw traces (`cut.mjs`, `echo.mjs`):

- **Dropped:** stderr, the probe's own annotations, Grok's `authenticate`
  request and result (the result names the account), Codex's
  `remoteControl/status/changed` (names this machine's installation).
- **Rewritten:** the probe's working directory to `/tmp/thread-trace/work`,
  which the test swaps for its own; `/Users/<name>` to `/Users/someone`.
- **Slimmed:** any array of more than 8 entries to its first 3 — tool, model,
  command and announcement lists. No line was dropped for size.
- **Added:** each Grok trace's user echo, the first `user_message_chunk` line of
  that session's own `updates.jsonl`, placed after the wire line stamped with
  the same `agentTimestampMs`. Grok holds the record's user turn until that
  file echoes the prompt, so a replay without it waits out a 30 s deadline.
