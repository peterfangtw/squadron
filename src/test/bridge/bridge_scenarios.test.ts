import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import type { Act } from '../../core/coordination/route';
import type { PendingRequest } from '../../core/live';
import type { TurnOutcome } from '../../core/events';
import type { Session, WindowClaim } from '../../core/model';
import type { SessionVerbs } from '../../core/bridge/bridge';
import type { FakeMessenger, FakeOptions, FakePost } from '../../core/bridge/fake';
import type { Posted, SenderId, SessionAddr, Watched } from '../../core/bridge/model';
import type { Messenger } from '../../core/bridge/port';
import { tempHome } from '../helpers';

type Engine = typeof import('../../core/bridge/bridge');
type Fake = typeof import('../../core/bridge/fake');
type Store = typeof import('../../core/bridge/store');
type Paths = typeof import('../../core/paths');
type Words = typeof import('../../core/bridge/words');
type Allow = typeof import('../../core/bridge/allow');
type Transcripts = typeof import('../../core/record');

let engine: Engine;
let fake: Fake;
let store: Store;
let paths: Paths;
let words: Words;
let allow: Allow;
let record: Transcripts;
let home: string;

before(async () => {
  home = await tempHome();
  engine = await import('../../core/bridge/bridge');
  fake = await import('../../core/bridge/fake');
  store = await import('../../core/bridge/store');
  paths = await import('../../core/paths');
  words = await import('../../core/bridge/words');
  allow = await import('../../core/bridge/allow');
  record = await import('../../core/record');
});

beforeEach(() => fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;
const OWNER = 'T1:U1';
const STRANGER = 'T1:U9';
const APP = path.resolve('/work/agentsview');
const SITE = path.resolve('/work/acme-web');

/**
 * The two ways a messenger groups a conversation, each replied to the way its
 * people reply: in the thread, or to the message answered. The chain shape
 * also has a 64-byte payload and no edit, so every settle is a follow-up post.
 */
const MODES = [
  {
    name: 'thread',
    fake: { shape: 'thread' } satisfies FakeOptions,
    reply: (m: FakeMessenger, to: Posted, text: string, sender: SenderId = OWNER) =>
      m.say(sender, text, { in: to.anchor })
  },
  {
    name: 'chain',
    fake: { shape: 'chain', payloadMax: 64, edit: false } satisfies FakeOptions,
    reply: (m: FakeMessenger, to: Posted, text: string, sender: SenderId = OWNER) =>
      m.say(sender, text, { replyTo: to.message })
  }
] as const;

type Mode = (typeof MODES)[number];
type Call = { verb: string; args: unknown[] };

/**
 * The sessions Remote reaches, as a board that moves the way real sessions
 * do: a send to a busy or waiting session is held in its outbox and delivered
 * when its turn ends; a delivered one makes it busy; a Deny lets it carry on;
 * End takes it off the board. Every change replaces the session's `Watched`,
 * so an observation the bridge already holds never changes under it.
 */
class World {
  claims: WindowClaim[] = [claim('w1', APP)];
  readonly calls: Call[] = [];
  /** What each session was handed as a prompt, by pid. */
  readonly got = new Map<number, string[]>();
  private sessions: Watched[] = [];
  private readonly outbox = new Map<number, string[]>();
  private readonly replies = new Map<number, string>();
  private pids = 500;
  now = T0 + 100_000;

  add(pid: number, label: string, over: Partial<Session> = {}): Watched {
    const w: Watched = { session: session(pid, over), pending: [], label };
    this.sessions.push(w);
    return w;
  }

  board(): Watched[] {
    return [...this.sessions];
  }

  at(pid: number): Watched {
    const w = this.sessions.find((s) => s.session.pid === pid);
    assert.ok(w, `no session ${pid} on the board`);
    return w;
  }

  addr(pid: number): SessionAddr {
    const { session: s } = this.at(pid);
    return { pid, startedAt: s.startedAt, windowId: s.windowId ?? '' };
  }

  /** The turn ends with `text`; a held message starts the next one at once. */
  finish(pid: number, text: string, outcome: TurnOutcome = 'done'): void {
    this.replies.set(pid, text);
    this.move(pid, (w) => ({
      ...w,
      pending: [],
      session: {
        ...w.session,
        status: 'idle',
        turnOutcome: outcome,
        endedOutcome: outcome,
        turnsEnded: (w.session.turnsEnded ?? 0) + 1
      }
    }));
    const held = this.outbox.get(pid)?.shift();
    if (held !== undefined) this.deliver(pid, held);
  }

  ask(pid: number, request: PendingRequest): void {
    this.move(pid, (w) => ({
      ...w,
      pending: [...w.pending, request],
      session: { ...w.session, status: 'waiting' }
    }));
  }

  /** A request closed by anyone but Remote: a peer's answer, a dialog click. */
  close(pid: number, requestId: string): void {
    this.move(pid, (w) => {
      const pending = w.pending.filter((r) => r.requestId !== requestId);
      const status = pending.length > 0 ? ('waiting' as const) : ('busy' as const);
      return { ...w, pending, session: { ...w.session, status } };
    });
  }

  exit(pid: number): void {
    this.sessions = this.sessions.filter((w) => w.session.pid !== pid);
  }

  of(verb: string): Call[] {
    return this.calls.filter((c) => c.verb === verb);
  }

  readonly verbs: SessionVerbs = {
    send: (addr, text) => {
      this.calls.push({ verb: 'send', args: [addr, text] });
      return Promise.resolve(this.take(addr, text));
    },
    answer: (addr, askId, text) => {
      this.calls.push({ verb: 'answer', args: [addr, askId, text] });
      const w = this.find(addr);
      if (w?.pending.some((r) => r.requestId === askId)) {
        this.close(addr.pid, askId);
        this.deliver(addr.pid, text);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(this.take(addr, text));
    },
    interrupt: (addr) => {
      this.calls.push({ verb: 'interrupt', args: [addr] });
      if (this.find(addr) === undefined) return Promise.resolve(gone);
      this.finish(addr.pid, '', 'interrupted');
      return Promise.resolve({ ok: true });
    },
    deny: (addr, requestId, reason) => {
      this.calls.push({ verb: 'deny', args: [addr, requestId, reason] });
      if (this.find(addr) === undefined) return Promise.resolve(gone);
      this.close(addr.pid, requestId);
      return Promise.resolve({ ok: true });
    },
    end: (addr, members) => {
      this.calls.push({ verb: 'end', args: [addr, members] });
      for (const one of [addr, ...members]) this.exit(one.pid);
      return Promise.resolve({ ok: true });
    },
    start: (input) => {
      this.calls.push({ verb: 'start', args: [input] });
      const pid = ++this.pids;
      const w = this.add(pid, path.basename(input.cwd), {
        cwd: input.cwd,
        repoRoot: input.cwd,
        windowId: input.windowId,
        status: 'busy',
        ...(input.brand === undefined ? {} : { brand: input.brand })
      });
      this.got.set(pid, [input.prompt]);
      const brand = input.brand ?? 'claude';
      return Promise.resolve({
        ok: true,
        pid,
        startedAt: w.session.startedAt,
        brand,
        sessionId: w.session.sessionId
      });
    },
    lastReply: (addr) => Promise.resolve(this.replies.get(addr.pid))
  };

  /** A message for a session: delivered when it is free, else held. */
  private take(addr: SessionAddr, text: string): Act {
    const w = this.find(addr);
    if (w === undefined) return gone;
    if (w.session.status === 'idle' && w.pending.length === 0) {
      this.deliver(addr.pid, text);
      return { ok: true };
    }
    const held = [...(this.outbox.get(addr.pid) ?? []), text];
    this.outbox.set(addr.pid, held);
    return { ok: true, queued: held.length };
  }

  private deliver(pid: number, text: string): void {
    this.got.set(pid, [...(this.got.get(pid) ?? []), text]);
    this.move(pid, (w) => ({ ...w, session: { ...w.session, status: 'busy' } }));
  }

  private find(addr: SessionAddr): Watched | undefined {
    return this.sessions.find(
      (w) => w.session.pid === addr.pid && w.session.startedAt === addr.startedAt
    );
  }

  private move(pid: number, change: (w: Watched) => Watched): void {
    this.sessions = this.sessions.map((w) => (w.session.pid === pid ? change(w) : w));
  }
}

const gone: Act = { ok: false, reason: 'That session has ended' };

function session(pid: number, over: Partial<Session> = {}): Session {
  return {
    pid,
    sessionId: `s${pid}`,
    cwd: APP,
    repoRoot: APP,
    name: `n${pid}`,
    status: 'busy',
    hasCommand: false,
    startedAt: T0 + pid * 1000,
    updatedAt: T0 + pid * 1000,
    transcript: `/t/${pid}.jsonl`,
    source: 'owned',
    windowId: 'w1',
    brand: 'claude',
    turnsEnded: 0,
    ...over
  };
}

function claim(id: string, folder: string): WindowClaim {
  return { id, label: `window ${id}`, app: 'Code', folder, shellPids: [], updatedAt: T0 };
}

const permission = (requestId: string, command: string): PendingRequest => ({
  requestId,
  toolName: 'Bash',
  ask: false,
  input: { command }
});

const question = (requestId: string): PendingRequest => ({
  requestId,
  toolName: 'AskUserQuestion',
  ask: true,
  questions: [
    {
      question: 'Which retry policy?',
      multiSelect: false,
      options: [{ label: 'Fixed' }, { label: 'Exponential' }]
    }
  ]
});

/** Remote turned on over `world`: the bridge started on the fake, and its
 *  first observation taken. */
async function remoteOn(mode: Mode, world: World, messenger?: Messenger) {
  const fakeOne = fake.fakeMessenger(mode.fake);
  const bridge = new engine.Bridge({
    messenger: messenger ?? fakeOne,
    label: 'Test messenger',
    verbs: world.verbs,
    allowlist: [OWNER],
    clock: () => world.now,
    resolve: () => Promise.resolve(new Map()),
    log: () => undefined
  });
  await bridge.load();
  const observe = () => bridge.observe(world.board(), world.claims);
  await observe();
  bridge.connect();
  return {
    bridge,
    messenger: fakeOne,
    observe,
    /** Every event the fake delivered so far, handled. */
    drain: () => bridge.tick(world.now),
    last(): FakePost {
      const post = fakeOne.posts().at(-1);
      assert.ok(post, 'nothing was posted');
      return post;
    }
  };
}

type Remote = Awaited<ReturnType<typeof remoteOn>>;

/** A root's turn ended and Remote posted it: its conversation is open. */
async function finished(t: Remote, world: World, pid: number, text: string): Promise<FakePost> {
  world.finish(pid, text);
  await t.observe();
  const post = t.last();
  assert.equal(post.notice.kind, 'finished');
  return post;
}

/** In a notice's conversation, whatever the shape. */
function inConversationOf(post: FakePost, opener: FakePost): void {
  assert.ok('conversation' in post.place, `${post.notice.kind} was not posted in a conversation`);
  assert.equal(post.place.conversation.anchor, opener.posted.anchor);
  assert.equal(post.posted.anchor, opener.posted.anchor);
}

/** The notice's buttons became `word`: edited in place, or said in a
 *  follow-up post in its conversation where the messenger cannot edit. */
function settledAs(t: Remote, notice: FakePost, word: string): void {
  if (t.messenger.edit) {
    const edited = t.messenger
      .settles()
      .some((s) => s.message === notice.posted.message && s.notice.settled === word);
    assert.ok(edited, `not settled as "${word}"`);
    return;
  }
  const said = t.messenger
    .posts()
    .some((p) => p.notice.body === word && p.posted.anchor === notice.posted.anchor);
  assert.ok(said, `no follow-up saying "${word}"`);
}

function button(post: FakePost, label: string): string {
  const found = post.notice.buttons?.find((b) => b.label === label);
  assert.ok(found, `no ${label} button on the ${post.notice.kind} notice`);
  return found.payload;
}

const files = async () => {
  const names = await fs.readdir(paths.CONVERSATIONS_DIR).catch(() => []);
  return Promise.all(
    names.map((name) => fs.readFile(path.join(paths.CONVERSATIONS_DIR, name), 'utf8'))
  );
};

for (const mode of MODES) {
  describe(`PRD scenarios through the fake, ${mode.name} mode`, () => {
    it('1. dinner: a finish is posted, the reply carries on, the next finish lands in the same conversation', async () => {
      const world = new World();
      world.add(10, 'A');
      const t = await remoteOn(mode, world);
      assert.equal(t.messenger.posts().length, 0, 'a busy session needs nobody yet');

      const first = await finished(t, world, 10, 'Keep the old API or migrate?');
      assert.deepEqual(first.place, { home: OWNER });
      assert.equal(first.notice.mention, OWNER);
      assert.match(first.notice.body, /Keep the old API or migrate\?/);
      assert.equal(first.notice.head, '[agentsview] A');

      mode.reply(t.messenger, first.posted, 'migrate');
      await t.drain();
      assert.deepEqual(world.of('send')[0]?.args, [world.addr(10), 'migrate']);
      assert.deepEqual(world.got.get(10), ['migrate']);
      assert.equal(t.messenger.posts().length, 1, 'an idle root took it: no receipt');

      await t.observe();
      const next = await finished(t, world, 10, 'Migrated; the tests pass.');
      inConversationOf(next, first);
      assert.match(next.notice.body, /Migrated; the tests pass\./);
    });

    it('2. the boss in two windows: a pick starts the job, and its answer lands under the message', async () => {
      const world = new World();
      world.claims = [claim('w1', APP), claim('w2', SITE)];
      const t = await remoteOn(mode, world);

      const asked = t.messenger.say(OWNER, 'what does the retry policy in acme-web do?');
      assert.ok(asked?.kind === 'message');
      await t.drain();
      const correlation = (await store.readConversations())[0]?.held?.correlation;
      assert.ok(correlation);
      const picker = t.last();
      assert.equal(picker.notice.kind, 'picker');
      assert.deepEqual(picker.place, { under: asked.ref });
      assert.deepEqual(
        picker.notice.buttons?.map((b) => b.label),
        ['acme-web', 'agentsview', 'Cancel']
      );
      assert.equal(world.of('start').length, 0, 'held until a folder is picked');

      t.messenger.press(OWNER, button(picker, 'acme-web'));
      await t.drain();
      t.messenger.press(OWNER, button(t.last(), 'Use window default'));
      await t.drain();
      assert.deepEqual(world.of('start')[0]?.args, [
        {
          windowId: 'w2',
          cwd: SITE,
          prompt: 'what does the retry policy in acme-web do?',
          correlation
        }
      ]);
      settledAs(t, picker, 'Choice updated');

      await t.observe();
      const job = world.board()[0];
      assert.ok(job);
      const answer = await finished(
        t,
        world,
        job.session.pid,
        'Three tries, doubling from 200 ms.'
      );
      inConversationOf(answer, picker);
      assert.equal(answer.posted.anchor, picker.posted.anchor);
      assert.match(answer.notice.body, /Three tries/);
    });

    it('3. a child stuck on a permission: posted in its root’s conversation, Deny, then End', async () => {
      const world = new World();
      world.add(10, 'A');
      world.add(11, 'auth redirect', { parentSessionId: 's10' });
      const t = await remoteOn(mode, world);
      const opener = await finished(t, world, 10, 'Spawned a child for the redirect.');

      world.ask(11, permission('p1', 'git push'));
      await t.observe();
      const asks = t.last();
      assert.equal(asks.notice.kind, 'permission');
      inConversationOf(asks, opener);
      assert.equal(asks.notice.head, '[agentsview] auth redirect · spawned by A');
      assert.equal(asks.notice.mention, OWNER);
      assert.match(`${asks.notice.body}\n${asks.notice.code ?? ''}`, /git push/);
      assert.deepEqual(
        asks.notice.buttons?.map((b) => b.label),
        ['Deny', 'End'],
        'no Allow from a phone (D18)'
      );

      t.messenger.press(OWNER, button(asks, 'Deny'));
      await t.drain();
      assert.deepEqual(world.of('deny')[0]?.args, [world.addr(11), 'p1', words.DENY_REASON]);
      settledAs(t, asks, words.DENIED);
      await t.observe();

      world.ask(11, permission('p2', 'git push --force'));
      await t.observe();
      const again = t.last();
      inConversationOf(again, opener);
      const child = world.addr(11);
      t.messenger.press(OWNER, button(again, 'End'));
      await t.drain();
      const confirm = t.last();
      assert.equal(confirm.notice.kind, 'confirm');
      assert.equal(confirm.notice.body, 'End auth redirect?');
      inConversationOf(confirm, opener);

      t.messenger.press(OWNER, button(confirm, 'End'));
      await t.drain();
      assert.deepEqual(world.of('end')[0]?.args, [child, []]);
      assert.equal(world.board().length, 1, 'the root is still running');
      settledAs(t, confirm, words.ENDED);
      await t.observe();
      settledAs(t, again, words.NO_LONGER_WAITING);
      const [kept] = await store.readConversations();
      assert.deepEqual(
        kept?.notices.filter((n) => n.requestId).map((n) => [n.requestId, n.settled]),
        [
          ['p1', words.DENIED],
          ['p2', words.NO_LONGER_WAITING]
        ],
        'a denied request is not settled a second time when it closes'
      );
    });

    it('4. a child asks a question: posted in the root’s conversation, and the reply reaches the root', async () => {
      const world = new World();
      world.add(10, 'A');
      world.add(11, 'B', { parentSessionId: 's10' });
      const t = await remoteOn(mode, world);
      const opener = await finished(t, world, 10, 'B is on it.');

      world.ask(11, question('q1'));
      await t.observe();
      const asks = t.last();
      assert.equal(asks.notice.kind, 'question');
      inConversationOf(asks, opener);
      assert.equal(asks.notice.head, '[agentsview] B · spawned by A');
      assert.match(asks.notice.body, /Which retry policy\?\n1\. Fixed\n2\. Exponential/);

      mode.reply(t.messenger, asks.posted, 'use the second option, tell B');
      await t.drain();
      assert.deepEqual(world.of('send')[0]?.args, [
        world.addr(10),
        'use the second option, tell B'
      ]);
      assert.equal(world.of('answer').length, 0, 'typed text never answers a child (D17)');
      assert.equal(world.at(11).pending[0]?.requestId, 'q1');

      world.close(11, 'q1');
      await t.observe();
      settledAs(t, asks, words.NO_LONGER_WAITING);
    });

    it('5. a reply to an ended root starts a fresh session where it ran, pointed at its record', async () => {
      const world = new World();
      world.add(10, 'A');
      const t = await remoteOn(mode, world);
      const opener = await finished(t, world, 10, 'Done for tonight.');
      world.exit(10);
      await t.observe();

      mode.reply(t.messenger, opener.posted, 'keep going with the docs');
      await t.drain();
      const ended = t.last();
      assert.deepEqual(ended.notice, words.endedNotice(APP, OWNER));
      inConversationOf(ended, opener);
      const [start] = world.of('start');
      const input = start?.args[0] as { windowId: string; cwd: string; prompt: string };
      assert.equal(input.windowId, 'w1');
      assert.equal(input.cwd, APP);
      assert.match(input.prompt, /^keep going with the docs\n\n/);
      assert.ok(input.prompt.includes(record.recordFile('s10')));
      assert.ok(record.recordFile('s10').startsWith(home));

      await t.observe();
      const fresh = world.board()[0];
      assert.ok(fresh);
      const next = await finished(t, world, fresh.session.pid, 'Docs updated.');
      inConversationOf(next, opener);
      const [kept] = await store.readConversations();
      assert.deepEqual(kept?.past, ['s10']);
      assert.equal(kept?.root?.pid, fresh.session.pid);
    });

    it('5b. a child outliving its root keeps its family’s conversation, and a reply there starts a fresh root (U1)', async () => {
      const world = new World();
      world.add(10, 'A');
      world.add(11, 'B', { parentSessionId: 's10' });
      const t = await remoteOn(mode, world);
      const opener = await finished(t, world, 10, 'Handed off to B.');
      world.exit(10);
      await t.observe();

      world.ask(11, permission('p1', 'npm publish'));
      await t.observe();
      const asks = t.last();
      inConversationOf(asks, opener);
      assert.equal(asks.notice.head, '[agentsview] B · spawned by A');

      mode.reply(t.messenger, asks.posted, 'leave it for the morning');
      await t.drain();
      assert.equal(world.of('send').length, 0, 'the child is not the root (D17)');
      assert.equal(world.of('start').length, 1);
      inConversationOf(t.last(), opener);
    });

    it('6. a stranger: nothing happens and nothing is posted', async () => {
      const world = new World();
      world.add(10, 'A');
      const t = await remoteOn(mode, world);
      const opener = await finished(t, world, 10, 'Ready.');
      world.ask(10, permission('p1', 'rm -rf build'));
      await t.observe();
      const asks = t.last();
      const posts = t.messenger.posts().length;
      const calls = world.calls.length;
      const written = await files();
      const acked = t.messenger.acked();

      t.messenger.say(STRANGER, '@squadron what are you doing?', { addressed: 'mention' });
      mode.reply(t.messenger, opener.posted, 'stop everything', STRANGER);
      t.messenger.press(STRANGER, button(asks, 'Deny'));
      t.messenger.command(STRANGER, 'list');
      t.messenger.command(STRANGER, 'hello');
      await t.drain();

      assert.equal(t.messenger.acked() - acked, 5, 'every event is still acked');
      assert.equal(t.messenger.posts().length, posts);
      assert.equal(t.messenger.settles().length, 0);
      assert.equal(world.calls.length, calls);
      assert.deepEqual(await files(), written);
    });

    it('7. Remote never turned on: nothing connects, nothing is posted, nothing is written', async () => {
      const turnOn = allow.canTurnOn({
        fields: fake.fakeEntry.setup.fields,
        credentials: {},
        allowlist: allow.normalizeAllowlist(undefined)
      });
      assert.equal(turnOn.ok, false, 'an unset allowlist cannot turn Remote on');

      const messenger = fake.fakeMessenger(mode.fake);
      const world = new World();
      world.add(10, 'A');
      world.finish(10, 'Finished while nobody listened.');
      world.ask(10, permission('p1', 'git push'));
      assert.throws(() => messenger.link({ kind: 'connected' }), /no open connection/);
      assert.equal(messenger.posts().length, 0);
      assert.deepEqual(await files(), []);
      await assert.rejects(fs.access(paths.HOLDER_FILE));
    });

    it('an agent’s file opens its root’s conversation, and a reply to it reaches the root (R3)', async () => {
      const world = new World();
      world.add(10, 'A');
      const t = await remoteOn(mode, world);
      const sent = await t.bridge.attach(world.addr(10), {
        bytes: Buffer.from('png'),
        name: 'graph.png',
        mime: 'image/png',
        caption: 'Latency before and after.'
      });
      assert.deepEqual(sent, { ok: true });
      const opener = t.last();
      assert.deepEqual(opener.place, { home: OWNER });
      assert.equal(opener.notice.kind, 'attached');
      assert.equal(opener.notice.mention, OWNER);
      const [file] = t.messenger.attachments();
      assert.ok(file);
      assert.equal(file.posted.anchor, opener.posted.anchor);
      assert.equal(file.attachment.caption, 'Latency before and after.');

      mode.reply(t.messenger, file.posted, 'zoom into p99');
      await t.drain();
      assert.deepEqual(world.of('send')[0]?.args, [world.addr(10), 'zoom into p99']);
      const receipt = t.last();
      assert.equal(receipt.notice.kind, 'receipt', 'A is busy, so the reply is held');
      inConversationOf(receipt, opener);

      world.finish(10, 'Here is the p99 view.');
      assert.equal(world.at(10).session.status, 'busy', 'the held reply started the next turn');
      await t.observe();
      const done = t.last();
      assert.equal(done.notice.kind, 'finished', 'the count shows a finish the status hides');
      inConversationOf(done, opener);
    });

    it('`list` is one snapshot: every running session as a row, one time, links where a conversation exists', async () => {
      const world = new World();
      world.claims = [claim('w1', APP), claim('w2', SITE)];
      world.add(10, 'A', { warm: true });
      world.add(30, 'C', { cwd: SITE, repoRoot: SITE, windowId: 'w2' });
      world.add(11, 'B', { parentSessionId: 's10', warm: false });
      const t = await remoteOn(mode, world);
      const opener = await finished(t, world, 10, 'Ready.');

      // Each link lookup takes an hour of the clock: nothing after the first
      // await may read it.
      const asked = world.now;
      const links = t.messenger.links;
      assert.ok(links);
      Object.assign(t.messenger, {
        links: {
          to: async (anchor: string) => {
            world.now += 3_600_000;
            return links.to(anchor);
          }
        }
      });
      t.messenger.command(OWNER, 'list');
      await t.drain();
      const list = t.last();
      assert.equal(list.notice.kind, 'list');
      assert.deepEqual(list.place, { home: OWNER });
      const table = list.notice.table;
      assert.ok(table);
      const d = new Date(asked);
      const two = (n: number) => String(n).padStart(2, '0');
      assert.ok(
        table.caption.startsWith(
          `Snapshot at ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} `
        ),
        table.caption
      );
      const link = { link: `fake://conversation/${opener.posted.anchor}`, text: 'open' };
      assert.deepEqual(table.rows, [
        ['agentsview', 'A', 'idle', '10', link, '1m ago', 'true'],
        ['acme-web', 'C', 'busy', '30', '—', '1m ago', '—'],
        ['agentsview', 'B', 'busy', '11', link, '1m ago', 'false']
      ]);

      // A later change is a later list; the one posted stays as it was.
      const posted = structuredClone(list.notice);
      world.finish(30, 'Done.');
      await t.observe();
      t.messenger.command(OWNER, 'list');
      await t.drain();
      assert.deepEqual(list.notice, posted);
      assert.equal(
        t.messenger.settles().filter((s) => s.message === list.posted.message).length,
        0,
        'the list is never edited'
      );
      assert.equal(t.last().notice.table?.rows[1]?.[2], 'idle');

      const { links: _links, ...unlinked } = fake.fakeMessenger(mode.fake);
      const plain = await remoteOn(mode, world, unlinked);
      unlinked.command(OWNER, 'list');
      await plain.drain();
      const bare = unlinked.posts().at(-1);
      assert.ok(bare);
      assert.doesNotMatch(bare.notice.body, /\]\(/);
    });
  });
}

describe('new job selection', () => {
  it('holds the original prompt through folder, model and effort, including reload', async () => {
    const world = new World();
    world.claims.push(claim('w2', SITE));
    world.verbs.models = (windowId) => {
      assert.equal(windowId, 'w2');
      return Promise.resolve({
        models: {
          brands: [],
          models: [
            {
              brand: 'codex',
              model: 'gpt-picker',
              name: 'Picker',
              efforts: [{ value: 'high' }, { value: 'low' }],
              defaultEffort: 'high',
              preferredEffort: 'low'
            }
          ]
        },
        remoteSelection: { defaultTarget: { brand: 'codex', model: 'gpt-picker', effort: 'low' } }
      });
    };
    const t = await remoteOn(MODES[0], world);
    t.messenger.say(OWNER, 'Original job');
    await t.drain();
    const correlation = (await store.readConversations())[0]?.held?.correlation;
    assert.ok(correlation);
    assert.equal(world.calls.filter((c) => c.verb === 'start').length, 0);
    const tap = async (label: RegExp) => {
      const button = t.messenger
        .posts()
        .flatMap((p) => p.notice.buttons ?? [])
        .find((b) => label.test(b.label));
      assert.ok(button, String(label));
      t.messenger.press(OWNER, button.payload);
      await t.drain();
    };
    await tap(/acme-web/);
    await tap(/Picker/);
    assert.equal(world.calls.filter((c) => c.verb === 'start').length, 0);
    const kept = (await store.readConversations())[0];
    assert.equal(kept?.held?.prompt, 'Original job');
    await t.bridge.stop();
    const resumed = new engine.Bridge({
      messenger: t.messenger,
      verbs: world.verbs,
      allowlist: [OWNER],
      clock: () => world.now,
      claims: () => Promise.resolve(world.claims)
    });
    await resumed.load();
    await resumed.observe(world.board(), world.claims);
    resumed.connect();
    const low = t.messenger
      .posts()
      .flatMap((p) => p.notice.buttons ?? [])
      .find((b) => /low/.test(b.label));
    assert.ok(low);
    t.messenger.press(OWNER, low.payload);
    await resumed.tick(world.now);
    const started = world.calls.find((c) => c.verb === 'start');
    assert.deepEqual(started?.args[0], {
      windowId: 'w2',
      cwd: SITE,
      prompt: 'Original job',
      correlation,
      brand: 'codex',
      model: 'gpt-picker',
      effort: 'low',
      selection: 'catalog'
    });
    t.messenger.press(OWNER, low.payload);
    await resumed.tick(world.now);
    assert.equal(world.calls.filter((c) => c.verb === 'start').length, 1);
    await resumed.stop();
  });
});

async function pickerRig(options: FakeOptions = {}) {
  const world = new World();
  const messenger = fake.fakeMessenger(options);
  const catalog: import('../../core/model_listing').RemoteModels & {
    remoteSelection: { defaultTarget: import('../../core/model').LaunchTarget };
  } = {
    models: {
      brands: [],
      models: [
        {
          brand: 'claude' as const,
          model: 'reasoner',
          name: 'Reasoner',
          efforts: [{ value: 'high' }, { value: 'low' }],
          defaultEffort: 'high',
          preferredEffort: 'low'
        }
      ]
    },
    remoteSelection: {
      defaultTarget: { brand: 'claude' as const, model: 'reasoner', effort: 'low' }
    }
  };
  world.verbs.models = () => Promise.resolve(catalog);
  const create = () =>
    new engine.Bridge({
      messenger,
      verbs: world.verbs,
      allowlist: [OWNER],
      clock: () => world.now,
      claims: () => Promise.resolve(world.claims)
    });
  let bridge = create();
  await bridge.load();
  await bridge.observe([], world.claims);
  bridge.connect();
  const drain = () => bridge.tick(world.now);
  const buttons = () =>
    messenger
      .posts()
      .filter((p) => !p.notice.settled)
      .flatMap((p) => p.notice.buttons ?? []);
  const tap = async (label: string) => {
    const button = buttons().find((b) => b.label === label);
    assert.ok(button, label);
    messenger.press(OWNER, button.payload);
    await drain();
  };
  return {
    world,
    messenger,
    catalog,
    drain,
    tap,
    buttons,
    bridge: () => bridge,
    async reload() {
      await bridge.stop();
      bridge = create();
      await bridge.load();
      await bridge.observe(world.board(), world.claims);
      bridge.connect();
    },
    async begin() {
      messenger.say(OWNER, 'original');
      await drain();
    }
  };
}

describe('pending job lifecycle', () => {
  it('dispatches a complete choice when settlement crosses its selection deadline', async () => {
    const t = await pickerRig();
    await t.begin();
    const deadline = (await store.readConversations())[0]?.held?.expiresAt;
    assert.ok(deadline);
    const edit = t.messenger.edit;
    assert.ok(edit);
    const settle = edit.settle.bind(edit);
    edit.settle = (message, notice) => {
      t.world.now = deadline + 1;
      return settle(message, notice);
    };
    t.world.now = deadline - 1;
    await t.tap('Use window default');
    assert.equal(t.world.calls.filter((call) => call.verb === 'start').length, 1);
    assert.equal((await store.readConversations())[0]?.state, 'live');
    await t.bridge().stop();
  });

  it('refreshes choices when a captured catalog default without effort disappears', async () => {
    const t = await pickerRig();
    const listings = await import('../../core/model_listing');
    t.catalog.models.models = [{ brand: 'claude', model: 'older', name: 'Older' }];
    t.catalog.remoteSelection.defaultTarget = { brand: 'claude', model: 'older' };
    await t.begin();
    const current = { models: { brands: [], models: [] }, remoteSelection: { defaultTarget: {} } };
    t.world.verbs.models = () => Promise.resolve(current);
    const start = t.world.verbs.start.bind(t.world.verbs);
    t.world.verbs.start = (input) => {
      const result = listings.remoteTarget(input, current.models, () => undefined);
      return result.ok ? start(input) : Promise.resolve(result);
    };
    await t.tap('Use window default');
    assert.equal(t.world.calls.filter((call) => call.verb === 'start').length, 0);
    const held = (await store.readConversations())[0]?.held;
    assert.equal(held?.prompt, 'original');
    assert.equal(held?.picker?.stage, 'model');
    assert.deepEqual(held?.picker?.catalog, current);
    await t.bridge().stop();
  });

  for (const mode of MODES)
    for (const transition of ['model', 'page'] as const)
      for (const change of ['closed', 'replaced'] as const)
        it(`${mode.name}: resets ${transition} selection when its window is ${change}`, async () => {
          const t = await pickerRig({ ...mode.fake, perNotice: 2 });
          t.catalog.models.models = Array.from({ length: 4 }, (_, i) => ({
            ...t.catalog.models.models[0]!,
            model: `reasoner-${i}`,
            name: `Reasoner ${i}`
          }));
          await t.begin();
          const deadline = (await store.readConversations())[0]?.held?.expiresAt;
          const model = t.buttons().find((button) => button.label.includes('Reasoner'));
          assert.ok(model);
          t.world.claims = [claim('w2', change === 'replaced' ? APP : SITE)];
          await t.tap(transition === 'page' ? 'Next' : model.label);
          const held = (await store.readConversations())[0]?.held;
          assert.equal(held?.picker?.stage, 'folder');
          assert.equal(held?.picker?.catalog, undefined);
          assert.equal(held?.picker?.target, undefined);
          assert.equal(held?.prompt, 'original');
          assert.equal(held?.expiresAt, deadline);
          assert.equal(t.world.calls.filter((call) => call.verb === 'start').length, 0);
          await t.bridge().stop();
        });

  for (const mode of MODES)
    it(`${mode.name}: ignores legacy folder buttons after a migrated start reloads`, async () => {
      const t = await pickerRig(mode.fake);
      await t.begin();
      const saved = (await store.readConversations())[0];
      assert.ok(saved?.held?.picker?.folder);
      saved.held.picker = { ...saved.held.picker, stage: 'starting', target: {} };
      saved.notices.push({
        id: 'old',
        kind: 'picker',
        message: 'legacy-folder',
        postedAt: t.world.now,
        actions: [{ id: 'old', verb: 'pick', folder: APP }]
      });
      assert.equal(await store.writeConversation(saved), true);
      await t.reload();
      const payload = store.encodePayload(saved.id, 'old');
      assert.ok(payload);
      t.messenger.press(OWNER, payload, 'legacy-folder');
      await t.drain();
      assert.equal((await store.readConversations())[0]?.held?.picker?.stage, 'starting');
      assert.equal(t.world.calls.filter((call) => call.verb === 'start').length, 0);
      await t.bridge().stop();
    });

  it('retires model buttons on Back and cancels without replacing the original prompt', async () => {
    const t = await pickerRig();
    await t.begin();
    const stale = t.buttons().find((b) => b.label.includes('Reasoner'));
    assert.ok(stale);
    await t.tap(stale.label);
    t.messenger.say(OWNER, 'replacement', { in: t.messenger.posts()[0]?.posted.anchor });
    await t.drain();
    assert.equal((await store.readConversations())[0]?.held?.prompt, 'original');
    await t.tap('Back to models');
    const count = t.messenger.posts().length;
    t.messenger.press(OWNER, stale.payload);
    await t.drain();
    assert.equal(t.world.calls.filter((c) => c.verb === 'start').length, 0);
    assert.equal(t.messenger.posts().length, count);
    await t.tap('Cancel');
    await t.reload();
    assert.equal((await store.readConversations())[0]?.held, undefined);
    assert.equal(t.world.calls.filter((c) => c.verb === 'start').length, 0);
    await t.bridge().stop();
  });

  it('expires after discovery awaits, and rechecks fresh claims without an observation', async () => {
    const t = await pickerRig();
    try {
      t.world.verbs.models = () => {
        t.world.now += 10 * 60_000;
        return Promise.resolve(t.catalog);
      };
      await t.begin();
      assert.equal(t.buttons().length, 0);
      assert.equal((await store.readConversations())[0]?.held, undefined);
    } finally {
      await t.bridge().stop();
    }
    const fresh = await pickerRig();
    try {
      await fresh.begin();
      fresh.world.claims = [];
      await fresh.tap('Use window default');
      assert.equal(fresh.world.calls.filter((c) => c.verb === 'start').length, 0);
      assert.equal((await store.readConversations()).at(-1)?.held, undefined);
    } finally {
      await fresh.bridge().stop();
    }
  });

  for (const outcome of ['silent', 'throw'] as const)
    it(`keeps a ${outcome} start inert through reload and deadline`, async () => {
      const t = await pickerRig();
      let starts = 0;
      t.world.verbs.start = async () => {
        starts++;
        assert.equal((await store.readConversations())[0]?.held?.picker?.stage, 'starting');
        if (outcome === 'throw') throw new Error('child may already exist');
        return { ok: false, reason: 'no reply', outcome: 'unknown' };
      };
      await t.begin();
      await t.tap('Use window default');
      t.world.now += 20 * 60_000;
      await t.reload();
      await t.drain();
      assert.equal(starts, 1);
      assert.equal(t.bridge().nextDeadline(), undefined);
      assert.match(t.messenger.posts().at(-1)?.notice.body ?? '', /outcome unknown/);
      await t.bridge().stop();
    });

  it('only a positive no-child refusal permits a later new attempt', async () => {
    const t = await pickerRig();
    let starts = 0;
    const original = t.world.verbs.start.bind(t.world.verbs);
    t.world.verbs.start = async (input) => {
      if (++starts === 1)
        return {
          ok: false,
          reason: 'catalog changed',
          outcome: 'stopped',
          selectionInvalid: true
        };
      return original(input);
    };
    await t.begin();
    const deadline = (await store.readConversations())[0]?.held?.expiresAt;
    await t.tap('Use window default');
    assert.equal(starts, 1);
    assert.equal((await store.readConversations())[0]?.held?.expiresAt, deadline);
    await t.tap('Use window default');
    assert.equal(starts, 2);
    assert.equal((await store.readConversations())[0]?.state, 'live');
    await t.bridge().stop();
  });

  it('offers Retry after discovery fails without starting implicitly', async () => {
    const t = await pickerRig();
    let reads = 0;
    t.world.verbs.models = () => {
      if (++reads === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve(t.catalog);
    };
    await t.begin();
    assert.deepEqual(
      t.buttons().map((b) => b.label),
      ['Retry', 'Cancel']
    );
    await t.tap('Retry');
    assert.ok(t.buttons().some((b) => b.label === 'Use window default'));
    assert.equal(t.world.calls.filter((c) => c.verb === 'start').length, 0);
    await t.bridge().stop();
  });

  it('binds a reused payload to its recorded message after a post was not saved', async () => {
    const world = new World();
    const m = fake.fakeMessenger();
    const displaced = paths.CONVERSATIONS_DIR + '-displaced';
    let block = true;
    const wrapped: Messenger = {
      ...m,
      async post(place, notice) {
        const posted = await m.post(place, notice);
        if (block) {
          block = false;
          await fs.rename(paths.CONVERSATIONS_DIR, displaced);
          await fs.writeFile(paths.CONVERSATIONS_DIR, 'cannot save');
        }
        return posted;
      }
    };
    const create = () =>
      new engine.Bridge({
        messenger: wrapped,
        verbs: world.verbs,
        allowlist: [OWNER],
        clock: () => world.now
      });
    let b = create();
    await b.load();
    await b.observe([], world.claims);
    b.connect();
    m.say(OWNER, 'original');
    await b.tick(world.now);
    const ghost = m.posts()[0];
    assert.ok(ghost);
    const payload = ghost.notice.buttons?.find(
      (button) => button.label === 'Use window default'
    )?.payload;
    assert.ok(payload);
    await b.stop();
    await fs.rm(paths.CONVERSATIONS_DIR);
    await fs.rename(displaced, paths.CONVERSATIONS_DIR);
    b = create();
    await b.load();
    await b.observe([], world.claims);
    b.connect();
    await b.tick(world.now);
    const active = m.posts().at(-1);
    assert.ok(active);
    assert.equal(
      active.notice.buttons?.find((button) => button.label === 'Use window default')?.payload,
      payload
    );
    m.press(OWNER, payload, ghost.posted.message);
    await b.tick(world.now);
    assert.equal(world.calls.filter((c) => c.verb === 'start').length, 0);
    m.press(OWNER, payload, active.posted.message);
    await b.tick(world.now);
    assert.equal(world.calls.filter((c) => c.verb === 'start').length, 1);
    await b.stop();
  });
});

describe('persisting a new job before publishing choices', () => {
  it('does not publish or start when the initial draft cannot be saved', async () => {
    await fs.mkdir(path.dirname(paths.CONVERSATIONS_DIR), { recursive: true });
    await fs.writeFile(paths.CONVERSATIONS_DIR, 'blocked');
    const t = await pickerRig();
    try {
      await t.begin();
      assert.equal(t.messenger.posts().length, 0);
      assert.equal(t.world.calls.filter((call) => call.verb === 'start').length, 0);
    } finally {
      await t.bridge().stop();
      await fs.rm(paths.CONVERSATIONS_DIR);
    }
  });
});

describe('discovery interrupted by reload', () => {
  it('resumes the selected sole folder before any notice without asking for a folder again', async () => {
    const t = await pickerRig();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.world.verbs.models = async () => {
      entered();
      await waiting;
      return t.catalog;
    };
    t.messenger.say(OWNER, 'original');
    await reading;
    const savedStage = (await store.readConversations())[0]?.held?.picker?.stage;
    const stopping = t.bridge().stop();
    release();
    await stopping;
    t.world.verbs.models = () => Promise.resolve(t.catalog);
    await t.reload();
    await t.drain();
    assert.equal(savedStage, 'model');
    assert.ok(t.buttons().some((button) => button.label === 'Use window default'));
    assert.ok(t.buttons().every((button) => button.label !== 'agentsview'));
    assert.equal(t.world.calls.filter((call) => call.verb === 'start').length, 0);
    await t.bridge().stop();
  });
});

describe('older models', () => {
  async function withOlder() {
    const t = await pickerRig();
    t.catalog.models.models.push({
      brand: 'claude',
      model: 'vintage',
      name: 'Vintage',
      legacy: true
    });
    await t.begin();
    return t;
  }
  const labels = (t: Awaited<ReturnType<typeof pickerRig>>) => t.buttons().map((b) => b.label);

  it('hides them again, and keeps them shown across a reload', async () => {
    const t = await withOlder();
    await t.tap('Show older models');
    await t.reload();
    assert.ok(labels(t).includes('Older · claude · Vintage'));
    await t.tap('Hide older models');
    assert.ok(!labels(t).some((label) => label.includes('Vintage')));
    await t.bridge().stop();
  });
});
