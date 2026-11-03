/**
 * A `claude` that costs nothing: reads stream-json on stdin, writes canned
 * frames on stdout.
 *
 * Every frame below is copied from a real probe run (2026-07-27, CLI 2.1.220,
 * recorded in `docs/reference/cli_state/claude/protocol.md`) and keeps the CLI's own
 * field spellings — `session_id`, `permissionMode`, `requires_user_interaction`
 * — because a fixture that agrees with our reader instead of with the CLI would
 * pass while the real thing failed.
 *
 * What a turn does is chosen by the text sent to it, so one script covers every
 * shape the client has to handle:
 *
 * | Text | What comes back |
 * | --- | --- |
 * | `ask` | an `AskUserQuestion` control request — three questions, the multi-select in slot 2 |
 * | `two` | two `Write` permission requests, both open at once |
 * | `write` | a `Write` permission request, with a suggestion on it |
 * | `held-tool` | a silent busy turn with an open Bash tool, until interrupted |
 * | `thread-acquisition` | file-paced text growth and completing assistant frame for host acquisition smoke |
 * | `delayed-interrupt` | a slow turn whose interrupt waits for its fixture signal file |
 * | `slow` | an `init` and a delta, then nothing: a turn to interrupt |
 * | `linger` | an `init` and a delta, then a `result` 4s later: a turn that is seen busy and ends well |
 * | `quiet` | a turn that ends on `session_state_changed` alone, with no `result` |
 * | `api-529`, `api-403` | a turn that could not run: a `<synthetic>` reply, `terminal_reason: "api_error"` |
 * | `api-retry` | two `api_retry` frames 150ms apart, then the `api-529` ending |
 * | `origin` | the fan-out var off the child's own environment, or `unset` |
 * | `whoami` | every name in `IDENTITY_NAMES` off the child's own environment |
 * | `entrypoint` | `CLAUDE_CODE_ENTRYPOINT` off the child's own environment, or `unset` |
 * | anything | `init`, `message_start`, text block start and delta, completing `assistant`, `result` |
 *
 * A control response we receive is echoed back as assistant text, which is how
 * a test reads what the client actually put on the wire.
 *
 * Not a `*.test.ts`, so no test glob picks it up; it is spawned by
 * `session.test.ts` through `childTransport`'s own code path.
 */

import { nativeTool } from './native_tool';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'readline';

import { IDENTITY_NAMES } from '../../core/identity';
import { logEnvironment } from './env_log';

/**
 * Machine-wide auth, the way smoke drives the accounts surfaces without a real
 * Anthropic login. The host points `squadron.claudePath` at this fixture, so
 * `claude auth status|login|logout` land here rather than on a network CLI.
 *
 * State lives under `$HOME/.claude/squadron/fake-auth.json` — the smoke
 * `HOME` is already a temp dir, and unit tests that never call `auth` never
 * touch the file. Default when the file is missing: **signed in**, so the nav
 * ladder's `.lim .w5` box still exists on first paint (signed-out replaces the
 * readout with a Log in button and would vacate the 600px step).
 */
/**
 * The argv this fixture was launched with, appended one JSON array per spawn to
 * the file `FAKE_CLI_ARGV` names.
 *
 * The only witness there is to what went on a launch line. A card states what
 * the *panel* passed to `connect` — the same local `launch` was handed one
 * statement earlier — so a scenario reading a flag off a card is reading our own
 * side of the call back to us. This is the other side.
 *
 * Only where the smoke shim named a file. Unit tests spawn this fixture too and
 * set no such variable, and a fixture guessing at a path leaves a file in
 * whatever `HOME` those happen to point at.
 */
const recordArgv = (): void => {
  const file = process.env.FAKE_CLI_ARGV;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(process.argv.slice(2)) + '\n');
  } catch {
    // A fixture that cannot write its own log still has a session to run.
  }
};
recordArgv();
logEnvironment();

type FakeAuth = {
  loggedIn: boolean;
  email?: string;
  plan?: string;
};

const fakeAuthPath = (): string =>
  path.join(process.env.HOME || os.homedir(), '.claude', 'squadron', 'fake-auth.json');

const readFakeAuth = (): FakeAuth => {
  try {
    const raw = JSON.parse(fs.readFileSync(fakeAuthPath(), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') throw new Error('empty');
    const o = raw as Record<string, unknown>;
    if (typeof o.loggedIn !== 'boolean') throw new Error('shape');
    return {
      loggedIn: o.loggedIn,
      email: typeof o.email === 'string' ? o.email : undefined,
      plan: typeof o.plan === 'string' ? o.plan : undefined
    };
  } catch {
    return { loggedIn: true, email: 'smoke@example.invalid', plan: 'Max' };
  }
};

const writeFakeAuth = (state: FakeAuth): void => {
  const file = fakeAuthPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
};

/**
 * `claude mcp …` — the other pre-stdio branch. Observed shapes are in
 * `docs/reference/cli_state/claude/mcp.md`.
 *
 * **The pty is the point.** The real CLI refuses a piped stdin before binding
 * anything, so the host runs this under `script -q /dev/null`; a login here that
 * simply printed and exited would let a regression in that wrapper pass. So the
 * URL goes out and the process *waits*, exactly as the real one does — and the
 * host has to SIGTERM it, which is what the Cancel case drives.
 */
if (process.argv.includes('mcp')) {
  const sub = process.argv[process.argv.indexOf('mcp') + 1];
  const home = process.env.HOME || os.homedir();
  const hold = path.join(home, '.claude', 'fake-mcp-hold');
  const commandKey = `${sub}:${process.argv[process.argv.indexOf('mcp') + 2] ?? ''}`;
  if (fs.existsSync(hold) && fs.readFileSync(hold, 'utf8') === commandKey) {
    fs.writeFileSync(hold + '.entered', commandKey);
    const deadline = Date.now() + 15_000;
    while (fs.existsSync(hold) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const cachePath = path.join(home, '.claude', 'mcp-needs-auth-cache.json');
  // Which servers this fixture has been told to forget. `mcp logout` clears a
  // keychain entry the fake has none of, so the state it really changes is what
  // the *next* `mcp list` decides — which is the sequence the host drives.
  // One-way on purpose: `login` below never completes, so nothing here can
  // un-forget a name. A scenario that drives a login to `done` has to prune
  // this file as well, or its row comes back still asking to be authorised.
  const forgottenPath = path.join(home, '.claude', 'fake-mcp-forgotten.json');
  const readNames = (file: string): string[] => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? Object.keys(raw) : [];
    } catch {
      return [];
    }
  };
  if (sub === 'list') {
    // Real `mcp list` rewrites the needs-auth cache as it checks each server;
    // the host runs it after a completed login, and after a logout, for exactly
    // that side effect. Union rather than a wipe: a server whose credentials
    // just went is unauthenticated on the very next check.
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const needs: Record<string, { timestamp: number }> = {};
    for (const name of [...readNames(cachePath), ...readNames(forgottenPath)]) {
      needs[name] = { timestamp: 1 };
    }
    fs.writeFileSync(cachePath, JSON.stringify(needs));
    // **`smoke` is deliberately not the fixture's server name (`smoke-mcp`).**
    // The host now parses these verdicts and overlays them on the rows, so a
    // name matching the fixture's would make this hardcoded `✔ Connected`
    // outrank the cache — and `mcp.smoke.ts`'s "exactly the cached-unauthenticated
    // server" assertion would fail pointing at the cache instead of at here.
    // Emit the real name only alongside a marker driven by the same
    // `forgotten`/cache state above, so health and cache agree the way the real
    // CLI makes them agree.
    process.stdout.write('smoke: https://mcp.smoke.test/mcp (HTTP) - ✔ Connected\n');
    process.exit(0);
  }
  if (sub === 'get') {
    const name = process.argv[process.argv.indexOf('mcp') + 2] ?? '';
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      projects?: Record<string, {mcpServers?: Record<string, {url?: string}>}>;
      mcpServers?: Record<string, {url?: string}>;
    };
    const local = config.projects?.[process.cwd().split(path.sep).join('/')]?.mcpServers?.[name];
    const server = local ?? config.mcpServers?.[name];
    if (!server?.url) process.exit(1);
    process.stdout.write(`  Scope: ${local ? 'Local' : 'User'} config\n  URL: ${server.url}\n`);
    process.exit(0);
  }
  if (sub === 'logout') {
    const name = process.argv[process.argv.indexOf('mcp') + 2] ?? 'unknown';
    const forgotten = Object.fromEntries([...readNames(forgottenPath), name].map((n) => [n, true]));
    fs.mkdirSync(path.dirname(forgottenPath), { recursive: true });
    fs.writeFileSync(forgottenPath, JSON.stringify(forgotten));
    // Piped stdin and all: the real one answers here too, which is the whole
    // reason this needs no pty.
    process.stdout.write(`Cleared credentials for "${name}"\n`);
    process.exit(0);
  }
  if (sub === 'login') {
    const name = process.argv[process.argv.indexOf('mcp') + 2] ?? 'unknown';
    if (!process.stdin.isTTY) {
      process.stdout.write("Couldn't complete authentication: stdin isn't a terminal.\n");
      process.exit(1);
    }
    // The cwd-miss sentence, and it exits. The other name waits under the pty;
    // this one is how the cell's error arm is proved to quote the child.
    if (name === 'gone-mcp') {
      process.stdout.write(`No MCP server named "${name}". Configured servers: smoke\n`);
      process.exit(1);
    }
    // OSC-8 wrapper and the PKCE marker, both as a real pty run carries them.
    const url =
      'https://mcp.smoke.test/authorize?response_type=code' +
      '&code_challenge=SMOKEyRhcnRoZXJl&code_challenge_method=S256';
    process.stdout.write(`Starting authentication for "${name}"…\r\n`);
    process.stdout.write('Visit this URL to authorize:\r\n');
    process.stdout.write(`  \x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n`);
    process.stdout.write('\r\nWaiting for authorization… (^C to cancel)\r\n');
    process.on('SIGTERM', () => process.exit(1));
    // Never resolves on its own: the host cancels, or the case ends.
    setInterval(() => {}, 1000);
  } else {
    process.stderr.write(`fake-cli: unknown mcp subcommand ${sub ?? ''}\n`);
    process.exit(2);
  }
} else if (process.argv.includes('auth')) {
  const sub = process.argv[process.argv.indexOf('auth') + 1];
  if (sub === 'status') {
    const state = readFakeAuth();
    const body: Record<string, unknown> = {
      loggedIn: state.loggedIn,
      authMethod: state.loggedIn ? 'claudeai' : 'none',
      apiProvider: 'firstParty'
    };
    if (state.loggedIn && state.email) body.email = state.email;
    if (state.loggedIn && state.plan) body.plan = state.plan;
    process.stdout.write(JSON.stringify(body) + '\n');
    // Real CLI exits 1 when signed out; auth.ts still parses stdout.
    process.exit(state.loggedIn ? 0 : 1);
  }
  if (sub === 'logout') {
    writeFakeAuth({ loggedIn: false });
    process.exit(0);
  }
  if (sub === 'login') {
    // Non-TTY paste-code shape observed 2026-08-09 (CLI 2.1.226), written with
    // the URL split across two chunks: a pipe boundary lands where it likes,
    // and the whole point of `settledPrefix` is that the host still opens one
    // tab at one whole URL. `accounts.smoke.ts` counts the opens.
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(
      "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_"
    );
    setTimeout(() => {
      process.stdout.write('id=fake-smoke\n');
      process.stdout.write('Paste code here if prompted > ');
    }, 40);
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const finish = (code: string | null): void => {
      rl.close();
      if (code && code.trim()) {
        writeFakeAuth({
          loggedIn: true,
          email: 'smoke@example.invalid',
          plan: 'Max'
        });
        process.exit(0);
      }
      process.exit(1);
    };
    rl.on('line', (line) => finish(line));
    process.on('SIGTERM', () => {
      rl.close();
      process.exit(1);
    });
    process.stdin.on('end', () => finish(null));
    // Stay open until a line, cancel, or EOF — do not fall through to stdio.
  } else {
    process.stderr.write(`fake-cli: unknown auth subcommand ${sub ?? ''}\n`);
    process.exit(2);
  }
} else {
  // --- stream-json session (owned smoke / session.test) ----------------------

  /**
   * The id the client pre-assigned, echoed back exactly as the real CLI does —
   * verified 2.1.220: `--session-id` rides the first frame and `init` restates it.
   * A fixture that stated an id of its own would pass while the real thing failed,
   * because `core/live.ts` prefers what `init` says: the pre-assigned id would
   * survive only until the first turn, and anything keyed by it (the workflow
   * progress file) would be seeded at one path and read at another.
   */
  const idFlag = process.argv.includes('--resume') ? '--resume' : '--session-id';
  const assigned = process.argv[process.argv.indexOf(idFlag) + 1];
  let SESSION_ID =
    process.argv.includes(idFlag) && assigned
      ? assigned
      : '11111111-2222-3333-4444-555555555555';
  /**
   * What `init` reports, and what a `set_model` moves.
   *
   * Not a constant, because the real CLI's is not: a `set_model` takes effect on
   * the **next** turn's `init` rather than at once (observed 2.1.220 —
   * `docs/reference/cli_state/claude/protocol.md`), so a fixture that answered `success`
   * and went on reporting the old model would let a client that never applied the
   * change pass.
   */
  let model = 'claude-opus-5';

  const out = (frame: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(frame) + '\n');
  };

  /** The flag without which the real CLI has no ask tool at all. A client that
   *  forgets it should fail here rather than three phases later. */
  if (!process.argv.includes('stdio')) {
    process.stderr.write('missing --permission-prompt-tool stdio\n');
    process.exit(3);
  }

  /**
   * The real CLI emits `session_state_changed` **only** when the child's
   * environment carries `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, so this fixture
   * reads the same var — a stub that emitted them unconditionally would pass with
   * the client's side of the plumbing missing.
   */
  const sessionState = (state: string): void => {
    if (process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) {
      out({ type: 'system', subtype: 'session_state_changed', session_id: SESSION_ID, state });
    }
  };

  const init = () =>
    out({
      type: 'system',
      subtype: 'init',
      cwd: process.cwd(),
      session_id: SESSION_ID,
      tools: ['Bash', 'Write', 'AskUserQuestion'],
      model,
      permissionMode: 'default',
      slash_commands: [],
      // Retained wire shape; folder fixtures in smoke/boot.ts populate the menu.
      skills: [
        'dataviz',
        'ponytail',
        'caveman:caveman',
        'a-skill-with-a-deliberately-very-long-name-to-push-the-menu-wide'
      ],
      claude_code_version: '2.1.220'
    });

  const delta = (text: string) =>
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      session_id: SESSION_ID,
      parent_tool_use_id: null
    });

  let messageNumber = 0;
  const messageStart = (tokens: number) =>
    out({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: `fixture-message-${++messageNumber}`,
          model,
          type: 'message',
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: tokens - 2
          }
        }
      },
      session_id: SESSION_ID,
      parent_tool_use_id: null
    });

  /** A finished turn, or an interrupted one — `aborted_tools` when a permission
   *  request was open, `aborted_streaming` when the reply was. */
  const result = (subtype: 'success' | 'error_during_execution', aborted = 'aborted_tools') => {
    out({
      type: 'result',
      subtype,
      is_error: subtype !== 'success',
      stop_reason: subtype === 'success' ? 'end_turn' : null,
      terminal_reason: subtype === 'success' ? 'completed' : aborted,
      session_id: SESSION_ID,
      total_cost_usd: 0.125,
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 98 },
      modelUsage: {
        [model]: { inputTokens: 2, outputTokens: 4, contextWindow: 1_000_000, costUSD: 0.125 }
      },
      permission_denials: []
    });
    // Just after the result, which is where the real one lands.
    sessionState('idle');
  };

  /**
   * A turn the API refused, as 2.1.289 ends one (protocol.md, "`terminal_reason`
   * on a finished turn…"): a `<synthetic>` assistant frame, then a `result`
   * whose `subtype` still says `success`. Only `terminal_reason` tells it from
   * a finished turn.
   */
  const apiError = (status: 529 | 403) => {
    const [error, text] =
      status === 529
        ? ['server_error', 'API Error: 529 Overloaded.']
        : ['authentication_failed', 'API Error: 403 Forbidden.'];
    out({
      type: 'assistant',
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      error,
      is_api_error_message: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }
    });
    out({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: status,
      stop_reason: 'stop_sequence',
      terminal_reason: 'api_error',
      session_id: SESSION_ID,
      total_cost_usd: 0,
      permission_denials: []
    });
    sessionState('idle');
  };

  const ASK = {
    questions: [
      {
        question: 'Which fruit?',
        header: 'Fruit',
        multiSelect: false,
        options: [{ label: 'Banana' }, { label: 'Apple' }]
      },
      {
        question: 'Which colours?',
        header: 'Colours',
        multiSelect: true,
        options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
      },
      {
        question: 'Which speed?',
        header: 'Speed',
        multiSelect: false,
        options: [{ label: 'Fast' }, { label: 'Slow' }]
      }
    ]
  };

  /** Every request left open, so an interrupt can retract them the way a real one
   *  does — the cancel arrives before the interrupt's own response. A list rather
   *  than a slot because `pending_permission_requests` is plural on the wire, and
   *  a fixture that could only ever hold one would make the two-at-once case
   *  untestable here. */
  const openRequests: string[] = [];
  let holdInterrupt = false;
  /** How long the process outlives its stdin closing: an end the CLI is slow
   *  to take, which is the gap the board's Ending… is drawn across. */
  let eofHoldMs = 0;

  /** One `Write` permission request, named after the file it wants. */
  const writeRequest = (requestId: string, file: string): void => {
    openRequests.push(requestId);
    out({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        display_name: 'Write',
        description: file,
        input: { file_path: `/tmp/${file}`, content: 'hi' },
        tool_use_id: `toolu_${requestId}`,
        permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      }
    });
  };

  /**
   * The keys below are **substrings**, and the text they are matched against is
   * everything a session is sent — not only what a scenario typed. A line the
   * panel composes on its own (`enrich`, `progressBriefing`, `CANCELLED_RUN`)
   * arrives here as an ordinary prompt, so a product string containing one of
   * these words scripts a turn nobody asked for: `write` cost a whole smoke run
   * once, opening a permission dialog whose `#scrim` wedged every scenario after
   * it. Check a new one against this list before sending it.
   */
  function turn(text: string): void {
    const tool = nativeTool(text, { CLAUDE_CODE_SESSION_ID: SESSION_ID, CLAUDE_PID: String(process.pid) });
    if (tool) {
      init();
      void tool.then(() => result('success'));
      return;
    }
    if (text === 'conversation-reset-probe') {
      out({ type: 'conversation_reset', session_id: SESSION_ID });
      SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    }
    holdInterrupt = text.includes('delayed-interrupt');
    if (text.includes('eof-hold')) eofHoldMs = 3000;
    sessionState('running');
    init();
    messageStart(100);
    if (text.includes('quota-push')) {
      // 2.1.309's shape: `unifiedWindows` utilization is a fraction, and the
      // figures differ from `get_usage`'s 3/47 so a scenario can tell them apart.
      const now = Math.floor(Date.now() / 1000);
      out({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: now + 5 * 3600,
          rateLimitType: 'five_hour',
          unifiedWindows: {
            five_hour: { utilization: 0.11, resetsAt: now + 5 * 3600 },
            seven_day: { utilization: 0.62, resetsAt: now + 7 * 24 * 3600 }
          }
        },
        uuid: 'fixture-rate-limit',
        session_id: SESSION_ID
      });
    }
    if (text === 'transcript-refresh-churn') {
      const signal = path.join(os.homedir(), '.squadron', 'refresh-churn-complete');
      let ticks = 0;
      const stop = setInterval(() => {
        if (!fs.existsSync(signal)) return;
        clearInterval(timer);
        clearInterval(stop);
        result('success');
      }, 50);
      const timer = setInterval(() => {
        out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: SESSION_ID,
          model: `fixture-churn-${++ticks}`, permissionMode: 'default', tools: [] });
        if (ticks < 8000) return;
        clearInterval(timer);
        clearInterval(stop);
        result('success');
      }, 1);
      return;
    }
    if (text === 'transcript-refresh-benchmark') {
      let chunk = 0;
      let body = '';
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' } }, session_id: SESSION_ID, parent_tool_use_id: null });
      const timer = setInterval(() => {
        const part = `Chunk ${++chunk}. ${'fixture prose '.repeat(24)}\n\n`;
        body += part;
        fs.appendFileSync(path.join(os.homedir(), '.squadron', 'refresh-fixture.jsonl'),
          JSON.stringify({ chunk, at: Date.now() }) + '\n');
        delta(part);
        if (chunk < 48) return;
        clearInterval(timer);
        out({ type: 'assistant', session_id: SESSION_ID, parent_tool_use_id: null,
          message: { id: `fixture-message-${messageNumber}`, role: 'assistant',
            content: [{ type: 'text', text: body }] } });
        result('success');
      }, 250);
      return;
    }
    if (text === 'pagination-stream') {
      let chunk = 0;
      let body = '';
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' } }, session_id: SESSION_ID, parent_tool_use_id: null });
      const timer = setInterval(() => {
        const part = `Page stream ${++chunk}. ${'live prose '.repeat(12)}\n\n`;
        body += part;
        delta(part);
        if (chunk < 20) return;
        clearInterval(timer);
        out({ type: 'assistant', session_id: SESSION_ID, parent_tool_use_id: null,
          message: { id: `fixture-message-${messageNumber}`, role: 'assistant',
            content: [{ type: 'text', text: body }] } });
        result('success');
      }, 250);
      return;
    }
    if (text === 'thread-acquisition') {
      const signal = path.join(os.homedir(), '.squadron', 'thread-acquisition');
      let grown = false;
      out({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        },
        session_id: SESSION_ID,
        parent_tool_use_id: null
      });
      delta('Acquired from memory.');
      const timer = setInterval(() => {
        let phase = '';
        try {
          phase = fs.readFileSync(signal, 'utf8');
        } catch {
          return;
        }
        if (phase === 'grow' && !grown) {
          grown = true;
          delta(' Still here after another delta.');
        }
        if (phase === 'complete' && grown) {
          clearInterval(timer);
          out({
            type: 'assistant',
            session_id: SESSION_ID,
            parent_tool_use_id: null,
            message: {
              id: `fixture-message-${messageNumber}`,
              role: 'assistant',
              content: [{ type: 'text', text: 'Acquired from memory. Still here after another delta.' }]
            }
          });
          result('success');
        }
      }, 50);
      return;
    }
    // A tool's dev server: a real child of this process, holding a real port.
    const serving = /serve-port-(\d+)/.exec(text)?.[1];
    if (serving !== undefined) {
      cp.spawn(process.execPath, ['-e', `require('net').createServer().listen(${serving})`], {
        stdio: 'ignore',
        windowsHide: true
      });
    }
    if (text.includes('execution-window-smoke-')) {
      const label = text.includes('execution-window-smoke-on') ? 'on' : 'off';
      const id = `execution-${label}`;
      const position = process.argv.indexOf('--settings');
      const settings = JSON.parse(position < 0 ? '{}' : process.argv[position + 1] ?? '{}') as {
        hooks?: Record<string, { hooks: { command: string }[] }[]>;
      };
      // Claude runs a hook with no `shell` in bash: Git Bash on Windows (2.1.296).
      const sh = fs.existsSync('/bin/sh')
        ? '/bin/sh'
        : (process.env.CLAUDE_CODE_GIT_BASH_PATH ?? 'C:\\Program Files\\Git\\bin\\bash.exe');
      const hook = (event: string): void => {
        for (const group of settings.hooks?.[event] ?? []) for (const command of group.hooks) {
          cp.spawnSync(sh, ['-c', command.command], {
            input: JSON.stringify({ hook_event_name: event, session_id: SESSION_ID, cwd: process.cwd(), tool_name: 'Bash', tool_use_id: id, prompt_id: id }),
            env: process.env, encoding: 'utf8', timeout: 10_000
          });
        }
      };
      out({ type: 'assistant', session_id: SESSION_ID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'fixture shell write' } }] } });
      hook('PreToolUse');
      fs.writeFileSync(path.join(process.cwd(), `execution-${label}-owned.txt`), 'owned\n');
      hook('PostToolUse');
      out({ type: 'user', session_id: SESSION_ID, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } });
      fs.writeFileSync(path.join(process.cwd(), `execution-${label}-gap.txt`), 'editor gap\n');
      delta('Execution capture fixture complete.');
      result('success');
      return;
    }
    if (text.includes('ask')) {
      delta('Before I answer, ');
      openRequests.push('req-ask');
      out({
        type: 'control_request',
        request_id: 'req-ask',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: ASK,
          tool_use_id: 'toolu_ask',
          requires_user_interaction: true
        }
      });
      return;
    }
    // Two in one turn, before the single case, so `two writes` is not read as one.
    // The real model batches its tool calls into separate messages, so this is
    // opportunistic there and deliberate here.
    if (text.includes('two')) {
      writeRequest('req-a', 'a.txt');
      writeRequest('req-b', 'b.txt');
      return;
    }
    if (text.includes('write')) {
      writeRequest('req-write', 'notes.txt');
      return;
    }
    if (text.includes('held-tool')) {
      delta('working');
      out({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_held',
            name: 'Bash',
            input: { command: 'sleep 3600' }
          }
        },
        session_id: SESSION_ID,
        parent_tool_use_id: null
      });
      return;
    }
    if (text.includes('slow')) {
      delta('working');
      return;
    }
    // Open for longer than the panel's trailing owned refresh (`OWNED_MS`,
    // 1000ms) can miss under load, so the busy paint is there to be read.
    if (text.includes('linger')) {
      delta('working');
      setTimeout(() => result('success'), 4000);
      return;
    }
    if (text.includes('api-529') || text.includes('api-403')) {
      apiError(text.includes('api-529') ? 529 : 403);
      return;
    }
    // Retries keep the turn `running`; only the last attempt ends it. Spaced so
    // a test can hold a message while the turn is still open.
    if (text.includes('api-retry')) {
      const retry = (attempt: number) =>
        out({
          type: 'system',
          subtype: 'api_retry',
          session_id: SESSION_ID,
          attempt,
          max_retries: 2,
          retry_delay_ms: 150,
          error_status: 529,
          error: 'overloaded'
        });
      retry(1);
      setTimeout(() => {
        retry(2);
        setTimeout(() => apiError(529), 150);
      }, 150);
      return;
    }
    // A turn whose `result` goes missing — the shape that latched five cards on
    // BUSY. Only the state event says it ended.
    if (text.includes('quiet')) {
      delta('done, quietly');
      sessionState('idle');
      return;
    }
    // What the child's environment actually holds for the fan-out, which is the
    // one thing about a spawn no frame states. Read here rather than asserted on
    // the parent's `process.env`, for the reason `sessionState` above is: the
    // claim is about the environment the *child* was given.
    // A reply tall enough to overflow the dock's thread, which is the only
    // state a reader can keep a place in. Paragraphs rather than one block: the
    // markdown engine collapses single newlines, and height is the whole point.
    //
    // Unended so the geometry cases can measure a streaming reply, then
    // interrupt it when their measurements finish.
    if (text.includes('spool')) {
      for (let line = 0; line < 40; line++) {
        delta(`Line ${line} of an answer long enough to fill the box.\n\n`);
      }
      return;
    }
    if (text.includes('whoami')) {
      // The list the scrub deletes, so a brand added to it is echoed with no edit.
      const ids = IDENTITY_NAMES.map((name) => `${name}=${process.env[name] ?? 'unset'}`).join(' ');
      delta(`whoami ${ids}`);
    }
    if (text.includes('origin')) {
      delta(`origin=${process.env.SQUADRON_LINEAGE_ORIGIN ?? 'unset'}`);
      result('success');
      return;
    }
    if (text.includes('entrypoint')) {
      delta(`entrypoint=${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unset'}`);
      result('success');
      return;
    }
    // Echoed rather than canned, so a test can read what the client actually
    // sent — the text, and how many image blocks rode with it.
    out({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      session_id: SESSION_ID,
      parent_tool_use_id: null
    });
    delta(text);
    out({
      type: 'assistant',
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        id: `fixture-message-${messageNumber}`,
        role: 'assistant',
        content: [{ type: 'text', text }]
      }
    });
    result('success');
  }

  function control(frame: Record<string, unknown>): void {
    const requestId = String(frame.request_id);
    const request = (frame.request ?? {}) as { subtype?: string };
    if (request.subtype === 'interrupt') {
      if (holdInterrupt) {
        holdInterrupt = false;
        const signal = path.join(os.homedir(), '.squadron', `interrupt-${SESSION_ID}`);
        fs.writeFileSync(signal, 'held');
        const timer = setInterval(() => {
          if (fs.readFileSync(signal, 'utf8') !== 'release') return;
          clearInterval(timer);
          control(frame);
        }, 50);
        return;
      }
      const aborted = openRequests.length ? 'aborted_tools' : 'aborted_streaming';
      for (const open of openRequests.splice(0)) {
        out({ type: 'control_cancel_request', request_id: open });
      }
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { still_queued: ['later'] }
        }
      });
      result('error_during_execution', aborted);
      return;
    }
    if (request.subtype === 'get_usage') {
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            subscription_type: 'max',
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 3, resets_at: new Date(Date.now() + 5 * 60 * 60_000).toISOString() },
              seven_day: { utilization: 47, resets_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString() },
              seven_day_opus: null
            }
          }
        }
      });
      return;
    }
    // Copied from a real answer (2026-08-04, 2.1.220), trimmed to four rows and
    // keeping every one of the CLI's own spellings — `value`, `resolvedModel`,
    // `displayName`. The `default` row is here because dropping it is the reader's
    // job, and a fixture without one could not prove that happens. Fable's row is
    // the awkward one and is kept for it: its `value` is a full id with a context
    // suffix while its `resolvedModel` is shorter, so neither field can be
    // derived from the other.
    /**
     * A model change, answered the way the real one is: `success`, an echo on a
     * `user` frame, and no `result` — it is not a turn. The new model shows up on
     * the **next** `init`, not on this response.
     *
     * The missing-model case is the one worth carrying. The real CLI answers
     * `success` to a `set_model` with no `model` field and silently resets the
     * session to the configured default, so a fixture that refused it would make
     * the client's guard look load-bearing when nothing was testing it.
     */
    if (request.subtype === 'set_model') {
      const want = (request as { model?: string }).model;
      model = typeof want === 'string' && want ? want : 'claude-opus-5';
      out({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId }
      });
      out({
        type: 'user',
        message: {
          role: 'user',
          content: `<local-command-stdout>Set model to ${model}</local-command-stdout>`
        },
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        isReplay: true
      });
      return;
    }
    /**
     * The one round trip that gives a print-mode session a name. The client
     * asks on the first running turn, and a fixture that refused it would send
     * the client back round the retry it keeps for a transient refusal — once
     * per frame of a turn that never ends.
     */
    if (request.subtype === 'generate_session_title') {
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { title: 'A fake title' }
        }
      });
      return;
    }
    if (request.subtype === 'list_models') {
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            models: [
              {
                value: 'default',
                resolvedModel: 'claude-opus-5[1m]',
                displayName: 'Default (recommended)',
                description: 'Opus 5 with 1M context',
                supportsEffort: true
              },
              {
                value: 'opus[1m]',
                resolvedModel: 'claude-opus-5[1m]',
                displayName: 'Opus (1M context)',
                description: 'Opus 5 with 1M context',
                supportsEffort: true
              },
              {
                value: 'claude-fable-5[1m]',
                resolvedModel: 'claude-fable-5',
                displayName: 'Fable',
                description: 'Fable 5',
                supportsEffort: true
              },
              {
                value: 'haiku',
                resolvedModel: 'claude-haiku-4-5-20251001',
                displayName: 'Haiku',
                description: 'Haiku 4.5 · Fastest for quick answers'
              },
              // A row the CLI lists to say it cannot run it, copied verbatim
              // from 2.1.241 on 2026-09-02 — the day 2.1.257 shipped Fable 5.1
              // and every binary below 2.1.255 started advertising this instead
              // of it. `value` names no model, so it has to be dropped, and a
              // fixture without one could not prove that happens.
              {
                value: 'cc-update-required-1',
                resolvedModel: 'cc-update-required-1',
                displayName: 'Fable 5.1 (disabled)',
                description: 'Update to 2.1.255+ to use Fable 5.1',
                supportsEffort: true,
                disabled: true
              }
            ]
          }
        }
      });
      return;
    }
    out({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: `unknown subtype` }
    });
  }

  function receive(line: string): boolean {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write('unparseable line\n');
      return false;
    }
    if (frame.type === 'user') {
      const message = (frame.message ?? {}) as { content?: unknown };
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks
        .map((b) => (b as { text?: unknown }).text)
        .filter((t): t is string => typeof t === 'string')
        .join(' ');
      const images = blocks.filter((b) => (b as { type?: unknown }).type === 'image').length;
      turn(images ? `${text} [${images} image]` : text);
    } else if (frame.type === 'control_request') {
      control(frame);
    } else if (frame.type === 'control_response') {
      // Echoed as the session's own words, so a test can read exactly what the
      // client put on the wire.
      const answered = (frame.response ?? {}) as { request_id?: unknown };
      const at = openRequests.indexOf(String(answered.request_id));
      if (at !== -1) {
        openRequests.splice(at, 1);
      }
      delta('RESPONSE ' + JSON.stringify(frame.response));
      // The turn ends when nothing is still blocking it. Answering one of two
      // leaves the other open, which is what the real CLI does — its tool runs
      // and the turn carries on waiting.
      if (!openRequests.length) {
        result('success');
      }
    }
    return frame.type === 'user';
  }

  const closedInput = path.join(os.homedir(), '.squadron', 'fake-closed-input');
  if (fs.existsSync(closedInput)) {
    // Node 24/libuv aborts if fd 0 is closed after a stream watcher owns it
    // (observed 2026-10-27). This fixture reads one prompt before creating one.
    const byte = Buffer.alloc(1);
    const line: number[] = [];
    while (fs.readSync(0, byte, 0, 1, null) === 1) {
      if (byte[0] !== 10) {
        line.push(byte[0]!);
        continue;
      }
      const prompted = receive(Buffer.from(line).toString('utf8'));
      line.length = 0;
      if (prompted) {
        const closing = setInterval(() => {
          let action = '';
          try {
            action = fs.readFileSync(closedInput, 'utf8');
          } catch {
            return;
          }
          if (action !== 'close') return;
          clearInterval(closing);
          fs.closeSync(0);
          fs.writeFileSync(closedInput, 'closed');
        }, 20);
        setInterval(() => {}, 1_000);
        break;
      }
    }
  } else {
    createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', receive);

  // Stdin EOF is what ends a stream-json session, and the only ending the real
  // CLI guarantees — the extension host dying closes this pipe whether or not
  // anything got to run a cleanup.
    process.stdin.on('end', () => setTimeout(() => process.exit(0), eofHoldMs));
  }
} // end non-auth (stream-json) branch
