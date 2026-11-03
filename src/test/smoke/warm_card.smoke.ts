import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as boot from './boot';
import * as fixtures from '../harness';

boot.section('warming footer, in the real IDE', () => {
  boot.step('fits the right-side warm action and its hit target on compact cards', async () => {
    await boot.openPanel();
    const message = fixtures.stateMessage([
      fixtures.groupView({
        sessions: [
          fixtures.cardView({
            pid: 501,
            status: 'busy',
            name: 'Warm cache orchestration',
            warm: { on: false, ttlMs: 3_600_000, source: 'measured' }
          })
        ]
      })
    ]);
    const readings = await boot.holdingHostState(() =>
      boot
        .panel()
        .locator('body')
        .evaluate(async (_, state) => {
          window.dispatchEvent(new MessageEvent('message', { data: state }));
          const card = document.querySelector<HTMLElement>('.card[data-pid="501"]')!;
          const grid = card.closest<HTMLElement>('.grid')!;
          await Promise.allSettled(
            document
              .getElementById('cards')!
              .getAnimations({ subtree: true })
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map((animation) => animation.finished)
          );
          const samples = [];
          for (const width of [180, 238, 320]) {
            grid.style.gridTemplateColumns = width + 'px';
            await new Promise(requestAnimationFrame);
            const buttons = [...card.querySelectorAll<HTMLElement>('.head button')];
            const warm = card.querySelector<HTMLElement>('[data-act="warm"]')!;
            const target = warm.getBoundingClientRect();
            const inset = getComputedStyle(warm, '::before');
            const head = card.querySelector<HTMLElement>('.head')!.getBoundingClientRect();
            samples.push({
              width,
              actions: buttons.map((button) => button.dataset.act),
              fits: buttons.every((button) => {
                const rect = button.getBoundingClientRect();
                return rect.left >= head.left && rect.right <= head.right + 1;
              }),
              targetWidth: target.width - parseFloat(inset.left) - parseFloat(inset.right),
              targetHeight: target.height - parseFloat(inset.top) - parseFloat(inset.bottom),
              hit: document
                .elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)
                ?.closest('[data-act]')
                ?.getAttribute('data-act')
            });
          }
          grid.style.removeProperty('grid-template-columns');
          return samples;
        }, message)
    );
    for (const reading of readings) {
      assert.deepEqual(reading.actions, ['interrupt', 'warm', 'copyRef', 'close']);
      assert.ok(reading.fits, `actions overflow at ${reading.width}px`);
      assert.ok(reading.targetWidth >= 24 && reading.targetHeight >= 24);
      assert.equal(reading.hit, 'warm');
    }
  });

  boot.step(
    'keeps the molten edge through rename, pauses when hidden and releases removed cards',
    async () => {
      await boot.openPanel();
      const message = fixtures.stateMessage([
        fixtures.groupView({
          sessions: Array.from({ length: 30 }, (_, index) =>
            fixtures.cardView({
              pid: 501 + index,
              name: index === 0 ? 'Warm cache orchestration' : 'Session ' + index,
              branch: 'staging',
              warming: index === 0 ? true : undefined
            })
          )
        })
      ]);
      const reading = await boot.holdingHostState(() =>
        boot
          .panel()
          .locator('body')
          .evaluate(async (_, state) => {
            const push = (data: PanelMessage): void => {
              window.dispatchEvent(new MessageEvent('message', { data }));
            };
            const settle = async (predicate: () => boolean): Promise<void> => {
              const deadline = performance.now() + 2000;
              while (!predicate()) {
                if (performance.now() > deadline) {
                  const node = document.querySelector('.card[data-pid="501"]');
                  throw new Error(
                    'Warm cue did not settle: ' +
                      JSON.stringify({
                        classes: node?.className,
                        card: node?.getBoundingClientRect().toJSON(),
                        root: document.getElementById('cards')?.getBoundingClientRect().toJSON()
                      })
                  );
                }
                await new Promise(requestAnimationFrame);
              }
            };
            try {
              push(state);
              const cards = document.getElementById('cards')!;
              cards.scrollTop = 0;
              const card = cards.querySelector<HTMLElement>('.card[data-pid="501"]')!;
              const foot = card.querySelector<HTMLElement>('.foot')!;
              await settle(() => card.classList.contains('warm-visible'));
              // A `postMessage` arrives trusted, as the host's own push does, so the
              // hold has to keep this empty board off the fixture. Same-source
              // messages are delivered in order: once our `visible` lands, so has it.
              const delivered = new Promise((resolve) => {
                const seen = (event: MessageEvent<PanelMessage>): void => {
                  if (event.source !== window || event.data.type !== 'visible') return;
                  window.removeEventListener('message', seen);
                  resolve(undefined);
                };
                window.addEventListener('message', seen);
              });
              window.postMessage({ ...state, groups: [] }, '*');
              window.postMessage({ type: 'visible', visible: true }, '*');
              await delivered;
              if (cards.querySelector('.card[data-pid="501"]') !== card)
                throw new Error('a host push replaced the fixture board');
              const before = card.getBoundingClientRect();
              const animations = foot.getAnimations({ subtree: true });
              push({
                ...state,
                groups: state.groups.map((group) => ({
                  ...group,
                  sessions: group.sessions.map((session) =>
                    session.pid === 501 ? { ...session, name: 'Renamed warming session' } : session
                  )
                }))
              });
              const renaming =
                card.querySelector('.name')?.textContent !== 'Renamed warming session';
              await new Promise((resolve) => setTimeout(resolve, 550));
              const renamed = card.querySelector('.name')?.textContent;
              const sameAnimations = animations.every((animation) =>
                foot.getAnimations({ subtree: true }).includes(animation)
              );
              const moving = getComputedStyle(foot, '::after').animationPlayState;
              push({ type: 'visible', visible: false });
              const hidden = getComputedStyle(foot, '::after').animationPlayState;
              push({ type: 'visible', visible: true });
              let documentHidden: string;
              try {
                Object.defineProperty(document, 'visibilityState', {
                  configurable: true,
                  value: 'hidden'
                });
                document.dispatchEvent(new Event('visibilitychange'));
                documentHidden = getComputedStyle(foot, '::after').animationPlayState;
              } finally {
                Reflect.deleteProperty(document, 'visibilityState');
                document.dispatchEvent(new Event('visibilitychange'));
              }
              const documentRestored = getComputedStyle(foot, '::after').animationPlayState;
              cards.scrollTop = cards.scrollHeight;
              await settle(() => !card.classList.contains('warm-visible'));
              const offscreen = getComputedStyle(foot, '::after').animationPlayState;
              cards.scrollTop = 0;
              await settle(() => card.classList.contains('warm-visible'));
              const resumed = getComputedStyle(foot, '::after').animationPlayState;
              const finished: StateMessage = {
                ...state,
                groups: state.groups.map((group) => ({
                  ...group,
                  sessions: group.sessions.map((session) => ({ ...session, warming: undefined }))
                }))
              };
              push(finished);
              const after = card.getBoundingClientRect();
              const finishedMotion = getComputedStyle(foot, '::after').animationName;
              const finishedReleased = !card.classList.contains('warm-visible');
              push(state);
              await settle(() => card.classList.contains('warm-visible'));
              push({
                ...state,
                groups: state.groups.map((group) => ({
                  ...group,
                  sessions: group.sessions.filter((session) => session.pid !== 501)
                }))
              });
              const removedReleased = !card.isConnected && !card.classList.contains('warm-visible');
              push(state);
              const replacement = cards.querySelector<HTMLElement>('.card[data-pid="501"]')!;
              await settle(() => replacement.classList.contains('warm-visible'));
              push({ ...state, groups: [] });
              const emptyReleased =
                !replacement.isConnected && !replacement.classList.contains('warm-visible');
              return {
                renaming,
                renamed,
                sameAnimations,
                animationCount: animations.length,
                moving,
                hidden,
                documentHidden,
                documentRestored,
                offscreen,
                resumed,
                finished: finishedMotion,
                finishedReleased,
                removedReleased,
                emptyReleased,
                sameFoot: foot === card.querySelector('.foot'),
                width: [before.width, after.width],
                height: [before.height, after.height],
                rows: card.children.length
              };
            } finally {
              push({ type: 'visible', visible: true });
            }
          }, message)
      );
      assert.equal(reading.animationCount, 1);
      assert.ok(reading.renaming, 'the rename did not start its scramble');
      assert.equal(reading.renamed, 'Renamed warming session');
      assert.ok(reading.sameAnimations, 'a push restarted the warm cue');
      assert.equal(reading.moving, 'running');
      assert.equal(reading.hidden, 'paused');
      assert.equal(reading.documentHidden, 'paused');
      assert.equal(reading.documentRestored, 'running');
      assert.equal(reading.offscreen, 'paused');
      assert.equal(reading.resumed, 'running');
      assert.equal(reading.finished, 'none');
      assert.ok(reading.finishedReleased, 'a finished ping kept its viewport state');
      assert.ok(reading.removedReleased, 'a removed warming card kept its viewport state');
      assert.ok(reading.emptyReleased, 'emptying the board kept its viewport state');
      assert.ok(reading.sameFoot);
      assert.equal(reading.width[0], reading.width[1]);
      assert.equal(reading.height[0], reading.height[1]);
      assert.equal(reading.rows, 4);
    }
  );

  boot.step('draws a still edge while Warm is on, and moves it only for a ping', async () => {
    await boot.openPanel();
    const card = (warming?: true) =>
      fixtures.stateMessage([
        fixtures.groupView({
          sessions: [
            fixtures.cardView({
              pid: 501,
              name: 'Kept warm',
              branch: 'staging',
              warm: { on: true, ttlMs: 3_600_000, source: 'measured' },
              warming
            })
          ]
        })
      ]);
    const reading = await boot.holdingHostState(() =>
      boot
        .panel()
        .locator('body')
        .evaluate(
          async (_, [still, pinging]) => {
            const push = (data: PanelMessage): void => {
              window.dispatchEvent(new MessageEvent('message', { data }));
            };
            const read = () => {
              const foot = document.querySelector<HTMLElement>('.card[data-pid="501"] .foot')!;
              return {
                edge: getComputedStyle(foot, '::after').backgroundImage,
                edgeMotion: getComputedStyle(foot, '::after').animationName,
                glow: getComputedStyle(foot, '::before').backgroundImage,
                edgeWidth: parseFloat(getComputedStyle(foot, '::after').width),
                stripWidth: foot.clientWidth,
                animations: foot.getAnimations({ subtree: true }).length
              };
            };
            push(still);
            await new Promise(requestAnimationFrame);
            const on = read();
            push(pinging);
            await new Promise(requestAnimationFrame);
            return { on, ping: read() };
          },
          [card(), card(true)] as const
        )
    );
    assert.notEqual(reading.on.edge, 'none', 'Warm on drew no edge');
    assert.equal(reading.on.edgeMotion, 'none');
    assert.equal(reading.on.glow, 'none');
    assert.ok(Math.abs(reading.on.edgeWidth - reading.on.stripWidth) < 1);
    assert.equal(reading.on.animations, 0, 'an idle warm card is animating');
    assert.equal(reading.ping.edgeMotion, 'molten-strip');
    assert.equal(reading.ping.animations, 1);
  });

  boot.step('keeps the plain edge for reduced motion in light and dark themes', async () => {
    try {
      await boot.holdingHostState(async () => {
        for (const theme of ['ink', 'paper'] as const) {
          await boot.ctx.page.emulateMedia({ reducedMotion: 'reduce' });
          const message = fixtures.stateMessage(
            [
              fixtures.groupView({
                sessions: [
                  fixtures.cardView({
                    pid: 501,
                    name: 'Warm cache orchestration',
                    branch: 'staging',
                    warming: true
                  })
                ]
              })
            ],
            { theme }
          );
          const reading = await boot
            .panel()
            .locator('body')
            .evaluate((_, state) => {
              window.dispatchEvent(new MessageEvent('message', { data: state }));
              const foot = document.querySelector<HTMLElement>('.card.warming .foot')!;
              const edge = getComputedStyle(foot, '::after');
              const glow = getComputedStyle(foot, '::before');
              return {
                edge: edge.backgroundImage,
                edgeMotion: edge.animationName,
                glow: glow.backgroundImage,
                branch: foot.querySelector('.br .n')?.textContent
              };
            }, message);
          assert.notEqual(reading.edge, 'none');
          assert.equal(reading.edgeMotion, 'none');
          assert.equal(reading.glow, 'none');
          assert.equal(reading.branch, 'staging');
          const run = process.env['SQUADRON_RUN'];
          if (run)
            await boot
              .panel()
              .locator('#cards')
              .screenshot({ path: path.join(run, 'warm-card-' + theme + '-reduced.png') });
          await boot.ctx.page.emulateMedia({ reducedMotion: 'no-preference' });
          if (run)
            await boot
              .panel()
              .locator('#cards')
              .screenshot({ path: path.join(run, 'warm-card-' + theme + '.png') });
        }
      });
    } finally {
      await boot.ctx.page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });
});
