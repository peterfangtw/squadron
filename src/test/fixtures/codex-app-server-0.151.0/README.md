# Codex app-server 0.151.0 fixtures

Sanitized transcripts captured on 2026-08-31 by
[`docs/reference/cli_state/codex/probe.mjs`](../../../../docs/reference/cli_state/codex/probe.mjs).
They cover metadata, thread start, text and image turns, command and file-change
approval, denial, user input, interrupt, settings, restart/resume, and signed-out
device login cancellation.

The C5 projections add:

- `c5_account.json` — signed-in/signed-out reads, device and hosted-browser
  start/cancel/completion ordering, and idempotent scratch logout;
- `c5_models.json` — every visible paginated model fact needed by the product,
  plus the all-model id/visibility inventory for signed-in and signed-out
  profiles;
- `c5_usage.json` — canonical and named rate-limit window shapes, token-activity
  shape, and signed-out request errors.

The question-dialog pass adds `questions_summary.json` plus four live protocol
projections and `questions_product_interrupt.json`. They separate Default-mode
reachability, answer semantics, `turn/steer`, native retraction, and the
before/after product interrupt frames. The exact model continuation is the
rollout `function_call_output` joined by `call_id`; raw rollouts stay out of the
repository.

The files intentionally replace account data, filesystem paths, protocol ids,
timestamps, rate-limit consumption, and balances. The raw capture is not
checked in. Values such as available models and context windows are observations
from this sitting, not product constants.

Re-capture into a disposable directory:

```sh
node docs/reference/cli_state/codex/probe.mjs --out /tmp/agentsview-codex-probe
node docs/reference/cli_state/codex/probe_account_models.mjs \
  --out /tmp/agentsview-codex-c5-probe
node docs/reference/cli_state/codex/probe_questions.mjs \
  --out /tmp/agentsview-codex-questions
```

The probe uses the current Codex login for model turns, creates a durable thread
in a temporary cwd, and starts a separate scratch `CODEX_HOME` for the canceled
device-code flow. Review `sanitized/` before replacing these fixtures; never
copy `raw.json` into the repository.

The C5 probe reads the normal profile but never mutates it. Login, cancellation,
and logout run only against a new scratch `CODEX_HOME`. Add
`--interactive-login` only when a reader is present to complete the scratch
device flow; it logs that profile out again after capturing the signed-in
reads.
