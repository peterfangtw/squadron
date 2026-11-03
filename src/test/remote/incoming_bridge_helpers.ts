import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import type {
  IncomingEvidenceQuery,
  IncomingHolder,
  Inbound,
  Watched
} from '../../core/bridge/model';
import type { Bridge } from '../../core/bridge/bridge';
import type { Reply, RequestBody } from '../../core/coordination/requests';
import type { BrandId } from '../../core/model';
import type { Messenger, Sink } from '../../core/bridge/port';
import * as children from './incoming_owner_helpers';

export async function make(
  cwd: string,
  options: {
    brand?: BrandId;
    root?: boolean;
    foreign?: boolean;
    sendReply?: (reply: Reply) => Promise<Reply>;
    startReply?: (reply: Reply) => Promise<Reply>;
    switch?: boolean;
    incomingFiles?: Messenger['incomingFiles'];
  } = {}
) {
  const ownership = await import('../../core/owned_incoming');
  const engine = await import('../../core/bridge/bridge');
  const fake = await import('../../core/bridge/fake');
  const remote = await import('../../core/remote/verbs');
  const store = await import('../../core/bridge/store');
  const live = await import('../../core/live');
  const serve = await import('../../core/coordination/serve_owned');
  const requests = await import('../../core/coordination/requests');
  const host = new ownership.IncomingHost('destination');
  const capability = await host.capability();
  assert.ok(capability);
  const holding = options.foreign ? new ownership.IncomingHost('holder-window') : host;
  const holdingAccess = await holding.capability();
  assert.ok(holdingAccess);
  let holder: IncomingHolder = { host: holdingAccess.host, generation: 1 };
  const started: Awaited<ReturnType<typeof children.child>>[] = [];
  const launches = new ownership.IncomingLaunches();
  let now = Date.now();
  let accepting = true;
  let queries = true;
  let sink: Sink = () => {};
  const messenger = fake.fakeMessenger({ held: true, now: () => now });
  const network: Messenger = {
    ...messenger,
    ...(options.incomingFiles ? { incomingFiles: options.incomingFiles } : {}),
    connect(deliver) {
      sink = deliver;
      return messenger.connect(deliver);
    }
  };
  const brand = options.brand ?? 'claude';
  const open = async () => {
    const child = await children.child(host, brand, cwd);
    started.push(child);
    return child;
  };
  const watched = (child: Awaited<ReturnType<typeof children.child>>): Watched => ({
    ...child.owner.snapshot(),
    session: live.toSession(
      child.handle.state,
      {
        pid: child.pid,
        startedAt: child.startedAt,
        brand,
        updatedAt: now
      },
      capability.host.windowId
    ),
    pending: child.handle.state.pending,
    messageFacts: child.handle.state.messageFacts,
    label: 'worker'
  });
  let board: Watched[] = [];
  if (options.root !== false) {
    const first = await open();
    const session = watched(first).session;
    assert.equal(
      await store.writeConversation({
        schema: 1,
        id: 'abcdefgh',
        messenger: 'fake',
        owner: 'owner',
        anchor: 'thread',
        refs: ['thread'],
        latest: 'thread',
        state: 'live',
        root: {
          pid: session.pid,
          startedAt: session.startedAt,
          sessionId: session.sessionId,
          cwd,
          brand,
          label: 'worker'
        },
        notices: [],
        past: [],
        createdAt: now,
        updatedAt: now
      }),
      true
    );
    board = [watched(first)];
  }
  const claim = {
    id: capability.host.windowId,
    label: 'window',
    app: 'Code',
    folder: cwd,
    shellPids: [],
    updatedAt: now
  };
  const port: import('../../core/coordination/serve_owned').ServePort = {
    owned: (pid) => started.find((child) => child.pid === pid)?.handle,
    end: () => false,
    incomingAccess: () => host.capability(),
    currentIncomingHolder: () => (accepting ? holder : undefined),
    holder: () =>
      Promise.resolve(
        accepting
          ? {
              windowId: holder.host.windowId,
              label: 'holder',
              pid: holder.host.pid,
              startedAt: holder.host.osStartedAt,
              since: now,
              incoming: holder
            }
          : undefined
      ),
    incomingHolder: () => port.holder(),
    async start() {
      const child = await open();
      return { ok: true, pid: child.pid, startedAt: child.startedAt, brand };
    },
    incomingStarts: launches,
    startFiles: async (input) => {
      const child = await open();
      const result = await child.owner.start(
        input.attempt,
        () =>
          child.route.messages!.send(
            input.prompt,
            undefined,
            undefined,
            undefined,
            undefined,
            input.attempt.correlation
          ),
        child.publish,
        () => Promise.resolve(accepting)
      );
      const reply: Reply = result.ok
        ? {
            ok: true,
            pid: child.pid,
            startedAt: child.startedAt,
            brand,
            sessionId: child.handle.state.sessionId,
            remoteLaunchEvidence: child.owner.snapshot().remoteLaunchEvidence
          }
        : { ...result, reason: 'start evidence unavailable' };
      return options.startReply ? options.startReply(reply) : reply;
    },
    evidence: (challenge, query) =>
      queries
        ? host.evidence(
            started.map((child) => child.owner),
            challenge,
            query,
            (owner) =>
              started.find((child) => child.owner === owner)?.publish() ?? Promise.resolve(false)
          )
        : Promise.resolve(undefined),
    async deliverIncoming(pid, delivery, outcome, send) {
      const child = started.find((child) => child.pid === pid);
      assert.ok(child);
      const reply = await child.owner.deliver(delivery, outcome, send, child.publish);
      return options.sendReply ? options.sendReply(reply) : reply;
    }
  };
  const ask = async (
    body: RequestBody
  ): Promise<import('../../core/coordination/ask').AskResult> => {
    const file = await requests.postRequest(body);
    assert.ok(file);
    await requests.claimRequests(body.windowId, (request) =>
      request.kind === 'models'
        ? Promise.resolve({
            ok: true,
            models: { brands: [], models: [] },
            incomingAccess: capability,
            remoteSelection: { defaultTarget: { brand } }
          })
        : (serve.serveOwned(request, port) ?? Promise.resolve({ ok: false }))
    );
    const reply = await requests.awaitReply(file, 1000);
    return !reply
      ? { ok: false, kind: 'silent', reason: 'reply withheld', file }
      : reply.ok
        ? { ok: true, reply, file }
        : { ok: false, kind: 'refused', reply, reason: reply.reason ?? 'refused', file };
  };
  const verbs = remote.remoteVerbs({
    windowId: holder.host.windowId,
    ...port,
    holderIdentity: holder,
    start(input) {
      return port.start(input);
    },
    startFiles: (input) =>
      serve.serveOwned(
        {
          ...input,
          kind: 'remoteStartFilesV1',
          windowId: capability.host.windowId,
          id: crypto.randomUUID(),
          createdAt: now
        },
        port
      ),
    models: async () => ({
      models: { brands: [], models: [] },
      incomingAccess: await host.capability(),
      remoteSelection: { defaultTarget: { brand } }
    }),
    ask,
    board: () => board,
    claims: () => Promise.resolve([claim]),
    signal: () => Promise.resolve([])
  });
  const bridges: Bridge[] = [];
  let switching: import('../../core/remote/switch').RemoteSwitch | undefined;
  let allowlist = ['owner'];
  let table: import('../../core/scan').ProcessTable | undefined;
  const build = async () => {
    if (options.switch) {
      const module = await import('../../core/remote/switch');
      const scan = await import('../../core/scan');
      const published = await import('../../core/published');
      switching ??= new module.RemoteSwitch({
        windowId: capability.host.windowId,
        entry: () => fake.fakeEntry,
        allowlist: () => allowlist,
        credentials: () => Promise.resolve({ token: 'fake-local-token' }),
        messenger: () => Promise.resolve({ ok: true, messenger: network }),
        identity: () => {
          holder = { ...holder, generation: holder.generation + 1 };
          return Promise.resolve({
            windowId: capability.host.windowId,
            label: 'holder',
            pid: capability.host.pid,
            startedAt: capability.host.osStartedAt,
            since: now,
            incoming: holder
          });
        },
        own: () => board,
        sessions: {
          ...port,
          evidence: (challenge, query) => port.evidence!(challenge, query),
          startFiles: (input) =>
            serve.serveOwned(
              {
                ...input,
                kind: 'remoteStartFilesV1',
                windowId: capability.host.windowId,
                id: crypto.randomUUID(),
                createdAt: now
              },
              port
            ),
          models: () =>
            Promise.resolve({ models: { brands: [], models: [] }, incomingAccess: capability })
        },
        processes: () => (table ? Promise.resolve(table) : scan.scanProcesses(true)),
        published: () => published.readPublished(),
        lineage: () => Promise.resolve(new Map()),
        claims: () => Promise.resolve([claim]),
        memory: { read: () => Promise.resolve(undefined), write: () => {} },
        keeper: { requestCheck: () => {}, reason: () => undefined, holdsForRemote: () => false },
        register: () => ({
          noticeChange: () => {},
          requestCheck: () => {},
          schedule: () => {},
          dispose: () => {}
        }),
        clock: () => now,
        log: () => {},
        changed: () => {}
      });
      assert.equal((await switching.turnOn()).ok, true);
      return undefined;
    }
    const bridge = new engine.Bridge({
      messenger: network,
      allowlist: ['owner'],
      verbs,
      clock: () => now,
      claims: () => Promise.resolve([claim])
    });
    bridges.push(bridge);
    await bridge.load();
    await bridge.observeIncomingPolicy(
      { messengerId: 'fake', installId: 'install', allowedIds: ['owner'] },
      holder
    );
    await bridge.observe(board, [claim]);
    bridge.connect();
    return bridge;
  };
  let bridge: Bridge | undefined;
  const currentBridge = (): Bridge => {
    assert.ok(bridge);
    return bridge;
  };
  bridge = await build();
  const send = (index = 0, text = 'inspect it', refs = ['thread']) => {
    const event: Extract<Inbound, { kind: 'message' }> = {
      kind: 'message',
      id: `original-${index}`,
      ref: `ref-${index}`,
      refs,
      sender: { id: 'owner' },
      addressed: 'direct',
      text,
      at: now,
      incoming: {
        version: 1,
        installId: 'install',
        omitted: 0,
        files: [
          { id: `file-${index}`, source: `opaque:install:${index}`, cacheKey: `fake_${index}` }
        ]
      }
    };
    sink(event);
    return event;
  };
  return {
    get bridge() {
      return currentBridge();
    },
    host,
    get holder() {
      return holder;
    },
    get remote() {
      return switching!;
    },
    capability,
    started,
    messenger,
    verbs,
    port,
    send,
    async view(id = 'original-0') {
      const message = (await store.readConversations())
        .flatMap((record) => record.messages ?? [])
        .find((message) => message.id === id);
      assert.ok(message);
      const record = (await store.readConversations()).find((record) =>
        record.messages?.some((row) => row.id === id)
      );
      assert.ok(record);
      const view = currentBridge().accessSnapshot(record.id, message.correlation);
      assert.ok(view);
      return view;
    },
    async drain() {
      if (switching) await switching.tick();
      else await currentBridge().tick(now);
    },
    async observe(childrenToShow = started) {
      board = childrenToShow.filter((child) => child.transport.processAlive?.()).map(watched);
      if (switching) await switching.pass();
      else await currentBridge().observe(board, [claim]);
    },
    async reload() {
      await currentBridge().stop();
      bridge = await build();
      return bridge;
    },
    advance(ms: number) {
      now += ms;
    },
    queries(enabled: boolean) {
      queries = enabled;
    },
    scan(value: import('../../core/scan').ProcessTable | undefined) {
      table = value;
    },
    async policy(ids: string[]) {
      allowlist = ids;
      await switching?.settingsChanged();
    },
    accepting(enabled: boolean) {
      accepting = enabled;
    },
    async evidence(query: IncomingEvidenceQuery) {
      return port.evidence!(crypto.randomUUID(), query);
    },
    async close() {
      await switching?.dispose();
      await Promise.all(bridges.map((bridge) => bridge.stop()));
      await Promise.all(started.map((child) => child.close()));
    },
    async press(label: string) {
      const post = [...messenger.posts()]
        .reverse()
        .find((post) => post.notice.buttons?.some((button) => button.label === label));
      const button = post?.notice.buttons?.find((button) => button.label === label);
      assert.ok(button && post, `missing ${label} button`);
      sink({
        kind: 'press',
        id: crypto.randomUUID(),
        sender: { id: 'owner' },
        message: post.posted.message,
        payload: button.payload
      });
      if (switching) await switching.tick();
      else await currentBridge().tick(now);
    },
    deliver(event: Inbound) {
      sink(event);
    }
  };
}
