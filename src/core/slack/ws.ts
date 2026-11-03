/**
 * The one file that imports `ws`. Everything else drives a `SocketLike`, so a
 * test runs `socket.ts` against a fake and only this file needs the network.
 *
 * `ws` over the global `WebSocket`: VS Code 1.95–1.100 run Node 20, which has
 * no global, and the WHATWG interface can neither send nor see a protocol
 * ping, which is how a half-open socket is found (M1 Notes, "WebSocket on
 * every host `engines` admits"). Its optional native add-ons are aliased to
 * `no_native.ts` at bundle time.
 */

import * as ws from 'ws';
import type { SocketEvents, SocketLike } from './socket';

/** A handshake that has not finished by then is abandoned, and its close
 *  starts the backoff. */
const HANDSHAKE_MS = 10_000;

export function openSocket(url: string, events: SocketEvents): SocketLike {
  const socket = new ws.WebSocket(url, { handshakeTimeout: HANDSHAKE_MS });
  // The default `binaryType`, `nodebuffer`, hands a text frame over as one
  // Buffer.
  socket.on('message', (data, isBinary) => {
    if (!isBinary && Buffer.isBuffer(data)) {
      events.message(data.toString('utf8'));
    }
  });
  // `ws` answers a ping with a pong by itself; both only say the peer is there.
  socket.on('ping', () => events.alive());
  socket.on('pong', () => events.alive());
  // `close` always follows `error`, and an `error` with no listener throws.
  socket.on('error', () => undefined);
  socket.once('close', () => events.close());

  const open = () => socket.readyState === ws.WebSocket.OPEN;
  return {
    send(text) {
      if (open()) {
        socket.send(text);
      }
    },
    ping() {
      if (open()) {
        socket.ping();
      }
    },
    close(code) {
      socket.close(code);
    },
    terminate() {
      socket.terminate();
    }
  };
}
