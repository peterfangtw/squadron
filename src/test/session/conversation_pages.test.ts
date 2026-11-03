import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { disposeHome, tempHome } from '../home';

type Pages = typeof import('../../core/conversation_pages');
type Conversation = import('../../core/conversations').Conversation;
let pages: Pages;
let names: typeof import('../../core/names');
let home: string;

const NOW = 40 * 86400000;
const ASKED = path.resolve('/repo/app');
const SIBLING = path.resolve('/repo/web');

before(async () => {
  home = await tempHome();
  pages = await import('../../core/conversation_pages');
  names = await import('../../core/names');
});
after(async () => disposeHome(home));

/** `n` rows newest first, `<prefix>0` the newest, `minutes` apart. */
function rows(n: number, prefix: string, cwd = SIBLING, newest = NOW): Conversation[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `${prefix}${i}`,
    title: `Prompt ${prefix}${i}`,
    titled: false,
    lastActivity: newest - i * 60_000,
    cwd,
    brand: 'codex' as const
  }));
}

const ids = (list: readonly Conversation[]): string[] => list.map((row) => row.sessionId);

/** Every page of a list, following `next` as the picker does. */
function walk(ranking: import('../../core/conversation_pages').Ranking, query = ''): string[][] {
  const out: string[][] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const next: import('../../core/conversation_pages').Page = pages.page(ranking, offset, query);
    out.push(ids(next.rows));
    offset = next.next;
  }
  return out;
}

describe('conversation pages', () => {
  it('serves a family smaller than one page whole, with no next page', () => {
    const ranking = pages.rank(rows(5, 's'), ASKED);
    assert.deepEqual(walk(ranking), [ids(rows(5, 's'))]);
  });

  it('ends after exactly one page', () => {
    const ranking = pages.rank(rows(20, 's'), ASKED);
    const first = pages.page(ranking, 0);
    assert.equal(first.rows.length, 20);
    assert.equal(first.next, undefined);
  });

  it('pulls asked-folder rows onto page 1 and serves the displaced rows later, once each', () => {
    const family = [...rows(30, 's'), ...rows(3, 'a', ASKED, NOW - 86400000)];
    const ranking = pages.rank(family, ASKED);
    const served = walk(ranking);
    assert.deepEqual(served[0], [...ids(rows(17, 's')), 'a0', 'a1', 'a2']);
    assert.deepEqual(served[1], ids(rows(30, 's').slice(17)));
    assert.equal(served.length, 2);
    assert.deepEqual(new Set(served.flat()).size, family.length);
  });

  it('answers an offset past the end with nothing and no next page', () => {
    const ranking = pages.rank(rows(25, 's'), ASKED);
    assert.deepEqual(pages.page(ranking, 100), { rows: [] });
    assert.deepEqual(pages.page(ranking, 20), { rows: rows(25, 's').slice(20) });
  });

  it('stops offering pages at 500 rows, for the list and for a query', () => {
    const ranking = pages.rank(rows(600, 's'), ASKED);
    for (const query of ['', 'prompt']) {
      const served = walk(ranking, query);
      assert.equal(served.length, 25, query);
      assert.equal(served.flat().length, 500, query);
      assert.deepEqual(pages.page(ranking, 500, query), { rows: [] });
    }
  });

  it('searches every row by activity alone, with no asked-folder floor', () => {
    // `s17` is newer than both asked rows, but the floor pushes it off page 1.
    const family = [
      ...rows(30, 's').map((row) =>
        row.sessionId === 's17' ? { ...row, title: 'Ledger s17' } : row
      ),
      ...rows(2, 'a', ASKED, NOW - 86400000).map((row) => ({
        ...row,
        title: `Ledger ${row.sessionId}`
      })),
      { ...rows(1, 'old')[0]!, title: 'ledger rounding', lastActivity: NOW - 2 * 86400000 },
      { ...rows(1, 'new')[0]!, title: 'LEDGER export', lastActivity: NOW + 1 }
    ];
    const ranking = pages.rank(family, ASKED);
    assert.deepEqual(
      pages
        .page(ranking, 0)
        .rows.slice(-2)
        .map((row) => row.sessionId),
      ['a0', 'a1']
    );
    assert.deepEqual(walk(ranking, '  ledger '), [['new0', 's17', 'a0', 'a1', 'old0']]);
    assert.deepEqual(pages.page(ranking, 0, 'no such words'), { rows: [] });
  });

  it('captures stated names per key, so search finds a row by its name alone', async () => {
    const family = rows(30, 's');
    assert.ok(await names.writeStatedName('codex', 's25', 'Quarterly ledger', NOW));
    const ranking = pages.rank(await pages.named(family), ASKED);
    const found = pages.page(ranking, 0, 'quarterly');
    assert.deepEqual(
      found.rows.map((row) => [row.sessionId, row.title, row.titled]),
      [['s25', 'Quarterly ledger', true]]
    );
    assert.deepEqual(pages.page(ranking, 0, 'Prompt s25'), { rows: [] });
    // Captured once: a rename after the open changes nothing in this snapshot.
    assert.ok(await names.writeStatedName('codex', 's25', 'Renamed later', NOW + 1));
    assert.equal(pages.page(ranking, 0, 'quarterly').rows[0]?.title, 'Quarterly ledger');
  });
});

describe('the snapshot a panel holds', () => {
  function held(): {
    snapshots: InstanceType<Pages['ConversationSnapshots']>;
    advance: (ms: number) => void;
  } {
    let now = 0;
    let timers: { at: number; run: () => void; cancelled: boolean }[] = [];
    const snapshots = new pages.ConversationSnapshots(
      () => now,
      (run, ms) => {
        const timer = { at: now + ms, run, cancelled: false };
        timers.push(timer);
        return { cancel: () => (timer.cancelled = true) };
      }
    );
    return {
      snapshots,
      advance: (ms) => {
        now += ms;
        const due = timers.filter((timer) => !timer.cancelled && timer.at <= now);
        timers = timers.filter((timer) => !due.includes(timer));
        for (const timer of due) timer.run();
      }
    };
  }
  const ranking = (): import('../../core/conversation_pages').Ranking =>
    pages.rank(rows(3, 's'), ASKED);

  it('answers its own id and folder only, and a new open replaces it', () => {
    const { snapshots } = held();
    snapshots.hold('one', ASKED, ranking());
    assert.ok(snapshots.ranking('one', ASKED));
    assert.equal(snapshots.ranking('one', SIBLING), undefined);
    assert.equal(snapshots.ranking('two', ASKED), undefined);
    snapshots.hold('two', ASKED, ranking());
    assert.equal(snapshots.ranking('one', ASKED), undefined);
    assert.ok(snapshots.ranking('two', ASKED));
  });

  it('drops a snapshot left unused for ten minutes, and a page keeps it for another ten', () => {
    const { snapshots, advance } = held();
    snapshots.hold('one', ASKED, ranking());
    advance(9 * 60_000);
    assert.ok(snapshots.ranking('one', ASKED));
    advance(9 * 60_000);
    assert.ok(snapshots.ranking('one', ASKED), 'a page did not keep the snapshot');
    advance(10 * 60_000);
    assert.equal(snapshots.ranking('one', ASKED), undefined);
  });

  it('drops it on dispose', () => {
    const { snapshots } = held();
    snapshots.hold('one', ASKED, ranking());
    snapshots.dispose();
    assert.equal(snapshots.ranking('one', ASKED), undefined);
  });
});
