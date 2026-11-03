# Live: one session answers another's question

## Purpose

`squadron-answer` withdraws a peer's open question by interrupt and delivers
the answer as its next prompt, worded the way a click reads. It never touches a
permission, and it never interrupts a turn whose question has closed.

## Proves what `check` cannot

The window arm in `serve` has no unit test, by construction (`host/`). Every
judgement it makes is `checkVerbAnswer`'s, which is tested — but whether the
shim, the published record and the window's live request agree about one
request id is only visible with real CLIs. So is the thing the verb exists for:
that the interrupt **withdraws the dialog** on every brand, and the asker
**acts on the prose** as it would on a click.

## Cost

One spawned asker per pass, ~3 turns. Two minutes. **One pass per brand** —
Claude, Grok and Codex as the asker; the driver can be any brand. Use the
cheaper models at low effort (`src/test/AGENTS.md`).

## Preconditions

- Deployed build, every window reloaded — or an Extension Development Host on
  the branch, with the asker spawned into it.
- `squadron.orchestrators.enabled` on.
- `squadron.skipPermissions.enabled` **off**, so step 7's permission prompt is
  real.
- Codex only: `features.default_mode_request_user_input = true` under
  `[features]` in `~/.codex/config.toml`, or Codex asks no question at all
  (`cli_feature_parity.md`, *Question prompt*).
- Panel open.

## Prompt

Replace `BRAND` and `MODEL` with the asker's brand and a cheap model id from
`squadron-models`.

```
You are driving a live test of Squadron. Work only in /tmp/agentsview-probe.
Do not touch any repository, do not edit files elsewhere, do not run builds.

Step 1. ~/.squadron/bin/squadron-list — note your own pid as PARENT.

Step 2. Spawn an asker:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand BRAND --model MODEL --effort low --name live-answer-asker \
    --prompt 'Live test asker. Use your question tool (the one that shows the
    user options) to ask TWO questions in ONE call: "Which database?" with
    options Postgres and SQLite, and "Which areas?" as a multi-select with
    options Auth, Billing and Search. When answered, write one line saying
    exactly which database and which areas you were given, then stop.'

Note the pid as ASKER.

Step 3. Run ~/.squadron/bin/squadron-list until ASKER reads `waiting`. Print
its `asking` field whole. Note the `requestId` as REQ.

Step 4. Answer it with entries that do not cover it, and report the exit code
and stderr:

  ~/.squadron/bin/squadron-answer --pid ASKER --request-id REQ \
    --answers '[{"answer":"SQLite"}]'

Step 5. Answer it properly:

  ~/.squadron/bin/squadron-answer --pid ASKER --request-id REQ \
    --answers '[{"answer":"SQLite"},{"answer":["Auth","Billing"]}]'

Report the exit code and stdout. Then answer REQ again with the same command,
and report the exit code and stderr.

Step 6. Wait for ASKER to go idle. Print its transcript's turns in order and
say plainly whether the question turn ends interrupted, whether the next user
turn is the answer prose, and whether the line ASKER wrote names SQLite and
both Auth and Billing.

Step 7. Ask for a permission:

  ~/.squadron/bin/squadron-send --pid ASKER \
    --text 'Run exactly this shell command and nothing else: curl -sI https://example.com'

Run squadron-list every second until ASKER reads `waiting` with an `asking`
entry of kind `permission`. Note its requestId as PERM, then at once try:

  ~/.squadron/bin/squadron-answer --pid ASKER --request-id PERM --answers '[]' --force

Report the exit code and stderr, and whether PERM is still in `asking`. Do not
answer it any other way. If ASKER goes idle without asking, say so and skip
this step.

Step 8. Print the newest three files in ~/.squadron/actions/.
```

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | The open question is legible without a transcript | step 3 | `asking` carries REQ, `kind: "question"`, both questions with their options, `multiSelect` true on the second |
| 2 | Entries that do not cover the request are refused before posting | step 4 | exit 2, naming 2 questions |
| 3 | The answer lands | step 5 | exit 0, `answer sent to ASKER; the interrupt withdraws the question` |
| 4 | A closed question is refused, nothing interrupted | step 5, second call | exit 2, `no longer open`; ASKER's transcript shows no second interrupt |
| 5 | **The question was withdrawn** | step 6, and ASKER's card | the question turn ends interrupted; the card leaves `waiting` and no dialog is left in the ask layer |
| 6 | **The asker acted on the answer** (PRD goal 1) | step 6 | the line names SQLite, Auth and Billing |
| 7 | **A permission is refused, `--force` or not** (PRD goal 2) | step 7 | exit 2, `granted only by a person`. The permission stays open on ASKER's dialog |
| 8 | It was recorded | `~/.squadron/actions/` | an `answer` record naming ASKER's pid and REQ as `askId` |
| 9 | **Human:** the answer wears who sent it | ASKER's dock | the answer turn reads `peer` + 8 characters of PARENT's id |

Row 7 needs a command the asker's own sandbox gates. A `touch` inside the
workspace raises no prompt on Grok or Codex, and Codex luna raised none for
`curl` either — its sandbox refused the network silently (2026-10-06) — so on
Codex this row is unreachable live and rests on `answer.test.ts`. Tell the
person not to Deny until step 7 has reported: a Deny closes PERM and the
refusal goes untested.

Row 1's `multiSelect` read `false` on Codex in the same run, with the asker
told to make it a multi-select; the list answer was still delivered and read.

Row 5 is the one each brand can get wrong on its own: Grok's interrupt has no
retract notification and fails the open RPC instead, so a dialog left standing
there is that path broken, not this verb.

## Cleanup

Answer PERM on ASKER's dialog yourself (Deny), then:

```
~/.squadron/bin/squadron-end --pid ASKER
```
