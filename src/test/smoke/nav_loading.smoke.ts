import { ticketSourceView } from '../ticket_fixtures';
import * as assert from 'node:assert/strict';
import * as boot from './boot';
import * as fixtures from '../harness';

boot.section('nav loading states, in the real IDE', () => {
  boot.step('ends the CPU wait on the next poll on an idle board', async () => {
    await boot.clearOnboarding();
    await boot.ctx.page.keyboard.press('ControlOrMeta+Shift+P');
    await boot.ctx.page.keyboard.type('Squadron: Show Sessions Overview');
    await boot.ctx.page.keyboard.press('Enter');
    const cpu = boot.panel().locator('#nav [data-key="machine"]');
    await cpu.waitFor({ timeout: 30_000 });
    assert.ok(await cpu.evaluate((n) => n.classList.contains('wait')), 'no initial CPU wait');
    const started = Date.now();
    await boot.panel().locator('#nav [data-key="machine"]:not(.wait)').waitFor({ timeout: 10_000 });
    assert.match((await cpu.locator('.v').textContent()) ?? '', /^\d+%$/);
    console.log(`  CPU arrived after ${Date.now() - started}ms of visible waiting`);
    await boot
      .panel()
      .locator('#nav [data-key="machine-mem"]:not(.wait)')
      .waitFor({ timeout: 10_000 });
    await boot.passOnboarding();
  });

  boot.step(
    'keeps loading animations through pushes and stops them for reduced motion',
    async () => {
      const waiting = fixtures.stateMessage([fixtures.groupView()], {
        usageWindows: [
          { id: 'session', short: '5h' },
          { id: 'weekly', short: 'wk' }
        ],
        ticketSource: { ...ticketSourceView(), linked: true }
      });
      try {
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await boot.ctx.page.emulateMedia({ reducedMotion });
          // Hold the unread state while measuring CSS; the first step above uses
          // real host pushes and never intercepts them.
          const reading = await boot.holdingHostState(() =>
            boot
              .panel()
              .locator('body')
              .evaluate(async (_, message) => {
                const push = (): void => {
                  window.dispatchEvent(new MessageEvent('message', { data: message }));
                };
                push();
                await new Promise((resolve) => setTimeout(resolve, 100));
                const scan = document.querySelector('.mach .scan');
                const bone = document.querySelector('.mach .bone');
                const animation = scan?.getAnimations()[0];
                const time = Number(animation?.currentTime ?? 0);
                push();
                await new Promise(requestAnimationFrame);
                return {
                  sameScan: scan === document.querySelector('.mach .scan'),
                  sameBone: bone === document.querySelector('.mach .bone'),
                  sameAnimation: animation === scan?.getAnimations()[0],
                  advanced: Number(animation?.currentTime ?? 0) >= time,
                  scanMotion: scan && getComputedStyle(scan).animationName,
                  boneMotion: bone && getComputedStyle(bone).animationName,
                  scanOpacity: scan && getComputedStyle(scan).opacity,
                  bones: document.querySelectorAll('#nav .bone').length,
                  usage: document.querySelector('.lim')?.textContent,
                  tickets: document.querySelector('#board-tickets')?.textContent
                };
              }, waiting)
          );
          assert.ok(reading.sameScan && reading.sameBone, 'a push replaced a loading node');
          assert.ok(reading.sameAnimation && reading.advanced, 'a push restarted the scan');
          assert.equal(reading.bones, 6);
          assert.equal(reading.usage, '5h  · wk ');
          assert.equal(reading.tickets, 'Tickets');
          assert.equal(reading.scanMotion, reducedMotion === 'reduce' ? 'none' : 'nav-scan');
          assert.equal(reading.boneMotion, reducedMotion === 'reduce' ? 'none' : 'nav-breathe');
          if (reducedMotion === 'reduce') assert.equal(reading.scanOpacity, '0');
        }
      } finally {
        await boot.ctx.page.emulateMedia({ reducedMotion: 'no-preference' });
      }
    }
  );
});
