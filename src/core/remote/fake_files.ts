/**
 * The test messenger, driven through the disk, so a process outside the host —
 * a smoke run, a hand-check — can play the person's side of every PRD scenario
 * in a real window with no network.
 *
 * In: one event per `inbox/*.json`, in our own shapes, each handed to the
 * fake's driver once and removed, read every `INBOX_POLL_MS` once the switch
 * starts the driver. Write a file whole (temp name, then rename): a file that
 * does not parse is set aside in `inbox/rejected/`, never retried.
 *
 * Out: every post, settle, file and reaction the fake records, one JSON line each, in
 * `outbox.jsonl` as it happens. `.jsonl`, which no watcher matches, so the
 * outbox nudges no pass.
 *
 * Checks: every setup check the fake answers, one line each in
 * `checks.jsonl`, with Remote on or off, so a run can count the checks a press
 * made.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fakeEntry, fakeEntryWith, type FakeMessenger } from '../bridge/fake';
import type { LinkState, MessengerEntry, SetupCheck, SetupRow } from '../bridge/port';
import { FAKE_DIR } from '../paths';
import * as check from './check';

export { FAKE_DIR };
export const INBOX_DIR = path.join(FAKE_DIR, 'inbox');
export const REJECTED_DIR = path.join(INBOX_DIR, 'rejected');
export const OUTBOX_FILE = path.join(FAKE_DIR, 'outbox.jsonl');
export const CHECKS_FILE = path.join(FAKE_DIR, 'checks.jsonl');

/** One inbox file: exactly one of these. */
type InboxEvent =
  | {
      say: {
        sender: string;
        text: string;
        in?: string;
        replyTo?: string;
        addressed?: 'direct' | 'mention';
      };
    }
  | { press: { sender: string; payload: string; on?: string } }
  | { command: { sender: string; name: string; args?: string } }
  | { link: LinkState };

/**
 * How often a started driver reads the inbox. A clock of its own, not
 * `host/watch.ts`'s announcement, although the inbox is under `STATE_DIR`:
 * stock VS Code 1.141's watcher (parcel over FSEvents) was measured
 * 2026-10-14 delivering its first event 6.7–14.4 s after it was created, and
 * under load delivering in batches 15.00 s apart — longer than a smoke step
 * waits for one file. Test-only, so a readdir of an empty directory five
 * times a second costs a production window nothing.
 */
export const INBOX_POLL_MS = 200;

export type FakeDriver = {
  /** Hands every inbox file to the fake, oldest first. Drains run one at a
   *  time, so a file is never handed over twice. */
  drain(): Promise<void>;
  /** Drains now and every `INBOX_POLL_MS` until `dispose`. Called once the
   *  fake's connection is open, since an event handed before that is lost. */
  start(): void;
  /** Resolves once every outbox line recorded so far is written. */
  flush(): Promise<void>;
  /** Stops appending and draining. */
  dispose(): void;
};

/** Made when Remote turns on with the fake selected: the inbox exists from
 *  then, and nothing writes under `FAKE_DIR` before. */
export async function driveFake(fake: FakeMessenger): Promise<FakeDriver> {
  await fs.mkdir(REJECTED_DIR, { recursive: true });
  let disposed = false;
  let draining: Promise<void> = Promise.resolve();
  let appending: Promise<void> = Promise.resolve();

  const unsubscribe = fake.onRecord((record) => {
    const line = `${JSON.stringify(record)}\n`;
    appending = appending.then(() => fs.appendFile(OUTBOX_FILE, line).catch(() => undefined));
  });

  const drain = (): Promise<void> => {
    draining = draining.then(() => (disposed ? undefined : drainOnce(fake, () => disposed)));
    return draining;
  };
  let poll: NodeJS.Timeout | undefined;
  // A tick that finds the last drain still running skips rather than queues.
  let reading = false;
  const tick = () => {
    if (reading) return;
    reading = true;
    const done = () => {
      reading = false;
    };
    void drain().then(done, done);
  };

  return {
    drain,
    start() {
      if (disposed || poll) return;
      poll = setInterval(tick, INBOX_POLL_MS);
      poll.unref();
      tick();
    },
    flush: () => appending,
    dispose() {
      disposed = true;
      clearInterval(poll);
      unsubscribe();
    }
  };
}

/**
 * The fake's entry as the host's check runner asks it: its check answers the
 * verdict `raw` names — `squadron.remote.fakeCheck`, a `SetupCheck` written
 * out — or the fake's own ok when that names none it can read, and appends
 * each answer to `CHECKS_FILE` with when it was given, redacted against the
 * credentials. Those are read by nobody and written nowhere.
 */
export function checkedFake(raw: unknown, clock: () => number = Date.now): MessengerEntry {
  const verdict = setupCheck(raw);
  const entry = verdict === undefined ? fakeEntry : fakeEntryWith(verdict);
  return {
    ...entry,
    check: async (credentials, signal) => {
      const found = await entry.check(credentials, signal);
      // Redacted before it is written: a verdict the setting names can carry
      // any text, a pasted token included.
      const result = check.redacted(found, Object.values(credentials));
      const line = `${JSON.stringify({ at: clock(), result })}\n`;
      await fs
        .mkdir(FAKE_DIR, { recursive: true })
        .then(() => fs.appendFile(CHECKS_FILE, line))
        .catch(() => undefined);
      return result;
    }
  };
}

async function drainOnce(fake: FakeMessenger, stopped: () => boolean): Promise<void> {
  for (const name of await oldestFirst()) {
    if (stopped()) return;
    const file = path.join(INBOX_DIR, name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue; // gone already
    }
    const event = narrow(parse(text));
    if (!event) {
      await fs.rename(file, path.join(REJECTED_DIR, name)).catch(() => undefined);
      continue;
    }
    // Removed before it is handed over: one lost to a crash beats one handed
    // over twice.
    try {
      await fs.rm(file);
    } catch {
      continue;
    }
    try {
      hand(fake, event);
    } catch {
      // A link file with no open connection; the fake says so by throwing,
      // and there is nothing to retry it against.
    }
  }
}

async function oldestFirst(): Promise<string[]> {
  let names: string[];
  try {
    names = (await fs.readdir(INBOX_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const dated = await Promise.all(
    names.map(async (name) => {
      const at = await fs
        .stat(path.join(INBOX_DIR, name))
        .then((stat) => stat.mtimeMs)
        .catch(() => Infinity);
      return { name, at };
    })
  );
  return dated.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)).map(({ name }) => name);
}

function hand(fake: FakeMessenger, event: InboxEvent): void {
  if ('say' in event) {
    const { sender, text, ...where } = event.say;
    fake.say(sender, text, where);
  } else if ('press' in event) {
    fake.press(event.press.sender, event.press.payload, event.press.on);
  } else if ('command' in event) {
    fake.command(event.command.sender, event.command.name, event.command.args);
  } else {
    fake.link(event.link);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The file as one of the four events, field by field, or nothing. */
function narrow(raw: unknown): InboxEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return undefined;
  const body = raw[keys[0] ?? ''];
  if (!isRecord(body)) return undefined;
  switch (keys[0]) {
    case 'say': {
      const { sender, text, in: anchor, replyTo, addressed } = body;
      if (!isString(sender) || !isString(text)) return undefined;
      if (!optional(anchor) || !optional(replyTo)) return undefined;
      if (addressed !== undefined && addressed !== 'direct' && addressed !== 'mention') {
        return undefined;
      }
      return {
        say: {
          sender,
          text,
          ...(anchor === undefined ? {} : { in: anchor }),
          ...(replyTo === undefined ? {} : { replyTo }),
          ...(addressed === undefined ? {} : { addressed })
        }
      };
    }
    case 'press': {
      const { sender, payload, on } = body;
      if (!isString(sender) || !isString(payload) || !optional(on)) return undefined;
      return { press: { sender, payload, ...(on === undefined ? {} : { on }) } };
    }
    case 'command': {
      const { sender, name, args } = body;
      if (!isString(sender) || !isString(name) || !optional(args)) return undefined;
      return { command: { sender, name, ...(args === undefined ? {} : { args }) } };
    }
    case 'link': {
      const link = linkState(body);
      return link && { link };
    }
    default:
      return undefined;
  }
}

/** A `SetupCheck` field by field, or nothing. */
function setupCheck(raw: unknown): SetupCheck | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'ok': {
      const facts = raw.facts ?? [];
      if (!Array.isArray(facts)) return undefined;
      const rows = facts.map((fact): SetupRow | undefined =>
        isRecord(fact) && isString(fact.label) && isString(fact.value)
          ? { label: fact.label, value: fact.value }
          : undefined
      );
      if (!rows.every((row) => row !== undefined)) return undefined;
      return isString(raw.space)
        ? { kind: 'ok', facts: rows, space: raw.space }
        : { kind: 'ok', facts: rows };
    }
    case 'setup':
      return Number.isInteger(raw.step) && (raw.step as number) >= 0 && isString(raw.reason)
        ? { kind: 'setup', step: raw.step as number, reason: raw.reason }
        : undefined;
    case 'unreachable':
      return isString(raw.reason) ? { kind: 'unreachable', reason: raw.reason } : undefined;
    default:
      return undefined;
  }
}

function linkState(raw: Record<string, unknown>): LinkState | undefined {
  switch (raw.kind) {
    case 'connecting':
      return { kind: 'connecting' };
    case 'connected':
      if (!optional(raw.warning)) return undefined;
      return raw.warning === undefined
        ? { kind: 'connected' }
        : { kind: 'connected', warning: raw.warning };
    case 'reconnecting':
      return isString(raw.reason) ? { kind: 'reconnecting', reason: raw.reason } : undefined;
    case 'failed':
      return isString(raw.reason) && typeof raw.retry === 'boolean'
        ? { kind: 'failed', reason: raw.reason, retry: raw.retry }
        : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function optional(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
