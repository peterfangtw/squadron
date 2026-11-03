import { readClaudeUsage } from './usage_reader';
import { claudeRoot } from './home';
import * as skills from './skills';
/**
 * Claude, as one brand among the ones the panel could drive.
 *
 * Claude's package, matching `core/grok/`: launch, binary, walk, transcript,
 * model list. The type import from `../adapter` is load-bearing: that module
 * holds the registry and imports this one, so a value import back would cycle.
 *
 * The type import from `../adapter` is **load-bearing, not stylistic**: that
 * module holds the registry and imports this one for real, so a value import
 * back would be a cycle. Types are erased; keep it `import type`.
 */

import type {
  AccountSource,
  CliAdapter,
  ConnectOptions,
  Launch,
  LaunchOptions,
  SessionHandle,
  UsageSource
} from '../adapter';
import { asStated, type PermissionView } from '../permissions';
import { catalogFor, windowOf } from '../catalog';
import { rowStatus } from '../accounts';
import { claudeBinary } from '../bin';
import type { SessionTransport } from '../session';
import { claudeAuthStamp, claudeAuthStatus } from './auth';
import { discover } from './discover';
import { OwnedSession, PROTOCOL_ARGS, PROTOCOL_ENV } from './session';
import {
  locateTranscript,
  readImage,
  readLastPromptAt,
  readRecent,
  readWitnessed
} from './transcript';
import { CLAUDE_WINDOWS, NO_RESET_MS, USAGE_MS } from './usage';
import * as execution from './execution';

/**
 * The launch line for one start.
 *
 * `PROTOCOL_ARGS` is what every start shares; everything below it is what this
 * start decided. The order is the one `host/sessions.ts` pushed them in, and
 * the reasons each flag is passed rather than assumed are recorded there and on
 * `PROTOCOL_ARGS` itself.
 *
 * `--session-id` and `--resume` are exclusive: a start handed both is a start
 * with two ids, and the CLI refuses it.
 */
function launch(options: LaunchOptions): Launch {
  const args: string[] = [...PROTOCOL_ARGS];
  const settings: Record<string, unknown> =
    options.execution && typeof options.execution === 'object'
      ? { ...(options.execution as Record<string, unknown>) }
      : {};
  if (options.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.model) {
    // **The one place `[1m]` and `CLAUDE_CODE_DISABLE_1M_CONTEXT` are spelled.**
    // Above here a start names a model and a window in tokens; which of them
    // needs a suffix, a flag, or nothing at all is this CLI's business and
    // stays behind this seam (root `AGENTS.md`, and `catalog.ts`'s header).
    //
    // Probed 2026-08-27/28 on 2.1.241, recorded in
    // `docs/reference/cli_state/claude/protocol.md`:
    //
    // - `suffix` — the CLI has no `[200k]` counterpart, so this only widens.
    // - `flag` — the var outranks the suffix and does not refuse, which makes
    //   it the only deterministic window there is. It rides `--settings` rather
    //   than `PROTOCOL_ENV` because the process environment is *inherited*: a
    //   session that spawns its own `claude` would pass it down, and every
    //   grandchild would be pinned by a decision made about its ancestor.
    //   `--settings` merges with the reader's own `env` block key by key
    //   (measured), so passing ours strips nothing of theirs.
    // - `plain`, or a pair the catalog does not state — say nothing, as every
    //   start did before this existed.
    const window = windowOf('claude', options.model, options.window);
    args.push('--model', window?.reach === 'suffix' ? `${options.model}[1m]` : options.model);
    if (window?.reach === 'flag') {
      settings.env = { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' };
    }
  }
  if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));
  if (options.name !== undefined) {
    args.push('--name', options.name);
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  } else if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }
  // Resume replays the original append today: cli_state/claude/protocol.md.
  if (options.briefing) args.push('--append-system-prompt', options.briefing);
  return { bin: options.bin, args, env: PROTOCOL_ENV };
}

function connect(transport: SessionTransport, start: ConnectOptions): SessionHandle {
  return new OwnedSession(transport, start);
}

async function discoverAsClaude(...args: Parameters<typeof discover>): ReturnType<typeof discover> {
  const sessions = await discover(...args);
  return sessions.map((session) => ({ ...session, brand: claudeAdapter.brand }));
}

const usage: UsageSource = {
  windows: CLAUDE_WINDOWS,
  read: readClaudeUsage,
  everyMs: USAGE_MS,
  noResetMs: NO_RESET_MS
};

/**
 * Claude's own words, as `--permission-mode` takes them and the transcript
 * states them back (`claude/transcript.ts`, `PermissionMode`). `default` is the
 * mode most sessions are in and prints nothing.
 */
const MODES: Record<string, PermissionView> = {
  acceptEdits: { label: 'accept edits', holds: false, bypass: false },
  plan: { label: 'plan', holds: true, bypass: false },
  auto: { label: 'auto', holds: false, bypass: false },
  bypassPermissions: { label: 'bypass', holds: false, bypass: true }
};

function permissionView(mode: string): PermissionView | undefined {
  if (mode === 'default') return undefined;
  return MODES[mode] ?? asStated(mode);
}

/** Sign-in: `claude auth status`, stamped off the account block in its config. */
const account: AccountSource = {
  status: async (override) => {
    const status = await claudeAuthStatus(override);
    return status && rowStatus(status);
  },
  stamp: () => claudeAuthStamp()
};

export const claudeAdapter: CliAdapter & { readonly brand: 'claude' } = {
  execution: execution.integration,
  brand: 'claude',
  pathSetting: 'claudePath',
  installUrl: 'https://code.claude.com/docs/en/setup',
  skillRoot: claudeRoot,
  skillSources: skills.skillSources,
  // True only because `startClaudeLogin` spawns under `BROWSER=true`; move the
  // two together or the reader gets no tab or two. Why, there.
  loginOpensBrowser: false,
  resolveBinary: (override) => claudeBinary(override),
  launch,
  connect,
  lastPromptAt: async (session) =>
    session.transcript ? readLastPromptAt(session.transcript) : undefined,
  discover: discoverAsClaude,
  locateTranscript,
  readTranscript: (session) => readRecent(session.transcript),
  readWitnessed: (session) => readWitnessed(session.transcript),
  readImage,
  models: () => catalogFor('claude'),
  modelSource: 'maintained',
  permissionView,
  usage,
  account
};
