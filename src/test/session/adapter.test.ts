import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import * as os from 'node:os';

import { before, describe, it } from 'node:test';

import * as brands from '../../core/brands';

import type { Session } from '../../core/model';

import type { Model } from '../../core/model_names';

import { brandName } from '../../core/accounts';

import { CLAUDE_MODELS, catalogFor } from '../../core/catalog';

import { repoRoot, tempHome } from '../helpers';

type AdapterModule = typeof import('../../core/adapter');

type ConversationsModule = typeof import('../../core/conversations');

type RecordModule = typeof import('../../core/record');

type SessionTransport = import('../../core/session').SessionTransport;

let mod: AdapterModule;

let conversations: ConversationsModule;

let record: RecordModule;

/** A pipe with nobody on it, for the one thing `connect` is asked here: what
 *  shape the handle it builds has. */
const nowhere = (): SessionTransport => ({
  pid: 1234,
  write: () => undefined,
  onLine: () => undefined,
  onExit: () => undefined,
  close: () => undefined
});

before(async () => {
  await tempHome();
  mod = await import('../../core/adapter');
  conversations = await import('../../core/conversations');
  record = await import('../../core/record');
});

describe('the adapter registry', () => {
  it('answers for the brand this build ships, and enumerates the list', () => {
    assert.equal(mod.adapter('claude')?.brand, 'claude');
    assert.equal(mod.adapter('codex')?.brand, 'codex');
    assert.deepEqual(brands.BRANDS, ['claude', 'grok', 'codex']);
  });

  it('answers nothing for a brand with no adapter, rather than a default', () => {
    // A start meant for one CLI silently running another is the failure this
    // shape exists to stop. A caller with *no* brand means `claude` and says so
    // at its own call site; an unknown one is a refusal.
    assert.equal(mod.adapter('gemini'), undefined);
    assert.equal(mod.adapter(''), undefined);
  });

  it('refuses a named brand this build cannot start, and leaves an absent one unset', () => {
    // Absence is the caller's default. A name with no adapter is a refusal:
    // treating it as absence starts Claude.
    assert.deepEqual(mod.brandForStart(undefined), { ok: true });
    assert.deepEqual(mod.brandForStart(null), { ok: true });
    for (const brand of brands.BRANDS) {
      assert.deepEqual(mod.brandForStart(brand), { ok: true, brand });
    }
    const refused = { ok: false, reason: 'That CLI cannot be started from here.' };
    assert.deepEqual(mod.brandForStart('gemini'), refused);
    assert.deepEqual(mod.brandForStart(''), refused);
    assert.deepEqual(mod.brandForStart('constructor'), refused);
  });

  /**
   * What a start asked for is seeded the same way behind every brand. Each
   * constructor used to copy these fields by hand, and two of three dropped
   * `effort` — a fresh card read no effort until its first reply.
   */
  it('seeds every brand from the launch it was started with', () => {
    const START = {
      claude: { model: 'claude-opus-5-5', window: 1_000_000 },
      grok: { model: 'grok-4.7', window: 500_000 },
      codex: { model: 'gpt-5.6-sol', window: 272_000 }
    } as const;
    for (const brand of brands.BRANDS) {
      const { model, window } = START[brand];
      const handle = mod.adapter(brand)?.connect(nowhere(), {
        cwd: '/tmp',
        startedAt: 1000,
        model,
        effort: 'high',
        window,
        windowReach: 'plain'
      });
      assert.ok(handle, `${brand} built no handle`);
      const { modelPick, effort, windowAsked, launchReach } = handle.state;
      assert.deepEqual(
        { modelPick, effort, windowAsked, launchReach },
        { modelPick: model, effort: 'high', windowAsked: window, launchReach: 'plain' },
        `${brand} dropped part of its launch`
      );
      handle.close();
    }
  });

  it('points every brand at an install page the host may open', () => {
    for (const brand of brands.BRANDS) {
      const url = new URL(mod.adapter(brand)?.installUrl ?? 'missing:');
      assert.equal(url.protocol, 'https:', `${brand} states no https install page`);
    }
  });

  it('resolves one session to its adapter, and an absent brand to Claude', () => {
    // The historical fallback, now said in one place rather than at six call
    // sites: a session discovered before brands existed carries no `brand` and
    // still has to reach an adapter that can drive it.
    assert.equal(mod.adapterFor({ brand: 'grok' })?.brand, 'grok');
    assert.equal(mod.adapterFor({})?.brand, 'claude');
  });

  it('resolves a brand this build has no adapter for to nothing', () => {
    // A record another build wrote. Every caller skips the call it cannot
    // make; none of them reaches for Claude's reader instead, which would open
    // one CLI's file with another's parser.
    assert.equal(mod.adapterFor({ brand: 'gemini' as Session['brand'] }), undefined);
  });

  it('states where a conversation lives only for the brand that files one', () => {
    // `locateTranscript` is Claude's project slug plus a sweep of
    // `~/.claude/projects/`. Absent is the contract, not an omission: the
    // caller trusts `session.transcript`, which is what Grok states as
    // `chat_history.jsonl` and what deriving a Claude path for it would
    // overwrite with a file that has never existed.
    assert.equal(typeof mod.adapter('claude')?.locateTranscript, 'function');
    assert.equal(typeof mod.adapter('grok')?.locateTranscript, 'undefined');
    assert.equal(typeof mod.adapter('codex')?.locateTranscript, 'undefined');
  });

  it('does not resolve a name off Object.prototype', () => {
    // The id arrives off disk or out of a settings box, and `ADAPTERS[id]`
    // would hand back a truthy non-adapter that then gets called.
    assert.equal(mod.adapter('constructor'), undefined);
    assert.equal(mod.adapter('toString'), undefined);
  });

  it('maps a Grok model id to the Grok adapter, and nothing else', () => {
    assert.equal(mod.brandForModel('grok-4.6'), 'grok');
    assert.equal(mod.brandForModel('  grok-4.5'), 'grok');
    assert.equal(mod.brandForModel('gpt-5.6-sol'), 'codex');
    assert.equal(mod.brandForModel('opus'), undefined);
    assert.equal(mod.brandForModel(''), undefined);
  });

  it('keeps a session on the models its brand owns', () => {
    const models: Model[] = [
      { value: 'opus', name: 'Opus', id: 'claude-opus-5', brand: 'claude' },
      { value: 'grok-4.6', name: 'Grok 4.6', id: 'grok-4.6', brand: 'grok' },
      { value: 'gpt-5', name: 'GPT-5', id: 'gpt-5', brand: 'codex' },
      { value: 'x1', name: 'X1', id: 'x1', brand: 'grok' }
    ];
    assert.deepEqual(
      mod.modelsForSession('claude', models).map((m) => m.value),
      ['opus']
    );
    assert.deepEqual(
      mod.modelsForSession('grok', models).map((m) => m.value),
      ['grok-4.6', 'x1']
    );
    assert.deepEqual(
      mod.modelsForSession(undefined, models).map((m) => m.value),
      ['opus']
    );
    assert.deepEqual(
      mod.modelsForSession('codex', models).map((m) => m.value),
      ['gpt-5']
    );
  });

  it("keeps a running session's catalog when that brand is filtered from starts", () => {
    assert.deepEqual(
      mod.modelsForSession('grok', []).map((m) => m.value),
      // No `grok-4.7-build-fast`: the fallback reads the catalog raw, and this
      // is a list to pick from. `catalogFor` still carries it.
      ['grok-4.7', 'grok-4.6', 'grok-4.5']
    );
  });

  /**
   * The dock's list, narrowed to what this session's own launch line can still
   * reach. `--settings` is composed at spawn, so the flag is fixed for the
   * session's life — the menu used to offer every window regardless, and
   * pressing `200k` on a session started at 1M relabelled a pill over a session
   * still running at a million.
   *
   * Over the real catalog, because the rule is about which windows a row has:
   * a fixture stating its own would be asserting against itself.
   */
  describe('the windows one session can still be moved onto', () => {
    const rows = catalogFor('claude');
    const stamped = (from?: 'plain' | 'suffix' | 'flag', wide?: boolean) =>
      mod
        .modelsForSession('claude', rows, from, wide)
        .filter((m) => m.fixed)
        .map((m) => `${m.value}@${m.window}`);

    it('marks every flag window on an unflagged line, given the wide window', () => {
      // Opus 5's 200k is reached by the flag alone, and no flag can join a
      // running process. Its 1M is spelled and stays offered.
      const off = stamped('suffix', true);
      assert.ok(off.includes('claude-opus-5@200000'), 'a flag window stayed offered');
      assert.ok(!off.includes('claude-opus-5@1000000'), 'a suffix window was marked');
      // Opus 4.6 reaches 200k plain, so it is offered from any line.
      assert.ok(!off.includes('claude-opus-4-6@200000'));
      assert.deepEqual(stamped('plain', true), off, 'plain and suffix lines differ');
    });

    /** The same line on an account that is never given the wide window: the
     *  pills point the other way, and the narrow one is what works. */
    it('marks every wide window instead when the account defaults narrow', () => {
      const off = stamped('plain', false);
      assert.ok(off.includes('claude-opus-5@1000000'), 'a refusable window stayed offered');
      assert.ok(off.includes('claude-sonnet-5@1000000'), 'a plain wide window stayed offered');
      assert.ok(!off.includes('claude-opus-5@200000'), 'the window that works was marked');
      assert.ok(!off.includes('claude-haiku-4-5@200000'), 'a one-window row was marked');
    });

    it('marks every wide window on a flagged line, however it is spelled', () => {
      const off = stamped('flag', true);
      assert.ok(off.includes('claude-opus-5@1000000'), 'a suffixed wide window stayed offered');
      assert.ok(off.includes('claude-sonnet-5@1000000'), 'a plain wide window stayed offered');
      assert.ok(!off.includes('claude-opus-5@200000'), 'the narrow window was marked');
      assert.ok(!off.includes('claude-haiku-4-5@200000'), 'a one-window row was marked');
    });

    it('marks nothing for a line it cannot speak for', () => {
      // A discovered session, one launched before the window rode the line, and
      // a window publishing an older record. Every pill stays pickable.
      assert.deepEqual(stamped(undefined, true), []);
    });

    /** Nor for an account that has not shown its hand — a session that has run
     *  no turn and asked for nothing states no width to read one off. */
    it('marks nothing until a width has been observed', () => {
      assert.deepEqual(stamped('plain', undefined), []);
    });

    /** `readonly` is erased at runtime, and a stamp written in place would
     *  corrupt the catalog for the gear and every later poll. */
    it('does not mutate the rows it was handed', () => {
      mod.modelsForSession('claude', rows, 'flag', true);
      assert.deepEqual(
        rows.filter((m) => m.fixed),
        [],
        'the catalog was stamped in place'
      );
    });

    /** Never `fixed: undefined`: a key present-and-undefined erases what a
     *  fold's other half knew, which is what `gated` states beside it. */
    it('leaves the key off a row it does not mark', () => {
      const reachable = mod
        .modelsForSession('claude', rows, 'flag', true)
        .filter((m) => m.window === 200_000);
      assert.ok(reachable.length > 0, 'the fixture found no narrow window');
      for (const model of reachable) {
        assert.ok(!('fixed' in model), `${model.value} carries a present-and-undefined key`);
      }
    });
  });

  /**
   * The availability filter, which is the whole of what the host decides about
   * the model list. Driven over the real registry, so a brand added to
   * `ADAPTERS` is covered here without a second list to keep.
   */
  describe('offeredModels', () => {
    const brandsIn = (rows: readonly { brand: string }[]): string[] => [
      ...new Set(rows.map((row) => row.brand))
    ];

    it('drops a brand that has been asked and has no account', () => {
      const rows = mod.offeredModels([
        { brand: 'claude', installed: true, signedIn: true },
        { brand: 'grok', installed: true, signedIn: false }
      ]);
      assert.deepEqual(brandsIn(rows), ['claude']);
    });

    it('drops a brand with no binary, however signed in it looks', () => {
      // Grok's status is a `~/.grok/auth.json` stat, so this pair is a real
      // machine state and not a contrived one: the file outlives the binary.
      const rows = mod.offeredModels([
        { brand: 'claude', installed: true, signedIn: true },
        { brand: 'grok', installed: false, signedIn: true }
      ]);
      assert.deepEqual(brandsIn(rows), ['claude']);
    });

    /** The first paint of every window, and the case the filter must not
     *  fail: nothing has been probed yet, and an empty flyout is the bug the
     *  synchronous catalog exists to remove. */
    it('keeps a brand nothing has probed yet', () => {
      const rows = mod.offeredModels([{ brand: 'claude' }, { brand: 'grok' }]);
      assert.deepEqual(brandsIn(rows).sort(), ['claude', 'grok']);
      assert.ok(rows.length > 2);
    });

    it('keeps a brand that is installed but not yet asked about', () => {
      const rows = mod.offeredModels([{ brand: 'claude', installed: true }]);
      assert.deepEqual(brandsIn(rows), ['claude']);
    });

    /**
     * `unlisted` is the one flag that decides a row is never seen rather than
     * how it is drawn, so the assertion is a pair: absent from what the panel
     * may offer, present in what a join reads. Deleting the row would satisfy
     * the first half alone, which is what this holds down.
     */
    it('offers no unlisted row, and leaves it in the catalog for the join', () => {
      const rows = mod.offeredModels([{ brand: 'grok', installed: true, signedIn: true }]);
      assert.equal(
        rows.find((row) => row.value === 'grok-4.7-build-fast'),
        undefined
      );
      assert.ok(rows.some((row) => row.value === 'grok-4.7'));
      const kept = catalogFor('grok').find((row) => row.value === 'grok-4.7-build-fast');
      assert.equal(kept?.unlisted, true);
      assert.equal(kept?.window, 500_000);
    });

    it('carries the readings the join needs all the way through', () => {
      const rows = mod.offeredModels([{ brand: 'claude', installed: true, signedIn: true }]);
      const haiku = rows.find((row) => row.value === 'claude-haiku-4-5');
      assert.ok(haiku?.readings?.includes('claude-haiku-4-5-20251001'));
    });

    it('names every row it offers, in the word that brand goes by', () => {
      const rows = mod.offeredModels([{ brand: 'claude' }, { brand: 'grok' }]);
      assert.ok(rows.length > 2);
      // Not a literal per row: what is under test is that every row got one and
      // that the word is the brand's, wherever that word is kept.
      for (const row of rows) {
        assert.equal(row.brandLabel, brandName(row.brand), `${row.value} carries no label`);
      }
    });

    /**
     * The guard `offeredModels` spreads for, and the one nothing held down
     * until this case: `models()` hands back the catalog's own module-level
     * array, so a stamp written in place would follow the rows into every
     * later poll of every window. `readonly` is erased at runtime and cannot
     * say so.
     */
    it('leaves the catalog it read alone', () => {
      mod.offeredModels([{ brand: 'claude' }]);
      for (const row of CLAUDE_MODELS) {
        assert.ok(
          !('brandLabel' in row),
          `${row.value} was stamped in the catalog itself, not in the copy`
        );
      }
    });

    it('offers nothing at all when every brand is a known negative', () => {
      assert.deepEqual(
        mod.offeredModels([
          { brand: 'claude', installed: false },
          { brand: 'grok', signedIn: false }
        ]),
        []
      );
    });
  });

  it('has a refusal for every capability, and names no CLI in it', () => {
    for (const cap of ['messages', 'turn', 'model', 'naming', 'asks', 'warm'] as const) {
      const words = mod.refusal(cap);
      assert.match(words, /^That session/);
      assert.doesNotMatch(words, /claude|grok|codex/i);
    }
  });
});

describe('readSessionTranscript picks a source', () => {
  /** A `.jsonl` holding one assistant message, written where a session can name
   *  it. The CLI's own shape, since that is what the fallback reader parses. */
  /** `asked` puts a user entry above each assistant one, which is what makes
   *  their walk count two turns where our record holds a single exchange. The
   *  turn cap then lands in a different place on each side, which is the only
   *  way a cap-bound window's cut is visible from out here. */
  async function transcript(name: string, ids: string[], asked = false): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-src-'));
    const file = path.join(dir, `${name}.jsonl`);
    const entry = (id: string, at: number, role: 'user' | 'assistant') => ({
      type: role,
      uuid: `u-${role}-${id}`,
      timestamp: new Date(1_700_000_000_000 + at).toISOString(),
      message:
        role === 'user'
          ? { role, content: [{ type: 'text', text: `asking ${id}` }] }
          : { role, id, model: 'claude-opus-5', content: [{ type: 'text', text: `from ${id}` }] }
    });
    await fs.writeFile(
      file,
      ids
        .flatMap((id, at) =>
          asked ? [entry(id, at, 'user'), entry(id, at, 'assistant')] : [entry(id, at, 'assistant')]
        )
        .map((one) => JSON.stringify(one))
        .join('\n') + '\n'
    );
    return file;
  }

  const session = (sessionId: string, file: string): Session =>
    ({ pid: 1, sessionId, cwd: '/tmp', transcript: file, brand: 'claude' }) as Session;

  it('draws our record when it witnessed every message the CLI wrote down', async () => {
    const file = await transcript('pick-1', ['msg_1']);
    await record.appendLine('pick-1', { ...{ role: 'assistant', text: 'ours' }, m: 'msg_1' });

    const drawn = await mod.readSessionTranscript(session('pick-1', file));
    assert.equal(drawn.ours, true);
    assert.equal(
      drawn.recent.exchanges[0] && 'text' in drawn.recent.exchanges[0]
        ? drawn.recent.exchanges[0].text
        : undefined,
      'ours'
    );
  });

  it('falls back when the CLI has a message we never saw', async () => {
    // A conversation carried on outside the panel. Drawing our record here would
    // show a thread with a hole in it, and that is the one failure worth a
    // comparison at all.
    const file = await transcript('pick-2', ['msg_1', 'msg_outside']);
    await record.appendLine('pick-2', { ...{ role: 'assistant', text: 'ours' }, m: 'msg_1' });

    const drawn = await mod.readSessionTranscript(session('pick-2', file));
    assert.equal(drawn.ours, false);
    assert.equal(drawn.recent.exchanges.length, 2, "the CLI's file, whole");
  });

  it('reads a brand this build has no adapter for as empty, not through Claude', async () => {
    // A record another build wrote. Claude's parser on another CLI's file is a
    // reading of something, which is worse than nothing: the guard answers and
    // the card shrinks. Neither branch may throw — `buildThread` is one member
    // of a `Promise.all` that pushes the whole board.
    const file = await transcript('pick-4', ['msg_1']);
    const foreign = { ...session('pick-4', file), brand: 'gemini' as Session['brand'] };

    const drawn = await mod.readSessionTranscript(foreign);
    assert.deepEqual(drawn.recent.exchanges, []);
    assert.equal(drawn.ours, false);
  });

  it('draws our record when the CLI file cannot be located at all', async () => {
    await record.appendLine('pick-3', { ...{ role: 'assistant', text: 'ours' }, m: 'msg_1' });
    const drawn = await mod.readSessionTranscript(session('pick-3', '/nowhere/at/all.jsonl'));
    assert.equal(drawn.ours, true);
  });

  it('falls back for a conversation with no record of ours', async () => {
    const file = await transcript('pick-4', ['msg_1']);
    const drawn = await mod.readSessionTranscript(session('pick-4', file));
    assert.equal(drawn.ours, false);
  });

  it('draws no further back than a bound CLI window is evidence for', async () => {
    // The tail is what can be compared; our record has no window at all. Drawing
    // 400 turns on the evidence of 24 is how a hole older than the tail goes
    // unseen — the review of 2026-08-20.
    //
    // Bound here by the turn cap rather than by bytes, because a byte-bound read
    // needs a file past `MAX_TAIL_BYTES` — 8 MiB to write and 14 to read back,
    // for a cut `record.test.ts` already pins on a fixture.
    const ids = Array.from({ length: 405 }, (_, n) => `msg_${n}`);
    const file = await transcript('pick-7', ids, true);
    for (const id of ids) {
      await record.appendLine('pick-7', { ...{ role: 'assistant', text: id }, m: id });
    }
    const drawn = await mod.readSessionTranscript(session('pick-7', file));
    assert.equal(drawn.ours, true);
    // Their 400 turns are 200 exchanges of ours, where our own cap would have
    // left 400. The window is the shorter ceiling and it is the one that binds.
    assert.equal(drawn.recent.exchanges.length, 200, 'only the range the window reached');
    assert.equal(drawn.recent.truncated, true);
  });

  it('draws the whole record when the CLI file was read whole', async () => {
    // The opening prompt carries a `message.id` on neither side, so the cut
    // above used to take it off every conversation ever held and then say more
    // was unread. A whole read has no older window for a hole to hide in.
    const file = await transcript('pick-8', ['msg_0', 'msg_1']);
    await record.appendLine('pick-8', { role: 'user', text: 'the prompt' });
    for (const id of ['msg_0', 'msg_1']) {
      await record.appendLine('pick-8', { ...{ role: 'assistant', text: id }, m: id });
    }
    const drawn = await mod.readSessionTranscript(session('pick-8', file));
    assert.equal(drawn.ours, true);
    assert.equal(drawn.recent.exchanges.length, 3, 'the prompt and both answers');
    assert.equal(drawn.recent.truncated, false, 'and nothing claimed unread');
  });

  /**
   * Grok's half of the same rule, on its own key.
   *
   * The witness is the prompt ordinal (`prompt_index` on disk,
   * `_meta.promptIndex` on the wire) rather than a per-message id, because Grok
   * writes no id either side. It is a *set* of ordinals, so a prompt the file
   * has and we never saw is a miss whatever its number.
   */
  async function grokTranscript(indices: readonly number[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-src-'));
    const file = path.join(dir, 'chat_history.jsonl');
    await fs.writeFile(
      file,
      indices
        .flatMap((index) => [
          {
            type: 'user',
            content: [{ type: 'text', text: `<user_query>\nasking ${index}\n</user_query>` }],
            prompt_index: index
          },
          { type: 'assistant', content: `answer ${index}` }
        ])
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
    return file;
  }

  const grokSession = (sessionId: string, file: string): Session =>
    ({ pid: 1, sessionId, cwd: '/tmp', transcript: file, brand: 'grok' }) as Session;

  it('draws our Grok record when it witnessed every prompt the file holds', async () => {
    const file = await grokTranscript([0, 1]);
    for (const index of [0, 1]) {
      await record.appendLine('pick-5', {
        ...{ role: 'user', text: `asking ${index}` },
        m: String(index)
      });
      await record.appendLine('pick-5', { role: 'assistant', text: `answer ${index}` });
    }
    const drawn = await mod.readSessionTranscript(grokSession('pick-5', file));
    assert.equal(drawn.ours, true);
    assert.equal(drawn.recent.exchanges.length, 4);
    assert.equal(drawn.recent.truncated, false, 'this reader has no window, so nothing is cut');
  });

  it('falls back when the Grok file holds a prompt we never saw', async () => {
    // A conversation carried on in the TUI, or loaded from one: the ordinals
    // are in the file and never reached our pipe. Probed 2026-08-20 (1.0.5):
    // the numbering carries on across a `session/load` rather than restarting,
    // which is what makes a missing one visible.
    const file = await grokTranscript([0, 1]);
    await record.appendLine('pick-9', { ...{ role: 'user', text: 'asking 0' }, m: '0' });
    const drawn = await mod.readSessionTranscript(grokSession('pick-9', file));
    assert.equal(drawn.ours, false);
    assert.equal(drawn.recent.exchanges.length, 4, "the CLI's file, whole");
  });

  it('draws our Grok record when there is no CLI file to compare against', async () => {
    await record.appendLine('pick-10', { ...{ role: 'user', text: 'asking 0' }, m: '0' });
    const drawn = await mod.readSessionTranscript(
      grokSession('pick-10', '/nowhere/chat_history.jsonl')
    );
    assert.equal(drawn.ours, true, 'an empty set is no evidence either way');
  });

  it('hands back the same reading while neither file has moved', async () => {
    // `renderTranscript` skips its whole view rebuild on object identity.
    const file = await transcript('pick-6', ['msg_1']);
    await record.appendLine('pick-6', { ...{ role: 'assistant', text: 'ours' }, m: 'msg_1' });
    const first = await mod.readSessionTranscript(session('pick-6', file));
    assert.equal((await mod.readSessionTranscript(session('pick-6', file))).recent, first.recent);
  });
});

describe('mergeConversations', () => {
  const row = (
    brand: 'claude' | 'grok',
    n: number,
    over: Partial<import('../../core/conversations').Conversation> = {}
  ): import('../../core/conversations').Conversation => ({
    sessionId: `${brand}-${n}`,
    title: `${brand} ${n}`,
    titled: true,
    lastActivity: n,
    cwd: '/dev/app',
    brand,
    ...over
  });

  it('returns 20 newest first from 15 Claude and 15 newer Grok, both brands present', () => {
    const claude = Array.from({ length: 15 }, (_, i) => row('claude', i + 1));
    const grok = Array.from({ length: 15 }, (_, i) => row('grok', i + 16));
    const merged = conversations.mergeConversations([...claude, ...grok], '/dev/app', 20);
    assert.equal(merged.length, 20);
    assert.deepEqual(
      merged.map((r) => r.lastActivity),
      Array.from({ length: 20 }, (_, i) => 30 - i)
    );
    assert.ok(merged.some((r) => r.brand === 'claude'));
    assert.ok(merged.some((r) => r.brand === 'grok'));
  });

  it('keeps a floor of asked-cwd rows when newer siblings would fill the page', () => {
    const here = [row('grok', 1, { cwd: '/dev/app' })];
    const other = Array.from({ length: 20 }, (_, i) =>
      row('claude', i + 10, { cwd: '/dev/app/apps/web' })
    );
    const merged = conversations.mergeConversations([...here, ...other], '/dev/app', 20);
    assert.equal(merged.length, 20);
    assert.equal(merged.filter((r) => r.cwd === '/dev/app').length, 1);
    assert.ok(merged.some((r) => r.sessionId === 'grok-1'));
  });

  it('keys a live session by brand and id, so the same id on two brands is two rows', () => {
    assert.notEqual(mod.conversationKey('claude', 'same'), mod.conversationKey('grok', 'same'));
  });
});

describe('the note that a thread was reconstructed', () => {
  const said = [{ role: 'user' as const, text: 'go' }];

  it('says so for turns that came out of the CLI\u2019s own transcript', () => {
    assert.equal(
      mod.reconstructed({ recent: { exchanges: said, truncated: false }, ours: false }),
      true
    );
  });

  it('says nothing for turns the panel witnessed whole', () => {
    assert.equal(
      mod.reconstructed({ recent: { exchanges: said, truncated: false }, ours: true }),
      undefined
    );
  });

  it('says nothing when nothing has been said', () => {
    // `drawable` declines a record with no exchanges, so a session before its
    // first turn is `ours: false` \u2014 the fallback reader's, over a file that is
    // not there. Flagged, the dock would name a reconstruction of a conversation
    // nobody has had.
    assert.equal(
      mod.reconstructed({ recent: { exchanges: [], truncated: false }, ours: false }),
      undefined
    );
  });

  it('says so for a cut that left no turns, which is still a read of that file', () => {
    // A tail that is all tool results: `walk` drops them, so the window yields
    // no exchanges and the reader is told only that older turns went unread.
    assert.equal(
      mod.reconstructed({ recent: { exchanges: [], truncated: true }, ours: false }),
      true
    );
  });
});

describe('lastPromptAt', () => {
  /** A Claude transcript holding one prompt, in that CLI's own shape — the
   *  fallback reader is what parses it, so the fixture agrees with the CLI. */
  async function claudeFile(name: string, at: number): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-prompt-'));
    const file = path.join(dir, `${name}.jsonl`);
    await fs.writeFile(
      file,
      `${JSON.stringify({
        type: 'user',
        uuid: `u-${name}`,
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'have a look' }] }
      })}\n`
    );
    return file;
  }

  const session = (brand: string, sessionId: string, transcript = ''): Session =>
    ({ pid: 1, sessionId, cwd: '/tmp', transcript, brand }) as Session;

  it('reads Claude out of the CLI file it names', async () => {
    const at = Date.parse('2026-09-08T10:00:00.000Z');
    const file = await claudeFile('lp-claude', at);

    assert.equal(await mod.adapter('claude')?.lastPromptAt?.(session('claude', 'lp-1', file)), at);
  });

  it('reads Grok and Codex out of our own record', async () => {
    // Neither CLI publishes a prompt clock this side can afford per poll —
    // Grok stamps nothing on a `chat_history.jsonl` row, and Codex writes no
    // transcript file at all. Both sessions are ones we hold the pipe to, so
    // every prompt they took came through the tee.
    //
    // The assistant turn is newer than the prompt in both, which is what
    // separates this from the general activity clock: a session answering its own
    // prompt must not move the clock a tally is dated against, or the tally is
    // silenced by the very turn the agent wrote its progress file during.
    for (const [brand, id, at] of [
      ['grok', 'lp-grok', 4000],
      ['codex', 'lp-codex', 7000]
    ] as const) {
      await record.appendLine(id, { role: 'user', text: 'go', at });
      await record.appendLine(id, { role: 'assistant', text: 'on it', at: at + 5000 });

      assert.equal(await mod.adapter(brand)?.lastPromptAt?.(session(brand, id)), at);
    }
  });

  it('says nothing rather than guessing, on every brand', async () => {
    for (const brand of brands.BRANDS) {
      assert.equal(
        await mod.adapter(brand)?.lastPromptAt?.(session(brand, 'lp-silent', '/nowhere.jsonl')),
        undefined,
        `${brand} invented a prompt time for a session with no source`
      );
    }
  });

  it('is answered by every brand, so no tally is undateable', () => {
    for (const brand of brands.BRANDS) {
      assert.equal(typeof mod.adapter(brand)?.lastPromptAt, 'function', `${brand} cannot say`);
    }
  });
});

describe('readImage', () => {
  /** A Claude transcript holding one pasted image, in that CLI's own shape —
   *  the `t|` ref is the one address no module of ours mints. */
  async function pasted(name: string, uuid: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-image-'));
    const file = path.join(dir, `${name}.jsonl`);
    await fs.writeFile(
      file,
      `${JSON.stringify({
        type: 'user',
        uuid,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
          ]
        }
      })}\n`
    );
    return file;
  }

  it('reads Claude an image only its own file is holding', async () => {
    const file = await pasted('img-claude', 'u-img');

    assert.equal(
      await mod.adapter('claude')?.readImage?.(file, 't|u-img|1'),
      'data:image/png;base64,AAAA'
    );
  });

  it('says nothing for an address that file does not carry', async () => {
    const file = await pasted('img-miss', 'u-miss');

    assert.equal(await mod.adapter('claude')?.readImage?.(file, 't|elsewhere|1'), undefined);
    // `f|` and `r|` name a file; they are `core/record.ts`'s and are answered
    // off disk before anything reaches this port at all.
    assert.equal(await mod.adapter('claude')?.readImage?.(file, 'f|u|0.0|/tmp/a.png'), undefined);
  });

  it('is absent for a brand whose embedded-image address is unmeasured', () => {
    // Absent is the contract, not an omission. Every ref the panel has seen
    // either brand carry names a file, and `refFile` answers it off disk; a
    // guessed scheme would draw a missing picture rather than the right one.
    assert.equal(typeof mod.adapter('claude')?.readImage, 'function');
    assert.equal(typeof mod.adapter('grok')?.readImage, 'undefined');
    assert.equal(typeof mod.adapter('codex')?.readImage, 'undefined');
  });
});

describe('activity clock policy', () => {
  it('never moves for a warm turn, whatever it says, and still moves the cache clock', () => {
    for (const origin of ['local', 'agent', 'prompt'] as const) {
      for (const status of ['idle', 'busy', 'waiting'] as const) {
        for (const turned of [false, true]) {
          assert.equal(mod.advancesActivityClock({ origin, status, turned, warm: true }), false);
        }
      }
    }
    assert.equal(
      mod.advancesActivityClock({ origin: 'prompt', status: 'idle', turned: false, warm: false }),
      true,
      'a real prompt after it still counts'
    );
    assert.equal(
      mod.advancesCacheClock({ origin: 'agent', running: true, wasRunning: false }),
      true
    );
  });
});

describe('cache clock policy', () => {
  it('moves only for confirmed agent traffic during and ending a turn', () => {
    for (const origin of ['local', 'agent', 'prompt'] as const) {
      for (const running of [false, true]) {
        for (const wasRunning of [false, true]) {
          assert.equal(
            mod.advancesCacheClock({ origin, running, wasRunning }),
            origin === 'agent' && (running || wasRunning)
          );
        }
      }
    }
  });
});

it('keeps dispatch and failed-write cleanup off the cache clock', () => {
  let at = 1000;
  let wasRunning = false;
  const apply = (
    origin: import('../../core/adapter').ChangeOrigin,
    running: boolean,
    now: number,
    cacheTraffic?: false
  ) => {
    if (mod.advancesCacheClock({ origin, running, wasRunning, cacheTraffic })) at = now;
    wasRunning = running;
  };
  apply('prompt', true, 2000);
  apply('agent', false, 3000, false);
  assert.equal(at, 1000);
  apply('prompt', true, 4000);
  apply('agent', true, 5000);
  assert.equal(at, 5000);
  apply('agent', false, 6000);
  assert.equal(at, 6000);
  apply('agent', false, 7000);
  apply('local', false, 8000);
  assert.equal(at, 6000);
});

it('moves the cache clock for an admitted completion without an opening frame', () => {
  assert.equal(
    mod.advancesCacheClock({
      origin: 'agent',
      running: false,
      wasRunning: false,
      cacheTraffic: true
    }),
    true
  );
  assert.equal(
    mod.advancesCacheClock({
      origin: 'agent',
      running: false,
      wasRunning: false,
      cacheTraffic: false
    }),
    false
  );
});

describe('the Claude adapter', () => {
  const claude = () => {
    const cli = mod.adapter('claude');
    assert.ok(cli);
    return cli;
  };

  /**
   * The manifest half is the point: an adapter naming a key `package.json` does
   * not contribute is a settings box nobody can find, so a reader whose binary
   * is neither on the host's `PATH` nor at the well-known path has no lever at
   * all. Grok shipped that way until this test was written.
   */
  it('names the setting its path lives in, and the manifest declares it', async () => {
    assert.equal(claude().pathSetting, 'claudePath');
    const manifest = JSON.parse(
      await fs.readFile(path.join(repoRoot(), 'package.json'), 'utf8')
    ) as { contributes: { configuration: { properties: Record<string, unknown> } } };
    for (const brand of brands.BRANDS) {
      const setting = mod.adapter(brand)?.pathSetting;
      assert.ok(setting, `${brand} names no setting its binary path lives in`);
      assert.ok(
        `squadron.${setting}` in manifest.contributes.configuration.properties,
        `squadron.${setting} is not contributed by package.json`
      );
    }
  });
});
