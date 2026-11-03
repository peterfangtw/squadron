import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { LinkState } from '../../core/bridge/port';
import { disposeHome } from '../helpers';
import {
  boot,
  stopBridges,
  APP,
  SITE,
  OWNER,
  home,
  paths,
  words,
  watched,
  claim,
  make,
  finished,
  saved,
  begin,
  chooseDefault
} from './bridge_engine_helpers';

before(async () => {
  await boot();
});

after(async () => {
  await stopBridges();
  await disposeHome(home);
});

beforeEach(() => fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true }));

describe('the engine: held prompts (D24, D39)', () => {
  it('holds a job for a pick, starts on the tap, and expires through tick', async () => {
    const claims = [claim('w1', APP), claim('w2', SITE)];
    const t = make();
    await begin(t.bridge, [], claims);
    assert.equal(t.bridge.nextDeadline(), undefined);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    const picker = t.messenger.posts().at(-1);
    assert.equal(picker?.notice.kind, 'picker');
    assert.equal(t.bridge.nextDeadline(), t.now() + 10 * 60_000);

    t.messenger.say(OWNER, 'write docs');
    await t.drain();
    const correlation = (await saved()).find((r) => r.held?.prompt === 'write docs')?.held
      ?.correlation;
    assert.ok(correlation);
    const second = t.messenger.posts().at(-1);
    const site = second?.notice.buttons?.find((b) => b.label === 'site');
    assert.ok(site);
    t.messenger.press(OWNER, site.payload);
    await t.drain();
    await chooseDefault(t);
    assert.deepEqual(t.verbs.of('start')[0]?.args, [
      { windowId: 'w2', cwd: SITE, prompt: 'write docs', correlation }
    ]);
    assert.equal(t.messenger.settles().at(-1)?.notice.settled, 'Starting');

    t.advance(10 * 60_000);
    await t.bridge.tick(t.now());
    const expired = t.messenger.settles().at(-1);
    assert.equal(expired?.message, picker?.posted.message);
    assert.equal(expired?.notice.settled, words.expiredWord);
    assert.equal(t.bridge.nextDeadline(), undefined);
    const records = await saved();
    assert.deepEqual(records.map((r) => r.state).sort(), ['held', 'live']);
  });
});

describe('the engine: a picker over the messenger’s buttons', () => {
  it('keeps every folder reachable within a two-button budget', async () => {
    const claims = ['app', 'docs', 'site', 'zeta'].map((name, i) =>
      claim(`w${i}`, path.resolve('/repo', name))
    );
    const t = make({ fake: { perNotice: 2 } });
    await begin(t.bridge, [], claims);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    const seen = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const active = t.messenger
        .posts()
        .filter((p) => p.notice.kind === 'picker' && !p.notice.settled);
      for (const post of active) {
        assert.ok((post.notice.buttons?.length ?? 0) <= 2);
        for (const button of post.notice.buttons ?? []) seen.add(button.label);
      }
      const next = active.flatMap((p) => p.notice.buttons ?? []).find((b) => b.label === 'Next');
      if (!next) break;
      t.messenger.press(OWNER, next.payload);
      await t.drain();
    }
    for (const name of ['app', 'docs', 'site', 'zeta']) assert.ok(seen.has(name));
    assert.equal(t.verbs.of('start').length, 0);
  });
});

describe('the engine: folders that share a name', () => {
  it('tells them apart by their parent, in the buttons and the settle', async () => {
    const claims = [
      claim('w1', path.resolve('/work/a/api')),
      claim('w2', path.resolve('/work/b/api')),
      claim('w3', path.resolve('/site'))
    ];
    const t = make();
    await begin(t.bridge, [], claims);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    const picker = t.messenger.posts().at(-1)?.notice;
    assert.deepEqual(
      picker?.buttons?.map((b) => b.label),
      ['site', 'a/api', 'b/api', 'Cancel']
    );
    const b = picker?.buttons?.find((button) => button.label === 'b/api');
    assert.ok(b);
    t.messenger.press(OWNER, b.payload);
    await t.drain();
    await chooseDefault(t);
    assert.equal(t.messenger.settles().at(-1)?.notice.settled, 'Starting');
  });
});

describe('the engine: who a notice mentions (D15)', () => {
  it('mentions the owner on a replacement picker and when a fresh session takes over', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP), claim('w2', SITE)]);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    const site = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'site');
    assert.ok(site);
    await t.bridge.observe([], [claim('w1', APP)]);
    t.messenger.press(OWNER, site.payload);
    await t.drain();
    const again = t.messenger.posts().at(-1)?.notice;
    assert.equal(again?.kind, 'picker');
    assert.equal(again?.mention, OWNER);

    await t.bridge.observe([], []);
    const app = again?.buttons?.find((b) => b.label === 'app');
    assert.ok(app);
    t.messenger.press(OWNER, app.payload);
    await t.drain();
    const none = t.messenger.posts().at(-1)?.notice;
    assert.equal(none?.kind, 'refusal');
    assert.equal(none?.mention, OWNER);

    const f = make();
    await begin(f.bridge);
    const { post } = await finished(f);
    await f.bridge.observe([], [claim('w1', APP)]);
    f.messenger.say(OWNER, 'keep going', { in: post.posted.anchor });
    await f.drain();
    const ended = f.messenger.posts().find((p) => p.notice.kind === 'ended')?.notice;
    assert.equal(ended?.mention, OWNER);
  });

  it('mentions nobody in a direct answer to the person’s own action', async () => {
    const t = make({ answers: { send: { ok: true, queued: 1 } } });
    await begin(t.bridge);
    const { root, post } = await finished(t);
    const busy = { ...root, session: { ...root.session, status: 'busy' as const } };
    await t.bridge.observe([busy], []);
    t.messenger.say(OWNER, 'and the tests', { in: post.posted.anchor });
    t.messenger.command(OWNER, 'list');
    t.messenger.command(OWNER, 'help');
    t.messenger.command(OWNER, 'end', '10');
    await t.bridge.observe([busy], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    await chooseDefault(t);
    const answers = t.messenger
      .posts()
      .slice(1)
      .filter((p) => p.notice.kind !== 'picker');
    assert.deepEqual(
      answers.map((p) => p.notice.kind),
      ['receipt', 'list', 'help', 'confirm', 'started']
    );
    for (const answer of answers)
      assert.equal(answer.notice.mention, undefined, answer.notice.kind);
  });
});

describe('the engine: list', () => {
  it('prints no exited session, so every pid it prints is one end takes', async () => {
    const t = make();
    await begin(t.bridge);
    const live = watched(10);
    const gone = { ...watched(20), exit: { code: 1, signal: null } };
    await t.bridge.observe([live, gone], [claim('w1', APP)]);
    t.messenger.command(OWNER, 'list');
    await t.drain();
    const list = t.messenger.posts().at(-1)?.notice;
    assert.equal(list?.kind, 'list');
    assert.deepEqual(
      list?.table?.rows.map((row) => row[3]),
      ['10']
    );
  });
});

describe('the engine: the link', () => {
  it('follows the connection through every LinkState', async () => {
    const t = make({ fake: { held: true } });
    assert.deepEqual(t.bridge.link(), { kind: 'connecting' });
    const seen: LinkState[] = [];
    t.bridge.onLink((state) => seen.push(state));
    await begin(t.bridge);
    assert.deepEqual(t.bridge.link(), { kind: 'connecting' });
    const states: LinkState[] = [
      { kind: 'connected' },
      { kind: 'reconnecting', reason: 'socket closed' },
      { kind: 'connected', warning: 'another client holds this app' },
      { kind: 'failed', reason: 'token revoked', retry: false }
    ];
    for (const state of states) {
      t.messenger.link(state);
      assert.deepEqual(t.bridge.link(), state);
    }
    assert.deepEqual(seen, states);
  });
});
