// What the mascot costs, in a visible Google Chrome, by the method of
// docs/reference/auto_warm_animation_performance.md: the real panel document
// (out/ui/document.js, with the compiled bundle inlined), driven by pushes,
// read through CDP Performance metrics and SystemInfo.getProcessInfo. The
// stock VS Code reading is src/test/smoke/mascot_cost.smoke.ts; both drive
// the board in src/test/mascot_busy.ts. Results: docs/reference/mascot_performance.md.
//
//   npm run compile && node scripts/mascot_cost.mjs [rounds]
//
// Opens a Chrome window for about six minutes a round. Nothing in the gate runs it.

/* global window -- the evaluate callbacks run in the page. */
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { panelDocument } = require('../out/ui/document.js');
const { restState, busyMinute } = require('../out/test/mascot_busy.js');

const ROUNDS = Number(process.argv[2] ?? 2);
const REST_MS = 15_000;
const SETTLE_MS = 2_000;

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({
  viewport: { width: 1500, height: 950 },
  deviceScaleFactor: 2
});
const page = await context.newPage();
await page.addInitScript(() => {
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
});
// Served from localhost rather than set as content: the panel needs a secure
// context (crypto.randomUUID), and about:blank is not one.
await page.route('http://localhost/panel', (route) =>
  route.fulfill({ contentType: 'text/html', body: panelDocument('0.0.0') })
);
await page.goto('http://localhost/panel');
const tab = await context.newCDPSession(page);
await tab.send('Performance.enable', { timeDomain: 'threadTicks' });
const whole = await browser.newBrowserCDPSession();

const push = (state) =>
  page.evaluate((s) => window.dispatchEvent(new MessageEvent('message', { data: s })), state);

async function metrics() {
  const { metrics: list } = await tab.send('Performance.getMetrics');
  const m = Object.fromEntries(list.map(({ name, value }) => [name, value]));
  const { processInfo } = await whole.send('SystemInfo.getProcessInfo');
  const cpu = (type) =>
    processInfo.filter((p) => p.type === type).reduce((sum, p) => sum + p.cpuTime, 0);
  return {
    wall: Date.now(),
    task: m.TaskDuration,
    layouts: m.LayoutCount,
    recalcs: m.RecalcStyleCount,
    heap: m.JSHeapUsedSize,
    renderer: cpu('renderer'),
    gpu: cpu('GPU')
  };
}

/** Percent of one core between two readings, per field. */
function delta(a, b) {
  const s = (b.wall - a.wall) / 1000;
  return {
    seconds: +s.toFixed(1),
    main: +((100 * (b.task - a.task)) / s).toFixed(2),
    renderer: +((100 * (b.renderer - a.renderer)) / s).toFixed(2),
    gpu: +((100 * (b.gpu - a.gpu)) / s).toFixed(2),
    layouts: b.layouts - a.layouts,
    recalcs: b.recalcs - a.recalcs,
    heapMB: +(b.heap / 1e6).toFixed(2)
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(mascot) {
  await push(restState(mascot));
  await wait(SETTLE_MS);
  const a = await metrics();
  await wait(REST_MS);
  return delta(a, await metrics());
}

/** The busy minute, scheduled inside the page so no CDP latency moves a push;
 *  read whole and per second, for the peak. */
async function busy(mascot) {
  await push(restState(mascot));
  await wait(SETTLE_MS);
  const plan = busyMinute().map(({ at, state }) => ({ at, state: { ...state, mascot } }));
  await page.evaluate((p) => {
    for (const { at, state } of p) {
      setTimeout(
        () => window.dispatchEvent(new MessageEvent('message', { data: state })),
        at * 1000
      );
    }
  }, plan);
  const start = await metrics();
  let prev = start;
  let peak = { renderer: 0, gpu: 0, sum: 0 };
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    const now = await metrics();
    const d = delta(prev, now);
    if (d.renderer + d.gpu > peak.sum)
      peak = { renderer: d.renderer, gpu: d.gpu, sum: d.renderer + d.gpu };
    prev = now;
  }
  return { ...delta(start, prev), peak };
}

const rows = [];
for (let round = 0; round < ROUNDS; round++) {
  for (const [name, run] of [
    ['off, at rest', () => rest(false)],
    ['on, at rest', () => rest(true)],
    ['off, busy minute', () => busy(false)],
    ['on, busy minute', () => busy(true)]
  ]) {
    const result = await run();
    rows.push({ round, name, ...result });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
await browser.close();
console.log(JSON.stringify({ chrome: browser.version?.() ?? 'chrome', rows }, null, 1));
