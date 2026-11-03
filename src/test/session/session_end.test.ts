import * as assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';
import type { EndPort, EndTarget, EndObservation } from '../../core/session_end';
import type { AskResult } from '../../core/coordination/ask';
import type { Reply } from '../../core/coordination/requests';

let execution: typeof import('../../core/session_end');
before(async () => {
  await tempHome();
  execution = await import('../../core/session_end');
});
const target: EndTarget = { pid: 42, startedAt: 10000, windowId: 'owner' };
const silent: AskResult = { ok: false, kind: 'silent', reason: 'no reply', file: 'request' };
const accepted: AskResult = { ok: true, reply: { ok: true }, file: 'request' };
const refusal = (reply: Reply): AskResult => ({
  ok: false,
  kind: 'refused',
  reason: reply.reason ?? 'refused',
  reply,
  file: 'request'
});
function port(over: Partial<EndPort> = {}): EndPort {
  return {
    ask: () => Promise.resolve(silent),
    observe: (targets) => Promise.resolve(targets.map(() => ({ kind: 'running' }))),
    ...over
  };
}

describe('shared End execution', () => {
  it('observes fresh ownership only for the matching process incarnation', async (t) => {
    const scan = await import('../../core/scan');
    const published = await import('../../core/published');
    const { session } = await import('../views_helpers');
    const snapshot: import('../../core/scan').ProcessTable = {
      complete: true,
      claude: new Map(),
      grok: new Map(),
      codex: new Map(),
      parents: new Map(),
      starts: new Map([[42, 10000]]),
      groups: new Map(),
      shellParents: new Set()
    };
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(snapshot));
    const record: import('../../core/published').PublishedLive = {
      schema: 1,
      session: session({ pid: 42, startedAt: 10000, source: 'owned', windowId: 'new-owner' }),
      pending: [],
      queued: []
    };
    assert.equal(await published.publishLive(record), true);
    assert.deepEqual(await execution.observeEnds([target]), [
      { kind: 'running', windowId: 'new-owner' }
    ]);
    await published.publishLive({ ...record, session: { ...record.session, startedAt: 70000 } });
    assert.deepEqual(
      await execution.observeEnds([target]),
      [{ kind: 'running' }],
      'a stale publication cannot donate its owner'
    );
    snapshot.starts.set(42, 70000);
    assert.deepEqual(
      await execution.observeEnds([target]),
      [{ kind: 'gone' }],
      'a reused PID is never the old session'
    );
    snapshot.starts.set(42, 10000);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const paths = await import('../../core/paths');
    await fs.writeFile(path.join(paths.LIVE_DIR, '42.json'), '{broken');
    assert.deepEqual(
      await execution.observeEnds([target]),
      [{ kind: 'unknown' }],
      'a malformed publication cannot authorize fallback'
    );
    snapshot.complete = false;
    assert.deepEqual(
      await execution.observeEnds([target]),
      [{ kind: 'unknown' }],
      'incomplete scans cannot prove exit'
    );
    await published.removePublished(42);
  });

  it('uses a matching local handle without requests or fallback work', async () => {
    let closed = 0;
    const io = port({
      local: {
        windowId: 'owner',
        owned: () => ({
          state: {
            cwd: '/work',
            startedAt: 10000,
            status: 'idle',
            running: false,
            pending: [],
            queued: [],
            turnsEnded: 0
          }
        }),
        end: (pid, start) => {
          assert.deepEqual([pid, start], [42, 10000]);
          closed++;
          return true;
        }
      },
      ask: () => {
        assert.fail('local close must not request another window');
      },
      observe: () => {
        assert.fail('accepted close must not inspect processes');
      },
      signal: () => {
        assert.fail('accepted close must not signal');
      }
    });
    const [result] = await execution.endSessions([target], io);
    assert.deepEqual(result?.outcome, { ok: true, kind: 'closing' });
    assert.equal(closed, 1);
  });

  it('waits for native shutdown when a pipe failure already latched exit', async () => {
    let ending = false;
    const [result] = await execution.endSessions(
      [target],
      port({
        local: {
          windowId: 'owner',
          ending: () => ending,
          owned: () => ({
            state: {
              cwd: '/work',
              startedAt: 10000,
              status: 'unknown',
              running: false,
              pending: [],
              queued: [],
              turnsEnded: 0,
              exit: { code: null, signal: null }
            }
          }),
          end: () => {
            ending = true;
            return true;
          }
        }
      })
    );
    assert.deepEqual(result?.outcome, { ok: true, kind: 'closing' });
  });

  it('cleans an exited local entry instead of leaving it registered', async () => {
    let removed = false;
    const [result] = await execution.endSessions(
      [target],
      port({
        local: {
          windowId: 'owner',
          owned: () => ({
            state: {
              cwd: '/work',
              startedAt: 10000,
              status: 'idle',
              running: false,
              pending: [],
              queued: [],
              turnsEnded: 0,
              exit: { code: 0, signal: null }
            }
          }),
          end: () => {
            removed = true;
            return true;
          }
        },
        observe: () => {
          assert.fail('the local owner knows it exited');
        }
      })
    );
    assert.equal(removed, true);
    assert.deepEqual(result?.outcome, { ok: true, kind: 'gone' });
  });

  it('accepts a remote close without inspecting or signalling', async () => {
    const asked: unknown[] = [];
    const [result] = await execution.endSessions(
      [target],
      port({
        ask: (request) => {
          asked.push(request);
          return Promise.resolve(accepted);
        },
        observe: () => {
          assert.fail('accepted request must not inspect');
        }
      })
    );
    assert.deepEqual(asked, [{ ...target, kind: 'close' }]);
    assert.deepEqual(result?.outcome, { ok: true, kind: 'closing' });
  });

  for (const reply of [
    { ok: false, reason: 'declined' },
    { ok: false, reason: 'legacy refusal' }
  ] satisfies Reply[]) {
    it(`preserves a terminal refusal: ${reply.reason}`, async () => {
      const [result] = await execution.endSessions(
        [target],
        port({
          ask: () => Promise.resolve(refusal(reply)),
          observe: () => {
            assert.fail('refusal must not enter fallback');
          },
          signal: () => {
            assert.fail('refusal must not signal');
          }
        })
      );
      assert.equal(result?.outcome.ok, false);
      assert.equal(result?.outcome.kind, 'refused');
    });
  }

  for (const [label, request] of [
    [
      'unwritable',
      (): Promise<AskResult> =>
        Promise.resolve({ ok: false, kind: 'unwritable', reason: 'cannot write' })
    ],
    ['unanswered', () => Promise.resolve(silent)],
    [
      'throw',
      (): Promise<AskResult> => {
        throw new Error('broken transport');
      }
    ],
    [
      'owner unavailable',
      () => Promise.resolve(refusal({ ok: false, closeFailure: 'unavailable', reason: 'not held' }))
    ],
    [
      'owner close failed',
      () => Promise.resolve(refusal({ ok: false, closeFailure: 'failed', reason: 'broken pipe' }))
    ],
    [
      'uncertain reply',
      () => Promise.resolve(refusal({ ok: false, unsure: true, reason: 'unknown' }))
    ]
  ] as const) {
    it(`rechecks before permitted signal fallback after ${label}`, async () => {
      const calls: string[] = [];
      const [result] = await execution.endSessions(
        [target],
        port({
          ask: request,
          observe: () => {
            calls.push('observe');
            return Promise.resolve([{ kind: 'running' }]);
          },
          signal: (targets) => {
            calls.push('signal');
            assert.deepEqual(targets, [target]);
            return Promise.resolve(['ended']);
          }
        })
      );
      assert.equal(calls.at(-1), 'signal');
      assert.equal(
        calls.slice(0, -1).every((call) => call === 'observe'),
        true
      );
      assert.ok(calls.length >= 2);
      assert.deepEqual(result?.outcome, { ok: true, kind: 'closing' });
    });
  }

  it('reports an unreachable owner when signal authority is absent', async () => {
    const [result] = await execution.endSessions([target], port());
    assert.equal(result?.outcome.ok, false);
    assert.equal(result?.outcome.kind, 'silent');
  });

  for (const seen of [{ kind: 'gone' }, { kind: 'unknown' }] satisfies EndObservation[]) {
    it(`never signals an observation that is ${seen.kind}`, async () => {
      const [result] = await execution.endSessions(
        [target],
        port({
          observe: () => Promise.resolve([seen]),
          signal: () => {
            assert.fail('unverified identity must not be signalled');
          }
        })
      );
      assert.equal(result?.outcome.ok, seen.kind === 'gone');
    });
  }

  it('reports a session this OS cannot signal as refused, and why', async () => {
    const [result] = await execution.endSessions(
      [target],
      port({
        signal: () =>
          Promise.resolve([
            { supported: false, reason: 'processes.signal is unavailable on win32: W4.1' }
          ])
      })
    );
    assert.equal(result?.outcome.ok, false);
    assert.equal(!result?.outcome.ok && result?.outcome.kind, 'refused');
    assert.match(
      (!result?.outcome.ok && result?.outcome.reason) || '',
      /; processes\.signal is unavailable on win32: W4\.1$/
    );
  });

  it('recovers a lost acknowledgment with one idempotent owner confirmation', async () => {
    let requests = 0;
    const [result] = await execution.endSessions(
      [target],
      port({
        ask: () => Promise.resolve(++requests === 1 ? silent : accepted),
        signal: () => {
          assert.fail('owner confirmed its ongoing close');
        }
      })
    );
    assert.equal(requests, 2);
    assert.deepEqual(result?.outcome, { ok: true, kind: 'closing' });
  });

  it('reaches a newly observed owner before considering signals', async () => {
    const asked: string[] = [];
    const [result] = await execution.endSessions(
      [target],
      port({
        ask: (request) => {
          asked.push(request.windowId);
          return Promise.resolve(request.windowId === 'new-owner' ? accepted : silent);
        },
        observe: () => Promise.resolve([{ kind: 'running', windowId: 'new-owner' }]),
        signal: () => {
          assert.fail('new owner accepted close');
        }
      })
    );
    assert.deepEqual(asked, ['owner', 'new-owner']);
    assert.equal(result?.outcome.ok, true);
  });

  it('revalidates after an ownership retry and stops if ownership changed again', async () => {
    let observations = 0;
    let requests = 0;
    const [result] = await execution.endSessions(
      [target],
      port({
        ask: () => {
          requests++;
          return Promise.resolve(silent);
        },
        observe: () =>
          Promise.resolve([
            { kind: 'running', windowId: ++observations === 1 ? 'second' : 'third' }
          ]),
        signal: () => {
          assert.fail('ownership changed during the request await');
        }
      })
    );
    assert.equal(requests, 2);
    assert.equal(observations, 2);
    assert.equal(result?.outcome.ok, false);
  });

  it('accepts a process that disappeared during a lost-acknowledgment retry', async () => {
    let observations = 0;
    const [result] = await execution.endSessions(
      [target],
      port({
        observe: () =>
          Promise.resolve(
            ++observations === 1 ? [{ kind: 'running', windowId: 'second' }] : [{ kind: 'gone' }]
          ),
        signal: () => {
          assert.fail('process already exited');
        }
      })
    );
    assert.deepEqual(result?.outcome, { ok: true, kind: 'gone' });
  });

  it('keeps every member result when observation or signalling fails', async () => {
    const targets = [target, { ...target, pid: 43 }];
    for (const io of [
      port({
        observe: () => {
          throw new Error('scan failed');
        },
        signal: () => {
          assert.fail('failed observation');
        }
      }),
      port({
        signal: () => {
          throw new Error('signal failed');
        }
      }),
      port({ signal: () => Promise.resolve([]) })
    ]) {
      const results = await execution.endSessions(targets, io);
      assert.equal(results.length, 2);
      assert.equal(
        results.every(({ outcome }) => !outcome.ok),
        true
      );
    }
  });

  it('keeps an accepted End pending beyond the old grace period', async (t) => {
    t.mock.method(Date, 'now', () => 1_000_000);
    let signalled = false;
    const [result] = await execution.endSessions(
      [target],
      port({
        local: {
          windowId: 'owner',
          owned: () => undefined,
          end: () => {
            assert.fail('no handle remains');
          },
          ending: () => true
        },
        signal: () => {
          signalled = true;
          return Promise.resolve(['ended']);
        }
      })
    );
    assert.equal(signalled, false, 'elapsed time cannot turn pending termination into recovery');
    assert.deepEqual(result?.outcome, { ok: true, kind: 'closing' });
  });

  it('acknowledges an overlapping End while native shutdown is pending', async () => {
    let held = true;
    let ending = false;
    const io = port({
      local: {
        windowId: 'owner',
        owned: () =>
          held
            ? {
                state: {
                  cwd: '/work',
                  startedAt: 10000,
                  status: 'idle',
                  running: false,
                  pending: [],
                  queued: [],
                  turnsEnded: 0
                }
              }
            : undefined,
        ending: () => ending,
        end: () => {
          held = false;
          ending = true;
          return true;
        }
      },
      observe: () => {
        assert.fail('the owner still manages shutdown');
      },
      signal: () => {
        assert.fail('the first End already completed');
      }
    });
    const [first, second] = await Promise.all([
      execution.endSessions([target], io),
      execution.endSessions([target], io)
    ]);
    assert.equal(first[0]?.outcome.ok, true);
    assert.deepEqual(second[0]?.outcome, { ok: true, kind: 'closing' });
  });
});
