import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { Deduper } from '../../core/bridge/allow';
import * as fake from '../../core/bridge/fake';
import type { Inbound, Routed, SessionAddr, Watched } from '../../core/bridge/model';
import * as route from '../../core/bridge/route';
import type { ConversationRecord, NoticeRecord } from '../../core/bridge/store';
import * as words from '../../core/bridge/words';
import type { PendingRequest } from '../../core/live';
import type { Session, WindowClaim } from '../../core/model';

const APP = path.resolve('/repo/app');
const SITE = path.resolve('/repo/site');
const T0 = 1_700_000_000_000;
const OWNER = 'T1:U1';
const STRANGER = 'T1:U9';

function session(pid: number, over: Partial<Session> = {}): Session {
  return {
    pid,
    sessionId: `s${pid}`,
    cwd: APP,
    repoRoot: APP,
    name: `n${pid}`,
    status: 'idle',
    hasCommand: false,
    startedAt: T0 + pid,
    updatedAt: T0 + pid,
    transcript: `/t/${pid}.jsonl`,
    source: 'owned',
    windowId: 'w1',
    ...over
  };
}

function watched(pid: number, over: Partial<Session> = {}, pending: PendingRequest[] = []) {
  return { session: session(pid, over), pending, label: `n${pid}` } satisfies Watched;
}

const addr = (w: Watched): SessionAddr => ({
  pid: w.session.pid,
  startedAt: w.session.startedAt,
  windowId: 'w1'
});

const permission = (requestId: string, over: Partial<PendingRequest> = {}): PendingRequest => ({
  requestId,
  toolName: 'Bash',
  ask: false,
  input: { command: 'rm -rf build' },
  ...over
});

const question = (requestId: string): PendingRequest => ({
  requestId,
  toolName: 'AskUserQuestion',
  ask: true,
  questions: [{ question: 'Which database?', multiSelect: false, options: [{ label: 'SQLite' }] }]
});

function claim(id: string, folder: string, updatedAt = T0): WindowClaim {
  return { id, label: `window ${id}`, app: 'Code', folder, shellPids: [], updatedAt };
}

function conversation(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schema: 1,
    id: 'conv0001',
    messenger: 'fake',
    anchor: 'A',
    refs: ['A'],
    latest: 'A',
    owner: OWNER,
    state: 'live',
    past: [],
    notices: [],
    createdAt: T0,
    updatedAt: T0,
    ...over
  };
}

function rooted(w: Watched, over: Partial<ConversationRecord> = {}): ConversationRecord {
  return conversation({
    root: {
      pid: w.session.pid,
      startedAt: w.session.startedAt,
      sessionId: w.session.sessionId,
      brand: 'claude',
      cwd: w.session.cwd,
      label: w.label
    },
    ...over
  });
}

function notice(over: Partial<NoticeRecord>): NoticeRecord {
  return { id: 'n1', kind: 'permission', message: 'M1', postedAt: T0, actions: [], ...over };
}

type Ctx = route.RouteContext;

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    allowlist: [OWNER],
    deduper: new Deduper(),
    now: T0 + 1000,
    store: [],
    board: [],
    claims: [claim('w1', APP)],
    windowFor: (cwd) =>
      Promise.resolve(
        cwd.startsWith(APP) ? { window: claim('w1', APP) } : { refuse: words.notOpenNotice(cwd) }
      ),
    ...over
  };
}

let ids = 0;

function say(
  text: string,
  refs: string[] = ['A'],
  sender = OWNER
): Extract<Inbound, { kind: 'message' }> {
  return {
    kind: 'message',
    id: `e${++ids}`,
    sender: { id: sender },
    text,
    addressed: 'direct',
    refs,
    ref: `u${ids}`,
    at: T0
  };
}

function press(payload: string, sender = OWNER): Inbound {
  return { kind: 'press', id: `e${++ids}`, sender: { id: sender }, payload, message: 'M1' };
}

function command(name: 'list' | 'new' | 'end' | 'help', args = '', sender = OWNER): Inbound {
  return { kind: 'command', id: `e${++ids}`, sender: { id: sender }, name, args, refs: [] };
}

function as<K extends Routed['kind']>(routed: Routed, kind: K): Extract<Routed, { kind: K }> {
  assert.equal(routed.kind, kind, JSON.stringify(routed));
  return routed as Extract<Routed, { kind: K }>;
}

describe('route: who may act (D9) and what arrives twice', () => {
  it('drops a stranger’s press before any lookup', async () => {
    const touched: string[] = [];
    const trap = new Proxy(ctx(), {
      get(target, key, receiver) {
        if (key !== 'allowlist') touched.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      }
    });
    const routed = await route.route(press('conv0001.a', STRANGER), trap);
    assert.deepEqual(routed, { kind: 'drop', why: 'stranger' });
    assert.deepEqual(touched, []);
  });

  it('drops a stranger’s help, and answers the owner’s at home', async () => {
    assert.deepEqual(await route.route(command('help', 'what', STRANGER), ctx()), {
      kind: 'drop',
      why: 'stranger'
    });
    assert.deepEqual(await route.route(command('help', 'what'), ctx()), {
      kind: 'help',
      sender: OWNER,
      text: 'what'
    });
  });

  it('drops a repeat delivery once it has been routed', async () => {
    const c = ctx();
    const event = command('list');
    assert.equal((await route.route(event, c)).kind, 'list');
    assert.deepEqual(await route.route(event, c), { kind: 'drop', why: 'repeat' });
  });

  it('drops a message with no text', async () => {
    assert.deepEqual(await route.route(say('  '), ctx()), { kind: 'drop', why: 'empty' });
  });
});

describe('route: typed text goes to the root (D17), its state picks the verb (D20)', () => {
  const reply = async (root: Watched, board: Watched[] = [root]) =>
    as(await route.route(say('go on'), ctx({ store: [rooted(root)], board })), 'reply');

  it('sends to an idle root', async () => {
    const root = watched(10);
    const routed = await reply(root);
    assert.equal(routed.verb, 'send');
    assert.deepEqual(routed.to, addr(root));
    assert.equal(routed.text, 'go on');
    assert.equal(routed.conversation, 'conv0001');
    assert.equal(routed.because, undefined);
  });

  it('sends to a busy root, held because it is busy', async () => {
    const routed = await reply(watched(10, { status: 'busy' }));
    assert.equal(routed.verb, 'send');
    assert.equal(routed.because, 'busy');
  });

  it('answers a root waiting on one question', async () => {
    const routed = await reply(watched(10, { status: 'waiting' }, [question('q1')]));
    assert.equal(routed.verb, 'answer');
    assert.equal(routed.requestId, 'q1');
  });

  it('sends to a root waiting on a permission, held because of it', async () => {
    const routed = await reply(watched(10, { status: 'waiting' }, [permission('p1')]));
    assert.equal(routed.verb, 'send');
    assert.equal(routed.requestId, undefined);
    assert.equal(routed.because, 'permission');
  });

  it('sends to a root holding two requests, held because of both', async () => {
    const routed = await reply(
      watched(10, { status: 'waiting' }, [question('q1'), question('q2')])
    );
    assert.equal(routed.verb, 'send');
    assert.equal(routed.because, 'several');
  });

  it('reaches the root, not the child, from a thread a child posts in', async () => {
    const root = watched(10);
    const child = watched(11, { parentSessionId: 's10' }, [question('q1')]);
    const routed = await reply(root, [root, child]);
    assert.deepEqual(routed.to, addr(root));
    assert.equal(routed.verb, 'send');
  });

  it('takes an @mention inside a known thread to that conversation’s root', async () => {
    const root = watched(10);
    const event = { ...say('status?'), addressed: 'mention' as const };
    const routed = as(
      await route.route(event, ctx({ store: [rooted(root)], board: [root] })),
      'reply'
    );
    assert.deepEqual(routed.to, addr(root));
  });

  it('joins a thread it does not know on an @mention, under the thread’s root', async () => {
    const event = { ...say('weigh in?', ['B']), addressed: 'mention' as const };
    const routed = as(await route.route(event, ctx({ store: [rooted(watched(10))] })), 'job');
    assert.deepEqual(routed.place, { under: 'B' });
    assert.equal(routed.joined, true);
    assert.equal(routed.text, 'weigh in?');
    assert.equal(routed.job.kind, 'start');
  });

  it('joins on an @mention in the record admission minted, under its anchor', async () => {
    const minted = conversation({ id: 'conv0002', anchor: 'B', refs: ['B'], latest: 'u0' });
    const event = { ...say('weigh in?', ['B']), addressed: 'mention' as const };
    const routed = as(await route.route(event, ctx({ store: [minted] })), 'job');
    assert.deepEqual(routed.place, { under: 'B' });
    assert.equal(routed.joined, true);
  });

  it('answers a direct reply inside a thread it does not know as an orphan', async () => {
    const event = say('status?', ['B']);
    const routed = as(await route.route(event, ctx({ store: [rooted(watched(10))] })), 'orphan');
    assert.deepEqual(routed.place, { under: event.ref });
  });

  it('answers an @mention as an orphan where a conversation has history', async () => {
    const mention = (refs: string[]) => ({ ...say('again?', refs), addressed: 'mention' as const });
    const cancelled = conversation({ id: 'conv0003', anchor: 'C', refs: ['C'], state: 'held' });
    const ended = conversation({ id: 'conv0004', anchor: 'D', refs: ['D'], past: ['s9'] });
    const c = ctx({ store: [cancelled, ended] });
    as(await route.route(mention(['C']), c), 'orphan');
    as(await route.route(mention(['D']), c), 'orphan');
  });

  it('refuses a reply in a held prompt’s thread until a folder is picked', async () => {
    const held = conversation({
      state: 'held',
      held: { prompt: 'fix it', folders: ['/a', '/b'], expiresAt: T0 + 600_000 }
    });
    const routed = as(await route.route(say('hurry'), ctx({ store: [held] })), 'refuse');
    assert.deepEqual(routed.notice, words.pickFirstNotice);
  });
});

describe('route: a reply to an ended root (D23, D26)', () => {
  it('starts a fresh session where the root ran, with its brand and its id', async () => {
    const root = watched(10, { cwd: path.join(APP, 'sub') });
    const record = rooted(root, { past: [] });
    const routed = as(await route.route(say('again'), ctx({ store: [record] })), 'fresh');
    assert.deepEqual(routed, {
      kind: 'fresh',
      conversation: 'conv0001',
      windowId: 'w1',
      cwd: path.join(APP, 'sub'),
      text: 'again',
      brand: 'claude',
      past: 's10'
    });
  });

  it('refuses when no window holds the directory, naming it', async () => {
    const root = watched(10, { cwd: '/elsewhere' });
    const routed = as(await route.route(say('again'), ctx({ store: [rooted(root)] })), 'refuse');
    assert.deepEqual(routed.place, { conversation: { anchor: 'A', latest: 'A' } });
    assert.match(routed.notice.body, /^elsewhere is not open/);
  });

  it('sends to a root the engine just started, though no board shows it yet', async () => {
    const root = watched(10);
    const starting = [{ pid: 10, startedAt: T0 + 10, windowId: 'w2' }];
    const routed = as(
      await route.route(say('again'), ctx({ store: [rooted(root)], starting })),
      'reply'
    );
    assert.deepEqual(routed.to, starting[0]);
    assert.equal(routed.verb, 'send');
    assert.equal(routed.because, 'busy');
  });

  it('treats a root whose process exited as ended, though its card is still drawn', async () => {
    const root = watched(10, { status: 'busy' });
    const crashed = { ...root, exit: { code: 1, signal: null } };
    const routed = await route.route(
      say('again'),
      ctx({ store: [rooted(root)], board: [crashed] })
    );
    assert.equal(routed.kind, 'fresh');
  });

  it('treats a root an End is taking down as ended, though no pass has seen it go', async () => {
    const root = watched(10);
    const routed = await route.route(
      say('again'),
      ctx({ store: [rooted(root)], board: [root], ending: [addr(root)] })
    );
    assert.equal(routed.kind, 'fresh');
  });

  it('settles a button on a session whose process exited as ended', async () => {
    const root = watched(10, { status: 'waiting' }, [permission('p1')]);
    const crashed = { ...root, exit: { code: null, signal: 'SIGKILL' } };
    const store = [
      rooted(root, {
        notices: [
          notice({
            target: addr(root),
            requestId: 'p1',
            actions: [
              { id: 'a', verb: 'deny' },
              { id: 'b', verb: 'stop' }
            ]
          })
        ]
      })
    ];
    for (const payload of ['conv0001.a', 'conv0001.b']) {
      const routed = as(
        await route.route(press(payload), ctx({ store, board: [crashed] })),
        'stale'
      );
      assert.equal(routed.word, words.SESSION_ENDED);
    }
    const ended = await route.route(command('end', '10'), ctx({ board: [crashed] }));
    assert.equal(ended.kind, 'refuse');
  });

  it('treats a root whose pid came back under another start as ended', async () => {
    const root = watched(10);
    const recycled = watched(10, { startedAt: T0 + 99_999 });
    const routed = await route.route(
      say('again'),
      ctx({ store: [rooted(root)], board: [recycled] })
    );
    assert.equal(routed.kind, 'fresh');
  });
});

describe('route: a message that arrives late', () => {
  const MINUTE = 60_000;
  const late = (message: Extract<Inbound, { kind: 'message' }>, minutes: number) => ({
    ...message,
    at: T0 + 1000 - minutes * MINUTE
  });

  it('answers a late top-level message under it, and starts nothing', async () => {
    const message = late(say('run the tests', []), 16);
    const routed = as(await route.route(message, ctx()), 'refuse');
    assert.deepEqual(routed.place, { under: message.ref });
    assert.deepEqual(routed.notice, words.missedOfflineNotice);
  });

  it('answers a late reply in its thread, and sends nothing', async () => {
    const root = watched(10);
    const routed = as(
      await route.route(
        late(say('and the docs'), 16),
        ctx({ store: [rooted(root)], board: [root] })
      ),
      'refuse'
    );
    assert.deepEqual(routed.place, { under: 'A' });
    assert.deepEqual(routed.notice, words.missedOfflineNotice);
  });

  it('acts on a message just inside the window', async () => {
    as(await route.route(late(say('run the tests', []), 14), ctx()), 'job');
  });

  it('drops a late stranger before anything is said', async () => {
    assert.deepEqual(await route.route(late(say('hi', [], STRANGER), 16), ctx()), {
      kind: 'drop',
      why: 'stranger'
    });
  });
});

describe('route: new jobs (D24, D28)', () => {
  it('starts a job from a top-level message, under that message', async () => {
    const event = say('fix the build', []);
    const routed = as(await route.route(event, ctx()), 'job');
    assert.deepEqual(routed.place, { under: event.ref });
    assert.equal(routed.joined, undefined);
    assert.equal(routed.text, 'fix the build');
    assert.deepEqual(routed.job, {
      kind: 'start',
      folder: { folder: APP, windowId: 'w1' }
    });
  });

  it('holds for a pick with two folders open', async () => {
    const claims = [claim('w1', APP), claim('w2', SITE)];
    const routed = as(await route.route(say('fix it', []), ctx({ claims })), 'job');
    assert.equal(routed.job.kind, 'hold');
  });

  it('refuses with no folder open', async () => {
    const routed = as(await route.route(say('fix it', []), ctx({ claims: [] })), 'job');
    assert.deepEqual(routed.job, { kind: 'refuse' });
  });

  it('starts `new` at the sender’s home, and treats an empty one as help', async () => {
    const routed = as(await route.route(command('new', 'write docs'), ctx()), 'job');
    assert.deepEqual(routed.place, { home: OWNER });
    assert.equal(routed.text, 'write docs');
    assert.deepEqual(await route.route(command('new', ' '), ctx()), {
      kind: 'help',
      sender: OWNER,
      text: ''
    });
  });

  it('in chain mode, a top-level message starts a job and never reaches the latest conversation', async () => {
    const messenger = fake.fakeMessenger({ shape: 'chain' });
    const root = watched(10);
    const posted = await messenger.post({ home: OWNER }, { kind: 'finished', body: 'Done.' });
    const record = rooted(root, {
      anchor: posted.anchor,
      refs: [posted.anchor, posted.message],
      latest: posted.message
    });
    const c = ctx({ store: [record], board: [root] });
    const events: Inbound[] = [];
    messenger.connect((event) => events.push(event));
    messenger.say(OWNER, 'a new thing');
    messenger.say(OWNER, 'more on that', { replyTo: posted.message });
    const [top, reply] = events;
    assert.ok(top && reply);
    assert.equal((await route.route(top, c)).kind, 'job');
    assert.equal((await route.route(reply, c)).kind, 'reply');
  });
});

describe('route: buttons act on the session they name (D18)', () => {
  const root = watched(10, { status: 'waiting' });
  const child = watched(11, { parentSessionId: 's10', status: 'waiting' }, [permission('p1')]);
  const grand = watched(12, { parentSessionId: 's11' });

  const permissionOf = (target: Watched) =>
    notice({
      target: addr(target),
      requestId: 'p1',
      actions: [
        { id: 'a', verb: 'deny' },
        { id: 'b', verb: 'end' }
      ]
    });

  it('denies a child’s request, not the root’s', async () => {
    const store = [rooted(root, { notices: [permissionOf(child)] })];
    const routed = as(
      await route.route(press('conv0001.a'), ctx({ store, board: [root, child] })),
      'deny'
    );
    assert.deepEqual(routed, {
      kind: 'deny',
      to: addr(child),
      requestId: 'p1',
      reason: true,
      conversation: 'conv0001',
      notice: 'n1'
    });
  });

  it('carries a request that takes no reason', async () => {
    const quiet = watched(11, { parentSessionId: 's10' }, [
      permission('p1', { canDenyReason: false })
    ]);
    const store = [rooted(root, { notices: [permissionOf(quiet)] })];
    const routed = as(
      await route.route(press('conv0001.a'), ctx({ store, board: [root, quiet] })),
      'deny'
    );
    assert.equal(routed.reason, false);
  });

  it('settles Deny on a request that has closed as no longer waiting', async () => {
    const closed = watched(11, { parentSessionId: 's10' });
    const store = [rooted(root, { notices: [permissionOf(closed)] })];
    const routed = as(
      await route.route(press('conv0001.a'), ctx({ store, board: [root, closed] })),
      'stale'
    );
    assert.equal(routed.word, words.NO_LONGER_WAITING);
  });

  it('settles a button whose session has gone', async () => {
    const store = [rooted(root, { notices: [permissionOf(child)] })];
    const routed = as(
      await route.route(press('conv0001.b'), ctx({ store, board: [root] })),
      'stale'
    );
    assert.equal(routed.word, words.SESSION_ENDED);
  });

  it('settles a press on a notice already settled with what it said', async () => {
    const store = [rooted(root, { notices: [{ ...permissionOf(child), settled: words.DENIED }] })];
    const routed = as(
      await route.route(press('conv0001.a'), ctx({ store, board: [root, child] })),
      'stale'
    );
    assert.equal(routed.word, words.DENIED);
  });

  it('counts the descent of a busy root on End', async () => {
    const busy = watched(10, { status: 'busy' }, [permission('p1')]);
    const store = [rooted(busy, { notices: [permissionOf(busy)] })];
    const routed = as(
      await route.route(press('conv0001.b'), ctx({ store, board: [busy, child, grand] })),
      'end'
    );
    assert.deepEqual(routed.to, addr(busy));
    assert.equal(routed.label, 'n10');
    assert.equal(routed.conversation, 'conv0001');
    assert.deepEqual(routed.members, [addr(child), addr(grand)]);
  });

  it('ends exactly the members the confirm counted, not a child spawned since', async () => {
    const confirm = notice({
      id: 'n2',
      kind: 'confirm',
      target: addr(root),
      members: [addr(child)],
      actions: [
        { id: 'c', verb: 'end-confirm' },
        { id: 'd', verb: 'cancel' }
      ]
    });
    const store = [rooted(root, { notices: [confirm] })];
    const late = watched(13, { parentSessionId: 's10' });
    const c = ctx({ store, board: [root, child, late] });
    assert.deepEqual(await route.route(press('conv0001.c'), c), {
      kind: 'end-confirmed',
      to: addr(root),
      members: [addr(child)],
      conversation: 'conv0001',
      notice: 'n2'
    });
    assert.deepEqual(await route.route(press('conv0001.d'), c), {
      kind: 'cancel',
      conversation: 'conv0001',
      notice: 'n2'
    });
  });

  it('routes Stop to the verb whatever the board last saw: the window holding the pipe says', async () => {
    const receipt = (target: Watched) =>
      notice({ kind: 'receipt', target: addr(target), actions: [{ id: 's', verb: 'stop' }] });
    const busy = watched(10, { status: 'busy' });
    assert.deepEqual(
      await route.route(
        press('conv0001.s'),
        ctx({ store: [rooted(busy, { notices: [receipt(busy)] })], board: [busy] })
      ),
      { kind: 'stop', to: addr(busy), conversation: 'conv0001', notice: 'n1' }
    );
    // A pass up to five seconds old reads a turn begun since as idle; the
    // receipt the Stop is on is itself evidence of a turn.
    const idle = watched(10);
    assert.deepEqual(
      await route.route(
        press('conv0001.s'),
        ctx({ store: [rooted(idle, { notices: [receipt(idle)] })], board: [idle] })
      ),
      { kind: 'stop', to: addr(idle), conversation: 'conv0001', notice: 'n1' }
    );
  });

  it('drops a payload that names no button the store holds', async () => {
    const store = [rooted(root, { notices: [permissionOf(child)] })];
    for (const payload of ['conv0001.z', 'other001.a', 'not a payload']) {
      assert.deepEqual(await route.route(press(payload), ctx({ store, board: [root, child] })), {
        kind: 'drop',
        why: 'unknown'
      });
    }
  });
});

describe('route: picking a folder (D24, D39)', () => {
  const held = (expiresAt: number) =>
    conversation({
      state: 'held',
      held: { prompt: 'fix it', folders: [APP, SITE], expiresAt },
      notices: [
        notice({
          kind: 'picker',
          actions: [
            { id: 'a', verb: 'pick', folder: APP },
            { id: 'b', verb: 'pick', folder: SITE }
          ]
        })
      ]
    });
  const claims = [claim('w1', APP), claim('w2', SITE)];

  it('starts in the picked folder’s window', async () => {
    const routed = as(
      await route.route(press('conv0001.b'), ctx({ store: [held(T0 + 600_000)], claims })),
      'pick'
    );
    assert.equal(routed.folder, SITE);
    assert.deepEqual(routed.picked, {
      kind: 'start',
      folder: { folder: SITE, windowId: 'w2' }
    });
  });

  it('says expired after ten minutes', async () => {
    const routed = as(
      await route.route(press('conv0001.a'), ctx({ store: [held(T0)], claims })),
      'pick'
    );
    assert.deepEqual(routed.picked, { kind: 'expired' });
  });
});

describe('route: commands', () => {
  const root = watched(10, { status: 'busy' });
  const child = watched(11, { parentSessionId: 's10' });

  it('lists for the sender', async () => {
    assert.deepEqual(await route.route(command('list'), ctx()), { kind: 'list', sender: OWNER });
  });

  it('asks to end the pid `list` printed, counting its descent, at home (U5)', async () => {
    const routed = as(
      await route.route(command('end', ' 10 '), ctx({ board: [root, child] })),
      'end'
    );
    assert.deepEqual(routed, {
      kind: 'end',
      to: addr(root),
      label: 'n10',
      members: [addr(child)],
      sender: OWNER
    });
  });

  it('refuses `end` for a pid not on the board, or none', async () => {
    for (const args of ['99', 'abc', '']) {
      const routed = as(await route.route(command('end', args), ctx({ board: [root] })), 'refuse');
      assert.deepEqual(routed.place, { home: OWNER });
      assert.deepEqual(routed.notice, words.noSuchSessionNotice(args));
    }
  });
});
