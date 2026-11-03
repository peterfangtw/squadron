import * as assert from 'node:assert/strict';
import { before } from 'node:test';
import { openPanel, panel, section, step } from './boot';
import { composer, endCard, openDraft, pids, waitForNewPid } from './kit';

/**
 * A draft's first send as motion, which only a host can run: jsdom has no
 * `animate` and lays nothing out, so `chat_first_send.test.ts` holds every
 * state and none of the flight. What this proves is the flight's two ends in a
 * real renderer — that the press lifts something into the air at all, and
 * that when the session lands nothing is left there.
 * docs/mockups/chat-first-send.html is the comp; the look of it is a
 * hand-check.
 */
section('a draft’s first send, in the real IDE', () => {
  before(async () => {
    await openPanel();
  });

  step('flies the prompt, then extends the header without jumping the conversation', async () => {
    const PROMPT = 'smoke first send lands where it sat';
    const was = await pids();
    await openDraft();
    const box = composer();
    await box.fill(PROMPT);
    // The lifted block lasts 160ms; a Playwright round trip can outlive it.
    // This listener runs after the composer's real keydown handler.
    await box.evaluate((input) => {
      const head = document.getElementById('chat-head')!;
      const observer = new MutationObserver(() => {
        if (head.classList.contains('starting') || getComputedStyle(head).display === 'none')
          return;
        observer.disconnect();
        const animations = head.getAnimations({ subtree: true });
        animations.forEach((animation) => animation.pause());
        const frame = (fraction: number): { height: number; promptTop: number } => {
          for (const animation of animations) {
            const duration = Number(animation.effect?.getTiming().duration ?? 0);
            animation.currentTime = duration * fraction;
          }
          return {
            height: head.getBoundingClientRect().height,
            promptTop: document.querySelector('#thread .turn.user')!.getBoundingClientRect().top
          };
        };
        input.dataset.firstSendHeader = JSON.stringify([frame(0), frame(0.5), frame(1)]);
        animations.forEach((animation) => {
          animation.currentTime = 0;
          animation.play();
        });
      });
      observer.observe(head, { attributes: true, attributeFilter: ['class'] });
      input.addEventListener(
        'keydown',
        () => {
          input.dataset.firstSendAloft = String(document.querySelectorAll('.aloft').length);
          input.dataset.firstSendPrompt =
            document.querySelector('#thread > .turn.user .body')?.textContent ?? '';
        },
        { once: true }
      );
    });
    await box.press('Enter');

    const pressed = await box.evaluate((input) => ({
      aloft: Number(input.dataset.firstSendAloft ?? 0),
      first: input.dataset.firstSendPrompt ?? ''
    }));
    assert.ok(
      pressed.aloft > 0,
      'nothing in the air — the press ran as a cut, or the landing cut it'
    );
    assert.equal(pressed.first, PROMPT, 'the prompt is not seated as the first turn');

    const pid = await waitForNewPid(was);
    const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
    await card.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    // The fake can be idle inside the flight, so wait for the animation to end.
    await panel()
      .locator('.aloft')
      .first()
      .waitFor({ state: 'detached', timeout: 5_000 })
      .catch(() => undefined);

    const landed = await panel()
      .locator('body')
      .evaluate(() => ({
        aloft: document.querySelectorAll('.aloft').length,
        first: document.querySelector('#thread .turn.user .body')?.textContent ?? ''
      }));
    assert.equal(landed.aloft, 0, 'a flight outlived the landing');
    assert.equal(landed.first, PROMPT, 'the prompt did not stay the first turn');

    await panel().locator('#chat-head:not(.starting)').waitFor({ state: 'visible' });
    const frames = await box.evaluate(
      (input) =>
        JSON.parse(input.dataset.firstSendHeader ?? '[]') as {
          height: number;
          promptTop: number;
        }[]
    );
    assert.equal(frames.length, 3, 'the startup header never appeared');
    const [start, middle, end] = frames;
    assert.ok(start && middle && end);
    assert.equal(start.height, 0, 'the header appeared at full height');
    assert.ok(middle.height > 0 && middle.height < end.height, 'the header did not extend');
    assert.ok(end.height > 20, 'the header never reached a usable height');
    for (const frame of [middle, end])
      assert.ok(
        Math.abs(frame.promptTop - start.promptTop - frame.height) < 1,
        'the conversation did not move with the extending header'
      );

    await endCard(pid);
  });
});
