import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import type { RemoteStart } from '../../core/coordination/serve_owned';
import type { Holder } from '../../core/remote/holder';
import type { Started } from '../../core/bridge/bridge';
import type { FakeMessenger } from '../../core/bridge/fake';
import type { Messenger } from '../../core/bridge/port';
import type { Session, WindowClaim } from '../../core/model';
import type { PublishedLive } from '../../core/published';
import * as reconcile from '../../core/reconcile';
import type { OwnSession } from '../../core/remote/board';
import type { Built, RemoteSwitch } from '../../core/remote/switch';
import { resetDir, tempHome } from '../helpers';

/** Loaded after `tempHome`, so every store resolves under the temp `HOME`. */
let switching: typeof import('../../core/remote/switch');
let fake: typeof import('../../core/bridge/fake');
let holders: typeof import('../../core/remote/holder');
let paths: typeof import('../../core/paths');
let link: typeof import('../../core/remote/link');
let words: typeof import('../../core/bridge/words');

before(async () => {
  await tempHome();
  switching = await import('../../core/remote/switch');
  fake = await import('../../core/bridge/fake');
  holders = await import('../../core/remote/holder');
  paths = await import('../../core/paths');
  link = await import('../../core/remote/link');
  words = await import('../../core/bridge/words');
});

const switches: RemoteSwitch[] = [];
beforeEach(() => resetDir(paths.REMOTE_DIR));
afterEach(async () => {
  for (const remote of switches.splice(0)) await remote.dispose();
});

const OWNER = 'T1:U1';
const SECRET = 'switch-secret-0b7e';
const APP = path.resolve('/repo/app');
const T0 = 1_700_000_000_000;

/** This window's host, and another window's: alive at these starts unless a
 *  test takes them out of the table. */
const ME: Holder = { windowId: 'w-me', label: 'window me', pid: 4242, startedAt: T0, since: T0 };
const OTHER: Holder = {
  windowId: 'w-other',
  label: 'window other',
  pid: 5353,
  startedAt: T0 + 1_000,
  since: T0
};

/** This window's claim, so a new job has a folder to start in. */
const claim: WindowClaim = {
  id: ME.windowId,
  label: ME.label,
  app: 'Code',
  folder: APP,
  shellPids: [],
  updatedAt: Date.now()
};

/** The ports a host fills, held by the test: what the machine looks like,
 *  and a record of what the switch did to it. */
type Rig = {
  remote: RemoteSwitch;
  messenger: FakeMessenger;
  /** The process table every read returns. */
  starts: Map<number, number>;
  /** Every write to the remembered switch, in order. */
  memory: string[];
  logs: string[];
  own: OwnSession[];
  /** Other windows' records, by pid. */
  published: Map<number, PublishedLive>;
  claims: WindowClaim[];
  startCalls: RemoteStart[];
  /** What a start here comes to; refused unless a test says. */
  startAs?: Started;
  build: (signal?: AbortSignal) => Promise<Built>;
  /** The next credential read waits on this, once. */
  gate?: Promise<void>;
  /** A credential read has met the gate. */
  gated?: boolean;
  /** Called on each identity read. */
  onIdentity?: () => void;
  /** This host's start cannot be read: `identity` answers nothing. */
  unreadable?: boolean;
  keeperChecks: number;
  /** The allowlist setting as the switch reads it. */
  allowlist: string[];
  /** The pass's registration, when the rig runs a real Reconciler. */
  registration?: reconcile.CheckRegistration;
  /** Changes noticed on the registration that does nothing. */
  changes: number;
  /** Reads of the process table: one per pass. */
  processReads: number;
};

/** `reconciler`: register the pass with a real one, as the host does, its log
 *  into `logs`. Otherwise the registration does nothing. */
function rig(options: { reconciler?: boolean } = {}): Rig {
  const messenger = fake.fakeMessenger({ credentials: { token: SECRET } });
  const r: Omit<Rig, 'remote'> & { remote?: RemoteSwitch } = {
    messenger,
    starts: new Map([
      [ME.pid, ME.startedAt],
      [OTHER.pid, OTHER.startedAt]
    ]),
    memory: [],
    logs: [],
    own: [],
    published: new Map(),
    claims: [],
    startCalls: [],
    build: () => Promise.resolve({ ok: true, messenger }),
    keeperChecks: 0,
    allowlist: [OWNER],
    changes: 0,
    processReads: 0
  };
  const runtime = options.reconciler
    ? new reconcile.Reconciler((line) => r.logs.push(line))
    : undefined;
  r.remote = new switching.RemoteSwitch({
    windowId: ME.windowId,
    entry: () => fake.fakeEntry,
    allowlist: () => r.allowlist,
    credentials: async () => {
      const gate = r.gate;
      if (gate) {
        r.gate = undefined;
        r.gated = true;
        await gate;
      }
      return { token: SECRET };
    },
    messenger: (_entry, _credentials, signal) => r.build(signal),
    identity: () => {
      r.onIdentity?.();
      return Promise.resolve(r.unreadable ? undefined : { ...ME });
    },
    own: () => r.own,
    sessions: {
      owned: () => undefined,
      end: () => false,
      start: (start) => {
        r.startCalls.push(start);
        return Promise.resolve(r.startAs ?? { ok: false, reason: 'not started in this test' });
      }
    },
    processes: () => {
      r.processReads++;
      return Promise.resolve({ starts: new Map(r.starts) });
    },
    published: () => Promise.resolve(new Map(r.published)),
    lineage: () => Promise.resolve(new Map()),
    claims: () => Promise.resolve(r.claims),
    memory: {
      read: () => Promise.resolve(r.memory.at(-1)),
      write: (text) => {
        r.memory.push(text);
      }
    },
    keeper: {
      requestCheck: () => {
        r.keeperChecks++;
      },
      reason: () => undefined,
      holdsForRemote: () => true
    },
    register: (name, check) => {
      if (!runtime) {
        return {
          noticeChange: () => {
            r.changes++;
          },
          requestCheck: () => undefined,
          schedule: () => undefined,
          dispose: () => undefined
        };
      }
      const registration = runtime.register(name, 5_000, check);
      if (name === 'remote pass') r.registration = registration;
      return registration;
    },
    clock: Date.now,
    log: (line) => r.logs.push(line),
    changed: () => undefined
  });
  switches.push(r.remote);
  return r as Rig;
}

async function holderOnDisk(): Promise<Holder | undefined> {
  const text = await fs.readFile(paths.HOLDER_FILE, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as Holder);
}

/** Another window holds Remote: its file, written as its turn-on writes it. */
async function heldElsewhere(): Promise<void> {
  assert.deepEqual(await holders.acquireHolder(OTHER, { starts: new Map() }, []), { ok: true });
}

const remembered = (r: Rig) => link.readRemembered(r.memory.at(-1));

async function chooseDefault(r: Rig): Promise<void> {
  assert.equal(r.startCalls.length, 0, 'folder resolution still waits for a model choice');
  const picker = r.messenger.posts().at(-1);
  assert.equal(picker?.notice.kind, 'picker');
  const button = picker?.notice.buttons?.find((one) => one.label === 'Use window default');
  assert.ok(button);
  r.messenger.press(OWNER, button.payload);
  await r.remote.tick();
}

it('Off aborts construction and closes a late messenger without connecting', async (t) => {
  const r = rig();
  let finish: (made: Built) => void = () => {};
  let entered: () => void = () => {};
  const building = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let constructionSignal: AbortSignal | undefined;
  r.build = (signal) => {
    constructionSignal = signal;
    entered();
    return new Promise<Built>((resolve) => {
      finish = resolve;
    });
  };
  const connected = t.mock.method(r.messenger, 'connect');
  const closed = t.mock.method(r.messenger, 'close');
  const starting = r.remote.turnOn();
  await building;
  const stopping = r.remote.turnOff();
  finish({ ok: true, messenger: r.messenger });
  const outcome = await starting;
  await stopping;
  assert.equal(outcome.ok, false);
  assert.equal(constructionSignal?.aborted, true);
  assert.equal(connected.mock.callCount(), 0);
  assert.equal(closed.mock.callCount(), 1);
  assert.equal(r.remote.holds(), false);
  assert.equal(await holderOnDisk(), undefined);
});

describe('RemoteSwitch: turning on and off', () => {
  it('turns on: the holder file names this window, the switch is remembered, keep-awake looks again', async () => {
    const r = rig();
    assert.deepEqual(await r.remote.turnOn(), { ok: true });
    assert.equal(r.remote.holds(), true);
    assert.equal((await holderOnDisk())?.windowId, ME.windowId);
    assert.deepEqual(remembered(r), { on: true });
    assert.ok(r.keeperChecks > 0);
  });

  it('asks for a pass when the link comes back, and not when it only warns', async () => {
    const r = rig();
    assert.deepEqual(await r.remote.turnOn(), { ok: true });
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    r.messenger.link({ kind: 'connected' });
    await settle();
    const changes = r.changes;
    r.messenger.link({ kind: 'connected', warning: 'another client' });
    await settle();
    assert.equal(r.changes, changes, 'a warning is no return');
    r.messenger.link({ kind: 'reconnecting', reason: 'dropped' });
    await settle();
    r.messenger.link({ kind: 'connected' });
    await settle();
    assert.equal(r.changes, changes + 1);
    await r.remote.turnOff();
  });

  it('a build that fails releases the holder it took, and says why', async () => {
    const r = rig();
    r.build = () => Promise.resolve({ ok: false, reason: 'the messenger would not build' });
    const turned = await r.remote.turnOn();
    assert.deepEqual(turned, { ok: false, reason: 'the messenger would not build' });
    assert.equal(r.remote.holds(), false);
    assert.equal(await holderOnDisk(), undefined);
    const view = await r.remote.view();
    assert.equal(view.refused?.reason, 'the messenger would not build');
  });

  it('a messenger whose connect throws is refused, and the holder released', async () => {
    const r = rig();
    const messenger = fake.fakeMessenger({ credentials: { token: SECRET } });
    r.build = () =>
      Promise.resolve({
        ok: true,
        messenger: {
          ...messenger,
          connect: () => {
            throw new Error('no socket');
          }
        }
      });
    const turned = await r.remote.turnOn();
    assert.deepEqual(turned, { ok: false, reason: 'Remote could not start: no socket' });
    assert.equal(r.remote.holds(), false);
    assert.equal(await holderOnDisk(), undefined);
  });

  it('refuses a messenger whose buttons cannot carry a store key, and releases the holder', async () => {
    const r = rig();
    r.build = () =>
      Promise.resolve({ ok: true, messenger: fake.fakeMessenger({ payloadMax: 15 }) });
    const turned = await r.remote.turnOn();
    assert.equal(turned.ok, false);
    assert.match(turned.ok ? '' : (turned.reason ?? ''), /cannot carry Remote’s buttons/);
    assert.equal(r.remote.holds(), false);
    assert.equal(await holderOnDisk(), undefined);
  });

  it('refuses while another window holds Remote, naming it, and leaves its file', async () => {
    const r = rig();
    await heldElsewhere();
    const turned = await r.remote.turnOn();
    assert.equal(turned.ok, false);
    assert.equal(turned.ok ? '' : turned.holder?.windowId, OTHER.windowId);
    assert.equal((await holderOnDisk())?.windowId, OTHER.windowId);
  });

  it('off by a person: the engine stops, the holder goes, the switch is forgotten', async () => {
    const r = rig();
    await r.remote.turnOn();
    await r.remote.turnOff();
    assert.equal(r.remote.holds(), false);
    assert.equal(await holderOnDisk(), undefined);
    assert.deepEqual(remembered(r), { on: false });
    assert.equal((await r.remote.view()).state.kind, 'off');
  });

  it('a holder file taken by another window: off with the reason, forgotten, and the file left to it', async () => {
    const r = rig();
    await r.remote.turnOn();
    await fs.rm(paths.HOLDER_FILE);
    await heldElsewhere();
    await r.remote.pass();
    // The close waits on the switch's chain, where the pass queued its stop,
    // and stamps nothing once the switch is forgotten.
    await r.remote.dispose();
    assert.equal(r.remote.holds(), false);
    assert.deepEqual(remembered(r), { on: false });
    assert.equal((await holderOnDisk())?.windowId, OTHER.windowId);
    assert.ok(r.logs.some((line) => line.includes(link.holderLost({ label: OTHER.label }))));
  });

  it('a close stamps the off-time, keeps the switch, and releases the holder', async () => {
    const r = rig();
    await r.remote.turnOn();
    const before = Date.now();
    await r.remote.dispose();
    const memory = remembered(r);
    assert.equal(memory.on, true);
    assert.ok(memory.offAt !== undefined && memory.offAt >= before);
    assert.equal(await holderOnDisk(), undefined);
  });

  it('drops the catch-up watermark when a person turns it on, and keeps it on a restore', async () => {
    const kept = async () => {
      const text = await fs.readFile(paths.HEARD_FILE, 'utf8').catch(() => undefined);
      return text === undefined ? undefined : (JSON.parse(text) as { at: number }).at;
    };
    const old = Date.now() - 3_600_000;
    await fs.mkdir(paths.REMOTE_DIR, { recursive: true });
    await fs.writeFile(paths.HEARD_FILE, JSON.stringify({ at: old }));
    const restored = rig();
    restored.memory.push(JSON.stringify({ on: true, offAt: Date.now() - 1_000 }));
    await restored.remote.restore();
    assert.equal(restored.remote.holds(), true);
    assert.equal(await kept(), old);
    await restored.remote.turnOff();

    const person = rig();
    await person.remote.turnOn();
    const at = await kept();
    assert.ok(at !== undefined && at > old, `the watermark is now, not ${String(at)}`);
    await person.remote.turnOff();
  });

  it('restores after a reload, and not after a close long ago', async () => {
    const r = rig();
    r.memory.push(JSON.stringify({ on: true, offAt: Date.now() - 1_000 }));
    await r.remote.restore();
    assert.equal(r.remote.holds(), true);
    await r.remote.dispose();

    const late = rig();
    late.memory.push(JSON.stringify({ on: true, offAt: Date.now() - link.RESTORE_MS - 1 }));
    await late.remote.restore();
    assert.equal(late.remote.holds(), false);
    assert.deepEqual(remembered(late), { on: false });
  });

  it('stays off after a crash, and forgets the switch', async () => {
    const r = rig();
    r.memory.push(JSON.stringify({ on: true }));
    await r.remote.restore();
    assert.equal(r.remote.holds(), false);
    assert.deepEqual(remembered(r), { on: false });
  });
});

describe('RemoteSwitch: a refusal and its cause', () => {
  it('pressing off while off clears the refusal drawn', async () => {
    const r = rig();
    r.build = () => Promise.resolve({ ok: false, reason: 'the messenger would not build' });
    await r.remote.turnOn();
    assert.equal((await r.remote.view()).refused?.reason, 'the messenger would not build');
    await r.remote.turnOff();
    assert.equal((await r.remote.view()).refused, undefined);
  });

  it('a refusal for setup goes once the setup is satisfied', async () => {
    const r = rig();
    r.allowlist = [];
    await r.remote.turnOn();
    assert.equal((await r.remote.view()).refused?.reason, 'Remote needs an allowed account first.');
    r.allowlist = [OWNER];
    await r.remote.settingsChanged();
    assert.equal((await r.remote.view()).refused, undefined);
  });

  it('a refusal naming the holder goes once that holder turns off', async () => {
    const r = rig();
    await heldElsewhere();
    await r.remote.turnOn();
    assert.equal((await r.remote.view()).refused?.holder?.label, OTHER.label);
    await holders.releaseHolder(OTHER);
    const view = await r.remote.view();
    assert.equal(view.state.kind, 'off');
    assert.equal(view.refused, undefined);
  });
});

describe('RemoteSwitch: accounts the messenger cannot use', () => {
  it('draws a stored account the rule refuses, and turns on for the one it takes', async () => {
    const r = rig();
    r.allowlist = ['two words', OWNER];
    await r.remote.settingsChanged();
    assert.deepEqual((await r.remote.view()).setup.unusable, [
      {
        account: 'two words',
        problem: { kind: 'refused', reason: 'The test messenger takes an id with no spaces in it.' }
      }
    ]);
    assert.deepEqual(await r.remote.turnOn(), { ok: true });
    await r.remote.turnOff();
  });

  it('refuses to turn on when no stored account can be used', async () => {
    const r = rig();
    r.allowlist = ['two words'];
    await r.remote.turnOn();
    assert.equal(r.remote.holds(), false);
    assert.equal((await r.remote.view()).refused?.reason, 'Remote needs an allowed account first.');
  });
});

describe('RemoteSwitch: the log', () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('redacts a credential in an error the switch or the pass throws', async () => {
    const r = rig();
    r.onIdentity = () => {
      throw new Error(`identity read ${SECRET}`);
    };
    await r.remote.turnOn().catch(() => undefined);
    r.onIdentity = undefined;
    await r.remote.turnOn();
    Object.defineProperty(r, 'own', {
      get: () => {
        throw new Error(`board read ${SECRET}`);
      }
    });
    await r.remote.pass().catch(() => undefined);
    await settled();
    assert.ok(
      r.logs.some((line) => line.includes('identity read …')),
      r.logs.join('\n')
    );
    assert.ok(
      r.logs.some((line) => line.includes('board read …')),
      r.logs.join('\n')
    );
    assert.equal(
      r.logs.some((line) => line.includes(SECRET)),
      false
    );
  });

  it('leaves the Reconciler no failed pass to log raw', async () => {
    const r = rig({ reconciler: true });
    await r.remote.turnOn();
    Object.defineProperty(r, 'own', {
      get: () => {
        throw new Error(`board read ${SECRET}`);
      }
    });
    try {
      assert.ok(r.registration);
      r.registration.requestCheck();
      await within(5_000, () => r.logs.some((line) => line.includes('board read …')));
    } finally {
      await r.remote.dispose();
    }
    assert.ok(
      r.logs.some((line) => line.includes('board read …')),
      r.logs.join('\n')
    );
    assert.equal(
      r.logs.some((line) => line.includes(SECRET)),
      false,
      r.logs.join('\n')
    );
  });

  it('redacts any line a host hands it', async () => {
    const r = rig();
    assert.equal(await r.remote.redact(`settings said ${SECRET}`), 'settings said …');
    assert.equal(await r.remote.redacted(`settings said ${SECRET}`), 'settings said …');
  });

  it('answers nothing to quote when the credentials to redact against cannot be read', async () => {
    const r = rig();
    r.gate = Promise.reject(new Error('keychain locked'));
    assert.equal(await r.remote.redacted('settings.json has errors'), undefined);
  });
});

describe('RemoteSwitch: reaction deadlines', () => {
  it(
    'retries an asynchronously failed reaction without a new event while the main pass is blocked',
    { timeout: 8_000 },
    async () => {
      const r = rig({ reconciler: true });
      const base = r.messenger;
      assert.ok(base.reactions);
      const reactions = base.reactions;
      let attempts = 0;
      let fail = () => {};
      let holdPosts = false;
      let posting = false;
      let releasePost = () => {};
      const messenger: Messenger = {
        ...base,
        reactions: {
          set(message, status, signal) {
            attempts++;
            if (attempts === 1)
              return new Promise<void>((_resolve, reject) => {
                fail = () => reject(new Error('reaction connection dropped'));
              });
            return reactions.set(message, status, signal);
          }
        },
        post(place, notice) {
          if (!holdPosts) return base.post(place, notice);
          posting = true;
          return new Promise((resolve, reject) => {
            releasePost = () => {
              posting = false;
              void base.post(place, notice).then(resolve, reject);
            };
          });
        }
      };
      r.build = () => Promise.resolve({ ok: true, messenger });
      r.claims = [claim];
      try {
        assert.deepEqual(await r.remote.turnOn(), { ok: true });
        const event = base.say(OWNER, 'tidy the docs please');
        assert.ok(event && event.kind === 'message');
        await r.remote.tick();
        await within(1_000, () => attempts === 1);
        await r.remote.pass();
        assert.equal(attempts, 1, 'the effect is pending when the pass schedules its deadlines');

        holdPosts = true;
        r.own = [
          {
            ...ownSession(7301, { status: 'waiting' }),
            pending: [{ requestId: 'permission', toolName: 'Write', ask: false }]
          }
        ];
        assert.ok(r.registration, 'the fixture retains the main pass registration');
        r.registration.requestCheck();
        await within(1_000, () => posting);
        fail();
        await within(4_000, () =>
          base
            .reactionEffects()
            .some((effect) => effect.message === event.ref && effect.status === 'queued')
        );
        assert.equal(
          attempts,
          2,
          'the retry deadline runs with no further session change or manual check'
        );
        assert.equal(posting, true, 'the main pass remains blocked throughout reaction recovery');
      } finally {
        fail();
        holdPosts = false;
        releasePost();
        await r.remote.dispose();
      }
    }
  );
  it('a reaction-only retry reads no process table', { timeout: 8_000 }, async () => {
    const r = rig({ reconciler: true });
    const base = r.messenger;
    assert.ok(base.reactions);
    const reactions = base.reactions;
    let failing = true;
    let attempts = 0;
    const messenger: Messenger = {
      ...base,
      reactions: {
        set(message, status, signal) {
          attempts++;
          if (failing) return Promise.reject(new Error('reaction connection dropped'));
          return reactions.set(message, status, signal);
        }
      }
    };
    r.build = () => Promise.resolve({ ok: true, messenger });
    r.claims = [claim];
    try {
      assert.deepEqual(await r.remote.turnOn(), { ok: true });
      const event = base.say(OWNER, 'tidy the docs please');
      assert.ok(event && event.kind === 'message');
      await r.remote.tick();
      await within(1_000, () => attempts > 0);
      await r.remote.pass();
      const reads = r.processReads;
      failing = false;
      await within(4_000, () =>
        base.reactionEffects().some((effect) => effect.message === event.ref)
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(r.processReads, reads, 'the retry ran without a machine pass');
    } finally {
      await r.remote.dispose();
    }
  });
});

describe('RemoteSwitch: a process table that failed', () => {
  it('the holder keeps Remote on through an empty table: its own file is read against itself', async () => {
    const r = rig();
    await r.remote.turnOn();
    r.starts = new Map();
    await r.remote.pass();
    // A table that has lost this host's row says nothing against it either.
    r.starts = new Map([[OTHER.pid, OTHER.startedAt]]);
    await r.remote.pass();
    await r.remote.view();
    assert.equal(r.remote.holds(), true);
    assert.equal((await holderOnDisk())?.windowId, ME.windowId);
    assert.deepEqual(remembered(r), { on: true });
  });

  it('a turn-on over an empty table refuses, naming the holder, and leaves its file', async () => {
    const r = rig();
    await heldElsewhere();
    r.starts = new Map();
    const turned = await r.remote.turnOn();
    assert.equal(turned.ok ? '' : turned.holder?.windowId, OTHER.windowId);
    assert.equal((await holderOnDisk())?.windowId, OTHER.windowId);
  });

  it('a pass over an empty table changes nothing: no other window’s request settles', async () => {
    const r = rig();
    const waiting = ownSession(7101, { status: 'waiting', windowId: OTHER.windowId });
    const ask = { requestId: 'p1', toolName: 'Bash', ask: false };
    r.published.set(7101, { schema: 1, session: waiting.session, pending: [ask], queued: [] });
    r.starts.set(7101, waiting.session.startedAt);
    await r.remote.turnOn();
    assert.deepEqual(
      r.messenger.posts().map((p) => p.notice.kind),
      ['permission']
    );
    const full = r.starts;
    r.starts = new Map();
    await r.remote.pass();
    r.starts = full;
    await r.remote.pass();
    assert.deepEqual(r.messenger.settles(), []);
    assert.equal(r.messenger.posts().length, 1);
  });

  it('a window off Remote keeps drawing the holder through an empty table', async () => {
    const r = rig();
    await heldElsewhere();
    assert.equal((await r.remote.view()).state.kind, 'elsewhere');
    r.starts = new Map();
    assert.equal((await r.remote.view()).state.kind, 'elsewhere');
  });
});

describe('RemoteSwitch: the first pass', () => {
  /** A new job from the phone, routed once the engine has taken it. */
  async function job(r: Rig, text: string): Promise<void> {
    r.messenger.say(OWNER, text);
    await r.remote.tick();
    await chooseDefault(r);
  }

  it('is run before the messenger connects, so a job meets the open windows', async () => {
    const r = rig();
    r.claims = [claim];
    await r.remote.turnOn();
    await job(r, 'tidy the docs please');
    assert.deepEqual(
      r.startCalls.map((start) => start.cwd),
      [APP]
    );
    assert.ok(!r.messenger.posts().some((p) => p.notice.body === words.noFolderNotice.body));
  });

  it('is run again before a rebuilt engine connects', async () => {
    const r = rig();
    r.claims = [claim];
    await r.remote.turnOn();
    await r.remote.settingsChanged();
    assert.equal(r.remote.holds(), true);
    await job(r, 'tidy the docs please');
    assert.equal(r.startCalls.length, 1);
    assert.ok(!r.messenger.posts().some((p) => p.notice.body === words.noFolderNotice.body));
  });
});

describe('RemoteSwitch: a first pass whose post hangs', () => {
  /** The fake, but every post waits until the messenger is closed. */
  function hanging(r: Rig): { messenger: Messenger; posting: () => boolean } {
    const base = r.messenger;
    const waiting: ((err: Error) => void)[] = [];
    const messenger: Messenger = {
      id: base.id,
      text: base.text,
      buttons: base.buttons,
      connect: (sink) => base.connect(sink),
      post: () => new Promise((_, reject) => waiting.push(reject)),
      close: () => {
        for (const reject of waiting.splice(0)) reject(new Error('closed'));
        base.close();
      }
    };
    return { messenger, posting: () => waiting.length > 0 };
  }

  const asking = (r: Rig) => {
    const ask = { requestId: 'p1', toolName: 'Bash', ask: false };
    r.own = [{ ...ownSession(7201, { status: 'waiting' }), pending: [ask] }];
  };

  /** `done`, or 'held' once `ms` (a duration) has passed. */
  const inTime = <T>(done: Promise<T>, ms = 2_000) =>
    Promise.race([done, new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), ms))]);

  it('holds no turn-off: the off aborts it, then releases the holder', async () => {
    const r = rig();
    const hung = hanging(r);
    r.build = () => Promise.resolve({ ok: true, messenger: hung.messenger });
    asking(r);
    const turning = r.remote.turnOn();
    await within(1_000, hung.posting);
    assert.ok(hung.posting(), 'the first pass is posting');
    assert.notEqual(await inTime(r.remote.turnOff()), 'held');
    await turning;
    assert.equal(r.remote.holds(), false);
    assert.equal(await holderOnDisk(), undefined);
    assert.deepEqual(remembered(r), { on: false });
  });

  it('has the switch remembered before it, so a close meanwhile stamps it', async () => {
    const r = rig();
    const hung = hanging(r);
    r.build = () => Promise.resolve({ ok: true, messenger: hung.messenger });
    asking(r);
    const turning = r.remote.turnOn();
    await within(1_000, hung.posting);
    assert.deepEqual(remembered(r), { on: true });
    await r.remote.turnOff();
    await turning;
  });

  it('holds no close either', async () => {
    const r = rig();
    const hung = hanging(r);
    r.build = () => Promise.resolve({ ok: true, messenger: hung.messenger });
    asking(r);
    const turning = r.remote.turnOn();
    await within(1_000, hung.posting);
    assert.notEqual(await inTime(r.remote.dispose()), 'held');
    await turning;
    assert.equal(await holderOnDisk(), undefined);
  });
});

describe('RemoteSwitch: a restore that is refused', () => {
  it('forgets the switch, so a later reload cannot turn Remote on unasked', async () => {
    const r = rig();
    r.memory.push(JSON.stringify({ on: true, offAt: Date.now() - 1_000 }));
    await heldElsewhere();
    await r.remote.restore();
    assert.equal(r.remote.holds(), false);
    assert.deepEqual(remembered(r), { on: false });
    await r.remote.dispose();
    assert.deepEqual(remembered(r), { on: false }, 'a close stamps nothing to restore');
  });

  it('keeps the switch through a refusal that may pass, for the next start to try', async () => {
    const r = rig();
    r.memory.push(JSON.stringify({ on: true, offAt: Date.now() - 1_000 }));
    r.unreadable = true;
    await r.remote.restore();
    assert.equal(r.remote.holds(), false);
    assert.equal(remembered(r).on, true);
    await r.remote.dispose();
    const memory = remembered(r);
    assert.ok(memory.on && memory.offAt !== undefined, 'the close stamps it again');
  });

  it('keeps the switch through a restore that throws', async () => {
    const r = rig();
    r.memory.push(JSON.stringify({ on: true, offAt: Date.now() - 1_000 }));
    r.onIdentity = () => {
      throw new Error('the identity read failed');
    };
    await r.remote.restore();
    assert.equal(r.remote.holds(), false);
    assert.equal(remembered(r).on, true);
  });
});

describe('RemoteSwitch: one switch at a time', () => {
  it('a refusal is drawn before the next turn-on runs, never over a Remote that came on', async () => {
    const r = rig();
    await heldElsewhere();
    let open = () => {};
    // The refusal reads the credentials to redact its reason against; that
    // read is held, so the refusal is still being drawn.
    r.onIdentity = () => {
      r.onIdentity = undefined;
      r.gate = new Promise((resolve) => (open = resolve));
    };
    const refused = r.remote.turnOn();
    await within(1_000, () => r.gated === true);
    await fs.rm(paths.HOLDER_FILE);
    const allowed = r.remote.turnOn();
    open();
    assert.equal((await refused).ok, false);
    assert.deepEqual(await allowed, { ok: true });
    // Anything still landing from the refusal lands now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const view = await r.remote.view();
    assert.equal(view.refused, undefined);
    assert.equal(view.state.kind, 'connected');
  });
});

describe('RemoteSwitch: a rebuild', () => {
  it('keeps the board it had seen, so a finish since the last pass is posted', async () => {
    const r = rig();
    r.own = [ownSession(7001, { status: 'busy', turnsEnded: 0 })];
    await r.remote.turnOn();
    r.own = [ownSession(7001, { status: 'idle', turnsEnded: 1 })];
    await r.remote.settingsChanged();
    await r.remote.pass();
    const finished = r.messenger.posts().filter((p) => p.notice.kind === 'finished');
    assert.equal(finished.length, 1);
  });

  it('keeps the roots it started, so a reply before one reaches the board starts no second', async () => {
    const r = rig();
    r.claims = [claim];
    r.startAs = { ok: true, pid: 7002, startedAt: T0 + 2, brand: 'claude', sessionId: 's7002' };
    await r.remote.turnOn();
    r.messenger.say(OWNER, 'tidy the docs please');
    await r.remote.tick();
    await chooseDefault(r);
    const started = r.messenger.posts().find((p) => p.notice.kind === 'started');
    assert.ok(started);
    await r.remote.settingsChanged();
    r.messenger.say(OWNER, 'and the readme', { in: started.posted.anchor });
    await r.remote.tick();
    assert.equal(r.startCalls.length, 1);
  });
});

describe('RemoteSwitch: the close', () => {
  it('every remember lands in order, so a turn-on finishing behind the close keeps its stamp', async () => {
    const r = rig();
    let building = false;
    let build = () => {};
    r.build = () => {
      building = true;
      return new Promise(
        (resolve) => (build = () => resolve({ ok: true, messenger: r.messenger }))
      );
    };
    const turned = r.remote.turnOn();
    await within(1_000, () => building);
    const closed = r.remote.dispose();
    build();
    await turned;
    await closed;
    const memory = remembered(r);
    assert.equal(memory.on, true);
    assert.ok(memory.offAt !== undefined, `the stamp was overwritten: ${r.memory.at(-1)}`);
  });
});

/** A session this window drives, as its handle reads. */
function ownSession(pid: number, over: Partial<Session> = {}): OwnSession {
  return {
    session: {
      pid,
      sessionId: `s${pid}`,
      cwd: APP,
      name: `n${pid}`,
      status: 'idle',
      hasCommand: false,
      startedAt: T0 + pid,
      updatedAt: T0,
      transcript: `/t/${pid}.jsonl`,
      source: 'owned',
      windowId: ME.windowId,
      ...over
    },
    pending: []
  };
}

/** Polls `done` every 10 ms (an interval) for up to `ms` (a duration), and
 *  fails the test if it never holds. */
async function within(ms: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) assert.fail(`not true within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
