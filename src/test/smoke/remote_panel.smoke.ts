import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import { after, before } from 'node:test';
import { descendants, scanProcesses } from '../../core/scan';
import * as boot from './boot';
import * as kit from './kit';

/**
 * Remote as the panel draws and drives it, in one real stock VS Code with the
 * fake messenger selected: the bar word's dot through every link state, the
 * switch through the host's arms and `remoteChoice`, a token through the
 * host's input box into `SecretStorage`, an allowed account into the User
 * settings file, the setup check's verdict across the host's polls, the
 * holder file against another live process, the switch staying put while
 * setup scrolls, the guide over the drawer, focus returning to Remote, and an
 * account the messenger refuses beside the space a check fills.
 *
 * Run alone, never from `e2e.ts`, and by `npm run release` as a step of its
 * own after the barrel (U19): Remote on holds `caffeinate`, and a reload within
 * 2 min turns it back on, so a barrel reset — a reload — would carry it into
 * the next file. Every step that turns Remote on ends with it off.
 *
 * Paths are spelled under `boot.homeDir()`, not taken from `core/paths`, whose
 * constants were fixed against the real `HOME` when this file was loaded.
 */

/** The credential that must never reach the panel's document or the disk. */
const SENTINEL = `smoke-sentinel-token-${crypto.randomUUID()}`;
/** The one account the page allows. Typed padded, stored trimmed. */
const PHONE = 'phone';
/** What the stand-in for another window calls itself in a refusal. */
const ELSEWHERE = 'elsewhere-window';
const RECONNECTING = 'smoke: the socket dropped';
const FAILED = 'smoke: the token was revoked';
/** The verdict `squadron.remote.fakeCheck` names for the pressed check: the
 *  fake's second step, so neither the paste's ok nor the connected link can
 *  draw it. */
const CHECK_FAILED = 'smoke: the check failed the second step';

type Holder = { windowId: string; label: string; folder?: string; pid: number };

const squadron = (): string => path.join(boot.homeDir(), '.squadron');
const holderFile = (): string => path.join(squadron(), 'remote', 'holder.json');
/** The claim of the window the stand-in plays: a press takes over a holder
 *  whose window no live claim names. */
const elsewhereClaim = (): string => path.join(squadron(), 'windows', 'smoke-elsewhere.json');
const inboxDir = (): string => path.join(squadron(), 'remote', 'fake', 'inbox');
const outboxFile = (): string => path.join(squadron(), 'remote', 'fake', 'outbox.jsonl');
const checksFile = (): string => path.join(squadron(), 'remote', 'fake', 'checks.jsonl');
const userSettings = (): string => path.join(boot.ctx.profile, 'data', 'User', 'settings.json');

const word = () => boot.panel().locator('#bottomhub .remote-tab');
const sheet = () => boot.panel().locator('#bottomdrawer');
const switchRow = () => boot.panel().locator('#bottomdrawer .bdlist [data-key="remote:switch"]');
const detail = () => sheet().locator('.bddetail');
const verdict = () => detail().locator('[data-key="remote:verdict"]');
const guide = () => boot.panel().locator('#gscrim');

let other: ChildProcess | undefined;

boot.section(
  'Remote on the panel, in the real IDE',
  () => {
    before(() => boot.openPanel());
    after(async () => {
      other?.kill('SIGKILL');
      await fs.rm(elsewhereClaim(), { force: true });
    });

    boot.step('1. off and needing setup: no dot, a dead switch, Not configured', async () => {
      await word().waitFor({ state: 'visible', timeout: 30_000 });
      await dotIs('');
      await kit.openRemoteSheet();
      await sheet()
        .locator('.bdlist .mrow.drilled', { hasText: 'Test messenger' })
        .waitFor({ timeout: 10_000 });
      assert.equal(await switchRow().getAttribute('aria-disabled'), 'true');
      assert.equal((await switchRow().innerText()).trim(), 'Enable Remote');
      assert.match(await sheet().locator('.bdlist .mrow.drilled').innerText(), /Not configured/);
      assert.equal(await summary('tokens'), '0 of 1 set');
      assert.equal(await summary('allowed'), '0');
      assert.match(await verdict().innerText(), /Not checked/);
    });

    boot.step('2. setup in the sheet: a token through the host’s box, then its check', async () => {
      const field = detail().locator('.remote-field', { hasText: 'Token' });
      assert.equal(await field.locator('.v').innerText(), 'Not set');

      await field.getByRole('button', { name: 'Paste Token' }).click();
      const box = boot.ctx.page.locator('.quick-input-widget');
      await box.locator('.quick-input-title', { hasText: 'Token' }).waitFor({ timeout: 15_000 });
      const input = box.locator('input:not([type="checkbox"])');
      assert.equal(await input.getAttribute('type'), 'password', 'the box shows what is typed');
      await input.fill(SENTINEL);
      await boot.ctx.page.keyboard.press('Enter');
      await box.waitFor({ state: 'hidden', timeout: 10_000 });
      assert.ok(await sheet().isVisible(), 'the host’s box shut the drawer it was opened from');
      await field.locator('.v', { hasText: /^Set$/ }).waitFor({ timeout: 15_000 });
      // Step 11 writes down where focus lands; this is the same reading.
      console.log(`  focus after the box: ${await focusedControl()}`);

      // The paste starts a check, and its own store's change event must not
      // abort it: an aborted check is dropped and the verdict stays unchecked.
      await until('the paste’s check in the fake’s record', async () =>
        (await checks()) >= 1 ? true : undefined
      );
      await verdict().locator('text=Configured').waitFor({ timeout: 15_000 });
      assert.match((await verdict().getAttribute('class')) ?? '', /\bok\b/);
    });

    boot.step('3. an allowed account, from the sheet into the User settings file', async () => {
      await detail().locator('.remote-allow input').fill(`  ${PHONE}  `);
      await detail().locator('[data-key="remote:allow:add"]').click();
      await detail().locator('.remote-id', { hasText: PHONE }).waitFor({ timeout: 15_000 });
      await until('the allowlist in the User settings file', async () => {
        const list = (await savedSettings())['squadron.remote.allowlist'];
        return Array.isArray(list) && list.length === 1 && list[0] === PHONE ? true : undefined;
      });
      await until('the switch to take a press', async () =>
        (await switchRow().getAttribute('aria-disabled')) === null ? true : undefined
      );
      assert.equal(await summary('tokens'), '1 of 1 set');
      assert.equal(await summary('allowed'), '1');
    });

    boot.step('4. connecting: a press, a pending dot, and the holder names this host', async () => {
      await kit.openRemoteSheet();
      await switchRow().click();
      await dotIs('pending');
      await sheet()
        .locator('.bdlist .mrow.drilled .val', { hasText: 'Connecting…' })
        .waitFor({ timeout: 15_000 });
      assert.equal(await switchRow().getAttribute('aria-checked'), 'true');
      const held = await until('a holder file', readHolder);
      assert.equal(held.windowId, await thisWindow(), 'the holder is another window');
      const table = await scanProcesses(true);
      assert.ok(
        descendants(boot.ctx.hostPid, table.parents).includes(held.pid),
        `the holder's pid ${held.pid} is not this IDE's`
      );
    });

    boot.step('5. connected: a link file turns the dot live', async () => {
      await deliver({ link: { kind: 'connected' } });
      await dotIs('live');
      await sheet()
        .locator('.bdlist .mrow.drilled .val', { hasText: 'Connected' })
        .waitFor({ timeout: 15_000 });
      await sheet().locator('.remote-hint').waitFor({ timeout: 5_000 });
    });

    boot.step('5a. original-message receipt reaches the fake through the host', async () => {
      const before = await outbox();
      await deliver({ say: { sender: PHONE, text: 'smoke receipt', in: 'unknown-smoke-thread' } });
      const effect = await until('received reaction in the fake outbox', async () => {
        const added = (await outbox()).slice(before.length).split('\n').filter(Boolean);
        const records = added.map(
          (line) => JSON.parse(line) as { kind: string; message?: string; status?: string }
        );
        return records.find((record) => record.kind === 'reaction' && record.status === 'received');
      });
      assert.match(effect.message ?? '', /^u\d+$/);
      const conversations = path.join(squadron(), 'remote', 'conversations');
      const originals = (
        await Promise.all(
          (await fs.readdir(conversations))
            .filter((name) => name.endsWith('.json'))
            .map(
              async (name) =>
                JSON.parse(await fs.readFile(path.join(conversations, name), 'utf8')) as {
                  messages?: { ref: string; correlation: string }[];
                }
            )
        )
      ).flatMap((record) => record.messages ?? []);
      assert.ok(
        originals.some(
          (message) => message.ref === effect.message && message.correlation.length > 0
        )
      );
    });

    boot.step(
      '5b. a selected Remote job publishes its original-prompt identity and done reaction',
      async () => {
        const before = await outbox();
        await deliver({ say: { sender: PHONE, text: 'remote identity check' } });
        type Event = {
          kind: string;
          message?: string;
          status?: string;
          notice?: { buttons?: { label: string; payload: string }[] };
          posted?: { message: string };
        };
        const events = async (): Promise<Event[]> =>
          (await outbox())
            .slice(before.length)
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Event);
        const choice = await until('the Remote launch selection', async () => {
          for (const event of await events()) {
            const button = event.notice?.buttons?.find(
              (button) => button.label === 'Use window default'
            );
            if (button) return { button, on: event.posted?.message };
          }
          return undefined;
        });
        const receipt = (await events()).find(
          (event) => event.kind === 'reaction' && event.status === 'received'
        );
        assert.ok(receipt?.message);
        await until('the original prompt queued behind selection', async () =>
          (await events()).some(
            (e) => e.kind === 'reaction' && e.message === receipt.message && e.status === 'queued'
          )
            ? true
            : undefined
        );
        await deliver({ press: { sender: PHONE, payload: choice.button.payload, on: choice.on } });
        const record = await until(
          'a root and original correlation saved by the host',
          async () => {
            const dir = path.join(squadron(), 'remote', 'conversations');
            for (const name of await fs.readdir(dir)) {
              if (!name.endsWith('.json')) continue;
              const candidate = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as {
                root?: { pid: number };
                messages?: { ref: string; correlation: string }[];
              };
              const message = candidate.messages?.find((m) => m.ref === receipt.message);
              if (candidate.root && message)
                return { pid: candidate.root.pid, correlation: message.correlation };
            }
            return undefined;
          }
        );
        await until('authoritative initial-prompt completion in published state', async () => {
          const raw = await fs
            .readFile(path.join(squadron(), 'live', `${record.pid}.json`), 'utf8')
            .catch(() => 'null');
          const published = JSON.parse(raw) as {
            messageFacts?: { correlation: string; phase: string }[];
          } | null;
          return published?.messageFacts?.some(
            (f) => f.correlation === record.correlation && f.phase === 'done'
          )
            ? true
            : undefined;
        });
        await until('done on the original Remote prompt', async () =>
          (await events()).some(
            (e) => e.kind === 'reaction' && e.message === receipt.message && e.status === 'done'
          )
            ? true
            : undefined
        );
      }
    );

    boot.step(
      '6. Check: one more check recorded, its failure kept across two polls and a reopen',
      async () => {
        // The paste's check, and nothing since: a connected link checks nothing.
        const before = await checks();
        assert.ok(before >= 1, 'no check recorded for the paste');
        await boot.patchSettings({
          'squadron.remote.fakeCheck': { kind: 'setup', step: 1, reason: CHECK_FAILED }
        });
        await detail().locator('[data-key="remote:check"]').click();
        await until('the pressed check in the fake’s record', async () =>
          (await checks()) === before + 1 ? true : undefined
        );
        await verdict().locator(`text=${CHECK_FAILED}`).waitFor({ timeout: 15_000 });
        await failedAtSecondStep();

        // The 3 s refresh composes the view afresh each time, and with the link
        // still connected: the explicit result has to outrank it on each.
        await holds('the failed verdict across two polls', 7_000, async () => {
          const text = await verdict().innerText();
          return text.includes(CHECK_FAILED) ? undefined : `the verdict read "${text}"`;
        });
        assert.equal(await checks(), before + 1, 'a poll ran another check');

        await switchRow().focus();
        await boot.ctx.page.keyboard.press('Escape');
        await sheet().waitFor({ state: 'hidden', timeout: 5_000 });
        await kit.openRemoteSheet();
        await verdict().locator(`text=${CHECK_FAILED}`).waitFor({ timeout: 5_000 });
        await failedAtSecondStep();
        assert.equal(await checks(), before + 1, 'the reopen ran another check');
        // Read at each check's start, so dropping it changes no verdict drawn.
        await boot.patchSettings({ 'squadron.remote.fakeCheck': undefined });
      }
    );

    boot.step('7. reconnecting, then failed: each reason verbatim under the switch', async () => {
      await deliver({ link: { kind: 'reconnecting', reason: RECONNECTING } });
      await dotIs('pending');
      await sheet().locator('.bdlist .remote-reason', { hasText: RECONNECTING }).waitFor();

      await deliver({ link: { kind: 'failed', reason: FAILED, retry: false } });
      await dotIs('fault');
      await sheet().locator('.bdlist .remote-reason', { hasText: FAILED }).waitFor();
      assert.equal(await switchRow().getAttribute('aria-checked'), 'true', 'failed is still on');
    });

    boot.step('8. keep-awake: restores a disabled hold or reports unsupported', async () => {
      await boot.patchSettings({ 'squadron.cafe.enabled': false });
      if (!platform.power.holds.supported) {
        const warning = sheet().locator('.remote-warn', {
          hasText: 'This machine cannot be kept awake from here'
        });
        await warning.waitFor({ timeout: 15_000 });
        assert.equal(await warning.getByRole('button', { name: 'Keep awake' }).count(), 0);
        return;
      }
      const warning = sheet().locator('.remote-warn', { hasText: 'Keep-awake is off' });
      await warning.waitFor({ timeout: 15_000 });
      await warning.getByRole('button', { name: 'Keep awake' }).click();
      await until('keep-awake back on in the User settings file', async () => {
        const saved = JSON.parse(await fs.readFile(userSettings(), 'utf8')) as Record<
          string,
          unknown
        >;
        return saved['squadron.cafe.enabled'] === true ? true : undefined;
      });
      await warning.waitFor({ state: 'detached', timeout: 15_000 });
    });

    boot.step('9. off: a press removes the holder and clears the dot', async () => {
      await switchRow().click();
      await gone(holderFile(), 'the turn-off to release the holder');
      await dotIs('');
      await settled(false);
    });

    boot.step(
      '10. refused while another window holds Remote, then its death taken over',
      async () => {
        other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
          stdio: 'ignore'
        });
        const pid = other.pid;
        assert.ok(pid, 'no child to stand for another window');
        const table = await until('the stand-in in the process table', async () => {
          const fresh = await scanProcesses(true);
          return fresh.starts.has(pid) ? fresh : undefined;
        });
        await writeJson(elsewhereClaim(), {
          id: 'smoke-elsewhere',
          label: ELSEWHERE,
          app: 'Code',
          folder: path.join(boot.homeDir(), ELSEWHERE),
          shellPids: [],
          updatedAt: Date.now()
        });
        await writeJson(holderFile(), {
          windowId: 'smoke-elsewhere',
          label: ELSEWHERE,
          folder: path.join(boot.homeDir(), ELSEWHERE),
          pid,
          startedAt: table.starts.get(pid),
          since: Date.now()
        });
        await dotIs('elsewhere');
        await sheet()
          .locator('.bdlist .mrow.drilled .val', { hasText: `On in another window: ${ELSEWHERE}` })
          .waitFor();
        assert.equal(await switchRow().getAttribute('aria-disabled'), null, 'elsewhere refuses');

        const posted = await outbox();
        await switchRow().click();
        await sheet()
          .locator('.remote-refused', {
            hasText: `Remote is on in ${ELSEWHERE}. Turn it off there first.`
          })
          .waitFor({ timeout: 15_000 });
        // Without `remoteChoice`, the flip would stand until a push agreed —
        // and a refused turn-on sends none that does.
        await settled(false);
        assert.equal((await readHolder())?.pid, pid, 'the holder no longer names the other window');
        assert.equal(await outbox(), posted, 'a refused turn-on reached the messenger');

        // Refused once more just before the death, so the host's last process
        // table calls the stand-in alive and the takeover lands inside the
        // second that table is cached for (`CACHE_MS`).
        await switchRow().click();
        await until('the refusal to put the switch back', async () =>
          (await switchRow().getAttribute('aria-checked')) === 'false' ? true : undefined
        );
        other.kill('SIGKILL');
        await until('the stand-in to die', async () =>
          (await scanProcesses(true)).starts.has(pid) ? undefined : true
        );
        // Pressed at once, before the panel has seen the death (D37).
        await switchRow().click();
        const taken = await until('this window to take the dead holder over', async () => {
          const held = await readHolder();
          return held && held.pid !== pid ? held : undefined;
        });
        assert.equal(taken.windowId, await thisWindow());
        await dotIs('pending');

        await switchRow().click();
        await gone(holderFile(), 'the turn-off to release the holder');
        await dotIs('');
        await settled(false);
        await fs.rm(elsewhereClaim(), { force: true });
      }
    );

    boot.step('11. geometry: the switch stays put while setup scrolls', async () => {
      const ids = Array.from({ length: 40 }, (_, i) => `scroll-${String(i).padStart(2, '0')}`);
      await boot.patchSettings({ 'squadron.remote.allowlist': [PHONE, ...ids] });
      await kit.openRemoteSheet();
      await until('forty-one allowed accounts in the sheet', async () =>
        (await summary('allowed')) === '41' ? true : undefined
      );
      try {
        const reading = await sheet().evaluate(async (frame) => {
          const column = frame.querySelector<HTMLElement>('.bddetail');
          const list = frame.querySelector<HTMLElement>('.bdlist .messengers');
          const sw = frame.querySelector<HTMLElement>('.bdlist > [data-key="remote:switch"]');
          const rows = frame.querySelectorAll<HTMLElement>('.bddetail .remote-id');
          const last = rows[rows.length - 1];
          if (!column || !list || !sw || !last) return null;
          const hit = (node: HTMLElement): boolean => {
            const r = node.getBoundingClientRect();
            const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!at && node.contains(at);
          };
          const inFrame = (node: HTMLElement): boolean => {
            const r = node.getBoundingClientRect();
            const f = frame.getBoundingClientRect();
            return r.top >= f.top - 0.5 && r.bottom <= f.bottom + 0.5;
          };
          const swBefore = sw.getBoundingClientRect().top;
          const swHit = hit(sw) && inFrame(sw);
          const listBefore = list.scrollTop;
          column.scrollTop = column.scrollHeight;
          await new Promise(requestAnimationFrame);
          return {
            overflows: column.scrollHeight > column.clientHeight + 1,
            scrolled: column.scrollTop > 0,
            listStayed: list.scrollTop === listBefore,
            swMoved: Math.abs(sw.getBoundingClientRect().top - swBefore),
            swHit,
            swHitAfter: hit(sw) && inFrame(sw),
            lastHit: hit(last)
          };
        });
        assert.ok(reading, 'the open Remote drew no setup column, messenger list or switch');
        assert.ok(reading.overflows, 'forty-one accounts did not overflow the setup column');
        assert.ok(reading.scrolled, 'the setup column did not scroll');
        assert.ok(reading.listStayed, 'the messenger list scrolled with the setup column');
        assert.ok(reading.swMoved < 1, `the switch moved ${reading.swMoved}px as setup scrolled`);
        assert.ok(reading.swHit && reading.swHitAfter, 'the switch is covered or out of the frame');
        assert.ok(reading.lastHit, 'the last account is not reachable once scrolled to');
      } finally {
        await boot.patchSettings({ 'squadron.remote.allowlist': [PHONE] });
        await until('the one allowed account back', async () =>
          (await summary('allowed')) === '1' ? true : undefined
        );
      }
    });

    boot.step('12. geometry: the guide over the drawer, a press in it keeping both', async () => {
      await kit.openRemoteSheet();
      await detail().locator('[data-key="remote:guide"]').click();
      const card = guide().locator('.asheet');
      await card.waitFor({ state: 'visible', timeout: 5_000 });
      // Above the drawer: the guide's backdrop takes the drawer's own points,
      // and nothing is drawn over the guide itself.
      const stack = await card.evaluate((node) => {
        const drawer = document.getElementById('bottomdrawer');
        const scrim = node.parentElement;
        if (!drawer || !scrim) return null;
        const d = drawer.getBoundingClientRect();
        const g = node.getBoundingClientRect();
        const name = (at: Element | null): string =>
          at ? `${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ''}.${at.className}` : 'nothing';
        const drawerPoints = [
          [d.left + d.width / 2, d.top + d.height / 2],
          [d.left + 8, d.bottom - 8],
          [d.right - 8, d.top + 8]
        ].map(([x = 0, y = 0]) => document.elementFromPoint(x, y));
        const covered: string[] = [];
        for (let i = 1; i < 8; i++) {
          for (let j = 1; j < 8; j++) {
            const x = g.left + (g.width * i) / 8;
            const y = g.top + (g.height * j) / 8;
            const at = document.elementFromPoint(x, y);
            if (!at || !node.contains(at))
              covered.push(`${Math.round(x)},${Math.round(y)}: ${name(at)}`);
          }
        }
        return {
          overDrawer: drawerPoints.every((at) => at === scrim),
          drawerHits: drawerPoints.map(name),
          covered
        };
      });
      assert.ok(stack, 'no drawer under the guide');
      assert.ok(
        stack.overDrawer,
        `the drawer is above the guide's backdrop: ${stack.drawerHits.join(', ')}`
      );
      assert.deepEqual(stack.covered, [], 'something is drawn over the guide');

      await guide().locator('.asbody').click();
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(await card.isVisible(), 'a press inside the guide shut it');
      assert.ok(await sheet().isVisible(), 'a press inside the guide shut the drawer');

      await guide().locator('.asfoot .b.pri', { hasText: 'Done' }).click();
      await guide().waitFor({ state: 'hidden', timeout: 5_000 });
      assert.ok(await sheet().isVisible(), 'Done shut the drawer under the guide');
      assert.equal(await focusedControl(), 'button "Guide"', 'focus did not go back to Guide');

      // Escape in order: the guide, then the drawer.
      await detail().locator('[data-key="remote:guide"]').click();
      await card.waitFor({ state: 'visible', timeout: 5_000 });
      await boot.ctx.page.keyboard.press('Escape');
      await guide().waitFor({ state: 'hidden', timeout: 5_000 });
      assert.ok(await sheet().isVisible(), 'the guide’s Escape shut the drawer too');
    });

    boot.step('13. geometry: focus returns to the visible Remote word', async () => {
      await kit.openRemoteSheet();
      // The caret goes back to the word that opened the mode. jsdom cannot see
      // the bar's visibility, which is what a real host's focus() checks.
      await switchRow().focus();
      await boot.ctx.page.keyboard.press('Escape');
      await sheet().waitFor({ state: 'hidden', timeout: 5_000 });
      assert.equal(
        await focusedControl(),
        'button "Remote"',
        'the shut sheet did not hand focus back to the Remote word'
      );

      const target = await word().evaluate((node) => {
        const box = node.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          hit: node.contains(
            document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          )
        };
      });
      assert.ok(target.hit, 'the Remote word is not reachable by pointer');
      assert.ok(
        target.width >= 24 && target.height >= 24,
        `the Remote word is ${target.width}×${target.height}`
      );
    });

    boot.step('14. accounts the messenger refuses, and the space the check fills', async () => {
      await kit.openRemoteSheet();
      const allowed = detail().locator('.sect.allowed');
      const field = detail().locator('.remote-allow input');
      try {
        // Refused by the host: the settings file keeps its one account, and
        // the field gets the refused one back.
        await field.fill('two words');
        await detail().locator('[data-key="remote:allow:add"]').click();
        await allowed
          .locator('.remote-failed', { hasText: 'two words was not added.' })
          .waitFor({ timeout: 15_000 });
        assert.equal(await field.inputValue(), 'two words');
        assert.deepEqual((await savedSettings())['squadron.remote.allowlist'], [PHONE]);
        await field.fill('');

        // Stored by hand: drawn as unusable, and its removal still lands.
        await boot.patchSettings({ 'squadron.remote.allowlist': [PHONE, 'two words'] });
        await allowed
          .locator('.remote-id.bad', { hasText: 'two words' })
          .waitFor({ timeout: 15_000 });
        await allowed.locator('.remote-problem', { hasText: 'no spaces' }).waitFor();
        await allowed.getByRole('button', { name: 'Remove two words' }).click();
        await until('the hand-stored account removed', async () => {
          const list = (await savedSettings())['squadron.remote.allowlist'];
          return Array.isArray(list) && list.length === 1 && list[0] === PHONE ? true : undefined;
        });

        // The space: Not set, filled by a check that finds one, never
        // overwritten by the next, which is offered instead.
        const space = allowed.locator('.remote-space');
        assert.equal(await space.locator('.v').innerText(), 'Not set');
        await boot.patchSettings({
          'squadron.remote.fakeCheck': { kind: 'ok', facts: [], space: 'S0FOUND' }
        });
        await detail().locator('[data-key="remote:check"]').click();
        await until('the found space in the User settings file', async () =>
          (await savedSettings())['squadron.remote.space'] === 'S0FOUND' ? true : undefined
        );
        await space.locator('.v', { hasText: 'S0FOUND' }).waitFor({ timeout: 15_000 });

        await boot.patchSettings({
          'squadron.remote.fakeCheck': { kind: 'ok', facts: [], space: 'S0OTHER' }
        });
        await detail().locator('[data-key="remote:check"]').click();
        const found = allowed.locator('.remote-found', { hasText: 'S0OTHER' });
        await found.waitFor({ timeout: 15_000 });
        assert.equal((await savedSettings())['squadron.remote.space'], 'S0FOUND');
        await found.getByRole('button', { name: 'Use S0OTHER' }).click();
        await until('Use to write the space', async () =>
          (await savedSettings())['squadron.remote.space'] === 'S0OTHER' ? true : undefined
        );
        await found.waitFor({ state: 'detached', timeout: 15_000 });

        // Change… asks in the host's own box, which is no password box.
        await space.getByRole('button', { name: 'Change Space' }).click();
        const box = boot.ctx.page.locator('.quick-input-widget');
        await box.locator('.quick-input-title', { hasText: 'Space' }).waitFor({ timeout: 15_000 });
        const input = box.locator('input:not([type="checkbox"])');
        assert.notEqual(await input.getAttribute('type'), 'password');
        await input.fill('S0TYPED');
        await boot.ctx.page.keyboard.press('Enter');
        await box.waitFor({ state: 'hidden', timeout: 10_000 });
        await until('the typed space in the User settings file', async () =>
          (await savedSettings())['squadron.remote.space'] === 'S0TYPED' ? true : undefined
        );
        await space.locator('.v', { hasText: 'S0TYPED' }).waitFor({ timeout: 15_000 });
      } finally {
        await boot.patchSettings({
          'squadron.remote.fakeCheck': undefined,
          'squadron.remote.space': undefined
        });
      }
    });

    boot.step('15. the token is nowhere in the panel’s document or on disk', async () => {
      const dump = path.join(boot.homeDir(), '..', `remote-panel-webview-${process.pid}.json`);
      const webview = await boot
        .panel()
        .locator('body')
        .evaluate(() => ({
          html: document.documentElement.outerHTML,
          values: [...document.querySelectorAll('input, textarea')].map(
            (n) => (n as HTMLInputElement).value
          ),
          local: JSON.stringify({ ...localStorage }),
          session: JSON.stringify({ ...sessionStorage })
        }));
      await fs.writeFile(dump, JSON.stringify(webview));
      try {
        // Windows keeps Chromium's LevelDB LOCK files unreadable until host exit.
        await boot.closeHost();
        assert.deepEqual(
          await filesHolding(SENTINEL, [boot.homeDir(), boot.ctx.profile, dump]),
          [],
          'the token reached the panel or the disk'
        );
        // The check can see what it looks for: the dump holds a value it was given.
        await fs.appendFile(dump, SENTINEL);
        assert.deepEqual(await filesHolding(SENTINEL, [dump]), [dump]);
      } finally {
        await fs.rm(dump, { force: true });
      }
    });
  },
  () => ({
    'squadron.remote.messenger': 'fake',
    'squadron.remote.fakeLink': 'held'
  })
);

/** The word's dot, as a class: `''` is off. Read rather than waited on as
 *  visible, because the bar is hidden while the sheet is up. */
async function dotIs(tone: '' | 'pending' | 'live' | 'fault' | 'elsewhere'): Promise<void> {
  const want = tone ? `dot ${tone}` : 'dot';
  let saw = '';
  await until(
    `the Remote dot to read "${want}"`,
    async () => {
      saw = (await word().locator('.dot').getAttribute('class')) ?? '';
      return saw === want ? true : undefined;
    },
    15_000,
    () => Promise.resolve(saw)
  );
}

/** The switch as it stands past the next push: settled, not just flipped. */
async function settled(on: boolean): Promise<void> {
  await until(`the switch to read ${on}`, async () =>
    (await switchRow().getAttribute('aria-checked')) === String(on) ? true : undefined
  );
  await new Promise((r) => setTimeout(r, 4_000));
  assert.equal(await switchRow().getAttribute('aria-checked'), String(on), 'the switch moved back');
}

/** A setup section's count, by its class: `tokens` or `allowed`. */
async function summary(name: 'tokens' | 'allowed'): Promise<string> {
  return detail().locator(`.sect.${name} > .column-head .summary`).innerText();
}

/** The checklist under a failed check at the fake's second step: the first
 *  done, the second failed. */
async function failedAtSecondStep(): Promise<void> {
  assert.match((await verdict().getAttribute('class')) ?? '', /\bbad\b/);
  const steps = detail().locator('.checklist .gstep');
  assert.equal(await steps.count(), 2);
  assert.match((await steps.nth(0).getAttribute('class')) ?? '', /\bst-done\b/);
  assert.match((await steps.nth(1).getAttribute('class')) ?? '', /\bst-failed\b/);
}

/** How many checks the fake has answered, one line each. */
async function checks(): Promise<number> {
  const text = await fs.readFile(checksFile(), 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line !== '').length;
}

async function savedSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(userSettings(), 'utf8')) as Record<string, unknown>;
}

/** Where the panel's focus is, as a reader would name it. */
async function focusedControl(): Promise<string> {
  return boot
    .panel()
    .locator('body')
    .evaluate(() => {
      const at = document.activeElement;
      if (!at || at === document.body) return `body (document focused: ${document.hasFocus()})`;
      const key = (at as HTMLElement).dataset.focusKey;
      return `${at.tagName.toLowerCase()}${key ? ` [${key}]` : ''} "${(at.textContent ?? '').trim()}"`;
    });
}

/** This window's claim id: the one whose folder is the profile's project. */
async function thisWindow(): Promise<string> {
  const dir = path.join(squadron(), 'windows');
  const project = path.join(boot.homeDir(), 'project');
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    const claim = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as {
      id: string;
      folder?: string;
    };
    if (
      claim.folder !== undefined &&
      platform.paths.key(claim.folder) === platform.paths.key(project)
    )
      return claim.id;
  }
  assert.fail('no claim for this window');
}

/** One inbox event, renamed into place whole. */
let delivered = 0;
async function deliver(event: unknown): Promise<void> {
  await fs.mkdir(inboxDir(), { recursive: true });
  const file = path.join(inboxDir(), `${Date.now()}-${String(++delivered).padStart(3, '0')}.json`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(event));
  await fs.rename(`${file}.tmp`, file);
}

async function outbox(): Promise<string> {
  return fs.readFile(outboxFile(), 'utf8').catch(() => '');
}

async function readHolder(): Promise<Holder | undefined> {
  const text = await fs.readFile(holderFile(), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as Holder);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
  await fs.rename(`${file}.tmp`, file);
}

async function gone(file: string, why: string): Promise<void> {
  await until(why, () =>
    fs.access(file).then(
      () => undefined,
      () => true
    )
  );
}

async function filesHolding(value: string, roots: string[]): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (file: string): Promise<void> => {
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(file)) await visit(path.join(file, name));
    } else if (stat.isFile() && (await fs.readFile(file)).includes(value)) {
      matches.push(file);
    }
  };
  for (const root of roots) await visit(root);
  return matches;
}

/** `broken` answers undefined for the whole of `ms`, read every 250 ms. */
async function holds(
  why: string,
  ms: number,
  broken: () => Promise<string | undefined>
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const saw = await broken();
    if (saw !== undefined) assert.fail(`${why} did not hold: ${saw}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function until<T>(
  why: string,
  read: () => Promise<T | undefined>,
  ms = 30_000,
  saw?: () => Promise<string>
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      assert.fail(`waited ${ms} ms for ${why}${saw ? `; saw: ${await saw()}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
