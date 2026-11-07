# src

## What the surfaces are called

| Surface | Name | Where |
| --- | --- | --- |
| the whole webview, host side | `panel` | `host/panel.ts` |
| the cards column | `board` | `#board` |
| one card | `card` | `.card` |
| the right column | `dock` | `#dock` |
| the dock's chat | `chat` | `#chat` |
| the board's filter row, one child per view | `board head` | `#board-head` |
| the board's content, one child per view | `board body` | `#board-body` |
| the board's tickets tab | `tickets` | `#tk-head`, `#tk-list` |
| one turn image over the board | `lightbox` | `#lightbox`, `webview/lightbox.ts` |
| the filter and tally strip atop the board | `nav bar` | `#nav` |
| sessions needing input, above Agents | `waiting pills` | `#bottomhub-waiting`, `webview/bottom_hub.ts` |
| the live chips above a group's cards | `servers line`, one `server chip` | `.servers`, `.srv` |
| the heading's way into the sheet | `door` | `.sdoor` |
| a repo's worktrees, what each can start, on which port | `servers sheet`: `rail`, `starts`, `port row` | `#runsheet`, `webview/runpicker.ts` |
| a directory's past conversations | `resume picker` | `#picker`, `webview/resume.ts` |
| every workflow on the machine | `bottom drawer` | `#bottomdrawer`, `webview/bottom_drawer.ts`, `workflows_mode.ts`, `workflows_drag.ts` |
| this window's warm switches | the sheet's Warm mode | `#bottomdrawer.warm`, `webview/warm_menu.ts` |
| Remote's messengers, this window's switch, and the setup and its check | the sheet's Remote mode | `#bottomdrawer.remote`, `webview/remote_sheet.ts`, `remote_setup.ts` |
| what holds this machine awake, its three switches and its figures | the sheet's Keep-awake mode | `#bottomdrawer.awake`, `webview/awake_sheet.ts` |
| the agent switches, and every verb a session may run | the sheet's Agents mode | `#bottomdrawer.agents`, `webview/agents_sheet.ts` |
| how to make a messenger's app, over Remote's setup | the guide | `#gscrim`, `webview/remote_sheet.ts` |
| the board-wide doors over the board's bottom | `bottom hub` | `webview/bottom_hub.ts` |
| the step rail for a live attach | `workflow overview drawer` | `webview/workflow_overview_drawer.ts` |
| the cup, and the pot that pours it | `café` | `webview/cafe.ts`, `pot.ts` |
| a question or a permission awaiting an answer | `dialog` | `#ask`, `webview/question.ts` |
| the chick over the board, behind its experiment | `mascot` | `#mascot`, `webview/mascot.ts` |

A sheet (root glossary) opens over the board with a backdrop of its own — never
`#scrim`, which belongs to `question.ts`.

**Two files do not match the surface they draw; do not rename them:**

- `runpicker.ts` draws the **servers sheet**. Prose says servers sheet while
  identifiers, element ids and the `openRunPicker` message keep `run` —
  renaming a wire message costs a protocol change.
- `chat.ts` draws the tab the reader sees labelled **Agent**.

`panel` is the host's own word (`vscode.WebviewPanel`, `--vscode-panel-border`);
leave it. The right column was `pane` until a reader reported one as a
misspelling of `panel` — introduce no near-neighbour of it.

`agent_` in prose means **session-scoped — exactly one agent**. An agent_card
and the agent_chat tab are; the board, the dock and the tickets tab are not.
Scope is what a surface is *about*, not where it is drawn: the ask layer
overlays the board and is still session-scoped. Identifiers drop the prefix.

The top level is the testability boundary: `host/` imports `vscode` and so is
checked by hand; `core/`, `ui/` and `cli/` run headlessly — by their tests, or
with `node -e` against real machine state, which you try before debugging
through the IDE. A file that grows a `vscode` import has moved house, and a
decision worth a test belongs in `core/` or `ui/`, never `host/`.

Within that boundary, keep **UI pure and behaviour imported** (same spirit as
a frontend app’s component / hook / service split, not its folder names):

- **`webview/`** — paint and local interaction only. Read pushed state, write
  DOM, emit protocol messages. No discovery, no poll loop, no machine truth.
  Gesture, morph, FLIP, drag, scramble *are* UI and stay here.
- **`ui/`** — headless view-models and pure presentation policy (what a card or
  thread *means*). No DOM, no `vscode`.
- **`core/`** — data processing and domain rules. No DOM, no `vscode`.
- **`host/`** — poll, deliver, vscode-only side effects; compose `core` + `ui`.
  Prefer thin wiring over a fat controller.

One-way deps: `host` → `core`/`ui`; `webview` may take leaf `core` only where
already allowed (e.g. markers/tokens). Never `core` → `host`/`webview`. A
`postMessage` from the document is the webview’s service call — do not grow a
second data layer beside the host.

```
src/
  host/          the vscode-bound half — nothing here is unit-tested
    extension.ts activate(): takes the window's process-reader lease before
                 its first identity read (disposed last in deactivate, after
                 owned shutdown), publishes this window's claim, watches for open
                 requests, registers the command, owns the children and the window
                 Reconciler; installs agent verbs through `platform.launchers`
                 (when and where stay here); routes changes and removes routes
                 before disposing the cache warmer, Café, WAIT, then the runtime
                 backstop
    request_host.ts  one activation's request dispatch and incoming-launch ledger;
                 guarded Remote starts, serialized agent admission, held reports
                 and their shutdown witness. Activation owns the poll and supplies
                 late Remote/attachment reads; core modules retain the rules
    panel.ts     webview host: board polling/dispatch, serialized board gathers
                 and independent selected-thread snapshots/patches, with an explicit full recorded-history view. Activity-only clocks
                 do not invalidate discovery; conversation generations do.
                 Selection requests and owned captures fence asynchronous reads.
                 A Warm figure edit is written Global, as
                 core/warm_policy.ts's `warmSettingWrite` maps and clamps it
    panel_actions.ts  friend surface for extracted host verbs — rules under
                 *H56 extract hygiene* below
    runs.ts      servers sheet's answer, start/stop, occupancy, runner cache.
                 `squadron.devServers.enabled` gates two of those from
                 `panel.ts` and not from here: the poll skips `serverContext`
                 when it is off, and the sheet, the start and the kill are
                 refused. `touchHeldServers` is deliberately outside it — it
                 runs on `extension.ts`'s interval, probes only what this
                 window holds a terminal for, and a server already running is
                 not a drawing to switch off
    session_close.ts  end / dismiss / cascade confirm; executes through
                 core/session_end.ts with human signal authority. Whether an
                 owned session has said anything is read from its thread in
                 memory, after recovery; a background one is read from the
                 files
    session_io.ts     send, queue, interrupt, model, rename, thread, images
    session_open.ts   new/resume, copy ref, reveal; pending UI resumes share
                      startup across panel reopenings, with a reply per attempt
                      Folderless panel starts allocate a managed scratch child;
                      explicit CLI starts keep their requested cwd
    skills.ts     window-lived folder discovery, refreshed on mention use with
                  one-minute freshness and shared by drafts, thread and
                  workflow editor; actual cwd selects the deepest opened root,
                  independent of board/worktree grouping. No session-frame source
                  or persisted catalog. Sources: core/{claude,codex,grok}/skills.ts
    session_lookup.ts routing a pid to this window's handle, or refusing it
    workflow_actions.ts  save/dup/delete/order, cancel/retry workflow
    panel_auth.ts  login child, sign-out, accounts rows for the wire.
                 Sign-in and sign-out are one row per brand
                 (`ACCOUNT_ROW_DESCRIPTORS`); whether each is signed in is
                 `core/signin.ts` every pass; MCP reads and the optional health
                 probe use `MCP_READERS`, login/disconnect `MCP_AUTH_DRIVERS`
    terminal.ts  the dev servers this window started — the one thing only a
                 terminal's own window can do. A dev server's terminal is
                 created, sent one command and disposed. A session's terminal is
                 neither written to nor looked for: every card is a pipe
    sessions.ts  the sessions this window started and drives: the registry, the
                 spawn, and the child's lifetime. The Session it draws and
                 publishes waits for explicit prompt admissibility; unready
                 handles stay in the registry for cleanup. The Session is
                 synthesised from frames by core/live.ts. The
                 dock draws an owned session's thread from the handle's
                 memory (core/thread.ts); the record is written behind it.
                 Exact incoming identities and stable receipts live on those
                 same entries, through core/owned_incoming.ts; required startup
                 publication is acknowledged before the original prompt.
                 `readWarmPolicy` is the one read of the `squadron.warmCache`
                 figures, here and not in warm.ts because warm.ts imports this.
                 An ended session leaves the registry at the send and is drawn,
                 as the card it wore then, until its child is seen to exit
                 (`endingSessions`). `core/ending.ts` retains the card with its
                 pending/failed End state; refreshes never prune that state.
                 The entry keeps the spawn parent and the resolved origin, so
                 the parked card still names its family after discovery loses
                 the twin. An accepted pipe end notifies `onOwnedEnd` with the
                 pid and start; the panel turns that into `closeResult`
    cli_path.ts  the one read of a brand's binary-path setting; every override
                 handed to a CliAdapter port goes through it
    windows.ts   publishes this window's claim on a 30s heartbeat, and again
                 when `squadron.orchestrators.enabled` changes: the claim's
                 `orchestration` is what `cli/gate.ts` reads. Reading them is
                 core/coordination/claims.ts
    watch.ts     "some session state changed on disk", said once for whoever is
                 listening: session files, top-level state and dynamically
                 watched state directories except user scratch; two rates and this window's
                 own publishes dropped. Started by the first subscriber and
                 stopped by the last, so its lifetime is not the panel's
    usage.ts     extension-lived account usage: adapter and ready owned ports
                 over core/usage_refresh.ts; account eligibility through signInFor,
                 independent of panel visibility. No CLI method names here
    warm.ts      `cacheWarmer()`: core/warmer.ts's `CacheWarmer` on this
                 window's registry and the warm settings
    waits.ts     resolving the registered waits: read them, run the rule, send
                 the one message, delete the record. Panel-free; timing is
                 core/reconcile.ts, ordinary-wait rules core/coordination/wait.ts,
                 workflow waits core/workflows/wait.ts. One table serves its
                 discovery and says whether that pass's process evidence was
                 complete (`processes` for `resolveWaits`), which pids it runs
                 and whether every record was read (core/coordination/wait_board.ts)
    keepawake.ts the `platform.power` lease that keeps this machine awake while a
                 session is working, while this window holds Remote, or while
                 a session has Warm on (`squadron.cafe.remote` and
                 `squadron.cafe.warm`). Nothing polls: owned changes and an explicit
                 refill deadline use core/reconcile.ts. Owns leases and hold
                 writes; every rule it applies is core/awake.ts, which is
                 handed whether this OS can hold rather than reading it. An
                 incomplete process table reads its sessions as occupied
    remote.ts    `RemoteHost`: `core/remote/switch.ts` over `vscode`,
                 panel-free like the keeper — the tokens in `SecretStorage`,
                 the settings — the allowlist written through `admitAccounts`,
                 the space through the messenger's rule — the memory file, the
                 Reconciler tenants (`remote pass`, coalesced at 5 s, and each
                 engine's `remote retries` through the same port), the
                 subscriptions, and the setup check's runner
                 (`core/remote/check.ts`) over the credential reads and their
                 change events, filling an empty space. Nothing it decides
    markdown.ts  turns -> markup, via the host's own markdown preview engine
  core/          machine state in, data out — no vscode import
    platform/    Node-only OS seam, introduced capability by capability.
                 host.ts reads the OS once; index.ts selects one factory per
                 capability, with explicit legacy POSIX routing (unverified
                 off Darwin). unsupported.ts distinguishes unsupported, failed,
                 incomplete and successful results, including empty success.
                 Factories capture their own effects; selection/import never
                 starts a scan, timer or child. Operation contracts arrive with
                 their implementations; paths/key, commands/render and
                 launchers/install stay total.
                 The map — support, mechanisms, and what stays outside — is
                 `docs/reference/os_seam.md`. Reading the OS (`process.platform`,
                 `os.platform()`, `os.type()`; `squadron/os-read`) is an error
                 outside `host.ts` and `src/test/home.ts`. `process.getuid`
                 is an error outside this package and `src/test`.
                 Never import the Node composition root into the webview.
                 `executables/`: PATH/PATHEXT search, npm shim following and
                 starting a found `Program`, which is opaque — no caller reads
                 or assembles its argv. `named` (test fixtures) and
                 `executables/internal` (execution cooperation) are lint-held.
                 `console_login/`: bounded console-backed login output and cancellation.
                 Darwin retains BSD `script -q /dev/null`; Windows x64 uses the
                 source-built Framework 4.8 monitor outside the CLI job, atomic
                 suspended containment and held owner identity. A zero-member
                 acknowledgement releases admission; monitor death without one
                 retains unresolved job accounting. Other hosts refuse with terminal guidance.
                 `files/`: complete-file replacement, plain rename on POSIX;
                 bounded regular-file bytes, with nonblocking FIFO rejection
                 on POSIX; CLI input owns UTF-8 decoding and its byte limit.
                 Every backend performs one rename and propagates its error;
                 operation owners decide recovery and publication failure.
                 Directory open/sync/finally-close also lives here; Windows
                 tolerates only directory-sync EPERM, POSIX propagates errors.
                 `contended` says a lock file's error meant another process was
                 using it: EPERM on Windows, never on POSIX
                 `processes/`: one native table per `snapshot`, rows with a
                 source-tagged start and an optional group, and completeness
                 said apart from failure and from no reader. `own()` is a lease:
                 while one is held a backend may answer from a reusable reader
                 (win32), and Darwin keeps nothing. `win32.ts` `processes(effects)`
                 is the selected Windows backend: one-shot reads with no lease,
                 the owned reader while any lease is held, `signalling` always.
                 `win32_reader.ts` `reader` is the one-shot WMI read,
                 with injected Windows directory/run, bounded streamed CIM
                 gathering, FILETIME starts and nullable image/command
                 metadata, tagged `win32-filetime-ms-v1`. `StartSource` is the
                 one vocabulary (`isStartSource`, `filetimeToUnixMs`) every
                 persisted identity and admission check names. `win32.ts`
                 `snapshotOf` maps a read to the shared snapshot and
                 `invocationOf` splits a command line's program token (pure). Rows may carry
                 neutral `image`/`invocation`; command may be null.
                 `win32_owned_reader.ts` `ownedReader` is the reusable
                 stdin child a lease selects: serialized nonce requests,
                 5/2 s cold/warm bounds, close on any bad reply, 1–30 s failed
                 start backoff, 30 s idle EOF, disposal. Ending is EOF then a
                 contained kill; only `close` is closure. A child past its close
                 deadline is unresolved: kept, reported by `dispose`
                 (`Disposal.unresolved`), and no replacement starts until it
                 closes. `win32_run.ts` `boundedRun` is the one-shot's run:
                 it starts its child in the slot the reader reserved.
                 `win32_children.ts` `children` is the backend's one
                 admission, shared by both kinds and outliving every lease:
                 one child at a time, reserved atomically (a leased read waits
                 for an active one-shot to close; a reader reusing its own
                 child asks for nothing), ending keeps the slot, an unresolved
                 child refuses every start, at most 16 wait, and each
                 `Lease.dispose()` reports every child still unresolved. No cache, classification or ancestry: those
                 are `scan`'s.
                 `signal(members, stop|kill, table)` judges each member by
                 its own row's exact start on the backend's clock, by group
                 only for an observed leader, by pid for a root; it never
                 scans, waits or retries. win32's `signalling`: `kill` is
                 TerminateProcess by exact positive pid, `stop` is Unsupported
                 (no flush request)
                 `paths/`: `key(raw)` → `PathKey`, a directory's comparison
                 identity for compares, map keys, containment and store
                 filename hashes. The raw path on Darwin and other POSIX; win32
                 upper-cases a drive letter and turns `/` into `\` on drive
                 and UNC paths, nothing else (`os_seam.md`).
                 `contains(outer, inner)` is lexical containment under that
                 key: normalized by the backend's own flavor, so `..`, a
                 sibling prefix, another drive or share, or `Foo` against
                 `foo` never passes; claims' folder tier uses it. IO, spawn,
                 display, stored content, CLI slugs and identity digests keep
                 the raw string. A scanned store reads only the file the
                 current key names. `buildGroups` sends one original spelling per key
                 `commands/`: `render(program, args, policy, shell, env?)` →
                 text a shell or an agent runs, never argv. The producer picks
                 its policy: program literal or always quoted, arguments always
                 or conditionally quoted, or the dev host's unescaped double
                 quotes (a known defect). Numbers stay bare. Hook text is
                 trusted natively by its bytes. Grammar is per shell
                 (`posix.ts`, `powershell.ts` for Windows PowerShell 5.1);
                 `shell(family)` is the OS's part: a brand's `native` family
                 is PowerShell on win32, sh elsewhere. `carries` states what a
                 shell cannot deliver (cmd behind a `.cmd`); `placeholder`
                 spells a described value. Receivers: `TOOL_SHELL` in
                 `identity.ts`, `ExecutionIntegration.hookShell` per brand
                 `launchers/`: `install(binDir, name, bundle)` copies one
                 extensionless verb and chmods 0755 on POSIX, best effort per
                 command. Bundle bytes, shebang included, are not rewritten.
                 Windows publishes a `.scripts/` payload, a Git Bash sh wrapper
                 and an ASCII CRLF `name.cmd` for PowerShell/cmd, both on the
                 captured IDE runtime (D1); limits of the cmd routes: OS seam
                 `scriptPath(binDir, name)` locates the JavaScript entry for
                 direct-Node callers without exposing the layout outside it;
                 `verbPath(binDir, name, shell)` the launcher a command for
                 that shell names (`.cmd` for PowerShell); `scriptCommand()`
                 the runtime a hook starts an owned script on — `/usr/bin/env
                 node` on POSIX, the captured IDE runtime under
                 `ELECTRON_RUN_AS_NODE=1` on win32, rendered inline, no file
                 `power/`: `holds` answers support with no effect; `read()`
                 is `pmset -g batt` under a 2-second backstop, `ok` with no
                 value for no battery line; `hold(lease, hostPid)` is
                 `caffeinate -i -t <lease s> -w <host pid>`, its end and
                 failure as events and `release`. Lease timing, overlap and
                 the battery floor are the keeper's. Unsupported on win32
                 (W7.1) and every other non-darwin host, as before the seam
                 `memory/`: `read()` uses vm_stat on Darwin, cgroup-first then
                 proc on Linux, and OS total/free counters on legacy win32.
                 Other hosts answer unsupported; failures or changed output
                 leave the caller no reading. No poll belongs to the backend
                 `listeners/`: bounded lsof reads and cwd batches, fallback paths
                 remembered per window; exit 1 is no matches, killed/truncated
                 output is failed. win32 reads `netstat -ano`, remote port 0 being
                 a listener, and refuses `cwds`. Port deduplication and cwd
                 enrichment stay in devservers/listeners
                 `private_files/`: owner, mode, link-count and inode checks,
                 each call naming its purpose. The managed incoming directory
                 and its files: this user's, no group or other bit, one link,
                 real path. An attachment: this user's regular file, any mode
                 or link count — never the managed rule. Reads go through one
                 descriptor bound to the path's inode (`O_NOFOLLOW`, and
                 `O_NONBLOCK` for an attachment); a missing uid never passes.
                 Admission, roots, deny, digests, quotas, names and expiry stay
                 with callers. Windows uses the packaged descriptor-owning
                 helper, with full-bit identities, private-from-first-byte
                 creation, bounded scope-owned children and awaited host
                 disposal. Actual minimum-runtime/admitted-target and product
                 verification remain open (W6.6); see the private-files task.
    shutdown.ts  `settleThenRelease`: the host's last step, under one named
                 budget (`SHUTDOWN_BUDGET`). Readers of process evidence settle
                 (or the budget passes) before the process-reader lease is
                 released, the release has its own bound, other participants
                 get the rest; then rejections, unsettled participants by name,
                 release failure and unresolved reader children are reported
                 together. `startAfter` starts owned shutdown after the report
                 note or its budget; `drain` is the reader participant for
                 the lifetime cleanups `closeAll` starts, which outlive its
                 1.5 s bound (`within`), named one by one at expiry
    reconcile.ts per-registration change/deadline timers and isolated async
                 checks; first-event coalescing, explicit schedule/cancel,
                 one-second deadline floor, due-only reruns. Failures discard
                 queued reruns but retain unfired timers; disposal ignores late
                 requests/schedules. No domain rules, effects or retry policy
    claude/discover.ts  reads the CLI's session files -> Session[]: owned
                 twins and background only — the rest never reach the fold.
                 Each file is read and decoded once; given a wait pass's
                 `PassEvidence`, it records the unread (unreadable or malformed)
                 and the retired (a pooled worker whose job is done or failed)
    git.ts       a cwd -> its branch and its repo root, a repo -> every working
                 tree it has, and a branch -> the sha it points at, from `.git`
                 alone
    scan.ts      process table: liveness, descendants, start times. Classifies
                 `platform.processes` snapshots once and owns the 1 s shared
                 cache (`tableCache`); a fresh read for an action still refills
                 it. Windows tables are named by image/program token without
                 case or `.exe`; parent-age refutation covers both native clocks
                 `wrapperOf` names the runtime root a recognized CLI was
                 started under (npm's `node codex.js`), and `runsCommand` reads
                 a shell of the root or of that one native child. Identity
                 stays the root's; `publishedProcess` (`published.ts`) is the
                 Grok/Codex record join over them
    coordination/  session-to-session actions, and the shims' delivery
      requests.ts  what a shim writes to a window, and the reply it waits for.
                   **Fourteen kinds** — `open`, `send`, `answer`, `rename`, `warm`,
                   `close`, `models`, `attach`, posted by a `squadron-*` command; and Remote's `interrupt`, `deny`,
                   `personAnswer`, posted by the holder window and served only
                   while a live holder names it. Incoming's versioned
                   `remoteStartFilesV1`, `incomingEvidenceV1`, and holder-only
                   `fetchFile` carry
                   strict neutral contracts. Start/evidence are owner-served;
                   fetch is served only by the current holder. Receiver
                   and current-holder challenges do not use the routing queue. Incoming-prefixed files alone have 64-KiB
                   pre-parse caps. `open` and `models` use the
                   spawn-selected window, or the picked folder's for Remote's
                   `open` (`via: 'remote'`); `attach` is addressed to the holder,
                   which reads the file and posts it without the session's
                   window. `fetchFile` names the holder and returns typed
                   fetched/pending/refused metadata; the other session verbs use the target
                   session's pipe owner.
                   `models` needs no target session or open panel. The panel
                   posts none: it drives the sessions it started without files
      request_codec.ts  pure request/reply wire decoding and field validation;
                   requests.ts keeps contracts and file transport. Shares incoming-kind
                   and delivery narrowing with the poster; request types are type-only
                   imports, so decoding does not load the transport
      origin.ts    action origin and closed admission-owner policy, classified once
                   at dispatch. Decoder validates explicit metadata without inferring
                   legacy origin; the raw serveOwned facade shares that classifier.
                   Fixed-kind discovery/proof/control keeps its existing policy;
                   origin grants no authority. Wait is local, never a file origin;
                   `warm` is a fixed-kind request like `rename` and carries none
      serve_owned.ts  the window-side arms of every kind that acts on a pipe
                   this window holds — the composer `send`, `close`, Remote's
                   three and its `open` — moved out of `host/extension.ts` so
                   the two-window test drives the code a window runs. A kind
                   with no arm fails the build here, and an unknown one answers
                   "older Squadron"
      claims.ts    reads the per-window claim files, so panel and CLI agree on
                   which windows are alive. `brands` is still parsed and no
                   longer read. Also the cwd tiers, `windowForCwd`: the
                   window whose folder holds a directory (deepest, then
                   newest), else one on the same repo, else — only with
                   `fallback` — the newest. Spawn calls it with the fallback;
                   Remote without, so a cwd no window holds is refused (D26)
      lineage.ts   who spawned whom: one file per child, keyed by the pid that
                   spawn is responsible for — the CLI's own, since every start
                   this window makes is a child process it drives. Owns the join
                   too: every brand's discover asks it whose child a live pid is
      actions.ts   what one session did to another: one `ActionRecord` keyed on
                   `kind`, shared with lineage — a spawn is the `spawn` variant, an
                   accepted message the `send` one, a wait converging the `wait`
                   one, whose author is a window rather than a session, a peer's
                   answer to an open question the `answer` one. The last three
                   are what the guards count. Two directories on purpose, one
                   seven-day sweep
      guards.ts    every cap that decides whether an agent may act on a session:
                   the send cost guards (stale target, context ceiling), the
                   window burst `--force` never lifts, and the spawn burst and
                   fleet
      spawn.ts     what a spawn decides before the child exists: the prompt's
                   quoting and length, brand and model as a pair, and the two
                   caps (guards.ts). Depth is uncapped: an end clears the
                   whole descent
      send.ts      what a cross-session message decides before it is delivered:
                   the three wrappers' one spelling each — a peer's message, a
                   wait converging, and a cache-warming ping — and the guards in
                   core/coordination/guards.ts applied in the order a sender can act on
      answer.ts    one session answering another's open question: which request
                   may be answered (an open question, never a permission), the
                   prose the answer is delivered as, and the window's check
                   before its interrupt withdraws the question. Send's guards
                   and burst counter
      wait.ts      a registered wait, and whether it has converged: the store
                   under `waits/`, the predicate over the board, and the one
                   sentence a convergence says. On a pass whose process table
                   was not complete only a watched exit (`ended`) settles a
                   member; the deadline still delivers, the rest as unread. On
                   a complete one a member off the board is stopped only if its
                   pid is not `running` or a brand read it `retired`; unread
                   records hold workflow waits
      wait_board.ts the board a wait pass judges and its evidence, from one read
                   of each store: `readPublishedEvidence` once, joined by every
                   brand, and each brand's own files decoded once into
                   `PassEvidence` (`listed`, `unread`, `retired`)
                   Pure — the reads and delivery are host/waits.ts; timing is
                   core/reconcile.ts
      reports.ts   reports parked against a wait before convergence
      ask.ts       request outcomes and shim exit codes
      route.ts     a pid to this window's handle, wrapped so a thrown verb
                   becomes a sentence, or a refusal. Explicit interrupt reads
                   the live handle's `running` flag at the call and returns
                   `idle: true` without an adapter call when it is false
    delivery.ts the prose a send puts on the pipe: emptiness is the trimmed
                 body, and the bytes are the body it was given
    control.ts   ending a session: one SIGTERM to the CLI and its subtree.
                 `endBySignal` ends what no pipe could close — refused before
                 any scan where `platform.processes` cannot signal, then one
                 fresh scan for the batch, incomplete scans fail, nothing sent
                 to a pid whose start moved — and arms one SIGKILL
                 reap for the sweep, held by a `ReapOwner` (`Reaps` for Remote)
                 so an owner disposed inside the grace sends no kill. Tree
                 selection and order are here; each signal is the capability's
    bin.ts       where `claude`, `grok` or `codex` is, for a process with no shell
                 to find it: each brand's setting and installer path, and its
                 refusal words. `platform.executables` searches and starts it
    scrub.ts     the bound a tool input passes through on its way into a
                 thread. Neutral, because `ToolCall.input`'s "bounded" contract
                 is — every reader that mints a call goes through it, off the
                 wire and off disk alike
    events.ts    what a CLI just said, in our words — the inbound half of the
                 adapter seam. Types only: no brand's frame enum and no wire
                 method name is in the kind union
    acp.ts       line-delimited JSON-RPC 2.0, the ACP family. No brand's
                 `_meta` and no `_x.ai` method lives here
    activity.ts  real-activity and confirmed-cache-traffic clock policies; no registry imports
    brands.ts    browser-safe identity roster, guard and complete-record builder;
                 BrandId derives here and model.ts re-exports it. Required
                 declarations fail compilation when a new ID is added
    mcp.ts       neutral McpSnapshot contract, one board-read gate,
                 combination and presentation grouping. Native packages acquire
                 and normalize MCP inputs, including capability/provenance facts;
                 shared folding never reads native text. Readable config text
                 opens the gate, including empty or malformed text; a missing
                 read does not. It is not all-declaration availability. Native
                 read cwd and effective provenance survive section remapping
    mcp_target.ts declaration references and exact current-snapshot action
                 resolution. Scope and native read cwd survive repo grouping;
                 missing, changed, ambiguous and unavailable targets refuse.
                 Native auth drivers consume the resolved target. Grok uses a
                 disposable child because ACP cannot prove an owned session's
                 loaded declaration; no name-only live trigger is exposed
    adapter.ts   the seam a CLI brand is added at: the ports, the capabilities
                 a session offers as objects rather than flags, and the registry
                 — keyed adapter values must match the identity roster. The host owns
                 required account/MCP auth declarations; warm_policy owns TTL settings.
                 `ownedTranscript` attributes captured history; `captureOwned`
                 and `publishable` guard selected-thread publication; `ownedStamp`
                 reads generation without a snapshot, and `hasExchanges` asks memory
    transcript_attribution.ts selected history + recorded checkpoint/execution evidence
                 -> file claims, baselines and counts. Owns the merged Recent memo;
                 neighbor-window identities invalidate both adapter read paths
    permissions.ts
                 what a card says about a session's permission mode, in one
                 shape for every brand — a file of its own because the three
                 adapters need `asStated` as a value and `adapter.ts` imports
                 them
    claude/      Claude's stream-json adapter: launch, discovery, transcript,
                 frames and their reduction. `home.ts` is the one answer to
                 where its state lives (`CLAUDE_CONFIG_DIR`), a leaf `paths.ts`,
                 `skills.ts` and `skillRoot` all ask. `session.ts` owns delivery,
                 lifecycle, recovery and warm admission. `projection.ts` owns
                 stream-block identity and composes `tee.ts`'s frame lines and
                 task tracker onto a captured Conversation, before reduction
    grok/        Grok as the second brand. ACP stdio handle, launch line, and
                 the mapping from `session/update` / xAI notifications into
                 `events.ts`. A pid walk so a published twin folds. Its `tee.ts`
                 answers row-addressed `Teed` operations for the thread. Its
                 `projection.ts` owns recovery overlap, recovered-row admission
                 and applying those operations to a captured Conversation;
                 echo workers and native turn ownership stay in `session.ts`.
                 `transcript.ts` says which prompts the CLI's file holds, so
                 recovery and a background read keep our record unless that
                 file proves we missed prompts
    codex/       Codex as the third brand, over the app-server's JSON-RPC on
                 stdio. `runtime.ts` opens short-lived account/history children;
                 temporary children use SessionLifetime through confirmed cleanup.
                 Owned startup and experimental fallback stay in `session.ts`;
                 its usage port reuses the live client and receives canonical
                 account quota notifications without advancing activity clocks.
                 `client.ts` is the request/notify pair, `reduce.ts` maps
                 `thread/*` notifications into `events.ts`. `auth.ts` and
                 `models.ts` read the account and the product catalog, holding
                 the last good one. `discover.ts` is the pid walk.
                 `permissions.ts` spells the two-word permission mode (policy +
                 sandbox). `mcp.ts` alone skips the app-server, for
                 `codex mcp list --json`. `projection.ts` owns open-item rows
                 and closure, consuming explicit receipt and output ownership
                 from `session.ts` independently of live completion admission
    bridge/      Remote: sessions driven from a messenger. The whole
                 messenger-free core — no file here names a messenger, and
                 `bridge_seam.test.ts` greps for it. May import `ui/closing.ts`,
                 `ui/activity.ts` and `ui/views.ts`'s lineage fold, all pure
      port.ts      the seam a messenger is added at, as `adapter.ts` is for a
                   brand: `Messenger` with its capabilities as objects
                   (`edit`, `files`, `incomingFiles`, `links`, `backlog`, `reactions`, `thread` — absent means unsupported, and
                   nothing branches on `id` but `host/remote.ts`'s build of the
                   fake, whose file driver needs its handle), `LinkState` and
                   its rule (failed only when a person must act),
                   `MessengerEntry` with its own setup words, its
                   `AccountRule` (what an allowed account is, how it and the
                   space compose a sender) and its optional setup `check`
                   (ok with the space it found, a failed step, or
                   unreachable), and the
                   registry — one line here plus one sibling package is the
                   whole of a messenger
      model.ts     our shapes for what crosses it: a conversation as opaque
                   refs, `Place`, `Inbound`, `Notice`, `SessionAddr`,
                   `Watched` (a session as the notice policy reads it), neutral
                   immutable incoming admission, exact host/receiver identity,
                   stable launch/delivery evidence and typed fetch replies,
                   `Routed`, every place an inbound event can go, and
                   `ThreadLine` / `ThreadRead`, what `Messenger.thread` returns
      fake.ts      the second messenger, in memory, shipped in `src/` because
                   the host runs it in place of a real one: thread or chain
                   shape, drivers for a person's side (`missed` for one the
                   link never delivered, which `backlog` reads back;
                   `earlier` and `failRead` for `thread.read`, which this
                   messenger always has),
                   `onRecord` for the host's file driver, `held` to pin the
                   link at connecting
      allow.ts     the allowlist (exact ids, checked before anything else);
                   `resolveAccounts`, the setting through the messenger's
                   `AccountRule` and the space into the ids admitted and why
                   the rest are not; `admitAccounts`, an edit as it may be
                   written; `canTurnOn`; and the deduper for redelivered
                   events, whose window outlasts `route.ts`'s late rule
      store.ts     one record per conversation under `remote/conversations/`:
                   refs, root by pid and start (marked `remoteSpawned` when
                   the engine started it), schema-2 staged job draft (original
                   prompt, deadline, destination, catalog/target and generation),
                   last 50 notices with their buttons. Schema-1 live records
                   remain readable. Schema 3 adds frozen original incoming
                   admission independently of replay event, a separate access
                   revision/state and monotonic conversation revisions; malformed
                   optional provenance and identity collisions deny files while
                   preserving text/reactions. Its process-local ordered writer
                   compares committed snapshots and flushes before acknowledging
                   admission. Loaded/disk retention unions normal reactions with
                   incoming access/unresolved execution; retired reaction effects
                   do not resurrect on reload. Inventory completeness controls new
                   metadata budget promises. `readStoredConversation` decodes one
                   original for fetch output consistency, never authority.
                   Current-holder writes and destructive cleanup share the existing
                   writer. Button payloads are short keys into it.
                   Original message refs/tokens, durable admission/delivery state,
                   desired/applied reactions and retry deadlines survive reload.
                   Also `remote/heard`, `catch_up.ts`'s watermark. A joined
                   thread keeps `joined`, and `threadRead` once a read was
                   written; a held job may carry `threadUnread` for the
                   started notice
      access.ts    Bridge-owned committed immutable access index, exact
                   revision/digest/attempt/receiver compare-and-persist, immediate
                   dirty denial and conservative retry. Current policy is a small
                   sender/install value, with no observation journal. Indexed
                   16-MiB conversation/64-MiB machine admission budget reserves
                   provenance bytes plus 48 KiB for access/original owner receipt,
                   with additional serialized proven-no-start history charged
                   before another attempt. No service owns writable permission
                   or per-history waiters
      message_status.ts per-original-message reaction effects, independent of
                   routing; add/cleanup completion, bounded calls, abort and
                   persisted retry deadlines. No messenger wire here
      words.ts     every word Remote says, and the `Notice` builders, so a
                   copy change touches no rule. `incomingManifest` formats the durable original
                   conversation/correlation/file IDs, immutable labels and omission
                   count with the quoted absolute installed fetch command; Bridge
                   appends it to start/send/person-answer and held/started text.
                   Existing text views carry each constituent unchanged
      notify.ts    the notice policy: edges between two observations of the
                   board (waiting, settle, finished, failed, stopped, closed),
                   and which conversation a session posts in (D16, the walk to
                   its root)
      jobs.ts      where new work starts: the folders the open windows offer,
                   a held prompt's pick and its ten minutes, the fresh
                   session's window with no fallback and its prompt.
                   `threadPrompt` points a joined job at its thread file when
                   the read found earlier messages
      thread_file.ts the file a joined job hands the agent: `renderThread`
                   turns the read into one `<conversationId>.md` under
                   `THREADS_DIR`, and `writeThread` writes it. Context from
                   other people and bots, not instructions, outside any repo
      picker.ts    persisted folder/model/effort/starting stages and their
                   decoder; pure choice/revision decisions, generation admission,
                   expiry, folder availability and safe start/reload recovery.
                   PickerFlow owns reads, writes and selection effects; words.ts paginates
                   neutral choices
      picker_flow.ts  folder/catalog I/O, reload, deadlines, retry, notice effects
                   and selection recovery on Bridge's routing chain; the
                   persisted picker draft is the only selection state
      message_state.ts  conversation/message inventory, admission, deduplication,
                   collision indices, ordered persistence and shared retention.
                   Owns the access ledger and message reactions; its short
                   mutation queue never awaits routing or network
      incoming_delivery.ts  receiver/launch evidence recovery outside routing;
                   delivery manifests and start preparation for routing actions.
                   Access changes commit through MessageState
      session.ts   SessionVerbs and start/stop/end outcomes, with shared session
                   address comparison and conversation-root conversion.
                   Bridge re-exports the existing public type paths
      lifetime.ts  how long a remote-spawned session lives (D41): a marked
                   root and its live descent go cold together, at the latest
                   `cacheUntil` among them, unless any is not idle
      catch_up.ts  `CatchUp`: what was sent while the link was down. The
                   watermark (`remote/heard`) and the incomplete-read floor,
                   the read bounded by its own abort race (`CATCH_UP_MS`),
                   admission as it lands and replay on Bridge's chain, through
                   a port and never Bridge itself. A late answer after a
                   timeout or stop does nothing
      route.ts     where one inbound event goes, reading only what it is
                   handed: drop, reply, fresh, job, pick, a button's verb,
                   list, help, orphan, refuse, stale. An @mention in an
                   unborn thread — live, no root, no past, nothing held — is
                   a joined job under its anchor; a direct message there, and
                   a cancelled held conversation, stay orphan. A message older
                   than `LATE_MS` is refused with a word, never acted on
      bridge.ts    the engine: post, record the ref, act through
                   `SessionVerbs` (which the host fills), settle with the
                   outcome; every inbound event, observation, tick and
                   attachment on one routing chain. Retains notices, observation,
                   session actions and stop sequencing, including the sole stop
                   flag. MessageState owns incoming compare/persist and the
                   final closure drain. `tick` also ends what
                   `lifetime.ts` says is cold, and `nextDeadline` names it.
                   `attach` opens a root's conversation when it has none, and
                   refuses an exited card before either post (the same
                   refusal as `findTarget`; a send already started is left
                   as it stands). A
                   notice that failed to post keeps its session's earlier
                   entry in the board the next pass compares against, so it
                   is derived again; a link coming back hands `catch_up.ts`
                   its read. Its own Reconciler tenant (`register`) retries
                   reactions and incoming writes; `nextDeadline` is routing
                   only, so a retry runs no pass. A joined job reads
                   `Messenger.thread` before
                   the prompt is held, and writes the file when that read
                   succeeds; a later reply or fresh start there reads it again
    remote/      Remote's rules about this machine's windows and sessions, under
                 `host/remote.ts`. Names no messenger
      board.ts     the observed board: this window's handles plus every other
                   window's published records, live or holding their exit
                   (a crash its window still draws), joined to lineage — no
                   `discoverAll`, no read of `~/.claude`; names by
                   `ui/views.ts`. `findTarget` for M3
      attach.ts    which files an agent may send and how often, one copy for
                   the shim and the holder: the roots (its cwd, its working
                   tree, temp), the hidden-component and deny rules on the
                   realpath, the 10 MiB cap, the caption, the MIME table and
                   `AttachGuard`'s one cap, ten a minute per session
      serve_attach.ts  the holder's `attach` arm, ahead of the owned lookup in
                   `host/request_host.ts`'s `serveRequest`: holds, guard, a pass
                   run now for the target, the checks again, then the checked
                   bytes read into memory and posted from there: no path
                   travels past the check
      incoming.ts  `IncomingFiles.fetch`: committed original membership/current
                   policy, exact holder/receiver and challenged lifetime receipt
                   before provider metadata, download or cache return. Independent
                   event waits (10/receiver, 40/holder), one 45s monotonic budget,
                   generation/closure/abort fences and late completion denial.
                   Uses Bridge's resolver without routing, launch, send or post.
                   Composed by RemoteSwitch with independent evidence wakes;
                   dispose aborts immediately and drains local writes, never
                   waiting on an abort-ignoring provider.
      incoming_cache.ts  managed temporary bytes, never permission: verified
                   capability root, provider-qualified hashed names, exclusive
                   partials and atomic complete inodes, bounded manifests,
                   integrity checks, 24h expiry/refetch and conservative existing
                   byte/reservation accounting. Short process-local accounting
                   queue under the existing single-holder lifecycle; no network
                   or pending wait in it. Exclusive-holder crash/expiry sweep
                   preserves active reservations and neighboring files.
      verbs.ts     `SessionVerbs`: this window's handle in memory, else a
                   request to the session's window; End delegates to session_end
                   with human signal authority. Explicit refusal stays terminal
      serve_fetch.ts  holder-only fetchFile arm before owned PID lookup;
                   typed fetch result from IncomingFiles, without a routing pass
      holder.ts    which window holds Remote, as pid and start time in
                   `remote/holder.json`: exclusive create, a dead holder (or,
                   at a press, one no live claim names) removed only under
                   `holder.json.lock`, released only by its holder (D37), and
                   the window's claim removed only after that (`unclaimAfter`).
                   Incoming holders require exact native death for takeover,
                   ignoring claim expiry; release compares the generation.
                   Present but unreadable incoming metadata is held, never taken
      switch.ts    `RemoteSwitch`: one window's switch and the pass over
                   ports — turn-on in D37's order, release on a failed build,
                   the holder lost, stop before release, the rebuild, the
                   remembered switch. It registers the pass; each engine
                   registers its own retries through the same port, so a
                   slow pass cannot hold them.
                   Composes holder-scoped IncomingFiles and housekeeping;
                   drains local writes before release or rebuild activation.
                   The host and `remote_helpers.ts` both run it
      link.ts      the lifecycle reducer and `RemoteView`, every reason
                   redacted as it is stored; the restore rule and the
                   remembered switch
      check.ts     `CheckRunner`: the setup check over ports — one in flight,
                   each start tagged with the credentials' generation so a
                   finish from before a change is dropped, a change event
                   acted on only when a re-read's digest differs from the one
                   the check ran under, abort on dispose. The setup verdict
                   reads only this runner's state, independently of the link.
                   The host and its tests both run it
      fake_files.ts the fake messenger driven through `remote/fake/`: one event
                   per `inbox/*.json`, read on the driver's own clock once the
                   switch starts it after connect — not on `host/watch.ts`,
                   whose delivery lags by seconds; posts, settles, files and reactions appended to
                   `outbox.jsonl`, and every setup check, answering the
                   undeclared `squadron.remote.fakeCheck`, to `checks.jsonl`
                   with Remote on or off. Test-only, behind the undeclared
                   `squadron.remote.messenger: 'fake'`, and only outside a
                   Production `extensionMode`
    slack/       Slack as the first messenger: the only code that knows its wire.
                 Nothing outside it names Slack's thread key, its markup or its
                 token prefixes, and `slack_seam.test.ts` greps for them
      messenger.ts the messenger seam beside the brand seam (`adapter.ts`):
                   `slackMessenger` fills `core/bridge/port.ts`'s `Messenger`,
                   and `slackEntry` is its one registry line there, with the
                   setup words, the token checks and `slackAccounts`: a member
                   id composed with the workspace, or a whole `team:user`. The
                   two tokens live in its closure and nowhere else.
                   `thread.read` is `conversations.replies` older than the
                   mention, every page to it, keeping the newest
                   `THREAD_WINDOW` and counting the rest in `total`: the
                   bot's own rows dropped, other bots kept.
                   `missing_scope`, `not_in_channel` and `channel_not_found`
                   are `scope`; any other failure is `unreachable`. A
                   `users.info` miss falls back
      wire.ts      Slack's shapes narrowed field by field: Socket Mode frames,
                   the two subscribed events, a press, a slash command, a Web
                   API reply, a message's author and file names, and the
                   `<channel>:<ts>` ref
      api.ts       the Web API over `fetch`: bearer header, JSON or form, error
                   codes, the 429 wait, one post in flight per channel.
                   `history` and `replies` return rows, up to
                   `HISTORY_PAGES`, for `backlog`; `replyPages` walks a thread
                   up to `latest` at `THREAD_LIMIT` a page with no cap, for
                   `Messenger.thread`. `userInfo` names a member
      socket.ts    the Socket Mode connection: connect, ack every envelope,
                   refresh with overlap (one at a time, retried), backoff that
                   resets once a link held, the ping watchdog and a hello
                   deadline. Its timers are the transport's own, not the
                   Reconciler's
      ws.ts        the one file that imports `ws`
      no_native.ts what `ws`'s two optional native add-ons resolve to in the
                   bundle: a module that throws
      inbound.ts   an envelope, or a history row, as `Inbound`: drops the bot's
                   own and other bots' messages, keys the sender `team:user`
                   and a message on its `channel:ts`, reads `/squadron`
      render.ts    a `Notice` as Block Kit plus the push text, a table as Slack's
                   `table` block cut between rows: deterministic, so
                   a settle re-renders; bodies split on fences, never cut, and
                   Slack's control tokens in agent text sent as text
      download.ts  authenticated incoming originals: exact-install provenance,
                   fresh files.info, operation-scoped private URLs, separate
                   bounded binary transport with manual same-origin redirects.
      files.ts     the three-call external upload into a thread, from the
                   bytes it is handed, the caption escaped
      manifest.ts  the Slack app Squadron ships, and its create-from-manifest
                   link. `OPTIONAL_SCOPES`, by feature — `reactions:write`
                   for reactions, `channels:history` and `groups:history` for
                   thread context, `users:read` for author names — are asked
                   for and do not fail the setup check
    owned_incoming.ts  activation and entry identity from tagged native process
                 starts and the actual child pipe. The receiver is the spawned
                 root itself; a native CLI below a wrapper root is not its
                 identity. Lifetime original launch and delivery receipts,
                 irreversible queue dismissal, acknowledged publication revisions and one-shot launch reservations. Host
                 sessions keeps the registry; this module keeps no second one
    startup.ts   monotonic opening deadline, cancellation and once-only settlement;
                 caller transport expiry does not retire this operation
    session_lifetime.ts  native scope registered before adapter opening, shared
                 by failed starts, End, shutdown and temporary usage readers;
                 adapter cleanup plus verified
                 child/descendant escalation, durable member observations and idempotent
                 release; native exit and bounded-backoff retries reconcile retained cleanup
    temporary_session.ts  one temporary transport through native cleanup;
                 cancellation closes its pipe, return waits for confirmed exit
    coordination/owner_claim.ts  complete exclusive owner publication and fenced
                 dead-owner recovery, shared by startup admission and usage.
                 `acquire` is their one bounded wait, for a held claim or a
                 contended error, and reports that error if the bound ends on it.
                 New pid/start evidence carries its start source; untagged bytes are
                 `ps-lstart-v1`. `judge` says live/gone only on a complete table
                 on the record's clock, so another clock is never proved gone
    coordination/usage.ts  usage-refresh.<brand>.json: current attempt, account
                 generation, cooldown and the live backoff (`activeAfter`).
                 Short state transactions admit one read at a time: the
                 fallback's `attempt`, released by native cleanup and not a
                 protocol reply, or the `live` slot, which older hosts never see.
                 Owner and members are source-tagged; another clock retains
    coordination/startup_records.ts  strict machine-wide agent admission under
                 exclusive claim; versioned startups/ receipts hold opening and
                 unresolved cleanup capacity separately from successful lineage. Dead-owner
                 bound receipts recover only after exact root/member absence;
                 unbound spawning stays unknown; abandoned temporary writes are pruned
    session.ts   shared JSON child transport, launch file preparation and
                 unprompted-close confirmation; CLI semantics live in each
                 brand package
    live.ts      frames -> the card of an owned session: status, asks, model,
                 name, the outbox. A pure reducer, so a rule about that state
                 is a test rather than something to watch happen in the IDE.
                 The dock draws its turns from core/thread.ts, and the record
                 is written behind that
    incoming.ts  shared bounded neutral incoming-contract codec: fixed admission
                 tuple digest, immutable descriptors, exact identities, challenged
                 evidence and typed replies; a receiver shares its host's start
                 source. Syntax is not live authority; no
                 provider/network/filesystem service here
    message_facts.ts optional correlation facts, bounded native-turn history,
                 terminal attribution and validation at trust boundaries.
                 Merged prompts retain every original token; unknown is not success
    session_end.ts shared End execution for panel, Remote and CLI: local close
                 or owner request, per-member outcomes, fresh unhappy-path
                 identity/ownership checks and one bounded owner/uncertain-reply retry. Explicit
                 refusal stops; signal fallback exists only when supplied by
                 the caller. observeEnds batches process/selected-publication reads;
                 the owner's ending timestamp respects model.endPending, also
                 used by the card deadline
    session_target.ts neutral kind/owner facts, bounded control decoding and
                 compatibility reading; resolves a selected session to an advisory
                 pid/start/window address. Matching publications can prove exit;
                 missing owner claims stay unconfirmed. No caller authority or I/O
    published.ts the live half of an owned session, written down where another
                 process can read it — a file, for the same reason claims and
                 lineage are, and never trusted without a live twin beside it.
                 Its readers are the `squadron-*` shims, `host/waits.ts`,
                 Codex's discovery and the resume picker's duplicate guard. The
                 panel's board reads none of them. Remote reads optional message
                 facts and strictly decoded optional incoming identity/launch/
                 delivery evidence without changing schema 1 or the liveText
                 compatibility path. Incoming evidence requires fresh owner proof. Stopping conversation records
                 retain exact known native members without advertising a driveable
                 session. `readPublished` is the display read and skips what it
                 cannot read; `readPublishedEvidence` keeps an unlisted `live/`
                 and each unreadable `<pid>.json` for ownership and waits; a
                 record that names no conversation (`identified`) counts as
                 unreadable. `PassEvidence` is one wait pass's reads.
                 `conversationOwner` is the resume decision: held on a live or
                 stopping record, free only on a complete table from a
                 recognized clock with every record a running pid has read,
                 otherwise unknown (refused, retryable)
    execution.ts scoped runtime admission, immutable runner installation and
                 native-child ancestry notes; no native hook vocabulary
    checkpoint.ts TurnCheckpoints lifecycle: private baseline, capture chain and
                 tracked trees; preserves the public checkpoint import surface
    checkpoint_model.ts shared snapshot/evidence types and execution identity keys
    checkpoint_git.ts Git snapshots/diffs/reflog, per-owner warm indexes,
                 timestamp-safe seed/publish copies and lock-aware cleanup
    checkpoint_journal.ts per-tree evidence and private runtime-note storage,
                 decoding/projection, size/mtime and alias-source identity caches
    checkpoint_execution.ts execution capture, turn source selection, pending-call
                 settlement and runtime cleanup; no coordinator state
    checkpoint_attribution.ts pure rewrite suppression and neighbor subtraction
    checkpoint_record.ts reserves an ordered thread slot and serializes the
                 captured checkpoint after writing its neighbor window
    prune.ts     the age sweep the per-session files need, since nothing that
                 writes them ever removes them
    arrange.ts   where the reader put the cards: one file per group, holding the
                 top-level slot order as pids guarded by their start times, so
                 an arrangement lives exactly as long as its sessions
    theme_names.ts every theme name the panel can paint. A leaf, so the picker
                 and the folder store share one list
    repo_theme.ts the folder this window opened and the theme it keeps: one
                 file, never swept. Absent falls back to `squadron.theme`
    acks.ts      which sessions the reader has opened, as an empty file per
                 session whose mtime is the mark — so a `done` that has been
                 seen stops being said
    names.ts     the **stated name**: what a person or an agent said a
                 conversation is called, one file per named session keyed by
                 brand and session id. Ours rather than any CLI's, so a brand
                 with no rename door still renames and a brand whose echo never
                 arrives is not waited on. The top rung of `naming.ts`, and
                 never swept — it is what makes an old picker row findable
    naming.ts    which of several names a card wears: five rungs, and the one
                 place a `nameSource` word is read as a kind of claim. Both
                 `live.ts` and `ui/views.ts` rank with it — never a second copy
    asks.ts      an AskUserQuestion's questions, narrowed field by field
    answers.ts   picks and typed words -> the payload the ask tool takes
    backlog.ts   the tickets tab's state machine: complete scope catalog, remembered
                 selection, atomic scoped snapshots, TTL and retired request/action tokens
    pastes.ts    images written down so a path can carry them to the CLI
    markers.ts   `[Image #N]`: which image a message's prose means, given that
                 the bytes ride after each message's words rather than among
                 them. The one rule both halves share — a leaf with no imports
                 of its own, which is what lets the bundle take it, beside
                 `tokens`, `model`, `model_names`, `workflows/graph` and
                 `workflows/authoring`
    ticket_ref.ts   portable ticket references: identifier plus validated HTTP(S)
                 URL, shared by host validation and mention recognition
    session_ref.ts  `@squadron[pid][transcript]`: what a card's copy writes and
                 what the dock and the composer draw back as a pill. A leaf for
                 `markers`' reason
    transcript.ts  the session's turns, its queue, its images
    conversations.ts  a directory's past conversations, from our own transcript
                 store. Every open reads every family record in the 30-day window, so
                 rows rank by recorded activity and never by file mtime. With no
                 catalog the open first reads every record's header; that catalog is
                 published after the reply, and the next read waits for it. The host
                 posts rows before invoking maintenance and disposes the reader
    conversation_catalog.ts  rebuildable `catalog/transcripts.v1.jsonl`: bounded
                 header discovery, complete file witnesses and family summaries read
                 through per-worker buffers. Raw cwd storage, platform path comparison
                 and owned atomic publication; no writer hooks, resident cache or
                 daily archive scan
    conversation_pages.ts  the resume picker's pages: one frozen ranking per open
                 (page 1 under the asked-folder floor, then activity order), slices of
                 20 up to 500 loaded rows, a query view by activity with no floor, and
                 stated names captured per key. `ConversationSnapshots` is the panel's
                 one snapshot: replaced per open, dropped on dispose or 10 min unused
    thread.ts    an owned conversation's thread, in the process that holds
                 its pipe. Entries are keyed by row id and ordered by the
                 ordinal stamped at enqueue. The dock draws one snapshot per
                 selected-thread read. End asks the same memory after recovery. The record
                 is written behind in that order and read once, on a resume,
                 to recover what came before the pipe
    recovery.ts  resume history state and first-send latch for owned adapters; each brand
                 keeps its baseline reader and recovery-completion hook
    record_index.ts record-owned ephemeral byte offsets and true note targets;
                 cold chunk scan, append-only updates and bounded page reads.
                 No durable index. readRecordPage uses it, and readBaseline
                 retains global witness coverage before capped materialization
    record.ts    our own transcript of a conversation, written behind the
                 in-memory thread the owned dock draws: one `<sessionId>.jsonl`
                 under `transcripts/`, plus the image bytes a turn handed
                 the composer. A resume reads it once and draws it when
                 drawable. A session with no pipe does the same each refresh.
                 The CLI's file is the fallback for what we never witnessed
    usage.ts     the account's plan usage, for every brand: `usage.<brand>.json`
                 is canonical, memory mirrors it. Newest stamp wins per window,
                 never a percentage comparison. Readings come from the adapter's
                 `usage` port; only a sign-out deletes one. Fresh observations
                 persist their stamps even when percentages stay the same; only
                 a numeric window is an observation, so a declaration neither
                 restamps "updated" nor postpones the fallback. `readLive` is one
                 activity-driven read under live admission
    usage_refresh.ts  three Reconciler tenants over normalized usage ports:
                 passive observations, activity-driven reads (`LiveHints`: a
                 turn ended or running in this window; `liveReaderFor`: a pipe,
                 or a `childless` source, never a temporary child) and the
                 hourly fallback; independent of the panel
    usage_policy.ts  the 60-minute fallback and the live bounds (one read per
                 brand per 60 s machine-wide, 2 s settle, 5 min failure
                 backoff), and `liveDue`, the deadline both sides recompute
    claude/usage_reader.ts  get_usage on a control-only temporary child;
                 decoding remains in the leaf claude/usage.ts
    signin.ts    whether each CLI is signed in: the answer stored under
                 `signin.<brand>.json`, reused while the adapter's `account`
                 stamp holds, so a CLI is started only when the answer is
                 missing or a verb forces it. A failed ask waits a minute. Also
                 when an `'account'` model catalog is re-read: once per stamp
    context.ts   the window a session's tokens are a share of, so a card states
                 a percentage before the session has stated its window. What
                 a model id was seen to answer in outlives the window that saw
                 it: `models.claude.json`, beside the usage store
    tickets.ts   shared ticket source contract, scoped keys, individual detail reads and view projection
    tickets/linear.ts Linear GraphQL transport, native field translation,
                 team/member/state pagination and provider presentation metadata
    hooks.ts     removing the hooks older builds installed in the CLI's
                 settings. Nothing installs one now
    jobs.ts      the background-job files a non-interactive session writes
    workflows/   authored workflows, execution progress, and displayed order
      examples.ts  activation's one-time offer of packaged examples: exclusive
                   marker claim, non-overwriting copies. The permanent
                   `workflows.examples.seeded` marker survives user deletion
                   and extension updates; reads and polls never reseed
      workflows.ts the authored half of a workflow: what the user wrote down,
                   whether the whole chain can run where they point it
                   (`armWorkflow` for a spawn, `armMention` for a send), each
                   `uses` looked up in the skill folders of the brand that runs
                   its step (`statedBrand`, `SkillDiscovery`), and the
                   one line a mention puts on the wire — the id, never the path
                   or the steps. The one directory prune.ts never sweeps
      progress.ts  public API for the four progress owners below
      progress_store.ts  session-keyed `runs/<sessionId>.progress.json`:
                   types, seed, validation, reads, writes, and cancellation
      progress_display.ts  completion tally and dates, live chip and observe
                   rail. The panel only reads — it never advances a step or
                   invents one from the transcript
      progress_briefing.ts  first-turn seed and briefing; mentions stage beside
                   the live record until the send is taken
      progress_execution.ts  pure cursor serving/completion and cross-lane
                   readiness, startup and wait-loop rules. Cursor and waits
                   share dependency rules; callers write, spawn and register
      next.ts      what `squadron-step next` does, as a value: serve, open
                   (with the ends to perform first), wait, or refuse. The one
                   place its order lives. `cli/step.ts` acts on it and asks
                   again after an open
      wait.ts      dependency waits read that run and reuse its readiness:
                   wake for a step or lane opening, a stall, or expiry;
                   ordinary session waits still resolve on idle
      graph.ts     the graph of a workflow, derived from the steps (and the
                   file's `lanes`, for column order): which needs resolve (`needsOf`), where the
                   canvas puts each step (`layout`), and which step opens a
                   lane (`opener`) — the one place that rule lives.
                   Import-free, so the webview bundles it
      authoring.ts the structural rules `validate()` and the editor share, and
                   every draft edit as steps in, steps or a refusal out.
                   Import-free but `graph.ts`, so the webview bundles it
      workflow_order.ts  the reader's ordering
    checklist.ts the step list a session keeps for itself, dated against the
                 last prompt so a finished one stops speaking for work the
                 session has moved past
    limits.ts    dates normalized rate-limit readings without reading a clock, and
                 merges them window by window (`mergeReadings`, newest stamp wins).
                 Native decoding and window selection live in each brand's
                 usage.ts; Claude's get_usage decoder is core/claude/usage.ts
    files.ts     the filesystem questions no one module owns — `writtenAt`, and
                 the file idiom every store under `~/.squadron/` is written in:
                 `writeAtomicJson`, `writeAtomicText`, `readJson`, `readJsonDir`
    web.ts       whether an untrusted string is an http(s) URL the host may
                 hand to `openExternal`. The scheme check `openTicket`,
                 `openServer` and `openLoginUrl` all share, because that API
                 honours `command:` and `vscode:`
    cache_ttl.ts how long a session's prompt cache lives, and who said so:
                 its brand's figure in the policy, `measured` at the default
                 and `configured` once a setting moves it. What the CLI
                 reports is never read. `CACHE_TTL` is each default's tip,
                 worded off `warm_policy.ts`'s `CACHE_BASIS`;
                 `warmConfig()` is the Warm column's pushed figures, in
                 Claude, Codex, Grok order, buffer and window included
    warm.ts      whether a ping is due now, held and why, or when the next is
                 (`warmDue`), which sessions have Warm on (`warmOn`, what the
                 keeper holds for — the switch, never a ping), whether the
                 last one found the cache
                 (`warmVerdict`, re-exported from the policy leaf), and when
                 the window has lapsed and the switch goes off (`warmLapsed`)
    warmer.ts    `CacheWarmer`, the Reconciler tenant that pings an idle owned
                 session before its cache expires, and switches Warm off once
                 its window lapses. Every rule is core/warm.ts; this holds the
                 pass, the last failure, and the policy generation that drops
                 a pass a settings change overtook. The window's reads and
                 writes arrive as `WarmerPorts`, from host/warm.ts
    warm_policy.ts what the warmer times against (`WarmPolicy`): each
                 brand's TTL, the ping buffer and the warm window, all
                 `squadron.warmCache.*` settings in minutes. `CACHE_BASIS`,
                 each brand's default and the docs or probe figures behind
                 it, which the guards' no-stamp bound also reads. The
                 defaults and bounds `package.json` repeats, `warmPolicy()` clamping
                 whatever settings.json holds, the wire key → setting table
                 and `warmSettingWrite`, plus the verdict thresholds.
                 Browser-safe leaf: imports only `model`
    warm_choice.ts  a session's warming choice, one file per conversation
                 under `warm/`, beside the default it overrides. Never swept
    awake.ts     whether this machine should be kept awake, and how much awake
                 is left in it: the safeguards — Remote and Warm as optional
                 reasons below the battery floor — the lease clock the
                 Keep-awake drawer draws, and the per-window record every panel merges. Pure — the child
                 process and the triggers are host/keepawake.ts
    machine.ts   CPU tick sampling, metering and the machine readout projection;
                 `readMemory` projects `platform.memory.read()` to a reading or
                 nothing. `docs/reference/machine_memory.md` records which OS
                 memory figures agree with the machine's own UI
    devservers/  runnable apps, ports, and the processes occupying them
      ports.ts     dev-server numbers: which ports in a start's block are taken —
                   both address families, which is the whole point — whether one
                   is answering, and what each branch picked last. The block is
                   derived per start from its toolchain's port (`resolveBlock`);
                   one in the ports file is a repo-wide override
      unsafe.ts    which ports the sheet never offers, and the words why:
                   below 1024, the ephemeral range, and the ones browsers
                   refuse. A leaf, so the webview bundle takes it
      listeners.ts who is on a port, asked of the kernel rather than of our own
                   registry: `platform.listeners` twice, port -> pid -> cwd. `ports.ts` says a
                   port is taken, this says by what — the reading that survives a
                   sleep the heartbeat slept through. `sessionListeners` is the
                   one test of a server being ours: below an owned session now
      runners.ts   what a directory can be told to start: the one obvious script
                   or none, the measured port flag and default port per
                   toolchain, and the extension dev host as a runner that takes
                   no port
      servers.ts   which dev servers are running and where. Alive-only, swept on
                   staleness like a claim — what a branch used last is ports.ts;
                   this window's dead records vs the ones still live is `reconcileServers`
      workspaces.ts workspace declarations and the bounded project-directory walk
    catalog.ts   maintained model metadata, one `CatalogRow` shape per brand —
                 what the panel offers, since the CLIs' own lists omit runnable
                 rows. A leaf: `import type` only
    models.ts    the `list_models` request, kept as a maintenance tool now that
                 `catalog.ts` answers the panel. `models.mjs claude` diffs the
                 two both ways; nothing on the runtime path imports this
    model_listing.ts  model-discovery wire shape, native efforts, captured Remote
                 defaults and receiving-window selection validation; projection
                 of the picker's offered rows, with brand availability and
                 catalog provenance
    model_names.ts  which row of that list a spelling names — one model has
                 three names on the wire. A leaf, so the webview bundle takes it
    verbs.ts     every `squadron-*` verb by bare name, whether it writes, and
                 the Agents drawer's line for it, plus `ORCHESTRATION_OFF`, the
                 one refusal sentence. Read by the CLI gate, help, the window's
                 spawn and send checks, and the drawer. A leaf, so the webview
                 bundle takes it. `paths.ts` `SHIM_NAMES` stays the install
                 list; `verbs.test.ts` holds the two and `dist/` to one set
    model.ts     types, and `isMidTurn`: which statuses hold a turn open, the
                 one copy host and webview both read
    identity.ts  the environment each CLI plants for its shell tools, one row
                 per brand. Outside a package because no single adapter can
                 name its siblings
    cli_home.ts  whether a CLI's override names one place: absolute, or read as
                 unset. Each brand's `home.ts` applies it to its own variable
    scratch.ts   canonical managed root, attempt-stable per-session working
                 directories and enclosing-Git refusal; user files persist
    state_watch.ts  discovers and maintains recursive watches on direct state
                 directories, excluding user scratch; host supplies watcher ports
    paths.ts     each CLI's locations, off its `home.ts`, and our own stores beside them —
                 `TRANSCRIPTS_DIR` and the `ATTACHMENTS_DIR` inside it among
                 them, so the two halves of one record sweep together; and
                 `REMOTE_DIR` with the conversations, the thread files and the
                 holder file in it; and `verbCommand`, one of our
                 installed verbs as an agent is handed it
  cli/           the agent-facing half — no vscode import
    help.ts      shared public command help and scoped step help; returns before
                 parsing operational arguments or reading state. Portable text
                 and stdout only; launcher and shell behavior stay at the OS seam
    workflow-validation.ts checks an authored JSON file against the shared
                 workflow rules, returning diagnostics without starting a run
    models.ts    `squadron-models`: asks spawn's selected window for its model
                 choices, availability and provenance as JSON
    gate.ts      Orchestration's gate, run by every write verb after its
                 arguments parse: the caller's own window claim while live,
                 else any live claim on; none live exits 3, off exits 2 with
                 `ORCHESTRATION_OFF`. Not a boundary — a hand-written request
                 skips it, and the window's spawn and send checks stay
                 authoritative. Owns `NO_WINDOW`; no entry point
    windows.ts   origin routing shared by spawn and model discovery, then the
                 cwd tiers of core/coordination/claims.ts with their fallback;
                 no CLI entry point, so importing it cannot execute another
                 verb
    execution.ts internal native-hook entry: adapter decoding, shared capture;
                 bundled separately, never installed as an agent-facing verb
    spawn.ts     `squadron-spawn`: picks a window and posts the open request.
                 Bundled to dist/ whole, since it runs outside the extension
    open.ts      the open request itself, shared by spawn and step. No entry
                 point: in a bundle every verb's `require.main === module` is
                 true, so a verb that imports another verb's file runs its `main`
                 too (`cli_bundles.test.ts`)
    end_plan.ts  whether one `squadron-end` would end a session; closeMembers
                 delegates execution to session_end without signal authority.
                 closeOne also serves workflow cleanup. No entry point of its own
    end.ts       `squadron-end`: what a session may take down — its own
                 descent, plus itself, or any session under `--any` — and the
                 close request it posts for each
    list.ts      `squadron-list`: what is running, as JSONL. The panel's own
                 fold from outside it. It asks no window — everything it reads
                 is on disk, so there is no exit 4 — but `loadBoard` still
                 needs a live claim, and exits 3 with none
    send.ts      `squadron-send`: one session's message to another. Wraps it
                 so the target's dock can say who sent it, checks the
                 guardrails here as well as in the window, and posts a `send`
                 request like its siblings
    answer.ts    `squadron-answer`: one session answers another's open
                 question. `send --interrupt` with the question's address on
                 it: checked against the published record, worded as a click
                 reads, delivered as the asker's next prompt. A permission is
                 always refused
    wait_plan.ts the decision a wait registration makes, shared by wait and
                 step, with no entry point for `open.ts`'s reason
    wait.ts      `squadron-wait`: be told once when these sessions are done.
                 Registers and returns — it never blocks, and it asks no window
                 (the gate only reads claims, so none live exits 3), so it
                 writes an unaddressed record and has no exit 4
    attach.ts    `squadron-attach`: a file to the caller's own conversation
                 under Remote, never another's — no `--pid`. Checks the
                 identity, the holder and the file here, then posts to the
                 holder, whose answer counts. Gated like every write verb
    self.ts      exact incoming caller: one fresh complete native process scan,
                 bounded nearest-ancestor walk over owned publications and CLI
                 process barriers, then incomingEvidenceV1 receiver challenge.
                 Environment hints check only the proved brand/current session;
                 no PID or ancestor fallback, no session-ID ownership match
    fetch.ts     `squadron-fetch-file`: original conversation, message correlation
                 and file ID only. Self supplies frozen receiver/current ID;
                 current holder receives fetchFile with a 60s wait. Retained
                 original descriptor checks cache metadata, never permission.
                 Exact typed reply, canonical managed root, private regular
                 inode, manifest/key/hash, byte cap and expiry precede JSON stdout
    rename.ts    `squadron-rename`: the caller's own card named, or any card
                 by `--pid`. The door is `stateName`, not a message; the pipe
                 it needs belongs to a window, so this posts a request like its
                 two siblings
    warm.ts      `squadron-warm`: one card's Warm switch on, or off with
                 `--off`, by required `--pid`. `warmPlan` refuses background
                 and gone sessions here; the window holding the pipe serves it
                 beside `rename` in host/request_host.ts and calls
                 `sessions.setWarm`. Warm's window and lifetime apply as to a
                 flip on the sheet; no `squadron.warmCache.*` setting moves
    step.ts      `squadron-step`: one step of the workflow the caller is
                 following, served when it asks — the agent pulls so it never
                 reads the chain ahead. Asks no window (the gate only
                 reads claims, so none live exits 3), and writes the cursor
                 `core/workflows/progress.ts` owns. `next` performs what
                 `core/workflows/next.ts` decides: ends, opens, the wait
                 and the write
  ui/            the panel's view built headlessly — no vscode import
    confirmations.ts one pending host confirmation per panel: offered action ids,
                 one-use replies and cancellation on replacement/reload/disposal
    chat_state.ts one private record per session incarnation or cwd draft:
                 compose data, thread, pending operations and reading state;
                 the only owner of active chat identity, selection request nonces,
                 ordered thread acceptance and session binding through startup
    compose_doc.ts a compose box's document as plain data — the editor's
                 snapshot, typed here so `ui/` never imports TipTap — and the
                 pure reads over it: emptiness, equality, the block append
                 promotion and an offscreen ticket share, and the capture
                 that numbers its images
    views.ts     sessions + claims -> GroupView/CardView/ThreadView, and the
                 lineage fold: who a card's live parent and children are, and
                 which cards a group boxes together as a family. An owned card
                 may already carry its spawn parent and origin; discovery fills
                 either only when the card does not. A group's server rows come
                 from `server_views.ts`: `serverRows` for the sheet, `repoOfTree`
                 for which repo a running server belongs to
    server_sheet.ts  what the line and the servers sheet decide about a repo's
                 rows: live or not, the rail's worktrees, a start joined to its
                 server, a start's default port, when occupancy has moved
    server_views.ts  one repo's server rows from `ServerContext`. Branch rows,
                 unmatched running servers, and session servers. Exact repo
                 match precedes workspace containment. `EPHEMERAL_FLOOR` is the
                 port the stop re-asks. No poll, bind, or process of its own
    activity.ts  one tool call -> the line the dock puts beside it, whatever
                 tool it was and whatever shape its input arrived in
    fold.ts      which turns a settled exchange hides behind one row, so a run
                 of forty calls reads as a line and opens on a click
    text.ts      the renderings more than one view shares — `shorten`
    local_path.ts  browser-safe path separator grammar and leaf labels: only
                 drive-absolute and backslash UNC shapes spend backslashes as
                 separators; slash-prefixed UNC leaves backslashes literal
    file_open.ts written-file opening policy after Uri.file: authority targets
                 stay in the file service, including HTML
    file_link.ts local turn-link parsing, decoding and source positions; raw
                 native spellings reach `openFile`, without a host OS guess
    turn_blocks.ts  one run of a settled turn's prose for the wire: a `user`
                 turn as source text for the webview's prose parser, any other
                 through the host's engine
    remote_view.ts  Remote's words and decisions off M2's `RemoteView` and the
                 selected messenger's setup: the switch, whether Remote is on in
                 any window (`link.ts` decides both), the tone, the status,
                 reason and refusal lines, the warnings and their fix, what
                 setup is missing, the messenger rows (the not-built ones with
                 their tips), the setup check's sentence and step marks, and
                 the setup column's content. The blob and the create link stay
                 host-side; no credential is a field
    awake_rows.ts the Keep-awake drawer's words: the master switch's state
                 and detail off the merged hold, the two switches and the
                 clock; the figures. The figures themselves are `lease.ts`,
                 the leaf both the keeper and the bundle reach
    flip_hold.ts a control's flip held on screen until a push agrees, or
                 until the host's choice reply comes back without the value.
                 `shown` only reads; `FlipHolds.settle` retires, for every
                 hold in the set at once
    warm_rows.ts the warm list's words: a row's lifetime, provenance and
                 clause off `CardView.warm` and the clock, and the bar's count.
                 The note is the pushed window (`warmNote`); the lead before
                 expiry is the configuration column's figure
    mascot.ts    the mascot's rules, headless: `facts` diffs two pushes into
                 what it reacts to (a dialog, an unread finished turn, a new
                 card, everything idle, the keep-awake hold ending — none on
                 the first push), the poses each holds, and the `Director`
                 that batches them for 1.2 s, cools down 8 s and flies at most
                 four times a minute, on an injected clock. Also `runs`, a
                 baked frame back into spans
    mascot_frames.ts  the chick's nine frames as run-length tone strings —
                 generated by `scripts/mascot.mjs` from
                 `scripts/assets/mascot/chick.mjs`, never hand-edited; a test runs
                 its `--check`
    reading.ts   what a card says and which nav count and hue that is: `resolve`
                 ranks a session's facts once on the host (`toCard`), owning
                 which facets may speak; `reading` picks unread until deliberately acknowledged, so card,
                 dock pill and nav paint one shipped answer
    changelog.ts packaged release sections, filtered through the running version
    document.ts  the panel's document: markup, stylesheet assembly, inlined script
    format_controls.ts shared formatting control markup, optionally filtered
                 to a caller's format list; chat keeps all eight
    css/         surface stylesheets (`base`…`cafe`); order is the cascade —
                 `panelStylesheet()` joins them; do not reorder lightly. Each
                 file is one template literal, so a backtick in a comment ends
                 it — the build error points at the next line and reads like
                 bad CSS. Three times now; write the identifier bare
    icons.ts     the inline SVGs
    marks.ts     the Squadron wordmark and Eclipse as data URIs, for the
                 watermarks — generated by `icons.mjs`, never hand-edited
    wfroute.ts   the lane canvas's wire router: measured rectangles and an
                 edge list in, SVG path data out
  webview/       the panel's browser half, emitted as one script (see below)
    dom.ts       element lookup and construction, the card formatters
    state.ts     the host handle, shared elements, panel state and chat-state exports
    kit.ts       the controls and the invariants they own: icon buttons,
                 dropdownTrigger UI (wrapper/button/label/caret), independent
                 opensMenu popover, the guard that holds a bar still while its own
                 menu is open, and the keyed morph every repainting container
                 goes through instead of replacing its children
    boxes.ts     editors kept across the paints that place them: the dialog
                 layer's boxes, one plain editor per owner, and the workflow
                 editor's step prompts (`keptBox`); `rebuild`, which rebuilds
                 a surface without taking one out of the document; `sayBox`
                 and `bailBox` around them. Apart from `kit.ts` so that
                 nothing wanting a menu loads TipTap
    tip.ts       the panel's own hover explanation, in place of the host's
                 `title=`: content on data attributes so a morph cannot lose
                 it, one delegated listener, and two renderings — a phrase and
                 a keyed readout
    sound.ts     the two notification cues, synthesised rather than played
    board.ts     board orchestrator: paint, slots, measure, re-exports
    board_repaint.ts  lazy repaint hook (breaks ticker ↔ paint cycles)
    board_stamps.ts   prompt-cache clock, since(), tickStamps
    board_card.ts     card and family paint, scramble, blocked, findCard
                      (the word a card wears is ui/reading.ts)
    board_warm.ts     viewport observation and morph carry for the active warm
                      ping's footer animation; document visibility is main.ts
    warm_choice.ts    one pending per-session warm preference shared by the
                      card and Warm sheet, keyed by pid + startedAt; posts setWarm
    board_nav.ts      nav bar, gauges, filter, start slots
    warm_menu.ts Warm on the bottom drawer: this window's switches, the
                 pinned New sessions default, the configuration column, and
                 the bar's count. Paint only; the decision arrives on
                 `CardView.warm`, the figures on `warmConfig`, and an edit
                 leaves as `setWarmSetting` with the key it was pushed
    holds.ts     the panel's one `FlipHolds`, settled by `main.ts` on every
                 state push before any surface repaints, open or shut, and
                 the `flags` hold keyed by `FlagKey` that Warm's New sessions
                 and Keep-awake's switches share. A `flagChoice` that did not
                 land drops the flip, if it still holds the value refused
    num_input.ts a whole-number field, typed and nothing else: rounds and
                 clamps on blur, Enter commits, Escape reverts. No wheel, no
                 stepper. A port of an in-house `NumberInput`, cut; its
                 header names what was left out
    settings.ts  native settings dialog: seven category tabs, account/auth handoff,
                 version-filtered packaged changelog and named extension-page links.
                 A focused field keeps its value, caret and focus across a
                 repaint. Remote is not in it: its setup is the sheet's
    remote_setup.ts Remote's Tokens and Allowed accounts, sections of the
                 sheet's right column under the setup check: one row per token
                 reading Set or Not set with Paste… posting `setRemoteField`
                 (the host's password box takes the value), Remove tokens, and
                 the allowed accounts posted as the whole list, with the edits
                 in flight settled against each push. The messenger's space
                 heads the accounts (`setRemoteSpace`, the host's plain box);
                 an account it cannot use is marked with why. No secret is
                 typed here
    board_settings.ts reusable setting controls and theme swatches; one model
                 builder for the default row, a session's pill and a draft's
    board_servers.ts  servers line, chips, the door and the stop marks the
                      sheet shares
    board_actions.ts  delegated #cards / #nav handlers
    board_arrange.ts  card drag-reorder
    dock.ts      chat owner transitions and session selection
    chat.ts      active chat orchestration, draft transitions and header rename
    chat_turns.ts keyed turn/tool/image/fold rendering and outbox echo
                 reconciliation. Engine HTML goes through `body()`, the
                 reader's prose through `proseBody`; both sanitize with
                 DOMPurify's allowlist first — the webview's one security
                 invariant, and not to be swapped for a hand-rolled strip again
    chat_scroll.ts prompt bar, trailing room, following, remembered positions
                 and divider drag; owns their coupled geometry state privately
    question.ts  the requests a session is blocked on, as a list of dialogs:
                 stepper, picks, the CTA — and where a permission dialog is drawn
    permission.ts  one such dialog for a tool call: what it wants, and allow /
                 always-allow / deny. Nothing here stages
    composer.ts  the message box: attachments, their chips, the workflow
                 mentioned on the next send, and the send itself
    formatbar.ts the shared formatting toolbar: controls over one
                 prose editor, one tab stop. What each applies and what stops
                 it is `Prose.formats`; workflow prompts offer code and lists
    mentions.ts  `attachMentions(target, { sources, write })` gives a box the
                 `@` menu over models, skills and sessions, effort step
                 included. Shared by the composer and the workflow editor; a
                 caller says what it offers and how it stores a pick. The box
                 is a `MentionTarget` adapter, `Prose.selection`
    mention_text.ts  that menu's pure half: what it draws for a query, Recent,
                 and every spelling a pick sends — the model flags copied off
                 `PanelState.models` rows and nothing else, the skill phrase,
                 the session reference
    prose.ts     the one markdown input every prose box shares:
                 `createProse(host, options)`, rich or plain, raw delivery;
                 in rich mode atomic chips, sent and copied as their
                 expansion and formed from complete text. The composer and
                 each step prompt mount it in rich mode, the dialog boxes in
                 plain mode; `squadronProse` is its test seam, and the hook on
                 a mounted host is what tests drive. `proseHtml` renders a
                 delivery string with that same parser and no view, for the
                 dock's in-flight rows and the reader's settled turns;
                 `deliveryOf` and `markdownDoc` serialize and parse a snapshot
                 the same way, for a send's capture, a ticket's append and a
                 step prompt's open. `format` and `formats` are the toolbar's
                 verbs. A quote, a list or a code block takes the lines a
                 selection touches — a hard break starts a line, as in
                 Slack's composer — for the keyboard's shortcuts too
    prose_blocks.ts  which hard-break lines a selection includes, and how a
                 quote, a code block, or a list is rebuilt around that cut.
                 Nine operations serve the rich command overrides, the block
                 input rules, and Shift+Enter's empty-quote exit. The module
                 imports TipTap only. `prose.ts` imports it and keeps the
                 schema, the chips, and the one rich parser
    bottom_hub.ts    the capsule over the board, built from bottom_drawer_modes.ts. Its one
                 bar sync compares counts, dots, tips and expanded state before
                 writing, then lets bottom_hub_overflow.ts measure the updated words.
                 Agents reports waiting sessions and exposes their keyed pills;
                 a pill uses board_actions.reveal to open its chat and request.
                 It applies nothing — the composer is the path a mention takes
    pill_stack.ts shared upward-pill interaction: hover grace, keyboard/touch access,
                 one open stack, board-clamped placement and disposal
    warning_ink.ts resolves black/white text for the rendered warning fill,
                 including its brighter hover state; cached by fill and ground
    bottom_hub_overflow.ts moves the bar's original buttons between its row and More's
                 stack, preserving their actions, status and focus on resize
    cafe.ts      the coffee cup over the board: drawing, drag, level. **Not
                 mounted since 2026-10-05** — out of the bundle, kept for
                 whatever shows the hold next
    pot.ts       the moka pot that pours into it, with computed shading
    resume.ts    resume picker and pending startup cards; correlated results
                 retain feedback until the exact session appears, or offer
                 retry/dismiss after refusal. Separate from draft chat state.
                 Pages: a reply is drawn only for the last ask (`requestId`,
                 snapshot), Show older appends and keeps the highlighted row, the
                 filter box asks the host after a 150 ms pause, Enter before the
                 list answers the box takes the answer's first row, an expired
                 snapshot restarts at page 1
    runpicker.ts the servers sheet: a rail of a repo's worktrees off the state
                 message, beside what the selected one can start off
                 the `ports` push, asked again when a server takes or leaves a
                 port. Morphed from the state, so clicks are delegated
    confirm_modal.ts reusable confirmation on the shared sheet frame: host copy and
                 actions, Cancel by default, one answer per opening
    sheet.ts     the shared sheet frame — scrim, head, body, foot — with explicit
                 board or full-panel positioning and opt-in interaction scope.
                 Board scope blocks board siblings while leaving chat accessible.
                 Panel scope would block the background and contain focus, and
                 nothing passes it. Login and Remote's guide use board
                 positioning; MCP and End confirmation use full-panel positioning.
                 Its backdrop owns clicks even when their target closes the
                 sheet; its capture listener owns Escape before surfaces below
    mention_pill.ts shared chat mention markup, consuming mention_text's
                 exhaustive presentation contract; only tickets are actionable
    mention_clipboard.ts ticket HTML links with validated reference metadata,
                 plain URL copy, and internal rich-paste recovery
    ticket_details.ts on-demand read surface, one current ticket; uncached host
                 Markdown, shared sanitizer and prose styles; closes release
                 content and cancel the correlated host read. Its board-scoped
                 sheet leaves the dock interactive and handles focused Escape
    markdown_dom.ts shared DOMPurify boundary; chat may preserve parsed local
                 file links, tracker content only offers validated web links
    tickets.ts   the tickets tab, its filter pills and menus; the list is
                 morphed too, keyed by ticket id
    onboarding.ts the first-launch dialog: setup (the accounts popover's rows,
                 gated when no CLI resolves), then three slides — the second
                 says which CLIs have the squadron skill. Once per install; the
                 gear's Show onboarding reopens it
    editor.ts    the board-mode workflow editor: a draft of one workflow, and
                 create, edit, save and delete of its JSON. Hands the canvas
                 facts and handlers, and reads none of its DOM
    wfcanvas.ts  the session-lane canvas: a column per session and a grid
                 row per step a tier holds in it, with the wires between steps.
                 Draws everything on a node and owns both gestures, the wire
                 drag and the grip's reorder, reporting each as a handler call
    wfgraph.ts   what the lane canvas draws: the words on each node, placed
                 by graph.layout
    bottom_drawer_modes.ts one record per mode: id, bar class, title/note, columns,
                 paint/repaint, bar values, focus word and beat participation.
                 Optional closed, empty, emptyWord and escape. Every mode is
                 available; `available: false` stays for a placeholder word. All imported callbacks are deferred until event
                 time; the id type is derived from these records
    sheet_parts.ts shared column heading; a DOM leaf outside the sheet cycle
    bottom_drawer.ts the bottom drawer's frame and lifecycle, dispatched through
                 bottom_drawer_modes.ts. One Escape listener for every mode; a
                 mode consumes the key through escape(). A dismissal returns focus
                 to its record's word, or More when that word is tucked away. The
                 live workflow chip passes `taken`, so focus stays on that chip.
                 Push and beat read the records; the beat
                 neither mounts nor measures
                 the bar. Find and foot start hidden when the filling changes
    workflows_mode.ts the Workflows filling: the list, detail, filter, delete
                 confirm and order write. The flight is workflows_drag.ts
    remote_sheet.ts Remote on the sheet: the bar word's dot and tip values; on the
                 left this window's switch above the messengers, with reason,
                 refusal, warnings and hint pinned under the list; on the right the
                 setup check's verdict with Check and Guide, its checklist,
                 `remote_setup.ts`'s sections and an empty Interactions slot.
                 The guide opens in `sheet.ts` on `#gscrim`, which owns its
                 dismissal events. Paint only; the flip is held until
                 a push agrees, and a `remoteChoice` that did not land drops
                 the flip it names
    awake_sheet.ts Keep-awake on the sheet: the bar word's dot; on the left
                 the Keep awake switch, carrying the hold's state, over the
                 Remote-hold and Warm-hold switches; on the right the keeper's figures, read-only. Paint only; the
                 hold is `StateMessage.awake`, the words `ui/awake_rows.ts`,
                 and a flip is held until a push agrees
    agents_sheet.ts Agents on the sheet: the bar word's dot off
                 `ui.state.orchestrators`; on the left `board_settings.ts`'s
                 `agentSettings()`, the master with its On/Off beside its name;
                 on the right every verb off `core/verbs.ts`, read-only, the
                 write ones dimmed under the refusal while Orchestration is
                 off. Paint only, no hold: the column follows the push
    messenger_marks.ts each messenger's mark by id, inlined from `media/`
                 for `mcp_marks.ts`'s CSP reason; an id with no mark draws none
    workflows_drag.ts the Workflows list's pointer flight: hold, ghost,
                 insertion line, auto-scroll, release and cancel. Order and
                 filter come from workflows_mode.ts; open and paint from
                 bottom_drawer.ts
    mascot.ts    the chick: one canvas over `#board` (frames painted into a
                 strip in theme tones, a swap one `drawImage`), WAAPI travel,
                 the bar, sheet and card perches, and the click. Nothing runs
                 at rest; off unmounts every element, listener and timer.
                 Watches `#bottomdrawer[hidden]` itself, so `bottom_drawer.ts` imports
                 nothing of it
    visibility.ts whether anyone can see the panel — the host's `visible`
                 and the document's — shared by the beat, the warm cue and
                 the mascot
    main.ts      the bundle's entry: the divider, and the message wiring
    protocol.d.ts  the wire format, ambient so both halves check against it
  test/          see src/test/AGENTS.md
```

## Who authors a card's status

**One source, on the panel's path.** `foldTwins` (`ui/views.ts`) still
reconciles three by ordering alone, because the `squadron-*` shims and
`host/waits.ts` fold through the same function and a published record is all
either has. The panel passes none: `refresh` hands it an empty map, so what
authors a card here is the frames reducer (`core/live.ts`) and nothing else.
Everything above that enriches (`effort`, a tool name) and never sets the coarse
state. An owned session's twin on disk can never arbitrate either: a print-mode
session writes no `status` field at all, so the twin's answer is `unknown` by
construction (`docs/reference/cli_state/claude/sessions.md`).

### Status is live, never disk

An owned card's status word, and every facet painted over it, comes off the
pipe this window holds — `statusOf` and what `endTurn` keeps in `core/live.ts`.
A file read lands a poll late, outlives the process that wrote it, and lets a
card disagree with the frames that just arrived. `failed` was first planned off
the transcript and moved to the turn-end frame for that reason
(`TASK_done_session_failed_status.md`).

**An exception is allowed only where no frame carries the fact, and only once
it is listed here** — added in the same commit as the read, with the reason:

| Fact | Read from | Why no frame carries it |
| --- | --- | --- |
| `completion` (`done` / `stalled`) | the CLI's task files `~/.claude/tasks/<id>/`, or a workflow's progress file; dated by the last prompt in the transcript (Claude) or our record (Grok, Codex) | the step list is the tool's files, not a frame, and a resumed session's list predates the pipe (`TASK_done_session_done_status.md`) |
| `unseen` | the ack file's mtime under `~/.squadron/acks/` | it records the reader opening the dock — panel state, not CLI state, and it must outlive a window reload |
| a background card's status | discovery, `~/.claude/sessions/<pid>.json` | no pipe: the CLI's daemon runs it |

The board's population is one decision, at `onBoard`: **owned here, or
background**. A session another window started is nothing at all
(`PRD_shipped_drop_cross_window.md`). A
session someone typed a CLI for never reaches the fold: each brand's discovery
drops it before enriching anything — Claude by `entrypoint`, Grok and Codex by
having no published record.

**Do not narrow `foldTwins` itself.** It is the shims' only path (`cli/board.ts`)
and the waits'. A filter there takes `squadron-list` blind on every session on
the machine, its own window's included, with no error anywhere.

`webview/` is real ES modules, bundled by esbuild into the single script that
`document.ts` inlines into the webview HTML, because the CSP admits scripts by
nonce only. `main.ts` is the entry; a file is in the bundle because something
imports it. The wire format and the host-injected globals (`ICONS`,
`acquireVsCodeApi`) stay ambient in `protocol.d.ts` — it has no import or
export, and must keep having none. An `import()` type is not one: `BrandId`
names `core/model`'s that way, and its target must resolve in the webview
typecheck too, which has no Node types.

Panel-wide mutable state that more than one module reads lives behind `ui` in
`ui/panel_bag.ts`. Chat-owned mutable state lives behind the private records and
operations in `ui/chat_state.ts`; `webview/state.ts` re-exports that access point
beside the DOM handles. ES module imports are read-only bindings, so neither
kind is exposed as a bare cross-module `let`.

**H56 extract hygiene** (panel + board modularisation — keep these after further
splits):

1. **Host friend surface.** `PanelActions` is how verb modules touch the
   controller after bodies left `panel.ts`. It is not the public extension API.
   Only host verb extracts write through it; prefer explicit args when few
   fields are needed; grow the type deliberately. Auth (login and MCP) is `AuthState` on the panel, owned by `panel_auth` — not on this
   type. A verb that is not that module cannot write `mcpHealth`.
2. **Board repaint hook.** `repaintBoard()` is a no-op until `board.ts` calls
   `setBoardRepaint(renderBoard)` at load end. Event-time and ticker calls are
   fine; do not depend on import-time paint.
3. **Board module cycles.** `board_card` / `board_stamps` / `board_nav` (and
   kin) may import each other. Safe only while those imports are used **inside
   functions**. A top-level `const x = neighbour.thing` across a cycle can TDZ.
   Push shared pure helpers into a leaf module if init-time sharing is required.
   What a card says (`reading`) is one such helper — `ui/reading.ts`.
4. **Drawer drag cycle.** `workflows_mode.ts` and `workflows_drag.ts` import each
   other, namespace imports both ways. Both directions stay inside functions:
   the drag reads `isFiltered`, `ordered` and `commitOrder` from the mode, and
   `isOpen` and `render` from the frame, when a pointer event asks. The mode
   reads `inFlight`, `justDragged` and `cancelFlight` from paint, the row click
   and `escape()`. The frame does not import the drag. A top-level read across
   the cycle can TDZ. Escape stays the one listener in `bottom_drawer.ts`. A
   second listener on the same key still runs after the first returns, so
   registration order cannot keep a cancelled flight from also closing the drawer.
5. **Drawer registry cycle.** `bottom_drawer_modes.ts`, `bottom_hub.ts`,
   `bottom_drawer.ts`, `workflows_mode.ts` and the other content modules import
   each other. The records contain literals and thunks:
   `paint: () => warmMenu.paintWarmSheet()`, never an import-time read of
   `warmMenu.paintWarmSheet`. Registry reads and calls stay inside functions.
   `sheet_parts.ts` is a leaf for shared DOM construction. A top-level read
   across the cycle can TDZ. Escape stays the one listener in `bottom_drawer.ts`;
   a mode consumes it through `escape()`. Centred sheets consume their own
   clicks and capture Escape in `sheet.ts`.

## Field or predicate: who decides a session's state

A question asked on more than one surface gets **one** answer, and where it is
computed follows from who already knows.

- **Decided at the seam, carried as a field.** A fact only one brand's CLI can
  state is read once, where its word is known, and travels as our own shape.
  `Session.background` is the worked example: `core/claude/discover.ts` knows
  `bg` and `daemon*`, `core/grok/discover.ts` states nothing, and nothing above
  `core/` has ever seen either spelling.
- **Control facts are not authority.** `core/live.ts:toSession` authors
  `Session.control` beside the schema-1 aliases. `core/session_target.ts` owns
  their compatibility reading, invalid-metadata result and observed addresses;
  `ui/views.ts:foldTwins` normalizes after its existing identity join. Each CLI
  keeps its selection, permission and guard policy. A missing owner claim is
  advisory, and incoming caller proof (`cli/self.ts`) remains separate. The
  panel uses its actual local live half for current sendability; invalid routing
  data cannot remove its owned card's close/dismiss controls.
- **Ship the answer, not the ingredient.** When the host has already decided,
  the wire carries the decision and `webview/` paints it — `CardView.canControl`,
  in the idiom `ThreadView` already uses for `canSend` and `canAttach`. A raw value the webview re-derives is one
  more place the decision can be wrong, and the two copies drift silently
  because both compile.
- **Share a utility only for a composition the host never makes.** `panelDrives`
  (`ui/panel_bag.ts`) is imported into the webview bundle and is not a
  counter-example: it composes an already-shipped decision (`owned`) across
  groups and thread. The webview may own a composition; it must not own a
  derivation.
- **A reading of our own vocabulary is shared, not shipped.** `isMidTurn`
  (`core/model.ts`) is asked on both sides of the wire, but of `status`, a word
  the seam already decided. It derives nothing from a brand's spelling, so
  there is nothing for the host to decide first; a copy per site is how the
  usage chip came to disagree with the six others.

The cost of getting it wrong is not a bug that fails loudly. `kind: string` was
compared at six sites in three layers, in both polarities, and every one of them
compiled forever. `docs/tasks/TASK_done_state_derivation_seam.md` is the whole
reasoning, including why the shared predicate that looks like the obvious fix
was dropped.
