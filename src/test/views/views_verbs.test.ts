import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initial } from '../../core/live';
import type { Session, SessionStatus } from '../../core/model';
import { composeThread, toCard } from '../../ui/views';
import { session } from '../views_helpers';

/** Which verbs a card or thread offers, each decided once in `ui/views.ts`. */
describe('verbs offered', () => {
  it('offers Interrupt only on an opened turn of a session not being ended', () => {
    const statuses: SessionStatus[] = ['busy', 'waiting', 'idle', 'unknown'];
    const flags = [false, true] as const;
    for (const status of statuses)
      for (const turnPending of flags)
        for (const closing of flags)
          for (const endStuck of flags)
            for (const owned of flags) {
              const facts: Partial<Session> = {
                status,
                ...(turnPending ? { turnPending: true } : {}),
                ...(closing ? { closing: true } : {}),
                ...(endStuck ? { endStuck: true } : {}),
                ...(owned ? { source: 'owned' } : {})
              };
              const open = status === 'busy' || (status === 'waiting' && owned);
              assert.equal(
                toCard(session(facts)).canInterrupt,
                open && !turnPending && !closing && !endStuck,
                JSON.stringify(facts)
              );
            }
  });

  it('offers no Interrupt on a session nothing here controls', () => {
    for (const status of ['busy', 'waiting'] as const) {
      const card = toCard(session({ status, source: 'owned', background: true }));
      assert.equal(card.canControl, false);
      assert.equal(card.canInterrupt, false, status);
    }
  });

  it('offers a model per message only through a live pipe holding the port', () => {
    const half = initial({ cwd: '/w', startedAt: 1 });
    const exited = { ...half, exit: { code: 0, signal: null } };
    const history = { exchanges: [] };
    const cases = [
      ['owned, live, port', session({ source: 'owned' }), half, true, true],
      ['owned, live, no port', session({ source: 'owned' }), half, false, false],
      ['owned, exited, port', session({ source: 'owned' }), exited, true, false],
      ['owned, no live half, port', session({ source: 'owned' }), undefined, true, false],
      ['not owned, live, port', session({}), half, true, false]
    ] as const;
    for (const [label, s, live, messages, offered] of cases) {
      assert.equal(composeThread(s, { history, live }, { messages }).canModel, offered, label);
    }
  });
});
