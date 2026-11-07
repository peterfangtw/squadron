import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { before } from 'node:test';
import { holdingHostState, openPanel, panel, section, step } from './boot';
import * as fixtures from '../harness';
import { ticketPriority, ticketSourceView, ticketState } from '../ticket_fixtures';

section('compact board filters, in the real IDE', () => {
  before(openPanel);

  step('aligns session filters left and fits ticket filters beside their source', async () => {
    await holdingHostState(async () => {
      const state = fixtures.stateMessage([], {
        ticketSource: ticketSourceView({
          filter: { assignee: 'me', states: [], priorities: [] },
          options: {
            scopeId: 'team-a',
            assignees: [{ id: 'me', label: 'Me' }],
            states: [ticketState('In Progress')],
            priorities: [ticketPriority(2)]
          }
        }),
        tickets: []
      });
      const board = panel().locator('#board');
      const originalStyle = await board.getAttribute('style');
      try {
        await board.evaluate((n) => {
          n.style.flex = 'none';
          n.style.width = '700px';
        });
        await panel()
          .locator('body')
          .evaluate((_, data) => {
            window.dispatchEvent(new MessageEvent('message', { data }));
          }, state);
        await panel().locator('#board-sessions').click();
        const sessions = await board.evaluate((n) => {
          const filter = n.querySelector('#status-filter')!.getBoundingClientRect();
          return {
            repeatedHeading: n.querySelector('#sessions-head')!.textContent.includes('Sessions'),
            leftAligned: filter.left - n.getBoundingClientRect().left <= 24
          };
        });
        const frameOf = (
          selector: string
        ): Promise<{ top: string; bottom: string; left: string }> =>
          panel()
            .locator(selector)
            .evaluate((n) => {
              const style = getComputedStyle(n);
              return {
                top: style.paddingTop,
                bottom: style.paddingBottom,
                left: style.paddingLeft
              };
            });
        const sessionFilterLeft = await panel()
          .locator('#status-filter')
          .evaluate((n) => n.getBoundingClientRect().left);
        const sessionBody = await frameOf('#cards');
        const sessionFilterTop = await panel()
          .locator('#status-filter')
          .evaluate((n) => n.getBoundingClientRect().top);
        await panel().locator('#board-tickets').click();
        const ticketFilterTop = await panel()
          .locator('#tk-filter .fpill')
          .first()
          .evaluate((n) => n.getBoundingClientRect().top);
        const ticketSourceLeft = await panel()
          .locator('#tk-head .scope-button')
          .evaluate((n) => n.getBoundingClientRect().left);
        const ticketBody = {
          ...(await frameOf('#tk-list')),
          left: (await frameOf('.tkcolumns')).left
        };
        const wide = await board.evaluate((n) => {
          const source = n.querySelector('#tk-head .scope-button')!.getBoundingClientRect();
          const pills = [...n.querySelectorAll('#tk-filter .fpill')];
          return {
            count: pills.length,
            oneRow: pills.every((pill) => {
              const box = pill.getBoundingClientRect();
              return Math.abs(box.top + box.height / 2 - source.top - source.height / 2) <= 1;
            })
          };
        });
        const run = process.env['SQUADRON_RUN'];
        if (run) await board.screenshot({ path: path.join(run, 'filters-wide.png') });
        await board.evaluate((n) => {
          n.style.width = '360px';
        });
        const narrow = await board.evaluate((n) => {
          const frame = n.getBoundingClientRect();
          const pills = [...n.querySelectorAll('#tk-filter .fpill')].map((pill) =>
            pill.getBoundingClientRect()
          );
          const source = n.querySelector('#tk-head .scope-button')!.getBoundingClientRect();
          return {
            oneRow: pills.every(
              (box) => Math.abs(box.top + box.height / 2 - source.top - source.height / 2) <= 1
            ),
            contained: (() => {
              const filter = n.querySelector('#tk-filter')!.getBoundingClientRect();
              const actions = n.querySelector('#tk-actions')!.getBoundingClientRect();
              return filter.left >= frame.left && actions.right <= frame.right;
            })()
          };
        });
        if (run) await board.screenshot({ path: path.join(run, 'filters-narrow.png') });
        assert.deepEqual(
          { sessions, wide, narrow },
          {
            sessions: { repeatedHeading: false, leftAligned: true },
            wide: { count: 3, oneRow: true },
            narrow: { oneRow: true, contained: true }
          }
        );
        assert.equal(ticketSourceLeft, sessionFilterLeft, 'filters shift sideways between tabs');
        assert.deepEqual(ticketBody, sessionBody, 'board bodies are framed differently');
        assert.equal(
          ticketFilterTop,
          sessionFilterTop,
          'filters change height between tabs: ' +
            JSON.stringify(
              await board.evaluate((n) => ({
                dpr: devicePixelRatio,
                head: n.querySelector('#tk-head')!.getBoundingClientRect().toJSON(),
                filter: n.querySelector('#tk-filter')!.getBoundingClientRect().toJSON(),
                pill: n.querySelector('#tk-filter .fpill')!.getBoundingClientRect().toJSON()
              }))
            )
        );
      } finally {
        await board.evaluate((n, style) => {
          if (style === null) n.removeAttribute('style');
          else n.setAttribute('style', style);
        }, originalStyle);
      }
    });
  });

  step('starts a status column where a repo heading starts, under the same head', async () => {
    await holdingHostState(async () => {
      const state = fixtures.stateMessage([fixtures.groupView()], {
        ticketSource: ticketSourceView({
          filter: { assignee: 'anyone', states: [], priorities: [] },
          options: {
            scopeId: 'team-a',
            assignees: [],
            states: [ticketState('Backlog')],
            priorities: []
          }
        }),
        // One ticket, so no empty-filter notice sits above the column.
        tickets: [
          {
            scopeId: 'team-a',
            key: 'i1',
            identifier: 'ENG-1',
            title: 'a bug',
            priority: ticketPriority(2),
            state: ticketState('Backlog'),
            url: 'https://linear.app/x/ENG-1'
          }
        ]
      });
      await panel()
        .locator('body')
        .evaluate((_, data) => {
          window.dispatchEvent(new MessageEvent('message', { data }));
        }, state);
      const below = (selector: string) =>
        panel()
          .locator(selector)
          .first()
          .evaluate((n) => {
            const head = n.ownerDocument.getElementById('board-head')!.getBoundingClientRect();
            return Math.round(n.getBoundingClientRect().top - head.bottom);
          });
      await panel().locator('#board-sessions').click();
      const heading = await below('#cards .repo h2');
      await panel().locator('#board-tickets').click();
      const column = await below('#tk-list .lane > .lhead .lname');
      assert.equal(column, heading, 'a column title and a repo heading start apart');
    });
  });

  step('keeps waiting work off the content heading', async () => {
    await holdingHostState(async () => {
      const state = fixtures.stateMessage([
        fixtures.groupView({ sessions: [fixtures.cardView({ status: 'waiting' })] })
      ]);
      await panel()
        .locator('body')
        .evaluate((_, data) => {
          window.dispatchEvent(new MessageEvent('message', { data }));
        }, state);
      await panel().locator('#board-sessions').click();
      assert.equal(await panel().locator('#alert').count(), 0);
      assert.equal(await panel().locator('.agents-tab .waiting-count').textContent(), '1');
      assert.equal(await panel().locator('#bottomhub-waiting').isVisible(), false);
    });
  });
});
