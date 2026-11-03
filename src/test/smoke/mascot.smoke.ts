import * as assert from 'node:assert/strict';
import { before } from 'node:test';
import * as boot from './boot';
import * as fixtures from '../harness';

/**
 * Where the chick sits, which only a host can answer: jsdom has no layout, so
 * `mascot_ui.test.ts` asserts the perch and the pose and never a pixel. Here
 * the feet row (the sprite's row 44) is read against the edge it perches on —
 * the bar, the open sheet, a card — and against that edge again once it moved.
 */

const FEET = 44;

/** The chick's feet against an edge, and its box against the edge's span. */
interface Seat {
  /** Feet row minus the edge's top: 1 when it sits on it. */
  feet: number;
  /** Its centre, from the edge's left and right ends; both positive inside. */
  fromLeft: number;
  fromRight: number;
}

/** Wait until it has stopped on `perch` holding `pose`, then read its seat on
 *  the element `selector` names. */
async function seat(perch: string, pose: string, selector: string): Promise<Seat> {
  return boot
    .panel()
    .locator('body')
    .evaluate(
      async (_, { perch, pose, selector, FEET }) => {
        const deadline = performance.now() + 15_000;
        const chick = (): HTMLElement | null => document.getElementById('mascot');
        const settled = (): boolean => {
          const el = chick();
          return (
            !!el &&
            el.dataset.perch === perch &&
            el.dataset.pose === pose &&
            el.getAnimations().length === 0
          );
        };
        while (!settled()) {
          if (performance.now() > deadline) {
            const el = chick();
            throw new Error(
              `the chick never settled on ${perch} as ${pose}: ` +
                JSON.stringify({ perch: el?.dataset.perch, pose: el?.dataset.pose })
            );
          }
          await new Promise(requestAnimationFrame);
        }
        // The sheet's rise is a translate, and the edge is read where it stops.
        const edge = document.querySelector(selector);
        if (!edge) throw new Error(`no ${selector}`);
        while (!['none', '0px', '0px 0px'].includes(getComputedStyle(edge).translate)) {
          if (performance.now() > deadline) throw new Error(`${selector} never stopped rising`);
          await new Promise(requestAnimationFrame);
        }
        // A ResizeObserver delivers after the layout of the frame that moved the
        // edge, so the first read after a resize can precede the re-placing.
        // Read until it sits on the edge, both ways, or 2 s pass; the caller asserts
        // on whatever the last read was.
        const read = (): Seat => {
          const c = chick()!.getBoundingClientRect();
          const e = edge.getBoundingClientRect();
          const centre = c.left + c.width / 2;
          return {
            feet: c.top + FEET - e.top,
            fromLeft: centre - e.left,
            fromRight: e.right - centre
          };
        };
        const until = performance.now() + 2000;
        let last = read();
        const seated = (r: Seat): boolean =>
          Math.abs(r.feet - 1) <= 2 && r.fromLeft > 0 && r.fromRight > 0;
        while (!seated(last) && performance.now() < until) {
          await new Promise(requestAnimationFrame);
          last = read();
        }
        return last;
      },
      { perch, pose, selector, FEET }
    );
}

function onEdge(where: string, s: Seat): void {
  assert.ok(Math.abs(s.feet - 1) <= 2, `${where}: feet ${s.feet}px from the edge, wanted 1`);
  assert.ok(s.fromLeft > 0 && s.fromRight > 0, `${where}: not over it ${JSON.stringify(s)}`);
}

boot.section('the mascot, in the real IDE', () => {
  before(async () => {
    await boot.openPanel();
    await boot.patchSettings({ 'squadron.mascot.enabled': true });
  });

  boot.step("sits on the bottom hub's top edge", async () => {
    await boot.panel().locator('#mascot').waitFor({ state: 'attached', timeout: 30_000 });
    onEdge('bar', await seat('bar', 'stand', '#bottomhub'));
  });

  boot.step('returns to its perch when hidden layout recovers between frames', async () => {
    await boot.holdingHostState(async () => {
      await boot
        .panel()
        .locator('body')
        .evaluate(async (body) => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const display = body.style.display;
          body.style.display = 'none';
          window.dispatchEvent(
            new MessageEvent('message', { data: { type: 'visible', visible: false } })
          );
          // Restore in the same task: ResizeObserver sees the original size again.
          body.style.display = display;
          window.dispatchEvent(
            new MessageEvent('message', { data: { type: 'visible', visible: true } })
          );
        });
      onEdge('bar after foregrounding', await seat('bar', 'stand', '#bottomhub'));
    });
  });

  // jsdom has no canvas, so this is the one place the frames are seen drawn:
  // a sprite's worth of opaque pixels, and different ones under another theme.
  boot.step('paints the chick, and repaints it for a theme', async () => {
    const pixels = (): Promise<{ opaque: number; sum: number; light: number }> =>
      boot
        .panel()
        .locator('#mascot canvas')
        .evaluate(async (c: HTMLCanvasElement) => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          let sum = 0;
          let light = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3]! > 200) opaque++;
            if (data[i + 3]! > 200 && Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 200) light++;
            sum += data[i]! + data[i + 1]! + data[i + 2]!;
          }
          return { opaque, sum, light };
        });
    const before = await pixels();
    // The stand frame fills about a third of its 48×48 cells.
    assert.ok(before.opaque > 500, `only ${before.opaque} opaque pixels on the canvas`);
    const body = boot.panel().locator('body');
    const was = await body.evaluate((b) => b.dataset.theme ?? '');
    await body.evaluate((b) => (b.dataset.theme = 'paper'));
    const after = await pixels();
    await body.evaluate((b, t) => {
      if (t) b.dataset.theme = t;
      else delete b.dataset.theme;
    }, was);
    assert.notEqual(after.sum, before.sum, 'the paper preset left the chick unchanged');
    // Its body was --av-fg once, which drew a black chick on a light preset.
    assert.ok(
      after.light > after.opaque / 3,
      `only ${after.light} of ${after.opaque} pixels light on paper`
    );
  });

  boot.step("lands on the sheet's top edge, and follows it when it changes height", async () => {
    await boot.panel().locator('#bottomhub .warm-tab').click();
    await boot.panel().locator('#bottomdrawer').waitFor({ state: 'visible', timeout: 10_000 });
    onEdge('sheet', await seat('sheet', 'stand', '#bottomdrawer'));
    await boot
      .panel()
      .locator('#bottomdrawer')
      .evaluate((n: HTMLElement) => (n.style.maxHeight = '160px'));
    onEdge('shorter sheet', await seat('sheet', 'stand', '#bottomdrawer'));
    await boot
      .panel()
      .locator('#bottomdrawer')
      .evaluate((n: HTMLElement) => (n.style.maxHeight = ''));
    await boot.panel().locator('body').press('Escape');
    await boot.panel().locator('#bottomdrawer').waitFor({ state: 'hidden', timeout: 5_000 });
    onEdge('bar after the sheet', await seat('bar', 'stand', '#bottomhub'));
  });

  boot.step(
    'lands at home when Tickets interrupts a flight, then perches on its drawer',
    async () => {
      await boot.holdingHostState(async () => {
        const push = (status: CardView['status'], mascot = true): Promise<void> =>
          boot
            .panel()
            .locator('body')
            .evaluate(
              (_, data) => {
                window.dispatchEvent(new MessageEvent('message', { data }));
              },
              fixtures.stateMessage(
                [fixtures.groupView({ sessions: [fixtures.cardView({ pid: 701, status })] })],
                { mascot }
              )
            );
        await push('busy');
        await push('waiting');
        await boot
          .panel()
          .locator('body')
          .evaluate(async () => {
            const deadline = performance.now() + 5000;
            while (document.getElementById('mascot')?.dataset.perch !== 'card') {
              if (performance.now() > deadline) throw new Error('the flight never started');
              await new Promise(requestAnimationFrame);
            }
            const tab = document.querySelector<HTMLElement>('#nav [data-act="tickets"]');
            if (!tab) throw new Error('no Tickets tab');
            tab.click();
          });
        onEdge('Tickets home after interrupted flight', await seat('bar', 'stand', '#bottomhub'));
        await boot.panel().locator('#bottomhub .warm-tab').click();
        onEdge('Tickets drawer', await seat('sheet', 'stand', '#bottomdrawer'));
        await boot.panel().locator('#bottomdrawer-close').click();
        onEdge('Tickets home after drawer', await seat('bar', 'stand', '#bottomhub'));
        await boot.panel().locator('#nav [data-act="sessions"]').click();
        await push('busy', false);
        await push('busy');
      });
    }
  );

  boot.step("flies to a card's top edge, and follows it when the board re-slots", async () => {
    const cards = (waiting?: number): CardView[] =>
      Array.from({ length: 6 }, (_, i) =>
        fixtures.cardView({
          pid: 701 + i,
          name: `Session ${i + 1}`,
          status: 701 + i === waiting ? 'waiting' : 'busy'
        })
      );
    const state = (waiting?: number): StateMessage =>
      fixtures.stateMessage([fixtures.groupView({ sessions: cards(waiting) })], { mascot: true });
    const push = (data: StateMessage): Promise<void> =>
      boot
        .panel()
        .locator('body')
        .evaluate((_, d) => {
          window.dispatchEvent(new MessageEvent('message', { data: d }));
        }, data);
    await boot.holdingHostState(async () => {
      await push(state());
      await push(state(705));
      const card = '.card[data-pid="705"]';
      onEdge('card', await seat('card', 'alert', card));
      // Narrow the board: the grid re-slots and the card moves under it.
      await boot
        .panel()
        .locator('#board')
        .evaluate((n: HTMLElement) => (n.style.flex = '0 0 420px'));
      onEdge('re-slotted card', await seat('card', 'alert', card));
      await boot
        .panel()
        .locator('#board')
        .evaluate((n: HTMLElement) => (n.style.flex = ''));
    });
  });
});
