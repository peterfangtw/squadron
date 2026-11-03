import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as platform from './platform';
import * as commands from './platform/commands';
import * as brands from './brands';
import * as identity from './identity';
import * as claudeHome from './claude/home';
import { codexRoot } from './codex/home';
import { grokRoot } from './grok/home';

export const CLAUDE_DIR = claudeHome.claudeRoot(os.homedir(), process.env);
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
/**
 * Where a user-owned statusline script writes Claude's statusline dumps
 * (`<sessionId>.json`). Nothing reads them: only a session somebody typed
 * `claude` for draws a status bar. `prune.ts` still ages the directory out.
 */
export const DUMP_DIR = path.join(CLAUDE_DIR, 'squadron');
export const CLAUDE_SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
/** Everything this extension writes down. Store dirs below hang off this. */
export const STATE_DIR = path.join(os.homedir(), '.squadron');
export const BRIEFING_DIR = path.join(STATE_DIR, 'briefing');
export const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
/**
 * The CLI's own global config, beside `CLAUDE_DIR` until that is moved.
 * `projects[<root>].mcpServers` is where an MCP server is
 * declared — project-scoped, so a server exists only for the directories that
 * name it.
 */
export const CLAUDE_CONFIG_FILE = claudeHome.claudeConfigFile(os.homedir(), process.env);
/**
 * One key per server the CLI has decided is unauthenticated. **Not pruned on
 * `claude mcp remove`** — a key outlives its server, so this is only ever read
 * intersected with the config above.
 */
export const MCP_NEEDS_AUTH_FILE = path.join(CLAUDE_DIR, 'mcp-needs-auth-cache.json');
export const GROK_DIR = grokRoot(os.homedir(), process.env);
/** Under an explicit home, the default directory: a caller naming one is a test. */
export function grokHome(home?: string): string {
  return home ? path.join(home, '.grok') : GROK_DIR;
}
export const CODEX_DIR = codexRoot(os.homedir(), process.env);
/** `[mcp_servers.<name>]` url / enabled. */
export const GROK_CONFIG_FILE = path.join(GROK_DIR, 'config.toml');
/** Keys `name:url`. Do not log. Shape: `cli_state/grok/protocol.md`. */
export const GROK_MCP_CREDENTIALS_FILE = path.join(GROK_DIR, 'mcp_credentials.json');
/**
 * The CLI roots away from their default. A default sits in a hidden directory,
 * which is what keeps its credentials off an attachment; a moved one need not, so
 * these are denied by name (`core/remote/attach.ts`).
 */
export const MOVED_CLI_ROOTS: readonly string[] = (
  [
    [CLAUDE_DIR, '.claude'],
    [CODEX_DIR, '.codex'],
    [GROK_DIR, '.grok']
  ] as const
)
  .filter(([root, name]) => root !== path.join(os.homedir(), name))
  .map(([root]) => root);
/** What no attachment may come from, for the shim and the holder alike. */
export const NEVER_SENT_DIRS: readonly string[] = [STATE_DIR, ...MOVED_CLI_ROOTS];
export const PASTES_DIR = path.join(STATE_DIR, 'pastes');
export const STARTUPS_DIR = path.join(STATE_DIR, 'startups');
export const LINEAGE_DIR = path.join(STATE_DIR, 'lineage');
/**
 * One file per accepted cross-session send, UUID-named — what the guardrails in
 * `core/coordination/send.ts` count. Named for the record rather than the verb, so a `stop`
 * variant lands here later without a rename. Lineage is the other half of the
 * same record type and keeps its own directory: `core/coordination/actions.ts`.
 */
export const ACTIONS_DIR = path.join(STATE_DIR, 'actions');
export const LIVE_DIR = path.join(STATE_DIR, 'live');
export const ARRANGE_DIR = path.join(STATE_DIR, 'arrange');
/**
 * One file per folder this window opened, holding the theme it chose.
 * Not swept: `core/repo_theme.ts`.
 */
export const THEMES_DIR = path.join(STATE_DIR, 'themes');
/** One file per repo: its port block, and the port each branch last picked. */
export const PORTS_DIR = path.join(STATE_DIR, 'ports');
/** One file per dev server currently running, swept like a claim. */
export const SERVERS_DIR = path.join(STATE_DIR, 'servers');
/** One empty file per session the reader has opened, its mtime the whole mark. */
export const ACKS_DIR = path.join(STATE_DIR, 'acks');
/** One file per window currently holding the machine awake, swept like a claim.
 *  Per window rather than one shared file: every window holds for itself, so
 *  two writers never share a file and there is no race to lose. */
export const AWAKE_DIR = path.join(STATE_DIR, 'awake');
/** Authored workflow definitions — the one directory under here the user writes
 *  by hand, and so the one nothing of ours ever sweeps. */
export const WORKFLOWS_DIR = path.join(STATE_DIR, 'workflows');
/** Permanent one-time offer; deletion of a definition must not reset it. */
export const WORKFLOW_EXAMPLES_MARKER_NAME = 'workflows.examples.seeded';
export const WORKFLOW_EXAMPLES_MARKER = path.join(STATE_DIR, WORKFLOW_EXAMPLES_MARKER_NAME);
/** One file per run of one of them. Ours, and swept like everything else here. */
export const RUNS_DIR = path.join(STATE_DIR, 'runs');
/**
 * Where the reader put the workflows: the stated order and the pins.
 *
 * **Beside `workflows/`, never inside it.** That directory is the user's and is
 * read by `readJsonDir`, which would try to parse this as a definition and skip
 * it as invalid — a file that is fine today and a puzzle the first time anyone
 * wonders why it never appears.
 */
export const WORKFLOW_ORDER_NAME = 'workflows.order.json';
export const WORKFLOW_ORDER_FILE = path.join(STATE_DIR, WORKFLOW_ORDER_NAME);
/**
 * One brand's last plan-usage reading, so the nav bar has a figure before
 * anything is reporting one — including on the first paint after a launch.
 *
 * A flat file per brand rather than a directory: nothing enumerates brands off
 * disk, so each reader opens the one it wants by name. Under `STATE_DIR` for
 * both, which is what makes them one store rather than two conventions —
 * Claude's used to sit among the CLI's own dumps in `DUMP_DIR` and be sorted in
 * by mtime.
 *
 * The retired names are swept once on activate: `prune.ts` never touches
 * `STATE_DIR`'s top, so `grok-usage.cache.json` would otherwise be immortal.
 */
export function usageFile(brand: string, home?: string): string {
  return path.join(home ? path.join(home, '.squadron') : STATE_DIR, `usage.${brand}.json`);
}
export function usageStateFile(brand: string, home?: string): string {
  return path.join(path.dirname(usageFile(brand, home)), `usage-refresh.${brand}.json`);
}

/**
 * The attempt guard for one Grok refresh token.
 *
 * The token's fingerprint is the filename rather than a field inside it; why
 * that is the whole guard, and what it replaced, is on `refreshGrokBearer` in
 * `grok/auth.ts`.
 *
 * `.lock` and not `.json`: `host/watch.ts` watches every `.json` under this
 * root recursively, so a `.json` name would nudge every window on the machine
 * on every write (`files.ts:52`).
 */
const GROK_REFRESH_LOCK = 'grok-refresh.';
export function grokRefreshLockDir(home?: string): string {
  return home ? path.join(home, '.squadron') : STATE_DIR;
}
export function grokRefreshLock(fingerprint: string, home?: string): string {
  return path.join(grokRefreshLockDir(home), `${GROK_REFRESH_LOCK}${fingerprint}.lock`);
}
/** The one `mcp_credentials.json` writer lock. Its owner unlinks it; nothing sweeps it. */
export function grokMcpCredentialLock(home?: string): string {
  return path.join(grokRefreshLockDir(home), 'grok-mcp-credentials.lock');
}
/** Every name `grokRefreshLock` could have written, for the sweep that has only
 *  a directory listing to go on. Here rather than there so a renamed marker
 *  cannot stop matching the sweep that is the only thing deleting it. */
export function isGrokRefreshLock(name: string): boolean {
  return name.startsWith(GROK_REFRESH_LOCK) && name.endsWith('.lock');
}
export const RETIRED_USAGE_FILES = [
  path.join(STATE_DIR, 'grok-usage.cache.json'),
  path.join(DUMP_DIR, 'usage.cache.json')
] as const;
/**
 * What a brand's model ids answer in, as this machine has seen them stated —
 * the denominator a percentage needs, kept so it outlives the window that
 * learnt it.
 *
 * `usage.<brand>.json`'s shape and its reasons, one store over: flat file, one
 * brand each, opened by name. Two things make it a separate file rather than a
 * key in that one. A window size belongs to a model and a plan usage reading
 * belongs to an account, so the two have different lifetimes and neither
 * expires the other; and `usage` is written on a live reading while this is
 * written the rare time an id is first met.
 *
 * Claude's alone today: Grok's `signals.json` states `contextWindowTokens`
 * beside its percentage, so nothing there has a denominator to remember.
 */
export function modelsFile(brand: string, home?: string): string {
  return path.join(home ? path.join(home, '.squadron') : STATE_DIR, `models.${brand}.json`);
}
/**
 * Whether this brand's CLI was last found signed in, and the stamp of its own
 * auth state that answer was taken against — `core/signin.ts`. Beside `usage`
 * for the reason that store is flat: each reader opens its one brand by name.
 */
export function signInFile(brand: string, home?: string): string {
  return path.join(home ? path.join(home, '.squadron') : STATE_DIR, `signin.${brand}.json`);
}
/**
 * Our own conversation records, one `<sessionId>.jsonl` each — roadmap row 54.
 *
 * `.jsonl` and not `.json`: `host/watch.ts` watches every `.json` under this
 * root, subdirectories included, and these are appended to on every frame.
 *
 * The first store here meant to outlive the session that wrote it, so `prune.ts`
 * — an explicit per-store list — does not name it and nothing sweeps it. That is
 * deliberate rather than forgotten: `taskhub.md` §H81.
 */
export const TRANSCRIPTS_DIR = path.join(STATE_DIR, 'transcripts');
/** Rebuildable resume metadata; only crashed `.tmp` publications are swept. */
export const CATALOG_DIR = path.join(STATE_DIR, 'catalog');
export const CATALOG_FILE = path.join(CATALOG_DIR, 'transcripts.v1.jsonl');
/**
 * Image bytes a record owns, rather than points at. What the reader handed the
 * composer is copied here at send time and keyed by an id of ours; what a turn
 * merely read stays a path and is never copied. Under `transcripts/` so the two
 * halves of one record sweep, or fail to, together.
 */
export const ATTACHMENTS_DIR = path.join(TRANSCRIPTS_DIR, 'attachments');
/**
 * What each turn changed, one file per live **working tree** — not per repo, and
 * not per session.
 *
 * The one store here whose key is a place rather than a session, because the
 * question it answers is about a place: *did another session write into this
 * tree while my turn was open*. A session's own copy of that is in its record;
 * this is the index that lets a neighbour be found without opening every record
 * on the machine. `core/checkpoint.ts` owns the shape.
 *
 * `.jsonl` for `TRANSCRIPTS_DIR`'s reason — `host/watch.ts` watches every
 * `.json` under this root, and these are appended to at every turn boundary.
 *
 * **Not swept**, and deliberately, the same call `TRANSCRIPTS_DIR` makes: a
 * sweep would take a turn's neighbour evidence away while the turn is still
 * drawable, and the pill would then get *less* honest with age — it would stop
 * subtracting a neighbour's file and start naming it. One line per turn per
 * tree, so the whole of this machine's history is a few megabytes.
 */
export const CHECKPOINTS_DIR = path.join(STATE_DIR, 'checkpoints');
/**
 * What a person or an agent said a conversation should be called, one
 * `<brand>.<sessionId>.json` each — `core/names.ts` owns the shape.
 *
 * **Not swept**, and deliberately, the same call `TRANSCRIPTS_DIR` and
 * `CHECKPOINTS_DIR` above make. The name is what makes an old picker row
 * findable, so an age sweep would take away the one thing that made that
 * conversation identifiable. One small file per *named* session — most sessions
 * are never named — so the whole store is kilobytes.
 */
export const NAMES_DIR = path.join(STATE_DIR, 'names');
export const WARM_DIR = path.join(STATE_DIR, 'warm');
/** Cross-window request files. */
export const REQUESTS_DIR = path.join(STATE_DIR, 'requests');
/**
 * One file per registered wait — "tell me when these are done".
 *
 * **Addressed to no window**, unlike `REQUESTS_DIR` above, and that is the
 * whole difference between the two stores: nothing here asks a window to act,
 * so there is no `windowId` in a record and no reply file beside it. Whichever
 * window owns the requester resolves it, which is decided on every pass rather
 * than written down. `PRD_shipped_wait.md` §5.3.
 */
export const WAITS_DIR = path.join(STATE_DIR, 'waits');
/**
 * A report accepted while its wait was open, held until the convergence can
 * carry it.
 *
 * **Its own store rather than a field on the wait record**, and the reason is
 * contention: the send path reads `waits/` on every peer send, and growing the
 * record would make two windows race a read-modify-write of one file. One file
 * per report races nothing.
 *
 * Addressed to no window, like `WAITS_DIR` above and for the same reason —
 * whichever window owns the requester delivers or releases it.
 */
export const REPORTS_DIR = path.join(STATE_DIR, 'reports');
/**
 * Remote's own state (PRD D37): the conversation store, joined thread files,
 * and the file naming the one window that holds Remote. Written only by that
 * window.
 */
export const REMOTE_DIR = path.join(STATE_DIR, 'remote');
/**
 * One `<conversationId>.json` per conversation at the messenger —
 * `core/bridge/store.ts` owns the shape. `.json` on purpose: a write nudges
 * every window through `host/watch.ts`, and these are written once a notice.
 */
export const CONVERSATIONS_DIR = path.join(REMOTE_DIR, 'conversations');
/**
 * One `<conversationId>.md` per joined thread — `core/bridge/thread_file.ts`.
 * Markdown, so a write does not nudge `host/watch.ts`.
 */
export const THREADS_DIR = path.join(REMOTE_DIR, 'threads');
/**
 * Who holds Remote, as pid and start time — `core/remote/holder.ts`. A file,
 * so **not in `STORE_DIRS`**: `ensureHome` makes every entry there a directory.
 */
export const HOLDER_FILE = path.join(REMOTE_DIR, 'holder.json');
/**
 * The newest message Remote began routing, as its `at` — `core/bridge/store.ts`.
 * Not `.json`: it is written once an inbound message, and a `.json` write
 * nudges every window through `host/watch.ts`. A file, so not in `STORE_DIRS`.
 */
export const HEARD_FILE = path.join(REMOTE_DIR, 'heard');
/**
 * The test messenger's two files, so a process outside the host can drive it
 * (`core/remote/fake_files.ts`). Made only when Remote turns on with the fake
 * selected, so **not in `STORE_DIRS`** either.
 */
export const FAKE_DIR = path.join(REMOTE_DIR, 'fake');
/** Agent shims, copied here on activate. */
export const BIN_DIR = path.join(STATE_DIR, 'bin');
/**
 * The agent-facing commands, by the name they are copied under. Here rather than
 * beside the copy loop in `host/extension.ts` so a `vscode`-free test can read
 * it: the skill we install documents these verbs, and a row missing from that
 * table is a binary an agent never learns it has. That went unnoticed for a
 * fortnight once, which is what the test is for.
 */
export const SHIM_NAMES = [
  'squadron-spawn',
  'squadron-end',
  'squadron-rename',
  'squadron-warm',
  'squadron-list',
  'squadron-models',
  'squadron-send',
  'squadron-answer',
  'squadron-wait',
  'squadron-step',
  'squadron-attach',
  'squadron-fetch-file'
] as const;
export const WORKFLOW_VALIDATION_SHIM = 'workflow-validation';
export const STEP_BIN = path.join(BIN_DIR, 'squadron-step');
/**
 * The shell a session of `brand` runs a command it is handed in. An absent
 * brand is Claude, as for every pre-brand record; a caller with no identity
 * at all — a person at a terminal — is handed POSIX text.
 */
export function toolShell(brand: brands.BrandId | undefined): commands.Shell {
  return platform.commands.shell(identity.TOOL_SHELL[brands.sessionBrand(brand)]);
}

/**
 * One of our verbs as an agent is handed it, written for the shell that will
 * run it. The installed path is always quoted, so it reads the same on every
 * machine; each argument is quoted only where it needs to be — a home
 * directory, a lane name or a workflow id may carry whitespace or a quote.
 * Arguments that shell cannot deliver go through `--argv-file` instead.
 */
export function verbCommand(
  shell: commands.Shell,
  verb: (typeof SHIM_NAMES)[number],
  ...args: commands.Arg[]
): string {
  const program = platform.launchers.verbPath(BIN_DIR, verb, shell);
  const policy = { program: 'quoted', args: 'word' } as const;
  if (platform.commands.carries(program, args, shell)) {
    return platform.commands.render(program, args, policy, shell);
  }
  if (!platform.commands.carries(program, [], shell)) {
    return `Unsupported command route: ${verb}'s program path cannot be delivered intact through ${commands.SHELL_NAMES[shell]}; use a supported shell or a launcher on a local drive.`;
  }
  const file = platform.commands.placeholder('<file>', shell);
  const argv = args.map((arg) =>
    typeof arg === 'object' ? `${arg.option}=${arg.value}` : String(arg)
  );
  return `${platform.commands.render(program, ['--argv-file'], policy, shell)} ${file}, <file> being a UTF-8 file holding the JSON array ${JSON.stringify(argv)}`;
}

export function stepCommand(shell: commands.Shell, ...args: commands.Arg[]): string {
  return verbCommand(shell, 'squadron-step', ...args);
}

/** The CLI's own, not ours: one directory per session, holding its step list. */
export const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

/**
 * Every store under `STATE_DIR`. `ensureHome` mkdirs these on activate so a
 * stranger — and the panel watcher — has a real tree before the first write.
 * Not here: `DUMP_DIR` (Claude sidecars), `placements/` (row 56, no reader),
 * `workflows.order.json` (a file the reader writes).
 */
export const STORE_DIRS = [
  PASTES_DIR,
  LINEAGE_DIR,
  ACTIONS_DIR,
  LIVE_DIR,
  ARRANGE_DIR,
  THEMES_DIR,
  PORTS_DIR,
  SERVERS_DIR,
  ACKS_DIR,
  AWAKE_DIR,
  WORKFLOWS_DIR,
  RUNS_DIR,
  TRANSCRIPTS_DIR,
  ATTACHMENTS_DIR,
  CHECKPOINTS_DIR,
  NAMES_DIR,
  WARM_DIR,
  REQUESTS_DIR,
  WAITS_DIR,
  REPORTS_DIR,
  REMOTE_DIR,
  CONVERSATIONS_DIR,
  THREADS_DIR,
  path.join(STATE_DIR, 'windows'),
  BIN_DIR
] as const;

export async function ensureHome(): Promise<void> {
  await Promise.all(STORE_DIRS.map((dir) => fs.mkdir(dir, { recursive: true }).catch(() => {})));
  // `prune.ts` sweeps neither `STATE_DIR`'s top nor a name it does not know, so
  // a retired store would sit there for good. Unlinked here rather than left:
  // one `unlink` per launch against a file that is gone after the first.
  await Promise.all(
    RETIRED_USAGE_FILES.map((file) => fs.rm(file, { force: true }).catch(() => {}))
  );
}
