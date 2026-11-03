import type { HeadPass } from '../git';
import type { ProcessTable } from '../scan';
import type { PassEvidence } from '../published';
import * as skills from './skills';
/**
 * Grok, as the second brand on the seam.
 *
 * Launch is `grok agent --no-leader --always-approve stdio` when skip is
 * on or unset (1.0.4). Off is `grok --permission-mode default agent
 * --no-leader stdio`. `--no-leader` after `stdio` is a hard error.
 * A running model change is `session/set_model`, then the effort re-applied.
 * Asks are `_x.ai/ask_user_question`
 * (2026-08-16); `--always-approve` does not swallow them. Leftover
 * `session/request_permission` under that flag is answered when skip is
 * on (2026-08-17 census; t3code full-access).
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { BRIEFING_DIR } from '../paths';

import type {
  AccountSource,
  CliAdapter,
  Launch,
  LaunchOptions,
  SessionHandle,
  UsageSource
} from '../adapter';
import type { ConnectOptions } from '../adapter';
import { asStated, type PermissionView } from '../permissions';
import { catalogFor } from '../catalog';
import { grokBinary } from '../bin';
import type { Session } from '../model';
import { recordedPromptAt } from '../record';
import type { SessionTransport } from '../session';
import { rowStatus } from '../accounts';
import { grokAuthStamp, grokAuthStatus, grokPreflight } from './auth';
import { GROK_NO_RESET_MS, GROK_SESSION, GROK_USAGE_MS, GROK_WINDOW, readGrokUsage } from './usage';
import { discoverGrok } from './discover';
import { grokRoot } from './home';
import { GrokSession } from './session';
import { readGrokTranscript, readWitnessed } from './transcript';
import * as execution from './execution';

function launch(options: LaunchOptions): Launch {
  // `--permission-mode` is on root `grok`, not `agent` (1.0.4: `grok agent
  // --permission-mode default` is `unexpected argument`). Omitting
  // `--always-approve` without that override inherits `[ui] permission_mode`
  // from config.toml (this machine: always-approve).
  const args =
    options.skipPermissions === false
      ? ['--permission-mode', 'default', 'agent', '--no-leader']
      : ['agent', '--no-leader', '--always-approve'];
  // Only ids this CLI names. A leftover Opus id is a refused start.
  if (options.model?.startsWith('grok')) {
    args.push('-m', options.model);
  }
  // `options.window` is taken and ignored: one window, no flag to ask for
  // another (`GROK_MODELS` in `core/catalog.ts` measures every row and says why).
  if (options.effort) {
    args.push('--reasoning-effort', options.effort);
  }
  if (typeof options.execution === 'string') args.push('--plugin-dir', options.execution);
  let files: Launch['files'];
  if (options.briefing) {
    const content = `---\nname: squadron\ndescription: Squadron startup instructions\npromptMode: extend\n---\n${options.briefing}\n`;
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const file = path.join(BRIEFING_DIR, `grok-${hash}.md`);
    files = [{ path: file, content }];
    args.push('--agent-profile', file);
  }
  args.push('stdio');
  return { bin: options.bin, args, ...(files ? { files } : {}) };
}

// The rows this file used to hold are `GROK_MODELS` in `core/catalog.ts`, with
// the sitting that took them. They moved so both brands answer the `models`
// port out of one file, and so the next brand is a catalog entry rather than a
// literal in an adapter.

function connect(transport: SessionTransport, start: ConnectOptions): SessionHandle {
  return new GrokSession(transport, start);
}

async function discoverAsGrok(
  _pass?: HeadPass,
  table?: ProcessTable,
  evidence?: PassEvidence
): Promise<Session[]> {
  const sessions = await discoverGrok(table, evidence);
  return sessions.map((session) => ({ ...session, brand: grokAdapter.brand }));
}

const usage: UsageSource = {
  windows: [GROK_SESSION, GROK_WINDOW],
  read: async (_override, options) => {
    await options?.remember?.([]);
    return readGrokUsage({ signal: options?.signal });
  },
  everyMs: GROK_USAGE_MS,
  noResetMs: GROK_NO_RESET_MS,
  // The billing GET is this host's own request; the ACP pipe states no quota.
  childless: true
};

/**
 * Both words are ours: this CLI states no mode on the wire (probe 2026-08-17),
 * so `session.ts` mints whichever of the two `launch()` above composed.
 * `always-approve` is a flag on the launch line and bypasses everything the
 * panel would otherwise be asked; `ask` is `--permission-mode default`.
 */
function permissionView(mode: string): PermissionView | undefined {
  if (mode === 'always-approve') return { label: 'bypass', holds: false, bypass: true };
  if (mode === 'ask') return { label: 'ask', holds: false, bypass: false };
  return asStated(mode);
}

/**
 * Sign-in: the status is `~/.grok/auth.json` itself, so the stamp is that file.
 * No override reaches either — the argument `grokAuthStatus` takes is a home
 * directory, and a binary path handed to it would look signed out.
 */
const account: AccountSource = {
  status: async () => rowStatus(await grokAuthStatus()),
  stamp: () => grokAuthStamp()
};

export const grokAdapter: CliAdapter & { readonly brand: 'grok' } = {
  execution: execution.integration,
  brand: 'grok',
  pathSetting: 'grokPath',
  // Not `x.ai/cli`, which the binary names: it answers 403 to a non-browser
  // client (2026-09-25). This page carries the same `install.sh` line.
  installUrl: 'https://docs.x.ai/build/overview',
  skillRoot: grokRoot,
  skillSources: skills.skillSources,
  resolveBinary: (override) => grokBinary(override),
  preflight: grokPreflight,
  launch,
  connect,
  // Not this CLI's own file: `chat_history.jsonl` stamps no row, and the
  // sibling `updates.jsonl` that does is megabytes past the last prompt. See
  // `CliAdapter.lastPromptAt`.
  lastPromptAt: (session) => recordedPromptAt(session.sessionId ?? ''),
  discover: discoverAsGrok,
  readTranscript: (session) => readGrokTranscript(session.transcript),
  readWitnessed: (session) => readWitnessed(session.transcript),
  models: () => catalogFor('grok'),
  modelSource: 'maintained',
  permissionView,
  usage,
  account
};
