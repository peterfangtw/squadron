import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import type { Inbound, Notice } from '../../core/bridge/model';
import type { Credentials, LinkState, MessengerEntry, SetupCheck } from '../../core/bridge/port';
import { tempHome } from '../helpers';

let fake: typeof import('../../core/bridge/fake');
let files: typeof import('../../core/remote/fake_files');
let paths: typeof import('../../core/paths');

const T0 = 1_700_000_000;

before(async () => {
  await tempHome();
  fake = await import('../../core/bridge/fake');
  files = await import('../../core/remote/fake_files');
  paths = await import('../../core/paths');
});

beforeEach(async () => {
  await fs.rm(paths.FAKE_DIR, { recursive: true, force: true });
});

/** A fake with its connection open, and every event its sink was handed. */
function connected(options: Parameters<typeof fake.fakeMessenger>[0] = {}) {
  const messenger = fake.fakeMessenger(options);
  const events: Inbound[] = [];
  const connection = messenger.connect((event) => events.push(event));
  return { messenger, events, connection };
}

/** One inbox file, written whole, dated `at` seconds so the order is the
 *  test's and not the filesystem's. */
async function drop(name: string, body: unknown, at: number): Promise<void> {
  const file = path.join(files.INBOX_DIR, name);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, typeof body === 'string' ? body : JSON.stringify(body));
  await fs.rename(tmp, file);
  await fs.utimes(file, T0 + at, T0 + at);
}

const inbox = () =>
  fs.readdir(files.INBOX_DIR).then((names) => names.filter((n) => n.endsWith('.json')));
const rejected = () => fs.readdir(files.REJECTED_DIR).catch(() => [] as string[]);

const notice = (body: string): Notice => ({ kind: 'refusal', body });

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('driveFake', () => {
  it('makes the inbox when it starts, and nothing before', async () => {
    await assert.rejects(fs.stat(paths.FAKE_DIR));
    const { messenger } = connected();
    const driver = await files.driveFake(messenger);
    assert.equal((await fs.stat(files.INBOX_DIR)).isDirectory(), true);
    driver.dispose();
  });

  it('hands inbox files to the fake oldest first, each once, and removes them', async () => {
    const { messenger, events } = connected();
    const driver = await files.driveFake(messenger);
    // Named against their age, so a sort by name would get it wrong.
    await drop('a.json', { command: { sender: 'T1:U1', name: 'list' } }, 3);
    await drop('b.json', { press: { sender: 'T1:U1', payload: 'k.1' } }, 2);
    await drop('c.json', { say: { sender: 'T1:U1', text: 'hello', addressed: 'mention' } }, 1);
    await Promise.all([driver.drain(), driver.drain()]);
    await driver.drain();
    assert.deepEqual(
      events.map((event) => event.kind),
      ['message', 'press', 'command']
    );
    const said = events[0];
    assert.equal(said?.kind === 'message' ? said.text : '', 'hello');
    assert.equal(said?.kind === 'message' ? said.addressed : '', 'mention');
    assert.deepEqual(await inbox(), []);
    driver.dispose();
  });

  it('once started, hands a file dropped later with nobody asking, and stops at dispose', async () => {
    const { messenger, events } = connected();
    const driver = await files.driveFake(messenger);
    driver.start();
    await drop('late.json', { say: { sender: 'T1:U1', text: 'later' } }, 1);
    await until(() => events.length === 1, files.INBOX_POLL_MS * 10);
    assert.deepEqual(await inbox(), []);

    driver.dispose();
    await drop('after.json', { say: { sender: 'T1:U1', text: 'after' } }, 2);
    await new Promise((resolve) => setTimeout(resolve, files.INBOX_POLL_MS * 3));
    assert.equal(events.length, 1);
    assert.deepEqual(await inbox(), ['after.json']);
  });

  it('sets a bad file aside rather than retrying it', async () => {
    const { messenger, events, connection } = connected();
    const driver = await files.driveFake(messenger);
    await drop('torn.json', '{"say": {"sender": ', 1);
    await drop('shape.json', { shout: { sender: 'T1:U1', text: 'hi' } }, 2);
    await drop(
      'two.json',
      { say: { sender: 'a', text: 'b' }, press: { sender: 'a', payload: 'p' } },
      3
    );
    await drop('state.json', { link: { kind: 'sleeping' } }, 4);
    await drop('retry.json', { link: { kind: 'failed', reason: 'gone' } }, 5);
    await drop('text.json', { say: { sender: 'T1:U1', text: 7 } }, 6);
    await driver.drain();
    await driver.drain();
    assert.deepEqual(events, []);
    assert.deepEqual(connection.state, { kind: 'connected' });
    assert.deepEqual(await inbox(), []);
    assert.deepEqual((await rejected()).sort(), [
      'retry.json',
      'shape.json',
      'state.json',
      'text.json',
      'torn.json',
      'two.json'
    ]);
    driver.dispose();
  });

  it("moves the fake's connection through every link state", async () => {
    const { messenger, connection } = connected({ held: true });
    const seen: LinkState[] = [];
    connection.onState((state) => seen.push(state));
    const driver = await files.driveFake(messenger);
    assert.deepEqual(connection.state, { kind: 'connecting' });
    const moves: LinkState[] = [
      { kind: 'connected', warning: 'another client' },
      { kind: 'reconnecting', reason: 'socket closed' },
      { kind: 'connected' },
      { kind: 'failed', reason: 'token revoked', retry: false }
    ];
    for (const [i, link] of moves.entries()) await drop(`l${i}.json`, { link }, i);
    await driver.drain();
    assert.deepEqual(seen, moves);
    driver.dispose();
  });

  it('appends every post, settle and file to the outbox as it happens, in order', async () => {
    const { messenger } = connected();
    const driver = await files.driveFake(messenger);
    const first = await messenger.post({ home: 'T1:U1' }, notice('one'));
    await messenger.edit?.settle(first.message, { ...notice('one'), settled: 'Done' });
    await messenger.post({ under: first.message }, notice('two'));
    await driver.flush();
    const lines = (await fs.readFile(files.OUTBOX_FILE, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; notice: Notice });
    assert.deepEqual(
      lines.map((line) => [line.kind, line.notice.body, line.notice.settled]),
      [
        ['post', 'one', undefined],
        ['settle', 'one', 'Done'],
        ['post', 'two', undefined]
      ]
    );
    driver.dispose();
  });

  it('records reaction effects against original messages in the fake and disk outbox', async () => {
    const { messenger } = connected();
    const driver = await files.driveFake(messenger);
    const original = messenger.say('T1:U1', 'hello');
    assert.ok(original?.kind === 'message');
    assert.ok(messenger.reactions);
    for (const status of ['received', 'processing', 'done'] as const) {
      await messenger.reactions.set(original.ref, status);
    }
    await driver.flush();
    const records = (await fs.readFile(files.OUTBOX_FILE, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    assert.deepEqual(records, [
      { kind: 'reaction', message: original.ref, status: 'received' },
      { kind: 'reaction', message: original.ref, status: 'processing' },
      { kind: 'reaction', message: original.ref, status: 'done' }
    ]);
    assert.deepEqual(
      messenger.reactionEffects(),
      records.map((record) => {
        const { kind: _kind, ...effect } = record;
        return effect;
      })
    );
    driver.dispose();
    await messenger.reactions.set(original.ref, 'received');
    await driver.flush();
    assert.equal((await fs.readFile(files.OUTBOX_FILE, 'utf8')).trim().split('\n').length, 3);
  });

  it('writes nothing for a fake it does not drive, and nothing after dispose', async () => {
    const undriven = connected();
    await undriven.messenger.post({ home: 'T1:U1' }, notice('quiet'));
    await assert.rejects(fs.stat(paths.FAKE_DIR));

    const { messenger, events } = connected();
    const driver = await files.driveFake(messenger);
    driver.dispose();
    await messenger.post({ home: 'T1:U1' }, notice('after'));
    await drop('late.json', { say: { sender: 'T1:U1', text: 'late' } }, 1);
    await driver.drain();
    await driver.flush();
    assert.deepEqual(events, []);
    await assert.rejects(fs.stat(files.OUTBOX_FILE));
  });
});

describe('checkedFake', () => {
  const ask = async (entry: MessengerEntry, credentials: Credentials = { token: 't' }) => {
    const found = await entry.check?.(credentials, new AbortController().signal);
    assert.ok(found);
    return found;
  };

  const records = async () =>
    (await fs.readFile(files.CHECKS_FILE, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { at: number; result: SetupCheck });

  it('answers ok when no verdict is named, and records it with Remote off', async () => {
    const found = await ask(files.checkedFake(undefined, () => 42));
    assert.equal(found.kind, 'ok');
    assert.deepEqual(await records(), [{ at: 42, result: found }]);
    // Remote off: nothing drove the fake, so its inbox was never made.
    await assert.rejects(fs.stat(files.INBOX_DIR));
  });

  it('answers the verdict the setting names, and records each check in order', async () => {
    const failed = { kind: 'setup', step: 1, reason: 'Redo the second step.' } as const;
    const entry = files.checkedFake(failed, () => 1);
    assert.deepEqual(await ask(entry), failed);
    assert.deepEqual(await ask(entry), failed);
    const unreachable = { kind: 'unreachable', reason: 'Offline.' } as const;
    assert.deepEqual(await ask(files.checkedFake(unreachable, () => 2)), unreachable);
    assert.deepEqual(
      (await records()).map(({ at, result }) => [at, result.kind]),
      [
        [1, 'setup'],
        [1, 'setup'],
        [2, 'unreachable']
      ]
    );
  });

  it('keeps the facts an ok verdict names', async () => {
    const ok = { kind: 'ok', facts: [{ label: 'Workspace', value: 'Smoke' }] } as const;
    assert.deepEqual(await ask(files.checkedFake(ok, () => 1)), ok);
  });

  it('keeps the space an ok verdict names, and drops one that is not text', async () => {
    const ok = { kind: 'ok', facts: [], space: 'S0SMOKE' } as const;
    assert.deepEqual(await ask(files.checkedFake(ok, () => 1)), ok);
    const odd = await ask(files.checkedFake({ kind: 'ok', facts: [], space: 7 }, () => 1));
    assert.deepEqual(odd, { kind: 'ok', facts: [] });
  });

  it('answers the default for a verdict it cannot read', async () => {
    for (const raw of [
      'setup',
      { kind: 'setup', step: -1, reason: 'x' },
      { kind: 'setup', step: 1.5, reason: 'x' },
      { kind: 'setup', step: 1 },
      { kind: 'unreachable' },
      { kind: 'ok', facts: [{ label: 'x' }] },
      { kind: 'later' }
    ]) {
      assert.equal((await ask(files.checkedFake(raw, () => 1))).kind, 'ok', JSON.stringify(raw));
    }
  });

  it('records no credential a verdict reflects back', async () => {
    const sentinel = 'SENTINEL-TOKEN-77';
    for (const verdict of [
      { kind: 'setup', step: 0, reason: `Refused ${sentinel}.` },
      { kind: 'unreachable', reason: `Could not reach with ${sentinel}.` },
      { kind: 'ok', facts: [{ label: sentinel, value: `bot ${sentinel}` }] }
    ]) {
      await ask(
        files.checkedFake(verdict, () => 1),
        { token: sentinel }
      );
    }
    const text = await fs.readFile(files.CHECKS_FILE, 'utf8');
    assert.equal(text.trim().split('\n').length, 3);
    assert.ok(!text.includes('SENTINEL'), text);
  });

  it('keeps the fake entry everything else reads', () => {
    const entry = files.checkedFake(undefined, () => 1);
    assert.equal(entry.id, fake.fakeEntry.id);
    assert.deepEqual(entry.setup, fake.fakeEntry.setup);
  });
});
