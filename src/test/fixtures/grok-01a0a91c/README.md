# grok 1.0.30 (`01a0a91c`)

Sanitized on-disk capture from the installed binary, taken 2026-09-16.
CLI **1.0.30** (`04b7ffed98c6`) [stable], `grok agent --no-leader
--always-approve stdio`, scratch cwd `/tmp/av-grok-probe` (real sitting used
an `mktemp -d` under `/tmp`). Three `session/prompt` turns: a no-tool
`end_turn` (`pong`), a `list_dir`, a `write` of `probe.txt`.

`grok-01a019f2/` beside this one stays as the 1.0.5 record of the turn that
showed the live-bubble duplicate — see `cli_state/codex/protocol.md` for the
same keep-the-old-capture convention. Tests still read that directory.

| File | What it is |
| --- | --- |
| `chat_history.jsonl` | 19 rows: `system` / injected `user` / three typed prompts (`prompt_index` 0–2) / `reasoning` / `assistant` / `tool_result` |
| `updates.jsonl` | 33 ACP-style lines (`session/update` + `_x.ai/session/update`) |
| `summary.json` | Chrome. `generated_title` / `current_model_id` still the keys `readGrokChrome` takes |
| `signals.json` | Chrome. `contextWindowUsage` / `contextWindowTokens` still present |

Injected `<user_info>` / skills / MCP reminders are stubbed the same way
`grok-01a019f2` was. `encrypted_content` is `<redacted>`. Paths under `$HOME`
read `<path>`. `agent_id` / `attempt_id` / `request_id` are placeholders.
Scratch cwd is `/tmp/av-grok-probe`. Probe prompts are synthetic.

Handshake / `session/new` / `version.json` notes live in
`docs/reference/cli_state/grok/probe.md` (2026-09-16 sitting), not in this
directory — those frames are not the jsonl the dock reads.
