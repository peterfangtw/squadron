/**
 * The Socket Mode connection: connect, ack, refresh, reconnect, and the
 * watchdog that finds a socket gone half-open.
 *
 * It drives a `SocketLike`, so tests run it against a fake; `ws.ts` is the
 * real one. Its timers — the backoff, the watchdog — are the transport's own
 * clock, as TCP keepalive is the kernel's, so they live here rather than on
 * the window's Reconciler. All of them exist only between `openSocketMode` and
 * `close()`.
 */

import type { LinkState } from '../bridge/port';
import * as api from './api';
import * as wire from './wire';

/** What a socket tells its driver. `close` fires once, whoever closed it. */
export type SocketEvents = {
  /** A text frame. */
  message(text: string): void;
  /** A protocol ping from the server, or the pong to ours. */
  alive(): void;
  close(): void;
};

/** The slice of a WebSocket this drives. `send` and `ping` on a socket that
 *  is not open do nothing. */
export interface SocketLike {
  send(text: string): void;
  ping(): void;
  close(code: number): void;
  terminate(): void;
}

export type OpenSocket = (url: string, events: SocketEvents) => SocketLike;

/** The envelopes that carry something for the bot. `hello` and `disconnect`
 *  are the connection's own business. */
export type SocketEnvelope = wire.EventsApi | wire.Interactive | wire.SlashCommand;

export type SocketModeOptions = {
  fetch: api.Fetch;
  /** The bot's Web API, for `auth.test`. */
  api: Pick<api.SlackApi, 'authTest'>;
  /** The app-level token, for `apps.connections.open` only. */
  appToken: string;
  openSocket: OpenSocket;
  /** Called before the envelope is acked. A throw is swallowed; the ack goes
   *  out regardless. `self` is the bot as `auth.test` named it. */
  onEnvelope(envelope: SocketEnvelope, self: wire.Identity): void;
  /** Every move of the link. It starts at `connecting`, which is not
   *  reported. */
  onState(state: LinkState): void;
};

export interface SocketMode {
  close(): void;
}

// Provisional until M1 Step 3 measures how often Slack pings: a socket that
// has said nothing for QUIET_MS is pinged, and one that then stays silent
// for PONG_MS is terminated.
/** A duration: silence before the watchdog pings. */
export const QUIET_MS = 30_000;
/** A duration: how long a ping waits for any frame back. */
export const PONG_MS = 5_000;

/** A duration: how long an open socket may go without `hello` before it is
 *  given up. Pongs alone do not keep it, since only `hello` carries events. */
export const HELLO_MS = 10_000;

/** A duration: how long a link must hold after `hello` before the backoff
 *  starts again from its first wait. */
export const STABLE_MS = 30_000;

/** The waits between failed connects, in order; the last repeats. Each is
 *  jittered by up to a fifth either way, so many clients do not retry in
 *  step. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const JITTER = 0.2;

const WORDS = {
  unreachable: 'Could not reach Slack',
  closed: 'The connection to Slack closed',
  silent: 'Slack stopped answering',
  unfinished: 'Slack did not finish opening the connection',
  disabled: 'Socket Mode is switched off for this Slack app',
  refused: 'Slack refused the connection',
  otherClient:
    'Another program is connected to this Slack app with the same tokens, so Slack sends it some of the events'
};

type Timer = ReturnType<typeof setTimeout>;

/** One socket and its watchdog. `hello` is pending until Slack greets it;
 *  `draining` once Slack has said it will close it. */
type Live = {
  socket: SocketLike;
  quiet?: Timer;
  pong?: Timer;
  hello?: Timer;
  draining?: true;
};

/**
 * Connects and stays connected until `close()` or a failure only a person can
 * fix. A refresh opens the next socket before the old one closes, so an event
 * may arrive on either; the core's deduper absorbs the repeat.
 */
export function openSocketMode(options: SocketModeOptions): SocketMode {
  const sockets = new Set<Live>();
  let state: LinkState = { kind: 'connecting' };
  let self: wire.Identity | undefined;
  let stopped = false;
  /** A connect is between its first call and its socket. */
  let opening = false;
  let retry: Timer | undefined;
  /** Zeroes `failures` once a link has held for `STABLE_MS`. */
  let stable: Timer | undefined;
  /** Failed connects since a link last held for `STABLE_MS`, which picks the
   *  next wait. */
  let failures = 0;
  /** Aborted by `stop()`, so a connect's rate-limit wait ends with it. */
  const lifetime = new AbortController();

  void connect();
  return { close: () => stop() };

  async function connect(): Promise<void> {
    opening = true;
    let url: string;
    try {
      self ??= await options.api.authTest(lifetime.signal);
      url = await api.openConnection(options.fetch, options.appToken, lifetime.signal);
    } catch (error) {
      opening = false;
      refused(error);
      return;
    }
    opening = false;
    if (stopped) {
      return;
    }
    try {
      track(url, self);
    } catch {
      // `ws` throws on a URL it cannot dial; the URL itself is never said.
      lost(WORDS.unreachable);
    }
  }

  function track(url: string, bot: wire.Identity): void {
    const live: Live = {
      // A socket let go can still deliver what was in flight: an event Slack
      // sent is handed up and acked, but only a tracked socket has a watchdog
      // or a say in the link, and after `close()` nothing is heard at all.
      socket: options.openSocket(url, {
        message: (text) => {
          if (stopped) {
            return;
          }
          const tracked = sockets.has(live);
          if (tracked) {
            heard(live);
          }
          frame(live, text, bot, tracked);
        },
        alive: () => {
          if (!stopped && sockets.has(live)) {
            heard(live);
          }
        },
        close: () => {
          if (retire(live)) {
            lost(WORDS.closed);
          }
        }
      })
    };
    sockets.add(live);
    heard(live);
    live.hello = setTimeout(() => {
      if (retire(live)) {
        live.socket.terminate();
        lost(WORDS.unfinished);
      }
    }, HELLO_MS);
  }

  /** One frame: hand it up, then ack it on the socket it came on. */
  function frame(live: Live, text: string, bot: wire.Identity, tracked: boolean): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const { envelopeId, envelope } = wire.narrowEnvelope(raw);
    try {
      if (envelope?.type === 'hello' || envelope?.type === 'disconnect') {
        if (tracked) {
          lifecycle(live, envelope);
        }
      } else if (envelope) {
        options.onEnvelope(envelope, bot);
      }
    } catch {
      // The sink's failure is the core's to log; the delivery is still ours
      // to ack, or Slack redelivers it.
    } finally {
      if (envelopeId !== undefined) {
        live.socket.send(JSON.stringify({ envelope_id: envelopeId }));
      }
    }
  }

  function lifecycle(live: Live, envelope: wire.Hello | wire.Disconnect): void {
    if (envelope.type === 'hello') {
      connected(live, envelope);
    } else {
      disconnecting(live, envelope);
    }
  }

  /** The first frame on a socket. The sockets before it are let go. */
  function connected(live: Live, hello: wire.Hello): void {
    clearTimeout(live.hello);
    live.hello = undefined;
    // Counted before the old sockets close: Slack's count includes them.
    const own = sockets.size;
    for (const other of [...sockets]) {
      if (other !== live) {
        shut(other);
      }
    }
    clearTimeout(stable);
    stable = setTimeout(() => {
      failures = 0;
    }, STABLE_MS);
    const warning = (hello.numConnections ?? 0) > own ? WORDS.otherClient : undefined;
    move({ kind: 'connected', ...(warning !== undefined && { warning }) });
  }

  /** `warning` and `refresh_requested` precede a routine refresh;
   *  `link_disabled` means Socket Mode was switched off. */
  function disconnecting(live: Live, disconnect: wire.Disconnect): void {
    if (disconnect.reason === 'link_disabled') {
      fail(WORDS.disabled);
      return;
    }
    live.draining = true;
    // A `warning` is followed by `refresh_requested`: one next socket for both.
    const pending = [...sockets].some((other) => other.hello !== undefined);
    if (!opening && retry === undefined && !pending) {
      void connect();
    }
  }

  /** A connect that failed before it had a socket. */
  function refused(error: unknown): void {
    if (stopped) {
      return;
    }
    if (error instanceof api.SlackError && api.fatal(error.code)) {
      fail(`${WORDS.refused} (${error.message})`);
      return;
    }
    lost(
      error instanceof api.SlackError
        ? `${WORDS.unreachable} (${error.message})`
        : WORDS.unreachable
    );
  }

  /** Something went; reconnect unless another socket or connect carries on.
   *  A draining socket does not, but keeps the link connected until it goes. */
  function lost(reason: string): void {
    if (stopped || opening) {
      return;
    }
    if (sockets.size === 0) {
      clearTimeout(stable);
      move({ kind: 'reconnecting', reason });
    }
    if (retry !== undefined || [...sockets].some((live) => !live.draining)) {
      return;
    }
    const base = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 30_000;
    failures++;
    const wait = base * (1 - JITTER + 2 * JITTER * Math.random());
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, wait);
  }

  function fail(reason: string): void {
    stop();
    state = { kind: 'failed', reason, retry: false };
    options.onState(state);
  }

  function stop(): void {
    stopped = true;
    lifetime.abort();
    clearTimeout(retry);
    clearTimeout(stable);
    retry = undefined;
    for (const live of [...sockets]) {
      shut(live);
    }
  }

  /** Any frame resets the watchdog. Silence earns a ping, and a ping with
   *  nothing back ends the socket. */
  function heard(live: Live): void {
    clearTimeout(live.quiet);
    clearTimeout(live.pong);
    live.pong = undefined;
    live.quiet = setTimeout(() => {
      live.socket.ping();
      live.pong = setTimeout(() => {
        if (retire(live)) {
          live.socket.terminate();
          lost(WORDS.silent);
        }
      }, PONG_MS);
    }, QUIET_MS);
  }

  /** Our own close: its close event, when it comes, is not a loss. */
  function shut(live: Live): void {
    retire(live);
    live.socket.close(1000);
  }

  /** Stops tracking a socket. False when it was already let go. */
  function retire(live: Live): boolean {
    clearTimeout(live.quiet);
    clearTimeout(live.pong);
    clearTimeout(live.hello);
    return sockets.delete(live);
  }

  function move(next: LinkState): void {
    if (stopped || JSON.stringify(next) === JSON.stringify(state)) {
      return;
    }
    state = next;
    options.onState(next);
  }
}
