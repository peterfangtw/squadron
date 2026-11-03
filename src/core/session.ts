/**
 * The byte spawn any brand rides.
 *
 * `childTransport` knows no CLI's spellings — the identity variables it scrubs
 * are a category it enumerates from `core/identity.ts`, never names. Claude's
 * handle is `core/claude/session.ts`; Grok's is `core/grok/session.ts`.
 *
 * `vscode`-free. Tests drive a fake CLI over the transport.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Launch } from './adapter';
import * as platform from './platform';
import type { Program } from './platform/executables';

import { type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';

import type { ExitSource } from './events';
import { EXECUTION_CONTEXT_ENV, IDENTITY_NAMES } from './identity';

/** Why the child is gone, as far as anything out here can tell. */
export type ExitInfo = {
  code: number | null;
  signal: string | null;
  /** Which of the three endings below fired. Two of them are not a death, so
   *  this is what tells a latched exit from a confirmed one — `core/events.ts`
   *  states the rest. */
  source: ExitSource;
  /** The tail of its stderr, which is where a CLI that refused to start says
   *  why. Nothing else on the pipe would carry a reason. */
  stderr?: string;
};

/**
 * The pipe, whatever is on the other end of it.
 *
 * Deliberately narrow: a JSON value in, JSON values out, an exit, and a way to
 * end it. Anything wider — a pid, a process handle — would be a detail of
 * *this* implementation leaking into the one thing this seam exists to allow
 * replacing.
 *
 * **Untyped on purpose.** It used to be `write(Outbound)` / `onFrame(Frame)`,
 * which are `core/frames.ts`'s shapes and so one CLI's. A second brand speaks
 * JSON-RPC on the same kind of child, and a transport that can only carry
 * Claude frames means a second copy of the spawn, the line splitting and the
 * exit handling. What is shared is a line of JSON; what it *means* belongs to
 * whoever wrote it, which is the brand's own handle.
 */
export interface SessionTransport {
  /**
   * The pid of the thing on the other end, where there is a local one. It is
   * the card's identity on the board and what `ps` is asked about, so a
   * transport with no process of its own — a socket, a remote peer — has none,
   * and a caller that cannot get one has nothing to key a card by.
   */
  readonly pid?: number;
  /** Native child and writable stdin, invalidated synchronously on close/exit. */
  processAlive?(): boolean;
  readonly exited?: Promise<boolean>;
  write(value: unknown): void;
  onLine(listener: (value: unknown) => void): void;
  onExit(listener: (info: ExitInfo) => void): void;
  /**
   * Every line the other end wrote has been delivered: its output closed. Not
   * the exit — Claude delivered a buffered delta after SIGKILL, before stdout
   * closed (2.1.292, `cli_state/claude/protocol.md`). A transport without it
   * is taken to end at its exit.
   */
  onEnd?(listener: () => void): void;
  close(): void;
}

/** How much of a failed start's stderr is worth keeping for the card. */
const STDERR_TAIL = 2000;

/**
 * A CLI child speaking line-delimited JSON on stdio, whichever CLI it is.
 *
 * It knows how to spawn, how to split lines, how to parse one, and when the
 * child is gone. It knows no brand's *spellings*: the whole launch line arrives
 * in `args` and `env`, from whoever asked for the child. A helper that reached
 * for `PROTOCOL_ARGS` here would start every future brand as
 * `grok --print --output-format stream-json … agent stdio`.
 */
export function childTransport(options: {
  /** What the brand's `resolveBinary` found, or a test's named fake CLI. */
  bin: Program;
  cwd: string;
  /** The whole launch line after the binary. Nothing is added to it. */
  args?: readonly string[];
  /** Overlay on this process's own environment: a string sets, `undefined`
   *  deletes. Deleting is not the same as leaving a key out — the child
   *  inherits ours, so a variable this host was launched with is passed on
   *  unless something says otherwise. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Signal the child after ending stdin. Used only where EOF shutdown has not
   *  been established by that adapter's protocol probe. */
  terminateOnClose?: boolean;
  /** The fan-out this session belongs to, for its own spawns to inherit. */
  origin?: string;
  /** The window starting this child, for `squadron-spawn` inside it to name
   *  when it asks who should serve its own `open`. */
  windowId?: string;
}): SessionTransport {
  const env = { ...process.env };
  // **Nobody inherits an identity.** Each CLI plants its own session id into the
  // environment it gives a shell tool — that is where `cli/args.ts`'s
  // `ownSessionId` reads it — so the copy above can only ever carry an
  // *ancestor's*, never this child's. Left in place it decides who a verb thinks
  // is calling: measured 2026-09-02, no ordering of those rungs is safe, because
  // a host booted from a Codex shell makes every Claude session it starts answer
  // to the Codex thread and the reverse holds too. What that misattributes is
  // `cli/spawn.ts`'s `parentSessionId` and the `--caller-session-id` default every verb
  // takes into `core/coordination/guards.ts` — one session spending another's rate and pair
  // budget. Same class as the `SQUADRON_LINEAGE_ORIGIN` scrub below, and for
  // the same reason: absence here is inheritance.
  //
  // Before `options.env`, so an adapter can still plant one deliberately. This
  // does not reach a CLI someone types in another session's terminal; only a
  // brand's marker would, and not every brand publishes one.
  //
  // Enumerated from `core/identity.ts` rather than spelled here, so this seam
  // knows the category and not a brand's spelling of it.
  for (const name of IDENTITY_NAMES) delete env[name];
  delete env[EXECUTION_CONTEXT_ENV];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  // The fan-out, planted so the shim inside this session reads it and every
  // spawn below names the same origin. Deleted when there is none, which is not
  // the same as leaving it off: the env above is `{...process.env}`, so absence
  // here is *inheritance*. An extension host booted from inside a session's own
  // shell — which `squadron-dev-host` and `npm run test:smoke` both do —
  // carries the var, and every rootless session it started would silently join
  // that ancestor's fan-out. Same class as the `ELECTRON_RUN_AS_NODE` and
  // `CLAUDE_CODE_CHILD_SESSION` leaks already on record.
  if (options.origin !== undefined) {
    env.SQUADRON_LINEAGE_ORIGIN = options.origin;
  } else {
    delete env.SQUADRON_LINEAGE_ORIGIN;
  }
  // **The window that started this child, planted for every brand** (row 71).
  // `pickWindow` ranks the caller's own window first, so a fan-out lands on the
  // board that asked for it — and it can only do that if a session can say
  // which window it belongs to. `cli/spawn.ts` could already work it out for
  // *Claude* callers, by reading the CLI's own pid export and looking the pid
  // up in the published records; Grok and Codex plant no pid at all (probed
  // 2026-09-08), so a Grok orchestrator's fan-out would have scattered by cwd
  // while a Claude one stayed put. Planting it here is brand-free: this is the
  // one place every brand's child is spawned.
  //
  // Deleted when absent, for `SQUADRON_LINEAGE_ORIGIN`'s reason directly
  // above — the env is a copy of this process's, so absence here is
  // inheritance, and an extension host booted from inside a session's shell
  // carries whatever that session carried.
  if (options.windowId !== undefined) {
    env.SQUADRON_ORIGIN_WINDOW = options.windowId;
  } else {
    delete env.SQUADRON_ORIGIN_WINDOW;
  }

  const spawned = platform.executables.spawn(options.bin, options.args ?? [], {
    cwd: options.cwd,
    env
  });
  // A thrown refusal gets the same ending as the `'error'` event below, so no
  // caller needs a second path.
  if (spawned.status === 'failed') return unstarted(spawned.reason);
  const child: ChildProcessWithoutNullStreams = spawned.value;

  let resolveExit: (native: boolean) => void = () => {};
  const exited = new Promise<boolean>((resolve) => {
    resolveExit = resolve;
  });
  const lines: ((value: unknown) => void)[] = [];
  const exits: ((info: ExitInfo) => void)[] = [];
  let stderr = '';
  let ended = false;
  let closing = false;

  // One JSON value per line, and the line splitting is node's: it holds a
  // partial line across chunks, decodes a multi-byte character that lands on a
  // read boundary, and puts no cap on how long a line may grow — an image block
  // is legitimately megabytes. A line that will not parse is skipped with the
  // line, the same rule as every other parse of another program's output here.
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    for (const listener of lines) {
      listener(value);
    }
  });
  const ends: (() => void)[] = [];
  reader.on('close', () => ends.forEach((listener) => listener()));
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });

  const end = (info: ExitInfo) => {
    if (ended) {
      return;
    }
    ended = true;
    for (const listener of exits) {
      listener({ ...info, stderr: stderr.trim() || undefined });
    }
  };
  child.on('exit', (code, signal) => {
    resolveExit(true);
    end({ code, signal, source: 'exit' });
  });
  // A binary that is not there, or is not executable. No frame will ever
  // arrive, so this is the only thing the card will ever have to show.
  child.on('error', (error) => {
    resolveExit(child.pid === undefined);
    stderr = `${stderr}${error.message}`.slice(-STDERR_TAIL);
    end({ code: null, signal: null, source: 'spawn' });
  });
  // Writing to a pipe whose reader has gone is an unhandled error event, not a
  // return value. The exit that caused it is already on its way.
  child.stdin.on('error', () => end({ code: null, signal: null, source: 'stdin' }));

  return {
    pid: child.pid,
    exited,
    processAlive: () =>
      !ended &&
      !child.killed &&
      !child.stdin.destroyed &&
      !child.stdin.writableEnded &&
      !child.stdout.destroyed &&
      !child.stdout.readableEnded,
    write(value) {
      child.stdin.write(JSON.stringify(value) + '\n');
    },
    onLine(listener) {
      lines.push(listener);
    },
    onExit(listener) {
      exits.push(listener);
    },
    onEnd(listener) {
      ends.push(listener);
    },
    close() {
      if (closing) return;
      closing = true;
      // Ending stdin is what ends the session: the CLI requires a readable
      // stdin for the lifetime of a stream-json run, so closing the pipe is the
      // documented way out — and the one that also fires when this process dies
      // without getting to run any cleanup of its own.
      child.stdin.end();
      if (options.terminateOnClose && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }
  };
}

/** A child `spawn` refused outright: no pid, and one `'spawn'` exit carrying
 *  the reason, delivered after the caller has had its turn to listen. */
function unstarted(reason: string): SessionTransport {
  const info: ExitInfo = { code: null, signal: null, source: 'spawn', stderr: reason };
  return {
    pid: undefined,
    exited: Promise.resolve(true),
    processAlive: () => false,
    write() {},
    onLine() {},
    onExit(listener) {
      queueMicrotask(() => listener(info));
    },
    onEnd(listener) {
      queueMicrotask(listener);
    },
    close() {}
  };
}

export async function writeLaunchFiles(
  files: Launch['files']
): Promise<{ path: string; reason: string }[]> {
  const failures: { path: string; reason: string }[] = [];
  for (const file of files ?? []) {
    try {
      if ((await fs.readFile(file.path, 'utf8').catch(() => undefined)) === file.content) continue;
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await fs.writeFile(file.path, file.content, 'utf8');
    } catch (error) {
      failures.push({
        path: file.path,
        reason: error instanceof Error ? error.message : 'write failed'
      });
    }
  }
  return failures;
}

/** A required pre-prompt failure is definite only after the native child exits. */
export async function closeUnprompted(transport: SessionTransport): Promise<boolean> {
  transport.close();
  if (!transport.exited) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      transport.exited,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
