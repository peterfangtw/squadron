# FAQ

## Why is my Codex not asking questions?

If Codex does not show question prompts in Default mode, including when using
bypass permissions mode (`--yolo`), enable its question-tool feature:

```sh
codex features enable default_mode_request_user_input
```

This sets the following in your Codex user config (`~/.codex/config.toml`):

```toml
[features]
default_mode_request_user_input = true
```

Restart Codex or reload the IDE window, then start a new session.

YOLO bypasses command approvals and sandboxing; question-tool availability is a
separate setting. This flag allows Codex to use the question tool outside Plan
mode but does not force it to ask questions. The feature is under development
and requires a Codex version that supports it.
