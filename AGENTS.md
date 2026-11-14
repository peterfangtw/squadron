# Squadron

VS Code + fork extension. Shows every session this IDE window started as cards,
grouped by directory they run in. Session another window started is not drawn,
not counted, not reachable from here — reader switches windows, as they would
for its terminal (`PRD_shipped_drop_cross_window.md`).

Until 2026-09-23 the product was AgentsView (tab: AgentSquad); older docs still
say so, and the checkout keeps the folder name `agentsview`. Why:
`TASK_done_squadron_rename.md`.

`discover`/`scan`/`windows`/`requests` read machine state. `views` turns it into
what card shows — all `vscode`-free, tested. `panel`/`html`/`webview` = UI. Full
map: `src/AGENTS.md`.

**Each directory carries its own instruction file, and you read it before you
work there.** `src/AGENTS.md` is the module map, `src/test/AGENTS.md` the test
machinery, `docs/AGENTS.md` what belongs in which doc. Only this root file
arrives on its own; each `CLAUDE.md` is a one-line pointer at its `AGENTS.md`
(why: `reference/agent_doc_files.md`).

**Drive what has protocol, report what doesn't.** Every card is session this
panel started: stream-json on pipe, so messages, answers, interrupts are frames
and panel offers all. Exception is background session, which CLI runs under its
daemon — drawn, says so, drives nothing. Session someone typed `claude` for is
not known at all: no card, no count, dropped in discovery before anything about
it is read (`PRD_shipped_drop_terminal_sessions.md`).

## Glossary

What we call these to each other. **No user-facing string names one of them** —
a notice says "its terminal", never which box of ours the reader is looking at.
Full map, including the two files whose name differs from their surface's:
`src/AGENTS.md`.

- **Panel** — whole Squadron tab. Board + dock.
- **Board** — left/centre column: nav bar, card grid, everything floating over
  it.
- **Session card** — one running session on board. Bare "card" = this.
- **Dock** — right column for selected session: turn stream, tickets, anything
  scoped to that one session.
- **Lightbox** — surface over the board with its own backdrop for viewing one
  turn image. It is not a sheet: no host push fills it and there is nothing to
  pick.
- **Sheet** — surface that opens over board with its own backdrop. Two fill
  from a host push, because their answer is real work no 3s morph should wait
  on: **resume picker** (a directory's past conversations), **servers sheet**
  (a repo's worktrees, what each can start, on which port). The **MCP sheet** is
  the third by mechanism and fills off the state message instead — every server
  the board's repos configure, in a **section** per repo.
- **Bottom drawer** — the bottom drawer, which a hub word raises. Every
  workflow on the machine; Routines, Warm, Remote, Agents and Keep-awake are modes of
  the same frame. Not a sheet: no host push fills it.
- **Section** — one repo's block on the MCP sheet: a head that stays legible
  shut (name, state dot, count) over the rows it holds, this window's repo open
  first and everything belonging to no repo in a trailing one. Never "group" —
  that is the board's word for one directory's cards.
- **Servers line** — chip row above a group's cards, one per running server of
  that repo; a repo with none draws no line. One is a **server chip**. The
  heading's **door** opens the servers sheet, a failed chip opens it on its
  worktree. Behind the `squadron.devServers.enabled` experiment, off by default;
  what the switch does and does not stop: `runs.ts` in `src/AGENTS.md`.
- **Bottom hub** — capsule over the board's bottom edge: one word per
  board-wide surface — Workflows (opens the bottom drawer), Routines (its
  repository reminders and saved tasks), Warm (opens
  that sheet's Warm mode), Remote (its Remote mode; a dot for the link's
  state), Agents (its Agents mode: the agent switches and every `squadron-*`
  verb; a dot for Orchestration), Keep-awake (its Keep-awake mode; a dot for
  the hold). A workflow is applied from the
  composer only.
- **Café** — the coffee cup over the board whose level is the keep-awake lease
  left. Dismounted 2026-10-05; code and the hold it reported both remain.
- **Dialog** / **modal** — permission or question prompt awaiting an answer,
  drawn in the ask layer **over the board** — not in the dock. Never call one
  "card".

Above is surfaces. Below is what kind of session a card is for.

- **Owned session** — we started it and hold its stream-json pipe. Every panel
  `+` card and every `squadron-spawn` card is one. Full support: read, send,
  answer, interrupt, model, rename, end. Every card on board is one, bar
  background.
- **Fleet** — every `squadron-spawn` session still alive, across windows. What
  `FLEET_MAX` counts. Admission reads startup receipts and `lineage/`, not any
  window's memory. A panel `+` card is owned but writes no lineage, so it is
  not in it.

Workflow execution names both an agent role and the code that resolves waits.

- **Coordinator** — the AI session following a workflow's main lane, called
  the **anchor** in code. Its `squadron-step next` opens the workflow's other
  lanes when their prerequisites permit it.
- **Reconciler** — `src/core/reconcile.ts`. Shared scheduler for background
  checks, run after changes settle or at a deadline. Nine tenants: repository routine reminders/recovery, the wait
  resolver, keep-awake, the cache warmer, Remote's pass, Remote's retries,
  and the three usage passes (observations, live reads, the hourly fallback).
- **Wait resolver** — `src/host/waits.ts`. Checks a registered wait's sessions
  (or a workflow's dependencies) and sends the one wake-up message on
  resolution or expiry. Agents still pull and complete their own steps.
- **Cache warmer** — `src/core/warmer.ts`, wired in `src/host/warm.ts`. Sends
  an idle owned session one short **ping** (a warm turn) its cache lifetime
  minus a buffer after the last real turn, for a set window, so coming back does
  not re-send the whole context.
  The lifetime per brand, the buffer (5 min) and the window (2 h) are
  `squadron.warmCache.*` settings, edited in Warm's configuration column. A
  ping is maintenance: no sound, no unread, not counted as work, drawn as one
  CLI row. A session with Warm on holds the machine awake (`squadron.cafe.warm`).
  Its switch per session is Warm on the bottom hub, or `squadron-warm` from
  another session.

## Conventions

- Weigh expected CPU and RAM usage when comparing approaches in implementation plans.

- **Right architecture over the cheap one.** Put boundaries where they belong
  and fix the cause, not the symptom, even when that costs more code or work.
  Fewer lines is never the goal. Write for a later session with none of this
  conversation. If the better shape is unclear, **ask a human**.
- Processes: **no daemons.** Nothing we start is meant to run detached from
  the window that started it — no launchd agent, no resident helper. A child
  left running after its window died is a leak to reap (`core/control.ts`),
  not a daemon. A **local server** — socket or HTTP endpoint, in the extension
  host or a child — is allowed (t3code runs one), but only for performance or
  a capability the file-and-pipe path cannot give; cleaner code alone does not
  earn one. Worked no: `reference/session_messaging.md`.
- TypeScript strict, past it: `noUncheckedIndexedAccess` and friends on — every
  parse here is of a file some other program wrote.
- Deps: no native modules, ever. Host API or stdlib over new package. Pure-JS
  build-time-bundled packages case-by-case — pinned exact version, zero-to-few
  transitive deps, only where hand-rolling is worse on the axis that matters
  (sanitizing untrusted HTML, DOM reconciliation). Vendor one file when package
  is overkill. Reasoning + allow/deny list:
  `docs/tasks/TASK_done_structural_rebuild.md`.
- Comments earn their place by provenance: a measurement or another program's
  behaviour stays at the length its evidence needs, an alternative that fails
  gets one line, prose restating the code goes. One copy of a rationale, on the
  line it governs. State the fact, not the story: what the code used to do and
  which bug showed it go in the commit message. Whole standard:
  `code-comment-principles` skill.
- IDE-agnostic by default. Antigravity = host we run, not host we target. Stock
  VS Code API only (`engines.vscode`, now `^1.95.0`), no proposed APIs, paint off
  `--vscode-*` theme vars. Fork identity unavoidable → read it (`env.appName`,
  `appRoot/product.json`), never write name down. Hardcoded install paths live
  only in build tooling behind an env var — `scripts/deploy.mjs` (`SQUADRON_IDE_CLI`)
  and `src/test/smoke/` (`SQUADRON_IDE`) — never `src/`. Why:
  `TASK_done_drop_antigravity_name.md`.
- Everything reads undocumented Claude CLI state. Verify by observation, never
  assumption. Degrade gracefully — changed or missing file shrinks a card, never
  breaks panel. Record: `docs/reference/cli_state/claude/README.md`. Read before
  touching discovery.
- Brand seam: a CLI's wire or disk format lives in its own package
  (`core/claude/`, `core/codex/`, `core/grok/`), or in `scan`, `paths`, `bin`,
  `adapter` or `identity`. Everything else uses our own shapes. No brand checks
  for behaviour in `ui/` or `webview/`. Every brand gets the same verbs and the
  same card; if one can't, ask a human. Inventory: `reference/brand_seam.md`.
- Example paths and sample data are generic: `/Users/me/src/squadron`, a
  monorepo called `acme-web`, tickets `ENG-<n>`. Never this machine's home,
  its other repos, an employer or a private ticket — Squadron runs on other
  people's machines and `src/` ships publicly. An observation keeps its date
  and figures and drops whose machine it was. `tooling/example_paths.test.ts`
  refuses real homes everywhere, and private names listed in
  `scripts/local/private_names.txt`, a file the public snapshot drops.
- Commits: conventional prefix, subject <~50 chars, body explains _why_ when not
  obvious.
- HTML design previews: never Claude Artifacts. Write HTML to file, open in
  browser.

### Mention pills

Composer/chat mention pills use `src/webview/mention_text.ts` for recognition,
labels and presentation, `prose.ts` for editor atoms, and `mention_pill.ts` for
chat markup. New kinds join this contract; do not create a separate pill path.
`squadron/mention-pills` lint guards direct class construction outside those
renderers. Exceptions require `eslint-disable-next-line` with a `--` reason.
Filter chips, status badges and file/image attachments are separate concepts.
Ticket delivery text and clipboard text differ deliberately: rich HTML restores
its validated reference inside Squadron; plain text is an ordinary URL.

### Style

Pruned from opencode's `AGENTS.md`; anything a linter can decide belongs in
`eslint.config.js` instead.

| Rule | Why |
| --- | --- |
| Extract a function, type or module when it names a real concept, even if it has one caller; skip wrappers that only forward a call | A named concept makes the caller read better; a `handleX` pass-through only adds a hop |
| Happy path on top, supporting detail in helpers below it | The reader sees what a function does before how |
| Early return for guards; `if`/`else` or a ternary when the branches are symmetric | `else` is not a smell here. Flattening two equal outcomes into a fallthrough hides that they are equal |
| Annotate exported signatures, infer locals | An inferred export surfaces its error in the caller, far from the edit that broke it |
| `import * as x` is the namespace idiom here, ~460 of them — never convert one to named imports | A module namespace at each call site is how a 360-file tree stays legible |
| Alias an import only where a real collision forces it (`css as boardCss` — every `css/` module exports `css`) | An unforced alias makes the symbol ungreppable: one export, two spellings |

## Build

`npm run check` = the gate: format, lint, compile, test, in that order. Commit
only format-checks and lints staged filenames; feature pushes run no checks.
Work starts on `feat/*`, with a PR targeting `staging`. Run
`npm run integrate -- <PR-number>` to check its combined result locally and
merge the PR. New local staging results and direct staging pushes are guarded;
release's fully verified version update is the exception.

`check` and `npm test` select tests the change since the merge-base with
`origin/staging` can reach (`scripts/affected.mjs`). Integration passes
`--base <staging-commit>` to compare directly against its fetched staging base.
`npm run check -- --all` runs every test, and release always does. No hosted
test CI is required. Enforcement limits and recovery:
[`docs/workflows/integration.md`](docs/workflows/integration.md).
Enable hooks once per clone:

```sh
git config core.hooksPath .githooks
```

Typecheck and emit are separate tools. `tsc` checks both halves; `esbuild` (via
`scripts/esbuild.mjs`) emits the bundles — webview script + `dist/extension.js`, which is
what ships. `tsc` alone → panel with no script, VSIX with no extension. Rest are
`package.json` scripts, names say it: `watch`, `lint`, `format`, `test`,
`package`.

Built against Antigravity IDE 2.3.1, bundled VS Code API 1.107.0.
`engines.vscode` must stay below host.

## Test

New behaviour in `vscode`-free module comes with test. IDE-only behaviour gets
hand-checked — say so in commit.

Before starting any model-backed live session or CLI probe, read
`src/test/AGENTS.md` for the model and effort policy. This includes temporary
probe scripts and dev-host hand-checks outside `src/test/`.

Every run of `check`, `test` and smoke appends a line to
`$(git rev-parse --git-common-dir)/squadron-timings.jsonl` — read it before
calling a run slow. A red run prints its evidence folder under `squadron-runs/`;
read it **before** re-running. Never pipe a test or commit command through
`head` or `tail` to see its result.

**From `compile` on, a run waits its turn.** `check`, `test` and smoke share one
slot per user on the machine (`scripts/timed.mjs`), so a second run prints `waiting for
the gate: N ahead — …` and starts when the first ends. That is not a hang; it
gives up with exit 75 after 45 minutes. A run that passed but could not release
the slot exits 74 and names the holder file to remove by hand once none of its
processes are left. Run gated commands in the background.

**One command launches the IDE, and it is not `check`.** `npm run test:smoke`
drives a real host with Playwright. Never point it at a glob — that spawns an IDE
per file. Scenarios, both commands, and what a cold profile needs first:
`src/test/AGENTS.md`.

Everything else about the IDE is hand-check. `squadron-dev-host` skill boots an
Extension Development Host from CLI, over F5.

**Use `npm run dev:host` for hand-checks, never a raw IDE launch.** It compiles,
closes earlier dev hosts for this repo (including its worktrees), and starts
stock VS Code with an isolated profile and updates disabled. Keep the command
running while checking; stopping it closes its host. `npm run dev:host:close`
closes leftovers without opening another. Smoke's runner uses the same cleanup
before starting. Closing a previous host also ends any hand-check in it.

**Every host you boot to probe or test is stock VS Code, never the fork.** Smoke
and `dev:host` default to stock; `SQUADRON_IDE` selects another stock VS Code
executable. The fork is a host we deploy to, not one we test on.

## Ship

Three commands: `npm run release` checks and smokes a clean candidate and tags
the branch you are on; `npm run deploy` installs that tag without retesting;
`npm run publish -- <tag>` sends it to Open VSX and the Marketplace. Before
release, `release -- --dry` names the extension version — commit its nonempty
`## <version>` entry in `CHANGELOG.md` first, because notes added after the tag
cannot ship in it.

**The channel is the branch.** Feature PRs land on `staging` through local
integration, never directly on `main`. A tag
on `staging` installs (as "Squadron (STG)") and will not publish; promotion is a
fast-forward merge of `staging` into `main`, never a re-tag, and hooks refuse
any other move of `main`.

Reload the IDE window after a deploy, or the extension host keeps running old
code.

Versioning, rollback, every gate and `npm run snapshot` (export to
`squadron`): `docs/workflows/release.md`.

## Workflows

Both planners are machine-global skills — invoke `feature-planner` and
`implementation-planner` by name. Default to `docs/PRD/` and `docs/tasks/`, which
is what this repo uses.

Any change to what panel shows or posts goes through
`docs/workflows/ui_test_scenarios.md` — protocol first, scenario red, implement
to green.
