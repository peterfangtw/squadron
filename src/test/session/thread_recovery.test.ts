/**
 * The recovery boundary, per brand: a resumed session reads what came before
 * its pipe — our record when `drawable` may draw it, with what it missed
 * appended when that came after it, else the CLI's own history — and its first
 * send waits for that read (`SessionHandle.thread`).
 *
 * Each case pauses the read, puts frames on the pipe and a message in the
 * outbox while it is paused, then lets it land. What must hold: the prompt goes
 * once, after the baseline; the baseline is in the thread once; and what the
 * pipe delivered meanwhile reaches the record once, behind the read — so the
 * read could not already hold it.
 *
 * Claude and Grok read files, so their pause is the record's read failing as a
 * transient error does, which a recovery retries. Codex reads
 * through its own app-server, so its pause is that request held unanswered.
 * The sessions are the real classes; only the far end of the pipe is fake.
 */

import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import type { SessionHandle } from '../../core/adapter';
import type { RecordLine } from '../../core/record';
import type { SessionTransport } from '../../core/session';
import type { Exchange, Recent } from '../../core/transcript';
import { resetDir, tempHome } from '../helpers';

let record: typeof import('../../core/record');
let adapter: typeof import('../../core/adapter');
let closing: typeof import('../../ui/closing');
let live: typeof import('../../core/live');
let claude: typeof import('../../core/claude/session');
let claudeFiles: typeof import('../../core/claude/transcript');
let grok: typeof import('../../core/grok/session');
let grokFiles: typeof import('../../core/grok/transcript');
let codex: typeof import('../../core/codex/session');
let codexPages: typeof import('../../core/codex/transcript');
let route: typeof import('../../core/coordination/route');
let cwd = '';

/** `paths.ts` resolves `HOME` when first required, so it moves before any import. */
before(async () => {
  const home = await tempHome();
  await fs.mkdir(path.join(home, 'work'));
  // Real, as the CLI's: it files a transcript under the slug of the resolved
  // cwd, and the temp home is under a link on macOS (`/var/folders`).
  cwd = await fs.realpath(path.join(home, 'work'));
  record = await import('../../core/record');
  adapter = await import('../../core/adapter');
  closing = await import('../../ui/closing');
  live = await import('../../core/live');
  claude = await import('../../core/claude/session');
  claudeFiles = await import('../../core/claude/transcript');
  grok = await import('../../core/grok/session');
  grokFiles = await import('../../core/grok/transcript');
  codex = await import('../../core/codex/session');
  codexPages = await import('../../core/codex/transcript');
  route = await import('../../core/coordination/route');
});

const open: SessionHandle[] = [];
afterEach(() => mock.restoreAll());
after(() => {
  for (const handle of open) handle.close();
});

type Message = Record<string, unknown>;

function isRecord(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The far end of the pipe: every write kept, each request answered with what
 *  `answer` returns for it — or held, when it returns nothing. */
class Pipe {
  readonly written: Message[] = [];
  private readonly listeners: ((value: unknown) => void)[] = [];

  constructor(private readonly answer: (request: Message) => Message | undefined) {}

  readonly transport: SessionTransport = {
    pid: 4242,
    onLine: (listener) => this.listeners.push(listener),
    onExit: () => undefined,
    close: () => undefined,
    write: (value) => {
      if (!isRecord(value)) return;
      this.written.push(value);
      const reply = this.answer(value);
      if (reply) queueMicrotask(() => this.emit(reply));
    }
  };

  emit(value: unknown): void {
    for (const listener of this.listeners) listener(value);
  }

  count(match: (message: Message) => boolean): number {
    return this.written.filter(match).length;
  }
}

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600 && !(await done()); i++) await sleep(5);
  assert.ok(await done(), what);
}

const texts = (exchanges: readonly Exchange[]): string[] =>
  exchanges.map((one) => ('text' in one ? one.text : `[${one.mark}]`));

const textOf = (line: RecordLine): string | undefined =>
  'text' in line && typeof line.text === 'string' ? line.text : undefined;

/**
 * A record whose read fails until the returned call lets it through. The record
 * is written while held, so a retry sees the failure or the whole record —
 * deleting a blocker and then writing leaves a gap where the read finds no
 * record and rightly draws the CLI's history instead.
 */
function unreadable(conversation: string): () => void {
  const file = record.recordFile(conversation);
  const read = fs.open;
  const held = mock.method(fs, 'open', ((...args: Parameters<typeof fs.open>) =>
    args[0] === file
      ? Promise.reject(Object.assign(new Error('EIO: held'), { code: 'EIO' }))
      : read(...args)) as typeof fs.open);
  return () => held.mock.restore();
}

/** How a resume stands to our record: it witnessed everything (`ours`), it
 *  missed what came after it (`tail`), or it missed a turn among its own
 *  (`theirs`), which draws the brand's history. */
type Mode = 'ours' | 'tail' | 'theirs';

/** What a resume draws and what the record opens with afterwards: the
 *  history's rows from `from` on are the tail, behind the key `key`. */
function expect(
  mode: Mode,
  mine: readonly RecordLine[],
  theirs: { recent: Recent },
  missed: { key: string; from: number }
): { baseline: string[]; before: RecordLine[] } {
  const rows = theirs.recent.exchanges.slice(missed.from);
  const drawn = mine.flatMap((line) => {
    const text = textOf(line);
    return text === undefined ? [] : [text];
  });
  if (mode === 'theirs') return { baseline: texts(theirs.recent.exchanges), before: [...mine] };
  if (mode === 'ours') return { baseline: drawn, before: [...mine] };
  const before = [...mine, { m: missed.key }, ...rows];
  return {
    baseline: [...drawn, ...texts(rows)],
    before: JSON.parse(JSON.stringify(before)) as RecordLine[]
  };
}

async function recorded(conversation: string, lines: readonly RecordLine[]): Promise<void> {
  for (const line of lines) await record.appendLine(conversation, line);
}

/**
 * The boundary itself, the same for every brand: frames and a send while the
 * read is paused, nothing sent until it lands, then history once and the pipe's
 * words once.
 */
async function crossesOnce(o: {
  session: SessionHandle;
  conversation: string;
  /** Prompts the session has written to the pipe. */
  prompts: () => number;
  /** Put the pipe's own frames on it, mid-recovery. */
  during: () => void;
  /** Let the read land. */
  release: () => Promise<void>;
  /** What the record opens with once recovered: as it stood before the
   *  session, with the turns it missed appended when they were a tail. */
  before: readonly RecordLine[];
  /** What the thread must open with, as text. */
  baseline: readonly string[];
  /** The prose the frames during recovery carried. */
  live: string;
  /** What the thread holds after the baseline, for a brand that feeds it: the
   *  pipe's words, then the prompt sent during recovery. */
  fed?: readonly string[];
}): Promise<void> {
  assert.equal(o.session.thread.historyState, 'loading', 'recovery is visible while paused');
  o.during();
  const routed = route.routeTo({ owned: o.session });
  assert.ok(!route.isRefused(routed) && routed.messages);
  const receipt = await routed.messages.send('next prompt');
  await sleep(50);
  assert.equal(o.prompts(), 0, 'nothing is sent while what came before is being read');

  await o.release();
  await o.session.thread.recovered;
  assert.equal(o.session.thread.historyState, undefined, 'successful recovery stops loading');
  await until(() => o.prompts() > 0, 'the prompt goes once the baseline has landed');
  await sleep(20);
  assert.equal(o.prompts(), 1, 'and goes once');
  assert.ok(receipt.ok);
  assert.equal(receipt.queued, 1, 'a send held by recovery reports held, even while idle');

  assert.deepEqual(
    texts(o.session.thread.snapshot().recent.exchanges),
    [...o.baseline, ...(o.fed ?? [])],
    'the thread holds what came before, then the pipe, once each'
  );

  await until(
    async () =>
      (await record.readRecordLines(o.conversation))?.lines.some(
        (line) => textOf(line) === o.live
      ) === true,
    "the pipe's words reach the record"
  );
  const disk = (await record.readRecordLines(o.conversation))?.lines ?? [];
  assert.equal(disk.filter((line) => textOf(line) === o.live).length, 1, "the pipe's words once");
  assert.deepEqual(
    disk.slice(0, o.before.length),
    [...o.before],
    'the record opens with what was recovered, once'
  );
  assert.ok(
    disk.slice(o.before.length).every((line) => !o.baseline.includes(textOf(line) ?? '')),
    'the baseline is not appended to the record it came from'
  );
}

describe('send receipts on real adapters', () => {
  for (const brand of ['claude', 'grok', 'codex'] as const) {
    it(`reports an idle ${brand} send as outgoing while the baseline is captured`, async () => {
      const conversation = randomUUID();
      const pipe = new Pipe((request) => {
        if (request.id === undefined) return undefined;
        if (request.method === 'session/prompt') return undefined;
        const result =
          request.method === 'initialize'
            ? brand === 'grok'
              ? { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] }
              : { userAgent: 'codex-test', codexHome: cwd }
            : request.method === 'session/new'
              ? { sessionId: conversation, configOptions: [] }
              : request.method === 'thread/start'
                ? {
                    thread: {
                      id: conversation,
                      cwd,
                      canAcceptDirectInput: true,
                      status: { type: 'idle' }
                    }
                  }
                : request.method === 'turn/start'
                  ? { turn: { id: 'next-turn', status: 'inProgress' } }
                  : {};
        return { ...(brand === 'grok' ? { jsonrpc: '2.0' } : {}), id: request.id, result };
      });
      const cli = adapter.adapter(brand);
      assert.ok(cli);
      const session = cli.connect(pipe.transport, { cwd, startedAt: 1, sessionId: conversation });
      open.push(session);
      assert.equal(session.thread.historyState, undefined, 'a fresh session has no resume loading');
      assert.deepEqual(await session.opening, { ok: true });
      await session.thread.recovered;
      const routed = route.routeTo({ owned: session });
      assert.ok(!route.isRefused(routed) && routed.messages);

      const receipt = await routed.messages.send('next prompt');
      assert.ok(receipt.ok);
      assert.equal(receipt.queued, 0);
      assert.equal(session.state.queued.length, 1, 'capture keeps the outgoing row in the outbox');
      await until(
        () =>
          pipe.count(
            (message) =>
              message.type === 'user' ||
              message.method === 'session/prompt' ||
              message.method === 'turn/start'
          ) === 1,
        'the outgoing prompt reaches the pipe once'
      );
      const held = await routed.messages.send('later prompt');
      assert.ok(held.ok);
      assert.ok((held.queued ?? 0) > 0, 'the next send waits for the unacknowledged prompt');
      session.close();
    });
  }
});

describe('recovery boundary: Claude', () => {
  /** The CLI's own transcript, one user entry and one assistant entry per id. */
  async function transcript(conversation: string, ids: readonly string[]): Promise<string> {
    const file = claudeFiles.transcriptPath(cwd, conversation);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry = (id: string, at: number, role: 'user' | 'assistant') => ({
      type: role,
      uuid: `u-${role}-${id}`,
      timestamp: new Date(1_700_000_000_000 + at).toISOString(),
      message:
        role === 'user'
          ? { role, content: [{ type: 'text', text: `asked ${id}` }] }
          : { role, id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: `cli ${id}` }] }
    });
    await fs.writeFile(
      file,
      ids
        .flatMap((id, at) => [entry(id, at, 'user'), entry(id, at, 'assistant')])
        .map((one) => JSON.stringify(one))
        .join('\n') + '\n'
    );
    return file;
  }

  async function resume(cli: readonly string[], mode: Mode): Promise<void> {
    const conversation = randomUUID();
    const file = await transcript(conversation, cli);
    const mine: RecordLine[] = [
      { role: 'user', text: 'asked msg_1' },
      { role: 'assistant', text: 'ours msg_1', m: 'msg_1' }
    ];
    const theirs = await claudeFiles.readWitnessed(file);
    const { baseline, before } = expect(mode, mine, theirs, { key: 'msg_outside', from: 2 });
    const unlock = unreadable(conversation);
    const pipe = new Pipe(() => undefined);
    const session = new claude.OwnedSession(pipe.transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    await crossesOnce({
      session,
      conversation,
      prompts: () => pipe.count((message) => message.type === 'user'),
      during: () => {
        pipe.emit({
          type: 'assistant',
          parent_tool_use_id: null,
          session_id: conversation,
          message: {
            id: 'msg_live',
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: 'live words' }]
          }
        });
        pipe.emit({ type: 'result', subtype: 'success', session_id: conversation });
      },
      release: async () => {
        await recorded(conversation, mine);
        unlock();
      },
      before,
      baseline,
      live: 'live words',
      fed: ['live words', 'next prompt']
    });
    assert.equal(session.thread.snapshot().reconstructed, mode === 'theirs' ? true : undefined);
  }

  it('recovers our record when it witnessed the CLI, then sends once', async () => {
    await resume(['msg_1'], 'ours');
  });

  it('appends the messages the CLI took after ours, then sends once', async () => {
    await resume(['msg_1', 'msg_outside'], 'tail');
  });

  it("recovers the CLI's file when it holds a message we never saw before ours", async () => {
    await resume(['msg_0', 'msg_1'], 'theirs');
  });

  /** The CLI's file there and unreadable for the first read, then whole. */
  async function throughFailedHistory(mine: readonly RecordLine[]): Promise<void> {
    const conversation = randomUUID();
    const file = claudeFiles.transcriptPath(cwd, conversation);
    await fs.mkdir(file, { recursive: true });
    await recorded(conversation, mine);
    const session = new claude.OwnedSession(new Pipe(() => undefined).transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    await sleep(50);
    await resetDir(file);
    await transcript(conversation, ['msg_1', 'msg_outside']);
    await session.thread.recovered;
    assert.deepEqual(
      texts(session.thread.snapshot().recent.exchanges),
      texts((await claudeFiles.readWitnessed(file)).recent.exchanges),
      "a failed read of the CLI's file is retried, not taken as no history"
    );
  }

  it("retries the CLI's file that failed to read, with no record", async () => {
    await throughFailedHistory([]);
  });

  it("retries the CLI's file that failed to read, with a record that missed a message", async () => {
    await throughFailedHistory([
      { role: 'user', text: 'asked msg_outside' },
      { role: 'assistant', text: 'ours msg_outside', m: 'msg_outside' }
    ]);
  });
});

describe('End on an owned card', () => {
  /** End's decision for the card, as `closeSession` makes it — on an idle
   *  card, where only whether it has said anything decides. */
  async function plan(session: SessionHandle): Promise<string> {
    const card = {
      ...live.toSession(
        session.state,
        { pid: 4242, startedAt: 1, updatedAt: 1, brand: 'claude' },
        'w'
      ),
      status: 'idle' as const
    };
    const said = await adapter.hasExchanges(card, session);
    return closing.closePlan(card, [card], {
      alreadyDead: false,
      hasExchanges: said,
      processCount: 1
    }).kind;
  }

  it('confirms on a resumed card whose history is still being read', async () => {
    // Asked mid-recovery, memory holds none of it yet; the answer waits for it
    // rather than ending a conversation with history unasked.
    const conversation = randomUUID();
    const unlock = unreadable(conversation);
    const session = new claude.OwnedSession(new Pipe(() => undefined).transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    const asked = plan(session);
    await sleep(50);
    await recorded(conversation, [
      { role: 'user', text: 'asked before' },
      { role: 'assistant', text: 'answered before' }
    ]);
    unlock();
    assert.equal(await asked, 'confirm');
  });

  it('confirms on a resumed card whose recovery gave up, from the files', async () => {
    // A record that never reads: recovery gives up
    // after its retries and memory holds the pipe alone. The CLI's history still
    // says the conversation has turns, and End asks before it stops it.
    const conversation = randomUUID();
    unreadable(conversation);
    const file = claudeFiles.transcriptPath(cwd, conversation);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const turn = (role: 'user' | 'assistant', at: number) => ({
      type: role,
      uuid: `u-${role}`,
      timestamp: new Date(1_700_000_000_000 + at).toISOString(),
      message: { role, id: 'msg_1', content: [{ type: 'text', text: `${role} said` }] }
    });
    await fs.writeFile(
      file,
      [turn('user', 0), turn('assistant', 1)].map((one) => JSON.stringify(one)).join('\n') + '\n'
    );
    const session = new claude.OwnedSession(new Pipe(() => undefined).transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    assert.equal(await session.thread.recovered, false, 'gave up');
    assert.equal(session.thread.historyState, 'failed', 'exhausted recovery is not empty success');
    assert.deepEqual(session.thread.snapshot().recent.exchanges, []);
    assert.equal(await plan(session), 'confirm');
  });

  it('confirms on a card that has said anything this session, and stops one that has not', async () => {
    const pipe = new Pipe(() => undefined);
    const session = new claude.OwnedSession(pipe.transport, {
      cwd,
      startedAt: 1,
      sessionId: randomUUID()
    });
    open.push(session);
    assert.equal(await plan(session), 'stop', 'nothing said, nothing to lose');
    session.send('hello');
    await until(() => pipe.count((message) => message.type === 'user') > 0, 'the send left');
    assert.equal(await plan(session), 'confirm');
  });
});

describe('recovery boundary: Grok', () => {
  async function history(conversation: string, prompts: readonly number[]): Promise<string> {
    const file = grokFiles.grokTranscriptPath(cwd, conversation);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      prompts
        .flatMap((index) => [
          {
            type: 'user',
            content: [{ type: 'text', text: `<user_query>\nasked ${index}\n</user_query>` }],
            prompt_index: index
          },
          { type: 'assistant', content: `cli ${index}` }
        ])
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
    return file;
  }

  function peer(conversation: string): Pipe {
    return new Pipe((request) => {
      if (request.id === undefined || typeof request.method !== 'string') return undefined;
      if (request.method === 'session/prompt') return undefined;
      const result =
        request.method === 'initialize'
          ? { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] }
          : request.method === 'session/load'
            ? { sessionId: conversation, configOptions: [] }
            : {};
      return { jsonrpc: '2.0', id: request.id, result };
    });
  }

  /** `wake` is the prompt index of a turn Grok starts itself mid-recovery;
   *  `ours` the one prompt our record holds. */
  async function resume(
    prompts: readonly number[],
    mode: Mode,
    wake?: { index: number; drawn: boolean },
    ours = 0
  ): Promise<void> {
    const conversation = randomUUID();
    const file = await history(conversation, prompts);
    const mine: RecordLine[] = [
      { role: 'user', text: `asked ${ours}`, m: String(ours) },
      { role: 'assistant', text: `ours ${ours}` }
    ];
    const theirs = await grokFiles.readWitnessed(file);
    const { baseline, before } = expect(mode, mine, theirs, { key: String(ours + 1), from: 2 });
    const unlock = unreadable(conversation);
    const pipe = peer(conversation);
    const session = new grok.GrokSession(pipe.transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    assert.deepEqual(await session.opening, { ok: true });
    const update = (body: Message) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: conversation, update: body }
    });
    // A wake the history holds was answered there too: the pipe says the same.
    const answer = wake && !wake.drawn ? `cli ${wake.index}` : 'live words';
    await crossesOnce({
      session,
      conversation,
      prompts: () => pipe.count((message) => message.method === 'session/prompt'),
      // A turn Grok started itself — a background task's wake — is the frame
      // that can reach this pipe before anything of ours has been sent.
      during: () => {
        if (wake) {
          pipe.emit(
            update({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: `asked ${wake.index}` },
              _meta: { promptIndex: wake.index }
            })
          );
        }
        pipe.emit(
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: answer }
          })
        );
        pipe.emit(update({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }));
      },
      release: async () => {
        await recorded(conversation, mine);
        unlock();
      },
      before,
      baseline,
      live: answer,
      fed: wake?.drawn
        ? [`asked ${wake.index}`, answer, 'next prompt']
        : wake
          ? ['next prompt']
          : [answer, 'next prompt']
    });
  }

  it('recovers our record when it witnessed every prompt, then sends once', async () => {
    await resume([0], 'ours');
  });

  it('appends the prompts Grok took after ours, then sends once', async () => {
    await resume([0, 1], 'tail');
  });

  it("recovers Grok's history when it holds a prompt we never saw before ours", async () => {
    await resume([0, 1], 'theirs', undefined, 1);
  });

  // The CLI can file a wake's prompt before the read reaches it, and echo it on
  // the pipe too: the history is that turn's one copy.
  it('drops a wake the recovered history already holds', async () => {
    await resume([0, 1], 'tail', { index: 1, drawn: false });
  });

  it('keeps a wake the recovered history does not hold', async () => {
    await resume([0, 1], 'tail', { index: 2, drawn: true });
  });

  // The read caught the wake partway: its question and first row, a tool call
  // among it, are in the history; the row its next model call writes is not.
  it('reconciles a wake the history holds part of, by its rows, not its words', async () => {
    const conversation = randomUUID();
    const file = grokFiles.grokTranscriptPath(cwd, conversation);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const query = (text: string) => [
      { type: 'text', text: `<user_query>\n${text}\n</user_query>` }
    ];
    await fs.writeFile(
      file,
      [
        { type: 'user', content: query('asked 0'), prompt_index: 0 },
        { type: 'assistant', content: 'same words' },
        { type: 'user', content: query('wake question'), prompt_index: 1 },
        {
          type: 'assistant',
          content: 'wake answer',
          tool_calls: [
            { id: 'call-w-0', name: 'run_terminal_command', arguments: '{"command":"ls"}' }
          ]
        },
        { type: 'tool_result', tool_call_id: 'call-w-0', content: 'a.txt' }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
    const unlock = unreadable(conversation);
    const pipe = peer(conversation);
    const session = new grok.GrokSession(pipe.transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    assert.deepEqual(await session.opening, { ok: true });
    const update = (body: Message, meta: Message = {}) =>
      pipe.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: conversation, update: body, _meta: meta }
      });
    const call = { streamStartMs: 100, promptId: 'task-w' };
    update({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'wake question' },
      _meta: { promptIndex: 1 }
    });
    update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wake answer' } },
      call
    );
    update(
      { sessionUpdate: 'tool_call', toolCallId: 'call-w-0', title: 'run_terminal_command' },
      call
    );
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-w-0',
      status: 'completed',
      rawOutput: 'a.txt'
    });
    // Its next model call, after the read: no row of the history's.
    await sleep(50);
    unlock();
    update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'same words' } },
      { streamStartMs: 200, promptId: 'task-w' }
    );
    update({ sessionUpdate: 'turn_completed', prompt_id: 'task-w', stop_reason: 'end_turn' });
    await session.thread.recovered;
    await session.flush();
    const exchanges = session.thread.snapshot().recent.exchanges;
    assert.deepEqual(texts(exchanges), [
      'asked 0',
      'same words',
      'wake question',
      'wake answer',
      'same words'
    ]);
    const calls = exchanges
      .flatMap((x) => ('blocks' in x ? (x.blocks ?? []) : []))
      .flatMap((block) => ('call' in block ? [block.call.id] : []));
    assert.deepEqual(calls, ['call-w-0'], 'the call once');
    const read = await record.readRecordLines(conversation);
    const fold = new record.RecordFold();
    for (const line of read?.lines ?? []) fold.push(line);
    // No record shared a turn with the history, so it holds the pipe's alone.
    assert.deepEqual(texts(fold.snapshot().exchanges), ['same words'], 'and the record agrees');
  });

  /** Grok's history there and unreadable for the first read, then whole. */
  async function throughFailedHistory(mine: readonly RecordLine[]): Promise<void> {
    const conversation = randomUUID();
    const file = grokFiles.grokTranscriptPath(cwd, conversation);
    await fs.mkdir(file, { recursive: true });
    await recorded(conversation, mine);
    const session = new grok.GrokSession(peer(conversation).transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    assert.deepEqual(await session.opening, { ok: true });
    await sleep(50);
    await resetDir(file);
    await history(conversation, [0, 1]);
    await session.thread.recovered;
    assert.deepEqual(
      texts(session.thread.snapshot().recent.exchanges),
      texts((await grokFiles.readWitnessed(file)).recent.exchanges),
      "a failed read of Grok's history is retried, not taken as no history"
    );
  }

  it("retries Grok's history that failed to read, with no record", async () => {
    await throughFailedHistory([]);
  });

  it("retries Grok's history that failed to read, with a record that missed a prompt", async () => {
    await throughFailedHistory([
      { role: 'user', text: 'asked 1', m: '1' },
      { role: 'assistant', text: 'ours 1' }
    ]);
  });
});

describe('recovery boundary: Codex', () => {
  type Pages = { turns: unknown[]; items: unknown[] };

  function pages(ids: readonly string[]): Pages {
    return {
      turns: [{ id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2 }],
      items: [
        {
          turnId: 'turn-1',
          item: { type: 'userMessage', id: 'item-u', content: [{ type: 'text', text: 'asked' }] }
        },
        ...ids.map((id) => ({
          turnId: 'turn-1',
          item: { type: 'agentMessage', id, text: `cli ${id}` }
        }))
      ]
    };
  }

  /** The app-server: opens the thread, answers items, and holds the turn page
   *  until the test answers it — or fails it, when `failures` says so. */
  class Peer extends Pipe {
    turnPages: unknown[] = [];

    constructor(conversation: string, history: Pages, failures = 0) {
      super((request) => {
        const id = request.id;
        if (id === undefined || typeof request.method !== 'string') return undefined;
        switch (request.method) {
          case 'initialize':
            return { id, result: { userAgent: 'codex-test', codexHome: '/tmp/codex-home' } };
          case 'thread/resume':
            return {
              id,
              result: {
                thread: {
                  id: conversation,
                  cwd,
                  canAcceptDirectInput: true,
                  status: { type: 'idle' }
                }
              }
            };
          case 'thread/turns/list':
            if (failures-- > 0) return { id, error: { code: -32000, message: 'busy' } };
            this.turnPages.push(id);
            return undefined;
          case 'thread/items/list':
            return { id, result: { data: history.items, nextCursor: null } };
          case 'turn/start':
            return { id, result: { turn: { id: 'turn-live', status: 'inProgress' } } };
          default:
            return { id, result: {} };
        }
      });
      this.history = history;
    }

    private readonly history: Pages;

    answerTurns(): void {
      for (const id of this.turnPages.splice(0)) {
        this.emit({ id, result: { data: this.history.turns, nextCursor: null } });
      }
    }
  }

  async function expected(
    history: Pages,
    conversation: string
  ): Promise<{ recent: Recent; witnessed: ReadonlySet<string> }> {
    const read = await codexPages.readPaginated(
      {
        request: (method) =>
          Promise.resolve({
            data: method === 'thread/turns/list' ? history.turns : history.items,
            nextCursor: null
          })
      },
      { sessionId: conversation, cwd }
    );
    return read;
  }

  async function resume(cli: readonly string[], mode: Mode, failures = 0): Promise<void> {
    const conversation = randomUUID();
    const history = pages(cli);
    const mine: RecordLine[] = [
      { role: 'user', text: 'asked', m: 'item-u' },
      { role: 'assistant', text: 'ours item-a', m: 'item-a' }
    ];
    await recorded(conversation, mine);
    const theirs = await expected(history, conversation);
    const { baseline, before } = expect(mode, mine, theirs, { key: 'item-b', from: 2 });
    const pipe = new Peer(conversation, history, failures);
    const session = new codex.CodexSession(pipe.transport, {
      cwd,
      startedAt: 1,
      sessionId: conversation,
      resume: conversation
    });
    open.push(session);
    assert.deepEqual(await session.opening, { ok: true });
    await crossesOnce({
      session,
      conversation,
      prompts: () => pipe.count((message) => message.method === 'turn/start'),
      during: () => {
        pipe.emit({
          method: 'item/completed',
          params: {
            threadId: conversation,
            turnId: 'turn-0',
            item: { type: 'agentMessage', id: 'item-live', text: 'live words' }
          }
        });
      },
      release: async () => {
        await until(() => pipe.turnPages.length > 0, 'the history is asked for, on this pipe');
        pipe.answerTurns();
      },
      before,
      baseline,
      live: 'live words',
      fed: ['live words', 'next prompt']
    });
    assert.equal(
      pipe.count((message) => message.method === 'initialize'),
      1,
      'one app-server, the one driving the thread'
    );
  }

  it('recovers our record when it witnessed every item, then sends once', async () => {
    await resume(['item-a'], 'ours');
  });

  it('appends the items the app-server took after ours, then sends once', async () => {
    await resume(['item-a', 'item-b'], 'tail');
  });

  it("recovers the app-server's history when it holds an item we never saw before ours", async () => {
    await resume(['item-0', 'item-a'], 'theirs');
  });

  it('retries a history request that failed rather than recovering nothing', async () => {
    // Drawable, so the retry reads our record again — after the frames above
    // have been teed, which is the read that must not find them there.
    await resume(['item-a'], 'ours', 1);
  });
});
