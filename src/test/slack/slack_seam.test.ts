import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { Inbound, Notice } from '../../core/bridge/model';
import type { Connection, LinkState, Messenger } from '../../core/bridge/port';
import * as messenger from '../../core/slack/messenger';
import * as env from '../fixtures/slack_envelopes';
import { CREDENTIALS, fakeSlack } from './slack_helpers';
import { repoRoot } from '../helpers';

const SRC = path.join(repoRoot(), 'src');

/** Every `.ts` file under `dir`, as paths relative to `src/`. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [path.relative(SRC, full)] : [];
  });
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/**
 * Slack's wire stays in its package, held from source as the messenger seam
 * is (`bridge_seam.test.ts`): nothing at runtime notices the first wire word
 * that leaks above the adapter.
 */
describe('the Slack seam', () => {
  /** Slack's thread key, its markup, its two token prefixes, its ack field
   *  and its post method. */
  const WIRE = [/thread_ts/, /mrkdwn/, /xoxb/, /xapp/, /envelope_id/, /chat\.postMessage/];

  /**
   * Tests that play Slack's side carry its wire by design (R11): the Slack
   * suites and their fixtures. Two more name a word for a reason of their
   * own — the messenger seam's own list of words, and a sentinel shaped like
   * a bot token.
   */
  const exempt = (rel: string): boolean =>
    rel.startsWith(path.join('core', 'slack') + path.sep) ||
    /^test\/(fixtures\/|slack\/)slack_/.test(rel.split(path.sep).join('/')) ||
    rel === path.join('test', 'bridge', 'bridge_seam.test.ts') ||
    rel === path.join('test', 'bridge', 'bridge_engine_files.test.ts');

  it("names no Slack wire word outside src/core/slack/ and Slack's own tests", () => {
    const offenders: string[] = [];
    for (const rel of sources(SRC)) {
      if (exempt(rel)) continue;
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (WIRE.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        });
    }
    assert.deepEqual(offenders, []);
  });

  it('names no streaming method anywhere under src/ (D14)', () => {
    // Spelled apart, so this file does not name one either.
    const stream = new RegExp(['chat', '\\.(start|append|stop)', 'Stream'].join(''));
    const bare = new RegExp(['(start|append|stop)', 'Stream\\b'].join(''));
    const offenders = sources(SRC).filter((rel) => {
      const text = read(rel);
      return stream.test(text) || bare.test(text);
    });
    assert.deepEqual(offenders, []);
  });

  it('keeps every verb bundle clear of core/slack and the messenger port', () => {
    const offenders: string[] = [];
    for (const rel of sources(path.join(SRC, 'cli'))) {
      for (const reached of reachable(rel)) {
        const unix = reached.split(path.sep).join('/');
        if (unix.startsWith('core/slack/') || unix === 'core/bridge/port.ts') {
          offenders.push(`${rel} -> ${unix}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});

/** Every file `rel` reaches through value imports, itself included. A type
 *  import is erased and bundles nothing. */
function reachable(rel: string, seen = new Set<string>()): Set<string> {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const text = read(rel);
  const specifiers = [
    ...text.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm),
    ...text.matchAll(/^\s*import\s+'(\.[^']+)'/gm),
    ...text.matchAll(/^\s*export\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm),
    ...text.matchAll(/require\('(\.[^']+)'\)/g)
  ].map((match) => match[1] ?? '');
  for (const specifier of specifiers) {
    const base = path.join(path.dirname(rel), specifier);
    const target = [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) =>
      fs.existsSync(path.join(SRC, candidate))
    );
    if (target !== undefined) reachable(target, seen);
  }
  return seen;
}

describe('the Slack tokens', () => {
  const SENTINEL = 'SENTINEL';
  const said: string[] = [];
  const say = (value: unknown) =>
    said.push(typeof value === 'string' ? value : util.inspect(value, { depth: 12 }));

  beforeEach(() => {
    said.length = 0;
    for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      mock.method(console, name, (...args: unknown[]) => args.forEach(say));
    }
  });

  afterEach(() => mock.restoreAll());

  const notice: Notice = {
    kind: 'permission',
    mention: `${env.TEAM}:${env.OWNER}`,
    head: 'squadron · build',
    body: Array.from({ length: 800 }, (_, n) => `line ${n} of a long reply that runs on`).join(
      '\n'
    ),
    code: 'npm test',
    buttons: [{ label: 'Deny', payload: 'k3x9.a', tone: 'danger' }]
  };

  /** Lets the adapter's async connect run its course. */
  const settle = async () => {
    for (let spin = 0; spin < 20; spin++) await new Promise((resolve) => setImmediate(resolve));
  };

  /** A messenger over `fake`, connected, every event and state kept. */
  const connected = (fake: ReturnType<typeof fakeSlack>) => {
    const slack = messenger.slackMessenger(CREDENTIALS, fake.deps);
    const link = slack.connect((event: Inbound) => say(event));
    link.onState((state: LinkState) => say(state));
    return { slack, link };
  };

  /** Runs `call` and keeps what it gave or the message it threw. */
  const attempt = async (call: () => Promise<unknown>) => {
    try {
      say(await call());
    } catch (error) {
      say(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error);
    }
  };

  const clean = (links: Connection[], slack?: Messenger) => {
    for (const link of links) {
      say(link.state);
      link.close();
    }
    if (slack) say(slack);
    const leaks = said.filter((line) => line.includes(SENTINEL));
    assert.deepEqual(leaks, []);
    assert.ok(said.length > 0, 'the sweep saw something');
  };

  it('appear nowhere on the paths that work', async () => {
    const fake = fakeSlack();
    const { slack, link } = connected(fake);
    const ws = await fake.socket();
    ws.frame(env.hello());
    ws.frame(env.eventsApi(env.dmMessage(), { eventId: 'Ev1', envelopeId: 'a' }));
    ws.frame(env.eventsApi(env.dmThreadReply(), { eventId: 'Ev2', envelopeId: 'b' }));
    ws.frame(env.eventsApi(env.appMentionInThreadFromGuest(), { eventId: 'Ev3', envelopeId: 'c' }));
    ws.frame(env.blockActions());
    ws.frame(env.slashCommand('list'));
    ws.frame(env.eventsApi(env.botEcho(), { eventId: 'Ev4', envelopeId: 'd' }));
    await attempt(() => slack.post({ home: notice.mention ?? '' }, notice));
    const anchor = `${env.DM}:1760000100.000001`;
    await attempt(
      () => slack.edit?.settle(anchor, { ...notice, settled: 'Denied' }) ?? Promise.resolve()
    );
    await attempt(() => slack.links?.to(anchor) ?? Promise.resolve());
    await attempt(() => sendFile(slack, anchor));
    ws.drop();
    await settle();
    clean([link], slack);
  });

  it('appear nowhere when Slack refuses each call', async () => {
    const methods = [
      'auth.test',
      'apps.connections.open',
      'chat.postMessage',
      'chat.update',
      'chat.getPermalink',
      'files.getUploadURLExternal',
      'files.completeUploadExternal'
    ];
    const links: Connection[] = [];
    for (const method of methods) {
      const fake = fakeSlack({ refuse: { [method]: 'invalid_auth' } });
      const { slack, link } = connected(fake);
      links.push(link);
      await settle();
      await exercise(slack);
    }
    clean(links);
  });

  it('appear nowhere when the network throws with the headers in hand', async () => {
    const methods = [
      'auth.test',
      'apps.connections.open',
      'chat.postMessage',
      'chat.update',
      'chat.getPermalink',
      'files.getUploadURLExternal',
      'fixture-upload',
      'files.completeUploadExternal'
    ];
    const links: Connection[] = [];
    for (const method of methods) {
      const fake = fakeSlack({ throws: [method] });
      const { slack, link } = connected(fake);
      links.push(link);
      await settle();
      await exercise(slack);
    }
    clean(links);
  });

  it('appear in no refusal of malformed credentials', () => {
    for (const credentials of [
      { botToken: 'xoxp-SENTINEL', appToken: 'xapp-SENTINEL' },
      { botToken: 'xoxb-SENTINEL', appToken: 'xoxb-SENTINEL' },
      { botToken: 'xapp-SENTINEL', appToken: 'xoxb-SENTINEL' },
      { botToken: '', appToken: 'xapp-SENTINEL' }
    ]) {
      say(messenger.slackEntry.create(credentials));
    }
    clean([]);
  });

  /** Every outbound call once. */
  async function exercise(slack: Messenger): Promise<void> {
    const anchor = `${env.DM}:${env.P1_TS}`;
    await attempt(() => slack.post({ home: notice.mention ?? '' }, notice));
    await attempt(
      () => slack.edit?.settle(anchor, { ...notice, settled: 'Denied' }) ?? Promise.resolve()
    );
    await attempt(() => slack.links?.to(anchor) ?? Promise.resolve());
    await attempt(() => sendFile(slack, anchor));
  }

  async function sendFile(slack: Messenger, anchor: string): Promise<unknown> {
    return slack.files?.send(
      { conversation: { anchor, latest: anchor } },
      { bytes: Buffer.from('png'), name: 'shot.png', mime: 'image/png', caption: 'see <!here>' }
    );
  }
});
