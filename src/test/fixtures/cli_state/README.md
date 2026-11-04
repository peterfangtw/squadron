# CLI replay recordings

These recordings are the inputs consumed by the Claude, Codex and Grok tee
regression tests. Dates remain in the directory names. They moved from
`docs/reference/cli_state/` so the public source export includes the tests’
inputs. Capture bytes are unchanged by that move.

- Claude 2.1.296, 2026-10-14: foreground/background commands and subagents;
  the 2026-10-13 command recording is the earlier control.
- Codex 0.162.1, 2026-10-13: notifications for a command outliving its turn,
  without experimental API capabilities. Local home paths are replaced by `~`.
- Grok 1.0.50, 2026-10-13, and 1.0.52, 2026-10-14: background commands,
  subagents, their ends and parent wakes. Home paths are sanitized. The earlier
  recording omits setup notifications and trims handshake/account replies.

The private reference archive keeps the probe scripts and protocol analysis.
Do not reformat recordings or replace observed frames with invented examples.
