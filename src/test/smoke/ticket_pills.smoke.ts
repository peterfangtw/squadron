import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { before } from 'node:test';
import { ctx, holdingHostState, openPanel, panel, section, step } from './boot';
import { composer, composerValue, openDraft } from './kit';
import * as fixtures from '../harness';
import { ticketPriority, ticketSourceView, ticketState } from '../ticket_fixtures';

type ClipboardHost = { clipboard: { readText(): string; readHTML(): string } };

section('Ticket pill clipboard in stock VS Code', () => {
  before(openPanel);
  step(
    'copies a normal external link, pastes an atomic ticket internally, and keeps icon targets usable',
    async () => {
      await openDraft();
      await holdingHostState(async () => {
        const url = 'https://example.test/issue/ENG-42';
        const reference = '@ticket[ENG-42][' + url + ']';
        const row: TicketView = {
          scopeId: 'team-a',
          key: 'issue-a',
          identifier: 'ENG-42',
          title: 'Copy a portable ticket reference',
          url,
          priority: ticketPriority(),
          state: ticketState('Ready')
        };
        await panel()
          .locator('body')
          .evaluate(
            (_, data) => {
              window.dispatchEvent(new MessageEvent('message', { data }));
            },
            fixtures.stateMessage([fixtures.groupView()], {
              ticketSource: ticketSourceView(),
              tickets: [row]
            })
          );
        await panel().locator('#board-tickets').click();
        await panel().locator('.tk').first().click();
        for (const selector of ['.td-external', '.td-copy']) {
          const button = panel().locator('#ticket-detail ' + selector);
          const box = await button.boundingBox();
          assert.ok(box && box.width >= 24 && box.height >= 24, selector + ' hit target');
          assert.equal(await button.locator('svg').count(), 1);
        }
        await panel().locator('#ticket-detail .td-copy').click();
        await panel().getByRole('status').filter({ hasText: 'Copied' }).waitFor();
        const copied = await ctx.application.evaluate(({ clipboard }: ClipboardHost) => ({
          text: clipboard.readText(),
          html: clipboard.readHTML()
        }));
        assert.equal(copied.text, url);
        assert.ok(copied.html.includes('href="' + url + '"'));
        assert.ok(copied.html.includes(reference));
        await ctx.page.screenshot({
          path: path.join(process.env['SQUADRON_RUN'] ?? ctx.home, 'ticket-pills.png')
        });
        await panel().locator('#ticket-detail .ax').click();
        await composer().click();
        await composer().press('ControlOrMeta+v');
        await panel().locator('#input .pchip.ticket').waitFor();
        assert.equal((await composerValue()).trim(), reference);
        await composer().press('ControlOrMeta+a');
        await composer().press('ControlOrMeta+c');
        assert.equal(
          await ctx.application.evaluate(({ clipboard }: ClipboardHost) => clipboard.readText()),
          url
        );
        await composer().press('Backspace');
        assert.equal(await composerValue(), '');
      });
    }
  );

  step('lists each ticket in the @ menu on one line, number first and title cut', async () => {
    // The step before leaves the board on its tickets tab, where no add slot is drawn.
    await panel().locator('#board-sessions').click();
    await openDraft();
    await holdingHostState(async () => {
      const ticket = (identifier: string, title: string, n: number): TicketView => ({
        scopeId: 'team-a',
        key: 'menu-' + n,
        identifier,
        title,
        url: 'https://example.test/issue/' + n,
        priority: ticketPriority(),
        state: ticketState('Ready')
      });
      const tickets = [
        ticket('ENG-2880', 'Speed up release CD: skip the Go cache on reused runners', 1),
        ticket('acme/acme-web#42', 'Fix three DB tests that flake under CI load', 2),
        ticket('ENG-7', '修正既有報名時無法變更折扣規則與票券套用的問題', 3)
      ];
      await panel()
        .locator('body')
        .evaluate(
          (_, data) => {
            window.dispatchEvent(new MessageEvent('message', { data }));
          },
          fixtures.stateMessage([fixtures.groupView()], {
            ticketSource: ticketSourceView(),
            tickets
          })
        );
      await composer().click();
      await composer().pressSequentially('@ticket:');
      const rows = panel().locator('#mentionmenu:not([hidden]) .mnrow.titled');
      await rows.nth(2).waitFor();
      assert.deepEqual(await rows.locator('.nm').allTextContents(), ['ENG-2880', '#42', 'ENG-7']);
      for (let i = 0; i < 3; i++) {
        const shape = await rows.nth(i).evaluate((node) => {
          const nm = node.querySelector('.nm')!.getBoundingClientRect();
          const meta = node.querySelector<HTMLElement>('.meta')!;
          const box = meta.getBoundingClientRect();
          return {
            nmHeight: nm.height,
            metaHeight: box.height,
            line: parseFloat(getComputedStyle(node).lineHeight) || 20,
            gap: box.left - nm.right,
            cut: meta.scrollWidth > meta.clientWidth
          };
        });
        assert.ok(
          shape.nmHeight < shape.line * 1.5,
          'number on one line: ' + JSON.stringify(shape)
        );
        assert.ok(
          shape.metaHeight < shape.line * 1.5,
          'title on one line: ' + JSON.stringify(shape)
        );
        assert.ok(shape.gap >= 0, 'number and title apart: ' + JSON.stringify(shape));
        if (i === 0) assert.ok(shape.cut, 'a long title is cut');
      }
      await composer().press('Escape');
      await composer().press('ControlOrMeta+a');
      await composer().press('Backspace');
    });
  });
});
