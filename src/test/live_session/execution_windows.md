# Live: execution windows across Claude, Grok and Codex

## Purpose

Verify that complete native execution coverage excludes gap writes while disabled capture retains the turn fallback on all three brands.

## Proves what `check` cannot

The actual CLI must block on its scoped hooks, supply the native ownership/call IDs, and reach the existing file-pill surface through a real stock VS Code host. Fake protocols cannot establish those vendor boundaries.

## Cost

Three probe sessions, two turns per brand: six paid turns, already mixing Claude, Grok and Codex. Use Sonnet for Claude, an available Grok model, and Luna for Codex, at low effort where that brand supports it, or the nearest supported lower effort. Resolve the model ids from the current catalog before launch. Do not use Opus, Astra, Sol, or another higher-cost model. Native trust/auth preparation can require a separate launch. The optional child, mixed-pair and resume checks below add paid turns; run those only when explicitly requested.

## Preconditions

- A stock VS Code development host runs the compiled candidate. Its workspace is the disposable `/tmp/squadron-execution-live`; that path is absent before setup. Run the driver in an owned session in this same host, with a quiet board.
- All three CLIs are installed and signed in. `squadron.checkpoints.execution.enabled` is enabled before probe launch.
- Codex's native `/hooks` review has approved the current immutable command with the same launch flags and CLI environment. Read the generated `codex-hook-review.txt` under the owned runtime directory. Never author trust hashes. An untrusted run should use its floor; it cannot count as a precise pass.
- Read the candidate's execution-window task Notes and native CLI references. Do not change global native hook configuration.

## Prompt

Paste this into the fresh owned driver session. The host workspace can be created before opening the host; the driver must refuse existing marker/evidence files from an earlier run.

```text
Verify Squadron execution-window attribution using only /tmp/squadron-execution-live.
Do not touch any other repository, session, native configuration or credentials.

Initialize an empty Git repository there if needed. Refuse existing probe marker/evidence files.
Save every spawned pid immediately, one per line, to /tmp/squadron-execution-live/pids.
Use ~/.squadron/bin/squadron-models to select one model per brand from the current
catalog: Sonnet for claude, an available Grok model for grok, and Luna for codex, at
low effort where that brand supports it, or the nearest supported lower effort. Never
invent model IDs. Do not use Opus, Astra, Sol, or another higher-cost model.

Write /tmp/squadron-execution-live/marker.cjs. It receives a label, writes
<label>-start.json containing Date.now(), waits 150ms, then writes <label>.txt
containing one line and <label>-end.json containing Date.now(). The marker files
are measurement writes too; keep them identifiable. Resolve the absolute node binary.

For each brand, start a probe with ~/.squadron/bin/squadron-spawn,
--cwd /tmp/squadron-execution-live and the selected --brand, --model, and --effort. Its prompt is:
"Run exactly two separate shell tool calls in sequence: <absolute-node>
/tmp/squadron-execution-live/marker.cjs <brand>-on-a then <absolute-node>
/tmp/squadron-execution-live/marker.cjs <brand>-on-b. Do not combine them or use
other tools. Reply done." Substitute the known brand and node path before spawning.

While the second command is running, watch this runtime's per-tree checkpoint
JSONL. After its second post capture lands and before parent completion, write
/tmp/squadron-execution-live/<brand>-on-gap.txt yourself. If that interval was
missed, mark the check inconclusive and repeat in a new probe; do not call it passing.
Read the final coverage and the retained floor. Record owner/runtime/turn, source,
selected paths/counts, hook timing, and remaining private indexes in
/tmp/squadron-execution-live/results.json. Ask the human to inspect the matching dock.

Change only this disposable workspace's .vscode/settings.json to disable
squadron.checkpoints.execution.enabled, preserving other keys. Wait until every
probe runtime's context.json says enabled:false. Send each idle pid one equivalent
prompt using <brand>-off-a and <brand>-off-b, and inject <brand>-off-gap.txt after
the last command finishes but before parent completion. This turn must select turn
and include the gap in its floor. Save evidence; do not infer readiness from a sleep.
Restore the workspace setting to its previous enabled value after these turns.

Wait until your probes are idle, then perform the Cleanup commands below.
Confirm runtime-end notes and zero remaining private indexes for those runtimes.
Report pass/fail/inconclusive per row, CLI/IDE versions, and any discrepancy.
```

## Validation

| Check | Where to look | Pass |
| --- | --- | --- |
| Native barriers and membership | Hook snapshots, marker timestamps, independently observed call IDs | Both commands have matched blocking captures in the correct runtime/turn |
| Complete source | Final coverage and retained floor | `source: execution`; gap occurs only in the retained floor |
| Disabled source | Runtime admission and second coverage | Admission says false before send; `source: turn` |
| Paths and counts — **human** | Selected probe's dock | On excludes its gap; off includes its gap; each one-line file has `+1−0` |
| Tenancy — **human** | Probe host's board and a second window | Only the owning window draws/drives its probes |
| Shutdown | Per-tree evidence and Git admin directory | Actual runtime-end notes; no remaining call/floor indexes for ended probes |

Optional extended checks use fresh probes to avoid the four-message pair cap:

- Native children: for each brand, ask it to delegate one shell write to a native child and wait. The child's brackets/calls enter parent coverage; child prose, status, completion and interrupt target stay isolated. Unfinished/unproven children require fallback.
- Mixed pairs: run Claude/Grok, Claude/Codex and Grok/Codex on a fresh tree per pair. Hold simultaneous shell calls at a command barrier, then write one shared path and distinct paths. Repeat with one runtime launched off. Subtraction must withhold contested candidates, even when that loses an actual owned path; never union the floor into precise output.
- Resume/reload: reload with three idle probes, inspect runtime endings/index removal, then resume each durable conversation. Its new runtime cannot consume old pairs. Compare old turn pills and the newly selected source.
- Aliases/worktrees: repeat through `/tmp` and `/private/tmp`; replay legacy alias-spelled neighbors/native paths. Deleted/display paths survive comparison; linked worktrees have separate stores.
- Failures: exit 7, denial, cancellation, hook timeout, process death and unknown write-capable tools retain fallback/uncertainty when coverage is incomplete. Pending/background completion bounds uncertainty without inventing a post snapshot. Unobserved writers inside an interval remain an attribution limit.

## Cleanup

Run from the same driver session after the probes are idle:

```sh
while IFS= read -r probe_pid; do
  ~/.squadron/bin/squadron-end --pid "$probe_pid"
done < /tmp/squadron-execution-live/pids
```

After saving results and checking indexes, close only the disposable development host. Remove only its workspace:

```sh
rm -rf /tmp/squadron-execution-live
```

Do not remove immutable runner/configuration history or another runtime's indexes; their retention contract is documented separately.

## Results

- 2026-10-05 — `execution-windows` worktree, Claude 2.1.289/Grok 1.0.46/Codex 0.160.0, stock VS Code 1.140.0: native normal/fallback/children/mixed/resume/toggle/reload retakes passed; measured gaps/background limits and shutdown corrections are recorded in `TASK_done_execution_windows.md` Notes.
