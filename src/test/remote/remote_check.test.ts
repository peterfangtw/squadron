import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountRule, Credentials, MessengerEntry, SetupCheck } from '../../core/bridge/port';
import * as check from '../../core/remote/check';

const OK: SetupCheck = { kind: 'ok', facts: [{ label: 'Workspace', value: 'Acme' }] };
const FAILED: SetupCheck = { kind: 'setup', step: 1, reason: 'The bot token was refused.' };
/** Any account as it stands: the runner never asks the rule. */
const ANY: AccountRule = {
  refuse: () => undefined,
  refuseSpace: () => undefined,
  sender: (account) => account
};

/** One check the test settles by hand, and the signal it was handed. */
type Asked = { signal: AbortSignal; settle(result: SetupCheck): void; fail(err: unknown): void };

/** A runner over an entry whose checks the test settles, with what it fired. */
function rig(
  options: {
    id?: string;
    noCheck?: boolean;
    credentials?: () => Credentials;
    /** The space setting, which an ok check may fill. */
    space?: { value?: string };
    accounts?: AccountRule;
  } = {}
) {
  const asked: Asked[] = [];
  let now = 1_000;
  let changes = 0;
  const entry = (id: string): MessengerEntry => ({
    id,
    label: id,
    listed: true,
    setup: { fields: [{ key: 'token', label: 'Token' }], sender: { help: '' } },
    accounts: options.accounts ?? ANY,
    create: () => ({ ok: false, reason: 'not here' }),
    ...(options.noCheck
      ? {}
      : {
          check: (_credentials: Credentials, signal: AbortSignal) =>
            new Promise<SetupCheck>((settle, fail) => asked.push({ signal, settle, fail }))
        })
  });
  let id = options.id ?? 'chat';
  const runner = new check.CheckRunner({
    entry: () => entry(id),
    credentials: () => Promise.resolve(options.credentials?.() ?? { token: 'tok-1234' }),
    ...(options.space
      ? {
          space: {
            read: () => options.space?.value,
            fill: (value: string) => {
              if (options.space) options.space.value = value;
              return Promise.resolve();
            }
          }
        }
      : {}),
    clock: () => now,
    changed: () => {
      changes += 1;
    }
  });
  return {
    runner,
    asked,
    changes: () => changes,
    tick: (ms: number) => {
      now += ms;
    },
    select: (next: string) => {
      id = next;
    }
  };
}

/** Lets a check's credential read and its settle run through. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CheckRunner', () => {
  it('has never checked until asked', () => {
    const { runner, changes } = rig();
    assert.deepEqual(runner.state(), { kind: 'never' });
    assert.equal(changes(), 0);
  });

  it('is checking while the messenger is asked, then holds its result and when', async () => {
    const { runner, asked, changes, tick } = rig();
    const done = runner.start();
    assert.deepEqual(runner.state(), { kind: 'checking' });
    assert.equal(changes(), 1);
    await settled();
    tick(500);
    asked[0]?.settle(OK);
    await done;
    assert.deepEqual(runner.state(), { kind: 'result', result: OK, at: 1_500 });
    assert.equal(changes(), 2);
  });

  it('ignores a start while one is in flight', async () => {
    const { runner, asked, changes } = rig();
    const first = runner.start();
    await runner.start();
    await settled();
    assert.equal(asked.length, 1);
    assert.equal(changes(), 1);
    asked[0]?.settle(OK);
    await first;
  });

  it('runs again once the last one has finished', async () => {
    const { runner, asked } = rig();
    const first = runner.start();
    await settled();
    asked[0]?.settle(FAILED);
    await first;
    const second = runner.start();
    assert.deepEqual(runner.state(), { kind: 'checking' });
    await settled();
    asked[1]?.settle(OK);
    await second;
    const state = runner.state();
    assert.deepEqual(state.kind === 'result' ? state.result : undefined, OK);
  });

  it('forgets a result when the credentials change', async () => {
    const { runner, asked, changes } = rig();
    const done = runner.start();
    await settled();
    asked[0]?.settle(OK);
    await done;
    runner.invalidate();
    assert.deepEqual(runner.state(), { kind: 'never' });
    assert.equal(changes(), 3);
  });

  it('says nothing when the credentials change with nothing to forget', () => {
    const { runner, changes } = rig();
    runner.invalidate();
    assert.deepEqual(runner.state(), { kind: 'never' });
    assert.equal(changes(), 0);
  });

  it('aborts the check in flight when the credentials change, and drops its finish', async () => {
    const { runner, asked } = rig();
    const done = runner.start();
    await settled();
    runner.invalidate();
    assert.equal(asked[0]?.signal.aborted, true);
    assert.deepEqual(runner.state(), { kind: 'never' });
    asked[0]?.settle(OK);
    await done;
    assert.deepEqual(runner.state(), { kind: 'never' });
  });

  it('keeps a newer check checking when an older one it overtook finishes', async () => {
    const { runner, asked } = rig();
    const a = runner.start();
    await settled();
    runner.invalidate();
    const b = runner.start();
    await settled();
    assert.equal(asked.length, 2);
    asked[0]?.settle(FAILED);
    await a;
    assert.deepEqual(runner.state(), { kind: 'checking' });
    asked[1]?.settle(OK);
    await b;
    assert.deepEqual(runner.state(), { kind: 'result', result: OK, at: 1_000 });
  });

  it('drops a check whose credential read a change overtook', async () => {
    let reads = 0;
    const { runner, asked } = rig({
      credentials: () => {
        reads += 1;
        return { token: `tok-${reads}` };
      }
    });
    const done = runner.start();
    runner.invalidate();
    await done;
    assert.equal(asked.length, 0);
    assert.deepEqual(runner.state(), { kind: 'never' });
  });

  it('treats a messenger change as a credentials change', async () => {
    const { runner, asked, select } = rig();
    const done = runner.start();
    await settled();
    select('other');
    runner.invalidate();
    assert.equal(asked[0]?.signal.aborted, true);
    asked[0]?.settle(OK);
    await done;
    assert.deepEqual(runner.state(), { kind: 'never' });
  });

  it('forgets a result only for a secret of the chosen messenger', async () => {
    let token = 'tok-1';
    const { runner, asked } = rig({ credentials: () => ({ token }) });
    const done = runner.start();
    await settled();
    asked[0]?.settle(OK);
    await done;
    token = 'tok-2';
    await runner.secretChanged('squadron.remote.other.token');
    assert.equal(runner.state().kind, 'result');
    await runner.secretChanged('squadron.remote.chat.token');
    assert.deepEqual(runner.state(), { kind: 'never' });
  });

  it('does nothing for a messenger with no check', async () => {
    const { runner, changes } = rig({ noCheck: true });
    await runner.start();
    assert.deepEqual(runner.state(), { kind: 'never' });
    assert.equal(changes(), 0);
  });

  it('reads a credential store it cannot read as unreachable, blaming no step', async () => {
    const asked: number[] = [];
    const runner = new check.CheckRunner({
      entry: () => ({
        id: 'chat',
        label: 'Chat',
        listed: true,
        setup: { fields: [], sender: { help: '' } },
        accounts: ANY,
        create: () => ({ ok: false, reason: '' }),
        check: () => {
          asked.push(1);
          return Promise.resolve(OK);
        }
      }),
      credentials: () => Promise.reject(new Error('keychain locked')),
      clock: () => 7,
      changed: () => undefined
    });
    await runner.start();
    const state = runner.state();
    assert.equal(state.kind === 'result' ? state.result.kind : state.kind, 'unreachable');
    assert.deepEqual(asked, []);
  });

  it('settles a check that broke its promise not to reject, rather than checking forever', async () => {
    const { runner, asked } = rig();
    const done = runner.start();
    await settled();
    asked[0]?.fail(new Error('boom'));
    await done;
    const state = runner.state();
    assert.equal(state.kind === 'result' ? state.result.kind : state.kind, 'unreachable');
    const again = runner.start();
    assert.deepEqual(runner.state(), { kind: 'checking' });
    await settled();
    asked[1]?.settle(OK);
    await again;
  });

  it('redacts every stored credential out of what the check said', async () => {
    const { runner, asked } = rig({ credentials: () => ({ token: 'tok-SENTINEL-99' }) });
    const done = runner.start();
    await settled();
    asked[0]?.settle({ kind: 'unreachable', reason: 'Refused tok-SENTINEL-99 outright.' });
    await done;
    const failed = runner.state();
    assert.equal(JSON.stringify(failed).includes('SENTINEL'), false);
    const next = runner.start();
    await settled();
    asked[1]?.settle({ kind: 'ok', facts: [{ label: 'Bot', value: 'tok-SENTINEL-99' }] });
    await next;
    assert.equal(JSON.stringify(runner.state()).includes('SENTINEL'), false);
  });

  it('aborts on dispose, drops the finish, and starts nothing after', async () => {
    const { runner, asked, changes } = rig();
    const done = runner.start();
    await settled();
    runner.dispose();
    assert.equal(asked[0]?.signal.aborted, true);
    asked[0]?.settle(OK);
    await done;
    await runner.start();
    assert.equal(asked.length, 1);
    assert.equal(changes(), 1);
  });
});

/**
 * A runner over a credential store the test writes, two fields, driven as
 * `host/remote.ts` drives it: a paste stores, then invalidates and starts;
 * the store's change event arrives whenever the test says, or never.
 */
function stored(initial: Credentials = { bot: 'bot-1', app: 'app-1' }) {
  const asked: (Asked & { credentials: Credentials })[] = [];
  const store: Record<string, string> = { ...initial };
  /** The next read, held: it takes the store as it is now and answers on
   *  release. */
  let holding: ((release: () => void) => void) | undefined;
  const runner = new check.CheckRunner({
    entry: () => ({
      id: 'chat',
      label: 'Chat',
      listed: true,
      setup: {
        fields: [
          { key: 'bot', label: 'Bot' },
          { key: 'app', label: 'App' }
        ],
        sender: { help: '' }
      },
      accounts: ANY,
      create: () => ({ ok: false, reason: 'not here' }),
      check: (credentials: Credentials, signal: AbortSignal) =>
        new Promise<SetupCheck>((settle, fail) => asked.push({ credentials, signal, settle, fail }))
    }),
    credentials: () => {
      const read = { ...store };
      const hold = holding;
      holding = undefined;
      if (!hold) return Promise.resolve(read);
      return new Promise<Credentials>((answer) => hold(() => answer(read)));
    },
    clock: () => 1_000,
    changed: () => undefined
  });
  return {
    runner,
    asked,
    /** Holds the next credential read until the returned release. */
    holdNextRead: (): (() => void) => {
      let release: () => void = () => undefined;
      holding = (answer) => {
        release = answer;
      };
      return () => release();
    },
    /** Another window's store, or this one's before the event. */
    write: (key: string, value: string) => {
      store[key] = value;
    },
    /** What `setField` does once its store has resolved. */
    paste: (key: string, value: string) => {
      store[key] = value;
      runner.invalidate();
      return runner.start();
    },
    event: (key: string) => runner.secretChanged(`squadron.remote.chat.${key}`)
  };
}

/** A runner holding an ok result under the store's first values. */
async function checked() {
  const rig = stored();
  const done = rig.runner.start();
  await settled();
  rig.asked[0]?.settle(OK);
  await done;
  return rig;
}

describe('CheckRunner: the space an ok check found', () => {
  const FOUND: SetupCheck = { ...OK, space: 'T0FOUND01' };

  async function run(result: SetupCheck, space: { value?: string }, accounts?: AccountRule) {
    const { runner, asked } = rig({ space, ...(accounts ? { accounts } : {}) });
    const done = runner.start();
    await settled();
    asked[0]?.settle(result);
    await done;
    return runner;
  }

  it('fills the space setting when it is empty', async () => {
    const space: { value?: string } = {};
    await run(FOUND, space);
    assert.equal(space.value, 'T0FOUND01');
  });

  it('never overwrites a space already set, which is the reader’s', async () => {
    const space = { value: 'T0MINE001' };
    await run(FOUND, space);
    assert.equal(space.value, 'T0MINE001');
  });

  it('fills nothing from a check that found no space, or failed', async () => {
    for (const result of [OK, FAILED]) {
      const space: { value?: string } = {};
      await run(result, space);
      assert.equal(space.value, undefined, result.kind);
    }
  });

  it('fills nothing the messenger’s own rule refuses', async () => {
    const space: { value?: string } = {};
    await run(FOUND, space, { ...ANY, refuseSpace: () => 'not a space' });
    assert.equal(space.value, undefined);
  });

  it('holds the space it found in its result', async () => {
    const runner = await run(FOUND, { value: 'T0MINE001' });
    const state = runner.state();
    assert.equal(
      state.kind === 'result' && state.result.kind === 'ok' && state.result.space,
      'T0FOUND01'
    );
  });
});

describe('CheckRunner: a credential change event', () => {
  it('leaves a paste its own check when the store event lands after the store', async () => {
    const { runner, asked, paste, event } = await checked();
    const done = paste('bot', 'bot-2');
    await settled();
    await event('bot');
    assert.equal(asked[1]?.signal.aborted, false);
    asked[1]?.settle(OK);
    await done;
    assert.deepEqual(runner.state(), { kind: 'result', result: OK, at: 1_000 });
  });

  it('forgets the old result when the store event lands before the store resolves', async () => {
    const { runner, asked, write, paste, event } = await checked();
    write('bot', 'bot-2');
    await event('bot');
    assert.deepEqual(runner.state(), { kind: 'never' });
    const done = paste('bot', 'bot-2');
    await settled();
    asked[1]?.settle(OK);
    await done;
    assert.equal(runner.state().kind, 'result');
  });

  it('ends two overlapping pastes on the second check, whenever their events land', async () => {
    const { runner, asked, paste, event } = await checked();
    const first = paste('bot', 'bot-2');
    await settled();
    const second = paste('app', 'app-2');
    await settled();
    assert.equal(asked[1]?.signal.aborted, true);
    await event('bot');
    await event('app');
    assert.equal(asked[2]?.signal.aborted, false);
    assert.deepEqual(asked[2]?.credentials, { bot: 'bot-2', app: 'app-2' });
    asked[1]?.settle(OK);
    asked[2]?.settle(OK);
    await Promise.all([first, second]);
    assert.deepEqual(runner.state(), { kind: 'result', result: OK, at: 1_000 });
  });

  it('still hears a later change after a store that fired no event', async () => {
    const { runner, asked, write, paste, event } = await checked();
    const done = paste('bot', 'bot-2');
    await settled();
    asked[1]?.settle(OK);
    await done;
    write('bot', 'bot-3');
    await event('bot');
    assert.deepEqual(runner.state(), { kind: 'never' });
  });

  it("forgets the result on another window's write of a different value", async () => {
    const { runner, write, event } = await checked();
    write('app', 'app-9');
    await event('app');
    assert.deepEqual(runner.state(), { kind: 'never' });
  });

  it("keeps the result through another window's write of the same value", async () => {
    const { runner, event } = await checked();
    await event('bot');
    assert.deepEqual(runner.state(), { kind: 'result', result: OK, at: 1_000 });
  });

  it("aborts a check in flight on another window's write", async () => {
    const { runner, asked, write, event } = stored();
    const done = runner.start();
    await settled();
    write('bot', 'bot-9');
    await event('bot');
    assert.equal(asked[0]?.signal.aborted, true);
    asked[0]?.settle(OK);
    await done;
    assert.deepEqual(runner.state(), { kind: 'never' });
  });

  it('compares against the check that runs once the event has read, not the one it found', async () => {
    const { runner, asked, write, event } = await checked();
    write('bot', 'bot-2');
    const heard = event('bot');
    const pressed = runner.start();
    await heard;
    await settled();
    assert.equal(asked[1]?.signal.aborted, false);
    asked[1]?.settle(OK);
    await pressed;
    assert.equal(runner.state().kind, 'result');
  });

  it("leaves a paste its check when another window's slower event read the value before it", async () => {
    const { runner, asked, write, paste, event, holdNextRead } = await checked();
    write('bot', 'bot-2');
    const release = holdNextRead();
    const heard = event('bot');
    const pasted = paste('bot', 'bot-3');
    await settled();
    release();
    await heard;
    await event('bot');
    assert.deepEqual(asked[1]?.credentials, { bot: 'bot-3', app: 'app-1' });
    assert.equal(asked[1]?.signal.aborted, false, 'a stale event aborted the paste check');
    asked[1]?.settle(OK);
    await pasted;
    assert.equal(runner.state().kind, 'result');
  });
});
