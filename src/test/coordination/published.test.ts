import * as platform from '../../core/platform';
import * as win32 from '../../core/platform/files/win32';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { disposeHome, tempHome, testPlatform } from '../helpers';
import * as fixture from '../incoming_helpers';
import type { PublishedLive } from '../../core/published';
import type { Session } from '../../core/model';

type Published = typeof import('../../core/published');

let home: string;
let published: Published;

const dir = () => path.join(home, '.squadron', 'live');

before(async () => {
  home = await tempHome();
  published = await import('../../core/published');
});

after(async () => {
  await disposeHome(home);
});

const session = (over: Partial<Session> = {}): Session => ({
  pid: 42,
  sessionId: 'sid',
  cwd: '/work/app',
  name: 'app-3f',
  status: 'busy',
  hasCommand: false,
  startedAt: 1000,
  updatedAt: 2000,
  transcript: '/tmp/said.jsonl',
  windowId: 'window-b',
  source: 'owned',
  ...over
});

const record = (over: Partial<PublishedLive> = {}): PublishedLive => ({
  schema: 1,
  session: session(),
  pending: [],
  queued: [],
  ...over
});

/** Straight past `publishLive`, for the shapes it would never write itself. */
async function put(pid: number, body: unknown): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(
    path.join(dir(), `${pid}.json`),
    typeof body === 'string' ? body : JSON.stringify(body)
  );
}

async function reset(): Promise<void> {
  await fs.rm(dir(), { recursive: true, force: true });
}

describe('the published live half', () => {
  it('flushes required publication before replacing and syncing its directory', async (context) => {
    await reset();
    const calls: string[] = [];
    const open = fs.open;
    context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      context.mock.method(
        handle,
        'writeFile',
        async (...values: Parameters<typeof handle.writeFile>) => {
          calls.push('write');
          await write(...values);
        }
      );
      context.mock.method(handle, 'sync', async () => {
        calls.push('file sync');
        await sync();
      });
      context.mock.method(handle, 'close', async () => {
        calls.push('file close');
        await close();
      });
      return handle;
    });
    const replace = platform.files.replace.bind(platform.files);
    context.mock.method(platform.files, 'replace', async (...args: Parameters<typeof replace>) => {
      calls.push('replace');
      await replace(...args);
    });
    context.mock.method(platform.files, 'syncDirectory', async (directory: string) => {
      calls.push('directory sync');
      assert.equal(directory, dir());
      assert.equal(
        JSON.parse(await fs.readFile(path.join(directory, '42.json'), 'utf8')).schema,
        1
      );
    });
    assert.equal(await published.publishLive(record(), true), true);
    assert.deepEqual(calls, ['write', 'file sync', 'file close', 'replace', 'directory sync']);
  });

  for (const stage of ['file sync', 'replace', 'directory sync'] as const) {
    it(`reports required publication ${stage} failure and removes its temporary file`, async (context) => {
      await reset();
      const failure = Object.assign(new Error(stage), { code: 'EPERM' });
      const open = fs.open;
      let closed = false;
      context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const close = handle.close.bind(handle);
        if (stage === 'file sync')
          context.mock.method(handle, 'sync', () => Promise.reject(failure));
        context.mock.method(handle, 'close', async () => {
          await close();
          closed = true;
        });
        return handle;
      });
      const replace = platform.files.replace.bind(platform.files);
      let replacements = 0;
      context.mock.method(
        platform.files,
        'replace',
        async (...args: Parameters<typeof replace>) => {
          replacements++;
          if (stage === 'replace') throw failure;
          await replace(...args);
        }
      );
      let directories = 0;
      context.mock.method(platform.files, 'syncDirectory', () => {
        directories++;
        return Promise.reject(failure);
      });
      assert.equal(await published.publishLive(record(), true), false);
      assert.equal(closed, true);
      assert.equal(replacements, stage === 'file sync' ? 0 : 1);
      assert.equal(directories, stage === 'directory sync' ? 1 : 0);
      assert.deepEqual(await fs.readdir(dir()), stage === 'directory sync' ? ['42.json'] : []);
    });
  }

  it('attempts heartbeat publication once on replacement denial', async (context) => {
    let attempts = 0;
    const backend = win32.files({
      open: () => {
        throw new Error('unexpected directory open');
      },
      rename: () => {
        attempts++;
        return Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' }));
      }
    });
    const replace = context.mock.method(
      platform.files,
      'replace',
      async (source: string, destination: string) => {
        await backend.replace(source, destination);
      }
    );
    for (const required of [false, true]) {
      assert.equal(await published.publishLive(record(), required), false);
    }
    assert.equal(attempts, 2);
    assert.equal(replace.mock.callCount(), 2);
  });

  it('keeps stopping conversation evidence separate from driveable live records', async () => {
    await reset();
    const stopping = record({ stopping: { members: [{ pid: 77, startedAt: 3000 }] } });
    await published.publishLive(stopping, true);
    const records = await published.readPublished();
    const table: import('../../core/scan').ProcessTable = {
      complete: true,
      starts: new Map([[77, 3000]]),
      parents: new Map(),
      groups: new Map(),
      shellParents: new Set(),
      claude: new Map(),
      codex: new Map(),
      grok: new Map()
    };
    assert.equal(published.liveRecords(records, new Map([[42, 1000]])).length, 0);
    assert.equal(published.stoppingConversations(records, table).length, 1);
    table.starts.set(77, 4000);
    assert.equal(published.stoppingConversations(records, table).length, 0);
    assert.equal(published.stoppingConversations(records, { ...table, complete: false }).length, 1);
  });

  describe('conversationOwner', () => {
    const table = (
      over: Partial<import('../../core/scan').ProcessTable> = {}
    ): import('../../core/scan').ProcessTable => ({
      complete: true,
      startSource: 'win32-filetime-ms-v1',
      starts: new Map([[42, 1000]]),
      parents: new Map(),
      groups: new Map(),
      shellParents: new Set(),
      claude: new Map(),
      codex: new Map(),
      grok: new Map(),
      ...over
    });
    const read = (
      found: ReadonlyMap<number, PublishedLive>,
      over: Partial<import('../../core/published').PublishedEvidence> = {}
    ) => ({ records: found, listed: true, unreadable: new Set<number>(), ...over });
    const records = read(new Map([[42, record()]]));
    const sid = (s: Session) => s.sessionId === 'sid';
    it('is held while a complete table has the exact start of the record', () => {
      assert.equal(published.conversationOwner(records, table(), sid), 'held');
    });
    it('is free only when a complete table proves the process gone', () => {
      assert.equal(published.conversationOwner(records, table({ starts: new Map() }), sid), 'free');
      assert.equal(
        published.conversationOwner(records, table({ starts: new Map([[42, 60_000]]) }), sid),
        'free'
      );
    });
    it('is unknown when an incomplete table is missing the row', () => {
      assert.equal(
        published.conversationOwner(records, table({ complete: false, starts: new Map() }), sid),
        'unknown'
      );
    });
    it('is unknown on a failed read, and on a table from no recognized clock', () => {
      const failed = table({ complete: undefined, startSource: undefined, starts: new Map() });
      assert.equal(published.conversationOwner(records, failed, sid), 'unknown');
      assert.equal(
        published.conversationOwner(
          records,
          table({ startSource: undefined, starts: new Map() }),
          sid
        ),
        'unknown'
      );
    });
    it('is held on an incomplete table that still shows the exact start, or a stopping record', () => {
      assert.equal(published.conversationOwner(records, table({ complete: false }), sid), 'held');
      const stopping = read(
        new Map([[42, record({ stopping: { members: [{ pid: 77, startedAt: 3000 }] } })]])
      );
      assert.equal(
        published.conversationOwner(stopping, table({ complete: false, starts: new Map() }), sid),
        'held'
      );
    });
    it('is free when nothing matches on a complete table', () => {
      assert.equal(
        published.conversationOwner(records, table(), () => false),
        'free'
      );
    });
    it('is unknown when the records could not be listed, on a complete table', () => {
      const unlisted = read(new Map(), { listed: false });
      assert.equal(published.conversationOwner(unlisted, table(), sid), 'unknown');
    });
    it('is unknown while a running pid has a record that could not be read', () => {
      const lost = read(new Map(), { unreadable: new Set([42]) });
      assert.equal(published.conversationOwner(lost, table(), sid), 'unknown');
      // A pid the complete table does not run cannot own a live conversation.
      assert.equal(
        published.conversationOwner(lost, table({ starts: new Map([[43, 1000]]) }), sid),
        'free'
      );
    });
  });

  describe('readPublishedEvidence', () => {
    const table = (pid: number): import('../../core/scan').ProcessTable => ({
      complete: true,
      startSource: 'win32-filetime-ms-v1',
      starts: new Map([[pid, 1000]]),
      parents: new Map(),
      groups: new Map(),
      shellParents: new Set(),
      claude: new Map(),
      codex: new Map(),
      grok: new Map()
    });
    const sid = (s: Session) => s.sessionId === 'sid';

    it('keeps a directory it could not list as unknown, never as no owner', async () => {
      await reset();
      await put(42, record());
      const readdir = fsPromises.readdir;
      const denied = mock.method(fsPromises, 'readdir', (async (
        target: string,
        ...rest: unknown[]
      ) => {
        if (path.resolve(String(target)) === path.resolve(dir()))
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return (readdir as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
      }) as typeof fsPromises.readdir);
      try {
        const evidence = await published.readPublishedEvidence();
        assert.equal(evidence.listed, false);
        assert.equal(published.conversationOwner(evidence, table(42), sid), 'unknown');
      } finally {
        denied.mock.restore();
      }
    });

    it('names a running pid whose record is unreadable or invalid', async () => {
      for (const write of [
        () => fs.mkdir(path.join(dir(), '42.json'), { recursive: true }),
        () => put(42, '{"schema":1,'),
        () => put(42, { ...record(), schema: 2 })
      ]) {
        await reset();
        await fs.mkdir(dir(), { recursive: true });
        await write();
        const evidence = await published.readPublishedEvidence();
        assert.deepEqual([...evidence.unreadable], [42]);
        assert.equal(published.conversationOwner(evidence, table(42), sid), 'unknown');
      }
    });

    it('lets an ordinary complete read with no owner resume', async () => {
      await reset();
      const missing = await published.readPublishedEvidence();
      assert.equal(missing.listed, true);
      assert.equal(published.conversationOwner(missing, table(42), sid), 'free');
      await put(7, record({ session: session({ pid: 7, sessionId: 'other' }) }));
      await fs.writeFile(path.join(dir(), 'notes.txt'), 'not a record');
      const read = await published.readPublishedEvidence();
      assert.deepEqual([...read.records.keys()], [7]);
      assert.equal(read.unreadable.size, 0);
      assert.equal(published.conversationOwner(read, table(7), sid), 'free');
    });

    it('keeps a decodable record that names no conversation as unknown, never free', async () => {
      const bare = { pid: 42, startedAt: 1000 };
      for (const [what, body] of [
        ['no session id', bare],
        ['a session id that is not a string', { ...bare, sessionId: 5 }],
        ['a brand that is not a string', { ...bare, sessionId: 'other', brand: 7 }],
        ['a brand no build knows', { ...bare, sessionId: 'other', brand: 'nope' }],
        ['a zero start', { ...bare, sessionId: 'other', startedAt: 0 }],
        ['a negative start', { ...bare, sessionId: 'other', startedAt: -1 }]
      ] as const) {
        await reset();
        await put(42, { schema: 1, session: body, pending: [], queued: [] });
        const evidence = await published.readPublishedEvidence();
        assert.deepEqual([...evidence.unreadable], [42], what);
        assert.equal(evidence.records.size, 0, what);
        assert.equal(published.conversationOwner(evidence, table(42), sid), 'unknown', what);
      }
    });

    it('reads a valid unrelated record and a legacy one with no brand as records', async () => {
      await reset();
      await put(42, record({ session: session({ sessionId: 'other', brand: 'codex' }) }));
      const unrelated = await published.readPublishedEvidence();
      assert.equal(unrelated.unreadable.size, 0);
      assert.equal(published.conversationOwner(unrelated, table(42), sid), 'free');
      await reset();
      // `session()` carries no brand: a legacy record, read as the default.
      await put(42, record());
      const legacy = await published.readPublishedEvidence();
      assert.equal(legacy.unreadable.size, 0);
      assert.equal(published.conversationOwner(legacy, table(42), sid), 'held');
    });
  });

  it('round-trips everything a remote card is built from', async () => {
    await reset();
    const written = record({
      pending: [{ requestId: 'r1', toolName: 'Write', ask: false, label: 'notes.txt' }],
      queued: [{ id: 'q1', text: 'and then this', queuedAt: 1 }],
      exit: { code: 0, signal: null }
    });
    await published.publishLive(written);

    const back = await published.readPublished();
    assert.deepEqual(back.get(42), { ...written, liveText: '' });
  });

  it('decodes optional control facts and keeps malformed records readable but unaddressable', async () => {
    await reset();
    const control = { canControl: true, owner: { kind: 'window', windowId: 'window-b' } };
    await put(42, { ...record(), session: { ...session(), control } });
    assert.deepEqual((await published.readPublished()).get(42)?.session.control, control);
    for (const malformed of [
      null,
      {},
      { ...control, owner: { kind: 'window', windowId: '' } },
      { ...control, owner: { kind: 'window', windowId: 'contradictory-owner' } }
    ]) {
      await put(42, { ...record(), session: { ...session(), control: malformed } });
      const back = (await published.readPublished()).get(42);
      assert.ok(back);
      assert.deepEqual(back.session.control, { canControl: false, reason: 'invalid' });
      assert.equal(back.session.name, 'app-3f');
    }
    await put(42, record());
    const old = (await published.readPublished()).get(42);
    assert.ok(old);
    assert.equal('control' in old.session, false);
  });

  it('round-trips historical message facts and drops malformed optional evidence without losing the session', async () => {
    await reset();
    const messageFacts = [{ correlation: 'remote-message', phase: 'done' as const }];
    await published.publishLive(record({ messageFacts }));
    assert.deepEqual((await published.readPublished()).get(42)?.messageFacts, messageFacts);
    for (const invalid of [
      null,
      {},
      [{ correlation: '', phase: 'done' }],
      [{ correlation: 7, phase: 'done' }],
      [{ correlation: 'remote-message', phase: 'idle' }],
      [
        { correlation: 'remote-message', phase: 'done' },
        { correlation: 'bad', phase: 'idle' }
      ]
    ]) {
      await put(42, { ...record(), messageFacts: invalid });
      const back = (await published.readPublished()).get(42);
      assert.ok(back, 'optional evidence must not discard an otherwise usable older record');
      assert.equal(back.messageFacts, undefined);
    }
    await put(42, record());
    assert.equal((await published.readPublished()).get(42)?.messageFacts, undefined);
  });

  it('writes schema 1 that the previous reader accepts without a text buffer', async () => {
    await reset();
    const written = record({
      pending: [{ requestId: 'r1', toolName: 'Write', ask: false }],
      queued: [{ id: 'q1', text: 'next', queuedAt: 1 }]
    });
    await published.publishLive(written);
    const raw = JSON.parse(await fs.readFile(path.join(dir(), '42.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    // Frozen schema-1 usable() from before Step 12 (review F9).
    const usable = (value: typeof raw): boolean => {
      const held = value.session as Partial<Session> | undefined;
      return (
        value.schema === 1 &&
        !!held &&
        held.pid === 42 &&
        typeof held.startedAt === 'number' &&
        Array.isArray(value.pending) &&
        Array.isArray(value.queued) &&
        value.queued.every(
          (row: { id?: unknown; text?: unknown; queuedAt?: unknown }) =>
            !!row &&
            typeof row.id === 'string' &&
            typeof row.text === 'string' &&
            typeof row.queuedAt === 'number'
        ) &&
        typeof value.liveText === 'string'
      );
    };
    assert.equal(raw.liveText, '');
    assert.equal(usable(raw), true);
    delete raw.liveText;
    assert.equal(usable(raw), false, 'the old reader rejects the whole record without the field');
  });

  it('leaves no temp file behind, and none that a watcher would take for one', async () => {
    // The panel watches every `.json` under the status directory, subdirectories
    // included: a temp file named `.json` would nudge every window on the
    // machine and be there to be parsed when they looked.
    await reset();
    await published.publishLive(record());
    assert.deepEqual(await fs.readdir(dir()), ['42.json']);
  });

  it('forgets a record, and says nothing about one already gone', async () => {
    await reset();
    await published.publishLive(record());
    await published.removePublished(42);
    assert.equal((await published.readPublished()).size, 0);
    await assert.doesNotReject(published.removePublished(42));
  });

  it('removes a record even when a write for it is still in the air', async () => {
    // Nothing awaits a publish, and an ending removes the record without
    // knowing whether one is still going: a removal that overtook the write it
    // was meant to undo would leave the file renamed back into place, for a
    // session no window will ever publish for again.
    await reset();
    const writing = published.publishLive(record());
    const removing = published.removePublished(42);
    await Promise.all([writing, removing]);

    assert.equal((await published.readPublished()).size, 0);
    assert.deepEqual(await fs.readdir(dir()), [], 'and no temp file either');
  });

  it('lands two writes in the order they were asked for', async () => {
    // A dialog that opens and is retracted a millisecond later is two writes in
    // flight at once, and both skip the throttle. Renames that finished out of
    // order would pin the open dialog on every other window's board until the
    // session next changed.
    await reset();
    const first = record({ pending: [{ requestId: 'r1', toolName: 'Write', ask: false }] });
    const second = record({ pending: [] });
    await Promise.all([published.publishLive(first), published.publishLive(second)]);

    assert.deepEqual((await published.readPublished()).get(42), { ...second, liveText: '' });
  });

  it('skips a half-written file rather than throwing over it', async () => {
    await reset();
    await published.publishLive(record());
    await put(43, '{"schema":1,"session":{"pid":4');

    const back = await published.readPublished();
    assert.deepEqual([...back.keys()], [42]);
  });

  it('skips a schema this build does not know', async () => {
    // Equality, not a floor: a newer writer's fields are fields whose meaning
    // this build would be guessing at.
    await reset();
    await put(44, { ...record({ session: session({ pid: 44 }) }), schema: 2 });
    assert.equal((await published.readPublished()).size, 0);
  });

  it('skips a record whose pid does not match its name', async () => {
    await reset();
    await put(45, record({ session: session({ pid: 42 }) }));
    assert.equal((await published.readPublished()).size, 0);
  });

  it('skips a record missing a field a card is built from', async () => {
    await reset();
    await put(46, { schema: 1, session: session({ pid: 46 }) });
    assert.equal((await published.readPublished()).size, 0);
  });

  it('reads a directory nobody has written as an empty map', async () => {
    await reset();
    assert.equal((await published.readPublished()).size, 0);
  });
});

describe('the last turn’s outcome, one window along', () => {
  // The twin discovery would make of the same pid: no outcome of its own.
  const twin = session({ status: 'unknown', windowId: undefined, source: undefined });

  /** Publish → read → fold, the path the shims and the wait resolver see. */
  async function folded(written: PublishedLive): Promise<Session | undefined> {
    await reset();
    await published.publishLive(written);
    const views = await import('../../ui/views');
    return views.foldTwins([], [twin], await published.readPublished())[0];
  }

  it('keeps what the owning window’s frames stated', async () => {
    const live = await import('../../core/live');
    const state = live.applyEvent(
      live.applyEvent(live.initial({ cwd: '/work/app', startedAt: 1000 }), {
        kind: 'status',
        status: 'busy'
      }),
      { kind: 'turn-end', outcome: 'error' }
    );
    const held = { pid: 42, startedAt: 1000, updatedAt: 2000, brand: 'claude' as const };
    const card = await folded(record({ session: live.toSession(state, held, 'window-b') }));
    assert.equal(card?.turnOutcome, 'error');
  });

  it('folds a record written without one to no outcome', async () => {
    const card = await folded(record({ session: session({ status: 'idle' }) }));
    assert.equal(card?.status, 'idle', 'the record was the one folded');
    assert.equal(card?.turnOutcome, undefined);
  });
});

describe('sorting a file event by what wrote it', () => {
  it('names the pid a live record belongs to', () => {
    assert.equal(published.livePid(path.join(dir(), '9500.json')), 9500);
  });

  it('ignores a state file outside live/', () => {
    assert.equal(published.livePid(path.join(home, '.squadron', 'claims', '9500.json')), undefined);
  });

  it('ignores a nested path that only ends in live/', () => {
    assert.equal(published.livePid(path.join(dir(), 'nested', '9500.json')), undefined);
  });

  it('ignores a file in live/ that does not name a pid', () => {
    assert.equal(published.livePid(path.join(dir(), 'index.json')), undefined);
    assert.equal(published.livePid(path.join(dir(), '9500.json.tmp')), undefined);
  });

  // `publishLive` writes `${pid}.json` for a positive pid, and nothing else is
  // one. Anything else asks for the full refresh, which is always safe.
  it('ignores a name `publishLive` never writes', () => {
    for (const name of [
      '0.json',
      '09500.json',
      '-9500.json',
      '+9500.json',
      '9500.5.json',
      '1e3.json',
      ' 9500.json',
      '9500 .json',
      '9500.JSON',
      '.json',
      '9500',
      `${'9'.repeat(20)}.json`
    ]) {
      assert.equal(published.livePid(path.join(dir(), name)), undefined, name);
    }
  });

  it('ignores a neighbouring directory', () => {
    for (const neighbour of ['live2', 'liv', 'live.old', 'Live']) {
      const file = path.join(home, '.squadron', neighbour, '9500.json');
      assert.equal(published.livePid(file), undefined, neighbour);
    }
    assert.equal(published.livePid(path.join(home, '.squadron', '9500.json')), undefined);
    assert.equal(published.livePid(path.join(home, 'live', '9500.json')), undefined);
  });

  // A watcher's `fsPath` lowers the drive letter; `LIVE_DIR` is `os.homedir`'s
  // upper one. Past the drive the case is kept, as the key keeps it.
  it('names the pid however the watcher spells the drive and separators', (t) => {
    if (testPlatform() !== 'win32')
      return t.skip('posix: drive and separator spellings are win32 paths');
    const file = path.join(dir(), '9500.json');
    const lower = file.charAt(0).toLowerCase() + file.slice(1);
    for (const spelled of [lower, file.replaceAll('\\', '/'), lower.replaceAll('\\', '/')]) {
      assert.equal(published.livePid(spelled), 9500, spelled);
    }
    const upper = path.join(home, '.squadron', 'LIVE', '9500.json');
    assert.equal(published.livePid(upper), undefined);
    assert.equal(published.livePid(`\\\\?\\${file}`), undefined);
  });
});

/**
 * The join `core/published.ts`'s own header states as the rule and the resume
 * picker is the one reader that has to apply by hand: a record is evidence only
 * beside a pid that is still running the session it was published for.
 *
 * Both arms shipped missing once (row 71), and each cost a conversation that
 * could not be resumed — the first for as long as the card sat on the board,
 * the second for the seven days `prune.ts` takes.
 */
describe('a record, joined to the process table', () => {
  const live = (pid: number, startedAt: number, over: Partial<PublishedLive> = {}) =>
    new Map([[pid, record({ session: session({ pid, startedAt }), ...over })]]);

  it('keeps one whose pid still holds the start it was published under', () => {
    const kept = published.liveRecords(live(42, 1000), new Map([[42, 1000]]));
    assert.deepEqual(
      kept.map((r) => r.session.pid),
      [42]
    );
  });

  it('drops one whose window said it exited, however live the pid is', () => {
    // The card is still on the board — a record outlives its session until the
    // reader dismisses it — so the pid arm alone would call this conversation
    // live and refuse to resume the thing that just ended.
    const kept = published.liveRecords(
      live(42, 1000, { exit: { code: 0, signal: null } }),
      new Map([[42, 1000]])
    );
    assert.deepEqual(kept, []);
  });

  it('drops one whose pid is gone — the window force-quit without closing', () => {
    // Nothing sweeps `live/` in that case. Without this the record stands for a
    // week and every conversation that window was running is unresumable, in
    // every window, with nothing in the UI to clear it with.
    assert.deepEqual(published.liveRecords(live(42, 1000), new Map()), []);
  });

  it('drops one whose pid has been recycled onto another process', () => {
    // A start match rather than "is that pid alive", for `core/control.ts`'s
    // reason: the number comes back around, and the starts differ by far more
    // than the launch skew the match allows.
    assert.deepEqual(published.liveRecords(live(42, 1000), new Map([[42, 900_000]])), []);
  });
});

describe('optional incoming publication', () => {
  it('strips malformed incoming identity without discarding legacy session and reaction facts', async () => {
    await reset();
    const messageFacts = [{ correlation: 'ordinary', phase: 'done' }];
    await put(42, {
      ...record(),
      receiverIdentity: { version: 1, pid: 42 },
      remoteLaunchEvidence: { version: 9 },
      messageFacts
    });
    const back = (await published.readPublished()).get(42) as unknown as Record<string, unknown>;
    assert.ok(back);
    assert.equal(back.receiverIdentity, undefined);
    assert.equal(back.remoteLaunchEvidence, undefined);
    assert.deepEqual(back.messageFacts, messageFacts);
  });
});

describe('stable incoming publication evidence', () => {
  it('round-trips lifetime receipts beyond recent-fact and individual-envelope limits', async () => {
    await reset();
    const receipts = Array.from({ length: 400 }, (_, index) => ({
      ...fixture.delivery,
      correlation: `delivery-${index}`,
      outcome: 'queued' as const,
      acceptedAt: 4000 + index
    }));
    assert.ok(receipts.length > 256);
    assert.ok(Buffer.byteLength(JSON.stringify(receipts), 'utf8') > 64 * 1024);
    const messageFacts = [{ correlation: 'ordinary', phase: 'done' as const }];
    const written = record({
      session: session({
        pid: fixture.receiver.pid,
        cwd: fixture.receiver.cwd,
        windowId: 'w1',
        brand: 'codex'
      }),
      receiverIdentity: fixture.receiver,
      incomingDeliveries: receipts,
      messageFacts
    });
    await published.publishLive(written);
    const decoded = (await published.readPublished()).get(fixture.receiver.pid)?.incomingDeliveries;
    assert.ok(decoded, 'valid lifetime receipts must remain available');
    assert.equal(decoded.length, receipts.length);
    assert.deepEqual(decoded, receipts);
    for (const invalid of [
      { ...receipts[350], admissionDigest: 'invalid' },
      { ...receipts[350], correlation: 'delivery-0' },
      { ...receipts[350], receiver: { ...fixture.receiver, pid: 8 } },
      { ...receipts[350], extra: 'x'.repeat(64 * 1024) }
    ]) {
      await put(fixture.receiver.pid, {
        ...written,
        incomingDeliveries: [...receipts.slice(0, 350), invalid, ...receipts.slice(351)]
      });
      const back = (await published.readPublished()).get(fixture.receiver.pid);
      assert.ok(back);
      assert.equal(back.incomingDeliveries, undefined);
      assert.deepEqual(back.receiverIdentity, fixture.receiver);
      assert.deepEqual(back.messageFacts, messageFacts);
      assert.deepEqual(back.session, written.session);
    }
  });

  it('reads exact stable launch and delivery receipts independently of recent turn facts', async () => {
    await reset();
    const receipt = { ...fixture.delivery, outcome: 'queued' as const, acceptedAt: 4000 };
    const written = record({
      session: session({
        pid: fixture.receiver.pid,
        cwd: fixture.receiver.cwd,
        windowId: 'w1',
        brand: 'codex'
      }),
      receiverIdentity: fixture.receiver,
      remoteLaunchEvidence: fixture.launch,
      incomingDeliveries: [receipt],
      messageFacts: []
    });
    await published.publishLive(written);
    const back = (await published.readPublished()).get(fixture.receiver.pid);
    assert.deepEqual(back?.receiverIdentity, fixture.receiver);
    assert.deepEqual(back?.remoteLaunchEvidence, fixture.launch);
    assert.deepEqual(back?.incomingDeliveries, [receipt]);
    for (const receiverIdentity of [
      { ...fixture.receiver, pid: 8 },
      { ...fixture.receiver, host: { ...fixture.host, windowId: 'other' } },
      { ...fixture.receiver, cwd: fixture.receiver.cwd + '-other' }
    ]) {
      await put(fixture.receiver.pid, { ...written, receiverIdentity });
      const invalid = (await published.readPublished()).get(fixture.receiver.pid);
      assert.ok(invalid);
      assert.equal(invalid.receiverIdentity, undefined);
      assert.equal(invalid.remoteLaunchEvidence, undefined);
      assert.equal(invalid.incomingDeliveries, undefined);
    }
    await put(fixture.receiver.pid, {
      ...written,
      incomingDeliveries: [receipt, { ...receipt, admissionDigest: 'b'.repeat(64) }]
    });
    assert.equal(
      (await published.readPublished()).get(fixture.receiver.pid)?.incomingDeliveries,
      undefined
    );
  });
});
