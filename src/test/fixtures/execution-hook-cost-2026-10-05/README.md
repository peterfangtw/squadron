# Execution hook cost evidence — 2026-10-05

Task: [execution hook cost](../../../../docs/tasks/TASK_done_execution_hook_cost.md).

`native.json` contains installed CLI recorder observations, with input bodies,
credentials, absolute scratch paths and native actor/call IDs removed. Each
recorder delayed 50 ms. Native tool groups were unrestricted (`all`), the
candidate writer regex (`write`), and `^ZZZ_NEVER_MATCHES$` (`never`). Child
ancestry groups remained unrestricted. Never-matching tool invocations: zero.

| Brand / model, low effort | Source | Tool recorder invocations: all / writer / never |
| --- | --- | ---: |
| Claude 2.1.289 / claude-sonnet-5-5 | scoped launch settings | 12 / 8 / 0 |
| Grok 1.0.46 / grok-4.7 | native plugin; Claude and Cursor compatibility off | 14 / 8 / 0 |
| Codex 0.160.0 / gpt-6-luna, file/shell | session-flags TOML, native TUI trust review | 6 / 6 / 0 |
| Codex 0.160.0 / gpt-6-luna, delegation | same source and native review | 10 / 4 / 0 |

Claude emitted `Read`, `ToolSearch`, `Write`, `Edit`, `Bash` and
`PostToolUseFailure`. The installed tool set did not expose `Glob`/`Grep` to
this probe; `MultiEdit`/`NotebookEdit` were not exercised. Grok emitted
`read_file`, `grep`, `list_dir`, `write`, `search_replace`,
`run_terminal_command`. Its first probe omitted `search_replace` from the
candidate; the retained retake includes it. Codex emitted `Bash`, `apply_patch`,
`collaborationspawn_agent`, `collaborationwait_agent`,
`collaborationinterrupt_agent`. `update_plan` emitted no hooks. A shell read
still emits `Bash` and is intentionally captured.

`production.json` records actual adapter/session/runner verification: precise
writer windows exclude injected editor-gap writes on all brands; native child
writers remain captured; pending Claude/Grok calls end from independent native
task completion without output polling. Production Codex commands were also
reviewed through its native TUI. Claude CLI retained its real HOME for macOS
keychain access; a command prefix gave only the capture runner a disposable
HOME, matching the parent observer's disposable state directory. No native
trust hashes or shared configuration were authored.

`paired-results.json` is the controlled resource report. Four configurations
rotate per call and per turn, with independent runtime state stores. The shared
capture pipeline uses Claude writer/read payloads; installed matcher behavior
is established separately for all brands above. This avoids claiming a Codex
saving for `update_plan` or shell reads. There are 30 sequential writer samples,
30 read samples, 110 mixed call samples across eleven measured turns (eight
3-call, two 16-call, one 54-call), and 30 parallel writers in ten 3-call waves,
per repository/configuration. Mixed turns use one writer per three calls. This
is a disclosed synthetic mix, not an observed distribution of tool types or
model end-to-end latency. Turn delays sum measured blocking hook edges and
exclude tool/model time. Parallel waves report both critical wall time and
aggregate hook process work. No timing threshold is asserted in CI.

The copies contain 1,218 agentsview and 4,869 acme-web visible
tracked/untracked nonignored files, plus the small measurement write. File
timestamps, ignore files and independent Git metadata were copied; worktree
registrations and Squadron timing/cache artifacts were omitted. Neither live
checkout was staged into, edited by a probe, or used for synthetic writes.
Machine load changed substantially: controlled runs 34.0→13.4 (agentsview) and
13.4→19.8 (acme-web), versus the caller's approximately 4.5. Earlier
sequential configurations were confounded by growing shared journals and
changing load; they were replaced by this rotating, isolated-state report.

`stages-*.json` times real `git add` subprocesses independently of Node startup,
and source-handle-open through copy close (including atomic publication/link).
Each has one fresh first call followed by 30 samples. These earlier runs were
under heavier concurrent load, so compare before/after within the report rather
than equating their absolute milliseconds with the original measurements.
`cold-results.json` contains three samples per repo/configuration after
remounting a separate APFS sparse image. This empties that volume's filesystem
cache without purging the machine. The backing image's host pages remain warm;
it is not a cold physical SSD claim. The image was detached after the run.
Mac `/usr/bin/time -l` maximum RSS is recorded in **bytes**, separately from
elapsed time. Writer RSS remains approximately 43–44 MiB; filtering reduces
process count, not memory per writer process.

Baseline: source `03248658` (execution code `7c165501`), Node v23.11.0,
Apple Git 2.39.5 (Apple Git-154). Runner SHA-256:

- baseline: `0f954bc4453c4e617c0a3600b3278240ed22784223ab4f9f5fb57a3cfea574c0`
- candidate: `8a3e6a97dc915397534c7c2ee627e60bc00a6707c66234123f07e312dbf2dfa7`

Reproduction uses disposable copies and compiled artifacts, without a branch
or worktree. Extract `git archive 03248658` into a disposable directory and compile there
with the installed dependencies to obtain baseline `out/core` and
`dist/execution.js`; preserve them before compiling
the candidate; put them at `<scratch>/baseline/core` and
`<scratch>/baseline/execution.js`, with analogous `candidate/` files. Copy each
source tree using `git ls-files -c -o --exclude-standard -z` with
`GIT_OPTIONAL_LOCKS=0` and all other `GIT_*` removed. Copy regular files with
metadata preservation, retain symlinks, and copy independent `.git` metadata
excluding `worktrees`, `squadron-runs`, `squadron-timings.jsonl` and
`squadron-*.index*`. Store copied trees as `measure-<repo>` and independent
stage copies as `stages-<repo>`. Read the metadata JSONs for source/counts.

The `.mjs.txt` files are retained **experiment source data**, not product/test
entry points. Copy `paired.mjs.txt`, `stages.mjs.txt`, `cold.mjs.txt` to the
scratch directory with `.mjs` extensions and run `node <script> <scratch>`;
`stages.mjs` additionally takes `baseline|candidate` and the repository name.
Cold runs require an owned 4 GiB sparse APFS
image mounted at `<scratch>/cold-mount`, containing independent repository
copies. Its script always detaches the owned image in `finally`.

Red-first evidence is under the shared Git directory's Squadron runs:
`2026-10-05T06-13-24.114Z-run-5294/test.log` (master reuse and native registration),
`2026-10-05T06-27-45.700Z-run-71789/test.log` (shutdown between Git commands).
The racy-clean test includes a valid synthetic index whose naive renewed
cutoff returns an old blob under default stat settings, then proves both safe
copy legs with real Git.
