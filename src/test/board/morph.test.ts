import { ticketPriority, ticketState, ticketSourceView } from '../ticket_fixtures';
import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { type Panel, cardView, groupView, openPanel, stateMessage } from '../harness';

describe('every acting node a morph writes is keyed', () => {
  /**
   * The containers `morph()` and `morphNode()` repaint. An unkeyed node is a
   * hazard only there, where morphdom matches it by position. The dock's held
   * message row (`chat_turns.ts`) sets `data-act` too and is out of scope: the
   * thread does not go through morphdom.
   */
  const ROOTS = ['#cards', '#nav', '#bottomhub-waiting', '#tk-list', '#board-tickets'];

  /** What each scenario below has to reach, so a fixture that stops drawing a
   *  site fails here instead of passing over an empty set. */
  const REACHED = [
    'ask',
    'clearFilter',
    'connect',
    'killListener',
    'lane',
    'open',
    'openServer',
    'openServers',
    'readTicket',
    'resume',
    'select',
    'stopServer',
    'sessions',
    'tickets'
  ];

  const sweep = (p: Panel, acts: Set<string>, unkeyed: string[]): void => {
    for (const root of ROOTS) {
      for (const node of p.window.document.querySelectorAll<HTMLElement>(`${root} [data-act]`)) {
        const act = node.dataset.act ?? '';
        acts.add(act);
        if (!node.dataset.key) unkeyed.push(`${root} [data-act="${act}"] <${node.tagName}>`);
      }
    }
  };

  const waiting = (pid: number) => cardView({ pid, name: 'w' + pid, status: 'waiting' });
  const ticket = (over: Partial<TicketView> = {}): TicketView => ({
    scopeId: 'team-a',
    key: 'i1',
    identifier: 'ENG-1',
    title: 'a bug',
    priority: ticketPriority(2),
    state: ticketState('In Progress'),
    url: 'https://linear.app/x/ENG-1',
    ...over
  });
  const linear = (states: string[]) => ({
    ...ticketSourceView(),
    linked: true,
    filter: { assignee: 'me', states, priorities: [] },
    options: {
      scopeId: 'team-a',
      assignees: [{ id: 'me', label: 'Me' }],
      states: [ticketState('To Do'), ticketState('In Progress')],
      priorities: [{ ...ticketPriority(2), label: 'High' }]
    }
  });
  const board = (over: Parameters<typeof stateMessage>[1]) =>
    stateMessage(
      [
        groupView({
          sessions: [
            cardView({ pid: 3 }),
            cardView({ pid: 7 }),
            cardView({ pid: 8 }),
            ...[20, 21, 22, 23, 24, 25, 26, 27, 28].map(waiting)
          ],
          // The parent outside its own box is what draws the `who` link to it.
          families: [{ parent: 3, members: [7, 8] }],
          servers: [
            {
              branch: 'main',
              tree: '/Users/someone/proj',
              cwd: '/Users/someone/proj',
              runnerId: 'dev',
              label: 'npm run dev'
            },
            {
              branch: 'up',
              tree: '/Users/someone/proj',
              cwd: '/Users/someone/proj',
              runnerId: 'dev',
              label: 'npm run dev',
              status: 'up',
              port: 3000,
              url: 'http://localhost:3000'
            },
            {
              branch: 'alien',
              tree: '/Users/someone/proj',
              cwd: '/Users/someone/proj',
              runnerId: 'dev',
              label: 'npm run dev',
              port: 3002,
              listener: { command: 'node', pid: 4242, startedAt: 1234, session: 'Fix login' }
            }
          ]
        })
      ],
      over
    );

  it('across the board, the waiting stack and the tickets tab', (t: TestContext) => {
    const p = openPanel(t);
    const acts = new Set<string>();
    const unkeyed: string[] = [];

    p.push(
      board({
        ticketSource: linear([]),
        tickets: [ticket(), ticket({ key: 'i2', identifier: 'ENG-2', state: ticketState('To Do') })]
      })
    );
    sweep(p, acts, unkeyed);
    p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
    sweep(p, acts, unkeyed);

    p.push(board({ ticketSource: linear(['To Do']), tickets: [] }));
    sweep(p, acts, unkeyed);

    p.push(board({ ticketSource: { ...ticketSourceView(), linked: false } }));
    sweep(p, acts, unkeyed);

    assert.deepEqual(
      REACHED.filter((act) => !acts.has(act)),
      [],
      'the fixture no longer draws these acts'
    );
    assert.deepEqual(unkeyed, [], 'an acting node with no data-key');
  });
});
