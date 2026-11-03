/** A deterministic Codex 0.151.0 app-server peer for runtime and auth tests. */

import { nativeTool } from './native_tool';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { logEnvironment } from './env_log';

logEnvironment();

const mode = process.env.FAKE_CODEX_MODE ?? 'normal';
const argv = process.argv.slice(2);
const fakeHome = process.env.HOME ?? process.cwd();
const authFile = path.join(fakeHome, '.codex', 'fake-auth.json');
/** Every decision this fake matched to one of its own requests, one per line. */
const answersFile = path.join(fakeHome, '.codex', 'fake-answers.log');
const loginComplete = path.join(fakeHome, '.codex', 'fake-login-complete');
const threadStore = process.env.FAKE_CODEX_STORE;

function afterResumeGate(phase: 'start' | 'history', answer: () => void): void {
  const file = path.join(fakeHome, '.codex', `fake-resume-${phase}.hold`);
  if (!fs.existsSync(file)) {
    answer();
    return;
  }
  let waiting = true;
  const release = (): void => {
    if (!waiting || fs.existsSync(file)) return;
    waiting = false;
    fs.unwatchFile(file, release);
    answer();
  };
  fs.watchFile(file, { interval: 25, persistent: false }, release);
  release();
}

if (mode === 'early-exit') {
  process.stderr.write('fake Codex exited before initialize\n');
  process.exit(17);
}

/**
 * `codex mcp` — the surface the MCP sheet reads, not the app-server.
 *
 * Values are synthetic. The only real behaviour reproduced is the shape of
 * `mcp list --json`, that it answers for the *cwd* it is run in (which is how
 * the panel derives user versus project scope), and that `login` prints an
 * authorize url on stdout and blocks until the grant lands.
 */
if (argv[0] === 'mcp') {
  const grants = path.join(fakeHome, '.codex', 'fake-mcp-grants.json');
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const heldNames = (): string[] => {
    const held = readJson(grants);
    return Array.isArray(held) ? (held as string[]) : [];
  };

  if (argv[1] === 'list' && argv[2] === '--json') {
    const user = readJson(path.join(fakeHome, '.codex', 'fake-mcp-user.json'));
    // A project file is only honoured from the directory holding it, which is
    // the trust rule's observable effect for our purposes.
    const project = readJson(path.join(process.cwd(), '.codex', 'fake-mcp-project.json'));
    const all = [...(Array.isArray(user) ? user : []), ...(Array.isArray(project) ? project : [])];
    const held = new Set(heldNames());
    process.stdout.write(
      `${JSON.stringify(
        all.map((server) => {
          const said = server as Record<string, unknown>;
          const wantsOauth = said.oauth === true;
          return {
            name: said.name,
            enabled: said.enabled !== false,
            disabled_reason: said.disabled_reason ?? null,
            transport: said.transport,
            startup_timeout_sec: null,
            tool_timeout_sec: null,
            auth_status: wantsOauth
              ? held.has(String(said.name))
                ? 'o_auth'
                : 'not_logged_in'
              : (said.auth_status ?? 'unsupported')
          };
        })
      )}\n`
    );
    process.exit(0);
  }

  if (argv[1] === 'login' && argv[2]) {
    const name = argv[2];
    process.stdout.write(`Authorize \`${name}\` by opening this URL in your browser:\n`);
    process.stdout.write(
      `https://mcp.smoke.test/authorize?response_type=code&client_id=fake&code_challenge=fakechallenge&state=1\n`
    );
    // Blocks exactly as the real one does, until the operator — here, the
    // scenario — drops the file that stands in for the browser callback.
    //
    // **Synchronously**, and that is the point: a timer would let this fall
    // through into the app-server branch below and start a second protocol on
    // the same stdin. `Atomics.wait` parks the one thread instead.
    const approved = path.join(fakeHome, '.codex', 'fake-mcp-approve');
    const park = new Int32Array(new SharedArrayBuffer(4));
    const until = Date.now() + 30_000;
    for (;;) {
      if (fs.existsSync(approved)) {
        fs.rmSync(approved, { force: true });
        fs.mkdirSync(path.dirname(grants), { recursive: true });
        fs.writeFileSync(grants, JSON.stringify([...new Set([...heldNames(), name])]));
        process.exit(0);
      }
      if (Date.now() > until) {
        process.stderr.write('fake Codex login timed out\n');
        process.exit(1);
      }
      Atomics.wait(park, 0, 0, 50);
    }
  } else if (argv[1] === 'logout' && argv[2]) {
    const name = argv[2];
    fs.mkdirSync(path.dirname(grants), { recursive: true });
    fs.writeFileSync(grants, JSON.stringify(heldNames().filter((held) => held !== name)));
    process.exit(0);
  } else if (argv[1] !== 'login') {
    process.stderr.write(`unexpected fake Codex mcp argv: ${JSON.stringify(argv)}\n`);
    process.exit(2);
  }
} else if (argv[0] !== 'app-server' || argv[1] !== '--listen' || argv[2] !== 'stdio://') {
  process.stderr.write(`unexpected fake Codex argv: ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id: unknown, value: unknown): void {
  write({ id, result: value });
}

function notify(method: string, params: unknown): void {
  write({ method, params, emittedAtMs: Date.now() });
}

function signedIn(): boolean {
  return fs.existsSync(authFile);
}

function setSignedIn(value: boolean): void {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  if (value) {
    fs.writeFileSync(authFile, JSON.stringify({ email: 'codex-smoke@example.invalid' }));
  } else {
    try {
      fs.unlinkSync(authFile);
    } catch {
      // Idempotent logout.
    }
  }
}

type StoredThread = {
  id: string;
  cwd: string;
  name: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
};

function storedThreads(): StoredThread[] {
  if (!threadStore) return [];
  try {
    const value = JSON.parse(fs.readFileSync(threadStore, 'utf8')) as unknown;
    return Array.isArray(value) ? (value as StoredThread[]) : [];
  } catch {
    return [];
  }
}

function writeThreads(rows: StoredThread[]): void {
  if (!threadStore) return;
  fs.mkdirSync(path.dirname(threadStore), { recursive: true });
  fs.writeFileSync(threadStore, JSON.stringify(rows));
}

function updateThread(threadId: string, change: Partial<StoredThread>): void {
  if (!threadStore) return;
  const rows = storedThreads();
  const at = rows.findIndex((row) => row.id === threadId);
  if (at < 0) return;
  rows[at] = { ...rows[at]!, ...change };
  writeThreads(rows);
}

function rememberThread(threadId: string, cwd: string): void {
  if (!threadStore) return;
  const now = Math.floor(Date.now() / 1000);
  const rows = storedThreads().filter((row) => row.id !== threadId);
  rows.push({ id: threadId, cwd, name: null, preview: '', createdAt: now, updatedAt: now });
  writeThreads(rows);
}

function storedThread(threadId: string): StoredThread | undefined {
  return storedThreads().find((row) => row.id === threadId);
}

function opened(threadId: string, params: Record<string, unknown>): Record<string, unknown> {
  const config = record(params.config) ? params.config : {};
  const model = typeof params.model === 'string' ? params.model : 'gpt-codex-test';
  const effort =
    mode === 'resume-high'
      ? 'high'
      : typeof config.model_reasoning_effort === 'string'
        ? config.model_reasoning_effort
        : 'medium';
  const approvalPolicy = params.approvalPolicy ?? 'on-request';
  const cwd = typeof params.cwd === 'string' ? params.cwd : process.cwd();
  const stored = storedThread(threadId);
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      cwd,
      status: { type: 'idle' },
      name: stored?.name ?? null,
      path: null,
      canAcceptDirectInput: mode !== 'no-input',
      turns: []
    },
    model,
    modelProvider: 'openai',
    serviceTier: null,
    cwd,
    approvalPolicy,
    approvalsReviewer: 'user',
    sandbox: { type: params.sandbox ?? 'workspaceWrite' },
    reasoningEffort: effort
  };
}

function fakeTurn(threadId: string): void {
  const turnId = 'turn-c1';
  notify('thread/name/updated', { threadId, threadName: 'Codex C1 fixture' });
  notify('thread/settings/updated', {
    threadId,
    threadSettings: {
      cwd: process.cwd(),
      approvalPolicy: 'on-request',
      model: 'gpt-codex-runtime',
      modelProvider: 'openai',
      effort: 'high'
    }
  });
  notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } });
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        totalTokens: 1234,
        inputTokens: 1200,
        cachedInputTokens: 0,
        outputTokens: 34,
        reasoningOutputTokens: 0
      },
      last: {
        totalTokens: 1234,
        inputTokens: 1200,
        cachedInputTokens: 0,
        outputTokens: 34,
        reasoningOutputTokens: 0
      },
      modelContextWindow: 258400
    }
  });
  setTimeout(() => {
    notify('thread/status/changed', { threadId, status: { type: 'idle' } });
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', items: [], itemsView: 'summary' }
    });
  }, 20);
}

let currentThread = 'thread-c1';
let currentTurn: string | undefined;
let turnNumber = 0;
let activeLogin: string | undefined;
let loginWatch: NodeJS.Timeout | undefined;
const serverRequests = new Map<
  string | number,
  { label: string; method: string; threadId: string; turnId: string }
>();

function requestClient(
  id: string | number,
  method: string,
  params: Record<string, unknown>,
  label: string
): void {
  const threadId = typeof params.threadId === 'string' ? params.threadId : currentThread;
  const turnId = typeof params.turnId === 'string' ? params.turnId : (currentTurn ?? '');
  serverRequests.set(id, { label, method, threadId, turnId });
  write({ method, id, params });
}

function requestPair(threadId: string, turnId: string): void {
  notify('thread/status/changed', {
    threadId,
    status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] }
  });
  requestClient(
    41,
    'item/commandExecution/requestApproval',
    {
      threadId,
      turnId,
      itemId: 'command-pair',
      command: 'npm test',
      cwd: '/tmp/codex-project',
      reason: 'Run the suite',
      availableDecisions: ['accept', 'acceptForSession', 'decline']
    },
    'command'
  );
  // The string twin proves product request keys do not collapse protocol ids.
  requestClient(
    '41',
    'item/tool/requestUserInput',
    {
      threadId,
      turnId,
      itemId: 'question-pair',
      questions: [
        {
          id: 'route',
          header: 'Route',
          question: 'Which route?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Left', description: 'Scenic' },
            { label: 'Right', description: 'Direct' }
          ]
        }
      ],
      // The shape Arm C observed from a panel-shaped thread. The secret arm
      // below stays blocking, so the two are told apart by what they carry
      // rather than by whether Codex waits.
      isBlocking: false,
      autoResolutionMs: null
    },
    'question'
  );
}

// Text items reach the model run together, with nothing between them (0.160.0,
// probed 2026-10-04): a separator is the sender's to write.
function inputText(params: Record<string, unknown>): string {
  const input = Array.isArray(params.input) ? params.input : [];
  return input
    .flatMap((part) =>
      record(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    )
    .join('');
}

/**
 * The prompt said back as the turn's answer, where `FAKE_CODEX_ECHO` asks:
 * a test that reads what a finished turn ended on needs a turn that ends on
 * something. Off by default, because the suites written before it assert a
 * turn that says nothing.
 */
function echo(turnId: string, text: string): void {
  const item = { type: 'agentMessage', id: `message-${turnId}`, text, phase: 'final_answer' };
  notify('item/started', { threadId: currentThread, turnId, item: { ...item, text: '' } });
  notify('item/agentMessage/delta', { threadId: currentThread, turnId, itemId: item.id, delta: text });
  notify('item/completed', { threadId: currentThread, turnId, item });
}

function completeTurn(threadId: string, turnId: string, status = 'completed'): void {
  if (currentTurn !== turnId) return;
  currentTurn = undefined;
  updateThread(threadId, { updatedAt: Math.floor(Date.now() / 1000) });
  notify('thread/status/changed', { threadId, status: { type: 'idle' } });
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status, items: [], itemsView: 'summary' }
  });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!record(message)) return;
  if (typeof message.method !== 'string') {
    const responseId =
      typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
    const pending = responseId === undefined ? undefined : serverRequests.get(responseId);
    if (!pending || responseId === undefined) return;
    serverRequests.delete(responseId);
    notify('serverRequest/resolved', { threadId: pending.threadId, requestId: responseId });
    const response = Object.hasOwn(message, 'result')
      ? message.result
      : pending.method === 'item/tool/requestUserInput'
        ? { answers: {} }
        : message.error;
    const answer = `answered:${pending.label}:${JSON.stringify(response)}`;
    notify('thread/name/updated', { threadId: pending.threadId, threadName: answer });
    // The same fact on disk, because the thread name is no longer a channel a
    // scenario can rely on: a session started from a draft carries a `--name`
    // cut from its prompt, and an explicit name outranks any title the CLI
    // states afterwards (`core/live.ts`). The notification above is still what
    // the panel's own reading is tested against; this is what a scenario reads
    // to say the decision reached the child at all.
    try {
      fs.mkdirSync(path.dirname(answersFile), { recursive: true });
      fs.appendFileSync(answersFile, answer + '\n');
    } catch {
      // A fixture that cannot write its own log is not a reason to fail a turn.
    }
    if (![...serverRequests.values()].some((request) => request.turnId === pending.turnId)) {
      completeTurn(pending.threadId, pending.turnId);
    }
    return;
  }
  if (process.env.FAKE_CODEX_REQUEST_LOG) fs.appendFileSync(process.env.FAKE_CODEX_REQUEST_LOG, JSON.stringify(message) + '\n');
  const id = message.id;
  const params = record(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize':
      if (mode === 'silent') {
        break;
      } else if (
        mode === 'require-experimental' &&
        (!record(params.capabilities) || params.capabilities.experimentalApi !== true)
      ) {
        write({ id, error: { code: -32602, message: 'experimental API was not enabled' } });
      } else if (
        mode === 'stable-only' &&
        record(params.capabilities) &&
        params.capabilities.experimentalApi === true
      ) {
        write({ id, error: { code: -32602, message: 'experimental API is unavailable' } });
      } else if (mode === 'bad-initialize') {
        result(id, { userAgent: 7 });
      } else if (mode === 'error-initialize') {
        write({ id, error: { code: -32000, message: 'fake initialize refusal' } });
      } else {
        result(id, {
          userAgent: 'fake-codex/0.151.0',
          codexHome: '/fake/.codex',
          platformFamily: 'unix',
          platformOs: 'macos'
        });
      }
      break;
    case 'initialized':
      break;
    case 'config/read': {
      const configured = process.env.FAKE_CODEX_CONFIG;
      if (configured === 'timeout') break;
      if (configured === 'refused') write({ id, error: { code: -32000, message: 'configuration unavailable' } });
      else if (configured === 'bad-response') result(id, { config: [] });
      else result(id, { config: configured === 'absent' ? {} : { developer_instructions: configured === 'null' ? null : configured === 'malformed' ? 7 : configured ?? '' } });
      break;
    }
    case 'account/read':
      result(id, {
        account: signedIn()
          ? { type: 'chatgpt', email: 'codex-smoke@example.invalid', planType: 'Smoke' }
          : null,
        requiresOpenaiAuth: true
      });
      break;
    case 'account/login/start':
      activeLogin = 'codex-smoke-login';
      result(id, {
        // A `.test` domain, the way the MCP fixtures do, and not the real
        // `auth.openai.com/codex/device` this used to answer: the host opens
        // this URL itself for Codex, so a barrel run aimed three sign-ins at a
        // production auth page. `browserSink()` in `smoke/boot.ts` is what
        // stops a tab opening at all; this is what a run without it opens.
        type: 'chatgptDeviceCode',
        loginId: activeLogin,
        verificationUrl: 'https://codex.smoke.test/device',
        userCode: 'CDX5-SMOK'
      });
      loginWatch = setInterval(() => {
        if (!activeLogin || !fs.existsSync(loginComplete)) return;
        fs.unlinkSync(loginComplete);
        const loginId = activeLogin;
        activeLogin = undefined;
        if (loginWatch) clearInterval(loginWatch);
        setSignedIn(true);
        notify('account/login/completed', { loginId, success: true, error: null });
        notify('account/updated', { authMode: 'chatgpt', planType: 'Smoke' });
      }, 20);
      break;
    case 'account/login/cancel': {
      const loginId = typeof params.loginId === 'string' ? params.loginId : '';
      activeLogin = undefined;
      if (loginWatch) clearInterval(loginWatch);
      result(id, { status: 'canceled' });
      notify('account/login/completed', {
        loginId,
        success: false,
        error: 'Login was not completed'
      });
      break;
    }
    case 'account/logout':
      setSignedIn(false);
      result(id, {});
      notify('account/updated', { authMode: null, planType: null });
      break;
    case 'model/list':
      result(id, {
        data: [
          {
            id: 'gpt-codex-test',
            model: 'gpt-codex-test',
            displayName: 'Codex Test',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'fixture' }],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image']
          },
          ...(signedIn()
            ? [
                {
                  id: 'gpt-codex-signed-in',
                  model: 'gpt-codex-signed-in',
                  displayName: 'Codex Signed In',
                  hidden: false,
                  isDefault: false,
                  supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'fixture' }],
                  defaultReasoningEffort: 'high',
                  inputModalities: ['text']
                }
              ]
            : [])
        ],
        nextCursor: null
      });
      break;
    case 'account/rateLimits/read':
      if (!signedIn()) {
        write({
          id,
          error: {
            code: -32600,
            message: 'codex account authentication required to read rate limits'
          }
        });
      } else {
        // Three days out, computed rather than a far-future constant: the
        // accounts popover prints when a window turns over now, and a fixed
        // 4_000_000_000 drew `resets 25581d 15h` on the row under assertion.
        result(id, {
          rateLimits: {
            primary: {
              usedPercent: 45,
              windowDurationMins: 10080,
              resetsAt: Math.floor(Date.now() / 1000) + 3 * 86_400
            },
            secondary: null
          },
          rateLimitsByLimitId: {}
        });
      }
      break;
    case 'thread/start':
      if (mode === 'bad-thread') {
        result(id, { thread: { id: '', canAcceptDirectInput: false } });
        break;
      }
      afterResumeGate('start', () => {
        if (fs.existsSync(path.join(fakeHome, '.codex', 'fake-open-refuse'))) {
          write({ id, error: { code: -32000, message: 'fake opening protocol failure' } });
          return;
        }
        currentThread = threadStore ? `thread-codex-${Date.now()}-${process.pid}` : 'thread-c1';
        rememberThread(currentThread, typeof params.cwd === 'string' ? params.cwd : process.cwd());
        result(id, opened(currentThread, params));
        setTimeout(() => {
          notify('thread/started', { thread: opened(currentThread, params).thread });
          if (mode === 'auto-turn') fakeTurn(currentThread);
        }, 10);
      });
      break;
    case 'thread/resume':
      currentThread = typeof params.threadId === 'string' ? params.threadId : '';
      if (threadStore && !storedThread(currentThread)) {
        write({
          id,
          error: { code: -32600, message: `no rollout found for thread id ${currentThread}` }
        });
        break;
      }
      afterResumeGate('start', () => result(id, opened(currentThread, params)));
      break;
    case 'thread/list': {
      const requested = Array.isArray(params.cwd)
        ? params.cwd.filter((value): value is string => typeof value === 'string')
        : typeof params.cwd === 'string'
          ? [params.cwd]
          : [];
      const offset =
        typeof params.cursor === 'string' && params.cursor.startsWith('offset:')
          ? Number(params.cursor.slice('offset:'.length))
          : 0;
      const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 20;
      const rows = storedThreads()
        .filter((row) => !requested.length || requested.includes(row.cwd))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const data = rows.slice(offset, offset + limit).map((row) => ({
        ...row,
        sessionId: row.id,
        preview: row.preview,
        recencyAt: row.updatedAt,
        status: { type: 'notLoaded' },
        source: 'vscode',
        canAcceptDirectInput: null,
        ephemeral: false,
        gitInfo: null,
        turns: []
      }));
      const next = offset + data.length;
      result(id, {
        data,
        nextCursor: next < rows.length ? `offset:${next}` : null,
        backwardsCursor: data.length ? `offset:${offset}` : null
      });
      break;
    }
    case 'thread/read': {
      const threadId = typeof params.threadId === 'string' ? params.threadId : '';
      const row = storedThread(threadId);
      if (!row) {
        write({
          id,
          error: { code: -32600, message: `no rollout found for thread id ${threadId}` }
        });
      } else {
        result(id, { thread: { ...row, status: { type: 'notLoaded' }, turns: [] } });
      }
      break;
    }
    case 'thread/turns/list':
    case 'thread/items/list':
      afterResumeGate('history', () => result(id, { data: [], nextCursor: null, backwardsCursor: null }));
      break;
    case 'thread/unsubscribe':
      result(id, { status: 'unsubscribed' });
      break;
    case 'turn/start': {
      currentTurn = `turn-c2-${++turnNumber}`;
      const turnModel = typeof params.model === 'string' ? params.model : 'gpt-codex-test';
      const turnEffort = typeof params.effort === 'string' ? params.effort : 'medium';
      updateThread(currentThread, {
        preview: inputText(params),
        updatedAt: Math.floor(Date.now() / 1000)
      });
      result(id, { turn: { id: currentTurn, status: 'inProgress' } });
      notify('thread/status/changed', {
        threadId: currentThread,
        status: { type: 'active', activeFlags: [] }
      });
      notify('turn/started', {
        threadId: currentThread,
        turn: { id: currentTurn, status: 'inProgress', items: [], itemsView: 'notLoaded' }
      });
      const userMessage = {
        type: 'userMessage',
        id: `user-${currentTurn}`,
        clientId:
          typeof params.clientUserMessageId === 'string' ? params.clientUserMessageId : null,
        content: Array.isArray(params.input) ? params.input : []
      };
      notify('item/started', {
        threadId: currentThread,
        turnId: currentTurn,
        item: userMessage,
        startedAtMs: Date.now()
      });
      notify('item/completed', {
        threadId: currentThread,
        turnId: currentTurn,
        item: userMessage,
        completedAtMs: Date.now()
      });
      // A stable-surface session is never told (cli_state/codex/protocol.md).
      if (mode !== 'stable-only') {
        notify('thread/settings/updated', {
          threadId: currentThread,
          threadSettings: { model: turnModel, effort: turnEffort }
        });
      }
      notify('thread/name/updated', {
        threadId: currentThread,
        threadName: `sent:${inputText(params)}|model:${
          typeof params.model === 'string' ? params.model : ''
        }|effort:${typeof params.effort === 'string' ? params.effort : ''}|images:${
          Array.isArray(params.input)
            ? params.input.filter((part) => record(part) && part.type !== 'text').length
            : 0
        }`
      });
      const tool = nativeTool(inputText(params), { CODEX_SESSION_ID: currentThread });
      if (tool) {
        const finishing = currentTurn;
        void tool.then(() => finishing && completeTurn(currentThread, finishing));
      } else if (inputText(params).includes('request pair')) {
        requestPair(currentThread, currentTurn);
      } else if (inputText(params).includes('permission request')) {
        notify('thread/status/changed', {
          threadId: currentThread,
          status: { type: 'active', activeFlags: ['waitingOnApproval'] }
        });
        requestClient(
          43,
          'item/permissions/requestApproval',
          {
            threadId: currentThread,
            turnId: currentTurn,
            itemId: 'permission-profile',
            cwd: '/tmp/codex-project',
            reason: 'Use the shared output',
            permissions: {
              network: { enabled: true },
              fileSystem: { write: ['/tmp/codex-project/shared'] }
            }
          },
          'permissions'
        );
      } else if (inputText(params).includes('patch request')) {
        // The one file-change arm a reader can actually answer. `retract
        // request` and `complete request` below both resolve themselves in
        // 40ms, which is what those cases are for and what makes them useless
        // to anything driving the dialog through the panel.
        notify('thread/status/changed', {
          threadId: currentThread,
          status: { type: 'active', activeFlags: ['waitingOnApproval'] }
        });
        requestClient(
          46,
          'item/fileChange/requestApproval',
          {
            threadId: currentThread,
            turnId: currentTurn,
            itemId: 'patch-file',
            reason: 'Apply the patch',
            grantRoot: null
          },
          'file'
        );
      } else if (inputText(params).includes('duplicate request')) {
        notify('thread/status/changed', {
          threadId: currentThread,
          status: { type: 'active', activeFlags: ['waitingOnApproval'] }
        });
        const duplicate = {
          threadId: currentThread,
          turnId: currentTurn,
          itemId: 'duplicate-command',
          command: 'pwd',
          availableDecisions: ['accept', 'decline']
        };
        requestClient(44, 'item/commandExecution/requestApproval', duplicate, 'duplicate');
        setTimeout(
          () => requestClient(44, 'item/commandExecution/requestApproval', duplicate, 'duplicate'),
          20
        );
      } else if (inputText(params).includes('complete request')) {
        notify('thread/status/changed', {
          threadId: currentThread,
          status: { type: 'active', activeFlags: ['waitingOnApproval'] }
        });
        requestClient(
          45,
          'item/fileChange/requestApproval',
          {
            threadId: currentThread,
            turnId: currentTurn,
            itemId: 'completed-file',
            reason: 'A callback outlived its turn',
            grantRoot: null
          },
          'completed'
        );
        const completing = currentTurn;
        setTimeout(() => completeTurn(currentThread, completing ?? ''), 40);
      } else if (inputText(params).includes('retract request')) {
        notify('thread/status/changed', {
          threadId: currentThread,
          status: { type: 'active', activeFlags: ['waitingOnApproval'] }
        });
        requestClient(
          42,
          'item/fileChange/requestApproval',
          {
            threadId: currentThread,
            turnId: currentTurn,
            itemId: 'file-retract',
            reason: 'Apply the patch',
            grantRoot: null
          },
          'retracted'
        );
        const retracting = currentTurn;
        setTimeout(() => {
          if (!retracting || !serverRequests.delete(42)) return;
          notify('serverRequest/resolved', { threadId: currentThread, requestId: 42 });
          completeTurn(currentThread, retracting);
        }, 40);
      } else if (inputText(params).includes('secret request')) {
        notify('thread/status/changed', {
          threadId: currentThread,
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] }
        });
        requestClient(
          43,
          'item/tool/requestUserInput',
          {
            threadId: currentThread,
            turnId: currentTurn,
            itemId: 'secret-question',
            questions: [
              {
                id: 'secret',
                header: 'Secret',
                question: 'Token?',
                isOther: true,
                isSecret: true,
                options: null
              }
            ],
            isBlocking: true,
            autoResolutionMs: null
          },
          'secret'
        );
      } else if (inputText(params).includes('question request')) {
        // One question and nothing beside it, so a typed reply reads as its
        // answer: `request pair` opens an approval with it, and `secret
        // request`'s question is one the panel declines to draw.
        notify('thread/status/changed', {
          threadId: currentThread,
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] }
        });
        requestClient(
          47,
          'item/tool/requestUserInput',
          {
            threadId: currentThread,
            turnId: currentTurn,
            itemId: 'question-only',
            questions: [
              {
                id: 'route',
                header: 'Route',
                question: 'Which route?',
                isOther: true,
                isSecret: false,
                options: [{ label: 'Left' }, { label: 'Right' }]
              }
            ],
            isBlocking: true,
            autoResolutionMs: null
          },
          'question'
        );
      } else if (!inputText(params).includes('slow')) {
        const finishing = currentTurn;
        if (process.env.FAKE_CODEX_ECHO && finishing) echo(finishing, inputText(params));
        setTimeout(() => finishing && completeTurn(currentThread, finishing), 30);
      }
      break;
    }
    case 'turn/interrupt': {
      const turnId = typeof params.turnId === 'string' ? params.turnId : '';
      if (mode === 'error-interrupt') {
        write({ id, error: { code: -32000, message: 'fake interrupt refusal' } });
        break;
      }
      result(id, {});
      for (const [requestId, request] of serverRequests) {
        if (request.turnId !== turnId) continue;
        serverRequests.delete(requestId);
        notify('serverRequest/resolved', { threadId: request.threadId, requestId });
      }
      notify('thread/name/updated', {
        threadId: currentThread,
        threadName: `interrupted:${turnId}`
      });
      completeTurn(currentThread, turnId, 'interrupted');
      break;
    }
    case 'thread/name/set': {
      const name = typeof params.name === 'string' ? params.name : '';
      updateThread(currentThread, { name, updatedAt: Math.floor(Date.now() / 1000) });
      result(id, {});
      notify('thread/name/updated', { threadId: currentThread, threadName: name });
      break;
    }
    default:
      if (id !== undefined) {
        write({ id, error: { code: -32601, message: `unknown fake method ${message.method}` } });
      }
  }
});

const stopHold = path.join(fakeHome, '.codex', 'fake-stop.hold');
let stopping = false;
const stop = (): void => {
  if (fs.existsSync(path.join(fakeHome, '.codex', 'fake-flush-delay'))) {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      fs.writeFileSync(path.join(fakeHome, '.codex', `fake-flush-${process.pid}`), 'flushed after 400ms');
      process.exit(0);
    }, 400);
    return;
  }
  if (!fs.existsSync(stopHold)) process.exit(0);
  if (stopping) return;
  stopping = true;
  if (loginWatch) clearInterval(loginWatch);
  fs.watchFile(stopHold, { interval: 25 }, () => {
    if (!fs.existsSync(stopHold)) process.exit(0);
  });
};
const terminate = (): void => {
  if (fs.existsSync(stopHold) || fs.existsSync(path.join(fakeHome, '.codex', 'fake-flush-delay'))) stop();
  else {
    process.removeListener('SIGTERM', terminate);
    process.kill(process.pid, 'SIGTERM');
  }
};
process.on('SIGTERM', terminate);
process.stdin.on('end', stop);
