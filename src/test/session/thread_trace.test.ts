/**
 * Real wire traces, replayed frame by frame through each brand's session, with
 * the dock's thread composed after every frame the way the host composes it.
 *
 * **The invariant is on the thread**: every word of prose the pipe has
 * delivered appears in it exactly once, in order — in a turn read back from
 * the record or in the live half, never both and never neither. Not on any
 * held or rendered display: rendering is not composition, and the traces'
 * prose is compared as words, so markdown is irrelevant here.
 *
 * Traces are `fixtures/thread-trace/` — cut from the in-memory-thread task's
 * Step 1 and Step 2 probes (README there). The sessions are the real classes;
 * only the far end of the pipe is fake, and it answers each request with the
 * trace's own response to that method.
 *
 * The composition is the host's: the session's state and its thread captured
 * in one instant, then the refresh's awaits (`host/session_io.ts`
 * `buildThread` → `ownedTranscript` → `composeThread`).
 */

import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import type { SessionHandle } from '../../core/adapter';
import type { Exchange, Recent } from '../../core/transcript';
import type { LiveState } from '../../core/live';
import type { SessionTransport } from '../../core/session';
import { gitRepo } from '../execution_helpers';
import { repoRoot, tempHome } from '../helpers';

let live: typeof import('../../core/live');
let adapter: typeof import('../../core/adapter');
let views: typeof import('../../ui/views');
let claude: typeof import('../../core/claude/session');
let codex: typeof import('../../core/codex/session');
let grok: typeof import('../../core/grok/session');
let grokTranscriptPath: typeof import('../../core/grok/transcript').grokTranscriptPath;
let record: typeof import('../../core/record');
let cwd = '';

/** `paths.ts` resolves `HOME` when first required, so it moves before any import. */
before(async () => {
  const home = await tempHome();
  cwd = path.join(home, 'work');
  await fs.mkdir(cwd);
  live = await import('../../core/live');
  adapter = await import('../../core/adapter');
  views = await import('../../ui/views');
  claude = await import('../../core/claude/session');
  codex = await import('../../core/codex/session');
  grok = await import('../../core/grok/session');
  ({ grokTranscriptPath } = await import('../../core/grok/transcript'));
  record = await import('../../core/record');
});

const open: Handle[] = [];
after(() => {
  for (const handle of open) handle.close();
});

const FIXTURES = path.join(repoRoot(), 'src', 'test', 'fixtures', 'thread-trace');
/** The probe's working directory, as the cut spells it; the test's own replaces it. */
const PROBE_CWD = '/tmp/thread-trace/work';

type Brand = 'claude' | 'codex' | 'grok';
/** One fixture row: a line we wrote, a line the CLI wrote to the pipe, or one
 *  it wrote to its own disk (`wrote` names the file). */
type Row = { t: number; sent?: Record<string, unknown>; line?: unknown; wrote?: string };

/** What every brand's session offers that a replay needs. */
type Handle = {
  readonly state: LiveState;
  readonly thread: SessionHandle['thread'];
  readonly turn?: { interrupt(): Promise<unknown> };
  readonly messages?: SessionHandle['messages'];
  flush(): Promise<void>;
  close(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A fixture, moved into this test's directory and onto a conversation id of
 * its own — the record is keyed by that id, so two replays of one trace would
 * otherwise append to one file.
 */
async function rows(name: string, where = cwd): Promise<Row[]> {
  const body = (await fs.readFile(path.join(FIXTURES, `${name}.jsonl`), 'utf8')).replaceAll(
    PROBE_CWD,
    JSON.stringify(where).slice(1, -1)
  );
  const parsed = body
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
  const conversation = parsed.map((row) => conversationOf(row.line)).find(Boolean);
  assert.ok(conversation, `${name} names no conversation`);
  return body
    .replaceAll(conversation, randomUUID())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

/** Claude's `init`, Codex's `thread/start` result, Grok's `session/new` result. */
function conversationOf(line: unknown): string | undefined {
  if (!isRecord(line)) return undefined;
  if (line.subtype === 'init' && typeof line.session_id === 'string') return line.session_id;
  const result = isRecord(line.result) ? line.result : undefined;
  if (isRecord(result?.thread) && typeof result.thread.id === 'string') return result.thread.id;
  return typeof result?.sessionId === 'string' ? result.sessionId : undefined;
}

/**
 * The far end of the pipe. A request is answered with the trace's response to
 * the same method, re-addressed to the id the session used; a method the probe
 * never sent gets an empty result. The prompt is held: its response is a line
 * of the trace, and arrives when the replay reaches it.
 */
class Peer {
  readonly written: Record<string, unknown>[] = [];
  /** The prompt request the session wrote, once it has. */
  prompt?: Record<string, unknown>;
  private readonly listeners: ((value: unknown) => void)[] = [];
  private readonly answers = new Map<string, Record<string, unknown>>();

  constructor(
    trace: readonly Row[],
    private readonly promptMethod: string
  ) {
    const asked = new Map<unknown, string>();
    for (const row of trace) {
      if (row.sent && row.sent.id !== undefined && typeof row.sent.method === 'string') {
        asked.set(row.sent.id, row.sent.method);
      } else if (isRecord(row.line) && row.line.method === undefined) {
        const method = asked.get(row.line.id);
        if (method) this.answers.set(method, row.line);
      }
    }
  }

  readonly transport: SessionTransport = {
    pid: 4242,
    onLine: (listener) => this.listeners.push(listener),
    onExit: () => undefined,
    close: () => undefined,
    write: (value) => {
      if (!isRecord(value)) return;
      this.written.push(value);
      if (value.id === undefined || typeof value.method !== 'string') return;
      if (value.method === this.promptMethod) {
        this.prompt = value;
        return;
      }
      const reply = this.reply(value.method, value.id);
      queueMicrotask(() => this.emit(reply));
    }
  };

  emit(value: unknown): void {
    for (const listener of this.listeners) listener(value);
  }

  private reply(method: string, id: unknown): Record<string, unknown> {
    // The live session's own history reader (Codex). Empty pages say the CLI
    // holds nothing we have not recorded, so the record is what is drawn.
    if (method === 'thread/turns/list' || method === 'thread/items/list') {
      return { id, result: { data: [], nextCursor: null } };
    }
    const traced = this.answers.get(method);
    if (traced) return { ...traced, id };
    return {
      ...(this.promptMethod === 'session/prompt' ? { jsonrpc: '2.0' } : {}),
      id,
      result: {}
    };
  }
}

/** One trace, opened and prompted: the session, and the frames still to come. */
type Replay = {
  brand: Brand;
  handle: Handle;
  /** Put one line on the session's pipe. */
  emit: (line: unknown) => void;
  /** Append one line to the CLI's own file, as the CLI would. */
  write?: (file: string, line: unknown) => Promise<void>;
  /** What happened after the prompt left, re-addressed to this session's ids. */
  frames: Frame[];
  /** The CLI's own file writes not replayed yet. */
  disk: Set<Frame>;
  /** Every request the session has written to the far end, in order. */
  written: readonly Record<string, unknown>[];
};

type Frame = { line?: unknown; interrupt?: true; wrote?: { file: string; line: unknown } };

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await setTimeout(5);
  assert.ok(done(), what);
}

/**
 * Everything the trace says after its prompt left. `sent` rows the probe wrote
 * mid-turn are the interrupt, played as the session's own; any other row the
 * probe sent is its business, not this session's.
 */
function remaining(
  trace: readonly Row[],
  promptAt: number,
  readdress: (line: unknown) => unknown
): Pick<Replay, 'frames' | 'disk'> {
  const frames = trace.slice(promptAt + 1).flatMap((row): Frame[] => {
    if (row.wrote !== undefined) return [{ wrote: { file: row.wrote, line: readdress(row.line) } }];
    if (row.line !== undefined) return [{ line: readdress(row.line) }];
    const method = row.sent?.method;
    return method === 'session/cancel' || method === 'turn/interrupt'
      ? [{ interrupt: true as const }]
      : [];
  });
  return { frames, disk: new Set(frames.filter((frame) => frame.wrote)) };
}

async function openClaude(name: string, where = cwd): Promise<Replay> {
  const trace = await rows(name, where);
  const promptAt = trace.findIndex((row) => row.sent?.type === 'user');
  const said = trace[promptAt]?.sent?.message as { content: { text: string }[] } | undefined;
  const init = trace.find((row) => isRecord(row.line) && row.line.subtype === 'init');
  const sessionId = conversationOf(init?.line);
  const peer = new Peer(trace, '');
  const handle = new claude.OwnedSession(peer.transport, {
    cwd: where,
    startedAt: Date.now(),
    sessionId
  });
  open.push(handle);
  handle.send(said?.content[0]?.text ?? '');
  await until(() => peer.written.some((w) => w.type === 'user'), 'the prompt never left');
  return {
    brand: 'claude',
    handle,
    written: peer.written,
    emit: (line) => peer.emit(line),
    ...remaining(trace, promptAt, (line) => line)
  };
}

async function openCodex(
  name: string,
  keep: (row: Row) => boolean = () => true,
  where = cwd
): Promise<Replay> {
  const trace = (await rows(name, where)).filter(keep);
  const promptAt = trace.findIndex((row) => row.sent?.method === 'turn/start');
  const sent = trace[promptAt]?.sent as { id: unknown; params: { input: { text: string }[] } };
  const peer = new Peer(trace, 'turn/start');
  const handle = new codex.CodexSession(peer.transport, { cwd: where, startedAt: Date.now() });
  open.push(handle);
  assert.equal((await handle.opening).ok, true);
  handle.send(sent.params.input[0]?.text ?? '');
  await until(() => peer.prompt !== undefined, 'turn/start never left');
  const ours = peer.prompt?.id;
  // The probe sent no client id, so its echo names none; Codex echoes the one
  // it is given (`cli_state/codex/protocol.md`), and this session gives one.
  const params = isRecord(peer.prompt?.params) ? peer.prompt.params : {};
  const clientId = params.clientUserMessageId;
  return {
    brand: 'codex',
    handle,
    written: peer.written,
    emit: (line) => peer.emit(line),
    ...remaining(trace, promptAt, (line) => {
      if (!isRecord(line)) return line;
      if (line.method === undefined && line.id === sent.id) return { ...line, id: ours };
      const echo = isRecord(line.params) ? line.params : {};
      const item = isRecord(echo.item) ? echo.item : {};
      return item.type === 'userMessage' && item.clientId === null
        ? { ...line, params: { ...echo, item: { ...item, clientId } } }
        : line;
    })
  };
}

async function openGrok(name: string, where = cwd): Promise<Replay> {
  const trace = await rows(name, where);
  const promptAt = trace.findIndex((row) => row.sent?.method === 'session/prompt');
  const sent = trace[promptAt]?.sent as {
    id: unknown;
    params: { prompt: { text: string }[]; _meta: { promptId: string } };
  };
  const peer = new Peer(trace, 'session/prompt');
  const handle = new grok.GrokSession(peer.transport, { cwd: where, startedAt: Date.now() });
  open.push(handle);
  assert.equal((await handle.opening).ok, true);
  handle.send(sent.params.prompt[0]?.text ?? '');
  await until(() => peer.prompt !== undefined, 'session/prompt never left');
  const prompt = peer.prompt as {
    id: unknown;
    params: { sessionId: string; _meta: { promptId: string } };
  };
  // The trace's prompt id is the probe's; every echo of it is this session's.
  const theirs = JSON.stringify(sent.params._meta.promptId);
  const ours = JSON.stringify(prompt.params._meta.promptId);
  const dir = path.dirname(
    handle.state.transcript ?? grokTranscriptPath(where, prompt.params.sessionId)
  );
  return {
    brand: 'grok',
    handle,
    written: peer.written,
    emit: (line) => peer.emit(line),
    // The echo is matched against the send's own clock, so it is stamped now.
    write: async (file, line) => {
      const now = Date.now();
      const stamped = JSON.stringify(line)
        .replace(/"agentTimestampMs":\d+/g, `"agentTimestampMs":${now}`)
        .replace(/"timestamp":\d+/, `"timestamp":${Math.floor(now / 1000)}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(path.join(dir, file), stamped + '\n');
    },
    ...remaining(trace, promptAt, (line) => {
      const echoed = JSON.parse(JSON.stringify(line).replaceAll(theirs, ours)) as unknown;
      return isRecord(echoed) && echoed.method === undefined && echoed.id === sent.id
        ? { ...echoed, id: prompt.id }
        : echoed;
    })
  };
}

/**
 * The prose a frame delivers, keyed by the message it belongs to — so messages
 * join at a word boundary however their deltas were cut. Thinking is not prose.
 */
class Delivered {
  private readonly messages = new Map<string, string>();
  private claudeMessage = '';

  constructor(private readonly brand: Brand) {}

  take(line: unknown): void {
    const said = this.prose(line);
    if (said) this.messages.set(said.key, (this.messages.get(said.key) ?? '') + said.text);
  }

  words(): string[] {
    return words([...this.messages.values()]);
  }

  private prose(line: unknown): { key: string; text: string } | undefined {
    if (!isRecord(line)) return undefined;
    if (this.brand === 'claude') {
      const event =
        line.type === 'stream_event' && !line.parent_tool_use_id ? line.event : undefined;
      if (!isRecord(event)) return undefined;
      if (event.type === 'message_start' && isRecord(event.message)) {
        this.claudeMessage = String(event.message.id);
      }
      const delta = event.type === 'content_block_delta' ? event.delta : undefined;
      return isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string'
        ? { key: `${this.claudeMessage}:${String(event.index)}`, text: delta.text }
        : undefined;
    }
    const params = isRecord(line.params) ? line.params : undefined;
    if (this.brand === 'codex') {
      return line.method === 'item/agentMessage/delta' && typeof params?.delta === 'string'
        ? { key: String(params.itemId), text: params.delta }
        : undefined;
    }
    const update = isRecord(params?.update) ? params.update : undefined;
    const content = isRecord(update?.content) ? update.content : undefined;
    const meta = isRecord(params?._meta) ? params._meta : undefined;
    return update?.sessionUpdate === 'agent_message_chunk' && typeof content?.text === 'string'
      ? { key: String(meta?.streamStartMs), text: content.text }
      : undefined;
  }
}

function words(texts: readonly string[]): string[] {
  return texts.join('\n').split(/\s+/).filter(Boolean);
}

/** The assistant prose a composed thread draws: read-back turns, then the live half. */
function drawnWords(thread: ThreadView): string[] {
  const turns = thread.exchanges.flatMap((x) =>
    'role' in x && x.role === 'assistant' ? [x.text] : []
  );
  return words(turns);
}

/** `renderTranscript`'s shape with no markdown engine behind it: composition
 *  reads role, words and stamps, never a block. */
function asViews(recent: Recent): ExchangeView[] {
  return recent.exchanges.map(asView);
}

function asView(x: Exchange): ExchangeView {
  return 'mark' in x
    ? x
    : {
        role: x.role,
        local: x.local,
        text: x.text,
        at: x.at,
        from: x.from,
        skill: x.skill,
        blocks: [],
        ...(x.cut ? { cut: true as const } : {})
      };
}

const HELD = { pid: 4242, startedAt: 1, updatedAt: 1 };

/**
 * One refresh, in `buildThread`'s order: the session's state and its thread
 * captured together with nothing awaited between, then the refresh's awaits.
 * `between` is what the pipe delivers while those are in flight — attribution
 * and rendering are where frames land.
 */
async function hostReads(replay: Replay, between?: () => Promise<void>): Promise<ThreadView> {
  const { live: state, shot } = adapter.captureOwned(replay.handle);
  const reading = adapter.ownedTranscript(replay.brand, shot);
  await between?.();
  const sourced = await reading;
  const card = live.toSession(state, { ...HELD, brand: replay.brand }, 'w');
  return views.composeThread(
    card,
    {
      history: {
        exchanges: asViews(sourced.recent),
        truncated: sourced.recent.truncated,
        fallback: adapter.reconstructed(sourced),
        tail: shot.tail.map((row) => ({ position: row.position, exchange: asView(row.exchange) }))
      },
      live: state
    },
    {}
  );
}

function describeFrame(line: unknown): string {
  if (!isRecord(line)) return String(line);
  if (isRecord(line.event)) return `stream_event ${String(line.event.type)}`;
  if (typeof line.type === 'string') return line.type;
  const update = isRecord(line.params) && isRecord(line.params.update) ? line.params.update : {};
  const method =
    typeof line.method === 'string' ? line.method : `response ${JSON.stringify(line.id)}`;
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  return `${method} ${kind}`;
}

/** Where two word lists part, as a sentence a failing run can be read by. */
function parting(drawn: readonly string[], said: readonly string[]): string {
  let at = 0;
  while (at < drawn.length && at < said.length && drawn[at] === said[at]) at++;
  const around = (list: readonly string[]): string =>
    JSON.stringify(list.slice(Math.max(0, at - 4), at + 6).join(' '));
  return (
    `drew ${drawn.length} words, the pipe delivered ${said.length}; ` +
    `they part at word ${at}: drawn ${around(drawn)} vs delivered ${around(said)}`
  );
}

/**
 * Deliver one frame and let the session's write-behind land, as a quiet pipe
 * would. Not while a disk write of the CLI's is still ahead in the trace: Grok
 * holds its record until its own file echoes the prompt, so nothing can land
 * before the replay reaches that write.
 */
async function deliver(replay: Replay, frame: Frame, said: Delivered): Promise<void> {
  if (frame.wrote) {
    assert.ok(replay.write, `${replay.brand} writes no file of its own here`);
    await replay.write(frame.wrote.file, frame.wrote.line);
    replay.disk.delete(frame);
  } else if (frame.interrupt) {
    void replay.handle.turn?.interrupt().catch(() => undefined);
  } else {
    said.take(frame.line);
    replay.emit(frame.line);
  }
  if (replay.disk.size === 0) await replay.handle.flush();
}

/** Why a composed thread breaks the invariant, or nothing when it holds. */
function broken(thread: ThreadView, delivered: readonly string[]): string | undefined {
  const drawn = drawnWords(thread);
  return drawn.join(' ') === delivered.join(' ') ? undefined : parting(drawn, delivered);
}

/**
 * Every frame of the trace, with a refresh after each once the session's
 * writes have landed. The first frame whose thread broke the invariant, or
 * nothing.
 */
async function everyFrame(replay: Replay): Promise<string | undefined> {
  const said = new Delivered(replay.brand);
  for (const [i, frame] of replay.frames.entries()) {
    await deliver(replay, frame, said);
    const wrong = broken(await hostReads(replay), said.words());
    if (wrong) {
      const what = frame.wrote
        ? `wrote ${frame.wrote.file}`
        : frame.interrupt
          ? 'interrupt'
          : describeFrame(frame.line);
      return `after frame ${i} (${what}): ${wrong}`;
    }
  }
  return undefined;
}

/**
 * The trace up to `from`, then one refresh whose history read lands before the
 * frames `from` to `to` and whose live read lands after them. Holds if the
 * thread is the delivered words at either instant.
 */
async function straddling(replay: Replay, from: number, to: number): Promise<string | undefined> {
  const said = new Delivered(replay.brand);
  for (const frame of replay.frames.slice(0, from)) await deliver(replay, frame, said);
  const before = said.words();
  const thread = await hostReads(replay, async () => {
    for (const frame of replay.frames.slice(from, to + 1)) await deliver(replay, frame, said);
  });
  const atStart = broken(thread, before);
  const atEnd = broken(thread, said.words());
  return atStart && atEnd
    ? `history before frame ${from}, live after frame ${to}: ${atEnd}`
    : undefined;
}

/** The index of the first (or last) remaining frame `match` picks, asserted present. */
function frameWhere(
  replay: Replay,
  match: (line: Record<string, unknown>) => boolean,
  last = false
): number {
  const hits = replay.frames.flatMap((f, i) => (isRecord(f.line) && match(f.line) ? [i] : []));
  const at = last ? hits.at(-1) : hits[0];
  assert.ok(at !== undefined, 'the trace no longer holds the frame this case is about');
  return at;
}

/** A row of the command item Codex ran between its two messages. */
function commandItem(row: Row): boolean {
  const params = isRecord(row.line) ? row.line.params : undefined;
  return isRecord(params) && isRecord(params.item) && params.item.type === 'commandExecution';
}

/** Codex completing one agent message. */
function agentMessageDone(line: Record<string, unknown>): boolean {
  return (
    line.method === 'item/completed' &&
    isRecord(line.params) &&
    isRecord(line.params.item) &&
    line.params.item.type === 'agentMessage'
  );
}

describe('the traces', () => {
  // A cut that dropped what a case is about would leave it trivially green.
  it('still hold the shapes the cases below are about', async () => {
    const kinds = async (name: string): Promise<string[]> =>
      (await rows(name)).flatMap((row) =>
        row.line === undefined ? [] : [describeFrame(row.line)]
      );
    const claudeTrace = await kinds('claude');
    assert.ok(
      claudeTrace.indexOf('user') > claudeTrace.indexOf('assistant'),
      'text, then a tool result'
    );
    assert.ok(
      claudeTrace.lastIndexOf('assistant') > claudeTrace.indexOf('user'),
      'then text again'
    );

    const codexItems = (await rows('codex')).flatMap((row) => {
      const params = isRecord(row.line) ? row.line.params : undefined;
      const item = isRecord(params) && isRecord(params.item) ? params.item : undefined;
      return isRecord(row.line) && row.line.method === 'item/completed' && item
        ? [String(item.phase ?? item.type)]
        : [];
    });
    assert.deepEqual(codexItems, ['userMessage', 'commentary', 'commandExecution', 'final_answer']);

    const grokTrace = await kinds('grok');
    const tool = grokTrace.indexOf('session/update tool_call_update');
    assert.ok(grokTrace.indexOf('session/update agent_message_chunk') < tool, 'prose, then a tool');
    assert.ok(grokTrace.lastIndexOf('session/update agent_message_chunk') > tool, 'then prose');

    const cancel = await rows('grok-cancel');
    const closed = cancel.findIndex((row) => describeFrame(row.line).endsWith('turn_completed'));
    const late = cancel
      .slice(closed + 1)
      .map((row) => row.line)
      .find(isChunk);
    const before = cancel
      .slice(0, closed)
      .map((row) => row.line)
      .filter(isChunk)
      .at(-1);
    assert.ok(late && before, 'a chunk after turn_completed');
    assert.equal(late.params._meta.streamStartMs, before.params._meta.streamStartMs);
    assert.equal(late.params._meta.promptId, undefined, 'naming no prompt');
  });
});

describe('a Claude turn, text then a tool then text (2.1.289)', () => {
  it('draws every delivered word once after every frame', async () => {
    assert.equal(await everyFrame(await openClaude('claude')), undefined);
  });

  it('draws every word once when the turn ends during a refresh', async () => {
    // The final `assistant` and `result` land during the refresh's awaits, 54 ms
    // apart in the trace; a history read before them and a live read after
    // drew neither copy of the last message.
    const replay = await openClaude('claude');
    const last = frameWhere(replay, (line) => line.type === 'assistant', true);
    const end = frameWhere(replay, (line) => line.type === 'result');
    assert.equal(await straddling(replay, last, end), undefined);
  });
});

describe('a message the end of a turn drains, during a refresh', () => {
  it('is drawn once: held, or sent, never both and never neither', async () => {
    // The live half and the thread are one instant. Taken apart — the outbox
    // read before `result` drained it, the thread after — it is drawn twice.
    const replay = await openClaude('claude');
    const next = 'and then this';
    void replay.handle.messages?.send(next, []);
    const end = frameWhere(replay, (line) => line.type === 'result');
    const said = new Delivered('claude');
    for (const frame of replay.frames.slice(0, end)) await deliver(replay, frame, said);
    assert.equal(replay.handle.state.queued.length, 1, 'held while the turn runs');
    const thread = await hostReads(replay, async () => {
      for (const frame of replay.frames.slice(end, end + 1)) await deliver(replay, frame, said);
      await until(() => replay.handle.state.queued.length === 0, 'the turn end drains it');
    });
    const drawn = [
      ...thread.exchanges.filter((x) => 'role' in x && x.role === 'user' && x.text === next),
      ...(thread.queued ?? []).filter((row) => row.text === next),
      ...(thread.sending ?? []).filter((row) => row.text === next)
    ];
    assert.equal(drawn.length, 1);
  });
});

describe('a Codex turn, commentary then a command then the final answer (0.160.0)', () => {
  it('draws every delivered word once after every frame', async () => {
    assert.equal(await everyFrame(await openCodex('codex')), undefined);
  });

  it('draws every word once when the turn ends during a refresh', async () => {
    const replay = await openCodex('codex');
    const last = frameWhere(replay, agentMessageDone, true);
    const end = frameWhere(replay, (line) => line.method === 'turn/completed');
    assert.equal(await straddling(replay, last, end), undefined);
  });
});

describe('a Codex turn, commentary straight into the final answer', () => {
  it('draws every delivered word once after every frame', async () => {
    // The trace above with its command item cut: two `agentMessage` items back
    // to back, each its own row, with no tool result between them — a single
    // live half joined them and drew the first twice.
    const replay = await openCodex('codex', (row) => !commandItem(row));
    assert.equal(await everyFrame(replay), undefined);
  });
});

describe('a Grok turn, prose then a tool then prose (1.0.46)', () => {
  it('draws every delivered word once after every frame', async () => {
    // The tee holds the prose on its open line past the completed tool, until
    // the next chunk: 2.1 s in the trace. It streams under the tee's row and
    // that row closes when the line lands, so the tool boundary moves nothing.
    assert.equal(await everyFrame(await openGrok('grok')), undefined);
  });
});

describe('a cancelled Grok turn, one chunk landing after turn_completed (1.0.46)', () => {
  it('draws every delivered word once after every frame', async () => {
    // The cancel cuts the message and holds its row off the record until the
    // reply seals it, for the chunk still to come. The thread draws it
    // throughout; the record does not have it yet.
    assert.equal(await everyFrame(await openGrok('grok-cancel')), undefined);
  });

  it('keeps the late chunk on the cancelled message', async () => {
    const replay = await openGrok('grok-cancel');
    const said = new Delivered('grok');
    const close = frameWhere(replay, (line) => describeFrame(line).endsWith('turn_completed'));
    let busy = false;
    for (const [i, frame] of replay.frames.entries()) {
      await deliver(replay, frame, said);
      if (i > close) busy ||= replay.handle.state.running;
    }
    const thread = await hostReads(replay);
    const replies = thread.exchanges.filter((x) => 'role' in x && x.role === 'assistant');
    assert.equal(replies.length, 1, 'one message, not the cut one and a stray');
    assert.equal(
      words(replies.map((x) => ('text' in x ? x.text : ''))).join(' '),
      said.words().join(' ')
    );
    const [cut] = replay.handle.thread
      .snapshot()
      .history.exchanges.filter((x) => 'role' in x && x.role === 'assistant');
    assert.equal(cut && 'cut' in cut ? cut.cut : undefined, true, 'kept, marked cut off');
    assert.equal(busy, false, 'the late chunk opens no turn');
  });
});

/** A Grok prose chunk, with the `_meta` the late-chunk case reads. */
function isChunk(
  line: unknown
): line is { params: { _meta: { streamStartMs?: number; promptId?: string } } } {
  return (
    describeFrame(line).endsWith('agent_message_chunk') &&
    isRecord(line) &&
    isRecord(line.params) &&
    isRecord(line.params._meta)
  );
}

/**
 * Every call made on `fs` and `fs/promises` while `work` runs, by name and
 * first argument. Both modules are patched in place, so every reader that
 * imports either is seen; `fs.promises` is the `fs/promises` object.
 */
async function fileCalls(work: () => Promise<unknown>): Promise<string[]> {
  const calls: string[] = [];
  const restore: (() => void)[] = [];
  for (const [name, mod] of [
    ['fs', fsSync as unknown as Record<string, unknown>],
    ['fs/promises', fs as unknown as Record<string, unknown>]
  ] as const) {
    for (const key of Object.keys(mod)) {
      const original = mod[key];
      if (typeof original !== 'function' || /^[A-Z]/.test(key)) continue;
      mod[key] = function (this: unknown, ...args: unknown[]) {
        calls.push(`${name}.${key}(${String(args[0])})`);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      restore.push(() => {
        mod[key] = original;
      });
    }
  }
  try {
    await work();
  } finally {
    for (const undo of restore) undo();
  }
  return calls;
}

/** The trace up to the first refresh with a message still being written. */
async function streaming(replay: Replay): Promise<void> {
  const said = new Delivered(replay.brand);
  for (const frame of replay.frames) {
    await deliver(replay, frame, said);
    if (replay.handle.thread.snapshot().tail.length) return;
  }
  assert.fail(`${replay.brand}'s trace never streamed`);
}

/** The requests that read a conversation back from Codex's app-server. */
const HISTORY_RPC = new Set(['thread/turns/list', 'thread/items/list']);

describe('a refresh of a streaming owned session', () => {
  for (const [brand, open] of [
    ['claude', () => openClaude('claude')],
    ['codex', () => openCodex('codex')],
    ['grok', () => openGrok('grok')]
  ] as const) {
    it(`acquires ${brand}'s thread with no transcript read and no history request`, async () => {
      const replay = await open();
      await streaming(replay);
      const asked = replay.written.length;
      let thread: ThreadView | undefined;
      const calls = await fileCalls(async () => {
        thread = await hostReads(replay);
      });
      assert.deepEqual(calls, [], 'the dock read no file');
      const requests = replay.written
        .slice(asked)
        .flatMap((w) =>
          typeof w.method === 'string' && HISTORY_RPC.has(w.method) ? [w.method] : []
        );
      assert.deepEqual(requests, [], 'and asked the CLI for no history');
      assert.ok(
        thread?.exchanges.some((x) => 'streaming' in x && x.streaming),
        'the message being written is drawn, from memory'
      );
    });
  }
});

/**
 * A refresh is a read, its awaits, and the panel's last check before it posts
 * (`host/panel.ts` → `publishable`). Frames and a `/clear` land inside those
 * awaits, and refreshes overlap; what one composed from a conversation the
 * card no longer holds must never be what the dock shows.
 */
describe('a refresh that read a conversation since cleared', () => {
  /** A Claude reply part-way through, its thread holding words. */
  async function replying(): Promise<Replay> {
    const replay = await openClaude('claude');
    const last = frameWhere(replay, (line) => line.type === 'assistant', true);
    const said = new Delivered('claude');
    for (const frame of replay.frames.slice(0, last)) await deliver(replay, frame, said);
    const shot = replay.handle.thread.snapshot();
    assert.ok(shot.recent.exchanges.length + shot.tail.length > 0, 'the reply is in memory');
    return replay;
  }

  function clear(replay: Replay): void {
    replay.emit({ type: 'conversation_reset' });
    replay.emit({ type: 'system', subtype: 'init', session_id: randomUUID() });
  }

  const now = (replay: Replay) => adapter.ownedStamp(replay.handle);

  it('is not published once the conversation it read was cleared', async () => {
    const replay = await replying();
    const polled = now(replay);
    const old = adapter.captureOwned(replay.handle);
    // Its render is still in flight when the `/clear` and the next `init` land.
    const rendering = adapter.ownedTranscript('claude', old.shot);
    clear(replay);
    assert.equal(
      adapter.publishable(old, polled, now(replay), 0),
      false,
      'the cleared conversation is not the one to draw, even with nothing newer drawn'
    );
    const fresh = adapter.captureOwned(replay.handle);
    assert.equal(fresh.shot.recent.exchanges.length + fresh.shot.tail.length, 0);
    assert.ok(adapter.publishable(fresh, now(replay), now(replay), 0));
    assert.ok((await rendering).recent.exchanges.length > 0, 'the old render finishes');
    assert.equal(adapter.publishable(old, polled, now(replay), fresh.order), false);
  });

  it('is not published when the poll read the card before the clear and the thread after', async () => {
    const replay = await replying();
    const polled = now(replay);
    clear(replay);
    const capture = adapter.captureOwned(replay.handle);
    assert.equal(adapter.publishable(capture, polled, now(replay), 0), false);
  });

  it('is not published once its session was replaced', async () => {
    const replay = await replying();
    const other = await openClaude('claude');
    const capture = adapter.captureOwned(replay.handle);
    assert.equal(adapter.publishable(capture, now(replay), undefined, 0), false);
    assert.equal(adapter.publishable(capture, now(replay), now(other), 0), false);
  });

  it('is not published once a refresh that read after it has', async () => {
    const replay = await replying();
    const earlier = adapter.captureOwned(replay.handle);
    const later = adapter.captureOwned(replay.handle);
    assert.ok(adapter.publishable(later, now(replay), now(replay), 0));
    assert.equal(adapter.publishable(earlier, now(replay), now(replay), later.order), false);
  });

  it('is published while the reply goes on streaming under it', async () => {
    const replay = await openClaude('claude');
    const polled = now(replay);
    const capture = adapter.captureOwned(replay.handle);
    const said = new Delivered('claude');
    for (const frame of replay.frames) await deliver(replay, frame, said);
    assert.ok(adapter.publishable(capture, polled, now(replay), 0));
  });
});

describe("the host's last flush, a reply still streaming", () => {
  // A window closing: `closeAll` calls `close()`, then `flush()`, and the host
  // exits. Nothing waits for the child's stdout to close, so the flush is the
  // last chance for the partial reply and the stopped turn's checkpoint.
  type Line = Record<string, unknown>;

  async function closedMidText(replay: Replay): Promise<{ partial: string; lines: Line[] }> {
    const said = new Delivered(replay.brand);
    for (const frame of replay.frames) {
      await deliver(replay, frame, said);
      if (replay.handle.thread.snapshot().tail.length) break;
    }
    const shot = replay.handle.thread.snapshot();
    const partial = shot.tail[0]?.exchange.text;
    assert.ok(partial, 'the trace streams text before it ends');
    replay.handle.close();
    await replay.handle.flush();
    const raw = await fs.readFile(record.recordFile(shot.conversation), 'utf8').catch(() => '');
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Line)
      .filter((line) => !('v' in line));
    return { partial, lines };
  }

  function assertFinalised({ partial, lines }: { partial: string; lines: Line[] }): void {
    const reply = lines.findIndex((line) => line.role === 'assistant');
    assert.ok(reply >= 0, 'the partial reply is on disk');
    assert.equal(lines[reply]?.cut, true, 'flagged cut off');
    assert.ok(String(lines[reply]?.text).startsWith(partial.trimEnd()), 'with its words');
    assert.ok(
      lines.slice(reply + 1).some((line) => line.ck !== undefined),
      "and the stopped turn's checkpoint behind it"
    );
  }

  it('writes Claude’s partial reply and its checkpoint', async () => {
    assertFinalised(await closedMidText(await openClaude('claude', await gitRepo('flush-claude'))));
  });

  it('writes Codex’s partial reply and its checkpoint', async () => {
    const where = await gitRepo('flush-codex');
    assertFinalised(await closedMidText(await openCodex('codex', undefined, where)));
  });

  it('writes Grok’s partial reply and its checkpoint', async () => {
    assertFinalised(await closedMidText(await openGrok('grok', await gitRepo('flush-grok'))));
  });
});
