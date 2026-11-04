# src/test

`node --test` against the compiled output in `out/` — no framework. Run with
`npm test`, or the whole gate with `npm run check`. Both run only the test files
the change since `origin/staging` can reach; add `-- --all` for every one.

Release verification can resume an immutable candidate explicitly with
`npm run release -- --resume <candidate-id>`. Ordinary check/test/smoke commands
still run their requested scope. `verification_checkpoints.test.ts` owns receipt,
authority and retention contracts; `test_results.test.ts` owns file-result attribution
and lifecycle evidence for `scripts/test-results.mjs`; `release.test.ts` owns actual Git
finalization/recovery; `timed.test.ts` owns archive timing and machine gating.
Smoke file completion aggregates every top-level section and requires root hooks
and supervisor cleanup. A resumed barrel loads only the outstanding scenario
files into one fresh host; Remote stays a single file and one checkpoint. A
per-file Node summary alone is not proof: on Node 23 it can say success after
a root-after failure. `scripts/test-results.mjs` makes that file decision.
`scripts/checkpoints.mjs` keeps candidate, job and gate ownership, and the
archived runner stays `runner.mjs` plus `verification_processes.mjs`. Details and history fields:
[`docs/workflows/release.md`](../../docs/workflows/release.md#verification-checkpoints-and-run-history).

Feature pushes run no tests. `npm run integrate -- <PR-number>` runs the gate
locally on an isolated proposed merge before requesting its PR merge. Its
`--base <staging-commit>` comparison is also available on `check` and `test`.
`tooling/integrate.test.ts` owns the command's Git/API boundary and uncertain
delivery behavior; `tooling/githooks.test.ts` owns local staging/main ref rules;
`tooling/release.test.ts` owns release's exact staging authorization. These
tests use disposable repositories and tiny fixture gates, never recursive
repository checks or real PR mutations.

**What `affected.mjs` counts as reaching.** A test runs when a changed file is
in its import graph, or in the webview bundle and the test imports
`ui/document.ts` or `harness.ts` (both load `out/webview/main.js` by path —
`RUNTIME_EDGES`). **A test that opens a file itself always runs**: anything in
its graph under `src/test/` matching `__dirname`, `path.resolve(`,
`process.cwd()`, a `'src/'`/`'dist/'`/`'docs/'`… literal, a bare `'docs'`-style
segment, or a `.md`/`.mjs`/`.html` file name (`READS_FILES`).
That is what covers a doc, fixture or root-script change, so a new test that
reads a path is safe without telling anyone. A new module that loads *compiled
output* by path is not: give it a row in `RUNTIME_EDGES`, or every test that
reaches it is missed. A build input (`package.json`, lockfile, `tsconfig*`,
`scripts/esbuild.mjs`) runs everything.

## Layout

The root holds shared machinery only: `helpers.ts`, `home.ts`, `harness.ts`,
`mascot_busy.ts`, helpers imported by three or more folders, `fixtures/`,
`smoke/` and `live_session/`. Recordings consumed by tests belong in
`fixtures/cli_state/`, with their CLI version, observation date and sanitization
recorded beside them. Build inputs live in `scripts/assets/`, not `docs/`.
One folder holds one concern. A basename keeps
its prefix, so it stays unique across the tree. A single-file test goes in
the folder of the contract it asserts. There is no leftovers folder. A
helper used by one or two folders lives with its main user.

**Routine live tests use cheaper models at low effort.** Use Sonnet for Claude,
an available Grok model (no particular version required), and Luna for Codex.
Do not use Opus, Astra, Sol or other higher-cost models for ordinary live tests.
Use `low` effort where supported, or the nearest supported lower effort; resolve
actual model IDs and effort choices from the current CLI/catalog before launch.
Higher-cost models or higher effort are exceptions only for complex test
scenarios or actual benchmarks. Record the reason, model and effort with the
test evidence. This applies to real test sessions, model-backed CLI probes,
scratch scripts and dev-host hand-checks, including outside this directory. It
does not select the model of the agent implementing or reviewing the change.

Tests run headlessly against the real machine: they point the home at a temp
directory, write session files into it, and spawn a symlink named `claude` so
liveness checks have something true to find. The temp-home sandbox is `home.ts`;
`helpers.ts` re-exports it. A progress test imports the sandbox from `home.ts`.
A progress test goes in the file of its owner: `progress_store.test.ts`,
`progress_display.test.ts`, `progress_briefing.test.ts` or
`progress_execution.test.ts`. Fixtures those files share go in
`progress_helpers.ts`. Do not add a barrel.

## Windows

The same suite targets Windows. The 2026-10-31 current-candidate full gate passed:
9,563 tests, 9,484 pass, zero fail, 66 skips and 13 TODOs. The receipt is
`<git-common-dir>/squadron-runs/remaining-smoke-repairs-2026-10-31/final-receipt.json`;
the [MCP plan](../../docs/tasks/TASK_verifying_windows_mcp_login.md#bounded-remaining-smoke-repairs---2026-10-31)
records the tested baseline and remaining acceptance limits. Historical reds
remain evidence. Write a test so that it holds
on both platforms. A red that appears on only one platform is still a red.
Every rule below was paid for in
`docs/tasks/TASK_done_windows_test_prep.md`.

- **Home.**
  - Move it only with `tempHome()`, which sets `HOME` and `USERPROFILE`.
    win32's `os.homedir()` reads the second, and a run that set only `HOME`
    deleted a real `~/.squadron`.
  - Give a child process `homeEnv(home)`.
    It also supplies `TMP`, `TEMP` and `TMPDIR` under that home. Fixture bases
    are captured before overriding these variables, so repeated `tempHome()`
    calls create siblings. Direct compiled-test runs retain these guards.
  - Smoke's home is under its run root, outside `homeEnv`'s base, so its
    worker and children take `boot.homeVars()`.
  - Lint (`squadron/home-write`) refuses a `HOME` or `USERPROFILE` key in an
    object literal, computed literal keys included, and an assignment to one.
    That covers the whole of `src/test`. Reads, `delete`, and an
    `Object.assign` of a captured env snapshot pass, and `homeVars()` is its
    one disabled line. The rule sees syntax only. A key built at runtime is
    not seen. A replacement `env` with no home key is not seen either, and
    that child falls back to the real home.
  - Recursively remove a directory the product computed only through
    `resetDir()`.
    It requires a normalized absolute path below a registered home and refuses
    link/junction components before deletion. Runner cleanup waits for child
    close and retries locked fixture removals within a bounded budget.
  - Reach anything that imports `core/paths` through `await import()` after
    `tempHome()`, which throws when that order is broken.
  - `affected.mjs` also runs every test process in a sandbox home. Treat that
    as the net, not the rule.
  - Installed Chrome under a moved home needs `<home>/AppData/Local` created
    and passed as `LOCALAPPDATA` in its launch environment.
- **Paths.**
  - A literal like `'/repo'` that means "some absolute path" goes through
    `path.resolve('/repo', …)` or `path.join`. That is the same string on
    POSIX and `C:\repo` on win32.
  - A macOS-shaped *input* the product parses (a CLI-recorded cwd, a slug)
    stays as written: it is the contract.
  - A temp directory is `fs.mkdtemp(path.join(os.tmpdir(), prefix))`.
    Lint (`squadron/temp-root`) refuses an fs `mkdtemp` whose prefix starts
    with an absolute literal, template, `+` or `join`/`resolve` root.
    An injected fake fs passes. A Unix socket root that has to stay inside
    Darwin's path limit is the exception, and it is disabled on its line.
  - Never assert a separator. Use `[\\/]` in a regex, `path.basename` in place
    of `endsWith('/x')`, and `JSON.stringify(p).slice(1, -1)` when pasting a
    path into raw JSON text.
- **Links.** A directory link is `linkDir()`, a junction on win32, which needs
  no privilege. A test about a symlinked *file* takes
  `{ skip: needsFileSymlinks() }`, because win32 makes one only with
  Developer Mode or elevation.
- **Processes.**
  - A fake CLI or fixture is a node script run through `process.execPath`.
    win32 runs neither a `#!/bin/sh` file nor anything under `/bin`.
  - A `timed.mjs` step string must parse in both sh and cmd.exe: `node x.cjs`
    and double quotes, with no `;`, `$VAR`, `exec` or single quotes.
    For arbitrary argv use a JSON array step (`name=["node","script.cjs"]`)
    and `--` before forwarded arguments. `scripts/verify.mjs` constructs these
    arrays for npm's check/test/smoke/dev-host compilation commands; slow mode
    sets its environment there.
  - `fixtures/invocation.ts` is a model-free Node argv/stdin/env/exit oracle.
    `hold` prints `ready` and waits for `release\n`, with a maximum five-second
    deadline. It is not a native executable-classification fixture.
  - On Windows, unknown gate ownership or a lost coordinator retains exclusion;
    admission failure exits 75. Do not delete an unknown holder to make a run
    proceed. A console Ctrl-C, Ctrl-Break (SIGBREAK, handled like SIGINT) or
    close reaches every process on that console, so neither `verify.mjs`,
    `timed.mjs` nor smoke's runner forwards it there:
    `kill` on win32 is TerminateProcess, which would end the supervisor before
    it reaps. Wider gate recovery (dead parent, live grandchildren) remains
    tooling Step 3.
  - Nothing reads `/bin/ps`. win32 reads the native table (processes Step
    6); `fakeClaude`/`fakeGrok`/`fakeShell` are copies of `PING.EXE` named
    for the brand or shell. A Claude pid file names its start with
    `procStartFor(ms)` (FILETIME on win32). Incoming cases supply the candidate through
    `incomingPlatformFixture(home)` for unbundled consumer tests. Bundled copied-CLI
    tests install and consume the real helper locator. Any win32 label names
    its own remaining cause. A test that supplies its own tables builds the
    Windows backend with `tablesSupplied(kill)`.
  - A suite that calls `tempHome()` removes it with `disposeHome(home)` in
    its own `after`, once its children (`await fake.stop()`) and writers
    have closed. A direct `node --test` has no sandbox sweep behind it.
- **Filesystem behaviour that differs.**
  - `chmod` does not make anything unreadable or unwritable on win32, so a test
    that uses it as the failure trigger takes `modeBitsSkip`.
  - mtime moves in timer ticks of about 1–16 ms, so "did it write" is never
    `mtimeMs` equality. Pin the mtime to a sentinel after the expected write
    (`stamped()` in `usage.test.ts`).
  - Two overlapping renames of one file can both succeed (W6.5).
  - Opening a directory succeeds and reads as empty (W6.3).
  - git reports a file's creation time as its ctime.
- **Every skip and todo reason opens with where it fires.** `win32`, `darwin`,
  `linux` or `posix` (darwin and linux), or a list (`win32, linux:`); `env:`
  for the machine or the run (root, no Chrome, an earlier step failed);
  `capability:` for a case under test that lacks what the test needs. The
  grammar is `scripts/skip-scopes.cjs`. Lint (`squadron/skip-reason`) refuses
  a bare condition, `skip: true`, `it.skip()` and an unscoped literal, in the
  options object, in `t.skip()` and in a constant named `…Skip` or `…Todo` —
  name a reason holder that way, or lint cannot see it. `npm test` prints
  `ℹ skipped by scope: posix 1` after the dots, skipped `describe`s included;
  `grep '# posix:'` on the run's `test.spec.log` names the tests. Smoke's
  runner prints no such line.
- **Sorting a red that only win32 shows.** Each reason starts `win32:`, so
  `grep -rn "win32:" src/test` lists what is left. A gap in the port also
  names its row in `docs/tasks/TASK_inprogress_windows_support.md`; a
  POSIX-only contract has no row to name.
  - A harness assumption is **ported** until the assertion means the same on
    both platforms.
  - A POSIX-only contract is **skipped**:
    `{ skip: testPlatform() === 'win32' && 'win32: <why> — <row>' }`, using
    `testPlatform` from `helpers.ts` for all test OS reads. The read itself is
    in `home.ts`. Lint holds that
    (`squadron/os-read`); its limits are in `docs/reference/os_seam.md`.
  - A missing Windows implementation is a **`todo`** of the same form, never an
    edited assertion. It is that row's failing control: the row's fix removes
    the `todo`, and the test has to pass.
  - Put a `todo` on the `describe` when the suite's `before` builds the
    fixture, because a failing hook outside a `todo` fails the run.
  - A case that can hang (a wait with no deadline, a signal win32 never
    delivers) is a skip, not a `todo`.
- **Smoke on win32.** `npm.cmd run dev:host` and one compiled scenario
  (`bottom_hub.smoke.js`) boot stock VS Code there, with normal close and
  console Ctrl-C and Ctrl-Break reaped by identity (tooling Step 5 Notes,
  2026-10-27). The normal stock VS Code 1.144.0 barrel passed on 2026-10-31:
  243 tests, 238 pass, zero fail and five explicit platform skips, in the same
  receipt as the full gate above. These skips and the plan's named acceptance
  limits remain open. Playwright runs
  the launcher through `cmd.exe`, so it is `launch.cmd`; the fake CLIs are
  npm-shaped `.cmd` shims naming a sidecar entry (`writeShim`).
  `release`/`publish` need W8.3; their tests are skipped and say so.

The panel's UI is tested without the IDE. `harness.ts` loads the real
`panelDocument()` document — markup, CSS, inlined compiled script — under jsdom,
stubs `acquireVsCodeApi`, and drives it with `PanelMessage`s the way `panel.ts`
does (`board_*.test.ts` + `board_helpers.ts`, `dock.test.ts`, `chat_*.test.ts`,
`question.test.ts`, `question_replay.test.ts`, `tickets_ui.test.ts`). Board
scenarios are one surface per
file (`board_card`, `board_nav`, `board_chrome`, `board_actions`, `board_morph`,
`board_family`, `board_arrange`, `board_servers`, `model_picker_gear` for the
gear settings, `model_picker_draft` for the draft pill and its seed,
`model_picker_menu` for the model menu and `model_picker_effort` for the effort
pill); drag/`COPY` helpers that more than one of those reach for live in
`board_helpers.ts`, and the model picker's shared readers live in
`model_picker_helpers.ts`, which registers nothing. Chat is the same idea:
the dock's thread is `chat_head`, `chat_escape`, `chat_turns`, `chat_calls`,
`chat_writes`, `chat_links`, `chat_sanitize`, `chat_turn_pills`,
`chat_user_turns`, `chat_echo`, `chat_outbox`, `chat_notices`, `chat_folds`,
`chat_time` and `chat_place`, beside `chat_composer`, `chat_media` and
`chat_workflow`; fixtures more than one of them needs are in `chat_helpers.ts`.
`openThread()` and `enter()` live in `harness.ts` rather than in one of them,
because the dock suites all reach for the same two. The mounted workflow editor
is four surfaces: `workflow_editor_form` (open, save, delete, leave),
`workflow_editor_canvas` (grid, grip, lanes), `workflow_editor_wire` (a wire)
and `workflow_editor_chip` (the model and effort chip). The shared readers live
in `workflow_editor_helpers.ts`, which registers nothing.

The bottom drawer's modes are a surface each: `warm_hub` is Warm,
`remote_sheet` is Remote (its bar word, its setup and its guide included) and
`awake_sheet` is Keep-awake.
`remote_view` pins every word Remote says, headless, off the mapper in `ui/`.

**Where a UI test goes.** An agent changing one surface reads the file named
for it — a few hundred lines, not the 3,500 `chat_thread` had grown to before
it was cut up on 2026-10-08 — and a new test has one obvious home.

A surface is what the reader sees and an agent would search for: a part of
the dock (`chat_head`, `chat_outbox`), or one concern spread across it
(`chat_escape`, `chat_sanitize`).

1. A test lives in the file of the surface its assertion is about. One that
   asserts two surfaces, each of which stands alone, is two tests in two files.
   A test of what an action does stays with the action even when the result
   is painted elsewhere: the interrupt's refusal is shown in the composer, and
   its test is in `chat_head`, where the interrupt is.
2. A test whose point is the handoff between surfaces — both move together, or
   in an order — goes in a file named for that flow: `chat_echo` is a send
   handing over from its echo to the turn that replaces it. A coordination test
   no named flow fits goes in `<area>_flows.test.ts`. A flow file earns its own
   name at about five tests; below that it waits in `_flows`.
3. Setup that more than one file needs goes in `<area>_helpers.ts`, or
   `harness.ts` when every dock suite reaches for it. No barrels: `npm test`
   runs each test file in its own process, so a barrel test file runs
   everything twice, and a re-export file is a second spelling of every helper.

A change that touches a surface file and its flow file is the layout working.
When routine changes to one surface keep touching two *surface* files, the cut
is in the wrong place; merge them. `affected.mjs` lists every `*.test.ts`
under `src/test/` at any depth and runs each from the same relative path under
`out/test/`.

`reconcile.test.ts` uses native node:test timer mocks for scheduling,
isolation, cancellation and in-flight disposal; no host or wall-clock sleep.

`remote_flows.test.ts` is Remote's flow file: every PRD scenario with the
sessions in one window and the bridge in another, once per brand, against real
fake CLIs, real request files and a real holder file. `remote_helpers.ts`
builds the two windows — `testWindow` (a registry of real handles served by
`claimRequests` and `serveOwned`) and `holderWindow` (the same plus
`RemoteSwitch`, the class the host runs, over the fake messenger, driven by
explicit `pass()` calls, with `arms` for a kind M3 adds). `remote_switch.test.ts`
drives that class alone, over ports a test holds, for the orderings no two
real windows can arrange. Each window's extension host is a bounded Node child with a readiness/release
handshake (`fixtures/held_process.ts`), because
the holder names a host by pid and start, and every window here shares one
process. `remote.smoke.ts` is the same handoff in two real windows.
`incoming_cache.test.ts` owns managed incoming byte accounting for
`core/remote/incoming_cache.ts`. Conversation persistence stays in
`bridge_store.test.ts`. The engine suite is five files.
`bridge_engine_notice.test.ts` is what the engine posts: notices, a post it
still owes, a root that stops or closes, and the board a cut pass hands over.
`bridge_engine_catch_up.test.ts` is the gap, one describe and its own
heard-file wipe. `bridge_engine_session.test.ts` is replies and buttons, an
End the bridge carries out, a remote-spawned lifetime, a root it just started,
and `bridge.stop`. `bridge_engine_picker.test.ts` is the picker, shared folder
names, mentions, the list command, and the link.
`bridge_engine_files.test.ts` is attachments, the credential sentinel, and a
thread the engine joins. `bridge_engine_helpers.ts` holds the shared boot and
readers and registers nothing. `bridge_notify.test.ts`, `bridge_picker.test.ts`,
`bridge_store.test.ts`, `bridge_scenarios.test.ts`, `bridge_lifetime.test.ts`
and `bridge_thread_file.test.ts` keep their own suites.

## CLI test ownership

Brand-owned entries use `<brand>_<concern>.test.ts` and live in that brand's
folder; the same concern has the same name across brands where coverage
exists. A missing counterpart is not a reason to invent tests.

| Concern | Entries |
| --- | --- |
| Owned lifecycle, thread and warm turns | `claude_session`, `grok_session`, `codex_session`; each brand's `_thread` and `_warm` |
| Checkpoints and outcomes | Each brand's `_checkpoint` and `_outcome` |
| Wire mapping | `claude_reduce`, `grok_reduce`, `codex_reduce`; approvals/questions in `_asks`, plus `grok_permissions` |
| Stored reads and live projection | Each brand's `_transcript` and `_tee`; Claude `_transcript_blocks` / `_transcript_writes` / `_transcript_images` / `_transcript_stats`, Grok `_transcript_images` / `_tee_flows` |
| Discovery and accounts | Each brand's `_discover`, `_auth`, `_usage`, `_mcp`; Claude/Codex `_models` |
| Claude facilities | `claude_adapter`, `claude_context`, `claude_checklist`, `claude_hooks`, `claude_jobs` |

Shared contracts retain shared names: `adapter` covers the registry and source
selection; `adapter_attribution` covers shared checkpoint/execution attribution;
`live` covers session/card state and maintenance, while `live_outbox` covers
queue/delivery identity and correlated settlement; `transcript` covers shared write
and maintenance helpers; `session` covers launch files; `auth` covers account
polling/rows/browser policy; `usage`, `catalog`, `model_names` and `checklist`
keep their shared rules. A Claude-shaped fixture does not make a shared
contract Claude-owned. `prose_images` tests the shared parser directly.

Session suites explicitly call their brand's `session_helpers.setup` and
`dispose` from their own hooks. Reader/projection helpers follow the same rule:
helpers register neither hooks nor tests. Move the home before loading runtime
modules that reach `core/paths`; keep handles and teardown within each test
process. `live_helpers` retains the existing Claude wire fixtures used to
arrange shared state and decoder tests; the asserted contract decides ownership.
Never import a `.test.ts` from another entry.

`fixtures/fake-cli.ts` is a `claude` that costs nothing: it reads stream-json on
stdin and writes canned frames back, so `claude_session.test.ts` drives the real
`childTransport` against a real child process with no account, no network and no
cost. It is compiled with everything else and spawned as
`out/test/fixtures/fake-cli.js`, and its frames keep the CLI's own field
spellings — a fixture that agreed with our reader instead of with the CLI would
pass while the real thing failed.

`fixtures/fake-acp.ts` is the same idea for Grok: JSON-RPC ACP on stdio, spawned
as `out/test/fixtures/fake-acp.js` by `grok_session.test.ts`. Handshake and stream
shapes are from `docs/reference/cli_state/grok/protocol.md` (1.0.4).

`fixtures/fake-grok.ts` is the smoke `grok` binary: `login` / `logout` /
`models` for accounts, and everything else forwarded to `fake-acp`. Boot
drops it in the profile and names it in `squadron.grokPath` — not at
`$HOME/.grok/bin/grok`, which `grokBinary` would find whether or not the
setting were read, leaving the lever untested. Do not add those subcommands to
`fake-cli.ts`.

A test that runs `git` must strip `GIT_*` from the environment it passes down —
see `CLEAN` in `release.test.ts`. A gate can inherit a git hook's environment,
and git exports `GIT_*` variables into a hook
pointing at this repository; they beat `cwd`, so a temp-repo command silently operates on
this checkout instead. It shows up as `error: invalid object ... for '<file>'`
from the very commit that is running the tests.

**`live_session/` is prompts, not tests.** Markdown a human pastes into a fresh
session, which then drives the real product — spawning peers, messaging them,
reading what came back. Nothing runs it automatically and nothing should: every
scenario costs real tokens, and several validation rows are things only a person
looking at the panel can check. It exists because the two worst defects in the
cross-session verbs were invisible to the whole unit suite *and* to smoke — both
were one process disagreeing with another about a file a third had written.
Weekly, and before a release. `live_session/README.md` has the shape a scenario
takes and the two rules they all follow.

**One thing here launches the IDE, and `npm run check` never runs it.**
`smoke/` drives a real IDE binary with Playwright, and holds only what needs a
host — behaviour coverage belongs in the jsdom suite above.

```
smoke/
  boot.ts            the host: launch, reset between sections, relaunch, teardown;
                     the fixtures, their seed, and the profile; `section`/`step`
  dev_host.ts        shared preflight: close prior repo/worktree dev hosts; manual launcher
  ide.ts             which stock VS Code: `SQUADRON_IDE` alone, else the OS's install;
                     its version from either bundle layout
  ownership.ts       smoke-only socket (named pipe on win32) ownership, process
                     witnesses and confirmed reap; win32 kills only through
                     `platform.processes.signal`
  launcher.ts        pre-exec registration helper; runner writes private launch.sh
                     (launch.cmd on win32)
  runner.ts          outer supervisor: worker loss, signals and bounded shutdown
  cleanup_peer.ts    harmless subprocess fixture for headless ownership tests
  cleanup.smoke.ts   independent fault oracle, opt-in; never imported by e2e
  cleanup_fixture.ts compiled boot lifecycle cases controlled by that oracle
  capture.ts         bounded Node copy child for evidence, closed before HOME reset
  seed.ts            sequential seed restoration and file drift, host paths excluded
  onboarding.smoke.ts first panel with no detectable CLI, through real host —
                     and that the slides' screenshots actually decode
  kit.ts             the board readings more than one scenario reaches for
  panel.smoke.ts     the panel arriving, chrome from disk, card height across a
                     retitle, theme pick kept for the opened folder, the
                     sound row's two settings
  nav_loading.smoke.ts first CPU arrival on an idle board, loading animation
                     continuity across pushes, reduced-motion CSS
  warm.smoke.ts      Warm on the bottom drawer: a flip through the host
                     by pointer, the open frame on screen, and each column
                     scrolling on its own with New sessions staying put
  awake.smoke.ts     Keep-awake on the bottom drawer: the open frame on
                     screen with the master switch beside the figures, and both
                     switches through the host into settings.json
  agents.smoke.ts    Agents on the bottom drawer: the hub word reachable by
                     pointer opens it, and Orchestration flips through the
                     host into settings.json
  mascot.smoke.ts    where the chick sits: its feet on the bar's top edge,
                     on the open sheet's and again when the sheet changes
                     height, and on a card's before and after the board
                     re-slots
  warm_card.smoke.ts active ping footer: stable geometry and animation identity,
                     hidden/off-screen pauses and reduced motion in both themes
  dropdown.smoke.ts composer model/effort border parity at rest, hover, focus
                     and open; captures the rendered composer for inspection
  editor_foot.smoke.ts an open step's Remove and Done, as boxes — jsdom has
                     the order and none of the edge
  footer_mode.smoke.ts the permission word sits on the branch; the context
                     reading keeps the strip's right end — jsdom has the
                     order and none of the boxes
  editor_canvas.smoke.ts the canvas's gestures in sequence — lane rename, `@`
                     pill, Remove, chip menus, grip drags, the delete lock —
                     with every wire end read against its cards after each
  workflow_repair.smoke.ts a hand-broken file on disk, through the real poll,
                     into the sheet and the editor, then a repaired file loses
                     its repair mark on the next poll
  workflow_wait.smoke.ts dependency waits stay asleep through idle and
                     intermediate steps, then a progress-file change wakes
                     the requester once, through the real host
  execution.smoke.ts bundled scoped hook admission through the stock host:
                     precise shell pill/gap exclusion and same-runtime off fallback
  wait_deadline.smoke.ts quiet finite owned WAIT: expiry without a member event,
                     one wake, action and record removal; included in barrel
  cafe_lease.smoke.ts opt-in real ten-minute refill/overlap, off release,
                     idle retention/natural lapse and combined host shutdown
                     including -w. Runs alone, outside barrel
  remote.smoke.ts    Remote across two real windows of one instance (the second
                     by the IDE CLI's `--new-window`): a credential through the
                     input box, the holder refusing B, a folder pick starting
                     in B, finish/reply/finish, Deny, Stop, the installed
                     `squadron-attach` from B through A (and refused with
                     Remote off), End, A's close freeing the holder, and no
                     credential on disk. Runs alone,
                     outside barrel and release
  remote_panel.smoke.ts Remote as the panel drives it, fake messenger: the
                     word's dot through every link state, a token through
                     the host's box and its check, an account into settings,
                     a pressed check's failure across two polls and a
                     reopen, the holder of a live `sleep` refusing and its
                     death taken over, the switch staying put while setup
                     scrolls, the guide over the drawer, five words on one
                     bar, an account the messenger refuses and the space a
                     check fills, no token in the document or on disk. Runs
                     alone, outside barrel, in release
  readme_shots.smoke.ts not a test: the README's screenshots, retaken. Made-up
                     state pushed into the real panel and its frame shot at
                     3000x1640 into `media/` (or `SQUADRON_SHOTS`). Runs
                     alone, outside barrel and release
  workflow_examples.smoke.ts opt-in installs every skill and its references;
                     installed workflow validation checks a candidate without a run;
                     activation installs both packaged examples;
                     ordinary editor and Delete work; reload keeps them deleted
  request_origin.smoke.ts request-file legacy/explicit admission, independent holder
                     requirement, accepted-action recording and lineage through the host
  models.smoke.ts    installed model-discovery CLI, configured accounts with
                     the panel closed; runs before panel.smoke in the barrel
  asks.smoke.ts      an answered ask, replayed off the fixture transcript
  thread_table.smoke.ts a table wider than the dock scrolls inside itself, and
                     the thread does not pan
  diff.smoke.ts      a pill's counts: the hue they resolve to, and the tab they
                     open — against HEAD, re-read, and with the file gone
  session.smoke.ts   one owned session's whole life, in sequence
  composer_editor.smoke.ts the composer's native editing, its own child
  session_end.smoke.ts End, exit, pipe-error and family sections, each
                     its own session
  thread_acquisition.smoke.ts owned streaming acquisition through growth and
                     completion while its record is unreadable; fake pipe,
                     real host, isolated section
  thread_refresh.smoke.ts independent thread publication, model-free CPU/RSS/
                     payload/DOM latency fixture, hide/reconstruction recovery and
                     selected growth during unrelated metadata churn
  failed.smoke.ts    a refused turn reads failed across a refresh and a panel
                     reopen, and the next turn clears it
  grok.smoke.ts      Grok New from a model id; resume from the picker; a
                     permission Allow on that card; typed grok draws nothing
  codex.smoke.ts     Codex New → stored thread → resume; running-row reveal
  tickets.smoke.ts   a ticket dragged onto New — starts a session of its own
  servers.smoke.ts   a dev server, booted and stopped; the ambiguous tree's scripts
  monorepo.smoke.ts  which app in a monorepo boots — the host half of the sheet
  notices.smoke.ts   status-bar vs toast for routine confirmations
  accounts.smoke.ts  accounts popover, login/sign-out sheets, pipe Log in CTA
  mcp.smoke.ts       MCP sheet from real Claude + Grok files; login child
  e2e.ts             the barrel: every scenario in one process
```

Windows server smoke covers picker geometry, script/app discovery, the
experiment toggle and a session server through its chip and ✕. Terminal boot
has a specific W7.4-W7.5 skip; that skip does not establish parity. The Windows
pipe-error scenario in `session_end.smoke.ts` compiles `fixtures/closed_input_native.cs`: native
`CloseHandle` establishes EPIPE while the child stays alive, which Node fd-0
close and stream destroy did not establish on 2026-10-31.

**A scenario that pushes its own `state` holds the host's with
`boot.holdingHostState`.** A hold added from `evaluate` runs too late — why:
`gateHostState` in `boot.ts`.

**Read the red run's printed folder before re-running.** `timed.mjs` copies each
step's complete output to `<step>.log`; unit runs show dots and failure details
in the terminal, with the full spec listing in `test.spec.log`. Smoke keeps spec
progress in the terminal. Never pipe test or commit output through `head`/`tail`.

A failed smoke step prints `evidence: <folder>` before reset or teardown. Read:

- `screenshot.png` and `workbench.txt`: what covers the board — host dialogs,
  notification toasts and the command palette, as well as the panel's pixels.
- `panel.html`: the panel's actual overlays and state at failure.
- `error.txt` and `console.log`: the original error and the last 500 console or
  page-error events since load, timestamped with source URLs where available.
- `host-logs/`: the host's live `data/logs/`, including renderer, extension-host
  and `output_logging_*/*-Squadron.log` output. A healthy output channel can be
  empty; copying it does not force a flush.
- `home/` and `claude-argv.jsonl`: fixture state and the fake CLI's launch flags
  before cleanup. The live HOME is still restored or discarded; this copy stays.
- `capture.log`, when present: which pieces were missing or exceeded their bound.
  One missing piece is not a second test failure; capture is best-effort.

A Node-abandoned step is captured by the section's first `after`, before the
file's cleanup; its folder prints there and in the runner's final block rather
than in Node's already-reported timeout error. Captures have 1.5 s per-piece
bounds within a 3 s budget, shortened near a step's deadline. Green runs write
no `smoke/` folder. The newest 20 runs are kept; an older live runner is protected
until it ends. The timings line's `alongside.start` / `alongside.end` and `load`
answer whether another checkout was compiling or smoking while this one failed.
Release candidates keep their run folders in the checkout's shared git directory,
so removal of the scratch extract does not remove their evidence.

**Each file is a `section`, and no section can reach another.** `section` and
`step` (`boot.ts`) stand where `describe` and `it` would, and they buy two
things:

- **The first red in a section skips the rest of it.** A section counts the
  steps it started and the steps that finished; a step whose predecessor never
  finished — a throw, or a timeout, where node:test abandons the promise and
  nothing throws at all — reports skipped instead of waiting out its own 30 s
  on a premise that is gone. Every step also has a ceiling (`STEP_MS`, 120 s),
  because a wedged drag hangs a process rather than reddening it. **The cost is
  accepted, not overlooked**: in a 31-case file like `session.smoke.ts`, one red
  hides the other thirty, so two independent bugs take two barrels.
- **Every section after a host's first starts on a reset host.** Escape, mouse
  up, terminals killed, the bottom panel and every editor shut, `settings.json`
  rewritten to the launch object, `HOME` put back from a seed `boot.ts` cloned
  after planting and before launch (Node restore with deletion), and the window
  reloaded — then the new host's claim awaited, the old one's removed, and the
  `squadron-step` shim awaited. The reset's commands are keys bound in the
  profile's `keybindings.json` (`RESET_KEYS`) rather than palette text.
  **A section that went red gets a new IDE instead**, and so does a host that
  died or a reload that cannot finish in 45 s (a modal, a wedged drag, a page
  that swallows keys) — one path for dead and wedged alike. Teardown and
  relaunch ask a supervisor outside the worker to snapshot before graceful
  close and confirm an identity-checked reap before deleting or reusing paths.
  Worker death bypasses hooks, so the outer supervisor owns every launch before
  Electron starts, through an acknowledged shell that then execs stock VS Code
  (on win32, Playwright's `cmd.exe`, which starts it as its second child). **Only steps count toward red**: a file's own `after`
  that fails (a sign-out, an end) still leaves the next section a reload, not a
  new IDE — the reload shuts what such an `after` is likely to leave. And a
  step that timed out is abandoned, not stopped: its promise can keep reading
  `ctx.page` after a relaunch has replaced it. Every retry loop here is bounded
  by Playwright or the filesystem, so nothing drives the new host for long.

What a reload measurably leaves, and why each step of the reset is there
(`TASK_done_smoke_sections.md`, Step 1): owned children die with the
extension host (`deactivate()` → `closeAll()`); **editors come back**, so they
are shut first; **a dev server's terminal comes back holding its port** unless
`terminal.integrated.enablePersistentSessions` is off, which the launch
settings now say; and **the old window's claim stays**, live on its timestamp
for 90 s, which would read as a second window to anything routing by claim.
What the reset does not clear, and is listed rather than chased:
`workspaceState` in the profile's `state.vscdb` (the café's position,
`tickets.filter`) and workbench layout past the bottom panel. The reset logs,
rather than fails on, any file `HOME` still differs from the seed by after the
reload — `.zsh_history` after a section that killed a terminal is expected.

`asks.smoke.ts` reopens a question somebody already answered, off the same
fixture transcript `diff.smoke.ts` reads. jsdom holds every rule about what the
record draws (`question_replay.test.ts`, `a replayed question`) against a view a test
wrote; this holds the half under it — a `toolUseResult` in the CLI's own shape on
disk, through `core/transcript.ts`'s walk and `ui/activity.ts`'s fold, to a pill
on the thread and the layer it opens. The shared fixture card and not a child of
its own, because that transcript is written once in `boot.ts` against a tree
`boot.ts` also commits, and a second child would need a second copy of both.
`notices.smoke.ts` rewrites that transcript down to a single entry; the reset
puts it back before the next section, whichever file that is.

**`kit.ts`'s `fixtureSession()` is that card, and it is an owned session.** It
was a fixture on disk until row 71 — a live `claude` pid, a `sessions/<pid>.json`
saying `entrypoint: 'sdk-cli'`, and no published record — which the board drew
because a piped session whose record never landed was the degraded case row 53
kept. That row's successor draws the sessions this window started and background
ones, and nothing else, so the card has to be a real child of this host. Three
things the old fixture gave for free and how each is kept: its **name** comes
from the stated-name store, which is where a rename from outside this window
lands, so every locator still finds it by `smoke session`; its **transcript** is
`boot.ts`'s, planted under the id this fixture resumes, so recovery acquires
its five turns before the pipe's first send; its **liveness** is a real
child rather than a `sleep` a slow barrel can outlive. Memoised within a
section, and dropped by every reset (`onReset`), since the reset ends the
child: each section that asks pays for one (~3 s), and the panel must already
be open when it does.

`accounts.smoke.ts` also holds the one usage claim only a host can answer: a
figure written to `usage.claude.json` by another process reaching the chip,
through the `STATE_DIR` watcher and the mirror that drops itself on it. Nothing
in that path is the process asserting it, and jsdom has no watcher at all.
The chip is last-idle, not first signed-in, so that case idles the Claude
fixture first.

`accounts.smoke.ts` drives Claude `auth` through `squadron.claudePath`
(`fake-cli.js`) and Grok `login` / `logout` through `squadron.grokPath`
(`fake-grok.js`). Default is signed-in for both so the nav ladder still has
a usage `.lim`. Claude-out / Grok-in stays a usage chip (`5h none`); Log in
only when no live brand is signed in. jsdom covers canned paints in
`accounts.test.ts`.

**`vscode.env.openExternal` cannot be watched from here, measured 2026-09-12
against VS Code 1.137.** It reaches the real machine, so a sign-in in a barrel
run is a sign-in on the operator's browser — and `workbench.externalBrowser` is
not the lever that catches it. Pointed at an application bundle whose executable
logs a line per launch, that bundle recorded nothing: not for the host's own
open, and not for the sheet's *Open browser* click, which is a path older than
any of this. The same bundle logged every time under a plain `open -a`, and the
host's `main.log` reported no failed launch to account for the gap — so the call
is being lost above the main process, wherever that is. Which brand opens a tab
is therefore a claim `auth.test.ts` holds off `CliAdapter.loginOpensBrowser`,
and a scenario that would open one is better left unclicked, as
`servers.smoke.ts` leaves its link, than counted. The counter that read this out
was written and reverted (`8a94ee85`); do not build it again without a new
measurement.

`boot.ts` registers its `before`/`after` on the **importing process's root
suite**, and `require` evaluates it once — so a scenario file run alone boots a
host of its own, and the barrel boots one for all of them. That is the whole
mechanism, and it is what lets a task run the smoke it cares about:

```sh
npm run test:smoke                                       # the barrel, ~6 min
npm run test:smoke:one -- out/test/smoke/servers.smoke.js  # one file, ~4s
```

**The barrel's count is worth trusting rather than eyeballing.** Measured
2026-09-24, the first barrels with sections: **114 tests**, 345 s and 405 s,
with other sessions pushing the load from ~5 to 22 and 38 during them — the
resets (a reload, or a new IDE after a red) are part of that. Before them,
2026-09-15: **107 tests**, 252s. Row 71 moved three: `notices.smoke.ts`'s
unroutable interrupt left — no card on the board can reach `UNROUTED` now except
by a race with its own end — `panel.smoke.ts` gained the negative that is
the whole of that row, a session another window *owns*, record and all, drawing
no card, and its second review gave `servers.smoke.ts` the same shape one layer
down: another window's *server record* drawing no row of ours. Both were proved
able to fail before they were kept, and both take a real fixture rather than a
composed view.

**`session.smoke.ts`'s *lifts the newest prompt to the top of the thread* flaked
once under load, 2026-09-15**, and is written down because it looks like a
regression and is not. It failed in **730ms** with `'tail 3' !== 'tail 2'` — the
bar read before the scroll had settled — in a 252s barrel, and passed in 8078ms
running that file alone. Baseline barrel at `8fde91dc` green, the same tree
green on the next barrel, and the scenario runs *before* the one added that day
(`e2e.ts` imports `session.smoke` at 44 and `servers.smoke` at 54), so it cannot
be downstream of it. A green on retry does not clear a race: if this comes back,
the thing to widen is the wait in front of that bar read, not the assertion.
(2026-09-06: 101 tests, 219s, with the other sessions on this machine idle —
the six over 08-31 are the draft's own (`TASK_done_draft_new_session.md`),
and the wall clock is up because every New now types a first turn before it
spawns. Two of the six are the gear's model-flyout placement pair, which came
back with the `Default model` row; the composer's pill has its own beside them,
and the two geometries are different code. 2026-08-31: 95 tests, 158s.) (2026-08-28: 89 tests, 190s. 2026-08-27:
88 tests, 158s. 2026-08-20: 84 tests, 157s, on a machine also running a
`check`.) Six scenarios landed after 08-28; C4's one
Codex lifecycle costs about six seconds and covers New, durable history,
resume, and running-row reveal.

**The count is the figure. The wall clock is a floor, not an expectation.**
The then-current 91 tests were read three times on 2026-08-29 at **157s, 188s and
386s** — a 2.5× spread with the suite unchanged, the slowest inside a `deploy`
while other sessions were working. So a run at twice the number above is not
evidence of a hang, and the 190s against 158s across 08-27/08-28 is load rather
than a scenario anybody added: before this, two readings a day apart were being
compared as though they measured the same thing.

It read `~23s` until these measurements began, from a run with a fraction of
these scenarios, and that gap is not cosmetic — a reader who believes 23s treats
a normal run as a hang and starts killing it, which is how one afternoon went.
Restate the count when it moves noticeably; restate the time only when the
floor moves, and say what else the machine was doing. Every barrel since
2026-10-01 is already written down, load beside it, in the log `timed.mjs`
keeps (root `AGENTS.md`, Test) — read the floor off that rather than one run.

**There is deliberately no glob.** The supervised runner accepts exactly one
compiled file, `e2e.js` or a run-alone scenario. Multiple files and globs are
refused before any host starts. Raw `node --test` invocation of a boot consumer
also fails before fixture work; use `test:smoke:one`. Supported Node flags use
`--test-name-pattern=value`, `--test-skip-pattern=value`, `--test-timeout=value`,
`--test-reporter=value`, `--test-reporter-destination=value`, or `--test-only`.
`release.mjs` calls `test:smoke`, so release candidates use the same supervisor.

`npm run test:smoke:cleanup` is the separate stock-host fault suite. It imports
no boot hooks and launches controlled compiled-boot workers with independently
owned case roots and process witnesses. It covers worker/outer-runner death,
launch acknowledgement races, disposed handles, close errors, relaunch,
concurrent-run isolation, the shutdown deadline and negative controls. It
proves the oracle red with a temporary disabled-cleanup runner and removes all
its own processes even when the candidate is broken. An explicit
`SQUADRON_SMOKE_ROOT` scopes the run to its own supervisor; it skips the
repo-wide previous-dev-host sweep so independently rooted runs stay isolated.
It stays outside `e2e.ts` and `npm run check`; headless ownership cases are
`smoke_cleanup.test.ts`.

The supervisor records descendants at registration, close preparation and
cleanup scans, retaining PID/start/group identities after reparenting. Every
signal uses fresh evidence; group signals require a live verified leader.
Ownership passes only through a live parent edge. A row reached only through
a member that has died (win32 keeps the dead pid as its ppid) is a suspect:
retained by pid and start, waited for, never signalled, and red if it
outlives the reap. So win32 watches `cmd.exe`, the launch root, from
registration until the IDE it starts is owned.
Cleanup failures retain uncertain resources and report under `SQUADRON_RUN`.
Failed scenarios also copy HOME and host logs to `SQUADRON_RUN/cleanup/host` before
disposal; without `SQUADRON_RUN`, the failed root is retained. Boot logs host
PID and launch/exit/page-close timestamps. The oracle stops waiting for readiness
when the runner exits, and reports its code, signal and elapsed time.
A supervisor SIGKILL and an unobserved host child that starts a separate group
and immediately reparents are outside this guarantee. Unobserved children the
test worker starts itself can also escape after worker death, even in its shared
foreground group; that group never authorizes a kill. Process start times have second resolution,
and checking then signalling is not atomic. No sweep claims older/manual hosts.
The host gets 10 s for graceful close, then 2 s TERM grace within an 8 s reap
budget. Each process read is bounded to 2 s. Worker completion/loss starts a
10 s test-runner shutdown deadline; an active barrel has no overall deadline.
Closing a host preserves the fixtures; the supervisor alone disposes run paths.

Two things do not divide, and both are launch-time. The **profile's
`settings.json`** is read before the window exists, so `boot.ts` writes the
union of every scenario's keys — a scenario cannot add one later, and a key the
loaded scenarios never touch costs nothing. A `patchSettings` lasts until the
next reset, which writes the union back. The **panel being open** is a test
(`panel.smoke.ts`, the command palette), and every reset shuts it, so every
other file calls `openPanel()` in its own `before`; it is idempotent by
visibility, so a file run alone and a file in the barrel both work.

**The window width is a third, and it is a ruler rather than a setting.**
`panel.smoke.ts`'s nav ladder reads the board against absolute widths, so
`boot.ts` pins the host window to 1536x1000 in the main process, where the board
measures 882px. Pinning once did not hold: that call goes in right after
`firstWindow()`, before the workbench has laid out, and 1 barrel run in 11 had
the host restore its own remembered bounds over it — the board read 786px, the
ladder straddled three steps instead of four, and it failed twenty tests later
as a layout assertion that named no window. So the pin is re-applied once
`.monaco-workbench` resolves and then *confirmed*. A read taken straight after
`setBounds` proves nothing, the overwrite being the later event, so the width
has to stand across three reads 100ms apart; a drift is logged, and a boot whose
pin never holds throws there naming the width. The ask is cut to the primary
display's work area — macOS lets a wider window overhang the right edge and
shoves a taller one back on every launch — and a work area down to 1456 wide
still lands in the band.

State a scenario writes is per-file and arranged by that file — the `HOME`
fixtures land via the poll, so they can be written after launch — and the next
reset undoes it. A red step saves a best-effort copy first in its evidence `home/`.

`session.smoke.ts` is one owned session's life, in sequence: **New session**
spawns
`fixtures/fake-cli.js` behind a shell shim set as `squadron.claudePath`, then
a dialog, its answer, a plain turn, a mentioned workflow (Attach among ≥2 +
enrich + live observe + drawer open/rail/progress/scroll + exclusivity +
finish + attach the other), board editor entry (bar Edit / Attach New), a step
reordered by its grip, create+delete on disk (Save/Delete wire + workbench
confirm), a permission
dialog, an interrupt, `squadron-end` refusing that same turn, the place the
dock keeps for each session, and end. Full select → step progress → Done → second
start and drawer paint rules are jsdom (`workflow_chat.test.ts`,
`workflow_overview_drawer.test.ts`); smoke proves the host seam including chip →
`#workflowoverviewdrawer` and a disk progress write the poll joins.

The rail's **scroll** is the shape of every "only a host has layout" case: jsdom
stores `scrollTop` but never overflows anything, so it can only assert that the
`<ol>` survives a repaint. The dock thread's **place** is the second of them,
and it is what that gap costs — jsdom's ruler is lent by the test, so it put the
first turn at the top of the thread, and the real one puts it below a padded
edge where nothing has reached the fold at all. The bookkeeping was green in
`chat_thread.test.ts` and the top of every thread was still thrown away. Whether a reader parked halfway down actually stays there
needs real boxes, and a note tall enough to overflow. Keep the two writes the
same height — Chromium anchors the scroll to what is on screen, so content
growing above the reader moves `scrollTop` legitimately and the assertion could
not tell that from the rail being rebuilt.

`containment.test.ts` is the one suite here that reads the **stylesheet** rather
than the paint, and it exists because the rule it holds is invisible to every
other layer. A `position: fixed` popover escapes its ancestors' overflow only
while no ancestor is a containing block for fixed descendants — and an ancestor
becomes one by setting `transform`, `filter`, `perspective`, `will-change` or
`contain: layout`, none of which look like they are about position. jsdom lays
nothing out, so it cannot see the clip; a smoke scenario could, but only for the
popovers someone thought to open. So the invariant is checked instead:
`panelStylesheet()` is parsed, matched against the **real** ancestor chain of
the rendered panel, and every fixed element on screen is walked upward. Its
approximations of the cascade are written at the top of the file — read them
before trusting a green. The fix it enforces is that such a menu leaves the box
entirely (`kit.ts`'s `portal`, `tip.ts`'s `<body>`).

**Its first version was wrong about which properties trap**, and that is the
lesson worth keeping: `container-type` and `view-transition-name` were both on
the list, read off the spec, and neither makes a containing block in any engine
this ships to. A property list like that has to be *measured* — the method and
the matrix are `docs/reference/z_index.md`, including how to run the probe in
the IDE's own Chromium rather than a desktop Chrome nine majors ahead of it.

**The drag is the other thing only a host can do**, and there are two of them.
jsdom implements neither `DragEvent` nor `DataTransfer`, so every drag in the
suite above is a hand-made object on a plain `Event`: real handlers, nothing
proven about the platform under them.

The **ticket drag** has `tickets.smoke.ts` to itself, because it starts a
session of its own — it was already kept clear of the owned sequence for that
reason, and now the file boundary says so. A pointer really drags a ticket row
onto the add slot and the whole path follows: `open` posted, a child spawned,
the reveal naming its folder, the ticket in that new session's composer
(taskhub H34). The reset before it ends whatever an earlier section started,
so it meets a board with no other session of its own.

The **step drag** reorders a workflow in the board editor, and it is here for
what a synthetic event cannot fail at: a drag the browser starts and never
finishes. `body.dragging-step` set `pointer-events: none` on the card while the
grip lived inside that same card, and the drag wedged — pressed, never released, no
dragover and no drop. Note the failure shape: a wedged drag **hangs whatever
process it is in** rather than reddening it, because Playwright's timeout does
not end a drag the renderer never resolves — so running `session.smoke.ts`
alone is the cheapest way to reproduce it. It needs a backlog, and a backlog needs a tracker: `fakeTracker`
serves the two GraphQL queries `LinearSource` makes from `127.0.0.1`, and the
panel is pointed at it by `squadron.linear.endpoint` in the profile's
settings. That setting is undeclared in `package.json` — not in the Settings UI,
not something a reader meets — and it exists so this suite needs no Linear
account. The key is real enough for the flow: the connect input box is the
workbench's own, driven like any other.

The mention is there for what only a host can join: `enrich` composes the
workflow's line host-side and the webview is handed neither the steps nor the
file, so the line appearing in the thread is the host having composed it and said
what it delivered. What that
test deliberately does not assert is the ghost bubble the same bug produced —
the fake writes no transcript, so the turn on screen *is* the echo, and a
`.sending` that never settled would settle anyway once the card went idle and the
grace ran out. `chat_workflow.test.ts` holds that half, against a thread it can
write.

`session.smoke.ts` shares one spawn deliberately — a second child would double
the slowest part of that file to prove nothing new — so its cases are a
sequence, not a set: each leaves the session idle for the next, and `owned` is
read off the card once. That is also why the workflow cases live there rather
than in a file of their own: they are steps in this session's life, and
splitting them out would buy granularity with a second child. The pull case is
the one there for a different reason: it runs the installed `squadron-step`
from `~/.squadron/bin`, which is the only place a verb that reached `src/` and
not the shim directory shows up red, and then reads the rail the panel painted
off a cursor another process wrote. The shelf case
arms a real run and cancels it through the product before later Attach cases,
since a *working* chip hides `.fpill`; it then unlinks from outside the panel,
so those cases do not depend on the cancel having passed.

**A shared spawn is why the section stops at its first red.** Each case
leaving the session idle for the next is a rule the *passing* path keeps; a
case that fails does so before its own cleanup, and leaves the session wherever
it fell. Measured 2026-08-18: the busy refusal threw on its assertion before
the trailing `#chat-interrupt`, and the six cases after it each timed out at
30 s against `<textarea disabled placeholder="Sending is unavailable">` —
seven red for one bug, and a parent at 228 s that names none of it. An
`afterEach` that interrupted a busy session used to soften this; the section's
bail replaced it (2026-09-24), so the file now reports one red and skips the
rest.

**Share within a phase; spawn between phases.** The granularity is not one
child per case — spawn is ~3 s, some fifteen of that file's cases need one, and
a child each would put ~45 s on a 52 s file to prove nothing new. Share within a
phase that genuinely builds on the last (dialog → answer → turn), and take a
fresh child at a phase boundary, where a stale session is a wrong premise rather
than an inconvenience.

**A gate satisfied by the previous turn is not a gate.** The same sequence makes
a leftover indistinguishable from the thing being waited for: `send('slow')`
then waiting for `.busy` reads a card that may still be painted busy from the
case before, so the wait returns having proved nothing. Waiting for an *edge*
means first waiting for the state it comes from — idle before busy — and a case
that skips that half passes on a stale paint until the day the timing moves.

**A line the panel composes is a prompt like any other**, and `fake-cli.ts`
scripts its turns on `text.includes(...)`. `enrich`, the progress briefing and
the cancel's stop line all arrive there as ordinary text, so a product string
carrying `write`, `ask`, `two`, `slow`, `linger`, `quiet`, `spool` or `origin` runs a turn
nobody
asked for. `write` in the stop line cost a whole run: the fixture opened a
permission dialog, and `#scrim` over the board wedged every scenario after it —
including files in later imports, which is what makes it read as a failure
somewhere else entirely.

`monorepo.smoke.ts` is here for what `host/panel.ts` makes untestable anywhere
else. `startsFor` walks a real disk and `serverContext` asks `declaresWorkspaces`
on the poll; both import `vscode`, so the jsdom suite can only drive the sheet
against a `PortsMessage` written by hand. Three things it proves and nothing
else can: a root that runs nothing still **lists its apps**, which only the
host's walk can answer; the rail sits **beside the starts in pixels**, which jsdom
cannot answer because it has no layout; and a remembered port **round-trips
through a real ports file** keyed per app, read back after a stop.

Its fixture is a **worktree of the existing repo, not a second repository**, and
that is the whole reason it needs nothing alive. A section is drawn for a root
`serverContext` derives from an open window or a live session — this window is
open on `project`, so that repo is free, and `readWorktrees` puts a second branch
under it. A separate repo would have needed a session, so a live process, so a
section that expires when `fakeClaude`'s `sleep` does: the row stops being drawn
partway through the suite and reads as a feature that never rendered.

Two traps it cost, both worth knowing before adding a fixture like it.
**`git worktree add` records a realpath**: `os.tmpdir()` is `/var/folders/…`, a
symlink to `/private/var/folders/…`, and the panel keys `commands` and its runner
cache by the path git reported — so a settings entry written against the
unresolved path matches nothing, and the sheet draws no What field with every
other part of the fixture correct.

**The smoke supervisor gives `boot.ts` canonical paths, and this is not
optional.** git is not the only thing that resolves one: a session the panel
starts reports the cwd its *own process* resolved, while the workspace folder
the host was launched with keeps the short spelling. `buildGroups` keys a
section on that string, so one directory arrives as two — and then every
`.first()` in this suite has two candidates, one of which has no conversations
under its slug at all. It cost a barrel where `grok.smoke` opened an empty
resume picker, waited 30 s, and left `#picker` over the board; twenty-nine
later cases across five files failed on a click it intercepted, none of them
naming a path. `grok.smoke` passed run alone the whole time, because alone
there was no long-lived owned session to draw the second section. And **the port outlives the chip**: disposing
the terminal signals the shell, and the socket goes a beat later, so a scenario
that reopens the sheet immediately sees its own remembered port as taken and is
offered the next free one instead — which is `defaultPort` obeying A17, not a
bug. Wait for the port, not the paint.

**A New is a draft, and a session that has said anything asks before it
ends.** Both are `TASK_done_draft_new_session.md`, and both changed what
every scenario here has to do. Pressing the add slot's New posts nothing now —
`openDraft`, `pickDraftModel` and `sendDraft` in `kit.ts` are the gesture, and
the pick on that draft is the only door to a non-Claude start, so a brand the
panel calls signed out cannot be started at all (which is why `codex.smoke.ts`
signs in through the panel first). And because the draft's first turn is a real
exchange, `closePlan` raises the shared **webview confirmation** on End. The host keeps
the plan and validates the correlated answer before ending anything. `endCard`
answers through `#cscrim`; do not write a bare close and wait for detachment.

**A case that presses a menu open must ask whether it already is.** `kit.ts`
builds one `.fmenu` per pill and shuts it with the `hidden` attribute, so the
node is in the document either way: `count()` is always 1, and only
`isVisible()` answers the question. A blind press is a toggle, and the losing
side does not read as a shut menu — it reads, thirty seconds later, as the host
never having written the file. `openBarMenu()` is that guard, and the flake it
fixes only ever appeared when `session.smoke.ts` ran **alone**, because a file
run by itself meets the bar at a different point in the poll than the barrel
does. Order-dependence the monolith could hide is order-dependence the split
surfaces; that is the split working, not the split breaking.

The **busy refusal** is the newest of the seam cases, and the shape is worth
copying. `endPlan` is pure and exhaustively tested, but every case there is
written against a board the test composed; only here does a session that is
*really* mid-turn have to read as `busy` to a *separate process*, down the
reducer → `core/published.ts` → a file → the CLI's own `foldTwins`. It runs the
copy in `~/.squadron/bin`, so the emit and `installShim` are covered too.

It cost two fixtures the fake CLI does not write, and both are instructive.
`fake-cli.ts` writes no `sessions/<pid>.json`, so `foldTwins` — called with no
owned list out there — had nothing to promote the published record onto and the
session was invisible to every command in `cli/`. Writing one is not enough
either: `discover.ts` wants the process to still be there, and its cheap test is
a command named `claude`, which the shim cannot pass because it `exec`s node.
`procStart` is the other half of that gate and is what the real CLI writes for
it. **Neither fixture may outlive the command that needs them** — the twin feeds
`hasCommand` back into the card through `withTwin`, a session holding a
backgrounded command has no composer, and two later cases in the file failed
intermittently until both files were removed the moment the assertion had its
answer.

What only this layer can prove is the **seam**. jsdom proves a click posts the
right `WebviewMessage`; `claude_session.test.ts` proves the transport carries it; only
here does a real host join them, and only an owned session can raise a dialog at
all (`core/asks.ts` stopped reading the hook's overlay).

**The settle is the assertion, not the words.** The fake CLI answers in about a
millisecond and writes no transcript, so its reply is live text that is gone
before the panel's next poll — nothing here can read what the child received.
The card returning to idle is the claim instead, and it is not the weak one it
looks: the fake splices an answered id out of its open list and emits `result`
only once that list is empty, so a response it could not match leaves the turn
open and the card where it was.

The exception is the interrupt case, and it is the exception for a reason worth
keeping: `slow` never ends, so its live text stays put rather than being
overtaken, and the word it streamed can be read off the paint. That assertion
covers the whole inbound path — reducer, the host's markdown engine, DOMPurify —
which is why it sits there rather than needing a fixture that writes transcripts
to get it back.

It is machine-dependent, so it runs only under `npm run test:smoke`, and nothing
in `smoke/` is named `*.test.ts` on purpose: no future recursive glob can pull
an IDE launch into the Node test gate. `*.smoke.ts` is the scenario suffix, and
`boot.ts`/`kit.ts`/`e2e.ts` are deliberately without it — they register no tests
of their own.

To watch it: `SQUADRON_SMOKE_SLOW=250 npm run test:smoke` (or
`npm run test:smoke:slow`) pauses that many milliseconds between Playwright
actions. Unset is full speed — keep CI and deploy at full speed.

**One window, and there is nothing left to miss.** This used to say that the
one thing only this layer could ever test — the cross-window relay, where the
window holding a pipe writes and the one holding a terminal reveals — was
skipped, because two extension hosts need two real IDEs. Row 71 closed that gap
by subtraction rather than by widening: a panel drives the sessions its own
window started, so nothing crosses between two hosts for a second host to
witness.

What is left in its place is the **negative**, and one host asserts it on its
own: `panel.smoke.ts`'s "draws no card for a session another window owns"
writes the session file and the published record another window would, and
requires no card.

`requests.test.ts` still covers the file protocol headlessly, for the four kinds
a shim posts. `TASK_dropped_session_broker` would replace those files with a
socket; a suite written against the relay would still be paid for twice.

**To prove a smoke case can fail, break `dist/extension.js` — not `out/`.**
The suite's own code runs from `out/`, but the thing under test is the
*extension*, which esbuild bundles into `dist/extension.js` and the host loads
from there. Patching `out/ui/views.js` and watching a scenario stay green proves
nothing at all: the running extension never read it. Measured 2026-09-15 while
proving row 71's board predicate — the same edit was invisible in `out/` and
turned the case red immediately in `dist/`. Copy the bundle aside, patch it, run
the one file, restore it, and re-run to confirm green; `npm run compile`
regenerates it either way.

**Stock VS Code, always.** `ide.ts` holds stock's install path per OS,
which is what this repo targets, and `SQUADRON_IDE` replaces it, with no
fallback, for a run you point somewhere by hand. The fork was in the list and came out: its build is an extra variable
in every failure here, and a red run that is the host's doing costs more to rule
out than driving stock ever bought. Nothing the extension depends on is
fork-only, so stock is the observation that matters.

Two things stop a cold profile dead, and both are startup, not the tests:

- **`--use-inmemory-secretstorage`.** `HOME` points at a temp directory, and
  macOS looks for the login keychain under `$HOME/Library/Keychains`, which that
  directory has none of — so the host's first secret raises a native *Keychain
  Not Found* sheet. It is not in the page, so nothing here can dismiss it, and on
  the fork the webview never paints behind it. `--password-store` does not help:
  Linux-only Chromium switch, and Electron's `safeStorage` goes to the Keychain
  on macOS whatever it says.
- **`clearOnboarding()`.** A first run is a welcome, and a fork's welcome is a
  full-window layer above the workbench that intercepts every click aimed below
  it, a webview's included. Removed from the DOM by the word `onboarding` in a
  class rather than by any product's own name, and a no-op on stock. Called at
  startup and again before the first click, because it can mount a beat late.

With those two, the fork was never the problem the deleted suite thought it was.

The suite was deleted once, on the reading that the host had stopped accepting
the flags it passed — `bad option: --user-data-dir=…` on 2.3.1. That error is
node's, not Electron's. Run from a terminal the extension host opened,
`process.env` carries `ELECTRON_RUN_AS_NODE=1`, and passing it down makes the
binary *be* node, which then rejects the workbench's own flags. `ideEnv()` strips
it and the `VSCODE_*` block; on the same flags as before, the workbench is up in
~2.5s. Anything else here that spawns the IDE needs the same scrub.

`playwright-core` is also what the ad-hoc Chromium rigs in the motion tasks use.
