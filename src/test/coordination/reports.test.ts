import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { resetDir, tempHome, writeJson } from '../helpers';
import { REPORTS_PER_MEMBER } from '../../core/coordination/guards';
import type { ParkedReport } from '../../core/coordination/reports';
import type { WaitRecord } from '../../core/coordination/wait';

type Reports = typeof import('../../core/coordination/reports');
type Paths = typeof import('../../core/paths');

let reports: Reports;
let paths: Paths;

before(async () => {
  // Imported after the home moves, `wait.test.ts`'s reason: `core/paths.ts`
  // resolves its directories once, at load.
  await tempHome();
  paths = await import('../../core/paths');
  reports = await import('../../core/coordination/reports');
});

/**
 * A report parked against an open wait, and the arithmetic that decides whether
 * to park one at all.
 *
 * Every case in the second suite is a line of `PRD_shipped_wait_report_attachment.md`
 * §5.1 or a row of S6, and that is why the rule is pure: "the message went to
 * the wrong place" and "the message went nowhere" look identical from outside,
 * and a fan-out that reproduces one of them takes minutes to set up and does
 * not repeat.
 */

const NOW = 1_700_000_000_000;

function wait(over: Partial<WaitRecord> = {}): WaitRecord {
  return {
    schema: 1,
    id: 'w1',
    requesterPid: 100,
    requesterSessionId: 'requester-session',
    members: [201, 202],
    createdAt: NOW - 60_000,
    expiresAt: NOW + 60_000,
    ...over
  };
}

function parked(over: Partial<ParkedReport> = {}): ParkedReport {
  return {
    schema: 1,
    id: 'r1',
    waitId: 'w1',
    requesterPid: 100,
    senderPid: 201,
    senderSessionId: 'child-a',
    payload: 'child A done, count in /tmp/wait-exp/a.md',
    at: NOW - 30_000,
    ...over
  };
}

describe('the parked reports on disk', () => {
  async function clear(): Promise<void> {
    await resetDir(paths.REPORTS_DIR);
  }

  it('round-trips a parked report', async () => {
    await clear();
    assert.equal(await reports.writeReport(parked()), true);
    assert.deepEqual(await reports.readReports(), [parked()]);
  });

  it('forgets one by id', async () => {
    await clear();
    await reports.writeReport(parked());
    await reports.writeReport(parked({ id: 'r2' }));
    await reports.dropReport('r1');
    assert.deepEqual(
      (await reports.readReports()).map((r) => r.id),
      ['r2']
    );
  });

  it('takes the id from the filename, not from the field inside', async () => {
    await clear();
    // `core/coordination/wait.ts`'s rule, for `core/coordination/wait.ts`'s reason: written equal, edited
    // apart, a delivery would remove the file the field names rather than the
    // one it just read — and that file is somebody's undelivered words.
    await writeJson(path.join(paths.REPORTS_DIR, 'real.json'), parked({ id: 'elsewhere' }));
    const [only] = await reports.readReports();
    assert.equal(only?.id, 'real');
  });

  it('removes a record that is not one of ours', async () => {
    await clear();
    await writeJson(path.join(paths.REPORTS_DIR, 'other.json'), { ...parked(), schema: 2 });
    assert.deepEqual(await reports.readReports(), []);
    assert.deepEqual(await fs.readdir(paths.REPORTS_DIR), []);
  });

  it('removes one whose sender is not a pid', async () => {
    await clear();
    // Narrowed rather than cast, and this is the case that made it worth doing:
    // a `senderPid` that is a string matches no member line, so the report
    // would render under nobody and be deleted with the rest of them.
    await writeJson(path.join(paths.REPORTS_DIR, 'bad.json'), { ...parked(), senderPid: '201' });
    assert.deepEqual(await reports.readReports(), []);
    assert.deepEqual(await fs.readdir(paths.REPORTS_DIR), []);
  });

  it('removes one whose sender name is not a name', async () => {
    await clear();
    // Narrowed even though it is optional, because it is read as an *author*:
    // `wrapMessage` takes it verbatim, so a stored number would deliver a peer
    // message signed `from="42"` — a pid standing where a sessionId belongs,
    // which is the one field a reader cannot check.
    await writeJson(path.join(paths.REPORTS_DIR, 'bad.json'), {
      ...parked(),
      senderSessionId: 42
    });
    assert.deepEqual(await reports.readReports(), []);
    assert.deepEqual(await fs.readdir(paths.REPORTS_DIR), []);
  });

  it('keeps one that names no sender at all', async () => {
    await clear();
    // Optional stays optional: absent is an older record, and the release path
    // has a fallback for it.
    const { senderSessionId, ...anonymous } = parked();
    void senderSessionId;
    await writeJson(path.join(paths.REPORTS_DIR, 'r1.json'), anonymous);
    assert.equal((await reports.readReports()).length, 1);
  });

  it('removes one carrying no words', async () => {
    await clear();
    await writeJson(path.join(paths.REPORTS_DIR, 'bad.json'), { ...parked(), payload: 42 });
    assert.deepEqual(await reports.readReports(), []);
  });

  it('sweeps what a dead host left behind', async () => {
    await clear();
    await reports.writeReport(parked());
    const file = path.join(paths.REPORTS_DIR, 'r1.json');
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await fs.utimes(file, new Date(old), new Date(old));
    await reports.pruneReports();
    assert.deepEqual(await fs.readdir(paths.REPORTS_DIR), []);
  });

  it('is a store the home tree makes on activate', () => {
    assert.ok(paths.STORE_DIRS.includes(paths.REPORTS_DIR));
  });
});

describe('whether a send is held against an open wait', () => {
  const open = [wait()];

  it('parks a member’s report to its requester', () => {
    const verdict = reports.parkFor({
      waits: open,
      reports: [],
      toPid: 100,
      fromPid: 201,
      now: NOW
    });
    assert.deepEqual(verdict, { kind: 'park', wait: wait() });
  });

  // S6: everything below behaves exactly as it does today, and `undefined` is
  // how this module says "not my business".
  const untouched: [string, { toPid: number; fromPid: number | undefined }][] = [
    ['a non-member writing to the requester', { toPid: 100, fromPid: 999 }],
    ['a member writing to a sibling', { toPid: 202, fromPid: 201 }],
    ['a member writing to a stranger', { toPid: 500, fromPid: 201 }],
    ['a sender nobody could place', { toPid: 100, fromPid: undefined }]
  ];
  for (const [what, addressed] of untouched) {
    it(`leaves ${what} alone`, () => {
      assert.equal(
        reports.parkFor({ waits: open, reports: [], now: NOW, ...addressed }),
        undefined
      );
    });
  }

  it('leaves a report alone when no wait is open at all', () => {
    assert.equal(
      reports.parkFor({ waits: [], reports: [], toPid: 100, fromPid: 201, now: NOW }),
      undefined
    );
  });

  it('never parks against a refused wait', () => {
    // A `failed` record is never evaluated again, so a report held behind one
    // would never move — the silent hang, rebuilt inside the feature.
    const refused = [wait({ failed: { reason: 'too full to be told', at: NOW } })];
    assert.equal(
      reports.parkFor({ waits: refused, reports: [], toPid: 100, fromPid: 201, now: NOW }),
      undefined
    );
  });

  it('never parks against a wait whose deadline has passed', () => {
    assert.equal(
      reports.parkFor({ waits: open, reports: [], toPid: 100, fromPid: 201, now: NOW + 120_000 }),
      undefined
    );
  });

  it('releases that member’s reports, in order, when it reaches the cap', () => {
    const held = Array.from({ length: REPORTS_PER_MEMBER }, (_, i) =>
      parked({ id: `r${i}`, at: NOW - (REPORTS_PER_MEMBER - i) * 1_000 })
    );
    const verdict = reports.parkFor({
      // Shuffled, so the order in the answer is the rule rather than the order
      // `readReports` happened to return.
      waits: open,
      reports: [...held].reverse(),
      toPid: 100,
      fromPid: 201,
      now: NOW
    });
    assert.equal(verdict?.kind, 'release');
    assert.deepEqual(
      verdict?.kind === 'release' ? verdict.reports.map((r) => r.id) : [],
      held.map((r) => r.id)
    );
  });

  it('counts the cap per member, not per wait', () => {
    // One chatty member must not spend the other's allowance.
    const held = Array.from({ length: REPORTS_PER_MEMBER }, (_, i) =>
      parked({ id: `r${i}`, senderPid: 201 })
    );
    const verdict = reports.parkFor({
      waits: open,
      reports: held,
      toPid: 100,
      fromPid: 202,
      now: NOW
    });
    assert.equal(verdict?.kind, 'park');
  });

  it('counts the cap per wait, not across every wait on the machine', () => {
    const held = Array.from({ length: REPORTS_PER_MEMBER }, (_, i) =>
      parked({ id: `r${i}`, waitId: 'somebody-else' })
    );
    const verdict = reports.parkFor({
      waits: open,
      reports: held,
      toPid: 100,
      fromPid: 201,
      now: NOW
    });
    assert.equal(verdict?.kind, 'park');
  });
});

describe('reports with no wait left to ride', () => {
  it('names the ones whose wait is gone', () => {
    const { release, strand } = reports.orphaned({
      waits: [wait({ id: 'w2' })],
      reports: [parked({ waitId: 'w1' })],
      owned: (pid) => pid === 100
    });
    assert.deepEqual(
      release.map((r) => r.id),
      ['r1']
    );
    assert.deepEqual(strand, []);
  });

  it('names the ones whose wait was refused', () => {
    // The load-bearing one: nothing evaluates a `failed` record again, so a
    // report behind one is never delivered and never released unless this
    // finds it.
    const { release } = reports.orphaned({
      waits: [wait({ failed: { reason: 'too full', at: NOW } })],
      reports: [parked()],
      owned: () => true
    });
    assert.deepEqual(
      release.map((r) => r.id),
      ['r1']
    );
  });

  it('leaves a report whose wait is still open', () => {
    const { release, strand } = reports.orphaned({
      waits: [wait()],
      reports: [parked()],
      owned: () => true
    });
    assert.deepEqual(release, []);
    assert.deepEqual(strand, []);
  });

  it('strands, rather than releases, one whose requester no window owns', () => {
    // A reload takes every owned child with it, so this requester is not coming
    // back and there is no pipe to put the words on. Named separately because
    // the caller must log it rather than retry it every pass for a day.
    const { release, strand } = reports.orphaned({
      waits: [],
      reports: [parked()],
      owned: () => false
    });
    assert.deepEqual(release, []);
    assert.deepEqual(
      strand.map((r) => r.id),
      ['r1']
    );
  });
});

describe('who a released report is attributed to', () => {
  // `send.test.ts` owns the wrapper bytes. This chooses the author only.
  const { senderSessionId, ...legacy } = parked({ senderPid: 201 });
  void senderSessionId;
  const rows: readonly [
    string,
    { readonly senderSessionId?: string; readonly senderPid: number },
    string
  ][] = [
    [
      'a stored session id',
      parked({ senderSessionId: '550e8400-e29b-41d4-a716-446655440000', senderPid: 201 }),
      '550e8400-e29b-41d4-a716-446655440000'
    ],
    [
      'a stored id with a quote and an ampersand',
      parked({ senderSessionId: 'say "a&b"', senderPid: 201 }),
      'say "a&b"'
    ],
    ['a report with no session id', legacy, '201'],
    ['an empty stored session id', parked({ senderSessionId: '', senderPid: 201 }), '']
  ];

  it('uses the stored session id, or the report sender pid when that id is absent', () => {
    for (const [what, report, author] of rows) {
      assert.equal(reports.releaseAuthor(report), author, what);
    }
  });
});
