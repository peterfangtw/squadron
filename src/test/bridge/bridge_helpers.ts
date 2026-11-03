import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as fake from '../../core/bridge/fake';
import type {
  Button,
  Inbound,
  MessageRef,
  Notice,
  Posted,
  SenderId
} from '../../core/bridge/model';
import type { Messenger } from '../../core/bridge/port';
import { repoRoot } from '../helpers';

/** What a person does at the messenger, in our words. A harness turns each
 *  into whatever its messenger would really deliver. */
export type PortFixture =
  /** A reply to a posted notice: in its thread, or answering it in a chain. */
  | { kind: 'reply'; sender: SenderId; text: string; to: Posted }
  | { kind: 'press'; sender: SenderId; payload: string; on: Posted }
  /** The bot's own post, coming back the way the messenger echoes it. */
  | { kind: 'echo'; of: Posted }
  /** A reply sent while the link was down: never delivered, and found in the
   *  messenger's history by `backlog`. */
  | { kind: 'missed'; sender: SenderId; text: string; to: Posted };

/** One posted notice as the person sees it: the text of each post it took,
 *  and the buttons or the settled word under it. */
export type Observed = {
  message: MessageRef;
  parts: readonly string[];
  buttons: readonly Button[];
  settled?: string;
};

/**
 * One adapter, under test. `inject` delivers a fixture as the messenger would
 * and resolves once the adapter has acked it; `acked` counts every delivery
 * the adapter acked, dropped ones included.
 */
export type PortHarness = {
  messenger: Messenger;
  inject(fixture: PortFixture): Promise<void>;
  observed(): readonly Observed[];
  acked(): number;
};

const OWNER = 'T1:U1';

/**
 * What every adapter must do for the core, run against a fresh harness per
 * case. The fake passes it here, and the Slack adapter passes the same
 * function in its own suite: the contract is shared, never copied.
 */
export function portContract(label: string, make: () => PortHarness): void {
  describe(`the port contract: ${label}`, () => {
    /** A harness connected to a sink that keeps what it is handed. */
    const connected = () => {
      const harness = make();
      const events: Inbound[] = [];
      const link = harness.messenger.connect((event) => events.push(event));
      return { harness, events, link };
    };

    it('brings a reply to a posted notice back with a ref that resolves to it', async () => {
      const { harness, events, link } = connected();
      const posted = await harness.messenger.post({ home: OWNER }, notice('Need a hand?'));
      await harness.inject({ kind: 'reply', sender: OWNER, text: 'yes', to: posted });
      link.close();
      assert.equal(events.length, 1);
      const reply = events[0];
      assert.equal(reply?.kind, 'message');
      if (reply?.kind !== 'message') return;
      assert.equal(reply.text, 'yes');
      assert.equal(reply.sender.id, OWNER);
      assert.ok(
        reply.refs.some((ref) => ref === posted.anchor || ref === posted.message),
        `refs ${JSON.stringify(reply.refs)} name the notice ${JSON.stringify(posted)}`
      );
    });

    it('reads back a reply the link missed, as a delivery would have carried it', async (t) => {
      const { harness, events, link } = connected();
      const backlog = harness.messenger.backlog;
      if (backlog === undefined) {
        link.close();
        t.skip('capability: this messenger keeps no backlog');
        return;
      }
      const posted = await harness.messenger.post({ home: OWNER }, notice('Need a hand?'));
      await harness.inject({ kind: 'missed', sender: OWNER, text: 'first', to: posted });
      await harness.inject({ kind: 'missed', sender: OWNER, text: 'second', to: posted });
      assert.equal(events.length, 0, 'nothing was delivered');
      const signal = new AbortController().signal;
      const read = await backlog.since([posted.anchor], 0, signal);
      link.close();
      assert.equal(read.missed, 0);
      const texts = read.events.map((e) => (e.kind === 'message' ? e.text : e.kind));
      assert.deepEqual(texts, ['first', 'second']);
      const [first, second] = read.events;
      assert.ok(first?.kind === 'message' && second?.kind === 'message');
      assert.equal(first.sender.id, OWNER);
      assert.ok(first.refs.some((ref) => ref === posted.anchor || ref === posted.message));
      assert.ok(first.at <= second.at);
      const later = await backlog.since([posted.anchor], first.at, signal);
      assert.deepEqual(
        later.events.map((e) => e.id),
        [second.id]
      );
    });

    it('round-trips a payload of payloadMax bytes, and refuses a longer one', async () => {
      const { harness, events, link } = connected();
      const max = harness.messenger.buttons.payloadMax;
      const payload = 'a'.repeat(max);
      const posted = await harness.messenger.post(
        { home: OWNER },
        notice('Pick one', [{ label: 'Go', payload }])
      );
      assert.deepEqual(
        harness
          .observed()
          .at(-1)
          ?.buttons.map((b) => b.payload),
        [payload]
      );
      await harness.inject({ kind: 'press', sender: OWNER, payload, on: posted });
      link.close();
      const press = events[0];
      assert.equal(press?.kind, 'press');
      if (press?.kind !== 'press') return;
      assert.equal(press.payload, payload);
      assert.equal(press.message, posted.message);
      await assert.rejects(
        harness.messenger.post(
          { home: OWNER },
          notice('Too long', [{ label: 'Go', payload: `${payload}a` }])
        )
      );
    });

    if (make().messenger.edit) {
      it('settles by replacing the buttons and nothing else', async () => {
        const harness = make();
        const edit = harness.messenger.edit;
        assert.ok(edit);
        const asked = notice('May I run it?', [
          { label: 'Deny', payload: 'c1.a', tone: 'danger' },
          { label: 'End', payload: 'c1.b', tone: 'danger' }
        ]);
        const posted = await harness.messenger.post({ home: OWNER }, asked);
        const before = harness.observed().at(-1);
        assert.equal(before?.buttons.length, 2);
        await edit.settle(posted.message, { ...asked, buttons: [], settled: 'Denied' });
        const after = harness.observed().at(-1);
        assert.equal(after?.message, posted.message);
        assert.deepEqual(after?.parts, before?.parts, 'the text is untouched');
        assert.deepEqual(after?.buttons, []);
        assert.equal(after?.settled, 'Denied');
      });
    }

    it('delivers text over text.max whole, in posts the messenger takes', async () => {
      const harness = make();
      const max = harness.messenger.text.max;
      const lines: string[] = [];
      for (let n = 0; lines.join('\n').length < max * 1.5; n++)
        lines.push(`line ${n} of a long reply`);
      const body = lines.join('\n');
      await harness.messenger.post({ home: OWNER }, notice(body));
      const seen = harness.observed().at(-1);
      assert.ok(seen);
      assert.ok(seen.parts.length > 1, 'split into more than one post');
      for (const part of seen.parts) assert.ok(part.length <= max, `${part.length} <= ${max}`);
      const squash = (text: string) => text.replace(/\s+/g, '');
      assert.ok(squash(seen.parts.join('')).includes(squash(body)), 'every word arrived');
    });

    it('never hands the bot’s own posts to the sink', async () => {
      const { harness, events, link } = connected();
      const posted = await harness.messenger.post({ home: OWNER }, notice('Done.'));
      await harness.inject({ kind: 'echo', of: posted });
      link.close();
      assert.deepEqual(events, []);
    });

    it('acks without waiting on the sink, and acks one that throws', async () => {
      const harness = make();
      const posted = await harness.messenger.post({ home: OWNER }, notice('Done.'));
      // A sink that never settles: an adapter awaiting it would hang here. The
      // port types the sink as void, which is the rule this case holds.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      const hanging = harness.messenger.connect(() => new Promise<void>(() => undefined));
      const before = harness.acked();
      await harness.inject({ kind: 'reply', sender: OWNER, text: 'one', to: posted });
      assert.equal(harness.acked(), before + 1);
      hanging.close();
      const throwing = harness.messenger.connect(() => {
        throw new Error('the core fell over');
      });
      await harness.inject({ kind: 'reply', sender: OWNER, text: 'two', to: posted });
      assert.equal(harness.acked(), before + 2);
      throwing.close();
    });
  });
}

function notice(body: string, buttons?: readonly Button[]): Notice {
  return { kind: 'finished', head: 'repo · session', body, ...(buttons ? { buttons } : {}) };
}

/** The fake as a `PortHarness`: fixtures become its own drivers. */
export function fakeHarness(options: fake.FakeOptions = {}): PortHarness & {
  messenger: fake.FakeMessenger;
} {
  const messenger = fake.fakeMessenger(options);
  return {
    messenger,
    inject(fixture) {
      switch (fixture.kind) {
        case 'reply':
          messenger.say(
            fixture.sender,
            fixture.text,
            messenger.shape === 'thread'
              ? { in: fixture.to.anchor }
              : { replyTo: fixture.to.message }
          );
          break;
        case 'press':
          messenger.press(fixture.sender, fixture.payload, fixture.on.message);
          break;
        case 'echo':
          messenger.echo(fixture.of);
          break;
        case 'missed':
          messenger.missed(
            fixture.sender,
            fixture.text,
            messenger.shape === 'thread'
              ? { in: fixture.to.anchor }
              : { replyTo: fixture.to.message }
          );
          break;
      }
      return Promise.resolve();
    },
    observed: () =>
      messenger.posts().map((post) => ({
        message: post.posted.message,
        parts: post.parts,
        buttons: post.notice.buttons ?? [],
        ...(post.notice.settled === undefined ? {} : { settled: post.notice.settled })
      })),
    acked: () => messenger.acked()
  };
}

/**
 * Every word a fake CLI scripts a turn on, read out of the fixtures' own
 * `includes('…')` calls so a new trigger is held here the day it is added. A
 * line the bridge composes and a session reads as a prompt must carry none
 * (`src/test/AGENTS.md`).
 */
export function triggerWords(): string[] {
  const dir = path.join(repoRoot(), 'src', 'test', 'fixtures');
  const words = new Set<string>();
  for (const file of ['fake-cli.ts', 'fake-acp.ts', 'fake-codex.ts']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of text.matchAll(/includes\('([^']+)'\)/g)) {
      if (match[1] !== undefined) words.add(match[1]);
    }
  }
  return [...words];
}

/** The trigger words a line carries, case-folded. */
export function triggersIn(line: string): string[] {
  const folded = line.toLowerCase();
  return triggerWords().filter((word) => folded.includes(word.toLowerCase()));
}
