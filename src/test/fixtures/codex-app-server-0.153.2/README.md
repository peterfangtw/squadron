# codex-app-server 0.153.2

Sanitized captures from the installed binary, taken 2026-09-05. The
`codex-app-server-0.151.0/` directory beside this one stays as historical
evidence and is not rewritten — see `cli_state/codex/protocol.md`, section
*0.153.2 re-read*.

- `questions_config_file.json` — Arm C. `features.default_mode_request_user_input`
  set in `config.toml` (not as a `thread/start` override) emits
  `item/tool/requestUserInput` on a panel-shaped thread, `isBlocking: false`.
  The second cell is the control with the key absent. Taken with
  `experimentalApi: false`, while the panel initializes with `true` and falls
  back — see the caveat in `protocol.md`. `parserAcceptedBeforeFix` is this
  capture's own field and records the **pre-fix** parser refusing the frame; it
  is not protocol evidence. The probe now emits the same reading as
  `parserAcceptedAtCapture`, because a re-run today reports `true` and must not
  file that under a name claiming otherwise. Nothing asserts on either — the
  tests re-parse the captured request.

The Step-4 permission pass of 2026-09-05 adds the two `item/permissions/`
`requestApproval` captures, one per outcome, as newline-delimited frames
(`{dir:"in"|"out"|"err", m:<frame>}` — the direction is the client's):

- `permissions_grant.jsonl` — the request answered with the echoed subset at
  `scope: "turn"`. The turn then completed and the model reported the grant it
  received.
- `permissions_error.jsonl` — the same request answered with JSON-RPC
  `-32602`. App-server logged a client error on stderr, resolved the request
  anyway, and handed the model `{permissions:{network:null,file_system:null}}`.
  The turn completed on a grant nobody gave. That is the permission-side twin of
  the question defect C3 corrected.

`item/agentMessage/delta` frames are **dropped** from both. The model spelled
the response body out a few characters at a time, splitting the home directory
across four deltas, so no per-frame path substitution can sanitize them; the
`item/completed` frame beside them carries the same text whole. Paths under the
home directory read `<path>`, ids are interned placeholders, and every
timestamp, `usedPercent`, plan and balance is zeroed or redacted — the same
treatment `probe.mjs` gives the 0.151.0 set, except that these two were taken by
hand rather than by a committed probe.

The command-approval pass of the same day adds two more, in the same frame
shape, taken by [`probe_exec_decline.mjs`](../../../../docs/reference/cli_state/codex/probe_exec_decline.mjs)
and read in [`approvals.md`](../../../../docs/reference/cli_state/codex/approvals.md):

- `command_decline.jsonl` — `item/commandExecution/requestApproval` for an
  escalated `touch` under the home directory, `availableDecisions` offering
  `accept`, an execpolicy amendment and `cancel` but no `decline`, answered
  `{decision: "decline"}` anyway. The item completed `declined`, the turn
  `completed`, and the model reported. `codex_asks.test.ts` parses this request.
- `command_cancel.jsonl` — the same request answered `{decision: "cancel"}`.
  The item completed `declined` and the turn ended `interrupted` with no
  report.

`item/agentMessage/delta`, `mcpServer/startupStatus/updated` and
`account/rateLimits/updated` frames are dropped from both; the first for the
reason above, the other two because they describe this machine's servers and
plan rather than the approval.
