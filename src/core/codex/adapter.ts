import type { HeadPass } from '../git';
import type { ProcessTable } from '../scan';
import type { PassEvidence } from '../published';
import { codexRoot } from './home';
import * as skills from './skills';
/** Codex app-server as a narrow owned-session runtime. */

import type {
  AccountSource,
  CliAdapter,
  ConnectOptions,
  Launch,
  LaunchOptions,
  SessionHandle,
  UsageSource
} from '../adapter';
import { rowStatus } from '../accounts';
import { codexBinary } from '../bin';
import type { Session } from '../model';
import { recordedPromptAt } from '../record';
import type { SessionTransport } from '../session';
import type { Recent } from '../transcript';
import { codexAuthStamp, codexAuthStatus, refreshCodexCatalog } from './auth';
import { discoverCodex } from './discover';
import { codexModels } from './models';
import { permissionView } from './permissions';
import { CodexSession } from './session';
import { activeTranscriptReader, readStoredTranscript } from './transcript';
import { CODEX_NO_RESET_MS, CODEX_USAGE_MS, CODEX_WINDOWS, readCodexUsage } from './usage';
import * as execution from './execution';

function launch(options: LaunchOptions): Launch {
  return {
    bin: options.bin,
    args: [
      'app-server',
      '--listen',
      'stdio://',
      ...(Array.isArray(options.execution) &&
      options.execution.every((value) => typeof value === 'string')
        ? options.execution
        : [])
    ],
    // C0 established SIGTERM shutdown. EOF-only shutdown was not established.
    terminateOnClose: true
  };
}

function connect(transport: SessionTransport, start: ConnectOptions): SessionHandle {
  return new CodexSession(transport, start);
}

function discover(
  _pass?: HeadPass,
  table?: ProcessTable,
  evidence?: PassEvidence
): Promise<Session[]> {
  return discoverCodex(table, evidence).then((sessions) =>
    sessions.map((session) => ({ ...session, brand: codexAdapter.brand }))
  );
}

async function readWitnessed(
  session: Session,
  override?: string
): Promise<{ recent: Recent; witnessed: ReadonlySet<string> }> {
  const active = activeTranscriptReader(session.sessionId);
  if (active) return active();
  return readStoredTranscript(session, override);
}

async function readTranscript(session: Session, override?: string): Promise<Recent> {
  return (await readWitnessed(session, override)).recent;
}

const usage: UsageSource = {
  windows: CODEX_WINDOWS,
  read: (override, options) => readCodexUsage(override, undefined, options),
  everyMs: CODEX_USAGE_MS,
  noResetMs: CODEX_NO_RESET_MS
};

/**
 * Sign-in: `account/read` on an app-server, stamped off `auth.json`. The catalog
 * is `refreshModels`'s, so a stamp that moves does not fetch it twice.
 */
const account: AccountSource = {
  status: async (override) => {
    const status = await codexAuthStatus(override, undefined, false);
    return status && rowStatus(status);
  },
  stamp: () => codexAuthStamp()
};

export const codexAdapter: CliAdapter & { readonly brand: 'codex' } = {
  execution: execution.integration,
  brand: 'codex',
  pathSetting: 'codexPath',
  installUrl: 'https://developers.openai.com/codex/cli',
  // `$CODEX_HOME/skills` is where Codex's own skill installer writes; the
  // install default is this; discovery follows CODEX_HOME via skills.ts.
  skillRoot: codexRoot,
  skillSources: skills.skillSources,
  // `account/login/start` answers with a verification URL and a code and opens
  // nothing: a device code exists to be carried to another device.
  loginOpensBrowser: false,
  resolveBinary: (override) => codexBinary(override),
  launch,
  connect,
  // This CLI publishes no transcript file. Our record is what
  // `session.transcript` already points at. See `CliAdapter.lastPromptAt`.
  lastPromptAt: (session) => recordedPromptAt(session.sessionId ?? ''),
  discover,
  readTranscript,
  readWitnessed,
  models: codexModels,
  modelSource: 'account',
  refreshModels: (override) => refreshCodexCatalog(override),
  permissionView,
  usage,
  account
};
