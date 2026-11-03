import { incomingPlatformFixture, INCOMING_TEST_MS } from './incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, type TestContext } from 'node:test';
import type { SessionHandle } from '../../core/adapter';
import type { FakeMessenger, FakeOptions, FakePost } from '../../core/bridge/fake';
import type { Posted, SenderId } from '../../core/bridge/model';
import type { Reply } from '../../core/coordination/requests';
import { IDENTITY_ENV } from '../../core/identity';
import type { BrandId } from '../../core/model';
import { tempHome } from '../helpers';
import type { Arm, HolderWindow, Live, TestWindow } from './remote_helpers';

/** Loaded after `tempHome`, so every store resolves under the temp `HOME`. */
let h: typeof import('./remote_helpers');
let words: typeof import('../../core/bridge/words');
let store: typeof import('../../core/bridge/store');
let jobs: typeof import('../../core/bridge/jobs');
let paths: typeof import('../../core/paths');
let record: typeof import('../../core/record');
let answer: typeof import('../../core/coordination/answer');
let awake: typeof import('../../core/awake');
let scan: typeof import('../../core/scan');
let transcript: typeof import('../../core/transcript');
let attachCli: typeof import('../../cli/attach');
let rules: typeof import('../../core/remote/attach');
let served: typeof import('../../core/remote/serve_attach');
let claims: typeof import('../../core/coordination/claims');
let asking: typeof import('../../core/coordination/ask');
let views: typeof import('../../ui/views');
let home: string;

let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  h = await import('./remote_helpers');
  words = await import('../../core/bridge/words');
  store = await import('../../core/bridge/store');
  jobs = await import('../../core/bridge/jobs');
  paths = await import('../../core/paths');
  record = await import('../../core/record');
  answer = await import('../../core/coordination/answer');
  awake = await import('../../core/awake');
  scan = await import('../../core/scan');
  transcript = await import('../../core/transcript');
  attachCli = await import('../../cli/attach');
  rules = await import('../../core/remote/attach');
  served = await import('../../core/remote/serve_attach');
  claims = await import('../../core/coordination/claims');
  asking = await import('../../core/coordination/ask');
  views = await import('../../ui/views');
});

beforeEach(async () => {
  await fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true });
  await fs.rm(paths.HEARD_FILE, { force: true });
});
afterEach(() => h.disposeAll());

/**
 * What each brand's fake does with a prompt (`fixtures/`). Every prompt below
 * is worded clear of the other words those fakes script a turn on.
 */
type Profile = {
  /** A turn that opens one question and waits on it. */
  question: string;
  /** A turn that asks one permission and waits on it. */
  permission: string;
  /** A turn that runs until it is interrupted. */
  slow: string;
  /** What a plain turn ends on. */
  answer(prompt: string): string;
  /** Where a Deny that reached the child shows. */
  denied(live: Live): Promise<string>;
};

const PROFILES: Record<BrandId, Profile> = {
  claude: {
    question: 'ask me first',
    permission: 'write the notes',
    slow: 'slow down',
    answer: (prompt) => prompt,
    // The fake says back every control response it is handed.
    denied: (live) => Promise.resolve(allText(live.handle))
  },
  grok: {
    question: 'ask me first',
    permission: 'perm for the notes',
    slow: 'slow down',
    answer: () => 'pong',
    denied: (live) => Promise.resolve(allText(live.handle))
  },
  codex: {
    question: 'question request',
    permission: 'patch request',
    slow: 'slow down',
    answer: (prompt) => prompt,
    // The fake logs every decision it matched to one of its requests.
    denied: () => fs.readFile(path.join(home, '.codex', 'fake-answers.log'), 'utf8').catch(() => '')
  }
};

const DENIED_AS: Record<BrandId, RegExp> = {
  claude: /"behavior":"deny"/,
  grok: /reject-once/,
  codex: /decline/
};

/**
 * The two ways a messenger groups a conversation, replied to as its people
 * reply, as M0's scenarios run them. The chain shape has a 64-byte payload
 * and no edit, so every settle is a follow-up post.
 */
const SHAPES = [
  {
    name: 'thread',
    fake: { shape: 'thread' } satisfies FakeOptions,
    reply: (m: FakeMessenger, to: Posted, text: string, sender: SenderId = h.OWNER) =>
      m.say(sender, text, { in: to.anchor })
  },
  {
    name: 'chain',
    fake: { shape: 'chain', payloadMax: 64, edit: false } satisfies FakeOptions,
    reply: (m: FakeMessenger, to: Posted, text: string, sender: SenderId = h.OWNER) =>
      m.say(sender, text, { replyTo: to.message })
  }
] as const;

type Shape = (typeof SHAPES)[number];
const BRANDS: readonly BrandId[] = ['claude', 'grok', 'codex'];

/**
 * The shape each brand's scenarios run in. A shape is the messenger's side
 * and a brand the session's, and neither reads the other, so every scenario
 * runs once per brand and in both shapes without the whole product — which
 * would double a file of real child processes to prove nothing more.
 */
const SHAPE_OF: Record<BrandId, Shape> = {
  claude: SHAPES[0],
  grok: SHAPES[1],
  codex: SHAPES[0]
};

/** Remote held in window A; the sessions in window B. */
type Rig = { a: HolderWindow; b: TestWindow; brand: BrandId; shape: Shape; p: Profile };

let windows = 0;
const fresh = (name: string) => `${name}-${++windows}`;

/** Every holder window opened, for the token proof's read of their logs. */
const holders: HolderWindow[] = [];

async function holder(
  brand: BrandId,
  options: Parameters<typeof h.holderWindow>[2] = {}
): Promise<HolderWindow> {
  const a = await h.holderWindow(fresh('A'), brand, options);
  holders.push(a);
  return a;
}

async function rig(brand: BrandId, shape: Shape): Promise<Rig> {
  const a = await holder(brand, { folder: path.join(home, 'work', 'app'), fake: shape.fake });
  const b = await h.testWindow(fresh('B'), brand, { folder: path.join(home, 'work', 'site') });
  assert.deepEqual(await a.turnOn(), { ok: true });
  return { a, b, brand, shape, p: PROFILES[brand] };
}

/** Every word of a session's thread, settled and streaming. */
function allText(handle: SessionHandle): string {
  const shot = handle.thread.snapshot();
  return [...shot.history.exchanges, ...shot.tail.map((row) => row.exchange)]
    .map((row) => ('text' in row ? row.text : ''))
    .join('\n');
}

for (const brand of BRANDS) {
  it(`${brand}: recovers lost start/send acknowledgments from published message facts without replay`, async () => {
    const { a, b } = await rig(brand, SHAPE_OF[brand]);
    const remoteVerbs = await import('../../core/remote/verbs');
    const published = await import('../../core/published');
    const remoteBoard = await import('../../core/remote/board');
    let attempts = 0;
    const verbs = remoteVerbs.remoteVerbs({
      windowId: a.id,
      owned: () => undefined,
      end: () => false,
      start: () => Promise.reject(new Error('must reach owning window')),
      ask: async (body, timeout) => {
        attempts++;
        const accepted = await asking.ask(body, timeout);
        assert.equal(
          accepted.ok,
          true,
          'owning window accepted before its acknowledgment was lost'
        );
        return { ok: false, kind: 'silent', reason: asking.UNANSWERED, file: 'lost-reply' };
      },
      board: () => [],
      claims: () => claims.readClaims(),
      signal: () => Promise.resolve([])
    });
    const startCorrelation = `initial-${brand}`;
    const started = await verbs.start({
      windowId: b.id,
      cwd: b.folder,
      prompt: 'same words',
      correlation: startCorrelation
    });
    assert.deepEqual(started, { ok: false, reason: asking.UNANSWERED, unsure: true });
    assert.equal(b.pids().length, 1);
    const pid = b.pids()[0];
    assert.ok(pid);
    const live = b.live(pid);
    await b.until(
      pid,
      'initial prompt fact',
      (state) =>
        state.messageFacts?.some(
          (fact) => fact.correlation === startCorrelation && fact.phase === 'done'
        ) === true
    );
    const sendCorrelation = `reply-${brand}`;
    const sent = await verbs.send(live.addr, 'same words', sendCorrelation);
    assert.deepEqual(sent, { ok: false, reason: asking.UNANSWERED, unsure: true });
    await b.until(
      pid,
      'reply fact',
      (state) =>
        state.messageFacts?.some(
          (fact) => fact.correlation === sendCorrelation && fact.phase === 'done'
        ) === true
    );
    await b.settled();
    const files = await published.readPublished();
    const starts = new Map([[pid, live.startedAt]]);
    const foreign = remoteBoard.remoteBoard({
      windowId: a.id,
      own: [],
      published: files,
      starts,
      lineage: new Map()
    });
    const local = remoteBoard.remoteBoard({
      windowId: b.id,
      own: [
        {
          session: b.session(pid),
          pending: live.handle.state.pending,
          messageFacts: live.handle.state.messageFacts
        }
      ],
      published: files,
      starts,
      lineage: new Map()
    });
    assert.deepEqual(foreign[0]?.messageFacts, local[0]?.messageFacts);
    for (const correlation of [startCorrelation, sendCorrelation]) {
      assert.ok(
        foreign[0]?.messageFacts?.some(
          (fact) => fact.correlation === correlation && fact.phase === 'done'
        )
      );
    }
    assert.equal(attempts, 2);
    assert.equal(live.handle.state.turnsEnded, 2);
    assert.equal(b.served.filter((request) => request.kind === 'open').length, 1);
    assert.equal(b.served.filter((request) => request.kind === 'send').length, 1);
  });
}

const turns = (t: TestWindow, live: Live, n: number) =>
  t.until(
    live.pid,
    `turn ${n} to end`,
    (s) => s.turnsEnded === n && !s.running && !s.queued.length
  );

function last(a: HolderWindow): FakePost {
  const post = a.messenger.posts().at(-1);
  assert.ok(post, 'nothing was posted');
  return post;
}

function postsSince(a: HolderWindow, count: number): FakePost[] {
  return a.messenger.posts().slice(count);
}

function only(posts: readonly FakePost[], kind: string): FakePost {
  const found = posts.filter((post) => post.notice.kind === kind);
  const all = posts.map((p) => p.notice.kind).join(', ');
  assert.equal(found.length, 1, `one ${kind} notice, of ${all}`);
  return found[0] as FakePost;
}

function inConversationOf(post: FakePost, opener: FakePost): void {
  assert.ok('conversation' in post.place, `${post.notice.kind} was not posted in a conversation`);
  assert.equal(post.posted.anchor, opener.posted.anchor);
}

function settledAs(a: HolderWindow, notice: FakePost, word: string): void {
  if (a.messenger.edit) {
    const edited = a.messenger
      .settles()
      .some((s) => s.message === notice.posted.message && s.notice.settled === word);
    assert.ok(edited, `not settled as "${word}"`);
    return;
  }
  const said = a.messenger
    .posts()
    .some((p) => p.notice.body === word && p.posted.anchor === notice.posted.anchor);
  assert.ok(said, `no follow-up saying "${word}"`);
}

function button(post: FakePost, label: string): string {
  const found = post.notice.buttons?.find((b) => b.label === label);
  assert.ok(found, `no ${label} button on the ${post.notice.kind} notice`);
  return found.payload;
}

const kinds = (t: TestWindow) => t.served.map((request) => request.kind);

/** A root in B that has finished a turn the panel gave it, and so has a
 *  conversation at the owner's home. The first pass is its baseline. */
async function rootWithConversation(t: Rig, text = 'hello there') {
  const root = await t.b.start();
  await t.a.pass();
  await t.b.say(root.pid, text);
  await turns(t.b, root, 1);
  await t.a.pass();
  const opener = last(t.a);
  assert.equal(opener.notice.kind, 'finished');
  assert.deepEqual(opener.place, { home: h.OWNER });
  return { root, opener };
}

async function alive(pid: number): Promise<boolean> {
  return (await scan.scanProcesses(true)).starts.has(pid);
}

async function gone(pid: number): Promise<void> {
  await h.until(`pid ${pid} to exit`, async () => ((await alive(pid)) ? undefined : true));
}

/** Remote held in A with `serveAttach` on its claim loop, as `serveRequest`
 *  answers `attach` before any owned lookup; the sessions in B. */
async function attachRig(brand: BrandId, shape: Shape): Promise<Rig> {
  // The arm is handed to the window it serves, so it reads that window late.
  const self: { a?: HolderWindow } = {};
  const arm: Arm = (request) =>
    request.kind === 'attach' && self.a
      ? served.serveAttach(request, self.a.attachPort())
      : undefined;
  const a = await holder(brand, {
    folder: path.join(home, 'work', 'app'),
    fake: shape.fake,
    arms: [arm]
  });
  self.a = a;
  const b = await h.testWindow(fresh('B'), brand, { folder: path.join(home, 'work', 'site') });
  assert.deepEqual(await a.turnOn(), { ok: true });
  return { a, b, brand, shape, p: PROFILES[brand] };
}

/** What `live`'s CLI plants for its shell tools, by the identity table. */
function planted(live: Live): NodeJS.ProcessEnv {
  const names = IDENTITY_ENV[live.brand];
  return {
    [names.id]: live.sessionId,
    ...(names.marker === undefined ? {} : { [names.marker]: '1' }),
    ...(names.pid === undefined ? {} : { [names.pid]: String(live.pid) })
  };
}

/**
 * `squadron-attach` as an agent in `live` runs it, less `loadBoard`, which
 * sees a fake CLI only through smoke's twin fixture: B's records stand in for
 * the board, the shell is in the session's cwd, and the request the shim's
 * own `readPlan` builds goes to the holder as a real request file.
 */
async function agentAttaches(
  t: Rig,
  live: Live,
  file: string,
  caption?: string,
  between?: () => Promise<void>
): Promise<{ plan: import('../../cli/attach').AttachPlan; reply: Reply }> {
  const sessions = t.b.pids().map((pid) => t.b.session(pid));
  const opts = { 'file-path': file, ...(caption === undefined ? {} : { caption }) };
  const cwd = t.b.session(live.pid).cwd;
  const plan = await attachCli.readPlan(opts, sessions, planted(live), cwd);
  assert.ok(plan.ok, plan.ok ? '' : plan.reason);
  await between?.();
  const result = await asking.ask(plan.body, rules.ATTACH_REPLY_MS);
  if (result.ok || result.kind === 'refused') return { plan, reply: result.reply };
  throw new Error(result.reason);
}

/** A PNG's bytes in a session's working directory. */
async function png(live: Live, t: Rig, name = 'graph.png'): Promise<string> {
  const at = path.join(t.b.session(live.pid).cwd, name);
  await fs.writeFile(at, Buffer.from('89504e470d0a1a0a', 'hex'));
  return at;
}

for (const brand of BRANDS) {
  const shape = SHAPE_OF[brand];
  describe(`PRD scenarios across two windows: ${brand}, ${shape.name} mode`, () => {
    it('1. dinner: B’s finish is posted with its text, a reply drains into it, the next finish lands in the same conversation', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      assert.equal(opener.notice.mention, h.OWNER);
      assert.ok(opener.notice.body.includes(t.p.answer('hello there')));

      shape.reply(t.a.messenger, opener.posted, 'carry on please');
      await t.a.drain();
      const sent = t.b.served.at(-1);
      assert.equal(sent?.kind, 'send');
      assert.equal(sent?.kind === 'send' ? sent.text : '', 'carry on please');
      await turns(t.b, root, 2);
      await t.a.pass();
      const next = last(t.a);
      assert.equal(next.notice.kind, 'finished');
      inConversationOf(next, opener);
      assert.ok(next.notice.body.includes(t.p.answer('carry on please')));
    });

    it('1b. dinner, coalesced: a reply held behind the turn it drains after, and both finishes posted', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      await t.b.say(root.pid, t.p.permission);
      await t.b.until(root.pid, 'a permission', (s) => s.pending.length === 1);
      await t.a.pass();
      const before = t.a.messenger.posts().length;

      // Held while the root waits, then delivered when the turn ends: the
      // turn it starts asks again, so both passes see the root waiting.
      shape.reply(t.a.messenger, opener.posted, `${t.p.permission} again`);
      await t.a.drain();
      assert.equal(last(t.a).notice.kind, 'receipt');
      const first = t.b.live(root.pid).handle.state.pending[0];
      assert.ok(first);
      assert.ok(t.b.live(root.pid).handle.asks?.respond(first.requestId, { allow: true }));
      await t.b.until(
        root.pid,
        'the held reply to start a turn that asks again',
        (s) => s.turnsEnded === 2 && s.pending.length === 1 && !s.queued.length
      );
      // What the ended turn said, read off B's thread before the prompt the
      // held reply wrote: the coalesced finish quotes it, and never the turn
      // already in flight.
      const shot = t.b.live(root.pid).handle.thread.snapshot();
      const thread = [...shot.history.exchanges, ...shot.tail.map((row) => row.exchange)];
      const prompts = thread.flatMap((row, i) => ('role' in row && row.role === 'user' ? [i] : []));
      const begun = prompts.at(-1) ?? thread.length;
      const ended = transcript.lastAnswer(thread.slice(0, begun));
      await t.a.pass();
      const coalesced = only(postsSince(t.a, before), 'finished');
      inConversationOf(coalesced, opener);
      assert.ok(coalesced.notice.body.includes(ended ?? ''), coalesced.notice.body);
      if (brand === 'claude') assert.match(coalesced.notice.body, /"behavior":"allow"/);

      const second = t.b.live(root.pid).handle.state.pending[0];
      assert.ok(second);
      assert.ok(t.b.live(root.pid).handle.asks?.respond(second.requestId, { allow: true }));
      await turns(t.b, root, 3);
      const count = t.a.messenger.posts().length;
      await t.a.pass();
      inConversationOf(only(postsSince(t.a, count), 'finished'), opener);
    });

    it('2. the boss in two windows: a folder per window, a tap starts in B, and the answer lands in that conversation', async () => {
      const t = await rig(brand, shape);
      const asked = t.a.messenger.say(h.OWNER, 'what does the backoff here do?');
      assert.ok(asked?.kind === 'message');
      await t.a.drain();
      const picker = last(t.a);
      assert.equal(picker.notice.kind, 'picker');
      assert.deepEqual(
        picker.notice.buttons?.map((b) => b.label),
        ['app', 'site', 'Cancel']
      );
      assert.equal(t.b.served.length, 0, 'held until a folder is picked');

      t.a.messenger.press(h.OWNER, button(picker, 'site'));
      await t.a.drain();
      assert.equal(t.b.pids().length, 0, 'model choices still hold the prompt');
      t.a.messenger.press(h.OWNER, button(last(t.a), 'Use window default'));
      await t.a.drain();
      const open = t.b.served.at(-1);
      assert.equal(open?.kind, 'open');
      assert.equal(open?.kind === 'open' ? open.via : undefined, 'remote');
      settledAs(t.a, picker, 'Choice updated');
      const job = t.b.pids().at(-1);
      assert.ok(job !== undefined);
      await turns(t.b, t.b.live(job), 1);

      await t.a.pass();
      const done = last(t.a);
      assert.equal(done.notice.kind, 'finished', 'a turn that ended before any pass is posted');
      inConversationOf(done, picker);
      assert.ok(done.notice.body.includes(t.p.answer('what does the backoff here do?')));
    });

    it('3. a child’s permission in B: posted in its root’s conversation, Deny reaches it as a deny, End takes it', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      const child = await t.b.start({ parent: root.sessionId, prompt: t.p.permission });
      await t.b.until(child.pid, 'a permission', (s) => s.pending.length === 1);
      await t.a.pass();
      const asks = last(t.a);
      assert.equal(asks.notice.kind, 'permission');
      inConversationOf(asks, opener);
      assert.match(asks.notice.head ?? '', /spawned by/);
      assert.deepEqual(
        asks.notice.buttons?.map((b) => b.label),
        ['Deny', 'End'],
        'no Allow from a phone (D18)'
      );

      t.a.messenger.press(h.OWNER, button(asks, 'Deny'));
      await t.a.drain();
      assert.equal(kinds(t.b).at(-1), 'deny');
      settledAs(t.a, asks, words.DENIED);
      await t.b.until(child.pid, 'the deny to close the request', (s) => !s.pending.length);
      assert.match(
        await h.until('the deny', async () => {
          const said = await t.p.denied(child);
          return DENIED_AS[brand].test(said) ? said : undefined;
        }),
        DENIED_AS[brand]
      );

      await t.a.pass();
      t.a.messenger.command(h.OWNER, 'end', String(child.pid));
      await t.a.drain();
      const confirm = last(t.a);
      assert.equal(confirm.notice.kind, 'confirm');
      t.a.messenger.press(h.OWNER, button(confirm, 'End'));
      await t.a.drain();
      assert.equal(kinds(t.b).at(-1), 'close');
      settledAs(t.a, confirm, words.ENDED);
      assert.equal(t.b.holdsPid(child.pid), false);
      assert.equal(t.b.holdsPid(root.pid), true, 'the root is still running');
      await gone(child.pid);
    });

    it('4. a child’s question in B: posted in its root’s conversation, and typed text reaches the root', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      const child = await t.b.start({ parent: root.sessionId, prompt: t.p.question });
      await t.b.until(child.pid, 'a question', (s) => s.pending.length === 1);
      await t.a.pass();
      const asks = last(t.a);
      assert.equal(asks.notice.kind, 'question');
      inConversationOf(asks, opener);
      assert.match(asks.notice.head ?? '', /spawned by/);

      shape.reply(t.a.messenger, asks.posted, 'use the second option');
      await t.a.drain();
      const sent = t.b.served.at(-1);
      assert.equal(sent?.kind, 'send', 'typed text never answers a child (D17)');
      assert.equal(sent?.kind === 'send' ? sent.pid : 0, root.pid);
      await turns(t.b, root, 2);
      assert.equal(t.b.live(child.pid).handle.state.pending.length, 1);
    });

    it('5. an ended root: a reply starts a fresh session in B with the pointer line, in the same conversation', async (context) => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      assert.ok(t.b.end(root.pid, root.startedAt));
      await gone(root.pid);
      await t.a.pass();

      shape.reply(t.a.messenger, opener.posted, 'keep going with the docs');
      await t.a.drain();
      const ended = t.a.messenger.posts().find((p) => p.notice.kind === 'ended');
      assert.ok(ended);
      inConversationOf(ended, opener);
      const open = t.b.served.at(-1);
      assert.ok(open?.kind === 'open');
      assert.equal(open.via, 'remote');
      assert.equal(open.brand, brand, 'the ended root’s brand');
      assert.equal(open.cwd, t.b.folder);
      assert.equal(
        open.prompt,
        jobs.freshPrompt('keep going with the docs', record.recordFile(root.sessionId))
      );

      const next = t.b.pids().at(-1);
      assert.ok(next !== undefined && next !== root.pid);
      try {
        await turns(t.b, t.b.live(next), 1);
      } finally {
        context.diagnostic(JSON.stringify(t.b.evidence(next)));
      }
      await t.a.pass();
      const done = last(t.a);
      assert.equal(done.notice.kind, 'finished');
      inConversationOf(done, opener);
      const [kept] = await store.readConversations();
      assert.deepEqual(kept?.past, [root.sessionId]);
      assert.equal(kept?.root?.pid, next);
    });

    it('5. a root in A whose CLI dies mid-turn: one stopped notice, then a reply starts afresh in A', async () => {
      const t = await rig(brand, shape);
      const root = await t.a.start();
      await t.a.pass();
      await t.a.say(root.pid, 'hello there');
      await turns(t.a, root, 1);
      await t.a.pass();
      const opener = last(t.a);
      assert.equal(opener.notice.kind, 'finished');
      await t.a.say(root.pid, t.p.slow);
      await t.a.until(root.pid, 'a busy turn', (s) => s.running);
      await t.a.pass();
      process.kill(root.pid, 'SIGKILL');
      await t.a.until(root.pid, 'the exit', (s) => s.exit !== undefined);
      await t.a.pass();
      await t.a.pass();
      const stopped = t.a.messenger.posts().filter((p) => p.notice.kind === 'stopped');
      assert.equal(stopped.length, 1);
      const [only] = stopped;
      assert.ok(only);
      inConversationOf(only, opener);
      assert.equal(only.notice.mention, h.OWNER);

      shape.reply(t.a.messenger, opener.posted, 'keep going with the docs');
      await t.a.drain();
      assert.equal(last(t.a).notice.kind, 'ended');
      const next = t.a.pids().at(-1);
      assert.ok(next !== undefined && next !== root.pid, 'a fresh session, not the dead outbox');
      assert.equal(t.a.live(next).handle.state.exit, undefined);
    });

    it('6. a stranger: nothing is posted and no request is written', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      await t.b.say(root.pid, t.p.permission);
      await t.b.until(root.pid, 'a permission', (s) => s.pending.length === 1);
      await t.a.pass();
      const asks = last(t.a);
      const posts = t.a.messenger.posts().length;
      const served = t.b.served.length;
      const files = await conversationFiles();

      t.a.messenger.say(h.STRANGER, '@squadron what are you doing?', { addressed: 'mention' });
      shape.reply(t.a.messenger, opener.posted, 'end it all', h.STRANGER);
      t.a.messenger.press(h.STRANGER, button(asks, 'Deny'));
      t.a.messenger.command(h.STRANGER, 'list');
      t.a.messenger.command(h.STRANGER, 'end', String(root.pid));
      await t.a.drain();
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(t.a.messenger.posts().length, posts);
      assert.equal(t.a.messenger.settles().length, 0);
      assert.equal(t.b.served.length, served);
      assert.deepEqual(await conversationFiles(), files);
      assert.equal(t.b.live(root.pid).handle.state.pending.length, 1);
    });

    it('7. Remote never turned on: nothing under remote/, no holder, and keep-awake’s verdicts unchanged', async () => {
      const a = await holder(brand, { fake: shape.fake });
      const b = await h.testWindow(fresh('B'), brand);
      const busy = await b.start({ prompt: PROFILES[brand].slow });
      const asking = await b.start({ prompt: PROFILES[brand].permission });
      await b.until(busy.pid, 'a busy turn', (s) => s.running);
      await b.until(asking.pid, 'a permission', (s) => s.pending.length === 1);
      await b.settled();

      assert.equal(a.holds(), false);
      assert.deepEqual(await filesUnder(paths.REMOTE_DIR), []);
      await assert.rejects(fs.access(paths.HOLDER_FILE));
      assert.equal(a.messenger.posts().length, 0);
      const sessions = [b.session(busy.pid), b.session(asking.pid)];
      const input = {
        sessions,
        power: { pct: 90, onAC: false },
        now: Date.now(),
        enabled: true,
        holds: true
      };
      for (const at of [input, { ...input, sessions: [] }]) {
        assert.deepEqual(awake.decide({ ...at, remote: a.holds() }), awake.decide(at));
      }
    });
  });

  describe(`Remote's verbs on B's sessions: ${brand}, ${shape.name} mode`, () => {
    it('Stop on a busy root in B', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      await t.b.say(root.pid, t.p.slow);
      await t.b.until(root.pid, 'a busy turn', (s) => s.running);
      await t.a.pass();

      shape.reply(t.a.messenger, opener.posted, 'carry on please');
      await t.a.drain();
      const receipt = last(t.a);
      assert.equal(receipt.notice.kind, 'receipt');
      t.a.messenger.press(h.OWNER, button(receipt, 'Stop'));
      await t.a.drain();
      assert.equal(kinds(t.b).at(-1), 'interrupt');
      settledAs(t.a, receipt, words.STOPPED);
      // The interrupted turn, then the held reply's own.
      await turns(t.b, root, 3);
      await t.a.pass();
      assert.equal(last(t.a).notice.kind, 'finished');
    });

    it('Stop on a turn begun since the last pass interrupts it', async () => {
      // No pass between the turn beginning and the press: the board reads it
      // idle, and the window holding the pipe is the one that knows.
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      await t.b.say(root.pid, t.p.slow);
      await t.b.until(root.pid, 'a busy turn', (s) => s.running);

      shape.reply(t.a.messenger, opener.posted, 'carry on please');
      await t.a.drain();
      const receipt = last(t.a);
      assert.equal(receipt.notice.kind, 'receipt');
      t.a.messenger.press(h.OWNER, button(receipt, 'Stop'));
      await t.a.drain();
      assert.equal(kinds(t.b).at(-1), 'interrupt');
      settledAs(t.a, receipt, words.STOPPED);
      await turns(t.b, root, 3);
    });

    it('End on a busy root with children in A and B: one confirm, then all three end', async () => {
      const t = await rig(brand, shape);
      const root = await t.b.start({ prompt: t.p.slow });
      await t.b.until(root.pid, 'a busy turn', (s) => s.running);
      const there = await t.b.start({ parent: root.sessionId });
      const here = await t.a.start({ parent: root.sessionId });
      await t.a.pass();

      t.a.messenger.command(h.OWNER, 'end', String(root.pid));
      await t.a.drain();
      const confirm = last(t.a);
      assert.equal(confirm.notice.kind, 'confirm');
      assert.match(confirm.notice.body, /and the 2 sessions it started\?$/);
      t.a.messenger.press(h.OWNER, button(confirm, 'End'));
      await t.a.drain();
      settledAs(t.a, confirm, words.ENDED);
      assert.deepEqual(
        t.b.served
          .filter((r) => r.kind === 'close')
          .map((r) => ('pid' in r ? r.pid : 0))
          .sort(),
        [root.pid, there.pid].sort()
      );
      assert.equal(t.a.holdsPid(here.pid), false, 'ended in memory, in the holder’s own window');
      for (const one of [root, there, here]) await gone(one.pid);
    });

    it('a person’s answer to an open question in B arrives as the root’s next prompt', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      await t.b.say(root.pid, t.p.question);
      await t.b.until(root.pid, 'a question', (s) => s.pending.length === 1);
      await t.a.pass();
      const asks = last(t.a);
      assert.equal(asks.notice.kind, 'question');
      inConversationOf(asks, opener);

      shape.reply(t.a.messenger, asks.posted, 'the second one');
      await t.a.drain();
      assert.equal(kinds(t.b).at(-1), 'personAnswer');
      await turns(t.b, root, 3);
      const said = allText(t.b.live(root.pid).handle);
      assert.ok(said.includes('the second one'));
      await t.a.pass();
      settledAs(t.a, asks, words.NO_LONGER_WAITING);
    });

    it('attachTarget finds a child spawned in B since the last pass, and the next pass posts nothing twice', async () => {
      const t = await rig(brand, shape);
      const { root, opener } = await rootWithConversation(t);
      const child = await t.b.start({ parent: root.sessionId, prompt: t.p.permission });
      await t.b.until(child.pid, 'a permission', (s) => s.pending.length === 1);
      const before = t.a.messenger.posts().length;

      const target = await t.a.attachTarget(child.addr);
      assert.ok(target.ok, target.ok ? '' : target.reason);
      assert.equal(target.session.pid, child.pid);
      assert.equal(target.maxBytes, t.a.messenger.files?.maxBytes);
      const early = postsSince(t.a, before);
      inConversationOf(only(early, 'permission'), opener);

      await t.a.pass();
      assert.equal(t.a.messenger.posts().length, before + early.length, 'no edge posted twice');
    });

    it('an agent’s file opens its root’s conversation, and a reply to it reaches the root (R3)', async () => {
      const t = await rig(brand, shape);
      const root = await t.b.start();
      await t.a.pass();
      const sent = await t.a.attach(root.addr, {
        bytes: Buffer.from('png'),
        name: 'graph.png',
        mime: 'image/png',
        caption: 'Latency before and after.'
      });
      assert.deepEqual(sent, { ok: true });
      const opener = last(t.a);
      assert.equal(opener.notice.kind, 'attached');
      assert.deepEqual(opener.place, { home: h.OWNER });
      const [file] = t.a.messenger.attachments();
      assert.ok(file);
      assert.equal(file.posted.anchor, opener.posted.anchor);

      shape.reply(t.a.messenger, file.posted, 'zoom into the tail');
      await t.a.drain();
      const reply = t.b.served.at(-1);
      assert.equal(reply?.kind === 'send' ? reply.pid : 0, root.pid);
      await turns(t.b, root, 1);
    });
  });

  describe(`An agent’s file across two windows: ${brand}, ${shape.name} mode`, () => {
    it(
      'a root with a conversation attaches a PNG from its cwd: one file there, with the caption, and no mention',
      {},
      async () => {
        const t = await attachRig(brand, shape);
        const { root, opener } = await rootWithConversation(t);
        const at = await png(root, t);
        const before = t.a.messenger.posts().length;

        const { plan, reply } = await agentAttaches(t, root, at, 'Latency before and after.');
        assert.deepEqual(reply, { ok: true });
        assert.equal(plan.ok && plan.body.windowId, t.a.id, 'addressed to the holder');
        assert.equal(plan.ok && plan.body.sessionWindowId, t.b.id);
        assert.deepEqual(postsSince(t.a, before), [], 'no notice, so no mention');
        const files = t.a.messenger.attachments();
        assert.equal(files.length, 1);
        const [file] = files;
        assert.ok(file);
        assert.equal(file.posted.anchor, opener.posted.anchor);
        assert.equal(file.attachment.name, 'graph.png');
        assert.equal(file.attachment.mime, 'image/png');
        assert.equal(file.attachment.caption, 'Latency before and after.');
        assert.equal(file.attachment.head, undefined);
        assert.ok(!kinds(t.b).includes('attach'), 'the session’s window is never asked');
      }
    );

    it(
      'a root with no conversation attaches: the opening notice, then the file, and its finish lands there too',
      {},
      async () => {
        const t = await attachRig(brand, shape);
        const root = await t.b.start();
        await t.a.pass();
        const at = await png(root, t);

        const { reply } = await agentAttaches(t, root, at);
        assert.deepEqual(reply, { ok: true });
        const opener = only(t.a.messenger.posts(), 'attached');
        assert.deepEqual(opener.place, { home: h.OWNER });
        assert.equal(opener.notice.mention, h.OWNER);
        assert.ok(opener.notice.head);
        const [file] = t.a.messenger.attachments();
        assert.ok(file);
        assert.equal(file.posted.anchor, opener.posted.anchor);

        await t.b.say(root.pid, 'hello there');
        await turns(t.b, root, 1);
        await t.a.pass();
        inConversationOf(only(t.a.messenger.posts(), 'finished'), opener);
      }
    );

    it(
      'a child of that root attaches: the file lands in the root’s conversation, headed with the child’s name',
      {},
      async () => {
        const t = await attachRig(brand, shape);
        const { root, opener } = await rootWithConversation(t);
        const child = await t.b.start({ parent: root.sessionId });
        const at = await png(child, t, 'diagram.png');

        const { reply } = await agentAttaches(t, child, at, 'The new flow.');
        assert.deepEqual(reply, { ok: true });
        const [file] = t.a.messenger.attachments();
        assert.ok(file);
        assert.equal(file.posted.anchor, opener.posted.anchor);
        const name = views.displayName(t.b.session(child.pid));
        assert.ok(file.attachment.head?.startsWith(`${name} · spawned by `), file.attachment.head);
        assert.equal(file.attachment.caption, `${file.attachment.head}\n\nThe new flow.`);
      }
    );

    it('Remote turned off in A between the plan and the claim: refused, and nothing posted', async () => {
      const t = await attachRig(brand, shape);
      const root = await t.b.start();
      await t.a.pass();
      const at = await png(root, t);

      const { reply } = await agentAttaches(t, root, at, undefined, () => t.a.turnOff());
      assert.deepEqual(reply, { ok: false, reason: words.OFF_HERE });
      assert.equal(t.a.messenger.attachments().length, 0);
    });

    it('a raw request naming the holder file: refused by the holder, and the fake records nothing', async () => {
      const t = await attachRig(brand, shape);
      const root = await t.b.start();
      await t.a.pass();
      const before = t.a.messenger.posts().length;

      const result = await asking.ask(
        {
          kind: 'attach',
          windowId: t.a.id,
          pid: root.pid,
          startedAt: root.startedAt,
          sessionWindowId: t.b.id,
          path: paths.HOLDER_FILE,
          from: root.sessionId
        },
        rules.ATTACH_REPLY_MS
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.kind, 'refused');
      assert.match(result.ok ? '' : result.reason, /is inside .*, which is never sent$/);
      assert.equal(t.a.messenger.attachments().length, 0);
      assert.equal(t.a.messenger.posts().length, before);
    });
  });
}

describe('Remote across windows, once', () => {
  const brand: BrandId = 'claude';
  const shape = SHAPES[0];

  it('a turn-on is refused while another window holds Remote, and allowed once it lets go (D37)', async () => {
    const t = await rig(brand, shape);
    const other = await holder(brand);
    const refused = await other.turnOn();
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? '' : refused.holder?.windowId, t.a.id);
    assert.equal(refused.ok ? '' : refused.holder?.label, t.a.claim.label);
    assert.equal(other.holds(), false);
    const held = JSON.parse(await fs.readFile(paths.HOLDER_FILE, 'utf8')) as { windowId: string };
    assert.equal(held.windowId, t.a.id);

    await t.a.turnOff();
    assert.deepEqual(await other.turnOn(), { ok: true });
  });

  it('a holder whose claim is briefly missing is still drawn and served as holding', async () => {
    // A claim goes while its window lives: swept after a sleep the heartbeat
    // slept through, or removed as the window closes.
    const a = await holder(brand);
    const b = await h.testWindow(fresh('B'), brand);
    const other = await holder(brand);
    assert.deepEqual(await a.turnOn(), { ok: true });
    await fs.rm(path.join(claims.WINDOWS_DIR, `${a.id}.json`));
    assert.equal((await other.remote.view()).state.kind, 'elsewhere');
    const before = b.pids().length;
    const opened = await asking.ask(
      {
        kind: 'open',
        windowId: b.id,
        cwd: b.folder,
        prompt: 'hello',
        via: 'remote',
        remote: a.id
      },
      10_000
    );
    assert.equal(opened.ok, true, opened.ok ? '' : opened.reason);
    assert.equal(b.pids().length, before + 1);
  });

  it('a holder file naming no live window locks nobody out (R4)', async () => {
    const a = await holder(brand);
    // A live process with its own start, as a forger would name one, on
    // behalf of a window no claim names.
    const table = await scan.scanProcesses(true);
    await fs.mkdir(paths.REMOTE_DIR, { recursive: true });
    await fs.writeFile(
      paths.HOLDER_FILE,
      JSON.stringify({
        windowId: 'forged',
        label: 'nowhere',
        pid: process.pid,
        startedAt: table.starts.get(process.pid),
        since: Date.now()
      })
    );
    assert.deepEqual(await a.turnOn(), { ok: true });
    const held = JSON.parse(await fs.readFile(paths.HOLDER_FILE, 'utf8')) as { windowId: string };
    assert.equal(held.windowId, a.id);
  });

  it('attach and attachTarget are refused off the holder', async () => {
    const t = await rig(brand, shape);
    const root = await t.b.start();
    const other = await holder(brand);
    const off = { ok: false, reason: words.OFF_HERE };
    assert.deepEqual(await other.attachTarget(root.addr), off);
    const bytes = Buffer.from('notes');
    assert.deepEqual(
      await other.attach(root.addr, { bytes, name: 'notes.txt', mime: 'text/plain' }),
      off
    );
    assert.equal(t.a.messenger.attachments().length, 0);
  });

  it('End signals a member whose window has gone, and never one whose start has moved (R8b)', async () => {
    const t = await rig(brand, shape);
    const root = await t.b.start();
    const c = await h.testWindow(fresh('C'), brand);
    const orphan = await c.start({ parent: root.sessionId });
    const moved = await c.start({ parent: root.sessionId });
    await c.leave();
    await t.a.pass();
    t.a.messenger.command(h.OWNER, 'end', String(root.pid));
    await t.a.drain();
    const confirm = last(t.a);
    assert.match(confirm.notice.body, /and the 2 sessions it started\?$/);

    // A pid reused between the confirm and the press, which no test can
    // arrange: the count is edited on disk while Remote is off, and the
    // engine reads it back on turn-on.
    await t.a.turnOff();
    const [kept] = await store.readConversations();
    const counted = kept?.notices.find((n) => n.kind === 'confirm')?.members;
    const stale = counted?.find((one) => one.pid === moved.pid);
    assert.ok(kept && stale);
    stale.startedAt += 60_000;
    await store.writeConversation(kept);
    assert.deepEqual(await t.a.turnOn(), { ok: true });

    t.a.messenger.press(h.OWNER, button(confirm, 'End'), confirm.posted.message);
    await t.a.drain();
    settledAs(t.a, confirm, words.ENDED);
    await gone(orphan.pid);
    await gone(root.pid);
    assert.equal(await alive(moved.pid), true, 'a start that moved is never signalled');
  });

  it('words every line it puts on a pipe with none of the fake CLIs’ trigger words', () => {
    const lines = [
      answer.personAnswerProse(''),
      jobs.freshPrompt('', '/tmp/record.jsonl'),
      words.DENY_REASON
    ].map((line) => line.toLowerCase());
    const triggers = [
      // fake-cli
      'ask',
      'two',
      'write',
      'slow',
      'linger',
      'quiet',
      'spool',
      'origin',
      'whoami',
      'entrypoint',
      'held-tool',
      'api-',
      'delayed-interrupt',
      'thread-acquisition',
      // fake-acp
      'perm',
      'hang-busy',
      'silent-completion',
      'self-started',
      'late-rebusy',
      'no-user-echo',
      // fake-codex
      'request'
    ];
    for (const line of lines) {
      for (const trigger of triggers) assert.equal(line.includes(trigger), false, trigger);
    }
  });
});

describe('the token proof', () => {
  after(() => h.disposeAll());

  it('no file under HOME, no child’s environment and no engine log holds the credential', async () => {
    const children = (await fs.readFile(h.envLog(), 'utf8')).trim().split('\n');
    assert.ok(children.length >= BRANDS.length, 'every brand’s children logged their environment');
    for (const line of children) assert.equal(line.includes(h.SENTINEL), false);
    assert.ok(holders.length > 0);
    for (const one of holders) {
      for (const line of one.logs) assert.equal(line.includes(h.SENTINEL), false);
    }
    for (const file of await filesUnder(home)) {
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      assert.equal(text.includes(h.SENTINEL), false, file);
    }
  });
});

/** Every file under `dir`, recursively; none when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

async function conversationFiles(): Promise<string[]> {
  const names = await fs.readdir(paths.CONVERSATIONS_DIR).catch(() => []);
  return Promise.all(
    names.map((name) => fs.readFile(path.join(paths.CONVERSATIONS_DIR, name), 'utf8'))
  );
}

describe('remote picker launch across real child transports', () => {
  it('starts the chosen context and effort in the selected window with the holder elsewhere', async () => {
    const t = await rig('claude', SHAPES[0]);
    t.a.messenger.say(h.OWNER, 'hello');
    await t.a.drain();
    t.a.messenger.press(h.OWNER, button(last(t.a), 'site'));
    await t.a.drain();
    t.a.messenger.press(h.OWNER, button(last(t.a), 'Show older models'));
    await t.a.drain();
    const offered = last(t.a).notice.buttons?.find((b) => b.label.includes('Opus 5 (200k)'));
    assert.ok(offered);
    t.a.messenger.press(h.OWNER, offered.payload);
    await t.a.drain();
    const effort = last(t.a).notice.buttons?.find((b) => b.label.startsWith('high'));
    assert.ok(effort);
    t.a.messenger.press(h.OWNER, effort.payload);
    await t.a.drain();
    const pid = t.b.pids().at(-1);
    assert.ok(pid !== undefined);
    const state = t.b.live(pid).handle.state;
    assert.equal(state.modelPick, 'claude-opus-5');
    assert.equal(state.windowAsked, 200_000);
    assert.equal(state.effort, 'high');
    assert.equal(t.a.pids().length, 0);
  });

  it('does not replay an open whose receiver threw after creating its child', async () => {
    const a = await holder('claude', { folder: path.join(home, 'work', 'app') });
    let attempts = 0;
    const b = await h.testWindow(fresh('B'), 'claude', {
      folder: path.join(home, 'work', 'site'),
      arms: [
        (request) =>
          request.kind === 'open'
            ? (async () => {
                attempts++;
                await b.start({ prompt: request.prompt });
                throw new Error('after child');
              })()
            : undefined
      ]
    });
    assert.equal((await a.turnOn()).ok, true);
    await a.pass();
    a.messenger.say(h.OWNER, 'original');
    await a.drain();
    a.messenger.press(h.OWNER, button(last(a), 'site'));
    await a.drain();
    a.messenger.press(h.OWNER, button(last(a), 'Use window default'));
    await a.drain();
    assert.equal(b.pids().length, 1);
    assert.equal(attempts, 1);
    assert.equal((await store.readConversations())[0]?.held?.picker?.stage, 'starting');
    await a.pass();
    await a.drain();
    assert.equal(attempts, 1);
    assert.match(last(a).notice.body, /outcome unknown/);
  });
});

function heldReply(context: TestContext) {
  let release!: (reply: Reply) => void;
  const withheld = new Promise<Reply>((resolve) => {
    release = resolve;
  });
  let original: Reply | undefined;
  let enter!: (reply: Reply) => void;
  const entered = new Promise<Reply>((resolve) => {
    enter = resolve;
  });
  const started = performance.now();
  const trace = (stage: string): void =>
    context.diagnostic(JSON.stringify({ stage, ms: performance.now() - started }));
  const abort = (): void => {
    trace('aborted');
    release({ ok: false, reason: 'fixture aborted' });
  };
  context.signal.addEventListener('abort', abort, { once: true });
  context.after(() => context.signal.removeEventListener('abort', abort));
  return {
    entered,
    trace,
    intercept: (reply: Reply) => {
      original = reply;
      enter(reply);
      return withheld;
    },
    release() {
      release(original ?? { ok: false, reason: 'fixture released' });
    },
    async phase<T>(stage: string, pending: Promise<T>): Promise<T> {
      trace(stage + ':start');
      let stop!: () => void;
      if (stage === 'setup') {
        const result = await pending;
        trace(stage + ':done');
        return result;
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        stop = () =>
          reject(new Error('Incoming fixture aborted.', { cause: context.signal.reason }));
        if (context.signal.aborted) stop();
        else context.signal.addEventListener('abort', stop, { once: true });
      });
      try {
        const result = await Promise.race([pending, aborted]);
        trace(stage + ':done');
        return result;
      } finally {
        context.signal.removeEventListener('abort', stop);
      }
    },
    async notices(t: Awaited<ReturnType<typeof import('../incoming_fetch_helpers').make>>) {
      const records = await store.readConversations();
      context.diagnostic(
        JSON.stringify({
          stage: 'posted notices',
          pickers: records.map((record) => record.held?.picker?.stage),
          notices: t.messenger.posts().map((post) => ({
            body: post.notice.body
              .replaceAll(home, '<fixture-home>')
              .replace(/https?:\/\/\S+/g, '<url>'),
            buttons: post.notice.buttons?.map((button) => button.label)
          }))
        })
      );
      return records;
    }
  };
}

function heldCleanup(
  context: TestContext,
  held: ReturnType<typeof heldReply>,
  t: Awaited<ReturnType<typeof import('../incoming_fetch_helpers').make>>,
  pressing: () => Promise<void> | undefined = () => undefined
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (cleanup ??= (async () => {
      held.release();
      try {
        await held.notices(t);
        await pressing();
        await t.drain();
      } finally {
        await t.close();
        held.trace('closed');
        assert.equal(
          t.started.some((child) => child.transport.processAlive?.()),
          false
        );
      }
    })());
  context.after(close);
  return close;
}

describe('incoming fetch evidence outside routing', () => {
  it(
    'a withheld native delivery reply recovers fetch through challenged request files without replay',
    { timeout: INCOMING_TEST_MS },
    async (context) => {
      const os = await import('node:os');
      const crypto = await import('node:crypto');
      const fixtures = await import('../incoming_fetch_helpers');
      const directory = path.join(home, 'incoming-fetch-transport');
      await fs.mkdir(directory, { recursive: true });
      context.mock.method(os, 'tmpdir', () => directory);
      const held = heldReply(context);
      const t = await held.phase(
        'setup',
        fixtures.make(directory, {
          foreign: true,
          sendReply: held.intercept
        })
      );
      const close = heldCleanup(context, held, t);
      try {
        t.send();
        await held.phase('delivery reply', held.entered);
        const view = await t.view();
        assert.equal(view.access.state, 'intended');
        const identity = t.identity(view);
        t.queries(false);
        let probed: () => void = () => {};
        const queried = new Promise<void>((resolve) => {
          probed = resolve;
        });
        const evidence = t.verbs.incomingEvidence!.bind(t.verbs);
        t.verbs.incomingEvidence = async (...args) => {
          const proof = await evidence(...args);
          probed();
          return proof;
        };
        const pending = t.files.fetch({
          requestId: crypto.randomUUID(),
          identity,
          signal: context.signal
        });
        await held.phase('evidence challenge', queried);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(t.calls, []);
        // Foreign publication can wake fetch while the routing acknowledgement remains withheld.
        t.queries(true);
        t.wake();
        const fetched = await held.phase('fetch', pending);
        assert.ok(fetched.kind === 'fetched');
        assert.equal(await fs.readFile(fetched.path, 'utf8'), 'actual local bytes');
        assert.equal((await t.view()).access.state, 'active');
        assert.equal(t.started.length, 1);
        assert.equal(t.started[0]!.owner.snapshot().incomingDeliveries.length, 1);
        const posts = t.messenger.posts().length;
        await t.bridge.closeIncoming(identity.conversation, identity.correlation);
        assert.equal(t.messenger.posts().length, posts);
        const denied = await t.fetch(identity);
        assert.equal(denied.kind === 'refused' && denied.code, 'closed');
        assert.equal(t.changed.size, 0);
      } finally {
        await close();
      }
    }
  );
});

it(
  'fetch resolves only the original native launch while its reply is held, without changing the routing root or starting again',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const os = await import('node:os');
    const crypto = await import('node:crypto');
    const fixtures = await import('../incoming_fetch_helpers');
    const directory = path.join(home, 'incoming-launch-fetch');
    await fs.mkdir(directory, { recursive: true });
    context.mock.method(os, 'tmpdir', () => directory);
    const held = heldReply(context);
    const t = await held.phase(
      'setup',
      fixtures.make(directory, {
        root: false,
        foreign: true,
        startReply: held.intercept
      })
    );
    let pressing: Promise<void> | undefined;
    const close = heldCleanup(context, held, t, () => pressing);
    try {
      t.send(0, 'inspect it', []);
      await t.drain();
      const records = await held.notices(t);
      assert.equal(records.at(-1)?.held?.picker?.stage, 'model');
      pressing = t.press('Use window default');
      await held.phase('launch reply', held.entered);
      const view = await t.view();
      assert.equal(view.access.state, 'starting');
      assert.equal(view.access.receiver, undefined);
      const identity = t.identity(view);
      const guess = await t.fetch({
        ...identity,
        receiver: { ...identity.receiver, incarnation: crypto.randomUUID() }
      });
      assert.equal(guess.kind === 'refused' && guess.code, 'wrong-receiver');
      assert.deepEqual(t.calls, []);
      const rootBefore = (await store.readConversations()).find(
        (record) => record.id === identity.conversation
      )?.root;
      const fetched = await held.phase('fetch', t.fetch(identity, context.signal));
      assert.ok(fetched.kind === 'fetched');
      assert.equal(await fs.readFile(fetched.path, 'utf8'), 'actual local bytes');
      assert.deepEqual((await t.view()).access.receiver, t.started[0]!.owner.receiverIdentity);
      assert.equal((await t.view()).access.state, 'active');
      assert.equal(t.started.length, 1);
      assert.deepEqual(
        (await store.readConversations()).find((record) => record.id === identity.conversation)
          ?.root,
        rootBefore
      );
      assert.equal(t.changed.size, 0);
    } finally {
      await close();
    }
  }
);
