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
});
