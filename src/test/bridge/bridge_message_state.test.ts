import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import type { ConversationRecord, MessageRecord } from '../../core/bridge/store';
import type { Holder } from '../../core/remote/holder';
import { resetDir, tempHome, writeJson } from '../helpers';

let MessageState: typeof import('../../core/bridge/message_state').MessageState;
let fake: typeof import('../../core/bridge/fake');
let paths: typeof import('../../core/paths');
let store: typeof import('../../core/bridge/store');

const T0 = 1_700_000_000_000;

before(async () => {
  await tempHome();
  MessageState = (await import('../../core/bridge/message_state')).MessageState;
  fake = await import('../../core/bridge/fake');
  paths = await import('../../core/paths');
  store = await import('../../core/bridge/store');
});

beforeEach(async () => {
  await resetDir(paths.CONVERSATIONS_DIR);
  await fs.rm(paths.HOLDER_FILE, { force: true });
});

function message(id: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    correlation: id,
    ref: 'thread',
    at: T0,
    desired: 'done',
    applied: 'done',
    delivery: 'settled',
    terminal: true,
    ...over
  };
}

function conversation(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schema: 3,
    revision: 0,
    id: 'abcdefgh',
    messenger: 'fake',
    anchor: 'thread',
    refs: ['thread'],
    latest: 'thread',
    owner: 'T1:U1',
    state: 'live',
    past: [],
    notices: [],
    createdAt: T0,
    updatedAt: T0,
    ...over
  };
}

function open(clock: () => number, holder?: Holder) {
  let changes = 0;
  const messages = new MessageState({
    messenger: fake.fakeMessenger(),
    allowlist: ['T1:U1'],
    clock,
    stopped: () => false,
    ...(holder ? { holder } : {}),
    changed: () => {
      changes++;
    },
    log: () => undefined
  });
  return { messages, changes: () => changes };
}

function fileOf(id: string): string {
  return path.join(paths.CONVERSATIONS_DIR, `${id}.json`);
}

async function disk(id: string): Promise<{
  revision: number;
  updatedAt: number;
  latest: string;
  messages?: { id: string }[];
}> {
  return JSON.parse(await fs.readFile(fileOf(id), 'utf8')) as {
    revision: number;
    updatedAt: number;
    latest: string;
    messages?: { id: string }[];
  };
}

/** NTFS mtime ticks are coarser than this case, so pin a sentinel the next write must move. */
async function stamp(id: string): Promise<number> {
  const old = new Date('2000-01-01T00:00:00Z');
  await fs.utimes(fileOf(id), old, old);
  return (await fs.stat(fileOf(id))).mtimeMs;
}

const holderOf = (pid: number): Holder => ({
  windowId: 'w1',
  label: 'w1',
  pid,
  startedAt: 10,
  since: 10
});

describe('MessageState save', () => {
  it('does not rewrite a record already durable, and does write a changed one', async () => {
    let now = T0;
    const { messages, changes } = open(() => now);
    const record = conversation({ messages: [message('m1')] });
    messages.keep(record);

    assert.equal(await messages.save(record), true);
    assert.equal(record.revision, 1);
    assert.equal((await disk(record.id)).revision, 1);
    const landed = changes();
    const mtime = await stamp(record.id);
    now = T0 + 1000;

    assert.equal(await messages.save(record), true);
    assert.equal(record.revision, 1);
    assert.equal(record.updatedAt, T0);
    assert.equal((await disk(record.id)).revision, 1);
    assert.equal((await disk(record.id)).updatedAt, T0);
    assert.equal((await fs.stat(fileOf(record.id))).mtimeMs, mtime);
    assert.equal(changes(), landed + 1);

    record.latest = 'next';
    assert.equal(await messages.save(record), true);
    assert.equal(record.revision, 2);
    assert.equal(record.updatedAt, T0 + 1000);
    const written = await disk(record.id);
    assert.equal(written.revision, 2);
    assert.equal(written.updatedAt, T0 + 1000);
    assert.equal(written.latest, 'next');
    assert.notEqual((await fs.stat(fileOf(record.id))).mtimeMs, mtime);
  });

  it('writes when retention drops a message and nothing else changed', async () => {
    const { messages } = open(() => T0);
    const rows = Array.from({ length: store.MESSAGES_KEPT + 1 }, (_, index) =>
      message(`m${index}`, index === 0 ? { uncertainEffect: true } : {})
    );
    const record = conversation({ messages: rows });
    messages.keep(record);

    assert.equal(await messages.save(record), true);
    assert.equal((await disk(record.id)).messages?.length, store.MESSAGES_KEPT + 1);
    delete rows[0]?.uncertainEffect;

    assert.equal(await messages.save(record), true);
    assert.equal(record.revision, 2);
    const written = await disk(record.id);
    assert.equal(written.revision, 2);
    assert.equal(written.messages?.length, store.MESSAGES_KEPT);
    assert.equal(
      written.messages?.some((row) => row.id === 'm0'),
      false
    );
  });

  it('writes again when a failed save left revision ahead of the file', async () => {
    const { messages } = open(() => T0);
    const record = conversation({ messages: [message('m1')] });
    messages.keep(record);
    assert.equal(await messages.save(record), true);
    assert.equal(record.revision, 1);
    const landed = await fs.readFile(fileOf(record.id), 'utf8');
    record.latest = 'next';
    await fs.writeFile(fileOf(record.id), '{');

    assert.equal(await messages.save(record), false);
    assert.equal(record.revision, 2);
    record.latest = 'thread';
    await fs.writeFile(fileOf(record.id), landed);
    assert.equal((await disk(record.id)).revision, 1);

    assert.equal(await messages.save(record), true);
    assert.equal(record.revision, 3);
    const repaired = await disk(record.id);
    assert.equal(repaired.revision, 3);
    assert.equal(repaired.latest, 'thread');
  });

  it('fails a repeated save once this window no longer holds Remote', async () => {
    const me = holderOf(4242);
    await writeJson(paths.HOLDER_FILE, me);
    const { messages } = open(() => T0, me);
    const record = conversation({ messages: [message('m1')] });
    messages.keep(record);

    assert.equal(await messages.save(record), true);
    const mtime = await stamp(record.id);
    await writeJson(paths.HOLDER_FILE, holderOf(4243));

    assert.equal(await messages.save(record), false);
    assert.equal(record.revision, 1);
    assert.equal((await disk(record.id)).revision, 1);
    assert.equal((await fs.stat(fileOf(record.id))).mtimeMs, mtime);
  });
});
