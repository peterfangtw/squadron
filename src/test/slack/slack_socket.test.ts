import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as wsPkg from 'ws';
import type { LinkState } from '../../core/bridge/port';
import * as api from '../../core/slack/api';
import * as socket from '../../core/slack/socket';
import * as ws from '../../core/slack/ws';
import * as env from '../fixtures/slack_envelopes';
import * as fx from '../fixtures/slack_replies';

const TOKEN = 'xoxb-SENTINEL-bot-0000';
const APP_TOKEN = 'xapp-SENTINEL-app-0000';

/** A socket the test plays Slack's side of. `close` and `terminate` only
 *  record, as a real socket's close event arrives later; `drop` is the close
 *  event. */
class FakeSocket implements socket.SocketLike {
  sent: string[] = [];
  pings = 0;
  closedWith?: number;
  terminated = false;

  constructor(
    readonly url: string,
    private readonly events: socket.SocketEvents
  ) {}

  send(text: string): void {
    this.sent.push(text);
  }
  ping(): void {
    this.pings++;
  }
  close(code: number): void {
    this.closedWith = code;
  }
  terminate(): void {
    this.terminated = true;
  }

  frame(value: unknown): void {
    this.events.message(JSON.stringify(value));
  }
  raw(text: string): void {
    this.events.message(text);
  }
  pong(): void {
    this.events.alive();
  }
  drop(): void {
    this.events.close();
  }
  acks(): unknown[] {
    return this.sent.map((text) => JSON.parse(text) as unknown);
  }
}

type Answer = { json?: unknown; throws?: boolean };

/** Slack's side of a Socket Mode run: the Web API's two calls, every socket
 *  opened, every state and every envelope handed up. */
function rig(
  answer: (method: string) => Answer = (method) =>
    method === 'auth.test' ? { json: fx.authTest() } : { json: fx.connectionsOpen() }
) {
  const methods: string[] = [];
  const sockets: FakeSocket[] = [];
  const states: LinkState[] = [];
  const seen: { envelope: socket.SocketEnvelope; self: unknown }[] = [];
  const order: string[] = [];
  let sink: (envelope: socket.SocketEnvelope) => void = () => undefined;

  const fetch: api.Fetch = (url) => {
    const method = url.slice('https://slack.com/api/'.length);
    methods.push(method);
    const reply = answer(method);
    if (reply.throws) {
      return Promise.reject(new Error('getaddrinfo ENOTFOUND slack.com'));
    }
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(reply.json)
    });
  };

  const mode = socket.openSocketMode({
    fetch,
    api: api.slackApi(fetch, TOKEN),
    appToken: APP_TOKEN,
    openSocket(url, events) {
      const fake = new FakeSocket(url, events);
      const send = fake.send.bind(fake);
      fake.send = (text) => {
        order.push('ack');
        send(text);
      };
      sockets.push(fake);
      return fake;
    },
    onEnvelope(envelope, self) {
      order.push('sink');
      seen.push({ envelope, self });
      sink(envelope);
    },
    onState(state) {
      states.push(state);
    }
  });

  return {
    mode,
    methods,
    sockets,
    states,
    seen,
    order,
    set sink(next: (envelope: socket.SocketEnvelope) => void) {
      sink = next;
    },
    last(): FakeSocket {
      const fake = sockets.at(-1);
      assert.ok(fake, 'no socket was opened');
      return fake;
    }
  };
}

/** Lets every pending promise run, without moving the mocked clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function kinds(states: readonly LinkState[]): string[] {
  return states.map((state) => state.kind);
}

describe('openSocketMode', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('asks auth.test, then a URL, then opens it; connected on hello', async () => {
    const r = rig();
    await flush();
    assert.deepEqual(r.methods, ['auth.test', 'apps.connections.open']);
    assert.equal(r.sockets.length, 1);
    assert.equal(r.last().url, fx.connectionsOpen().url);
    assert.deepEqual(r.states, [], 'still connecting until hello');

    r.last().frame(env.hello());
    assert.deepEqual(r.states, [{ kind: 'connected' }]);
    r.mode.close();
  });

  it('hands an envelope up with the bot, then acks it on the same socket', async () => {
    const r = rig();
    await flush();
    r.last().frame(env.hello());
    r.last().frame(env.eventsApi(env.dmMessage()));

    assert.deepEqual(r.order, ['sink', 'ack']);
    assert.deepEqual(r.last().acks(), [{ envelope_id: env.eventsApi({}).envelope_id }]);
    const [first] = r.seen;
    assert.equal(first?.envelope.type, 'events_api');
    assert.deepEqual(first?.self, { userId: env.BOT_USER, teamId: env.TEAM, botId: env.BOT_ID });
    r.mode.close();
  });

  it('acks an envelope whose sink threw', async () => {
    const r = rig();
    await flush();
    r.sink = () => {
      throw new Error('sink failed');
    };
    r.last().frame(env.blockActions());
    assert.deepEqual(r.last().acks(), [{ envelope_id: env.blockActions().envelope_id }]);
    r.mode.close();
  });

  it('acks an envelope it cannot read without handing it up', async () => {
    const r = rig();
    await flush();
    r.last().frame({ envelope_id: 'e-unknown-1', type: 'some_future_type', payload: {} });
    r.last().frame({ ...env.eventsApi(env.dmMessage()), envelope_id: 'e-broken-2', payload: 7 });
    r.last().raw('not json');
    assert.deepEqual(r.last().acks(), [
      { envelope_id: 'e-unknown-1' },
      { envelope_id: 'e-broken-2' }
    ]);
    assert.equal(r.seen.length, 0);
    r.mode.close();
  });

  it('warns on connected when another client holds the app', async () => {
    const r = rig();
    await flush();
    r.last().frame({ ...env.hello(), num_connections: 2 });
    const [state] = r.states;
    assert.equal(state?.kind, 'connected');
    assert.ok(state?.kind === 'connected' && state.warning, 'a warning names the other client');
    r.mode.close();
  });

  it('refreshes onto a second socket with no gap in connected', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('refresh_requested'));
    await flush();
    assert.equal(r.sockets.length, 2, 'the next socket opens before the old one closes');
    assert.equal(first.closedWith, undefined);

    const second = r.last();
    second.frame({ ...env.hello(), num_connections: 2 });
    assert.equal(first.closedWith, 1000, 'the old socket is closed once the new one is up');
    first.drop();
    assert.deepEqual(r.states, [{ kind: 'connected' }], 'no reconnecting, and no warning');
    r.mode.close();
  });

  it('carries on when the old socket closes before the new one says hello', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('warning'));
    first.drop();
    await flush();
    r.last().frame(env.hello());
    assert.deepEqual(kinds(r.states), ['connected']);
    r.mode.close();
  });

  it('opens one next socket for a warning and the refresh that follows it', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('warning'));
    await flush();
    first.frame(env.disconnect('refresh_requested'));
    await flush();
    assert.equal(r.sockets.length, 2);
    r.mode.close();
  });

  it('retries a refresh whose connect failed, staying connected meanwhile', async () => {
    let opens = 0;
    const r = rig((method) =>
      method === 'auth.test'
        ? { json: fx.authTest() }
        : ++opens === 2
          ? { throws: true }
          : { json: fx.connectionsOpen() }
    );
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('refresh_requested'));
    await flush();
    assert.equal(r.sockets.length, 1, 'the refresh connect failed');
    mock.timers.tick(1_200);
    await flush();
    assert.equal(r.sockets.length, 2, 'retried on the backoff');
    r.last().frame(env.hello());
    assert.deepEqual(kinds(r.states), ['connected']);
    r.mode.close();
  });

  it('retries a refresh whose socket never says hello', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('refresh_requested'));
    await flush();
    const second = r.last();
    mock.timers.tick(socket.HELLO_MS);
    assert.equal(second.terminated, true);
    mock.timers.tick(1_200);
    await flush();
    assert.equal(r.sockets.length, 3);
    assert.deepEqual(kinds(r.states), ['connected']);
    r.mode.close();
  });

  it('fails without retrying when Socket Mode is switched off', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('link_disabled'));
    assert.deepEqual(kinds(r.states), ['connected', 'failed']);
    const failed = r.states[1];
    assert.ok(failed?.kind === 'failed' && failed.retry === false);
    assert.equal(first.closedWith, 1000);

    mock.timers.tick(120_000);
    await flush();
    assert.equal(r.sockets.length, 1, 'nothing reconnects after failed');
    r.mode.close();
  });

  it('fails on a bad token, naming the method and code', async () => {
    const r = rig((method) =>
      method === 'auth.test' ? { json: fx.error('invalid_auth') } : { json: fx.connectionsOpen() }
    );
    await flush();
    assert.equal(r.states.length, 1);
    const [state] = r.states;
    assert.ok(state?.kind === 'failed' && state.retry === false);
    assert.match(state.reason, /auth\.test: invalid_auth/);
    mock.timers.tick(120_000);
    await flush();
    assert.deepEqual(r.methods, ['auth.test']);
    r.mode.close();
  });

  it('fails, rather than retrying, when the app token lacks its scope', async () => {
    for (const [method, code] of [
      ['apps.connections.open', 'missing_scope'],
      ['auth.test', 'no_permission']
    ] as const) {
      const r = rig((asked) =>
        asked === method
          ? { json: fx.error(code) }
          : { json: asked === 'auth.test' ? fx.authTest() : fx.connectionsOpen() }
      );
      await flush();
      assert.deepEqual(kinds(r.states), ['failed'], code);
      const [state] = r.states;
      assert.ok(state?.kind === 'failed' && state.retry === false);
      assert.ok(state.reason.includes(`${method}: ${code}`), state.reason);
      const asked = r.methods.length;
      mock.timers.tick(120_000);
      await flush();
      assert.equal(r.methods.length, asked, `${code}: nothing retried`);
      r.mode.close();
    }
  });

  it('backs off 1, 2, 4, 8, 16, then 30 s, each within a fifth', async () => {
    let down = true;
    const r = rig((method) =>
      method === 'auth.test'
        ? { json: fx.authTest() }
        : down
          ? { throws: true }
          : { json: fx.connectionsOpen() }
    );
    await flush();
    const opens = () => r.methods.filter((m) => m === 'apps.connections.open').length;
    assert.equal(opens(), 1);
    assert.equal(r.states[0]?.kind, 'reconnecting');

    for (const [i, base] of [1, 2, 4, 8, 16, 30, 30].entries()) {
      mock.timers.tick(base * 800 - 1);
      await flush();
      assert.equal(opens(), i + 1, `no attempt before ${base * 0.8} s`);
      mock.timers.tick(base * 400 + 1);
      await flush();
      assert.equal(opens(), i + 2, `an attempt by ${base * 1.2} s`);
    }
    assert.deepEqual(
      r.methods.filter((m) => m === 'auth.test'),
      ['auth.test']
    );

    // A link that held resets the backoff: the next drop retries after about
    // a second.
    down = false;
    mock.timers.tick(36_000);
    await flush();
    r.last().frame(env.hello());
    mock.timers.tick(socket.STABLE_MS);
    down = true;
    r.last().drop();
    const before = opens();
    mock.timers.tick(1_200);
    await flush();
    assert.equal(opens(), before + 1);
    assert.equal(r.states.at(-1)?.kind, 'reconnecting');
    r.mode.close();
  });

  it('keeps backing off when each socket says hello and drops at once', async () => {
    const r = rig();
    await flush();
    const opens = () => r.methods.filter((m) => m === 'apps.connections.open').length;
    for (const base of [1, 2, 4]) {
      r.last().frame(env.hello());
      r.last().drop();
      const before = opens();
      mock.timers.tick(base * 800 - 1);
      await flush();
      assert.equal(opens(), before, `no attempt before ${base * 0.8} s`);
      mock.timers.tick(base * 400 + 1);
      await flush();
      assert.equal(opens(), before + 1, `an attempt by ${base * 1.2} s`);
    }
    r.mode.close();
  });

  it('pings a silent socket, and terminates it when no pong comes', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());

    mock.timers.tick(socket.QUIET_MS - 1);
    assert.equal(first.pings, 0);
    mock.timers.tick(1);
    assert.equal(first.pings, 1);
    first.pong();
    mock.timers.tick(socket.QUIET_MS - 1);
    assert.equal(first.terminated, false, 'a pong keeps it');
    assert.equal(first.pings, 1);

    mock.timers.tick(1);
    assert.equal(first.pings, 2);
    mock.timers.tick(socket.PONG_MS);
    assert.equal(first.terminated, true);
    assert.equal(r.states.at(-1)?.kind, 'reconnecting');

    mock.timers.tick(1_200);
    await flush();
    assert.equal(r.sockets.length, 2, 'the link reconnects');
    r.mode.close();
  });

  it('counts any frame as the server being there', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());
    mock.timers.tick(socket.QUIET_MS - 1);
    first.frame(env.eventsApi(env.dmMessage()));
    mock.timers.tick(socket.QUIET_MS - 1);
    assert.equal(first.pings, 0);
    r.mode.close();
  });

  it('gives up on a socket that never says hello, however alive it is', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    for (let waited = 0; waited < socket.HELLO_MS; waited += 1_000) {
      first.pong();
      mock.timers.tick(1_000);
    }
    assert.equal(first.terminated, true);
    assert.deepEqual(kinds(r.states), ['reconnecting']);

    mock.timers.tick(1_200);
    await flush();
    assert.equal(r.sockets.length, 2, 'the link reconnects');
    r.mode.close();
  });

  it('closes every socket with 1000 and goes quiet', async () => {
    const r = rig();
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('warning'));
    await flush();
    r.mode.close();
    assert.equal(first.closedWith, 1000);
    assert.equal(r.last().closedWith, 1000);
    const states = r.states.length;
    first.drop();
    mock.timers.tick(600_000);
    await flush();
    assert.equal(r.sockets.length, 2);
    assert.equal(r.states.length, states);
  });
});

describe('openSocketMode, on real timers', () => {
  /** Timers alive in this process, which a mocked clock cannot count. */
  function timeouts(): number {
    return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  }

  it('leaves no timer behind after close, from connected or from a backoff', async () => {
    const baseline = timeouts();
    const up = rig();
    await flush();
    up.last().frame(env.hello());
    assert.ok(timeouts() > baseline, 'the watchdog is armed');
    up.mode.close();
    assert.equal(timeouts(), baseline);

    const down = rig((method) =>
      method === 'auth.test' ? { json: fx.authTest() } : { throws: true }
    );
    await flush();
    assert.equal(down.states[0]?.kind, 'reconnecting');
    assert.ok(timeouts() > baseline, 'a retry is pending');
    down.mode.close();
    assert.equal(timeouts(), baseline);
  });

  it('ignores a pong or an event that arrives after close', async (t) => {
    const baseline = timeouts();
    const r = rig();
    t.after(() => r.mode.close());
    await flush();
    const late = r.last();
    late.frame(env.hello());
    r.mode.close();
    late.pong();
    late.frame(env.eventsApi(env.dmMessage()));
    assert.equal(timeouts(), baseline, 'no watchdog re-armed');
    assert.equal(r.seen.length, 0, 'nothing handed up');
    assert.deepEqual(late.acks(), []);
    r.mode.close();
    assert.equal(timeouts(), baseline);
  });

  it('hands up a retired socket’s late event without re-arming its watchdog', async (t) => {
    const baseline = timeouts();
    const r = rig();
    t.after(() => r.mode.close());
    await flush();
    const first = r.last();
    first.frame(env.hello());
    first.frame(env.disconnect('refresh_requested'));
    await flush();
    r.last().frame(env.hello());
    assert.equal(first.closedWith, 1000, 'the refresh let the first socket go');
    const armed = timeouts();
    first.pong();
    first.frame(env.eventsApi(env.dmMessage(), { envelopeId: 'late-1' }));
    assert.equal(timeouts(), armed, 'only the live socket has a watchdog');
    assert.equal(r.seen.length, 1, 'Slack sent it, so it is handed up and acked');
    assert.deepEqual(first.acks(), [{ envelope_id: 'late-1' }]);
    r.mode.close();
    assert.equal(timeouts(), baseline);
  });
});

describe('openSocket over a real ws', () => {
  it('carries an envelope, its ack and a server ping on 127.0.0.1', async () => {
    const server = new wsPkg.WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    const local = `ws://127.0.0.1:${address.port}`;

    const acked = new Promise<unknown>((resolve) => {
      server.on('connection', (peer) => {
        peer.on('message', (data) =>
          resolve(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '') as unknown)
        );
        peer.send(JSON.stringify(env.hello()));
        peer.send(JSON.stringify(env.eventsApi(env.dmMessage())));
      });
    });
    const ponged = new Promise<void>((resolve) => {
      server.on('connection', (peer) => {
        peer.on('pong', () => resolve());
        peer.ping();
      });
    });

    const states: LinkState[] = [];
    const seen: socket.SocketEnvelope[] = [];
    const fetch: api.Fetch = (url) =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: () =>
          Promise.resolve(url.endsWith('auth.test') ? fx.authTest() : fx.connectionsOpen())
      });
    const mode = socket.openSocketMode({
      fetch,
      api: api.slackApi(fetch, TOKEN),
      appToken: APP_TOKEN,
      // Slack's URL is wss://; this one dials the loopback server instead.
      openSocket: (_url, events) => ws.openSocket(local, events),
      onEnvelope: (envelope) => seen.push(envelope),
      onState: (state) => states.push(state)
    });
    try {
      assert.deepEqual(await acked, { envelope_id: env.eventsApi({}).envelope_id });
      await ponged;
      assert.deepEqual(kinds(states), ['connected']);
      assert.equal(seen[0]?.type, 'events_api');
    } finally {
      mode.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
