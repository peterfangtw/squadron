import * as path from 'node:path';
import { ticketPriority, ticketState, ticketSourceView } from '../ticket_fixtures';
import * as assert from 'node:assert/strict';
import { before } from 'node:test';
import {
  ctx,
  closeEditors,
  holdingHostState,
  openPanel,
  panel,
  section,
  step,
  TICKET,
  ticketTracker
} from './boot';
import * as fixtures from '../harness';
import { composer, composerValue, fixtureSession, FIXTURE_NAME } from './kit';

section('Tickets beside persistent chat, in the real IDE', () => {
  before(openPanel);

  step(
    'connects the source and keeps the lane header and identifier hit target usable',
    async () => {
      await panel().locator('#board-tickets').click();
      await panel().locator('.tkconnect').click();
      await ctx.page.locator('.quick-input-widget').waitFor({ state: 'visible', timeout: 30_000 });
      await ctx.page.keyboard.type('lin_api_smoke');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.locator('.quick-input-widget').waitFor({ state: 'hidden', timeout: 30_000 });
      await panel().locator('#tk-source .scope-button').click();
      await panel().locator('#tk-source .fsearch').fill('Engineering');
      await ctx.page.keyboard.press('ArrowDown');
      await ctx.page.keyboard.press('Enter');
      const row = panel().locator('#tk-list .tk', { hasText: TICKET.identifier });
      await row.waitFor({ timeout: 30_000 });
      assert.equal(await row.getAttribute('draggable'), null);
      assert.equal(await row.locator('.handoff').count(), 0);
      assert.equal(await panel().locator('#dock-tabs').count(), 0);
      assert.ok(await panel().locator('#chat').isVisible());
      const head = panel().locator('#tk-list .lane > .lhead').first();
      const inner = await panel()
        .locator('#tk-list .lane')
        .first()
        .evaluate((n) => n.getBoundingClientRect().width);
      const band = await head.evaluate((n) => n.getBoundingClientRect().width);
      assert.equal(Math.round(band), Math.round(inner), 'the lane header shrink-wrapped');
      const hit = await row.boundingBox();
      assert.ok(hit && hit.width >= 24 && hit.height >= 24);
      await row.focus();
      assert.equal(await row.evaluate((n) => n.matches(':focus-visible')), true);
      await row.press('Enter');
      await panel().locator('#ticket-detail .td-title').waitFor();
      await panel().locator('#ticket-detail .ax').click();
      assert.equal(await row.evaluate((n) => n === document.activeElement), true);
      await row.click({ position: { x: 3, y: hit.height / 2 } });
      await panel().locator('#ticket-detail .td-title').waitFor();
      await panel().locator('#ticket-detail .ax').click();
    }
  );

  step('projects the adapter viewer into one named assignee choice', async () => {
    const pill = panel().locator('#tk-filter .fpill').first();
    await pill.filter({ hasText: 'Anyone (All)' }).waitFor();
    await pill.click();
    const names = await panel().locator('.fmenu.pmenu:not([hidden]) .mitem .nm').allTextContents();
    assert.deepEqual(names, ['Anyone (All)', 'Unassigned', 'smoke (Me)']);
    await ctx.page.keyboard.press('Escape');
  });

  step(
    'remembers the selected team across panel disposal and resets transient filters',
    async () => {
      await panel().locator('#tk-filter .fpill').last().click();
      await panel().getByRole('menuitemcheckbox', { name: 'Urgent', exact: true }).click();
      await ctx.page.keyboard.press('Escape');
      await panel().locator('#tk-source .scope-button').click();
      await panel().locator('#tk-source .mitem', { hasText: 'Linear / Operations' }).click();
      await panel().locator('#tk-list .tk', { hasText: 'OPS-1' }).waitFor();
      assert.match(
        await panel().locator('#tk-filter').innerText(),
        /Anyone \(All\).*Any status.*Any priority/s
      );
      await closeEditors();
      await openPanel();
      await panel().locator('#board-tickets').click();
      await panel().locator('#tk-list .tk', { hasText: 'OPS-1' }).waitFor();
      assert.match(await panel().locator('#tk-source .scope-button').innerText(), /Operations/);
      assert.ok(
        ticketTracker.requests.some(
          (request) =>
            (request.variables.filter as { team?: { id?: { eq?: string } } } | undefined)?.team?.id
              ?.eq === 'team-b'
        )
      );
      await panel().locator('#tk-source .scope-button').click();
      await panel().locator('#tk-source .mitem', { hasText: 'Linear / Engineering' }).click();
      await panel().locator('#tk-list .tk', { hasText: TICKET.identifier }).waitFor();
    }
  );

  step(
    'shows a required-options error from the real host and Retry recovers without discarding rows',
    async () => {
      ticketTracker.failure = {
        status: 403,
        message: 'Team access denied <literal>',
        optionsOnly: true
      };
      try {
        await panel().locator('#tk-actions .refresh').click();
        await panel().locator('.tkstale', { hasText: 'Team access denied <literal>' }).waitFor();
        assert.equal(await panel().locator('#tk-list .tk').count(), 1);
        assert.equal(await panel().locator('[data-act="retryTickets"]').innerText(), 'Retry');
        ticketTracker.failure = undefined;
        await panel().locator('[data-act="retryTickets"]').click();
        await panel().locator('.tkstale').waitFor({ state: 'detached' });
      } finally {
        ticketTracker.failure = undefined;
      }
    }
  );

  step(
    'keeps the toolbar on one row with scrollable filters at narrow widths and opens an unclipped menu',
    async () => {
      const tickets = panel().locator('#board-head');
      const previous = await tickets.getAttribute('style');
      try {
        await tickets.evaluate((node) => {
          node.style.width = '420px';
          node.style.maxWidth = '100%';
        });
        const boxes = await panel()
          .locator('#tk-head')
          .evaluate((node) => {
            const source = node.querySelector('#tk-source')!.getBoundingClientRect();
            const filters = node.querySelector('#tk-filter')!;
            const filter = filters.getBoundingClientRect();
            const actions = node.querySelector('#tk-actions')!.getBoundingClientRect();
            return {
              source: source.top + source.height / 2,
              filters: filter.top + filter.height / 2,
              actions: actions.top + actions.height / 2,
              scroll: filters.scrollWidth,
              client: filters.clientWidth,
              // Items, not scrollWidth: an .icon's hit band reaches 4px past
              // its button into #board-head's gutter by design.
              overflow: [...node.children].some(
                (c) => c.getBoundingClientRect().right > node.getBoundingClientRect().right + 0.5
              )
            };
          });
        assert.ok(
          Math.abs(boxes.source - boxes.filters) < 2 && Math.abs(boxes.actions - boxes.filters) < 2,
          JSON.stringify(boxes)
        );
        assert.ok(boxes.scroll > boxes.client, 'narrow filters did not scroll');
        assert.equal(boxes.overflow, false);
        await panel().locator('#tk-filter .fpill').first().click();
        const menu = panel().locator('.fmenu.pmenu.floating:not([hidden])');
        await menu.waitFor();
        assert.ok(await menu.locator('.mitem').first().isVisible());
        await ctx.page.keyboard.press('Escape');
      } finally {
        await tickets.evaluate((node, style) => {
          if (style === null) node.removeAttribute('style');
          else node.setAttribute('style', style);
        }, previous);
      }
    }
  );

  step(
    'keeps a live chat, reply draft, scroll and width while Tickets receives host pushes',
    async () => {
      await panel().locator('#board-sessions').click();
      const { pid } = await fixtureSession();
      await composer().fill('spool the ticket view fixture');
      await composer().press('Enter');
      await panel()
        .locator('#thread .turn.assistant.live', { hasText: 'Line 39 of an answer' })
        .waitFor({ timeout: 30_000 });
      const thread = panel().locator('#thread');
      const room = await thread.evaluate((n) => n.scrollHeight - n.clientHeight);
      assert.ok(room > 100, 'the thread must overflow to test its scroll');
      await composer().fill('unfinished reply');
      await thread.evaluate((n) => {
        n.scrollTop = 80;
      });
      const before = {
        width: await panel()
          .locator('#dock')
          .evaluate((n) => n.getBoundingClientRect().width),
        scroll: await thread.evaluate((n) => n.scrollTop)
      };
      await panel().locator('#board-tickets').click();
      assert.ok(await panel().locator('#chat').isVisible());
      assert.ok(await panel().locator('#cards').isHidden());
      await rowRefresh();
      assert.equal(await composerValue(), 'unfinished reply');
      assert.equal(await thread.evaluate((n) => n.scrollTop), before.scroll);
      assert.equal(
        await panel()
          .locator('#dock')
          .evaluate((n) => n.getBoundingClientRect().width),
        before.width
      );
      assert.equal(await panel().locator('.card.selected').getAttribute('data-pid'), String(pid));
      assert.equal(await panel().locator('#chat-head span.name').textContent(), FIXTURE_NAME);
      await panel().locator('#chat-interrupt').click();
      await panel()
        .locator('#thread .turn.assistant.live')
        .waitFor({ state: 'hidden', timeout: 30_000 });
      assert.ok(
        await panel().locator('#tk-list').isVisible(),
        'chat completion changed the board view'
      );
      assert.equal(await composerValue(), 'unfinished reply');
      await panel().locator('#board-sessions').click();
      assert.equal(await thread.evaluate((n) => n.scrollTop), before.scroll);
    }
  );

  step(
    'renders Markdown on demand with an anchored header and usable chat, then retries and refetches',
    async () => {
      await panel().locator('#board-sessions').click();
      await fixtureSession();
      await panel().locator('#board-tickets').click();
      const row = panel().locator('#tk-list .tk', { hasText: TICKET.identifier });
      await row.waitFor();
      const count = () =>
        ticketTracker.requests.filter((r) => r.query.includes('TicketDetail')).length;
      const before = count();
      await row.locator('.tkkey').click();
      const surface = panel().locator('#ticket-detail');
      await surface.locator('.body strong', { hasText: 'Rendered Markdown' }).waitFor();
      assert.match(await surface.locator('.td-fields').innerText(), /Unassigned/);
      // jsdom ranks by source order alone, so only a real engine settles these two.
      const type = await surface.evaluate((n) => {
        const read = (selector: string) => {
          const style = getComputedStyle(n.querySelector(selector)!);
          return { size: parseFloat(style.fontSize), color: style.color };
        };
        return { id: read('.td-tools b'), title: read('.td-title'), prose: read('.body strong') };
      });
      assert.ok(type.id.size < type.title.size, JSON.stringify(type));
      assert.equal(type.title.color, type.prose.color, 'the title reads dimmer than the body');
      const header = surface.locator('.ashead');
      const top = await header.evaluate((n) => n.getBoundingClientRect().top);
      await surface.locator('.td-description').evaluate((n) => {
        n.scrollTop = 500;
      });
      assert.equal(await header.evaluate((n) => n.getBoundingClientRect().top), top);
      assert.ok(await surface.locator('.td-description').evaluate((n) => n.scrollTop > 0));
      for (const frame of ['#board-head', '#board-body']) {
        assert.equal(
          await panel()
            .locator(frame)
            .evaluate((n) => n.hasAttribute('inert')),
          true,
          frame
        );
      }
      assert.equal(
        await panel()
          .locator('#dock')
          .evaluate((n) => n.hasAttribute('inert')),
        false
      );
      await composer().fill('ticket reading draft');
      assert.equal(await composerValue(), 'ticket reading draft');
      await composer().press('Escape');
      assert.ok(await surface.isVisible());
      await composer().press('Enter');
      await panel().locator('#thread .turn.user', { hasText: 'ticket reading draft' }).waitFor();
      assert.ok(await surface.isVisible());
      assert.equal(count(), before + 1, 'chat/polls triggered another detail read');
      await surface.locator('.ax').click();
      assert.equal(await surface.innerText(), '');
      ticketTracker.failure = {
        status: 503,
        message: 'Temporary detail failure',
        detailsOnly: true
      };
      try {
        await row.locator('.tkkey').click();
        await surface.locator('.td-retry').waitFor();
        ticketTracker.failure = undefined;
        await surface.locator('.td-retry').click();
        await surface.locator('.body strong').waitFor();
        assert.equal(count(), before + 3);
        await ctx.page.screenshot({
          path: path.join(process.env['SQUADRON_RUN'] ?? ctx.home, 'ticket-details-wide.png')
        });
        const board = panel().locator('#board');
        const previous = await board.getAttribute('style');
        try {
          await board.evaluate((n) => {
            n.style.flex = 'none';
            n.style.width = '360px';
          });
          const box = await surface.evaluate((n) => {
            const sheet = n.querySelector('.ticket-detail')!;
            const close = n.querySelector('.ax')!.getBoundingClientRect();
            const body = n.querySelector('.td-description')!;
            return {
              width: sheet.getBoundingClientRect().width,
              overflow: body.scrollWidth > body.clientWidth,
              reachable: close.right <= n.getBoundingClientRect().right
            };
          });
          assert.ok(box.width <= 360 && !box.overflow && box.reachable, JSON.stringify(box));
          await ctx.page.screenshot({
            path: path.join(process.env['SQUADRON_RUN'] ?? ctx.home, 'ticket-details-narrow.png')
          });
        } finally {
          await board.evaluate((n, style) => {
            if (style === null) n.removeAttribute('style');
            else n.setAttribute('style', style);
          }, previous);
        }
        await surface.locator('.td-title').focus();
        await ctx.page.keyboard.press('Escape');
        assert.ok(await surface.isHidden());
      } finally {
        ticketTracker.failure = undefined;
      }
    }
  );
  step(
    'anchors questions and tickets together and keeps long questions above the bottom edge',
    async () => {
      await panel().locator('#board-sessions').click();
      await fixtureSession();
      await composer().fill('ask');
      await composer().press('Enter');
      const ask = panel().locator('#ask');
      await panel().locator('#qlaunch').waitFor();
      if (!(await ask.isVisible())) await panel().locator('#qlaunch').click();
      await ask.waitFor();
      const board = panel().locator('#board');
      const previous = await board.getAttribute('style');
      try {
        await ask
          .locator('.qopts')
          .first()
          .evaluate((n) => {
            const option = n.firstElementChild!;
            for (let i = 0; i < 30; i++) n.append(option.cloneNode(true));
          });
        for (const width of [640, 360]) {
          await board.evaluate((n, width) => {
            n.style.flex = 'none';
            n.style.width = width + 'px';
          }, width);
          if (!(await ask.isVisible())) await panel().locator('#qlaunch').click();
          const geometry = await ask.evaluate((n) => {
            const box = n.getBoundingClientRect();
            const board = document.getElementById('board')!.getBoundingClientRect();
            const body = n.querySelector('.qcol')!;
            body.scrollTop = body.scrollHeight;
            return {
              top: box.top - board.top,
              bottom: box.bottom - board.top,
              height: board.height,
              scroll: body.scrollTop
            };
          });
          assert.ok(geometry.bottom <= geometry.height * 0.9 + 1, JSON.stringify(geometry));
          assert.ok(geometry.scroll > 0, 'long questions cannot scroll');
          await panel().locator('#qlaunch').click();
          await panel().locator('#board-tickets').click();
          await panel().locator('#tk-list .tk').first().click();
          const ticketTop = await panel()
            .locator('#ticket-detail .ashead')
            .evaluate(
              (n) =>
                n.getBoundingClientRect().top -
                document.getElementById('board')!.getBoundingClientRect().top
            );
          assert.ok(
            Math.abs(ticketTop - geometry.top) <= 1,
            `width ${width}: ticket ${ticketTop}, question ${geometry.top}`
          );
          assert.ok(
            Math.abs(geometry.top - (width <= 420 ? 12 : 28)) <= 1,
            JSON.stringify(geometry)
          );
          await panel().locator('#ticket-detail .ax').click();
        }
      } finally {
        await board.evaluate((n, style) => {
          if (style === null) n.removeAttribute('style');
          else n.setAttribute('style', style);
        }, previous);
        if (!(await ask.isVisible())) await panel().locator('#qlaunch').click();
        await ask.locator('.qcancel').click();
        await ask.waitFor({ state: 'hidden' });
      }
    }
  );

  step('cancels the old detail request when reloading the document', async () => {
    const requested = new Promise<void>((resolve) => {
      ticketTracker.detailRequested = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      ticketTracker.detailCancelled = resolve;
    });
    ticketTracker.holdDetail = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await panel()
        .locator('#tk-list .tk', { hasText: TICKET.identifier })
        .locator('.tkkey')
        .click();
      await requested;
      await panel()
        .locator('body')
        .evaluate((n) => {
          n.setAttribute('data-detail-reload-witness', 'old');
        });
      await ctx.page.keyboard.press('ControlOrMeta+Shift+P');
      await ctx.page.keyboard.type('Developer: Reload Webviews');
      await ctx.page.keyboard.press('Enter');
      await panel().locator('body:not([data-detail-reload-witness]) #board').waitFor();
      await Promise.race([
        cancelled,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('detail request survived document reload')),
            3000
          );
        })
      ]);
      assert.equal(await panel().locator('#ticket-detail').count(), 0);
    } finally {
      clearTimeout(timer);
      ticketTracker.holdDetail = false;
      ticketTracker.detailRequested = undefined;
      ticketTracker.detailCancelled = undefined;
    }
  });

  step(
    'scrolls status columns locally with fixed headers and independent chat geometry',
    async () => {
      await holdingHostState(async () => {
        const names = ['Building', 'In Review', 'Ready to Ship'];
        const state = fixtures.stateMessage([], {
          ticketSource: {
            ...ticketSourceView(),
            linked: true,
            filter: { assignee: 'me', states: [], priorities: [] },
            options: {
              scopeId: 'team-a',
              assignees: [{ id: 'me', label: 'Me' }],
              states: names.map((name, order) => ({ ...ticketState(name), order })),
              priorities: [{ ...ticketPriority(2), label: 'High' }]
            }
          },
          tickets: Array.from({ length: 32 }, (_, i) => ({
            scopeId: 'team-a',
            key: String(i),
            identifier: 'ENG-' + i,
            title: 'A ticket with enough text to wrap across the column',
            priority: ticketPriority(2),
            state: ticketState(names[i === 31 ? 2 : 0]!),
            url: 'https://example.invalid/ENG-' + i
          }))
        });
        const firstPaint = {
          ...state,
          ticketSource: ticketSourceView({
            stale: true,
            filter: { assignee: 'me', states: [], priorities: [] }
          })
        } satisfies StateMessage;
        await panel()
          .locator('body')
          .evaluate((_, data) => {
            window.dispatchEvent(new MessageEvent('message', { data }));
          }, firstPaint);
        await panel().locator('#board-tickets').click();
        for (const selector of ['#tk-list > .tkstale', '#tk-list > .tk']) {
          const inset = await panel()
            .locator(selector)
            .first()
            .evaluate((n) => {
              const parent = n.parentElement!;
              const content = document.createElement('div');
              content.style.cssText = 'height:0;flex:none;align-self:stretch';
              parent.append(content);
              const frame = content.getBoundingClientRect();
              const box = n.getBoundingClientRect();
              content.remove();
              return { left: box.left - frame.left, right: frame.right - box.right };
            });
          assert.deepEqual(inset, { left: 18, right: 18 }, 'fallback content lost its inset');
        }
        await panel()
          .locator('body')
          .evaluate((_, data) => {
            window.dispatchEvent(new MessageEvent('message', { data }));
          }, state);
        await panel().locator('#board-tickets').click();
        const track = panel().locator('.tkcolumns');
        const edges = await track.evaluate((n) => {
          const frame = n.getBoundingClientRect();
          const board = n.ownerDocument.getElementById('board')!.getBoundingClientRect();
          const first = n.querySelector('.lane')!.getBoundingClientRect();
          return {
            left: frame.left - board.left,
            right: board.right - frame.right,
            initialInset: first.left - frame.left
          };
        });
        assert.equal(edges.left, 0, 'ticket clipping is inset from the board left edge');
        assert.equal(edges.right, 0, 'ticket clipping is inset from the divider');
        assert.equal(edges.initialInset, 18, 'initial ticket spacing was lost');
        const head = track.locator('.lhead').first();
        const body = track.locator('.lbody').first();
        const dock = await panel().locator('#dock').boundingBox();
        const heading = await head.boundingBox();
        const vertical = await body.evaluate((n) => {
          n.scrollTop = 150;
          return n.scrollTop;
        });
        assert.ok(vertical > 0, 'column cards do not scroll vertically');
        assert.deepEqual(
          await head.boundingBox(),
          heading,
          'scrolling cards moved the status header'
        );
        const horizontal = await track.evaluate((n) => {
          n.scrollLeft = n.scrollWidth;
          return n.scrollLeft;
        });
        assert.ok(horizontal > 0, 'status columns do not scroll horizontally');
        const last = await track.locator('.lane').last().boundingBox();
        const frame = await track.boundingBox();
        assert.ok(
          last && frame && last.x + last.width <= frame.x + frame.width + 1,
          'the final column is unreachable'
        );
        assert.deepEqual(await panel().locator('#dock').boundingBox(), dock);
        assert.ok(
          await panel()
            .locator('body')
            .evaluate((n) => n.scrollWidth <= n.clientWidth),
          'columns overflow the whole panel'
        );
        console.log('ticket columns geometry', {
          vertical,
          horizontal,
          columnWidth: last.width,
          trackWidth: frame.width
        });
        await track.evaluate((n) => {
          n.scrollLeft = 0;
        });
        const firstLane = track.locator('.lane').first();
        const nextLane = track.locator('.lane').nth(1);
        const expanded = await firstLane.boundingBox();
        const nextBefore = await nextLane.boundingBox();
        const bodyScroll = await body.evaluate((n) => n.scrollTop);
        await head.click();
        const collapsed = await firstLane.boundingBox();
        const nextAfter = await nextLane.boundingBox();
        assert.ok(expanded && collapsed && nextBefore && nextAfter);
        assert.ok(
          collapsed.width >= 24 && collapsed.width <= 48,
          'collapsed status kept its column width'
        );
        assert.equal(
          nextBefore.x - nextAfter.x,
          expanded.width - collapsed.width,
          'collapse did not reclaim horizontal space'
        );
        assert.equal(await body.isVisible(), false);
        assert.equal(await head.locator('.ln').innerText(), '31');
        const tab = await head.boundingBox();
        assert.ok(
          tab &&
            tab.width === collapsed.width &&
            tab.height >= 24 &&
            tab.height < expanded.height / 2,
          'collapsed status is not a compact clickable tab'
        );
        const name = await head.locator('.lname').boundingBox();
        const count = await head.locator('.ln').boundingBox();
        assert.ok(
          name && count && count.y >= name.y + name.height,
          'count does not follow the vertical status name'
        );
        assert.equal(await head.locator('.caret').isVisible(), false);
        await panel()
          .locator('body')
          .evaluate((_, data) => {
            window.dispatchEvent(new MessageEvent('message', { data }));
          }, state);
        assert.deepEqual(
          await firstLane.boundingBox(),
          collapsed,
          'a push expanded the collapsed status'
        );
        await head.focus();
        await head.press('Enter');
        assert.deepEqual(
          await firstLane.boundingBox(),
          expanded,
          'keyboard expansion did not restore the column'
        );
        assert.equal(await body.isVisible(), true);
        assert.equal(
          await body.evaluate((n) => n.scrollTop),
          bodyScroll,
          'expansion lost the ticket scroll position'
        );
        assert.deepEqual(await panel().locator('#dock').boundingBox(), dock);
        await panel()
          .locator('body')
          .evaluate(
            (_, data) => {
              window.dispatchEvent(new MessageEvent('message', { data }));
            },
            { ...state, ticketSource: { ...state.ticketSource!, loading: true } }
          );
        const tickets = panel().locator('#board-head');
        await tickets.evaluate((node) => {
          node.style.width = '420px';
        });
        await panel().getByRole('status', { name: '' }).filter({ hasText: 'Refreshing' }).waitFor();
        const pending = await panel()
          .locator('#tk-head')
          .evaluate((node) => {
            const note = node.querySelector('.tkrefresh-note')!.getBoundingClientRect();
            const source = node.querySelector('#tk-source')!.getBoundingClientRect();
            return {
              // Items, not scrollWidth: an .icon's hit band reaches 4px past
              // its button into #board-head's gutter by design.
              overflow: [...node.children].some(
                (c) => c.getBoundingClientRect().right > node.getBoundingClientRect().right + 0.5
              ),
              sameRow: Math.abs(note.top + note.height / 2 - source.top - source.height / 2) < 2
            };
          });
        assert.equal(pending.overflow, false, 'refresh feedback overflowed the toolbar');
        assert.equal(pending.sameRow, true, 'refresh feedback created another toolbar row');
        await tickets.evaluate((node) => {
          node.style.removeProperty('width');
        });
      });
    }
  );
});

async function rowRefresh(): Promise<void> {
  await panel().locator('#tk-head .refresh').click();
  await panel().locator('#tk-list .tk', { hasText: TICKET.identifier }).waitFor();
  // Cross the real host poll while both surfaces are visible.
  await ctx.page.waitForTimeout(3500);
}
