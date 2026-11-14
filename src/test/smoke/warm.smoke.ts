import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before } from 'node:test';
import * as cacheTtl from '../../core/cache_ttl';
import * as boot from './boot';
import * as fixtures from '../harness';
import { FIXTURE_NAME, fixtureSession, openWorkflowSheet } from './kit';

/**
 * Warm on the bottom drawer, where jsdom has no layout. The open frame stays
 * on screen, a pointer flip lands in the host's warm file, and the two columns
 * scroll apart: a long session list moves under New sessions while the
 * configuration column does not.
 *
 * The nav bar's narrowing steps are not this file. The control left that bar.
 */

const button = () => boot.panel().locator('#bottomhub .warm-tab');
const sheet = () => boot.panel().locator('#bottomdrawer');

async function openWarm(): Promise<void> {
  if (
    await sheet()
      .isVisible()
      .catch(() => false)
  )
    return;
  if (!(await button().isVisible())) await boot.panel().locator('#bottomhub-more').click();
  await button().click();
  await sheet().waitFor({ state: 'visible', timeout: 10_000 });
  // hidden clears at the start of the rise. The frame begins one height below
  // the board and is not the one a reader sees until the translate settles.
  await sheet().evaluate(async (n) => {
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      const shift = getComputedStyle(n).translate;
      if (shift === 'none' || shift === '0px 0px') return;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
}

async function shutWarm(): Promise<void> {
  if (
    !(await sheet()
      .isVisible()
      .catch(() => false))
  )
    return;
  await boot.panel().locator('body').press('Escape');
  await sheet().waitFor({ state: 'hidden', timeout: 5_000 });
}

/** The open frame against the board it is inset from. The webview iframe's
 *  `innerWidth` is not that column: a full-width sheet reads past it while
 *  sitting 12px inside the board. */
const placed = () =>
  sheet().evaluate((n) => {
    const r = n.getBoundingClientRect();
    const board = document.getElementById('board')?.getBoundingClientRect();
    return {
      height: r.height,
      insetLeft: board ? r.left - board.left : Number.NaN,
      insetRight: board ? board.right - r.right : Number.NaN,
      insetBottom: board ? board.bottom - r.bottom : Number.NaN
    };
  });

/** Where a minute figure sits against its name. A board at or under 560px
 *  drops the figure under the name; a wider one keeps it on the same row.
 *  Covering the name is neither. */
function figurePlace(
  label: { top: number; right: number; bottom: number; left: number },
  minutes: { top: number; right: number; bottom: number; left: number }
): 'beside' | 'under' | 'off' {
  const sharesRow = minutes.top < label.bottom - 1 && label.top < minutes.bottom - 1;
  if (minutes.left >= label.right - 2 && sharesRow) return 'beside';
  if (minutes.top >= label.bottom - 2 && Math.abs(minutes.left - label.left) <= 8) return 'under';
  return 'off';
}

function assertOnScreen(box: Awaited<ReturnType<typeof placed>>, at: string): void {
  assert.ok(box.height > 40, `the frame has no height ${at}`);
  assert.ok(
    box.insetLeft >= 8 && box.insetLeft <= 16,
    `the frame's left inset is ${box.insetLeft}px ${at}`
  );
  assert.ok(
    box.insetRight >= 8 && box.insetRight <= 16,
    `the frame's right inset is ${box.insetRight}px ${at}`
  );
  assert.ok(
    box.insetBottom >= -1 && box.insetBottom <= 2,
    `the frame ends ${box.insetBottom}px above the board ${at}`
  );
}

/** The choice file the host writes. The bar's count moves before that write,
 *  so a dropped post still paints a switch that is on. */
async function waitWarm(sessionId: string, on: boolean): Promise<void> {
  const file = path.join(boot.homeDir(), '.squadron', 'warm', `claude.${sessionId}.json`);
  const start = Date.now();
  let last = 'missing';
  while (Date.now() - start < 15_000) {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { on?: boolean };
      if (raw.on === on) return;
      last = JSON.stringify(raw.on);
    } catch (why) {
      last = String(why);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`warm choice for ${sessionId} stayed ${last}, wanted ${on}`);
}

/** What the host wrote to this profile's User settings for one key. */
async function waitSetting(key: string, want: unknown): Promise<void> {
  const file = path.join(boot.ctx.profile, 'data', 'User', 'settings.json');
  const start = Date.now();
  let last: unknown = 'missing';
  while (Date.now() - start < 15_000) {
    try {
      last = (JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>)[key];
      if (last === want) return;
    } catch (why) {
      last = String(why);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(
    `${key} stayed ${JSON.stringify(last)} in settings.json, wanted ${JSON.stringify(want)}`
  );
}

boot.section('Warm on the bottom drawer, in the real IDE', () => {
  let sessionId = '';

  before(async () => {
    await boot.openPanel();
    sessionId = (await fixtureSession()).sessionId;
  });

  boot.step('flips a session warm through the host and back, by pointer', async () => {
    await openWarm();
    assertOnScreen(await placed(), 'at full width');
    const row = sheet().locator('.sessions .mrow', { hasText: FIXTURE_NAME });
    // A plain click, with no `force`: Playwright refuses a target another box
    // covers, which is the reachability the case is about.
    await row.click();
    await row.and(boot.panel().locator('[aria-checked="true"]')).waitFor({ timeout: 10_000 });
    await waitWarm(sessionId, true);
    await row.click();
    await row.and(boot.panel().locator('[aria-checked="false"]')).waitFor({ timeout: 10_000 });
    await waitWarm(sessionId, false);
    await shutWarm();
  });

  boot.step('scrolls the session list under New sessions, and not the configuration', async () => {
    const now = Date.now();
    const sessions = Array.from({ length: 24 }, (_, i) =>
      fixtures.cardView({
        pid: 90_000 + i,
        name: `long list ${i}`,
        warm: { on: i % 2 === 0, ttlMs: 3_600_000, source: 'measured', nextAt: now + 600_000 }
      })
    );
    const message = fixtures.stateMessage([fixtures.groupView({ sessions })]);
    await openWarm();
    // Hold the host's own pushes while this one is on screen, or the next poll
    // puts the one real session back mid-measure.
    const reading = await boot.holdingHostState(() =>
      boot
        .panel()
        .locator('body')
        .evaluate(async (_, state) => {
          window.dispatchEvent(new MessageEvent('message', { data: state }));
          await new Promise(requestAnimationFrame);
          const list = document.querySelector<HTMLElement>('#bottomdrawer .sessions');
          const pin = document.querySelector<HTMLElement>(
            '#bottomdrawer .bdlist > [data-key="warm:default"]'
          );
          const detail = document.querySelector<HTMLElement>('#bottomdrawer .bddetail');
          if (!list || !pin || !detail) return null;
          const hit = (node: HTMLElement): boolean => {
            const r = node.getBoundingClientRect();
            const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!at && node.contains(at);
          };
          const pinBefore = pin.getBoundingClientRect().top;
          const detailBefore = detail.scrollTop;
          const pinHit = hit(pin);
          list.scrollTop = list.scrollHeight;
          await new Promise(requestAnimationFrame);
          const rows = list.querySelectorAll<HTMLElement>('.mrow');
          const last = rows[rows.length - 1];
          const detailBox = detail.getBoundingClientRect();
          const listBox = list.getBoundingClientRect();
          return {
            rows: rows.length,
            overflows: list.scrollHeight > list.clientHeight + 1,
            scrolled: list.scrollTop > 0,
            detailStayed: detail.scrollTop === detailBefore,
            pinMoved: Math.abs(pin.getBoundingClientRect().top - pinBefore),
            beside: detailBox.left > listBox.left + 8,
            pinHit,
            pinHitAfter: hit(pin),
            lastHit: !!last && hit(last)
          };
        }, message)
    );
    try {
      assert.ok(reading, 'the open sheet drew no session list, pin, or configuration');
      assert.equal(reading.rows, 24);
      assert.ok(reading.beside, 'the configuration column is not beside the session list');
      assert.ok(reading.overflows, 'twenty-four rows did not overflow the session list');
      assert.ok(reading.scrolled, 'the session list did not scroll');
      assert.ok(reading.detailStayed, 'the configuration column scrolled with the session list');
      assert.ok(
        reading.pinMoved < 1,
        `New sessions moved ${reading.pinMoved}px as the list scrolled`
      );
      assert.ok(reading.pinHit && reading.pinHitAfter, 'something covers New sessions');
      assert.ok(reading.lastHit, 'the last row is not reachable once scrolled to');
    } finally {
      await shutWarm();
    }
  });

  boot.step('puts the policy line under the title, and a mark beside each TTL', async () => {
    await openWarm();
    const read = await sheet().evaluate(() => {
      const head = document.getElementById('bottomdrawer-head');
      const note = document.getElementById('bottomdrawer-note');
      const title = head?.querySelector('.ttl');
      const close = document.getElementById('bottomdrawer-close');
      if (!head || !note || !title || !close) return null;
      const box = (node: Element) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      };
      const headBox = box(head);
      const noteBox = box(note);
      const titleBox = box(title);
      const closeBox = box(close);
      // The field takes the pointer at its centre: nothing in the row covers it.
      const reachable = (node: Element | null): boolean => {
        if (!node) return false;
        const r = node.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at === node;
      };
      const boxOf = (node: Element | null) => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
      };
      const fields = [
        ...document.querySelectorAll('#bottomdrawer .ttl-field:not(.buffer):not(.window)')
      ].map((field) => {
        const mark = field.querySelector('.bm')?.getBoundingClientRect();
        return {
          mark: field.querySelector('.bm')?.getAttribute('class') ?? '',
          markW: mark?.width ?? 0,
          tip: field.querySelector('.why')?.getAttribute('aria-label') ?? '',
          source: field.querySelector('.source')?.textContent ?? '',
          label: boxOf(field.querySelector('.label')),
          minutes: boxOf(field.querySelector('.minutes')),
          input: boxOf(field.querySelector('.minutes .num')),
          reachable: reachable(field.querySelector('.minutes .num'))
        };
      });
      const bufferField = document.querySelector('#bottomdrawer .ttl-field.buffer');
      return {
        inHead: note.parentElement === head,
        inside: noteBox.top >= headBox.top && noteBox.bottom <= headBox.bottom + 1,
        underTitle: noteBox.top >= titleBox.bottom - 2,
        clearOfClose: noteBox.top >= closeBox.bottom - 2,
        note: note.textContent ?? '',
        board: document.getElementById('board')?.getBoundingClientRect().width ?? 0,
        fields,
        buffer: bufferField?.querySelector('.why')?.getAttribute('data-tip') ?? '',
        bufferLabel: boxOf(bufferField?.querySelector('.label') ?? null),
        bufferMinutes: boxOf(bufferField?.querySelector('.minutes') ?? null),
        bufferReachable: reachable(bufferField?.querySelector('.minutes .num') ?? null)
      };
    });
    assert.ok(read, 'Warm drew no header or policy line');
    assert.ok(read.inHead && read.inside, 'the policy line is not in the header');
    assert.ok(read.underTitle && read.clearOfClose, 'the policy line shares a row with the title');
    assert.match(read.note, /up to 2h after the last real turn/);
    assert.deepEqual(
      read.fields.map((field) => field.mark),
      ['bm cl', 'bm cx', 'bm gr']
    );
    assert.deepEqual(
      read.fields.map((field) => field.tip),
      (['claude', 'codex', 'grok'] as const).map((brand) => cacheTtl.CACHE_TTL[brand].tip)
    );
    assert.match(read.fields[2]?.tip ?? '', /reuse held at 11 min/);
    for (const field of read.fields) {
      assert.ok(field.markW >= 10, `a brand mark is ${field.markW}px`);
      assert.equal(field.source, '');
      assert.ok(field.label && field.minutes, `${field.mark} drew no name or minutes`);
      assert.ok(
        field.input && field.input.bottom - field.input.top >= 18,
        `${field.mark} drew no field to type in`
      );
      assert.ok(field.reachable, `something covers the ${field.mark} field`);
      const where = figurePlace(field.label, field.minutes);
      assert.notEqual(
        where,
        'off',
        `${field.mark} minutes sit off the name on a ${read.board}px board ` +
          `(name ${field.label.top}–${field.label.bottom}, minutes ${field.minutes.top}–${field.minutes.bottom})`
      );
    }
    assert.equal(read.buffer, 'Before cache expiry. Each ping runs 5 minutes before the TTL ends.');
    assert.ok(read.bufferLabel && read.bufferMinutes, 'Ping buffer drew no name or minutes');
    assert.ok(read.bufferReachable, 'something covers the Ping buffer field');
    assert.notEqual(
      figurePlace(read.bufferLabel, read.bufferMinutes),
      'off',
      `Ping buffer minutes sit off the name on a ${read.board}px board ` +
        `(name ${read.bufferLabel.top}–${read.bufferLabel.bottom}, minutes ${read.bufferMinutes.top}–${read.bufferMinutes.bottom})`
    );
    await shutWarm();
  });

  boot.step('keeps a typed figure through the 1s beat, and writes it to settings', async () => {
    const key = 'squadron.warmCache.bufferMinutes';
    const field = sheet().locator('.ttl-field.buffer .num');
    try {
      await openWarm();
      await field.click();
      await field.fill('7');
      // Past one beat of the countdown clock, which repaints this column.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await field.inputValue(), '7', 'the 1s beat wrote over the draft');
      assert.ok(
        await field.evaluate((n) => n === document.activeElement),
        'the 1s beat took the focus out of the field'
      );
      await field.press('Enter');
      await waitSetting(key, 7);
      // Past a poll as well, whose push carries the setting back.
      await new Promise((r) => setTimeout(r, 3500));
      assert.equal(await field.inputValue(), '7', 'the host push put the old figure back');
      assert.equal(
        await sheet().locator('.ttl-field.buffer .why').getAttribute('data-tip'),
        'Before cache expiry. Each ping runs 7 minutes before the TTL ends.'
      );
    } finally {
      await shutWarm();
      await boot.patchSettings({ [key]: undefined });
    }
  });

  boot.step('keeps the workflow search inside the list column', async () => {
    const dir = path.join(boot.homeDir(), '.squadron', 'workflows');
    const extras = Array.from({ length: 7 }, (_, i) => path.join(dir, `smoke-extra-${i}.json`));
    try {
      await Promise.all(
        extras.map((file, i) =>
          fs.writeFile(
            file,
            JSON.stringify({
              schema: 1,
              id: `smoke-extra-${i}`,
              label: `extra ${i}`,
              steps: [{ id: 's', label: 'S', prompt: 'do s' }]
            })
          )
        )
      );
      await shutWarm();
      await openWorkflowSheet();
      await boot
        .panel()
        .locator('#bottomdrawer-body .wsrow .nm', { hasText: 'extra 6' })
        .waitFor({ timeout: 15_000 });
      await boot
        .panel()
        .locator('#bottomdrawer-filter')
        .waitFor({ state: 'visible', timeout: 5_000 });
      const edges = await sheet().evaluate(() => {
        const filter = document.getElementById('bottomdrawer-filter')?.getBoundingClientRect();
        const list = document.querySelector('#bottomdrawer-body .bdlist')?.getBoundingClientRect();
        const detail = document
          .querySelector('#bottomdrawer-body .bddetail')
          ?.getBoundingClientRect();
        if (!filter || !list || !detail) return null;
        return {
          filterLeft: filter.left,
          filterRight: filter.right,
          listLeft: list.left,
          listRight: list.right,
          detailLeft: detail.left
        };
      });
      assert.ok(edges, 'the open sheet drew no search, list, or detail');
      assert.ok(
        Math.abs(edges.filterLeft - edges.listLeft) <= 2,
        `search starts at ${edges.filterLeft}, the list at ${edges.listLeft}`
      );
      assert.ok(
        Math.abs(edges.filterRight - edges.listRight) <= 2,
        `search ends at ${edges.filterRight}, the list at ${edges.listRight}`
      );
      assert.ok(
        edges.filterRight < edges.detailLeft,
        `search runs to ${edges.filterRight}, into the detail at ${edges.detailLeft}`
      );
    } finally {
      await Promise.all(extras.map((file) => fs.rm(file, { force: true })));
      await boot.panel().locator('body').press('Escape');
    }
  });
});
