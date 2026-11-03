/**
 * A Grok-shaped ACP peer that costs nothing: JSON-RPC on stdin, canned
 * replies on stdout.
 *
 * Handshake and stream shapes from `docs/reference/cli_state/grok/protocol.md` (1.0.4).
 * What a turn does is chosen by the prompt text:
 *
 * | Text | What comes back |
 * | --- | --- |
 * | `slow` | `working`, one thought chunk, then waits for `session/cancel` |
 * | `hang-busy` | same as `slow`, but `session/cancel` is ignored — a latched busy |
 * | `ask` | `_x.ai/ask_user_question` id 0; `session/prompt` waits for `accepted` |
 * | `ask-empty` | same method, empty-options question; client should fail the RPC |
 * | `perm` | `session/request_permission` id 1; waits for selected optionId |
 * | `perm-once` | same, options are once/reject only (leftover bash shape) |
 * | `perm-empty` | same method, no options; client should fail the RPC |
 * | `self-started` | ends normally, then Grok wakes itself: a turn with no `session/prompt`, closed by `turn_completed` |
 * | `self-started-nofinish` | the same wake with **no** `turn_completed` — the latch, reproduced |
 * | `self-started-noqueue` | a wake that announces itself on no `queue/changed` at all, closed normally |
 * | `self-started-paced` | the same wake, held open until a prompt is staged behind it — then it closes and answers it |
 * | `late-rebusy` | answers, then a stray `tool_call` re-busies the card — a latch on a turn of *ours* |
 * | `late-rebusy-lost` | the same, but *our* turn's `turn_completed` and queue clear are both lost |
 * | `silent-completion` | the prompt result alone, with no state-changing notification |
 * | a ping (`<squadron-warm>`) | `pong`, unless `SQUADRON_FAKE_ACP_WARM` names one of the words above to run instead |
 * | any image part | `working`, `"saw-N-image"` as chunks, `idle`, `end_turn` |
 * | anything else | `working`, `"pong"` as chunks, `idle`, `end_turn` |
 *
 * A reply is streamed as several `agent_message_chunk` notifications, because
 * the real wire streams tokens — see `stream()`.
 *
 * Not a `*.test.ts`. Spawned by `grok.test.ts` through `childTransport`.
 */

import { nativeTool } from './native_tool';
import { createInterface } from 'readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logEnvironment } from './env_log';

logEnvironment();

/** `g1`, unless a test running several sessions at once names each its own,
 *  as the real CLI mints one per `session/new`. */
const SESSION_ID = process.env.SQUADRON_FAKE_ACP_SESSION_ID || 'g1';

// The gear's model list is still Claude's. A leaked Opus id on `-m` is how a
// Grok start died before a card appeared; refuse so smoke sees it.
const modelAt = process.argv.indexOf('-m');
if (modelAt >= 0) {
  const id = process.argv[modelAt + 1] ?? '';
  if (!id.startsWith('grok')) {
    process.stderr.write(`unknown model: ${id}\n`);
    process.exit(2);
  }
}

function write(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function notify(method: string, params: unknown): void {
  write({ jsonrpc: '2.0', method, params });
}

function sessionUpdate(update: Record<string, unknown>): void {
  notify('session/update', { sessionId: SESSION_ID, update });
}

function result(id: unknown, value: unknown): void {
  write({ jsonrpc: '2.0', id, result: value });
}

let promptId: unknown;
/** When set, `session/cancel` does not finish the in-flight prompt. The
 *  adapter latch: `running` stays true because nothing on the wire idles
 *  us, not because the CLI already wrote `turn_ended`. */
let ignoreCancel = false;
/** 0-based, and it does not restart: probed against the real CLI across a
 *  `session/load` (2026-08-20, 1.0.5). */
let promptIndex = 0;
let sessionCwd = '/tmp/project';
let reasoningEffort = 'high';
let currentModel = 'grok-4.7';

/** grok-4.5 offers no `xhigh` (protocol.md, 1.0.40 and 1.0.50). The others do. */
const MODEL_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  'grok-4.5': ['high', 'medium', 'low']
};
const ALL_EFFORTS = ['xhigh', 'high', 'medium', 'low'] as const;

function effortsFor(model: string): readonly string[] {
  return MODEL_EFFORTS[model] ?? ALL_EFFORTS;
}

const configOptions = () => [
  {
    id: 'reasoning_effort',
    currentValue: reasoningEffort,
    options: effortsFor(currentModel).map((value) => ({ value }))
  }
];

/** One JSON line per request, when a test names the file. The transcript
 *  record shows prompts, not which RPC ran before them. */
function noteRequest(method: string, params: unknown): void {
  const file = process.env.SQUADRON_FAKE_ACP_REQUESTS;
  if (!file) return;
  fs.appendFileSync(file, JSON.stringify({ method, params }) + '\n');
}
/** Server→client ask id. Held until the client replies `outcome: accepted`. */
const ASK_ID = 0;
let askOpen = false;
/** Distinct from ASK_ID — a live permission capture is also id 0, but the
 *  fake must not treat an ask reply as a permission reply. */
const PERM_ID = 1;
let permOpen = false;

const ASK_PARAMS = {
  sessionId: SESSION_ID,
  toolCallId: 'call-ask-1',
  questions: [
    {
      question: 'Which route should we take?',
      options: [
        { label: 'Left', description: 'go left' },
        { label: 'Right', description: 'go right' }
      ],
      multiSelect: false
    },
    {
      question: 'Which pace?',
      options: [{ label: 'Slow' }, { label: 'Steady' }, { label: 'Fast' }],
      multiSelect: true
    }
  ],
  mode: 'default'
};

const PERM_PARAMS = {
  sessionId: SESSION_ID,
  toolCall: {
    toolCallId: 'call-write-1',
    kind: 'edit',
    title: 'Write `/tmp/probe-write.txt`',
    rawInput: { variant: 'Write', file_path: '/tmp/probe-write.txt', content: 'hello\n' }
  },
  options: [
    {
      optionId: 'allow-edits-session',
      name: 'Yes, allow all edits during this session',
      kind: 'allow_always'
    },
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    {
      optionId: 'reject-once',
      name: 'No, and tell Grok what to do differently',
      kind: 'reject_once'
    }
  ]
};

type Echoed = { type: 'text'; text: string } | { type: 'image' };

function runPrompt(
  id: unknown,
  text: string,
  images = 0,
  ourId?: string,
  echoed: readonly Echoed[] = []
): void {
  // A ping's words are the product's own and script nothing, so a case that
  // needs one to misbehave names the behaviour here instead.
  const script =
    text.includes('<squadron-warm>') && process.env.SQUADRON_FAKE_ACP_WARM
      ? process.env.SQUADRON_FAKE_ACP_WARM
      : text;
  if (promptId !== undefined && promptId !== id) {
    result(promptId, { stopReason: 'cancelled' });
  }
  promptId = id;
  const tool = nativeTool(text, { GROK_SESSION_ID: SESSION_ID, GROK_AGENT: '1' });
  if (tool) {
    void tool.then(() => finish('end_turn'));
    return;
  }
  ignoreCancel = script.includes('hang-busy');
  if (script.includes('silent-completion')) {
    result(id, { stopReason: 'end_turn' });
    promptId = undefined;
    return;
  }
  // The queue names the running turn, and echoes the `_meta.promptId` we were
  // sent (1.0.5 probe, 2026-08-25). This is how the client tells its own turn
  // from one Grok started — so a fake that never echoed would make every turn
  // look foreign and hide the distinction the drain gate rests on.
  //
  // Named either way, because 1.0.5 mints its own id when the client sends
  // none ("the mint is a fallback, not the rule"). Staying silent without
  // `_meta` would let the adapter drop `_meta.promptId` and stay green — every
  // turn would then read as ours-by-absence rather than as foreign.
  turnWireId = ourId ?? `grok-minted-${String(promptIndex)}`;
  notify('_x.ai/queue/changed', {
    sessionId: SESSION_ID,
    entries: [],
    runningPromptId: turnWireId
  });
  wakeAfter = script.includes('self-started')
    ? script.includes('nofinish')
      ? 'open'
      : script.includes('noqueue')
        ? 'silent'
        : 'closed'
    : undefined;
  // **The paced wake closes on the staged prompt, not on a clock.** A timer
  // makes the smoke scenario's central claim untestable: a real panel takes
  // an unknown time to get a keystroke to the host, so a fixed wake may be
  // over before the message is staged, and the message then drains for the
  // ordinary reason with the gate shut. Closing on arrival means the wake
  // ends *because* the drain wrote through it — and if the drain never
  // writes, the wake never closes and the card never idles, which is the
  // failure the scenario is there to catch. Not spelled `-slow`: `slow` is a
  // trigger of its own above and returns before `finish`.
  wakeOnPrompt = script.includes('self-started-paced');
  // Grok echoes the prompt back before it answers, and `_meta.promptIndex` is
  // on the echo — the witness our record stamps and `chat_history.jsonl`'s
  // `prompt_index` is compared against. At the top rather than on the pong
  // path, because live emits it whatever the turn goes on to do.
  // One chunk per prompt block, in order and all under one ordinal: 1.0.46
  // writes a prompt of several blocks to `updates.jsonl` that way (probe
  // 2026-10-04, `TASK_*_peer_message_blocks.md`). A prompt of one block is one
  // chunk, as it always was.
  const index = promptIndex++;
  const chunk = (content: Record<string, unknown>) => ({
    sessionUpdate: 'user_message_chunk',
    content,
    _meta: { modelId: currentModel, promptIndex: index }
  });
  const userUpdates =
    echoed.length > 1
      ? echoed.map((block) =>
          chunk(
            block.type === 'image'
              ? { type: 'image', data: 'iVBOR', mimeType: 'image/png' }
              : { type: 'text', text: block.text }
          )
        )
      : [
          chunk(
            images && !text
              ? { type: 'image', data: 'iVBOR', mimeType: 'image/png' }
              : { type: 'text', text }
          )
        ];
  if (script.includes('no-user-echo') || process.env.SQUADRON_FAKE_ACP_NO_USER_ECHO === '1') {
    const writeEcho = (): void => {
      const dir = path.join(
        os.homedir(),
        '.grok',
        'sessions',
        encodeURIComponent(sessionCwd),
        SESSION_ID
      );
      fs.mkdirSync(dir, { recursive: true });
      const at = Number(process.env.SQUADRON_FAKE_ACP_ECHO_AT_MS ?? Date.now());
      fs.appendFileSync(
        path.join(dir, 'updates.jsonl'),
        userUpdates
          .map(
            (update) =>
              JSON.stringify({
                timestamp: Math.floor(at / 1_000),
                method: 'session/update',
                params: { sessionId: SESSION_ID, update, _meta: { agentTimestampMs: at } }
              }) + '\n'
          )
          .join('')
      );
    };
    const delay = Number(process.env.SQUADRON_FAKE_ACP_DELAY_USER_ECHO_MS ?? 0);
    if (delay > 0) setTimeout(writeEcho, delay);
    else writeEcho();
  } else {
    for (const update of userUpdates) sessionUpdate(update);
  }
  notify('_x.ai/sessions/changed', {
    sessions: [{ sessionId: SESSION_ID, activity: 'working', modelId: currentModel }]
  });
  // Another session going idle must not end this turn (roster is machine-wide).
  notify('_x.ai/sessions/changed', {
    sessions: [{ sessionId: 'other', activity: 'idle' }]
  });
  if (script.includes('slow') || script.includes('hang-busy')) {
    sessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'counting' }
    });
    return;
  }
  if (script.includes('perm-empty')) {
    permOpen = true;
    write({
      jsonrpc: '2.0',
      id: PERM_ID,
      method: 'session/request_permission',
      params: { sessionId: SESSION_ID, toolCall: { kind: 'edit' }, options: [] }
    });
    return;
  }
  if (script.includes('perm-once')) {
    permOpen = true;
    write({
      jsonrpc: '2.0',
      id: PERM_ID,
      method: 'session/request_permission',
      params: {
        ...PERM_PARAMS,
        toolCall: {
          kind: 'execute',
          title: 'cd "$(pwd)" && echo hi',
          rawInput: { variant: 'run_terminal_command', command: 'cd "$(pwd)" && echo hi' }
        },
        options: PERM_PARAMS.options.filter((o) => o.optionId !== 'allow-edits-session')
      }
    });
    return;
  }
  if (/\bperm\b/.test(script)) {
    permOpen = true;
    sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: PERM_PARAMS.toolCall.toolCallId,
      title: PERM_PARAMS.toolCall.title,
      rawInput: PERM_PARAMS.toolCall.rawInput
    });
    write({
      jsonrpc: '2.0',
      id: PERM_ID,
      method: 'session/request_permission',
      params: PERM_PARAMS
    });
    return;
  }
  if (script.includes('ask-empty')) {
    askOpen = true;
    write({
      jsonrpc: '2.0',
      id: ASK_ID,
      method: '_x.ai/ask_user_question',
      params: { sessionId: SESSION_ID, questions: [{ question: 'Empty', options: [] }] }
    });
    return;
  }
  if (script.includes('ask')) {
    askOpen = true;
    // An ask **is** a tool call on this wire: the model emits the `tool_call`
    // and ACP raises `_x.ai/ask_user_question` for it (protocol.md § Ask arms,
    // "the model emitted both `tool_call`s together"). Emitted here because the
    // record files the answer against that call, and a fake that skipped it hid
    // the ordering bug the peer review of 2026-08-20 found.
    sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: ASK_PARAMS.toolCallId,
      title: 'ask_user_question',
      rawInput: { questions: ASK_PARAMS.questions }
    });
    write({
      jsonrpc: '2.0',
      id: ASK_ID,
      method: '_x.ai/ask_user_question',
      params: ASK_PARAMS
    });
    return;
  }
  // A turn of **ours** that the CLI leaves running: the result lands, then a
  // stray frame re-busies the card. This is the predecessor's "competing
  // latch", and it is deliberately *not* what this fix rescues — the drain
  // gate must still refuse, because we started this turn. `sendNow` is the
  // way out of it and another file's job to improve.
  turnFramesLost = script.includes('late-rebusy-lost');
  if (script.includes('late-rebusy')) {
    finish('end_turn', 'pong');
    setTimeout(() => {
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-late-1',
        title: 'late-work',
        rawInput: { variant: 'run_terminal_command', command: 'sleep 1' }
      });
    }, 40);
    return;
  }
  finish('end_turn', images > 0 ? `saw-${images}-image` : 'pong');
}

/**
 * A reply, in more than one chunk — because a chunk on this wire is a token.
 *
 * Measured 2026-08-22 (grok-4.6, session `01a02588`): a 68-character reply
 * arrived as 14 `agent_message_chunk` notifications of a word or two, while the
 * CLI's own `updates.jsonl` wrote it as one. `cli_state/grok/protocol.md` § A
 * chunk is a token carries the reading and what it cost — a fake that emitted a
 * message per chunk let a reader which kept only the last chunk stay green.
 *
 * Halves rather than real tokens: two is the whole difference between a reader
 * that joins deltas and one that does not, and it keeps a failure legible.
 */
function stream(text: string): void {
  const cut = Math.floor(text.length / 2);
  for (const part of [text.slice(0, cut), text.slice(cut)]) {
    if (part) {
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: part }
      });
    }
  }
}

function finish(stopReason: string, text?: string): void {
  if (promptId === undefined) {
    return;
  }
  if (text !== undefined) {
    stream(text);
  }
  notify('_x.ai/sessions/changed', {
    sessions: [{ sessionId: SESSION_ID, activity: 'idle' }]
  });
  // Our own turn closes its queue entry; a wake's never does (see `wake`).
  //
  // `late-rebusy-lost` withholds that clear **and** `turn_completed`, closing
  // our turn on the RPC result alone. That is this whole file's own premise
  // — a `turn_completed` that never arrives — applied to a turn of *ours*,
  // and it is the case the ours-vs-theirs test defends: nothing is left to
  // clear the queue's running id, so a client that could not recognise its
  // own id would call its own turn foreign and open the drain gate on it.
  if (!turnFramesLost) {
    notify('_x.ai/queue/changed', { sessionId: SESSION_ID, entries: [] });
  }
  // **1.0.5 emits this for a turn we sent as well as for a wake**, ~1-8 ms
  // ahead of the RPC result (protocol.md § Order, and § The one thing that
  // does close it). The fixture used to omit it, which meant the only
  // `turn-end` it could produce while a drain was in flight was a wake's — so
  // nothing could see `closesSomeoneElsesTurn` swallow one of *ours* by
  // mistake, which is the axis the re-review found it untested on.
  if (!turnFramesLost) {
    sessionUpdate({
      sessionUpdate: 'turn_completed',
      prompt_id: turnWireId,
      stop_reason: stopReason
    });
  }
  result(promptId, { stopReason });
  promptId = undefined;
  const pending = wakeAfter;
  wakeAfter = undefined;
  if (pending) {
    setTimeout(() => wake(pending !== 'open', pending !== 'silent'), 5);
  }
}

/** Set by a `self-started*` prompt, fired once that prompt has closed.
 *  `silent` is a wake that announces itself on no `queue/changed` at all —
 *  the monitor/hook shape, where nothing on the wire names the running turn. */
let wakeAfter: 'closed' | 'open' | 'silent' | undefined;

/** True while a wake is genuinely running, so a prompt arriving now is queued
 *  behind it rather than answered beside it. Grok runs an ordered queue per
 *  session and `runningPromptId` names the head (probe 2026-08-25). */
let wakeRunning = false;
/** In order, like the CLI's own per-session queue — not one slot. A fixture
 *  that dropped the displaced request would hang the client's `writePending`
 *  on an id nothing ever answers, which is the opposite of what it is here
 *  to model. */
const heldPrompts: {
  id: unknown;
  text: string;
  images: number;
  ourId?: string;
  echoed: Echoed[];
}[] = [];
/** The id this turn is running under on the wire — ours when we were sent one,
 *  the CLI's mint when we were not. `turn_completed` echoes it. */
let turnWireId = '';
/** Paced wake: stay open until something is queued behind it. */
let wakeOnPrompt = false;
/** `late-rebusy-lost` only: close this turn on the RPC result alone, leaving
 *  the queue still naming it and emitting no `turn_completed`. */
let turnFramesLost = false;

/**
 * A turn Grok starts itself, as 1.0.5 emits one (probe 2026-08-25,
 * `cli_state/grok/protocol.md` § Closing a self-started turn).
 *
 * Faithful in the three ways that matter, all of them asymmetries against a
 * turn we sent: **no** `session/prompt` of ours to resolve, **no** roster
 * frame at either edge, and a `_x.ai/queue/changed` that opens with a
 * synthetic `runningPromptId` and never emits a closing one. So
 * `turn_completed` is the only thing that can end it — and `closed: false`
 * withholds exactly that, which is the whole latch in one frame.
 */
function wake(closed: boolean, announced = true): void {
  const taskId = 'task-completed-01a0387b-982a-7492-8cd6-73d48fbf26d1';
  // **Only a wake that will close holds the agent.** `closed: false` models
  // the latch as it really is — the CLI finished and our client never heard
  // the frame — so Grok is idle and answers the next prompt at once. A fake
  // that kept the agent busy there would be modelling a hung CLI, a different
  // bug, and would make the recovery it is meant to prove unprovable.
  wakeRunning = closed;
  // `announced: false` is the monitor/hook shape: a wake that names its turn
  // nowhere. Nothing can then tell the client the running turn is not one it
  // sent, so only `turn_completed` can end it.
  if (announced) {
    notify('_x.ai/queue/changed', {
      sessionId: SESSION_ID,
      entries: [],
      runningPromptId: taskId,
      runningText:
        '<system-reminder>\nBackground task completed (exit code: 0).\n</system-reminder>'
    });
  }
  sessionUpdate({
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      text: '<system-reminder>\nBackground task completed.\n</system-reminder>'
    }
  });
  sessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'woke' }
  });
  // On its own tick, not in the same stdout chunk as the text above. Live put
  // ~5 s of model call between them; back-to-back here let a client that never
  // re-drains still look green, because the turn had already closed by the time
  // a test's `await` resumed and queued anything.
  if (closed && !wakeOnPrompt) {
    setTimeout(closeWake, 60);
  }
}

/** End the wake, then start whatever was queued behind it — the order
 *  protocol.md records at § The one thing that does close it. */
function closeWake(): void {
  if (!wakeRunning) {
    return;
  }
  wakeRunning = false;
  sessionUpdate({
    sessionUpdate: 'turn_completed',
    prompt_id: 'task-completed-01a0387b-982a-7492-8cd6-73d48fbf26d1',
    stop_reason: 'end_turn'
  });
  const held = heldPrompts.shift();
  if (held) {
    runPrompt(held.id, held.text, held.images, held.ourId, held.echoed);
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const msg = value as Record<string, unknown>;
  if (msg.jsonrpc !== '2.0') {
    return;
  }
  if (typeof msg.method !== 'string') {
    if (permOpen && msg.id === PERM_ID) {
      if (msg.result !== undefined) {
        permOpen = false;
        const option =
          msg.result &&
          typeof msg.result === 'object' &&
          'outcome' in msg.result &&
          (msg.result as { outcome?: { optionId?: string } }).outcome?.optionId;
        if (option === 'reject-once') {
          finish('cancelled', `perm:${JSON.stringify(msg.result)}`);
        } else {
          finish('end_turn', `perm:${JSON.stringify(msg.result)}`);
        }
      } else if (msg.error !== undefined) {
        permOpen = false;
        finish('end_turn', `failed:${JSON.stringify(msg.error)}`);
      }
      return;
    }
    if (askOpen && msg.id === ASK_ID) {
      if (msg.result !== undefined) {
        askOpen = false;
        finish('end_turn', `accepted:${JSON.stringify(msg.result)}`);
      } else if (msg.error !== undefined) {
        // Live 2026-08-16: a JSON-RPC error fails the tool and ends the turn.
        askOpen = false;
        finish('end_turn', `failed:${JSON.stringify(msg.error)}`);
      }
    }
    return;
  }
  const params = msg.params;
  if (typeof msg.method === 'string' && msg.id !== undefined) noteRequest(msg.method, params);
  if (msg.id === undefined) {
    if (msg.method === 'session/cancel') {
      if (!ignoreCancel) {
        finish('cancelled');
      }
    }
    return;
  }
  switch (msg.method) {
    case 'initialize':
      result(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }],
        _meta: { defaultAuthMethodId: 'cached_token', agentVersion: '1.0.4' }
      });
      return;
    case 'authenticate':
      result(msg.id, {});
      return;
    case 'session/new': {
      const rec =
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
      if (typeof rec.cwd === 'string') sessionCwd = rec.cwd;
      result(msg.id, { sessionId: SESSION_ID, configOptions: configOptions() });
      return;
    }
    case 'session/set_model': {
      const rec =
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
      if (process.env.SQUADRON_FAKE_ACP_FAIL_MODEL) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: 'Invalid params', data: 'model rejected' }
        });
        return;
      }
      if (
        fs.existsSync(path.join(os.homedir(), '.grok', 'fake-model-refuse')) ||
        (rec.modelId !== 'grok-4.5' &&
        rec.modelId !== 'grok-4.6' &&
        rec.modelId !== 'grok-4.7' &&
        rec.modelId !== 'grok-4.7-build-fast')
      ) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params', data: 'unknown model id' } });
        return;
      }
      const modelId = rec.modelId;
      const apply = (): void => {
        currentModel = modelId;
        result(msg.id, { _meta: { model: { Ok: currentModel } } });
        // The CLI keeps the effort across set_model (protocol.md, 1.0.50).
        sessionUpdate({
          sessionUpdate: 'model_changed',
          model_id: currentModel,
          reasoning_effort: reasoningEffort
        });
      };
      const holdMs = Number(process.env.SQUADRON_FAKE_ACP_HOLD_MODEL_MS ?? 0);
      if (holdMs > 0) setTimeout(apply, holdMs);
      else apply();
      return;
    }
    case 'session/load': {
      const rec =
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
      if (typeof rec.cwd === 'string') sessionCwd = rec.cwd;
      if (rec.sessionId === SESSION_ID) {
        // Observed 2026-08-16: load returns then emits isReplay updates.
        sessionUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed' },
          _meta: { isReplay: true }
        });
        result(msg.id, { sessionId: SESSION_ID, configOptions: configOptions() });
        setTimeout(
          () =>
            notify('_x.ai/sessions/changed', {
              sessions: [{ sessionId: SESSION_ID, activity: 'idle', title: 'Loaded session' }]
            }),
          5
        );
        return;
      }
      write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'Path not found.', data: { code: 'FS_NOT_FOUND' } }
      });
      return;
    }
    case 'session/set_config_option': {
      const rec =
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
      const value = typeof rec.value === 'string' ? rec.value : '';
      if (rec.configId !== 'reasoning_effort' || !effortsFor(currentModel).includes(value)) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32602,
            message: 'Invalid params',
            data: 'unknown reasoning_effort value'
          }
        });
        return;
      }
      if (process.env.SQUADRON_FAKE_ACP_FAIL_CONFIG) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32602,
            message: 'Invalid params',
            data: 'reasoning_effort rejected'
          }
        });
        return;
      }
      const holdMs = Number(process.env.SQUADRON_FAKE_ACP_HOLD_CONFIG_MS ?? 0);
      const reply = (): void => {
        reasoningEffort = value;
        result(msg.id, { configOptions: configOptions() });
        sessionUpdate({
          sessionUpdate: 'model_changed',
          model_id: currentModel,
          reasoning_effort: reasoningEffort
        });
        sessionUpdate({ sessionUpdate: 'config_option_update', configOptions: configOptions() });
      };
      if (holdMs > 0) {
        setTimeout(reply, holdMs);
        return;
      }
      reply();
      return;
    }
    case 'session/prompt': {
      const rec =
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
      const parts = Array.isArray(rec.prompt) ? rec.prompt : [];
      const texts: string[] = [];
      const echoed: Echoed[] = [];
      let images = 0;
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const block = part as { type?: unknown; text?: unknown };
        if (block.type === 'image') {
          images += 1;
          echoed.push({ type: 'image' });
        } else if (typeof block.text === 'string') {
          texts.push(block.text);
          echoed.push({ type: 'text', text: block.text });
        }
      }
      const meta = typeof rec._meta === 'object' && rec._meta !== null ? rec._meta : {};
      const ourId = (meta as { promptId?: unknown }).promptId;
      const mine = typeof ourId === 'string' ? ourId : undefined;
      // A prompt that lands mid-wake is **queued behind it**, not run beside
      // it — 1.0.5 runs an ordered queue per session (probe 2026-08-25,
      // `entries=[ours]` with the wake still `runningPromptId`). Answering it
      // in parallel is what hid the outbox regression this fixture now shows.
      if (wakeRunning) {
        heldPrompts.push({ id: msg.id, text: texts.join(''), images, ourId: mine, echoed });
        notify('_x.ai/queue/changed', {
          sessionId: SESSION_ID,
          entries: [
            {
              id: mine ?? `grok-minted-${String(promptIndex)}`,
              kind: 'prompt',
              text: texts.join('')
            }
          ],
          runningPromptId: 'task-completed-01a0387b-982a-7492-8cd6-73d48fbf26d1'
        });
        // The paced wake ends here — because the drain wrote through it.
        if (wakeOnPrompt) {
          setTimeout(closeWake, 30);
        }
        return;
      }
      runPrompt(msg.id, texts.join(''), images, mine, echoed);
      return;
    }
    default:
      write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' }
      });
  }
});
